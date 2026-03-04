import WebSocket from "ws";
import { ServiceRouter } from "./service-router.js";
import type { AudioChunk } from "@ar-training/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Called by the Coordinator when a transcript segment arrives. */
export type TranscriptCallback = (
    sessionId: string,
    text:      string,
    isFinal:   boolean,
) => void;

interface TranscriptMessage {
    type:       "transcript";
    session_id: string;
    text:       string;
    window_seq: number;
    is_final:   boolean;
    confidence: number;
}

// ─── TranscriptionClient ──────────────────────────────────────────────────────
//
// Manages one persistent WebSocket connection per session to the Transcription
// container. Forwards AudioChunk messages for Whisper to process and receives
// Transcript messages back, passing them to the provided callback.
//
// Session pinning via ServiceRouter ensures all audio for a session reaches
// the same Transcription instance, keeping per-session VAD buffers coherent.
//
// This is the only class that knows about the Transcription container's API.
// ─────────────────────────────────────────────────────────────────────────────

export class TranscriptionClient {
    private readonly router:     ServiceRouter;
    private readonly authHeader: string;
    private readonly onTranscript: TranscriptCallback;
    private readonly sockets:    Map<string, WebSocket> = new Map();

    constructor(
        transcriptionUrls: string[],
        internalApiKey:    string,
        onTranscript:      TranscriptCallback,
    ) {
        this.router      = new ServiceRouter(transcriptionUrls);
        this.authHeader  = `Bearer ${internalApiKey}`;
        this.onTranscript = onTranscript;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Opens a WebSocket connection to the Transcription container for a session.
     * Must be called once per session before sendAudio().
     */
    openSession(sessionId: string): void {
        if (this.sockets.has(sessionId)) return;

        const url = `${this.router.getWsUrl(sessionId)}/ws/${sessionId}`;
        const ws  = new WebSocket(url, {
            headers: { "Authorization": this.authHeader },
        });

        ws.on("message", (raw: Buffer) => {
            try {
                const msg = JSON.parse(raw.toString()) as TranscriptMessage;
                if (msg.type === "transcript") {
                    this.onTranscript(sessionId, msg.text, msg.is_final);
                }
            } catch {
                // Malformed message — skip
            }
        });

        ws.on("error", () => {
            // Non-fatal — transcription loss does not end the session.
            // The clip will proceed with whatever transcript has been accumulated.
            this.sockets.delete(sessionId);
        });

        ws.on("close", () => {
            this.sockets.delete(sessionId);
        });

        this.sockets.set(sessionId, ws);
    }

    /**
     * Forwards an AudioChunk to the Transcription container for the session.
     * Opens the connection automatically if not already open.
     */
    sendAudio(chunk: AudioChunk): void {
        const sessionId = chunk.session_id;

        if (!this.sockets.has(sessionId)) {
            this.openSession(sessionId);
        }

        const ws = this.sockets.get(sessionId);
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        ws.send(JSON.stringify(chunk));
    }

    /**
     * Sends a finalise signal to the Transcription container, asking it to
     * flush any in-flight audio and emit a final Transcript message.
     * Called by the Coordinator just before clip evaluation is dispatched.
     */
    async finaliseSession(sessionId: string, transcriptionUrl: string): Promise<void> {
        try {
            await fetch(`${transcriptionUrl}/transcription/finalise/${sessionId}`, {
                method:  "POST",
                headers: { "Authorization": this.authHeader },
            });
        } catch {
            // Non-fatal — proceed with accumulated transcript
        }
    }

    /**
     * Sends a reset signal to the Transcription container to clear the
     * per-session VAD buffer between clips, then closes the WebSocket.
     * A new connection will be opened automatically when the next clip starts.
     */
    async resetSession(sessionId: string, transcriptionUrl: string): Promise<void> {
        // Close the WebSocket cleanly before resetting so no in-flight
        // audio arrives after the buffer is cleared.
        this.closeSocket(sessionId);

        try {
            await fetch(`${transcriptionUrl}/transcription/reset/${sessionId}`, {
                method:  "POST",
                headers: { "Authorization": this.authHeader },
            });
        } catch {
            // Non-fatal
        }
    }

    /**
     * Closes the WebSocket for a session and releases the pinned routing entry.
     * Call this when a session ends permanently.
     */
    closeSession(sessionId: string): void {
        this.closeSocket(sessionId);
        this.router.releaseSession(sessionId);
    }

    /** Returns the base HTTP URL for a session's pinned Transcription instance. */
    getUrl(sessionId: string): string {
        return this.router.getUrl(sessionId);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private closeSocket(sessionId: string): void {
        const ws = this.sockets.get(sessionId);
        if (ws) {
            ws.terminate();
            this.sockets.delete(sessionId);
        }
    }
}
