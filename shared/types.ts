// =============================================================================
// AR Training — Shared Types
// Single source of truth for all TypeScript DTOs.
// Used by: client/, app/, feedback/
// Mirror these manually in evaluation/src/interfaces.py (Python dataclasses)
// =============================================================================


// ─── Primitives ───────────────────────────────────────────────────────────────

export interface Landmark {
    x: number;
    y: number;
    z: number;
    visibility: number;
}

/** Format: "{session_id}:{sequence}" */
export type WindowID = string;

// ─── Client → Server (WebSocket) ─────────────────────────────────────────────

export interface VideoFrame {
    type: "video_frame";
    session_id: string;
    frame_id: number;
    timestamp: number;          // seconds since session start
    face_landmarks: Landmark[]; // 478 entries
    left_hand: Landmark[];      // 21 entries, empty array if not detected
    right_hand: Landmark[];     // 21 entries, empty array if not detected
}

export interface AudioChunk {
    type: "audio_chunk";
    session_id: string;
    chunk_id: number;
    timestamp: number;      // seconds since session start
    pcm: string;            // base64-encoded raw s16le PCM bytes
    sample_rate: number;    // typically 16000
    mfccs: number[][];      // [n_frames][13] pre-computes via Meyda.js
}

export type ClientMessage = VideoFrame | AudioChunk;

// ─── Server → Client (WebSocket) ─────────────────────────────────────────────

export interface SessionUpdate {
    type: "session_update";
    session_id: string;
    window_id: WindowID;
    escalation_score: number;       // -1.0 to 1.0
    queue_position: number | null;
}

export interface SessionComplete {
    type: "session_complete";
    session_id: string;
    advice: string;
    severity: "low" | "medium" | "high";
    highlights: string[];
}

export interface FeedbackToken {
    type: "feedback_token";
    session_id: string;
    token: string;
}

export interface ServerError {
    type: "error";
    session_id: string;
    code: string;
    message: string;
}

export type ServerMessage = SessionUpdate | SessionComplete | FeedbackToken | ServerError;

// ─── HTTP — Session management ────────────────────────────────────────────────

export interface CreateSessionRequest {
    user_id: string;
    session_id: string;
    language: string;   // ISO 639-1, e.g. "en"
}

export interface CreateSessionResponse {
    session_id: string;
    state: "active" | "queued";
    scenario_id?: string;
    language?: string;
    queue_position?: number;
}

export interface ResumeSessionResponse {
    session_id: string;
    state: string;
    scenario_id: string;
    current_clip_id: string;
    turn_count: number;
}

export interface QueueStatusResponse {
    session_id: string;
    state: "active" | "queued";
    queue_position: number | null;
}

// ─── Scenario / Clip ──────────────────────────────────────────────────────────

export interface BranchCondition {
    min_score: number;           // inclusive
    max_score: number;           // exclusive
    next_clip: string | null;    // null = terminal clip, end of scenario
}

export interface ClipMetadata {
    clip_id: string;
    scenario_id: string;
    transcript: string;
    notable_features: string[];
    branch_conditions: BranchCondition[];
}

// ─── Client-side session state ────────────────────────────────────────────────

export type SessionState =
    | "idle"
    | "connecting"
    | "queued"
    | "active"
    | "paused"
    | "completed"
    | "dropped"
    | "error";