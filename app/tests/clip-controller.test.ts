import { describe, it, expect, vi } from "vitest";
import { ClipController } from "../src/clip-controller.js";
import type { ClipEnded, ClipMetadata, BehaviourResult } from "@ar-training/shared";
import type { SessionManager } from "../src/session-manager.js";
import type { Coordinator } from "../src/coordinator.js";
import type { ScenarioLoader } from "../src/scenario-loader.js";
import type { FeedbackClient } from "../src/feedback-client.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClip(clipId: string, nextClip: string | null = null): ClipMetadata {
    return {
        clip_id:                  clipId,
        scenario_id:              "scenario_01",
        video_url:                `/scenarios/scenario_01/${clipId}.mp4`,
        transcript:               "Test transcript",
        clip_duration_seconds:    10.0,
        notable_features:         [],
        scoring_mode:             "rubric",
        de_escalation_rubric:     [],
        escalation_rubric:        [],
        critical_failures:        [],
        score_range:              { min: -1.0, max: 1.0 },
        clip_learning_objectives: [],
        ideal_response:           null,
        response_warnings:        [],
        branch_conditions:        [{ min_score: -1.0, max_score: 1.01, next_clip: nextClip }],
    };
}

function makeBehaviourResult(sessionId: string): BehaviourResult {
    return {
        window_id:        `${sessionId}:1`,
        session_id:       sessionId,
        escalation_score: 0.2,
        dominant_emotion: "neutral",
        confidence:       1.0,
        signal_summary: {
            vocal_tension:      0.5,
            speech_pace:        3.2,
            gesture_activity:   0.3,
            open_gesture_ratio: 0.6,
            head_nod_frequency: 0.4,
            facing_ratio:       0.8,
            silence_ratio:      0.2,
            lexical_markers:    [],
            response_tone:      "neutral",
            notable_signals:    [],
        },
    };
}

function makeClipEndedMsg(sessionId: string, clipId: string): ClipEnded {
    return { type: "clip_ended", session_id: sessionId, clip_id: clipId };
}

function makeMockSessions(overrides: Partial<SessionManager> = {}): SessionManager {
    return {
        getSession:           vi.fn().mockReturnValue({ state: "ACTIVE", scenario_id: "scenario_01", turn_count: 0, is_admin: false }),
        markPaused:           vi.fn(),
        markActive:           vi.fn(),
        appendTurn:           vi.fn(),
        endSession:           vi.fn(),
        setCurrentClip:       vi.fn(),
        buildFeedbackRequest: vi.fn().mockReturnValue({ session_id: "s1", scenario_id: "scenario_01", language: "nl", history: [] }),
        createSession:        vi.fn(),
        resumeSession:        vi.fn(),
        getQueueStatus:       vi.fn(),
        markDropped:          vi.fn(),
        ...overrides,
    } as unknown as SessionManager;
}

function makeMockAdminSessions(overrides: Partial<SessionManager> = {}): SessionManager {
    return makeMockSessions({
        getSession: vi.fn().mockReturnValue({ state: "ACTIVE", scenario_id: "scenario_01", turn_count: 0, is_admin: true }),
        ...overrides,
    });
}

function makeMockCoord(overrides: Partial<Coordinator> = {}): Coordinator {
    return {
        flushSession:      vi.fn().mockResolvedValue(undefined),
        resetSession:      vi.fn().mockResolvedValue(undefined),
        getLastResult:     vi.fn().mockReturnValue(null),
        getLastTranscript: vi.fn().mockReturnValue(null),
        getLastDebug:      vi.fn().mockReturnValue(null),
        deregisterSession: vi.fn(),
        ...overrides,
    } as unknown as Coordinator;
}

function makeMockScenarios(clip: ClipMetadata | null = makeClip("clip_01")): ScenarioLoader {
    return {
        getClip:               vi.fn().mockReturnValue(clip),
        getEntryClip:          vi.fn(),
        listScenarios:         vi.fn().mockReturnValue([]),
        getClipVideoUrl:       vi.fn(),
        getCoachingContext:    vi.fn(),
        getLearningObjectives: vi.fn(),
        getTargetAudience:     vi.fn(),
        listClips:             vi.fn().mockReturnValue([]),
    } as unknown as ScenarioLoader;
}

function makeMockFeedback(): FeedbackClient {
    return {
        stream: vi.fn().mockResolvedValue(undefined),
    } as unknown as FeedbackClient;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("ClipController", () => {

    // ── Guard conditions ──────────────────────────────────────────────────────

    describe("guard conditions", () => {
        it("does nothing when the session does not exist", async () => {
            const sessions = makeMockSessions({ getSession: vi.fn().mockReturnValue(null) });
            const coord    = makeMockCoord();
            const ctrl     = new ClipController(sessions, coord, makeMockScenarios(), makeMockFeedback());

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(coord.flushSession).not.toHaveBeenCalled();
        });

        it("does nothing when the session is not ACTIVE", async () => {
            const sessions = makeMockSessions({
                getSession: vi.fn().mockReturnValue({ state: "PAUSED", scenario_id: "scenario_01", turn_count: 0, is_admin: false }),
            });
            const coord = makeMockCoord();
            const ctrl  = new ClipController(sessions, coord, makeMockScenarios(), makeMockFeedback());

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(coord.flushSession).not.toHaveBeenCalled();
        });
    });

    // ── Transition sequence ───────────────────────────────────────────────────

    describe("transition sequence", () => {
        it("pauses the session before flushing", async () => {
            const callOrder: string[] = [];
            const sessions = makeMockSessions({
                markPaused: vi.fn().mockImplementation(() => callOrder.push("pause")),
            });
            const coord = makeMockCoord({
                flushSession: vi.fn().mockImplementation(async () => { callOrder.push("flush"); }),
            });
            const ctrl = new ClipController(sessions, coord, makeMockScenarios(makeClip("clip_01", "clip_02")), makeMockFeedback());

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(callOrder.indexOf("pause")).toBeLessThan(callOrder.indexOf("flush"));
        });

        it("resets the evaluation buffer after the turn is appended", async () => {
            const callOrder: string[] = [];
            const sessions = makeMockSessions({
                appendTurn: vi.fn().mockImplementation(() => callOrder.push("append")),
            });
            const coord = makeMockCoord({
                resetSession: vi.fn().mockImplementation(async () => { callOrder.push("reset"); }),
            });
            const ctrl = new ClipController(sessions, coord, makeMockScenarios(makeClip("clip_01", "clip_02")), makeMockFeedback());

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(callOrder.indexOf("append")).toBeLessThan(callOrder.indexOf("reset"));
        });

        it("passes is_admin to flushSession", async () => {
            const coord = makeMockCoord();
            const ctrl  = new ClipController(
                makeMockAdminSessions(), coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(coord.flushSession).toHaveBeenCalledWith("s1", true);
        });

        it("passes false to flushSession for a non-admin session", async () => {
            const coord = makeMockCoord();
            const ctrl  = new ClipController(
                makeMockSessions(), coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(coord.flushSession).toHaveBeenCalledWith("s1", false);
        });
    });

    // ── clip_candidates + clip_selected messages ──────────────────────────────

    describe("clip_candidates and clip_selected", () => {
        it("sends clip_candidates before clip_selected", async () => {
            const coord  = makeMockCoord({
                getLastResult: vi.fn().mockReturnValue(makeBehaviourResult("s1")),
            });
            const ctrl   = new ClipController(
                makeMockSessions(), coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const types = sendFn.mock.calls.map(c => c[0].type);
            expect(types.indexOf("clip_candidates")).toBeLessThan(types.indexOf("clip_selected"));
        });

        it("clip_candidates lists the possible next clip", async () => {
            const currentClip   = makeClip("clip_01", "clip_02");
            const candidateClip = makeClip("clip_02");
            const scenarios = {
                getClip:               vi.fn()
                    .mockReturnValueOnce(currentClip)
                    .mockReturnValueOnce(candidateClip)
                    .mockReturnValueOnce(candidateClip),
                getEntryClip:          vi.fn(),
                listScenarios:         vi.fn().mockReturnValue([]),
                getClipVideoUrl:       vi.fn(),
                getCoachingContext:    vi.fn(),
                getLearningObjectives: vi.fn(),
                getTargetAudience:     vi.fn(),
                listClips:             vi.fn().mockReturnValue([]),
            } as unknown as ScenarioLoader;
            const ctrl   = new ClipController(makeMockSessions(), makeMockCoord(), scenarios, makeMockFeedback());
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const candidates = sendFn.mock.calls.find(c => c[0].type === "clip_candidates")[0];
            expect(candidates.candidates).toHaveLength(1);
            expect(candidates.candidates[0].clip_id).toBe("clip_02");
        });

        it("clip_candidates is an empty array for a terminal clip", async () => {
            const ctrl   = new ClipController(
                makeMockSessions(), makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", null)),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const candidates = sendFn.mock.calls.find(c => c[0].type === "clip_candidates")[0];
            expect(candidates.candidates).toHaveLength(0);
        });

        it("clip_selected carries the resolved clip_id and clip_score", async () => {
            const coord  = makeMockCoord({
                getLastResult: vi.fn().mockReturnValue(makeBehaviourResult("s1")),
            });
            const ctrl   = new ClipController(
                makeMockSessions(), coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const selected = sendFn.mock.calls.find(c => c[0].type === "clip_selected")[0];
            expect(selected.clip_id).toBe("clip_02");
            expect(selected.clip_score).toBe(0.2);
        });

        it("clip_selected has clip_id null for a terminal clip", async () => {
            const ctrl   = new ClipController(
                makeMockSessions(), makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", null)),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const selected = sendFn.mock.calls.find(c => c[0].type === "clip_selected")[0];
            expect(selected.clip_id).toBeNull();
        });

        it("clip_candidates includes video_url for each candidate", async () => {
            const currentClip   = makeClip("clip_01", "clip_02");
            const candidateClip = makeClip("clip_02");
            const scenarios = {
                getClip:               vi.fn()
                    .mockReturnValueOnce(currentClip)
                    .mockReturnValueOnce(candidateClip)
                    .mockReturnValueOnce(candidateClip),
                getEntryClip:          vi.fn(),
                listScenarios:         vi.fn().mockReturnValue([]),
                getClipVideoUrl:       vi.fn(),
                getCoachingContext:    vi.fn(),
                getLearningObjectives: vi.fn(),
                getTargetAudience:     vi.fn(),
                listClips:             vi.fn().mockReturnValue([]),
            } as unknown as ScenarioLoader;
            const ctrl   = new ClipController(makeMockSessions(), makeMockCoord(), scenarios, makeMockFeedback());
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const candidates = sendFn.mock.calls.find(c => c[0].type === "clip_candidates")[0];
            expect(candidates.candidates[0].video_url).toBe("/scenarios/scenario_01/clip_02.mp4");
        });
    });

    // ── debug_eval message ────────────────────────────────────────────────────

    describe("debug_eval", () => {
        it("sends debug_eval after clip_selected for an admin session", async () => {
            const ctrl   = new ClipController(
                makeMockAdminSessions(), makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const types = sendFn.mock.calls.map(c => c[0].type);
            expect(types).toContain("debug_eval");
        });

        it("does not send debug_eval for a non-admin session", async () => {
            const ctrl   = new ClipController(
                makeMockSessions(), makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const types = sendFn.mock.calls.map(c => c[0].type);
            expect(types).not.toContain("debug_eval");
        });

        it("debug_eval is sent after clip_selected", async () => {
            const ctrl   = new ClipController(
                makeMockAdminSessions(), makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const types = sendFn.mock.calls.map(c => c[0].type);
            expect(types.indexOf("clip_selected")).toBeLessThan(types.indexOf("debug_eval"));
        });

        it("debug_eval carries the BehaviourResult from the coordinator", async () => {
            const result = makeBehaviourResult("s1");
            const coord  = makeMockCoord({ getLastResult: vi.fn().mockReturnValue(result) });
            const ctrl   = new ClipController(
                makeMockAdminSessions(), coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const msg = sendFn.mock.calls.find(c => c[0].type === "debug_eval")[0];
            expect(msg.result.escalation_score).toBe(0.2);
            expect(msg.result.dominant_emotion).toBe("neutral");
        });

        it("debug_eval carries analyser_id and stages from the coordinator debug payload", async () => {
            const debugPayload = { analyser_id: "stub", stages: { note: "stub analyser" } };
            const coord = makeMockCoord({ getLastDebug: vi.fn().mockReturnValue(debugPayload) });
            const ctrl  = new ClipController(
                makeMockAdminSessions(), coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const msg = sendFn.mock.calls.find(c => c[0].type === "debug_eval")[0];
            expect(msg.analyser_id).toBe("stub");
            expect(msg.stages).toEqual({ note: "stub analyser" });
        });

        it("debug_eval uses fallback result when no BehaviourResult is available", async () => {
            const coord = makeMockCoord({ getLastResult: vi.fn().mockReturnValue(null) });
            const ctrl  = new ClipController(
                makeMockAdminSessions(), coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const msg = sendFn.mock.calls.find(c => c[0].type === "debug_eval")[0];
            expect(msg.capture.eval_fallback).toBe(true);
            expect(msg.stages).toBeNull();
        });

        it("debug_eval sets stages to null when debug payload is unavailable", async () => {
            const coord = makeMockCoord({ getLastDebug: vi.fn().mockReturnValue(null) });
            const ctrl  = new ClipController(
                makeMockAdminSessions(), coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const msg = sendFn.mock.calls.find(c => c[0].type === "debug_eval")[0];
            expect(msg.stages).toBeNull();
            expect(msg.analyser_id).toBe("unknown");
        });

        it("debug_eval includes eval_latency_ms as a non-negative number", async () => {
            const ctrl   = new ClipController(
                makeMockAdminSessions(), makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const msg = sendFn.mock.calls.find(c => c[0].type === "debug_eval")[0];
            expect(typeof msg.capture.eval_latency_ms).toBe("number");
            expect(msg.capture.eval_latency_ms).toBeGreaterThanOrEqual(0);
        });

        it("debug_eval is sent for a terminal admin clip", async () => {
            const ctrl   = new ClipController(
                makeMockAdminSessions(), makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", null)),
                makeMockFeedback(),
            );
            const sendFn = vi.fn();

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), sendFn);

            const types = sendFn.mock.calls.map(c => c[0].type);
            expect(types).toContain("debug_eval");
        });
    });

    // ── Non-terminal clip ─────────────────────────────────────────────────────

    describe("non-terminal clip", () => {
        it("passes the next clip metadata to resetSession", async () => {
            const nextClip  = makeClip("clip_02");
            const scenarios = {
                getClip:               vi.fn()
                    .mockReturnValueOnce(makeClip("clip_01", "clip_02"))
                    .mockReturnValueOnce(nextClip)
                    .mockReturnValueOnce(nextClip),
                getEntryClip:          vi.fn(),
                listScenarios:         vi.fn().mockReturnValue([]),
                getClipVideoUrl:       vi.fn(),
                getCoachingContext:    vi.fn(),
                getLearningObjectives: vi.fn(),
                getTargetAudience:     vi.fn(),
                listClips:             vi.fn().mockReturnValue([]),
            } as unknown as ScenarioLoader;
            const coord = makeMockCoord();
            const ctrl  = new ClipController(makeMockSessions(), coord, scenarios, makeMockFeedback());

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(coord.resetSession).toHaveBeenCalledWith("s1", nextClip);
        });

        it("transitions the session back to ACTIVE", async () => {
            const sessions = makeMockSessions();
            const ctrl     = new ClipController(
                sessions, makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(sessions.markActive).toHaveBeenCalledWith("s1");
        });

        it("does not trigger feedback for a non-terminal clip", async () => {
            const feedback = makeMockFeedback();
            const ctrl     = new ClipController(
                makeMockSessions(), makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                feedback,
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(feedback.stream).not.toHaveBeenCalled();
        });
    });

    // ── Terminal clip ─────────────────────────────────────────────────────────

    describe("terminal clip", () => {
        it("ends the session", async () => {
            const sessions = makeMockSessions();
            const ctrl     = new ClipController(
                sessions, makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", null)),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(sessions.endSession).toHaveBeenCalledWith("s1");
        });

        it("deregisters the coordinator session on terminal clip", async () => {
            const coord = makeMockCoord();
            const ctrl  = new ClipController(
                makeMockSessions(), coord,
                makeMockScenarios(makeClip("clip_01", null)),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(coord.deregisterSession).toHaveBeenCalledWith("s1");
        });

        it("triggers feedback streaming after the session ends", async () => {
            const callOrder: string[] = [];
            const sessions  = makeMockSessions({
                endSession: vi.fn().mockImplementation(() => callOrder.push("end")),
            });
            const feedback = {
                stream: vi.fn().mockImplementation(async () => { callOrder.push("feedback"); }),
            } as unknown as FeedbackClient;
            const ctrl = new ClipController(
                sessions, makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", null)),
                feedback,
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(callOrder.indexOf("end")).toBeLessThan(callOrder.indexOf("feedback"));
        });

        it("does not transition back to ACTIVE for a terminal clip", async () => {
            const sessions = makeMockSessions();
            const ctrl     = new ClipController(
                sessions, makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", null)),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            expect(sessions.markActive).not.toHaveBeenCalled();
        });
    });

    // ── ConversationTurn ──────────────────────────────────────────────────────

    describe("ConversationTurn", () => {
        it("appends a turn with the correct turn_id", async () => {
            const sessions = makeMockSessions({
                getSession: vi.fn().mockReturnValue({ state: "ACTIVE", scenario_id: "scenario_01", turn_count: 2, is_admin: false }),
            });
            const ctrl = new ClipController(
                sessions, makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            const turn = (sessions.appendTurn as ReturnType<typeof vi.fn>).mock.calls[0][1];
            expect(turn.turn_id).toBe(3);
        });

        it("strips evaluation-only fields from the clip in ConversationTurn", async () => {
            const sessions = makeMockSessions();
            const ctrl     = new ClipController(
                sessions, makeMockCoord(),
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            const turn = (sessions.appendTurn as ReturnType<typeof vi.fn>).mock.calls[0][1];
            // Feedback fields present
            expect(turn.clip.clip_id).toBe("clip_01");
            expect(turn.clip.transcript).toBe("Test transcript");
            expect(turn.clip.notable_features).toBeDefined();
            // Evaluation-only fields absent
            expect(turn.clip.scoring_mode).toBeUndefined();
            expect(turn.clip.de_escalation_rubric).toBeUndefined();
            expect(turn.clip.escalation_rubric).toBeUndefined();
            expect(turn.clip.critical_failures).toBeUndefined();
            expect(turn.clip.score_range).toBeUndefined();
            expect(turn.clip.clip_duration_seconds).toBeUndefined();
        });

        it("uses the last BehaviourResult from the coordinator when available", async () => {
            const result   = makeBehaviourResult("s1");
            const coord    = makeMockCoord({ getLastResult: vi.fn().mockReturnValue(result) });
            const sessions = makeMockSessions();
            const ctrl     = new ClipController(
                sessions, coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            const turn = (sessions.appendTurn as ReturnType<typeof vi.fn>).mock.calls[0][1];
            expect(turn.student_response).toBe(result);
        });

        it("uses a fallback BehaviourResult when no result is available", async () => {
            const coord    = makeMockCoord({ getLastResult: vi.fn().mockReturnValue(null) });
            const sessions = makeMockSessions();
            const ctrl     = new ClipController(
                sessions, coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            const turn = (sessions.appendTurn as ReturnType<typeof vi.fn>).mock.calls[0][1];
            expect(turn.student_response.signal_summary.notable_signals).toContain("no_data");
        });

        it("fallback result uses correct new SignalSummary field names", async () => {
            const coord    = makeMockCoord({ getLastResult: vi.fn().mockReturnValue(null) });
            const sessions = makeMockSessions();
            const ctrl     = new ClipController(
                sessions, coord,
                makeMockScenarios(makeClip("clip_01", "clip_02")),
                makeMockFeedback(),
            );

            await ctrl.handleClipEnded("s1", makeClipEndedMsg("s1", "clip_01"), vi.fn());

            const summary = (sessions.appendTurn as ReturnType<typeof vi.fn>).mock.calls[0][1].student_response.signal_summary;
            expect(summary.vocal_tension).toBeDefined();
            expect(summary.gesture_activity).toBeDefined();
            expect(summary.head_nod_frequency).toBeDefined();
            expect(summary.facing_ratio).toBeDefined();
            expect(summary.silence_ratio).toBeDefined();
            expect(summary.lexical_markers).toBeDefined();
            expect(summary.response_tone).toBeDefined();
            expect(summary.open_gesture_ratio).toBeNull();
            // Old field names must not exist
            expect((summary as Record<string, unknown>).voice_tension).toBeUndefined();
            expect((summary as Record<string, unknown>).hand_velocity).toBeUndefined();
            expect((summary as Record<string, unknown>).gaze_stability).toBeUndefined();
            expect((summary as Record<string, unknown>).open_palm_ratio).toBeUndefined();
        });
    });
});