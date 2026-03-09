import { WebSocket } from "ws";
import type { VideoFrame, AudioChunk, AnalysisWindow, ClipMetadata } from "@ar-training/shared";
import type {MfccMatrix} from "@ar-training/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TranscriptMessage {
    type:       "transcript";
    session_id: string;
    text:       string;
    window_seq: number;
    is_final:   boolean;
    confidence: number;
}

/**
 * Factory that produces a WebSocket instance. Injected so tests can supply a
 * mock without stubbing globals. In production, pass `defaultWsFactory`.
 */
export type WsFactory = (
    url:  string,
    opts: { headers: Record<string, string> },
) => WebSocket;

export const defaultWsFactory: WsFactory = (url, opts) => new WebSocket(url, opts);

// ─── ClipSession ──────────────────────────────────────────────────────────────
//
// Owns the full lifecycle of one clip's relationship with the Transcription
// service. Opens a WebSocket on construction, accumulates frames, MFCCs, and
// transcript segments, and resolves as a thenable once the Transcription
// service emits a final transcript segment (triggered by flush()).
//
// The Coordinator creates one ClipSession per clip, feeds it data, calls
// flush() on ClipEnded, then awaits the resolved AnalysisWindow.
//
// Responsibilities:
//   - WebSocket connection to the Transcription container
//   - Audio forwarding (with queue-while-connecting behaviour)
//   - Frame and MFCC buffering
//   - Transcript accumulation
//   - Resolving with a complete AnalysisWindow on is_final
//
// Does NOT know about: evaluation, feedback, session lifecycle, routing.
// ─────────────────────────────────────────────────────────────────────────────

export class ClipSession {
    private readonly frames:      VideoFrame[] = [];
    private readonly mfccs:       MfccMatrix[] = [];
    private readonly audioQueue:  string[]     = [];
    private transcript            = "";
    private flushed               = false;
    private finalReceived         = false;

    private readonly ws:          WebSocket;
    private readonly promise:     Promise<AnalysisWindow>;
    private resolve!:             (window: AnalysisWindow) => void;

    constructor(
        private readonly sessionId:        string,
        private readonly clip:             ClipMetadata,
        private readonly transcriptionUrl: string,
        private readonly authHeader:       string,
        wsFactory:                         WsFactory,
        private readonly sequence:         number = 1,
    ) {
        this.promise = new Promise(res => { this.resolve = res; });

        const wsUrl = transcriptionUrl
            .replace(/^http:\/\//, "ws://")
            .replace(/^https:\/\//, "wss://")
            .replace(/\/+$/, "");

        this.ws = wsFactory(`${wsUrl}/ws/${sessionId}`, {
            headers: { "Authorization": authHeader },
        });

        this.ws.on("open", () => {
            // Drain any audio queued during the CONNECTING phase
            for (const payload of this.audioQueue) {
                this.ws.send(payload);
            }
            this.audioQueue.length = 0;
        });

        this.ws.on("message", (raw: Buffer) => {
            try {
                const msg = JSON.parse(raw.toString()) as TranscriptMessage;
                if (msg.type !== "transcript") return;

                if (msg.text) {
                    this.transcript = this.transcript
                        ? `${this.transcript} ${msg.text}`
                        : msg.text;
                }

                if (msg.is_final) {
                    this.finalReceived = true;
                    if (this.flushed) this.resolveWindow();
                }
            } catch {
                // Malformed message — skip
            }
        });

        this.ws.on("error", () => {
            // Non-fatal — transcription loss does not end the session.
            // The clip will proceed with whatever transcript has been accumulated.
        });

        this.ws.on("close", () => { /* no-op */ });
    }

    // ── Thenable protocol ─────────────────────────────────────────────────────

    /**
     * Makes `await clipSession` work without subclassing Promise.
     * Resolves with the complete AnalysisWindow for this clip.
     */
    then<TResult1 = AnalysisWindow, TResult2 = never>(
        onFulfilled?: ((value: AnalysisWindow) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?:  ((reason: unknown)       => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        return this.promise.then(onFulfilled, onRejected);
    }

    // ── Data ingestion ────────────────────────────────────────────────────────

    onFrame(frame: VideoFrame): void {
        this.frames.push(frame);
    }

    /**
     * Forwards the audio chunk to the Transcription service.
     * Queues the chunk if the WebSocket is still connecting.
     * Drops the chunk silently if the socket is closed.
     */
    onAudio(chunk: AudioChunk): void {
        const payload = JSON.stringify(chunk);
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(payload);
        } else if (this.ws.readyState === WebSocket.CONNECTING) {
            this.audioQueue.push(payload);
        }
        // CLOSING or CLOSED — drop silently
        this.mfccs.push(chunk.mfccs);
    }

    // ── Clip end ──────────────────────────────────────────────────────────────

    /**
     * Signals the Transcription service to flush any in-flight audio and emit
     * a final Transcript message, then resolves the ClipSession thenable with
     * the complete AnalysisWindow. If the final segment already arrived before
     * this was called, resolves immediately.
     *
     * Fire-and-forget — await the ClipSession itself to receive the window.
     */
    flush(): void {
        this.flushed = true;

        // If is_final already arrived before flush() was called, resolve now.
        if (this.finalReceived) {
            this.resolveWindow();
        }

        // Fire-and-forget — non-fatal if this fails
        fetch(`${this.transcriptionUrl}/transcription/finalise/${this.sessionId}`, {
            method:  "POST",
            headers: { "Authorization": this.authHeader },
        }).catch(() => { /* non-fatal */ });
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    /**
     * Terminates the WebSocket connection. Call this when the clip is done
     * and the ClipSession is being discarded.
     */
    close(): void {
        this.ws.terminate();
        this.audioQueue.length = 0;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private resolveWindow(): void {
        this.resolve({
            window_id:     `${this.sessionId}:${this.sequence}`,
            session_id:    this.sessionId,
            frames:        this.frames,
            mfccs:         this.mfccs.flat(1),
            transcript:    this.transcript,
            clip_metadata: this.clip,
        });
    }
}