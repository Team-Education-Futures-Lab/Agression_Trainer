// =============================================================================
// AR Training — Shared Types
// Single source of truth for all TypeScript DTOs that cross container boundaries.
// Used by: client/, app/, feedback/
//
// Python equivalent: evaluation/src/interfaces.py
// Wire format reference: docs/api_contract.md
// =============================================================================

// ─── Primitives ───────────────────────────────────────────────────────────────

/** A single landmark point in normalized image coordinates (0..1). */
export interface Landmark {
    x: number;
    y: number;
    z: number;
    /** Confidence that the landmark is visible. May be absent for some models. */
    visibility: number;
}

/** Unique identifier for a clip's analysis window. One window is produced per clip. Format: `"{session_id}:{clip_sequence}"` */
export type WindowID = string;

/**
 * A matrix of Mel-frequency cepstral coefficients.
 * Rows are time frames, columns are the 13 MFCC coefficients (Meyda default).
 * Shape: [n_frames][13]
 */
export type MfccMatrix = number[][];

// ─── Client → Server (WebSocket) ─────────────────────────────────────────────

/**
 * One frame of landmark data extracted from the webcam by MediaPipe.js.
 * Sent continuously over WebSocket while a session is active.
 *
 * `face_landmarks` contains 478 points. Hand arrays contain 21 points each,
 * or are empty if the hand is not detected in the frame.
 */
export interface VideoFrame {
    type: "video_frame";
    session_id: string;
    /** Monotonically increasing counter, reset to 0 at session start. */
    frame_id: number;
    /** Seconds elapsed since session start. */
    timestamp: number;
    /** 478 MediaPipe face mesh landmarks in normalized image coordinates. */
    face_landmarks: Landmark[];
    /** 21 hand landmarks, or empty array if left hand is not detected. */
    left_hand: Landmark[];
    /** 21 hand landmarks, or empty array if right hand is not detected. */
    right_hand: Landmark[];
}

/**
 * One chunk of audio data from the microphone, covering approximately 2 seconds.
 *
 * Contains both raw PCM (for Whisper transcription server-side) and pre-computed
 * MFCCs (for the behavior classifier). Sending both avoids duplicating the
 * bandwidth cost — raw audio is ~64KB per chunk, MFCCs are ~3KB.
 */
export interface AudioChunk {
    type: "audio_chunk";
    session_id: string;
    /** Monotonically increasing counter, reset to 0 at session start. */
    chunk_id: number;
    /** Seconds elapsed since session start. */
    timestamp: number;
    /** Base64-encoded raw s16le PCM bytes, resampled to `sample_rate`. */
    pcm: string;
    /** Always 16000 Hz — required by Whisper. */
    sample_rate: number;
    /** `[n_frames][13]` MFCCs pre-computed client-side via Meyda.js. */
    mfccs: MfccMatrix;
}

/**
 * Sent by the client when a scenario clip finishes playing.
 *
 * The App container uses this to:
 *   1. Immediately send `clip_candidates` for all possible next clips
 *   2. Signal the ClipSession to flush and finalise the transcript
 *   3. Await the resolved AnalysisWindow and dispatch it to Evaluation
 *   4. Resolve the next clip from branch_conditions using the returned escalation_score
 *   5. Append a ConversationTurn to the session history
 *   6. Send `clip_selected` identifying which candidate to play
 *   7. Transition ACTIVE → PAUSED → ACTIVE (or COMPLETED if terminal)
 *
 * The client must stop sending VideoFrame and AudioChunk messages after
 * sending this and wait for ClipSelected (or FeedbackToken/SessionComplete
 * if the clip is terminal).
 */
export interface ClipEnded {
    type: "clip_ended";
    session_id: string;
    clip_id: string;
}

/**
 * Requests clip metadata and video URL from the App container.
 *
 * `activate: true` — the client intends to play this clip. On a fresh session
 * this also binds the scenario and transitions the session from CONNECTING to
 * ACTIVE. Must target the scenario's entry clip unless the session is admin or
 * resumed. Only one activate call is permitted per clip transition; clip
 * advancement is driven by `clip_ended` / `clip_selected`, not by further
 * activate calls.
 *
 * `activate: false` — preload only. Pure data lookup with no state change.
 * Valid at any point during the session, including while a clip is playing.
 */
export interface RequestClip {
    type: "request_clip";
    session_id: string;
    scenario_id: string;
    clip_id: string;
    /** True to play this clip; false to preload only. */
    activate: boolean;
}

/**
 * Requests the list of available scenarios from the App container.
 * May be sent at any point after the WebSocket connection is open.
 */
export interface GetScenarios {
    type: "get_scenarios";
    session_id: string;
}

export type ClientMessage = VideoFrame | AudioChunk | ClipEnded | RequestClip | GetScenarios;

// ─── Server → Client (WebSocket) ─────────────────────────────────────────────

/**
 * Sent by the App container when a transcript segment arrives from the
 * Transcription container during a clip.
 *
 * Carries the accumulated transcript for the current clip so far.
 * Intended for development and debugging — the client may choose not to
 * display this to students in production.
 *
 * `queue_position`: the App container always sends `null` here. Queue
 * position is communicated via `session_ready` (on promotion) and the
 * `GET /session/{id}/queue` polling endpoint. The field is typed as
 * `number | null` rather than `null` because the client constructs
 * synthetic `SessionUpdate` messages internally (e.g. to surface the
 * initial queue position from the HTTP create response) and needs to
 * populate this field with a non-null value.
 */
export interface SessionUpdate {
    type: "session_update";
    session_id: string;
    /** Accumulated transcript for the current clip so far. */
    transcript: string;
    /** Always null when sent by the server. May be non-null in client-constructed messages. */
    queue_position: number | null;
}

/**
 * Sent by the App container when a queued session is promoted to active.
 * The client should proceed to scenario discovery (get_scenarios) or clip
 * selection (request_clip) after receiving this message.
 */
export interface SessionReady {
    type: "session_ready";
    session_id: string;
}

/**
 * Sent in response to a `get_scenarios` message.
 * Contains summary metadata for all scenarios available on the server.
 * Full clip details are fetched separately via `request_clip`.
 */
export interface ScenariosListMessage {
    type: "scenarios_list";
    session_id: string;
    scenarios: ScenarioSummary[];
}

/**
 * Summary metadata for a single scenario, returned in `ScenariosListMessage`.
 * Does not include per-clip details — those are fetched via `request_clip`.
 */
export interface ScenarioSummary {
    scenario_id: string;
    title: string;
    description: string;
    /** ISO 639-1 language code, e.g. `"nl"`. */
    language: string;
    /** The clip_id the client should use for the first `request_clip` call. */
    entry_clip_id: string;
}

/**
 * Sent in response to a `request_clip` message.
 * Contains all information the client needs to load and display the clip,
 * including the video URL and branch conditions for preloading candidates.
 */
export interface ClipData {
    type: "clip_data";
    session_id: string;
    clip_id: string;
    scenario_id: string;
    /**
     * Browser-relative URL path for the video file.
     * Served by the client Nginx container from the mounted scenarios directory.
     * e.g. `/scenarios/scenario_01/clip_01_intro.mp4`
     */
    video_url: string;
    /** Verbatim transcript of the dialogue in this clip. */
    transcript: string;
    /** Observable behaviors in the clip relevant to de-escalation. */
    notable_features: string[];
    branch_conditions: BranchCondition[];
}

/**
 * Sent immediately when the App receives a `clip_ended` message, before
 * evaluation completes. Contains full clip data for every clip that could
 * possibly follow, so the client can begin preloading all candidates in
 * parallel while evaluation is running.
 *
 * `candidates` is an empty array when all branch conditions have
 * `next_clip: null` (terminal clip — no next clip to preload).
 */
export interface ClipCandidates {
    type: "clip_candidates";
    session_id: string;
    candidates: ClipCandidateData[];
}

/**
 * Full clip data for a single candidate in a `ClipCandidates` message.
 * Same fields as `ClipData` minus the message envelope fields.
 */
export interface ClipCandidateData {
    clip_id: string;
    video_url: string;
    transcript: string;
    notable_features: string[];
    branch_conditions: BranchCondition[];
}

/**
 * Sent once evaluation completes, after `ClipCandidates`.
 * Identifies which candidate the client should actually play.
 *
 * When `clip_id` is null the scenario is complete — the client should
 * wait for `FeedbackToken` and `SessionComplete` messages.
 */
export interface ClipSelected {
    type: "clip_selected";
    session_id: string;
    /** The clip to play. Null if the scenario is terminal. */
    clip_id: string | null;
    /** The escalation_score that drove this branching decision. */
    clip_score: number;
}

/**
 * Sent once at the end of a session when feedback generation is complete.
 * Delivered over the still-open WebSocket after the terminal clip is reached.
 */
export interface SessionComplete {
    type: "session_complete";
    session_id: string;
    /** Full debrief advice generated by the LLM. */
    advice: string;
    severity: "low" | "medium" | "high";
    /** Notable moments from the session, e.g. `"Turn 2: voice tension spiked"`. */
    highlights: string[];
}

/**
 * Streamed token-by-token from the Feedback container while advice is being
 * generated. Arrives before `SessionComplete`.
 */
export interface FeedbackToken {
    type: "feedback_token";
    session_id: string;
    token: string;
}

/** Sent by the App container when a recoverable or fatal error occurs. */
export interface ServerError {
    type: "error";
    session_id: string;
    /**
     * Machine-readable error code.
     * e.g. `"session_expired"`, `"invalid_frame"`, `"feedback_unavailable"`,
     * `"scenario_not_found"`, `"clip_not_found"`, `"activate_not_permitted"`.
     */
    code: string;
    message: string;
}

export type ServerMessage =
    | SessionUpdate
    | SessionReady
    | ScenariosListMessage
    | ClipData
    | ClipCandidates
    | ClipSelected
    | SessionComplete
    | FeedbackToken
    | ServerError;

// ─── HTTP — Session management ────────────────────────────────────────────────

/**
 * Body for `POST /session/create`.
 * `scenario_id` is no longer required at creation time — the scenario is
 * bound later via `request_clip` with `activate: true`.
 *
 * Admin mode: include `Authorization: Bearer <ADMIN_API_KEY>` to create an
 * admin session. Admin sessions bypass clip activation restrictions, allowing
 * any clip to be activated regardless of scenario entry point. If `ADMIN_API_KEY`
 * is unset in the server environment, admin mode is permanently unavailable.
 */
export interface CreateSessionRequest {
    user_id: string;
    /** ISO 639-1 language code, e.g. `"nl"`. */
    language: string;
}

/**
 * Returned by `POST /session/create`.
 *
 * `ws_path` is the WebSocket endpoint the client should connect to immediately.
 * When `state` is `"queued"` the server is at capacity; the client should open
 * the WebSocket and wait for a `session_ready` message before proceeding.
 */
export interface CreateSessionResponse {
    session_id: string;
    state: "active" | "queued";
    /** WebSocket endpoint path, e.g. `"/ws/{session_id}"`. */
    ws_path: string;
    /** Only present when `state === "queued"`. */
    queue_position?: number;
}

/**
 * Returned by `POST /session/{id}/resume`.
 *
 * `scenario_id` and `current_clip_id` are null if the session was dropped
 * before a scenario was bound via `request_clip`.
 *
 * `ws_path` is included so the client does not need to infer it from the
 * session ID — consistent with `CreateSessionResponse`.
 */
export interface ResumeSessionResponse {
    session_id: string;
    state: string;
    scenario_id: string | null;
    current_clip_id: string | null;
    /** Number of turns already completed before the resume. */
    turn_count: number;
    /** WebSocket endpoint path, e.g. `"/ws/{session_id}"`. */
    ws_path: string;
}

export interface QueueStatusResponse {
    session_id: string;
    state: "queued" | "active";
    queue_position: number | null;
}

// ─── Scenario / Clip ──────────────────────────────────────────────────────────

/**
 * Determines which clip plays next based on the `escalation_score` from the
 * single BehaviourResult produced for the current clip.
 *
 * Conditions are evaluated in order — the first match wins.
 * Together they must cover the full range from -1.0 to 1.0 with no gaps.
 */
export interface BranchCondition {
    /** Inclusive lower bound. */
    min_score: number;
    /** Exclusive upper bound. */
    max_score: number;
    /** ID of the next clip to play, or `null` to end the scenario. */
    next_clip: string | null;
}

/**
 * Metadata for a single clip within a scenario.
 *
 * Used internally by the App container and forwarded to the Evaluation and
 * Feedback containers as part of `AnalysisWindow` and `ConversationTurn`.
 * `video_url` is constructed by the App and ignored by Evaluation and Feedback.
 */
export interface ClipMetadata {
    clip_id: string;
    scenario_id: string;
    /**
     * Browser-relative URL path for the video file.
     * Constructed by the App container; ignored by Evaluation and Feedback.
     * e.g. `/scenarios/scenario_01/clip_01_intro.mp4`
     */
    video_url: string;
    /** Verbatim transcript of the dialogue in this clip. */
    transcript: string;
    /**
     * Observable behaviors in the clip relevant to de-escalation,
     * e.g. `"raised_voice"`, `"aggressive_posture"`. Used as context by the
     * classifier and LLM. See `docs/scenario_schema.md` for recommended values.
     */
    notable_features: string[];
    branch_conditions: BranchCondition[];
}

// ─── Evaluation — cross-container requests ───────────────────────────────────

/**
 * A clip-scoped window of captured data covering the student's complete response
 * to one clip. Assembled by ClipSession and dispatched once per clip to the
 * Evaluation container when the Transcription service emits its final segment.
 *
 * Wire format: POST /evaluate/analyse
 */
export interface AnalysisWindow {
    window_id:     WindowID;
    session_id:    string;
    frames:        VideoFrame[];
    /** Flattened MFCCs from all AudioChunks accumulated during the clip. [n_frames][13] */
    mfccs:         MfccMatrix;
    /** Complete transcript of the student's response for this clip. */
    transcript:    string;
    clip_metadata: ClipMetadata;
}

// ─── Evaluation — cross-container results ────────────────────────────────────

/**
 * A summary of the multimodal signals detected in a single analysis window.
 * Produced by the Evaluation container, forwarded to the Feedback container
 * as part of each ConversationTurn.
 */
export interface SignalSummary {
    /** 0.0 (relaxed) to 1.0 (tense). */
    voice_tension: number;
    /** Syllables per second. */
    speech_pace: number;
    /** Average landmark movement per frame. */
    hand_velocity: number;
    /** 0.0 (erratic) to 1.0 (steady). */
    gaze_stability: number;
    /** Ratio of frames where an open palm is detected. */
    open_palm_ratio: number;
    /** Notable signals detected, e.g. `"raised_voice"`, `"stub_mode"`. */
    notable_signals: string[];
}

/**
 * The result of analyzing a clip's complete AnalysisWindow.
 * Produced by the Evaluation container, consumed by the App container
 * (for clip branching) and the Feedback container (for debrief).
 */
export interface BehaviourResult {
    window_id: WindowID;
    session_id: string;
    /** -1.0 = strongly de-escalating, 1.0 = strongly escalating. */
    escalation_score: number;
    dominant_emotion: string;
    /** 0.0 to 1.0. */
    confidence: number;
    signal_summary: SignalSummary;
}

// ─── Feedback — cross-container types ────────────────────────────────────────

/**
 * A single turn in the conversation — one clip the student responded to,
 * paired with the behavior analysis of their response.
 *
 * Accumulated by the App container during a session and compiled into a
 * FeedbackRequest at session end.
 */
export interface ConversationTurn {
    turn_id: number;
    clip: ClipMetadata;
    student_response: BehaviourResult;
    student_transcript: string;
}

/**
 * Sent from the App container to the Feedback container at session end.
 * Contains the full conversation history needed to generate a debrief.
 *
 * Wire format: POST /feedback/generate
 */
export interface FeedbackRequest {
    session_id: string;
    scenario_id: string;
    /** ISO 639-1 language code, e.g. `"nl"`. */
    language: string;
    history: ConversationTurn[];
    /**
     * Optional scenario-specific description of the professional role and
     * context the student is practising. Used by the Feedback container to
     * frame its coaching prompt for the scenario.
     *
     * e.g. `"De student oefent het de-escaleren van een boze persoon in de
     * rol van docent in het MBO."`
     *
     * When absent the Feedback container falls back to a generic Dutch
     * de-escalation training description. Populated from the scenario's
     * `coaching_context` metadata field when present.
     */
    coaching_context?: string;
}

/**
 * Debrief generated by the Feedback container at session end.
 * Returned by POST /feedback/generate and carried in the `complete` SSE event
 * from POST /feedback/generate/stream.
 *
 * Also the source for the `session_complete` WebSocket message fields.
 */
export interface Feedback {
    session_id: string;
    /** Full debrief advice generated by the LLM. */
    advice: string;
    severity: "low" | "medium" | "high";
    /** Notable moments from the session, e.g. `"Turn 2: voice tension spiked"`. */
    highlights: string[];
}

// ─── Client-side session state ────────────────────────────────────────────────

/**
 * The client's view of the current session state.
 *
 * Mirrors the server-side state machine defined in `docs/session_lifecycle.md`,
 * with an additional `"idle"` state for before any session has been created.
 */
export type SessionState =
    | "idle"
    | "connecting"
    | "queued"
    | "selecting"
    | "active"
    | "paused"
    | "completed"
    | "dropped"
    | "error";