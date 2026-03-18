// noinspection DuplicatedCode

import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import type { ConversationTurn } from "@ar-training/shared";
import type { SessionManagerConfig } from "../src/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SessionManagerConfig> = {}): SessionManagerConfig {
    return {
        maxSessions:      2,
        maxQueueSize:     2,
        capacityPolicy:   "QUEUE",
        sessionTimeoutMs: 30_000,
        recoveryWindowMs: 30_000,
        adminApiKey:      undefined,
        ...overrides,
    };
}

function makeTurn(turn_id: number): ConversationTurn {
    return {
        turn_id,
        clip: {
            clip_id:           `clip_0${turn_id}`,
            scenario_id:       "scenario_01",
            video_url:         `/scenarios/scenario_01/clip_0${turn_id}.mp4`,
            transcript:        "Test transcript",
            notable_features:  [],
            branch_conditions: [{ min_score: -1.0, max_score: 1.01, next_clip: null }],
        },
        student_response: {
            window_id:        `session_abc:${turn_id}`,
            session_id:       "session_abc",
            escalation_score:  0.1,
            dominant_emotion:  "neutral",
            confidence:        1.0,
            signal_summary: {
                voice_tension:   0.5,
                speech_pace:     3.2,
                hand_velocity:   0.3,
                gaze_stability:  0.7,
                open_palm_ratio: 0.6,
                notable_signals: [],
            },
        },
        student_transcript: "Test response",
    };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("SessionManager", () => {

    // ── Capacity & admission ──────────────────────────────────────────────────

    describe("capacity and admission", () => {
        it("returns status 'active' with a SessionContext when under capacity", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);

            expect(result.status).toBe("active");
            if (result.status !== "active") return;

            expect(result.context.session_id).toBeTypeOf("string");
            expect(result.context.state).toBe("CONNECTING");
            expect(result.context.scenario_id).toBeNull();
            expect(result.context.language).toBe("nl");
            expect(result.context.is_admin).toBe(false);
        });

        it("returns status 'queued' with queue_position when at capacity and policy is QUEUE", () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE" }));

            sm.createSession("user_1", "nl", false);
            sm.createSession("user_2", "nl", false);
            const result = sm.createSession("user_3", "nl", false);

            expect(result.status).toBe("queued");
            if (result.status !== "queued") return;

            expect(result.queue_position).toBe(1);
            expect(result.context.state).toBe("QUEUED");
        });

        it("returns status 'at_capacity' when at capacity and policy is REJECT", () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "REJECT" }));

            sm.createSession("user_1", "nl", false);
            sm.createSession("user_2", "nl", false);
            const result = sm.createSession("user_3", "nl", false);

            expect(result.status).toBe("at_capacity");
        });

        it("returns status 'at_capacity' when the queue itself is full", () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE", maxQueueSize: 1 }));

            sm.createSession("user_1", "nl", false);
            sm.createSession("user_2", "nl", false);
            sm.createSession("user_3", "nl", false); // fills the queue
            const result = sm.createSession("user_4", "nl", false);

            expect(result.status).toBe("at_capacity");
        });

        it("queue positions are 1-indexed and increment correctly", () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE", maxQueueSize: 3 }));

            sm.createSession("user_1", "nl", false);
            sm.createSession("user_2", "nl", false);
            const r1 = sm.createSession("user_3", "nl", false);
            const r2 = sm.createSession("user_4", "nl", false);

            expect(r1.status).toBe("queued");
            expect(r2.status).toBe("queued");
            if (r1.status !== "queued" || r2.status !== "queued") return;

            expect(r1.queue_position).toBe(1);
            expect(r2.queue_position).toBe(2);
        });

        it("promotes queued session to CONNECTING when an active session ends", () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE" }));

            const s1     = sm.createSession("user_1", "nl", false);
            sm.createSession("user_2", "nl", false);
            const queued = sm.createSession("user_3", "nl", false);

            expect(queued.status).toBe("queued");
            if (s1.status !== "active" || queued.status !== "queued") return;

            sm.markActive(s1.context.session_id);
            sm.endSession(s1.context.session_id);

            const promoted = sm.getSession(queued.context.session_id);
            expect(promoted!.state).toBe("CONNECTING");
            expect(promoted!.queue_position).toBeNull();
        });

        it("calls the promotion callback when a queued session is promoted", () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE" }));

            const s1     = sm.createSession("user_1", "nl", false);
            sm.createSession("user_2", "nl", false);
            const queued = sm.createSession("user_3", "nl", false);

            if (s1.status !== "active" || queued.status !== "queued") return;

            const onPromoted = vi.fn();
            sm.setQueuedSocket(queued.context.session_id, onPromoted);

            sm.markActive(s1.context.session_id);
            sm.endSession(s1.context.session_id);

            expect(onPromoted).toHaveBeenCalledOnce();
        });

        it("does not call the promotion callback a second time after it fires", () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE" }));

            const s1 = sm.createSession("user_1", "nl", false);
            const s2 = sm.createSession("user_2", "nl", false);
            const q1 = sm.createSession("user_3", "nl", false);
            const q2 = sm.createSession("user_4", "nl", false);

            if (s1.status !== "active" || s2.status !== "active"
                || q1.status !== "queued" || q2.status !== "queued") return;

            const cb1 = vi.fn();
            const cb2 = vi.fn();
            sm.setQueuedSocket(q1.context.session_id, cb1);
            sm.setQueuedSocket(q2.context.session_id, cb2);

            sm.markActive(s1.context.session_id);
            sm.endSession(s1.context.session_id); // promotes q1

            expect(cb1).toHaveBeenCalledOnce();
            expect(cb2).not.toHaveBeenCalled();

            sm.markActive(s2.context.session_id);
            sm.endSession(s2.context.session_id); // promotes q2

            expect(cb1).toHaveBeenCalledOnce(); // still only once
            expect(cb2).toHaveBeenCalledOnce();
        });

        it("getQueueStatus returns current position while queued", () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE" }));

            sm.createSession("user_1", "nl", false);
            sm.createSession("user_2", "nl", false);
            const queued = sm.createSession("user_3", "nl", false);

            if (queued.status !== "queued") return;

            const status = sm.getQueueStatus(queued.context.session_id);
            expect(status.state).toBe("queued");
            if (status.state !== "queued") return;
            expect(status.queue_position).toBe(1);
        });

        it("getQueueStatus returns 'active' with null queue_position after promotion", () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE" }));

            const s1     = sm.createSession("user_1", "nl", false);
            sm.createSession("user_2", "nl", false);
            const queued = sm.createSession("user_3", "nl", false);

            if (s1.status !== "active" || queued.status !== "queued") return;

            sm.markActive(s1.context.session_id);
            sm.endSession(s1.context.session_id);

            const status = sm.getQueueStatus(queued.context.session_id);
            expect(status.state).toBe("active");
            if (status.state !== "active") return;
            expect(status.queue_position).toBeNull();
        });
    });

    // ── State transitions ─────────────────────────────────────────────────────

    describe("state transitions", () => {
        it("fresh session starts in CONNECTING state", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);

            expect(result.status).toBe("active");
            if (result.status !== "active") return;
            expect(result.context.state).toBe("CONNECTING");
        });

        it("transitions to ACTIVE via markActive", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            expect(sm.getSession(result.context.session_id)!.state).toBe("ACTIVE");
        });

        it("transitions ACTIVE → PAUSED when clip ends", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markPaused(result.context.session_id);
            expect(sm.getSession(result.context.session_id)!.state).toBe("PAUSED");
        });

        it("transitions PAUSED → ACTIVE when next clip starts", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markPaused(result.context.session_id);
            sm.markActive(result.context.session_id);
            expect(sm.getSession(result.context.session_id)!.state).toBe("ACTIVE");
        });

        it("transitions to COMPLETED when endSession is called", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.endSession(result.context.session_id);
            expect(sm.getSession(result.context.session_id)!.state).toBe("COMPLETED");
        });

        it("transitions ACTIVE → DROPPED on unexpected disconnect", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markDropped(result.context.session_id);
            expect(sm.getSession(result.context.session_id)!.state).toBe("DROPPED");
        });

        it("transitions DROPPED → CONNECTING on resume within recovery window", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markDropped(result.context.session_id);

            const resumed = sm.resumeSession(result.context.session_id);
            expect(resumed.status).toBe("ok");
            if (resumed.status !== "ok") return;
            expect(resumed.context.state).toBe("CONNECTING");
        });

        it("transitions DROPPED → EXPIRED when recovery window passes without resume", async () => {
            vi.useFakeTimers();
            const sm     = new SessionManager(makeConfig({ recoveryWindowMs: 30_000 }));
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markDropped(result.context.session_id);
            await vi.advanceTimersByTimeAsync(30_000);

            expect(sm.getSession(result.context.session_id)!.state).toBe("EXPIRED");
            vi.useRealTimers();
        });

        it("transitions CONNECTING → DROPPED when no activation arrives within session timeout", async () => {
            vi.useFakeTimers();
            const sm     = new SessionManager(makeConfig({ sessionTimeoutMs: 30_000 }));
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            await vi.advanceTimersByTimeAsync(30_000);

            expect(sm.getSession(result.context.session_id)!.state).toBe("DROPPED");
            vi.useRealTimers();
        });

        it("resuming an ACTIVE session returns status 'not_found'", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            const resumed = sm.resumeSession(result.context.session_id);
            expect(resumed.status).toBe("not_found");
        });
    });

    // ── Scenario binding ──────────────────────────────────────────────────────

    describe("scenario binding", () => {
        it("scenario_id is null on a fresh session", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            expect(result.context.scenario_id).toBeNull();
        });

        it("setScenario binds the scenario_id", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.setScenario(result.context.session_id, "scenario_01");
            expect(sm.getSession(result.context.session_id)!.scenario_id).toBe("scenario_01");
        });

        it("setScenario is a no-op if the scenario is already bound", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.setScenario(result.context.session_id, "scenario_01");
            sm.setScenario(result.context.session_id, "scenario_02"); // should be ignored
            expect(sm.getSession(result.context.session_id)!.scenario_id).toBe("scenario_01");
        });

        it("buildFeedbackRequest returns null if scenario is not yet bound", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            expect(sm.buildFeedbackRequest(result.context.session_id)).toBeNull();
        });

        it("buildFeedbackRequest succeeds once the scenario is bound", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.setScenario(result.context.session_id, "scenario_01");
            sm.appendTurn(result.context.session_id, makeTurn(1));

            const req = sm.buildFeedbackRequest(result.context.session_id);
            expect(req).not.toBeNull();
            expect(req!.scenario_id).toBe("scenario_01");
            expect(req!.history).toHaveLength(1);
        });
    });

    // ── Admin mode ────────────────────────────────────────────────────────────

    describe("admin mode", () => {
        it("is_admin is false for a normal session", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            expect(result.context.is_admin).toBe(false);
        });

        it("is_admin is true when the session is created with isAdmin=true", () => {
            const sm     = new SessionManager(makeConfig({ adminApiKey: "secret" }));
            const result = sm.createSession("user_1", "nl", true);
            if (result.status !== "active") return;

            expect(result.context.is_admin).toBe(true);
        });

        it("isAdminToken returns true for the correct token", () => {
            const sm = new SessionManager(makeConfig({ adminApiKey: "secret-key" }));
            expect(sm.isAdminToken("secret-key")).toBe(true);
        });

        it("isAdminToken returns false for an incorrect token", () => {
            const sm = new SessionManager(makeConfig({ adminApiKey: "secret-key" }));
            expect(sm.isAdminToken("wrong-key")).toBe(false);
        });

        it("isAdminToken returns false when adminApiKey is not configured", () => {
            const sm = new SessionManager(makeConfig({ adminApiKey: undefined }));
            expect(sm.isAdminToken("any-token")).toBe(false);
        });

        it("isAdminToken returns false for an empty string token", () => {
            const sm = new SessionManager(makeConfig({ adminApiKey: "secret-key" }));
            expect(sm.isAdminToken("")).toBe(false);
        });

        it("isAdminToken returns false for undefined", () => {
            const sm = new SessionManager(makeConfig({ adminApiKey: "secret-key" }));
            expect(sm.isAdminToken(undefined)).toBe(false);
        });
    });

    // ── Session data ──────────────────────────────────────────────────────────

    describe("session data", () => {
        it("appendTurn accumulates ConversationTurns in order", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.appendTurn(result.context.session_id, makeTurn(1));
            sm.appendTurn(result.context.session_id, makeTurn(2));
            sm.appendTurn(result.context.session_id, makeTurn(3));

            const session = sm.getSession(result.context.session_id);
            expect(session!.conversation_history).toHaveLength(3);
            expect(session!.conversation_history.map(t => t.turn_id)).toEqual([1, 2, 3]);
        });

        it("turn_count mirrors conversation_history length", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.appendTurn(result.context.session_id, makeTurn(1));
            sm.appendTurn(result.context.session_id, makeTurn(2));

            expect(sm.getSession(result.context.session_id)!.turn_count).toBe(2);
        });

        it("buildFeedbackRequest compiles history into a correct FeedbackRequest", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.setScenario(result.context.session_id, "scenario_01");
            sm.appendTurn(result.context.session_id, makeTurn(1));
            sm.appendTurn(result.context.session_id, makeTurn(2));

            const req = sm.buildFeedbackRequest(result.context.session_id);
            expect(req).not.toBeNull();
            expect(req!.session_id).toBe(result.context.session_id);
            expect(req!.scenario_id).toBe("scenario_01");
            expect(req!.language).toBe("nl");
            expect(req!.history).toHaveLength(2);
        });

        it("resumeSession restores turn_count and current_clip_id", () => {
            const sm     = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.setScenario(result.context.session_id, "scenario_01");
            sm.appendTurn(result.context.session_id, makeTurn(1));
            sm.setCurrentClip(result.context.session_id, "clip_02_calm");
            sm.markDropped(result.context.session_id);

            const resumed = sm.resumeSession(result.context.session_id);
            expect(resumed.status).toBe("ok");
            if (resumed.status !== "ok") return;

            expect(resumed.context.turn_count).toBe(1);
            expect(resumed.context.current_clip_id).toBe("clip_02_calm");
            expect(resumed.context.scenario_id).toBe("scenario_01");
        });
    });

    // ── Edge cases ────────────────────────────────────────────────────────────

    describe("edge cases", () => {
        it("resuming an EXPIRED session returns status 'not_found'", async () => {
            vi.useFakeTimers();
            const sm     = new SessionManager(makeConfig({ recoveryWindowMs: 30_000 }));
            const result = sm.createSession("user_1", "nl", false);
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markDropped(result.context.session_id);
            await vi.advanceTimersByTimeAsync(30_000);

            const resumed = sm.resumeSession(result.context.session_id);
            expect(resumed.status).toBe("not_found");
            vi.useRealTimers();
        });

        it("resuming an unknown session ID returns status 'not_found'", () => {
            const sm = new SessionManager(makeConfig());
            expect(sm.resumeSession("non-existent-id").status).toBe("not_found");
        });

        it("capacity slot is released when session reaches COMPLETED", () => {
            const sm = new SessionManager(makeConfig({ maxSessions: 1 }));
            const s1 = sm.createSession("user_1", "nl", false);
            if (s1.status !== "active") return;

            sm.markActive(s1.context.session_id);
            sm.endSession(s1.context.session_id);

            const s2 = sm.createSession("user_2", "nl", false);
            expect(s2.status).toBe("active");
        });

        it("capacity slot is released when session reaches EXPIRED", async () => {
            vi.useFakeTimers();
            const sm = new SessionManager(makeConfig({ maxSessions: 1, recoveryWindowMs: 30_000 }));
            const s1 = sm.createSession("user_1", "nl", false);
            if (s1.status !== "active") return;

            sm.markActive(s1.context.session_id);
            sm.markDropped(s1.context.session_id);
            await vi.advanceTimersByTimeAsync(30_000);

            const s2 = sm.createSession("user_2", "nl", false);
            expect(s2.status).toBe("active");
            vi.useRealTimers();
        });
    });
});