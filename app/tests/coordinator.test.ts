import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import type { VideoFrame, AudioChunk, ClipMetadata, BehaviourResult, SessionUpdate } from "@ar-training/shared";
import {CoordinatorConfig} from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EVALUATION_URL = "http://evaluation:8001";
const MIN_FRAMES     = 10;
const WINDOW_MS      = 2_000;

function makeConfig(): CoordinatorConfig {
    return {
        evaluationUrl: EVALUATION_URL,
        minFramesPerWindow: MIN_FRAMES,
        windowMs: WINDOW_MS,
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok:     false,
        status: 500,
    }));
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("Coordinator", () => {

    beforeEach(() => {
        vi.useFakeTimers();
        // Always stub fetch as a spy so expect(fetch).not.toHaveBeenCalled()
        // works even in tests that never trigger a fetch call.
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok:   false,
            status: 500,
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    // ── Window assembly ───────────────────────────────────────────────────────

    describe("window assembly", () => {
        it("does not dispatch a window before the timer fires", async () => {
            const coord  = new Coordinator(makeConfig());
            const sendFn = vi.fn();
            coord.registerSession("s1", makeClip("clip_01"), sendFn);

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));

            expect(fetch).not.toHaveBeenCalled();
        });

        it("dispatches a window when the timer fires and frame count meets threshold", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.2);
            mockFetchSuccess(result);

            const coord  = new Coordinator(makeConfig());
            const sendFn = vi.fn();
            coord.registerSession("s1", makeClip("clip_01"), sendFn);

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));

            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            expect(fetch).toHaveBeenCalledOnce();
        });

        it("discards a window when frame count is below threshold", async () => {
            const coord  = new Coordinator(makeConfig());
            const sendFn = vi.fn();
            coord.registerSession("s1", makeClip("clip_01"), sendFn);

            for (let i = 0; i < MIN_FRAMES - 1; i++) coord.onFrame(makeFrame("s1", i));

            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            expect(fetch).not.toHaveBeenCalled();
        });

        it("includes correct session_id and ClipMetadata in dispatched window", async () => {
            const clip   = makeClip("clip_01");
            const result = makeBehaviourResult("s1", "s1:1", 0.0);
            mockFetchSuccess(result);

            const coord  = new Coordinator(makeConfig());
            coord.registerSession("s1", clip, vi.fn());

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));

            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
            expect(body.session_id).toBe("s1");
            expect(body.clip_metadata.clip_id).toBe("clip_01");
        });

        it("WindowID sequence increments with each dispatched window", async () => {
            const result1 = makeBehaviourResult("s1", "s1:1", 0.1);
            const result2 = makeBehaviourResult("s1", "s1:2", 0.2);
            vi.stubGlobal("fetch", vi.fn()
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(result1) })
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(result2) }),
            );

            const coord  = new Coordinator(makeConfig());
            const sendFn = vi.fn();
            coord.registerSession("s1", makeClip("clip_01"), sendFn);

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            for (let i = MIN_FRAMES; i < MIN_FRAMES * 2; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
            const body1 = JSON.parse(calls[0][1].body);
            const body2 = JSON.parse(calls[1][1].body);
            expect(body1.window_id).toBe("s1:1");
            expect(body2.window_id).toBe("s1:2");
        });

        it("buffer is cleared after each dispatched window", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.0);
            mockFetchSuccess(result);

            const coord  = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            // Only enough frames for a second window if buffer was NOT cleared
            for (let i = 0; i < MIN_FRAMES - 1; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            expect(fetch).toHaveBeenCalledOnce();
        });

        it("audio MFCCs are included in the dispatched window", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.0);
            mockFetchSuccess(result);

            const coord  = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            coord.onAudio(makeChunk("s1", 1));

            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
            expect(body.mfccs).toHaveLength(1);
        });
    });

    // ── Flush ─────────────────────────────────────────────────────────────────

    describe("flushSession", () => {
        it("dispatches a partial window immediately regardless of frame threshold", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.0);
            mockFetchSuccess(result);

            const coord  = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < MIN_FRAMES - 1; i++) coord.onFrame(makeFrame("s1", i));

            await coord.flushSession("s1");

            expect(fetch).toHaveBeenCalledOnce();
        });

        it("does nothing when the buffer is empty", async () => {
            const coord = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            await coord.flushSession("s1");

            expect(fetch).not.toHaveBeenCalled();
        });

        it("clears the buffer after flushing", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.0);
            mockFetchSuccess(result);

            const coord  = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < MIN_FRAMES - 1; i++) coord.onFrame(makeFrame("s1", i));
            await coord.flushSession("s1");
            await coord.flushSession("s1");

            expect(fetch).toHaveBeenCalledOnce();
        });
    });

    // ── Evaluation communication ──────────────────────────────────────────────

    describe("evaluation communication", () => {
        it("sends a SessionUpdate to the client after a successful evaluation", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.4);
            mockFetchSuccess(result);

            const coord  = new Coordinator(makeConfig());
            const sendFn = vi.fn();
            coord.registerSession("s1", makeClip("clip_01"), sendFn);

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            expect(sendFn).toHaveBeenCalledOnce();
            const msg: SessionUpdate = sendFn.mock.calls[0][0];
            expect(msg.type).toBe("session_update");
            expect(msg.session_id).toBe("s1");
            expect(msg.escalation_score).toBe(0.4);
        });

        it("does not throw when the evaluation request fails", async () => {
            mockFetchFailure();

            const coord  = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));

            await expect(vi.advanceTimersByTimeAsync(WINDOW_MS)).resolves.not.toThrow();
        });

        it("does not send a SessionUpdate when the evaluation request fails", async () => {
            mockFetchFailure();

            const coord  = new Coordinator(makeConfig());
            const sendFn = vi.fn();
            coord.registerSession("s1", makeClip("clip_01"), sendFn);

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            expect(sendFn).not.toHaveBeenCalled();
        });
    });

    // ── Clip management ───────────────────────────────────────────────────────

    describe("clip management", () => {
        it("setClip updates the ClipMetadata used in subsequent windows", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.0);
            mockFetchSuccess(result);

            const coord = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            coord.setClip("s1", makeClip("clip_02"));

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
            expect(body.clip_metadata.clip_id).toBe("clip_02");
        });

        it("getClipAverageScore returns the mean of accumulated scores", async () => {
            vi.stubGlobal("fetch", vi.fn()
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeBehaviourResult("s1", "s1:1", 0.2)) })
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeBehaviourResult("s1", "s1:2", 0.6)) }),
            );

            const coord  = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            for (let i = MIN_FRAMES; i < MIN_FRAMES * 2; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            expect(coord.getClipAverageScore("s1")).toBeCloseTo(0.4);
        });

        it("getClipAverageScore returns null when no scores have been collected", () => {
            const coord = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            expect(coord.getClipAverageScore("s1")).toBeNull();
        });

        it("resetSession clears the score accumulator", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.8);
            mockFetchSuccess(result);

            const coord  = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            await coord.resetSession("s1");

            expect(coord.getClipAverageScore("s1")).toBeNull();
        });

        it("resetSession clears the audio buffer", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.0);
            // First call is the reset POST, second is the evaluate POST
            vi.stubGlobal("fetch", vi.fn()
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(result) }),
            );

            const coord  = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            coord.onAudio(makeChunk("s1", 1));
            await coord.resetSession("s1");

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            // Second call [1] is the evaluate POST
            const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
            expect(body.mfccs).toHaveLength(0);
        });
    });

    // ── SendFn lifecycle ──────────────────────────────────────────────────────

    describe("SendFn lifecycle", () => {
        it("does not send messages after deregisterSession is called", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.2);
            mockFetchSuccess(result);

            const coord  = new Coordinator(makeConfig());
            const sendFn = vi.fn();
            coord.registerSession("s1", makeClip("clip_01"), sendFn);

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            coord.deregisterSession("s1");

            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            expect(sendFn).not.toHaveBeenCalled();
        });

        it("stops the window timer when deregisterSession is called", async () => {
            const coord  = new Coordinator(makeConfig());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            coord.deregisterSession("s1");

            for (let i = 0; i < MIN_FRAMES; i++) coord.onFrame(makeFrame("s1", i));
            await vi.advanceTimersByTimeAsync(WINDOW_MS);

            expect(fetch).not.toHaveBeenCalled();
        });

        it("frames received for an unregistered session are ignored", () => {
            const coord = new Coordinator(makeConfig());
            expect(() => coord.onFrame(makeFrame("unknown", 1))).not.toThrow();
        });
    });
});
