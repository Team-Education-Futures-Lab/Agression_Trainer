// =============================================================================
// AR Training — App Container Internal Types
// Types used exclusively within the App container.
// Not shared across container boundaries.
//
// Shared cross-container types: shared/types.ts
// =============================================================================

import type { ConversationTurn } from "@ar-training/shared";

// ─── Session state machine ────────────────────────────────────────────────────

export type SessionState =
    | "CONNECTING"
    | "QUEUED"
    | "ACTIVE"
    | "PAUSED"
    | "COMPLETED"
    | "DROPPED"
    | "EXPIRED";

// ─── Session context ──────────────────────────────────────────────────────────

/**
 * The App container's full internal view of a session.
 * Maintained in memory for the lifetime of the session.
 */
export interface SessionContext {
    session_id:           string;
    user_id:              string;
    state:                SessionState;
    scenario_id:          string;
    language:             string;
    /** The clip currently playing, or null if the session has not started. */
    current_clip_id:      string | null;
    /** Completed turns accumulated during the session, in order. */
    conversation_history: ConversationTurn[];
    /** Convenience accessor — always equal to conversation_history.length. */
    turn_count:           number;
    /** 1-indexed position in the waiting queue, or null if not queued. */
    queue_position:       number | null;
}

// ─── Coordinator config ───────────────────────────────────────────────────────

/**
 * Configuration for the Coordinator, populated from environment variables.
 * See .env.example for defaults.
 */
export interface CoordinatorConfig {
    /** One or more Evaluation instance base URLs.
     *  A single entry is the common case; multiple entries enable session-pinned
     *  load distribution via EvaluationRouter. */
    evaluationUrls:     string[];
    /** Shared secret sent as Authorization: Bearer on all outbound AI requests. */
    internalApiKey:     string;
    /** Minimum number of frames required to dispatch a window. Windows below
     *  this threshold are discarded. Flush bypasses this check. */
    minFramesPerWindow: number;
    /** Duration of each analysis window in milliseconds. Default: 2000. */
    windowMs:           number;
}

// ─── Session Manager config ───────────────────────────────────────────────────

/**
 * Configuration for the SessionManager, populated from environment variables.
 * See .env.example for defaults.
 */
export interface SessionManagerConfig {
    /** Maximum number of concurrent active sessions. Default: 32. */
    maxSessions:      number;
    /** Maximum number of sessions allowed to wait in the queue. */
    maxQueueSize:     number;
    /** What to do when at capacity: hold new sessions in a queue or reject them. */
    capacityPolicy:   "QUEUE" | "REJECT";
    /** How long to wait for a WebSocket connection before dropping the session (ms). */
    sessionTimeoutMs: number;
    /** How long a DROPPED session can be resumed before it expires (ms). */
    recoveryWindowMs: number;
}

// ─── Session Manager results ──────────────────────────────────────────────────

/**
 * Result of SessionManager.createSession().
 * The Fastify route handler translates this into the correct HTTP response
 * as defined in docs/API_CONTRACT.md.
 *
 *   "active"      → 200 { state: "active", ... }
 *   "queued"      → 200 { state: "queued", queue_position, ... }
 *   "at_capacity" → 503 { error: "at_capacity" }
 */
export type CreateSessionResult =
    | { status: "active";      context: SessionContext }
    | { status: "queued";      context: SessionContext; queue_position: number }
    | { status: "at_capacity" };

/**
 * Result of SessionManager.resumeSession().
 * The Fastify route handler translates this into the correct HTTP response
 * as defined in docs/API_CONTRACT.md.
 *
 *   "ok"        → 200 { session_id, state, scenario_id, current_clip_id, turn_count }
 *   "not_found" → 404 { error: "session_not_found" }
 */
export type ResumeSessionResult =
    | { status: "ok";        context: SessionContext }
    | { status: "not_found" };

/**
 * Result of SessionManager.getQueueStatus().
 * The Fastify route handler translates this into the correct HTTP response
 * as defined in docs/API_CONTRACT.md.
 *
 *   "queued"    → 200 { state: "queued", queue_position }
 *   "active"    → 200 { state: "active", queue_position: null }
 *   "not_found" → 404 { error: "session_not_found" }
 */
export type QueueStatusResult =
    | { state: "queued";    queue_position: number }
    | { state: "active";    queue_position: null }
    | { state: "not_found" };
