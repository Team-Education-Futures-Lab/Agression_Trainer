import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StubFeedbackGenerator } from "../src/stub-feedback-generator.js";
import type { FeedbackRequest, BehaviourResult, ConversationTurn, ClipMetadata } from "@ar-training/shared";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeClip(clipId: string): ClipMetadata {
    return {
        clip_id:          clipId,
        scenario_id:      "scenario_01",
        video_url:        `/scenarios/scenario_01/${clipId}.mp4`,
        transcript:       "Dit is niet eerlijk!",
        notable_features: ["raised_voice"],
        branch_conditions: [
            { min_score: -1.0, max_score: 1.01, next_clip: null },
        ],
    };
}

function makeResult(sessionId: string): BehaviourResult {
    return {
        window_id:       `${sessionId}:0`,
        session_id:      sessionId,
        escalation_score: 0.4,
        dominant_emotion: "frustrated",
        confidence:      1.0,
        signal_summary: {
            voice_tension:  0.5,
            speech_pace:    3.2,
            hand_velocity:  0.3,
            gaze_stability: 0.7,
            open_palm_ratio: 0.6,
            notable_signals: ["stub_mode"],
        },
    };
}

function makeTurn(sessionId: string, turnId: number, clipId: string): ConversationTurn {
    return {
        turn_id:            turnId,
        clip:               makeClip(clipId),
        student_response:   makeResult(sessionId),
        student_transcript: "Ik snap het niet.",
    };
}

function makeRequest(sessionId: string, turns: ConversationTurn[]): FeedbackRequest {
    return {
        session_id:  sessionId,
        scenario_id: "scenario_01",
        language:    "nl",
        history:     turns,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("StubFeedbackGenerator", () => {
    const stub = new StubFeedbackGenerator();

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    describe("generate()", () => {
        it("returns session_id from request", async () => {
            const req = makeRequest("sess-1", [makeTurn("sess-1", 0, "clip_01")]);
            const result = await stub.generate(req);
            expect(result.session_id).toBe("sess-1");
        });

        it("always returns severity medium", async () => {
            const req = makeRequest("sess-2", [makeTurn("sess-2", 0, "clip_01")]);
            const result = await stub.generate(req);
            expect(result.severity).toBe("medium");
        });

        it("returns non-empty advice string", async () => {
            const req = makeRequest("sess-3", [makeTurn("sess-3", 0, "clip_01")]);
            const result = await stub.generate(req);
            expect(result.advice.length).toBeGreaterThan(0);
            expect(result.advice).toContain("[STUB]");
        });

        it("highlights references first turn when history has one entry", async () => {
            const req = makeRequest("sess-4", [makeTurn("sess-4", 1, "clip_01")]);
            const result = await stub.generate(req);
            expect(result.highlights.length).toBe(1);
            expect(result.highlights[0]).toContain("Turn 1");
        });

        it("highlights references first and last turn when history has multiple entries", async () => {
            const turns = [
                makeTurn("sess-5", 1, "clip_01"),
                makeTurn("sess-5", 2, "clip_02"),
                makeTurn("sess-5", 3, "clip_03"),
            ];
            const req = makeRequest("sess-5", turns);
            const result = await stub.generate(req);
            expect(result.highlights.length).toBe(2);
            expect(result.highlights[0]).toContain("Turn 1");
            expect(result.highlights[1]).toContain("Turn 3");
        });

        it("returns empty highlights for empty history", async () => {
            const req = makeRequest("sess-6", []);
            const result = await stub.generate(req);
            expect(result.highlights).toEqual([]);
        });
    });

    describe("generateStream()", () => {
        async function collectTokens(req: FeedbackRequest): Promise<string[]> {
            const tokens: string[] = [];
            const gen = stub.generateStream(req);
            while (true) {
                // Start (or resume) the generator first — this runs it up to the
                // next `await setTimeout`, where it suspends. Then advance the
                // clock to fire that timer, which lets gen.next() resolve.
                const next = gen.next();
                await vi.advanceTimersByTimeAsync(30);
                const { value, done } = await next;
                if (done) break;
                tokens.push(value);
            }
            return tokens;
        }

        it("yields at least one token", async () => {
            const req = makeRequest("sess-7", [makeTurn("sess-7", 0, "clip_01")]);
            const tokens = await collectTokens(req);
            expect(tokens.length).toBeGreaterThan(0);
        });

        it("accumulated tokens reconstruct the advice", async () => {
            const req = makeRequest("sess-8", [makeTurn("sess-8", 0, "clip_01")]);
            const tokens = await collectTokens(req);
            const expected = await stub.generate(req);
            expect(tokens.join("").trim()).toBe(expected.advice);
        });

        it("each token ends with a space (word-by-word split)", async () => {
            const req = makeRequest("sess-9", [makeTurn("sess-9", 0, "clip_01")]);
            const tokens = await collectTokens(req);
            for (const token of tokens) {
                expect(token).toMatch(/ $/);
            }
        });
    });
});