import type { ConversationTurn, FeedbackRequest } from "@ar-training/shared";
import type {
    CreateSessionResult, QueueStatusResult,
    ResumeSessionResult,
    SessionContext,
    SessionManagerConfig,
    SessionState
} from "./types.js";
import { randomUUID, timingSafeEqual } from "node:crypto";

// ─── Slot-consuming states ────────────────────────────────────────────────────

const SLOT_STATES = new Set<SessionState>(["CONNECTING", "ACTIVE", "PAUSED", "DROPPED"]);

// ─── SessionManager ───────────────────────────────────────────────────────────

export class SessionManager {
    private readonly config: SessionManagerConfig;
    private readonly sessions: Map<string, SessionContext> = new Map();
    private readonly timers: Map<string, NodeJS.Timeout> = new Map();
    private readonly queue: string[] = [];
    private readonly promotionCallbacks: Map<string, () => void> = new Map();
    private activeSlots = 0;

    constructor(config: SessionManagerConfig) {
        this.config = config;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    createSession(userId: string, language: string, isAdmin: boolean): CreateSessionResult {
        if (this.activeSlots < this.config.maxSessions) {
            const ctx = this.makeContext(userId, language, "CONNECTING", isAdmin);
            this.sessions.set(ctx.session_id, ctx);
            this.activeSlots++;
            this.startConnectionTimer(ctx.session_id);
            return { status: "active", context: ctx };
        }

        if (this.config.capacityPolicy === "REJECT") {
            return { status: "at_capacity" };
        }

        if (this.queue.length >= this.config.maxQueueSize) {
            return { status: "at_capacity" };
        }

        const pos = this.queue.length + 1;
        const ctx = this.makeContext(userId, language, "QUEUED", isAdmin, pos);
        this.sessions.set(ctx.session_id, ctx);
        this.queue.push(ctx.session_id);
        return { status: "queued", context: ctx, queue_position: pos };
    }

    resumeSession(sessionId: string): ResumeSessionResult {
        const ctx = this.sessions.get(sessionId);
        if (!ctx || ctx.state !== "DROPPED") {
            return { status: "not_found" };
        }

        this.clearTimer(sessionId);
        this.transition(ctx, "CONNECTING");
        this.startConnectionTimer(sessionId);
        return { status: "ok", context: ctx };
    }

    endSession(sessionId: string): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx) return;
        this.clearTimer(sessionId);
        const wasSlot = SLOT_STATES.has(ctx.state);
        this.transition(ctx, "COMPLETED");
        if (wasSlot) this.releaseSlot();
    }

    getSession(sessionId: string): SessionContext | null {
        return this.sessions.get(sessionId) ?? null;
    }

    getQueueStatus(sessionId: string): QueueStatusResult {
        const ctx = this.sessions.get(sessionId);
        if (!ctx) return { state: "not_found" };
        if (ctx.state === "QUEUED") return { state: "queued", queue_position: ctx.queue_position! };
        return { state: "active", queue_position: null };
    }

    markActive(sessionId: string): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx) return;
        this.clearTimer(sessionId);
        this.transition(ctx, "ACTIVE");
    }

    markPaused(sessionId: string): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx) return;
        this.transition(ctx, "PAUSED");
    }

    markDropped(sessionId: string): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx) return;
        this.clearTimer(sessionId);
        this.transition(ctx, "DROPPED");
        this.startRecoveryTimer(sessionId);
    }

    /**
     * Binds a scenario to the session. Called when the first request_clip
     * { activate: true } is received. No-op if the scenario is already set
     * (guards against duplicate calls during a resumed session).
     */
    setScenario(sessionId: string, scenarioId: string): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx || ctx.scenario_id !== null) return;
        ctx.scenario_id = scenarioId;
    }

    setCurrentClip(sessionId: string, clipId: string): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx) return;
        ctx.current_clip_id = clipId;
    }

    /**
     * Stores the coaching_context for the session. Called alongside setScenario()
     * when the first request_clip { activate: true } binds the scenario.
     * No-op if the scenario is already bound (mirrors setScenario guard).
     */
    setCoachingContext(sessionId: string, context: string | null): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx || ctx.scenario_id !== null) return;
        ctx.coaching_context = context;
    }

    /**
     * Stores the learning_objectives for the session.
     * No-op if the scenario is already bound.
     */
    setLearningObjectives(sessionId: string, objectives: string[] | null): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx || ctx.scenario_id !== null) return;
        ctx.learning_objectives = objectives;
    }

    /**
     * Stores the target_audience for the session.
     * No-op if the scenario is already bound.
     */
    setTargetAudience(sessionId: string, audience: string | null): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx || ctx.scenario_id !== null) return;
        ctx.target_audience = audience;
    }

    appendTurn(sessionId: string, turn: ConversationTurn): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx) return;
        ctx.conversation_history.push(turn);
        ctx.turn_count = ctx.conversation_history.length;
    }

    buildFeedbackRequest(sessionId: string): FeedbackRequest | null {
        const ctx = this.sessions.get(sessionId);
        if (!ctx || !ctx.scenario_id) return null;

        const req: FeedbackRequest = {
            session_id:  ctx.session_id,
            scenario_id: ctx.scenario_id,
            language:    ctx.language,
            history:     [...ctx.conversation_history],
        };

        if (ctx.coaching_context)    req.coaching_context    = ctx.coaching_context;
        if (ctx.learning_objectives) req.learning_objectives = ctx.learning_objectives;
        if (ctx.target_audience)     req.target_audience     = ctx.target_audience;

        return req;
    }

    /**
     * Registers a callback to be invoked once when a queued session is promoted
     * to CONNECTING. Called by the WebSocket handler so it can push session_ready
     * to the client without the SessionManager needing to know about sockets.
     * The callback is cleared after it fires.
     */
    setQueuedSocket(sessionId: string, onPromoted: () => void): void {
        this.promotionCallbacks.set(sessionId, onPromoted);
    }

    /**
     * Checks whether the provided token is a valid admin key using a
     * timing-safe comparison to prevent key enumeration via timing attacks.
     * Returns false if ADMIN_API_KEY is unset, making admin mode unavailable.
     */
    isAdminToken(token: string | undefined): boolean {
        if (!this.config.adminApiKey || !token) return false;
        // timingSafeEqual requires equal-length buffers; length mismatch is
        // itself non-secret information, so an early false here is acceptable.
        const a = Buffer.from(token);
        const b = Buffer.from(this.config.adminApiKey);
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private makeContext(
        userId:   string,
        language: string,
        state:    SessionState,
        isAdmin:  boolean,
        queuePos: number | null = null,
    ): SessionContext {
        return {
            session_id:           randomUUID(),
            user_id:              userId,
            state,
            scenario_id:          null,
            language,
            current_clip_id:      null,
            conversation_history: [],
            turn_count:           0,
            queue_position:       queuePos,
            is_admin:             isAdmin,
            coaching_context:     null,
            learning_objectives:  null,
            target_audience:      null,
        };
    }

    private transition(ctx: SessionContext, next: SessionState): void {
        ctx.state = next;
        if (next !== "QUEUED") ctx.queue_position = null;
    }

    private releaseSlot(): void {
        this.activeSlots--;
        this.promoteNext();
    }

    private promoteNext(): void {
        if (this.queue.length === 0) return;
        const nextId = this.queue.shift()!;
        const ctx = this.sessions.get(nextId);
        if (!ctx) return;

        this.transition(ctx, "CONNECTING");
        this.activeSlots++;
        this.startConnectionTimer(nextId);

        // Notify the waiting WebSocket that its session is ready.
        const cb = this.promotionCallbacks.get(nextId);
        if (cb) {
            this.promotionCallbacks.delete(nextId);
            cb();
        }

        this.queue.forEach((id, i) => {
            const c = this.sessions.get(id);
            if (c) c.queue_position = i + 1;
        });
    }

    private startConnectionTimer(sessionId: string): void {
        const handle = setTimeout(() => {
            const ctx = this.sessions.get(sessionId);
            if (!ctx || ctx.state !== "CONNECTING") return;
            this.transition(ctx, "DROPPED");
            this.startRecoveryTimer(sessionId);
        }, this.config.sessionTimeoutMs);
        this.timers.set(sessionId, handle);
    }

    private startRecoveryTimer(sessionId: string): void {
        const handle = setTimeout(() => {
            const ctx = this.sessions.get(sessionId);
            if (!ctx || ctx.state !== "DROPPED") return;
            this.transition(ctx, "EXPIRED");
            this.releaseSlot();
        }, this.config.recoveryWindowMs);
        this.timers.set(sessionId, handle);
    }

    private clearTimer(sessionId: string): void {
        const handle = this.timers.get(sessionId);
        if (handle) {
            clearTimeout(handle);
            this.timers.delete(sessionId);
        }
    }
}