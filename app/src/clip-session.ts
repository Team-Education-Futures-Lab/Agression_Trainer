import { WebSocket } from "ws";
import type { VideoFrame, AudioChunk, AnalysisWindow, ClipMetadata, MfccMatrix } from "@ar-training/shared";

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

/**
 * Called whenever a transcript segment arrives from the Transcription service.
 * Receives the session ID and the full accumulated transcript for the clip so far.
 */
export type TranscriptUpdateCallback = (sessionId: string, transcript: string) => void;

// Maximum frames buffered per clip. Matches MAX_FRAMES_PER_CLIP in main.ts.
const MAX_FRAMES = 3_600;

// Maximum audio chunks queued while the Transcription WebSocket is connecting.
const MAX_AUDIO_QUEUE = 120;


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

    private readonly sessionId:          string;
    private readonly clip:               ClipMetadata;
    private readonly transcriptionUrl:   string;
    private readonly authHeader:         string;
    private readonly sequence:           number = 1;
    private readonly onTranscriptUpdate: TranscriptUpdateCallback | undefined;

    constructor(
        sessionId:           string,
        clip:                ClipMetadata,
        transcriptionUrl:    string,
        authHeader:          string,
        wsFactory:           WsFactory,
        sequence:            number = 1,
        onTranscriptUpdate?: TranscriptUpdateCallback,
        /** ISO 639-1 language code for this session, e.g. "nl" or "en". */
        language:            string = "",
    ) {
        this.sessionId          = sessionId;
        this.clip               = clip;
        this.transcriptionUrl   = transcriptionUrl;
        this.authHeader         = authHeader;
        this.sequence           = sequence;
        this.onTranscriptUpdate = onTranscriptUpdate;

        this.promise = new Promise(res => { this.resolve = res; });

        const baseUrl = transcriptionUrl
            .replace(/^http:\/\//, "ws://")
            .replace(/^https:\/\//, "wss://")
            .replace(/\/+$/, "");

        // Append the per-session language as a query parameter so the
        // Transcription container can use the correct Whisper language
        // for this session regardless of its container-level default.
        const langParam = language ? `?language=${encodeURIComponent(language)}` : "";
        const wsUrl     = `${baseUrl}/ws/${sessionId}${langParam}`;

        this.ws = wsFactory(wsUrl, {
            headers: { "Authorization": authHeader },
        });

        this.ws.on("open", () => {
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

                this.onTranscriptUpdate?.(this.sessionId, this.transcript);

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
        });

        this.ws.on("close", () => { /* no-op */ });
    }

    // ── Thenable protocol ─────────────────────────────────────────────────────

    then<TResult1 = AnalysisWindow, TResult2 = never>(
        onFulfilled?: ((value: AnalysisWindow) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?:  ((reason: unknown)       => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        return this.promise.then(onFulfilled, onRejected);
    }

    // ── Data ingestion ────────────────────────────────────────────────────────

    onFrame(frame: VideoFrame): void {
        if (this.frames.length < MAX_FRAMES) {
            this.frames.push(frame);
        }
    }

    onAudio(sessionId: string, chunk: AudioChunk): void {
        const sanitised = chunk.session_id === sessionId
            ? chunk
            : { ...chunk, session_id: sessionId };

        const payload = JSON.stringify(sanitised);
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(payload);
        } else if (this.ws.readyState === WebSocket.CONNECTING) {
            if (this.audioQueue.length < MAX_AUDIO_QUEUE) {
                this.audioQueue.push(payload);
            }
        }
        this.mfccs.push(chunk.mfccs);
    }

    // ── Clip end ──────────────────────────────────────────────────────────────

    flush(): void {
        this.flushed = true;

        if (this.finalReceived) {
            this.resolveWindow();
        }

        fetch(`${this.transcriptionUrl}/transcription/finalise/${this.sessionId}`, {
            method:  "POST",
            headers: { "Authorization": this.authHeader },
        }).catch(() => { /* non-fatal */ });
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

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