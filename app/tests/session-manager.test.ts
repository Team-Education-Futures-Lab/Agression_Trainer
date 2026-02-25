// noinspection DuplicatedCode

import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import type { ConversationTurn } from "@ar-training/shared";
import {SessionManagerConfig} from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SessionManagerConfig> = {}): SessionManagerConfig {
    return {
        maxSessions:      2,
        maxQueueSize:     2,
        capacityPolicy:   "QUEUE",
        sessionTimeoutMs: 30_000,
        recoveryWindowMs: 30_000,
        ...overrides,
    };
}

function makeTurn(turn_id: number): ConversationTurn {
    return {
        turn_id,
        clip: {
            clip_id:           `clip_0${turn_id}`,
            scenario_id:       "scenario_01",
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
        it("returns status 'active' with a SessionContext when under capacity", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");

            expect(result.status).toBe("active");
            if (result.status !== "active") return;

            expect(result.context.session_id).toBeTypeOf("string");
            expect(result.context.state).toBe("CONNECTING");
            expect(result.context.scenario_id).toBe("scenario_01");
            expect(result.context.language).toBe("nl");
        });

        it("returns status 'queued' with queue_position when at capacity and policy is QUEUE", async () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE" }));

            sm.createSession("user_1", "scenario_01", "nl");
            sm.createSession("user_2", "scenario_01", "nl");
            const result = sm.createSession("user_3", "scenario_01", "nl");

            expect(result.status).toBe("queued");
            if (result.status !== "queued") return;

            expect(result.queue_position).toBe(1);
            expect(result.context.state).toBe("QUEUED");
        });

        it("returns status 'at_capacity' when at capacity and policy is REJECT", async () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "REJECT" }));

            sm.createSession("user_1", "scenario_01", "nl");
            sm.createSession("user_2", "scenario_01", "nl");
            const result = sm.createSession("user_3", "scenario_01", "nl");

            expect(result.status).toBe("at_capacity");
        });

        it("returns status 'at_capacity' when the queue itself is full", async () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE", maxQueueSize: 1 }));

            sm.createSession("user_1", "scenario_01", "nl");
            sm.createSession("user_2", "scenario_01", "nl");
            sm.createSession("user_3", "scenario_01", "nl"); // fills the queue
            const result = sm.createSession("user_4", "scenario_01", "nl");

            expect(result.status).toBe("at_capacity");
        });

        it("queue positions are 1-indexed and increment correctly", async () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE", maxQueueSize: 3 }));

            sm.createSession("user_1", "scenario_01", "nl");
            sm.createSession("user_2", "scenario_01", "nl");
            const r1 = sm.createSession("user_3", "scenario_01", "nl");
            const r2 = sm.createSession("user_4", "scenario_01", "nl");

            expect(r1.status).toBe("queued");
            expect(r2.status).toBe("queued");
            if (r1.status !== "queued" || r2.status !== "queued") return;

            expect(r1.queue_position).toBe(1);
            expect(r2.queue_position).toBe(2);
        });

        it("promotes queued session to CONNECTING when an active session ends", async () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE" }));

            const s1 = sm.createSession("user_1", "scenario_01", "nl");
            sm.createSession("user_2", "scenario_01", "nl");
            const queued = sm.createSession("user_3", "scenario_01", "nl");

            expect(queued.status).toBe("queued");
            if (s1.status !== "active" || queued.status !== "queued") return;

            sm.markActive(s1.context.session_id);
            sm.endSession(s1.context.session_id);

            const promoted = sm.getSession(queued.context.session_id);
            expect(promoted!.state).toBe("CONNECTING");
            expect(promoted!.queue_position).toBeNull();
        });

        it("getQueueStatus returns current position while queued", async () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE" }));

            sm.createSession("user_1", "scenario_01", "nl");
            sm.createSession("user_2", "scenario_01", "nl");
            const queued = sm.createSession("user_3", "scenario_01", "nl");

            if (queued.status !== "queued") return;

            const status = sm.getQueueStatus(queued.context.session_id);
            expect(status.state).toBe("queued");
            if (status.state !== "queued") return;
            expect(status.queue_position).toBe(1);
        });

        it("getQueueStatus returns state 'active' with null queue_position after promotion", async () => {
            const sm = new SessionManager(makeConfig({ capacityPolicy: "QUEUE" }));

            const s1 = sm.createSession("user_1", "scenario_01", "nl");
            sm.createSession("user_2", "scenario_01", "nl");
            const queued = sm.createSession("user_3", "scenario_01", "nl");

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
        it("fresh session starts in CONNECTING state", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");

            expect(result.status).toBe("active");
            if (result.status !== "active") return;
            expect(result.context.state).toBe("CONNECTING");
        });

        it("transitions to ACTIVE when WebSocket opens", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            expect(sm.getSession(result.context.session_id)!.state).toBe("ACTIVE");
        });

        it("transitions ACTIVE → PAUSED when clip ends", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markPaused(result.context.session_id);
            expect(sm.getSession(result.context.session_id)!.state).toBe("PAUSED");
        });

        it("transitions PAUSED → ACTIVE when next clip starts", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markPaused(result.context.session_id);
            sm.markActive(result.context.session_id);
            expect(sm.getSession(result.context.session_id)!.state).toBe("ACTIVE");
        });

        it("transitions to COMPLETED when endSession is called", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.endSession(result.context.session_id);
            expect(sm.getSession(result.context.session_id)!.state).toBe("COMPLETED");
        });

        it("transitions ACTIVE → DROPPED on unexpected disconnect", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markDropped(result.context.session_id);
            expect(sm.getSession(result.context.session_id)!.state).toBe("DROPPED");
        });

        it("transitions DROPPED → CONNECTING on resume within recovery window", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");
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
            const sm = new SessionManager(makeConfig({ recoveryWindowMs: 30_000 }));
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markDropped(result.context.session_id);
            await vi.advanceTimersByTimeAsync(30_000);

            expect(sm.getSession(result.context.session_id)!.state).toBe("EXPIRED");
            vi.useRealTimers();
        });

        it("transitions CONNECTING → DROPPED when WebSocket never opens within session timeout", async () => {
            vi.useFakeTimers();
            const sm = new SessionManager(makeConfig({ sessionTimeoutMs: 30_000 }));
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            await vi.advanceTimersByTimeAsync(30_000);

            expect(sm.getSession(result.context.session_id)!.state).toBe("DROPPED");
            vi.useRealTimers();
        });
    });

    // ── Session data ──────────────────────────────────────────────────────────

    describe("session data", () => {
        it("appendTurn accumulates ConversationTurns in order", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.appendTurn(result.context.session_id, makeTurn(1));
            sm.appendTurn(result.context.session_id, makeTurn(2));
            sm.appendTurn(result.context.session_id, makeTurn(3));

            const session = sm.getSession(result.context.session_id);
            expect(session!.conversation_history).toHaveLength(3);
            expect(session!.conversation_history.map(t => t.turn_id)).toEqual([1, 2, 3]);
        });

        it("buildFeedbackRequest compiles history into a correct FeedbackRequest", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.appendTurn(result.context.session_id, makeTurn(1));
            sm.appendTurn(result.context.session_id, makeTurn(2));

            const req = sm.buildFeedbackRequest(result.context.session_id);
            expect(req).not.toBeNull();
            expect(req!.session_id).toBe(result.context.session_id);
            expect(req!.scenario_id).toBe("scenario_01");
            expect(req!.language).toBe("nl");
            expect(req!.history).toHaveLength(2);
        });

        it("resumeSession restores turn_count and current_clip_id", async () => {
            const sm = new SessionManager(makeConfig());
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.appendTurn(result.context.session_id, makeTurn(1));
            sm.setCurrentClip(result.context.session_id, "clip_02_calm");
            sm.markDropped(result.context.session_id);

            const resumed = sm.resumeSession(result.context.session_id);
            expect(resumed.status).toBe("ok");
            if (resumed.status !== "ok") return;

            expect(resumed.context.turn_count).toBe(1);
            expect(resumed.context.current_clip_id).toBe("clip_02_calm");
        });
    });

    // ── Edge cases ────────────────────────────────────────────────────────────

    describe("edge cases", () => {
        it("resuming an EXPIRED session returns status 'not_found'", async () => {
            vi.useFakeTimers();
            const sm = new SessionManager(makeConfig({ recoveryWindowMs: 30_000 }));
            const result = sm.createSession("user_1", "scenario_01", "nl");
            if (result.status !== "active") return;

            sm.markActive(result.context.session_id);
            sm.markDropped(result.context.session_id);
            await vi.advanceTimersByTimeAsync(30_000);

            const resumed = sm.resumeSession(result.context.session_id);
            expect(resumed.status).toBe("not_found");
            vi.useRealTimers();
        });

        it("resuming an unknown session ID returns status 'not_found'", async () => {
            const sm = new SessionManager(makeConfig());
            const resumed = sm.resumeSession("non-existent-id");
            expect(resumed.status).toBe("not_found");
        });

        it("capacity slot is released when session reaches COMPLETED", async () => {
            const sm = new SessionManager(makeConfig({ maxSessions: 1 }));
            const s1 = sm.createSession("user_1", "scenario_01", "nl");
            if (s1.status !== "active") return;

            sm.markActive(s1.context.session_id);
            sm.endSession(s1.context.session_id);

            const s2 = sm.createSession("user_2", "scenario_01", "nl");
            expect(s2.status).toBe("active");
        });

        it("capacity slot is released when session reaches EXPIRED", async () => {
            vi.useFakeTimers();
            const sm = new SessionManager(makeConfig({ maxSessions: 1, recoveryWindowMs: 30_000 }));
            const s1 = sm.createSession("user_1", "scenario_01", "nl");
            if (s1.status !== "active") return;

            sm.markActive(s1.context.session_id);
            sm.markDropped(s1.context.session_id);
            await vi.advanceTimersByTimeAsync(30_000);

            const s2 = sm.createSession("user_2", "scenario_01", "nl");
            expect(s2.status).toBe("active");
            vi.useRealTimers();
        });
    });
});
