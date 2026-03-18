import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import type { VideoFrame, AudioChunk, ClipMetadata, BehaviourResult } from "@ar-training/shared";
import type { CoordinatorConfig } from "../src/types.js";
import { EventEmitter } from "events";

// ─── Mock WebSocket ───────────────────────────────────────────────────────────
//
// An EventEmitter-based stand-in that lets tests drive connection state and
// emit Transcription service messages without a real WebSocket.
// ─────────────────────────────────────────────────────────────────────────────

class MockWebSocket extends EventEmitter {
    readyState      = 0; // CONNECTING
    readonly sent:  string[] = [];
    terminate       = vi.fn(() => { this.readyState = 3; });
    send(data: string) { this.sent.push(data); }
    open()  { this.readyState = 1; this.emit("open"); }
    close() { this.readyState = 3; this.emit("close"); }
}

function emitTranscript(ws: MockWebSocket, text: string, isFinal: boolean) {
    ws.emit("message", Buffer.from(JSON.stringify({
        type:       "transcript",
        session_id: "s1",
        text,
        window_seq: 1,
        is_final:   isFinal,
        confidence: 0.95,
    })));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EVALUATION_URL    = "http://evaluation:8001";
const TRANSCRIPTION_URL = "http://transcription:8003";

function makeConfig(): CoordinatorConfig {
    return {
        evaluationUrls:    [EVALUATION_URL],
        transcriptionUrls: [TRANSCRIPTION_URL],
        internalApiKey:    "test-key",
    };
}

function makeFrame(sessionId: string, frameId: number): VideoFrame {
    return {
        type:           "video_frame",
        session_id:     sessionId,
        frame_id:       frameId,
        timestamp:      frameId * 0.033,
        face_landmarks: [],
        left_hand:      [],
        right_hand:     [],
    };
}

function makeChunk(sessionId: string, chunkId: number): AudioChunk {
    return {
        type:        "audio_chunk",
        session_id:  sessionId,
        chunk_id:    chunkId,
        timestamp:   chunkId * 0.5,
        pcm:         "",
        sample_rate: 16_000,
        mfccs:       [[0.1, 0.2]],
    };
}

function makeClip(clipId: string): ClipMetadata {
    return {
        clip_id:           clipId,
        scenario_id:       "scenario_01",
        video_url:         `/scenarios/scenario_01/${clipId}.mp4`,
        transcript:        "Test transcript",
        notable_features:  [],
        branch_conditions: [{ min_score: -1.0, max_score: 1.01, next_clip: null }],
    };
}

function makeBehaviourResult(sessionId: string, windowId: string, score: number): BehaviourResult {
    return {
        window_id:        windowId,
        session_id:       sessionId,
        escalation_score: score,
        dominant_emotion: "neutral",
        confidence:       1.0,
        signal_summary: {
            voice_tension:   0.5,
            speech_pace:     3.2,
            hand_velocity:   0.3,
            gaze_stability:  0.7,
            open_palm_ratio: 0.6,
            notable_signals: [],
        },
    };
}

function mockFetchSuccess(result: BehaviourResult): void {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok:   true,
        json: () => Promise.resolve(result),
    }));
}

function mockFetchFailure(): void {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
}

function makeCoord(ws: MockWebSocket) {
    const factory = vi.fn().mockReturnValue(ws);
    const coord   = new Coordinator(makeConfig(), factory);
    return { coord, factory };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("Coordinator", () => {

    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── Session registration ──────────────────────────────────────────────────

    describe("session registration", () => {
        it("creates a ClipSession (opens a WebSocket) on register", () => {
            const ws = new MockWebSocket();
            const { coord, factory } = makeCoord(ws);

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            expect(factory).toHaveBeenCalledOnce();
        });

        it("closes the ClipSession WebSocket on deregister", () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            coord.deregisterSession("s1");

            expect(ws.terminate).toHaveBeenCalled();
        });

        it("frames received for an unregistered session are ignored", () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);

            expect(() => coord.onFrame(makeFrame("unknown", 1))).not.toThrow();
        });
    });

    // ── Frame and audio buffering ─────────────────────────────────────────────

    describe("frame and audio buffering", () => {
        it("does not dispatch to evaluation before flushSession is called", () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < 30; i++) coord.onFrame(makeFrame("s1", i));

            expect(fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
        });

        it("forwards audio chunks to the ClipSession WebSocket", () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            ws.open();
            coord.onAudio(makeChunk("s1", 1));

            expect(ws.sent).toHaveLength(1);
            expect(JSON.parse(ws.sent[0]).chunk_id).toBe(1);
        });
    });

    // ── Flush (clip-scoped dispatch) ──────────────────────────────────────────

    describe("flushSession", () => {
        it("dispatches one AnalysisWindow to evaluation on flush", async () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);
            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.2));

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            ws.open();
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            const flush = coord.flushSession("s1");
            emitTranscript(ws, "tekst", true);
            await flush;

            const fetchMock = fetch as ReturnType<typeof vi.fn>;
            const evaluateCalls = fetchMock.mock.calls.filter(c => (c[0] as string).includes("/evaluate/analyse"));
            expect(evaluateCalls).toHaveLength(1);
        });

        it("does nothing when the session does not exist", async () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);

            await expect(coord.flushSession("unknown")).resolves.not.toThrow();
            expect(fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
        });

        it("includes the accumulated transcript in the dispatched window", async () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);
            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.0));

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            ws.open();
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            emitTranscript(ws, "Goed", false);

            const flush = coord.flushSession("s1");
            emitTranscript(ws, "gedaan", true);
            await flush;

            const fetchMock = fetch as ReturnType<typeof vi.fn>;
            const call = fetchMock.mock.calls.find(c => (c[0] as string).includes("/evaluate/analyse"))!;
            const body = JSON.parse(call[1].body);
            expect(body.transcript).toBe("Goed gedaan");
        });

        it("includes all accumulated MFCCs in the dispatched window", async () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);
            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.0));

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            ws.open();
            coord.onAudio(makeChunk("s1", 1));
            coord.onAudio(makeChunk("s1", 2));
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            const flush = coord.flushSession("s1");
            emitTranscript(ws, "tekst", true);
            await flush;

            const fetchMock = fetch as ReturnType<typeof vi.fn>;
            const call = fetchMock.mock.calls.find(c => (c[0] as string).includes("/evaluate/analyse"))!;
            const body = JSON.parse(call[1].body);
            expect(body.mfccs).toHaveLength(2);
        });

        it("includes correct session_id and ClipMetadata in dispatched window", async () => {
            const ws   = new MockWebSocket();
            const { coord } = makeCoord(ws);
            const clip = makeClip("clip_01");
            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.0));

            coord.registerSession("s1", clip, vi.fn());
            ws.open();
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            const flush = coord.flushSession("s1");
            emitTranscript(ws, "tekst", true);
            await flush;

            const fetchMock = fetch as ReturnType<typeof vi.fn>;
            const call = fetchMock.mock.calls.find(c => (c[0] as string).includes("/evaluate/analyse"))!;
            const body = JSON.parse(call[1].body);
            expect(body.session_id).toBe("s1");
            expect(body.clip_metadata.clip_id).toBe("clip_01");
            expect(body.clip_metadata.video_url).toBe("/scenarios/scenario_01/clip_01.mp4");
        });

        it("stores the BehaviourResult as lastResult after a successful evaluation", async () => {
            const ws     = new MockWebSocket();
            const { coord } = makeCoord(ws);
            const result = makeBehaviourResult("s1", "s1:1", 0.4);
            mockFetchSuccess(result);

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            ws.open();
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            const flush = coord.flushSession("s1");
            emitTranscript(ws, "tekst", true);
            await flush;

            expect(coord.getLastResult("s1")).toEqual(result);
        });

        it("does not throw when the evaluation request fails", async () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);
            mockFetchFailure();

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            ws.open();
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            const flush = coord.flushSession("s1");
            emitTranscript(ws, "tekst", true);

            await expect(flush).resolves.not.toThrow();
        });

        it("window_id sequence increments across clips", async () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);
            vi.stubGlobal("fetch", vi.fn()
                .mockResolvedValue({ ok: true, json: () => Promise.resolve(makeBehaviourResult("s1", "s1:1", 0.1)) }),
            );

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            ws.open();
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            const flush1 = coord.flushSession("s1");
            emitTranscript(ws, "eerste clip", true);
            await flush1;

            await coord.resetSession("s1", makeClip("clip_02"));
            ws.open();

            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));
            const flush2 = coord.flushSession("s1");
            emitTranscript(ws, "tweede clip", true);
            await flush2;

            const fetchMock = fetch as ReturnType<typeof vi.fn>;
            const evaluateCalls = fetchMock.mock.calls.filter(c => (c[0] as string).includes("/evaluate/analyse"));
            expect(evaluateCalls).toHaveLength(2);
            expect(JSON.parse(evaluateCalls[0][1].body).window_id).toBe("s1:1");
            expect(JSON.parse(evaluateCalls[1][1].body).window_id).toBe("s1:2");
        });

        it("proceeds after timeout if the Transcription service never responds", async () => {
            vi.useFakeTimers();
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            ws.open();
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            const flush = coord.flushSession("s1");
            vi.advanceTimersByTime(5_000);
            await expect(flush).resolves.not.toThrow();

            vi.useRealTimers();
        });
    });

    // ── Reset ─────────────────────────────────────────────────────────────────

    describe("resetSession", () => {
        it("closes the current ClipSession WebSocket on reset", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            await coord.resetSession("s1", makeClip("clip_02"));

            expect(ws.terminate).toHaveBeenCalled();
        });

        it("clears the accumulated transcript on reset", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            ws.open();

            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.0));
            const flush = coord.flushSession("s1");
            emitTranscript(ws, "some text", true);
            await flush;

            await coord.resetSession("s1", makeClip("clip_02"));

            expect(coord.getLastTranscript("s1")).toBeNull();
        });

        it("calls the evaluation reset endpoint", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            await coord.resetSession("s1", makeClip("clip_02"));

            const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
            expect(urls.some(u => u.includes("/evaluate/reset/s1"))).toBe(true);
        });

        it("calls the transcription reset endpoint", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            await coord.resetSession("s1", makeClip("clip_02"));

            const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
            expect(urls.some(u => u.includes("/transcription/reset/s1"))).toBe(true);
        });

        it("opens a new ClipSession for the next clip after reset", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
            const ws1 = new MockWebSocket();
            const ws2 = new MockWebSocket();
            const factory = vi.fn()
                .mockReturnValueOnce(ws1)
                .mockReturnValueOnce(ws2);
            const coord = new Coordinator(makeConfig(), factory);

            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            await coord.resetSession("s1", makeClip("clip_02"));

            expect(factory).toHaveBeenCalledTimes(2);
        });
    });

    // ── Last result ───────────────────────────────────────────────────────────

    describe("last result", () => {
        it("returns null before any flush", () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            expect(coord.getLastResult("s1")).toBeNull();
        });

        it("returns null for an unknown session", () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);
            expect(coord.getLastResult("unknown")).toBeNull();
        });

        it("returns null transcript for an unknown session", () => {
            const ws = new MockWebSocket();
            const { coord } = makeCoord(ws);
            expect(coord.getLastTranscript("unknown")).toBeNull();
        });
    });
});