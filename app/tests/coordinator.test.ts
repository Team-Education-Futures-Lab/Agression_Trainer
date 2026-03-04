import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import type { VideoFrame, AudioChunk, ClipMetadata, BehaviourResult } from "@ar-training/shared";
import type { CoordinatorConfig } from "../src/types.js";
import type { TranscriptionClient } from "../src/transcription-client.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EVALUATION_URL = "http://evaluation:8001";

function makeConfig(): CoordinatorConfig {
    return {
        evaluationUrls:    [EVALUATION_URL],
        transcriptionUrls: ["http://transcription:8003"],
        internalApiKey:    "test-key",
    };
}

function makeMockTranscription(): TranscriptionClient {
    return {
        openSession:     vi.fn(),
        closeSession:    vi.fn(),
        sendAudio:       vi.fn(),
        finaliseSession: vi.fn().mockResolvedValue(undefined),
        resetSession:    vi.fn().mockResolvedValue(undefined),
        getUrl:          vi.fn().mockReturnValue("http://transcription:8003"),
    } as unknown as TranscriptionClient;
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
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok:     false,
            status: 500,
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── Session registration ──────────────────────────────────────────────────

    describe("session registration", () => {
        it("opens a transcription session on register", () => {
            const transcription = makeMockTranscription();
            const coord = new Coordinator(makeConfig(), transcription);
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            expect(transcription.openSession).toHaveBeenCalledWith("s1");
        });

        it("closes transcription and releases eval router on deregister", () => {
            const transcription = makeMockTranscription();
            const coord = new Coordinator(makeConfig(), transcription);
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            coord.deregisterSession("s1");
            expect(transcription.closeSession).toHaveBeenCalledWith("s1");
        });

        it("frames received for an unregistered session are ignored", () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            expect(() => coord.onFrame(makeFrame("unknown", 1))).not.toThrow();
        });
    });

    // ── Frame and audio buffering ─────────────────────────────────────────────

    describe("frame and audio buffering", () => {
        it("does not dispatch to evaluation before flushSession is called", async () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < 30; i++) coord.onFrame(makeFrame("s1", i));

            expect(fetch).not.toHaveBeenCalled();
        });

        it("forwards audio chunks to the transcription client", () => {
            const transcription = makeMockTranscription();
            const coord = new Coordinator(makeConfig(), transcription);
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            const chunk = makeChunk("s1", 1);
            coord.onAudio(chunk);

            expect(transcription.sendAudio).toHaveBeenCalledWith(chunk);
        });
    });

    // ── Flush (clip-scoped dispatch) ──────────────────────────────────────────

    describe("flushSession", () => {
        it("finalises transcription before dispatching to evaluation", async () => {
            const callOrder: string[] = [];
            const transcription = makeMockTranscription();
            (transcription.finaliseSession as ReturnType<typeof vi.fn>)
                .mockImplementation(async () => { callOrder.push("finalise"); });

            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.2));
            vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
                callOrder.push("evaluate");
                return { ok: true, json: () => Promise.resolve(makeBehaviourResult("s1", "s1:1", 0.2)) };
            }));

            const coord = new Coordinator(makeConfig(), transcription);
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            await coord.flushSession("s1");

            expect(callOrder.indexOf("finalise")).toBeLessThan(callOrder.indexOf("evaluate"));
        });

        it("dispatches one AnalysisWindow to evaluation on flush", async () => {
            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.2));

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            await coord.flushSession("s1");

            expect(fetch).toHaveBeenCalledOnce();
        });

        it("does nothing when the frame buffer is empty", async () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            await coord.flushSession("s1");

            expect(fetch).not.toHaveBeenCalled();
        });

        it("includes the accumulated transcript in the dispatched window", async () => {
            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.0));

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            coord.onTranscript("s1", "Goed", true);
            coord.onTranscript("s1", "gedaan", true);

            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));
            await coord.flushSession("s1");

            const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
            expect(body.transcript).toBe("Goed gedaan");
        });

        it("includes all accumulated MFCCs in the dispatched window", async () => {
            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.0));

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            coord.onAudio(makeChunk("s1", 1));
            coord.onAudio(makeChunk("s1", 2));
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            await coord.flushSession("s1");

            const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
            expect(body.mfccs).toHaveLength(2);
        });

        it("includes correct session_id and ClipMetadata in dispatched window", async () => {
            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.0));
            const clip = makeClip("clip_01");

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", clip, vi.fn());
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            await coord.flushSession("s1");

            const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
            expect(body.session_id).toBe("s1");
            expect(body.clip_metadata.clip_id).toBe("clip_01");
        });

        it("clears the frame buffer after flushing", async () => {
            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.0));

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));
            await coord.flushSession("s1");
            await coord.flushSession("s1"); // second flush — buffer empty, no dispatch

            expect(fetch).toHaveBeenCalledOnce();
        });

        it("stores the BehaviourResult as lastResult after a successful evaluation", async () => {
            const result = makeBehaviourResult("s1", "s1:1", 0.4);
            mockFetchSuccess(result);

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            await coord.flushSession("s1");

            expect(coord.getLastResult("s1")).toEqual(result);
        });

        it("does not throw when the evaluation request fails", async () => {
            mockFetchFailure();

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));

            await expect(coord.flushSession("s1")).resolves.not.toThrow();
        });

        it("WindowID sequence increments across clips", async () => {
            const result1 = makeBehaviourResult("s1", "s1:1", 0.1);
            const result2 = makeBehaviourResult("s1", "s1:2", 0.2);
            vi.stubGlobal("fetch", vi.fn()
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(result1) })
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(result2) }),
            );

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));
            await coord.flushSession("s1");

            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));
            await coord.flushSession("s1");

            const body1 = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
            const body2 = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
            expect(body1.window_id).toBe("s1:1");
            expect(body2.window_id).toBe("s1:2");
        });
    });

    // ── Transcript accumulation ───────────────────────────────────────────────

    describe("transcript accumulation", () => {
        it("accumulates final transcript segments separated by spaces", () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            coord.onTranscript("s1", "Hallo", true);
            coord.onTranscript("s1", "wereld", true);

            expect(coord.getLastTranscript("s1")).toBe("Hallo wereld");
        });

        it("also accumulates partial transcript segments", () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            coord.onTranscript("s1", "Hal", false);
            coord.onTranscript("s1", "lo", true);

            expect(coord.getLastTranscript("s1")).toBe("Hal lo");
        });

        it("sends a SessionUpdate only on final transcript segments", () => {
            const sendFn = vi.fn();
            const coord  = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), sendFn);

            coord.onTranscript("s1", "partial", false);
            expect(sendFn).not.toHaveBeenCalled();

            coord.onTranscript("s1", "final", true);
            expect(sendFn).toHaveBeenCalledOnce();
        });

        it("SessionUpdate contains the full accumulated transcript so far", () => {
            const sendFn = vi.fn();
            const coord  = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), sendFn);

            coord.onTranscript("s1", "eerste", true);
            coord.onTranscript("s1", "tweede", true);

            const lastMsg = sendFn.mock.calls[1][0];
            expect(lastMsg.type).toBe("session_update");
            expect(lastMsg.transcript).toBe("eerste tweede");
        });

        it("getLastTranscript returns null before any transcript arrives", () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            expect(coord.getLastTranscript("s1")).toBeNull();
        });

        it("ignores transcript for unknown session", () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            expect(() => coord.onTranscript("unknown", "text", true)).not.toThrow();
        });
    });

    // ── Reset ─────────────────────────────────────────────────────────────────

    describe("resetSession", () => {
        it("clears accumulated frames", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));
            await coord.resetSession("s1");

            const callCountAfterReset = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

            await coord.flushSession("s1"); // nothing to flush — frames were cleared

            // No additional fetch calls beyond the reset POST itself
            expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountAfterReset);
        });

        it("clears the accumulated transcript", async () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            coord.onTranscript("s1", "some text", true);
            await coord.resetSession("s1");

            expect(coord.getLastTranscript("s1")).toBeNull();
        });

        it("calls resetSession on the transcription client", async () => {
            const transcription = makeMockTranscription();
            const coord = new Coordinator(makeConfig(), transcription);
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            await coord.resetSession("s1");

            expect(transcription.resetSession).toHaveBeenCalledWith(
                "s1",
                expect.any(String),
            );
        });

        it("calls the evaluation reset endpoint", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            await coord.resetSession("s1");

            const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
            expect(url).toContain("/evaluate/reset/s1");
        });

        it("reopens the transcription session after reset", async () => {
            const transcription = makeMockTranscription();
            const coord = new Coordinator(makeConfig(), transcription);
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());

            await coord.resetSession("s1");

            // openSession called once on register, once after reset
            expect(transcription.openSession).toHaveBeenCalledTimes(2);
        });
    });

    // ── Clip management ───────────────────────────────────────────────────────

    describe("clip management", () => {
        it("setClip updates the ClipMetadata used in subsequent flushes", async () => {
            mockFetchSuccess(makeBehaviourResult("s1", "s1:1", 0.0));

            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            coord.setClip("s1", makeClip("clip_02"));

            for (let i = 0; i < 5; i++) coord.onFrame(makeFrame("s1", i));
            await coord.flushSession("s1");

            const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
            expect(body.clip_metadata.clip_id).toBe("clip_02");
        });
    });

    // ── Last result ───────────────────────────────────────────────────────────

    describe("last result", () => {
        it("returns null before any flush", () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            coord.registerSession("s1", makeClip("clip_01"), vi.fn());
            expect(coord.getLastResult("s1")).toBeNull();
        });

        it("returns null for an unknown session", () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            expect(coord.getLastResult("unknown")).toBeNull();
        });

        it("returns null for an unknown session transcript", () => {
            const coord = new Coordinator(makeConfig(), makeMockTranscription());
            expect(coord.getLastTranscript("unknown")).toBeNull();
        });
    });
});
