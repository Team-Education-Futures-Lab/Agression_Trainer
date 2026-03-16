import type { ConversationTurn, FeedbackRequest } from "@ar-training/shared";
import type {
    CreateSessionResult, QueueStatusResult,
    ResumeSessionResult,
    SessionContext,
    SessionManagerConfig,
    SessionState
} from "./types.js";
import {randomUUID} from "node:crypto";

// ─── Slot-consuming states ────────────────────────────────────────────────────

const SLOT_STATES = new Set<SessionState>(["CONNECTING", "ACTIVE", "PAUSED", "DROPPED"]);

// ─── SessionManager ───────────────────────────────────────────────────────────

export class SessionManager {
    private readonly config: SessionManagerConfig;
    private readonly sessions: Map<string, SessionContext> = new Map();
    private readonly timers: Map<string, NodeJS.Timeout> = new Map();
    private readonly queue: string[] = [];
    private activeSlots = 0;

    constructor(config: SessionManagerConfig) {
        this.config = config;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    createSession(userId: string, scenarioId: string, language: string): CreateSessionResult {
        if (this.activeSlots < this.config.maxSessions) {
            const ctx = this.makeContext(userId, scenarioId, language, "CONNECTING");
            this.sessions.set(ctx.session_id, ctx);
            this.activeSlots++;
            this.startConnectionTimer(ctx.session_id);
            return {status: "active", context: ctx};
        }

        if (this.config.capacityPolicy === "REJECT") {
            return {status: "at_capacity"};
        }

        if (this.queue.length >= this.config.maxQueueSize) {
            return {status: "at_capacity"};
        }

        const pos = this.queue.length + 1;
        const ctx = this.makeContext(userId, scenarioId, language, "QUEUED", pos);
        this.sessions.set(ctx.session_id, ctx);
        this.queue.push(ctx.session_id);
        return { status: "queued", context: ctx, queue_position: pos};
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

    setCurrentClip(sessionId: string, clipId: string): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx) return;
        ctx.current_clip_id = clipId;
    }

    appendTurn(sessionId: string, turn: ConversationTurn): void {
        const ctx = this.sessions.get(sessionId);
        if (!ctx) return;
        ctx.conversation_history.push(turn);
        ctx.turn_count = ctx.conversation_history.length;
    }

    buildFeedbackRequest(sessionId: string): FeedbackRequest | null {
        const ctx = this.sessions.get(sessionId);
        if (!ctx) return null;
        return {
            session_id:  ctx.session_id,
            scenario_id: ctx.scenario_id,
            language:    ctx.language,
            history:     [...ctx.conversation_history],
        };
    }
    // ── Internal ──────────────────────────────────────────────────────────────

    private makeContext(
        userId: string,
        scenarioId: string,
        language: string,
        state: SessionState,
        queuePos: number | null = null,
    ): SessionContext {
        return {
            session_id: randomUUID(),
            user_id: userId,
            state,
            scenario_id: scenarioId,
            language,
            current_clip_id: null,
            conversation_history: [],
            turn_count: 0,
            queue_position: queuePos,
        }
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