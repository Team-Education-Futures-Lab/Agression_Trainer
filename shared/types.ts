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

/**
 * A single recognised word with its start and end time relative to clip start.
 * Produced by the Transcription container with session-level timing (seconds
 * from the last clip reset) and accumulated by the App container across all
 * TranscriptMessages for the clip.
 * Forwarded in AnalysisWindow to the Evaluation container for accurate
 * silence_ratio and speech_pace computation.
 */
export interface WordTiming {
    word:  string;
    /** Seconds from clip start (session-level, reset on each clip reset). */
    start: number;
    /** Seconds from clip start (session-level, reset on each clip reset). */
    end:   number;
}

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
 * MFCCs (for the behaviour analyser). Sending both avoids duplicating the
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
 *
 * Does not include rubric or scoring fields from ClipMetadata — those are
 * evaluation/feedback-internal and must not be exposed to the student.
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
    /** Observable behaviors of the actor in the clip relevant to de-escalation. */
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

/**
 * Transport-layer keepalive sent by the App container.
 *
 * Sent on two occasions:
 *   1. During feedback generation: every `HEARTBEAT_INTERVAL_MS` if no
 *      `feedback_token` has been forwarded in the current window. Confirms
 *      the LLM is still active so the client can display a progress indicator
 *      rather than a frozen spinner.
 *   2. Reserved for future general keepalive use (`status: "ok"`).
 *
 * On the **client side** this message is intercepted by `WebSocketTransport`
 * before it reaches `SessionHandler` or any application callback — it is
 * routed exclusively to `TransportInterface.onHeartbeat`. It therefore does
 * not appear in the application's message stream and callers of `onMessage`
 * will never receive it. It is included in `ServerMessage` solely so that
 * server-side code (App container) can type-safely pass it to `SendFn`.
 *
 * The server-side WebSocket ping/pong mechanism (protocol-level, not JSON)
 * runs alongside this and is handled automatically by the browser — no
 * application code is involved on either side for ping/pong.
 */
export interface HeartbeatMessage {
    type:       "heartbeat";
    session_id: string;
    /**
     * `"feedback_generating"` — Ollama is still producing output.
     * `"ok"`                  — General keepalive (reserved).
     */
    status: "feedback_generating" | "ok";
}

/**
 * Sent immediately after `clip_selected` for **admin sessions only**.
 * Never sent to non-admin sessions.
 *
 * Carries the full evaluation result for the completed clip, together with
 * App-level capture statistics and implementation-specific intermediate data
 * from the Evaluation container's analysis pipeline.
 *
 * `analyser_id` identifies the BehaviourAnalyser implementation. Clients must
 * use this value to interpret `stages`. When `analyser_id` is unrecognised the
 * client should treat `stages` as an opaque object and not attempt to parse it
 * against a known schema.
 *
 * See `docs/api_contract.md` → "Debug messages (admin sessions only)" for the
 * full wire format including known `stages` shapes.
 */
export interface DebugEval {
    type: "debug_eval";
    session_id: string;
    window_id: string;

    /** App-level capture statistics for this clip. */
    capture: {
        /** VideoFrame messages received for this clip. */
        frame_count: number;
        /** AudioChunk messages received for this clip. */
        audio_chunk_count: number;
        /** Word timing entries forwarded to Evaluation. */
        word_timing_count: number;
        /**
         * True if the neutral fallback score was used because Evaluation
         * returned a non-2xx response or was unreachable.
         */
        eval_fallback: boolean;
        /** Round-trip time for POST /evaluate/analyse, in milliseconds. */
        eval_latency_ms: number;
    };

    /** Final accumulated transcript and word timings for the clip. */
    transcript: {
        final_text: string;
        words: WordTiming[];
    };

    /** Full BehaviourResult returned by the Evaluation container. */
    result: BehaviourResult;

    /**
     * Stable identifier for the BehaviourAnalyser implementation.
     * e.g. `"stub"` or `"production"`.
     */
    analyser_id: string;

    /**
     * Implementation-specific intermediate data from the evaluation pipeline.
     * Shape is determined by `analyser_id`. May be null when debug data was
     * unavailable (e.g. eval fallback). May be large — do not assume it is
     * small enough to render inline without truncation.
     */
    stages: unknown;
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
    | HeartbeatMessage
    | DebugEval
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
 * A single entry in a clip's de-escalation or escalation rubric.
 * Pairs a signal name from the controlled vocabulary with a weight indicating
 * how important that signal is on this clip relative to others.
 * See `docs/scenario_schema.md` for the signal vocabulary.
 */
export interface RubricEntry {
    /** Signal name from the controlled vocabulary, e.g. `"calm_voice"`, `"raised_voice"`. */
    signal: string;
    /** Relative importance of this signal on this clip. 0.0 to 1.0. */
    weight: number;
}

/**
 * Constrains the `escalation_score` output range for a specific clip.
 * Applied by the Evaluation container after the weighted scorer runs.
 * Defaults to `{ min: -1.0, max: 1.0 }` when absent from the metadata.
 */
export interface ScoreRange {
    min: number;
    max: number;
}

/**
 * Metadata for a single clip within a scenario.
 *
 * Forwarded in full to the Evaluation container as part of `AnalysisWindow`.
 * A subset of fields (excluding all evaluation-only scoring fields) is
 * forwarded to the Feedback container as part of `ConversationTurn`.
 * `video_url` is constructed by the App and ignored by both AI containers.
 *
 * See `docs/scenario_schema.md` for field propagation details.
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
    /** Verbatim transcript of the actor's dialogue in this clip. */
    transcript: string;
    /**
     * Expected duration of the clip in seconds.
     * Used by the Evaluation container to normalise rate-based signals
     * (silence_ratio, speech_pace, head_nod_frequency).
     * The Evaluation container does not read video files.
     */
    clip_duration_seconds: number;
    /**
     * Observable behaviours of the actor in this clip — the stimulus the student
     * is responding to. Used as context by the scorer and the Feedback LLM.
     * See `docs/scenario_schema.md` for recommended values.
     */
    notable_features: string[];
    /**
     * Controls how the Evaluation container scores this clip.
     * `"rubric"` — graded score from weighted positive and negative signals.
     * `"threshold"` — only checks for clear escalation; absence of positive signals is not penalised.
     */
    scoring_mode: "rubric" | "threshold";
    /** Weighted positive signals for this clip. Used by the Evaluation scorer. */
    de_escalation_rubric: RubricEntry[];
    /** Weighted negative signals for this clip. Used by the Evaluation scorer. */
    escalation_rubric: RubricEntry[];
    /**
     * Signal names that apply a hard score penalty when detected, regardless of
     * positive signals. Used by the Evaluation scorer only.
     * When triggered, the signal name is appended to `SignalSummary.notable_signals`
     * as `"critical_failure:<signal_name>"`.
     */
    critical_failures: string[];
    /**
     * Clamps the escalation_score output for this clip.
     * Applied after the weighted scorer runs. Defaults to `{ min: -1.0, max: 1.0 }`.
     */
    score_range: ScoreRange;
    /**
     * De-escalation competency labels specifically targeted by this clip.
     * Used by the Feedback LLM to anchor turn-level coaching advice.
     * When absent, the Feedback container falls back to scenario-level learning_objectives.
     */
    clip_learning_objectives: string[];
    /**
     * Brief description of what a good student response to this clip looks like.
     * Used by the Feedback LLM only — not used by the Evaluation scorer.
     */
    ideal_response: string | null;
    /**
     * Behaviours or phrases the student should avoid when responding to this clip.
     * Used by the Feedback LLM only — not used by the Evaluation scorer.
     */
    response_warnings: string[];
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
    /**
     * Word-level timings for the student's response, accumulated from all
     * TranscriptMessages received during the clip. Times are session-level
     * (seconds from clip start, reset on each clip reset).
     * Used by the Evaluation container to compute silence_ratio and speech_pace
     * accurately from actual speech boundaries rather than total clip duration.
     * Empty array when using the stub Transcription pool or when no speech was detected.
     */
    words:         WordTiming[];
    clip_metadata: ClipMetadata;
}

// ─── Evaluation — cross-container results ────────────────────────────────────

/**
 * The computed multimodal signals produced by the Evaluation container's
 * signal-extraction pipeline for a single clip.
 *
 * These are the raw extracted values before the scorer maps them to an
 * escalation_score. Forwarded to the Feedback container as part of each
 * ConversationTurn so the LLM has interpretable signal evidence to reference.
 *
 * See `docs/architecture.md` for how each signal is computed.
 */
export interface SignalSummary {
    /** 0.0 (relaxed) to 1.0 (tense). Derived from MFCC energy variance and audio emotion arousal. */
    vocal_tension: number;
    /** Syllables per second of actual speech (speech duration from word timings, not clip duration). */
    speech_pace: number;
    /** Variance of wrist and fingertip landmark displacement across the clip. */
    gesture_activity: number;
    /**
     * Fraction of hand-detected frames with open-hand configuration.
     * Null when hands were detected in fewer than 50% of frames — distinguishes
     * a genuinely closed hand from hands that were off-camera.
     */
    open_gesture_ratio: number | null;
    /** Frequency of vertical head oscillation in Hz, from face landmark Y-coordinates. */
    head_nod_frequency: number;
    /**
     * Fraction of frames where the face is estimated to be forward-facing,
     * based on the horizontal symmetry of left/right face mesh landmarks.
     * 1.0 = fully facing the camera, 0.0 = fully turned away.
     * Note: computed from MediaPipe face mesh (478 landmarks), not body pose.
     * Shoulder landmarks are not available from the client's capture pipeline.
     */
    facing_ratio: number;
    /**
     * Fraction of clip_duration_seconds where no student speech was detected.
     * Computed from word timing boundaries vs. declared clip duration.
     * Requires word timings from the Transcription container; falls back to 0.0
     * when words are unavailable (stub pool or empty transcript).
     */
    silence_ratio: number;
    /** Matched Dutch empathy/validation/open-question phrases from the transcript. Empty array if none matched. */
    lexical_markers: string[];
    /** Broad sentiment classification of the student's transcript. */
    response_tone: "positive" | "neutral" | "negative";
    /**
     * Notable signals detected during scoring.
     * e.g. `"stub_mode"`, `"no_hands_detected"`, `"critical_failure:raised_voice"`.
     */
    notable_signals: string[];
}

/**
 * The result of analysing a clip's complete AnalysisWindow.
 * Produced by the Evaluation container, consumed by the App container
 * (for clip branching) and the Feedback container (for debrief).
 */
export interface BehaviourResult {
    window_id: WindowID;
    session_id: string;
    /**
     * -1.0 = strongly de-escalating, 1.0 = strongly escalating.
     * Produced by the deterministic weighted scorer from the signal summary
     * and the clip's rubric. Clamped to the clip's declared `score_range`.
     */
    escalation_score: number;
    /**
     * Dominant emotion label derived from the audio emotion classifier (Stage A).
     * Values: "calm" | "anxious" | "frustrated" | "neutral" | "distressed".
     * Not derived from facial expression recognition.
     */
    dominant_emotion: string;
    /**
     * 0.0 to 1.0. Reflects the proportion of rubric signals for which a reliable
     * measurement was available. Reduced when, e.g., hands were off-camera or the
     * transcript was empty.
     */
    confidence: number;
    signal_summary: SignalSummary;
}

// ─── Feedback — cross-container types ────────────────────────────────────────

/**
 * The subset of ClipMetadata fields forwarded to the Feedback container.
 * Evaluation-only fields (scoring_mode, de_escalation_rubric, escalation_rubric,
 * critical_failures, score_range, clip_duration_seconds) are stripped by the App
 * container before the FeedbackRequest is assembled — they are machine-scoring
 * inputs with no value to the LLM.
 */
export interface ClipMetadataForFeedback {
    clip_id: string;
    scenario_id: string;
    transcript: string;
    notable_features: string[];
    clip_learning_objectives: string[];
    ideal_response: string | null;
    response_warnings: string[];
}

/**
 * A single turn in the conversation — one clip the student responded to,
 * paired with the behaviour analysis of their response.
 *
 * Accumulated by the App container during a session and compiled into a
 * FeedbackRequest at session end.
 */
export interface ConversationTurn {
    turn_id: number;
    clip: ClipMetadataForFeedback;
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
     * When absent the Feedback container falls back to a generic Dutch
     * de-escalation training description. Populated from the scenario's
     * `coaching_context` metadata field when present.
     */
    coaching_context?: string;
    /**
     * De-escalation competencies this scenario trains.
     * The Feedback LLM uses these to anchor its advice to the educator's
     * intended outcomes. When absent, advice is based on general principles.
     */
    learning_objectives?: string[];
    /**
     * MBO level or professional context the scenario targets.
     * Used by the Feedback LLM to calibrate vocabulary and complexity.
     */
    target_audience?: string;
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