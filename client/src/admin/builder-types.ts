// =============================================================================
// builder-types.ts — Shared types, styles, field docs, and vocabularies
// for the ScenarioBuilder admin tool.
// =============================================================================

import type React from "react";

// ─── Data shapes ─────────────────────────────────────────────────────────────

export interface RubricEntry {
    signal: string;
    weight: string;
}

export interface BranchCondition {
    min_score: string;
    max_score: string;
    next_clip: string;
}

export interface ClipForm {
    id:                       string;
    clip_id:                  string;
    file:                     File | null;
    transcript:               string;
    clip_duration_seconds:    string;
    notable_features:         string[];
    scoring_mode:             "rubric" | "threshold";
    de_escalation_rubric:     RubricEntry[];
    escalation_rubric:        RubricEntry[];
    critical_failures:        string[];
    score_range_min:          string;
    score_range_max:          string;
    clip_learning_objectives: string[];
    ideal_response:           string;
    response_warnings:        string[];
    branch_conditions:        BranchCondition[];
    collapsed:                boolean;
}

// ─── Vocabularies (verbatim from docs/scenario_schema.md) ────────────────────

export const NOTABLE_FEATURES_VOCAB: string[] = [
    "raised_voice", "calm_voice", "aggressive_posture", "open_posture",
    "crossed_arms", "direct_eye_contact", "crying", "pointing_gesture",
    "backing_away", "silence",
];

export const POSITIVE_SIGNALS_VOCAB: string[] = [
    "calm_voice", "measured_pace", "active_listening", "open_posture",
    "open_gesture", "empathy_phrase", "open_question", "validation",
    "positive_tone", "appropriate_silence",
];

export const NEGATIVE_SIGNALS_VOCAB: string[] = [
    "raised_voice", "fast_speech", "turning_away", "closed_gesture",
    "negative_tone", "long_silence", "no_empathy",
];

export const ALL_SIGNALS_VOCAB: string[] = [
    ...POSITIVE_SIGNALS_VOCAB,
    ...NEGATIVE_SIGNALS_VOCAB,
];

// ─── Field documentation ──────────────────────────────────────────────────────

export interface FieldDoc {
    what:    string;
    accepts: string;
}

export const FIELD_DOCS: Record<string, FieldDoc> = {
    scenario_id: {
        what:    "Unique identifier for this scenario. Must match the directory name you will create inside scenarios/. Used throughout the system to reference this scenario.",
        accepts: "Lowercase letters, digits, and underscores only. E.g. scenario_02, angry_customer.",
    },
    title: {
        what:    "Human-readable name shown in the scenario selection UI before the session starts.",
        accepts: "Any string. E.g. 'Boze student'.",
    },
    description: {
        what:    "Brief description shown to the student on the scenario selection screen before the session begins.",
        accepts: "Any string. One or two sentences is ideal.",
    },
    language: {
        what:    "The primary spoken language of this scenario. Passed to the Transcription container so Whisper selects the correct language model.",
        accepts: "ISO 639-1 code. E.g. nl, en, de. Default: nl.",
    },
    entry_clip: {
        what:    "The clip_id of the first clip to play when the session starts. Must exactly match one of the clip IDs you define below.",
        accepts: "Any clip_id defined in the clips section of this scenario.",
    },
    coaching_context: {
        what:    "One or two sentences describing the professional role and situation the student is practising. Passed verbatim to the Feedback LLM so it can frame its coaching advice appropriately. Not shown to the student.",
        accepts: "Optional free text. E.g. 'De student oefent de rol van MBO-docent die geconfronteerd wordt met een boze student.'",
    },
    learning_objectives: {
        what:    "De-escalation competencies this scenario trains. The Feedback LLM anchors its end-of-session advice to these labels. Each tag is one competency, written in the scenario language.",
        accepts: "Optional free-text tags. E.g. actief luisteren, emotieregulatie, open vragen stellen, empathie tonen.",
    },
    target_audience: {
        what:    "The MBO level or professional context this scenario is designed for. The Feedback LLM uses this to calibrate the vocabulary and complexity of its coaching advice.",
        accepts: "Optional free text. E.g. 'MBO niveau 3-4, zorg en welzijn'.",
    },
    clip_id: {
        what:    "Unique identifier for this clip within the scenario. Used in branch conditions to reference this clip as a next_clip destination. Referenced by entry_clip at the scenario level.",
        accepts: "Any string with no spaces or path separators (/ \\ ..). E.g. clip_01_intro, clip_02_calm.",
    },
    file: {
        what:    "The video file for this clip. The filename is written into metadata.json exactly as provided by the browser and the file is included in the generated zip.",
        accepts: "video/mp4 or video/webm. The filename must not contain / \\ or ..",
    },
    transcript: {
        what:    "Verbatim transcript of what the actor says or does in this clip — the stimulus the student is responding to. Used by the Evaluation container as context for the scorer, and by the Feedback LLM when describing what the student faced.",
        accepts: "Any string. Write it exactly as spoken including punctuation.",
    },
    clip_duration_seconds: {
        what:    "The actual playback duration of the video file in seconds. The Evaluation container uses this to normalise rate-based signals (silence_ratio, speech_pace, head_nod_frequency). It does not read the video file — this must be set manually.",
        accepts: "Positive float. Must match the real video duration. E.g. 12.0.",
    },
    notable_features: {
        what:    "Observable behaviours of the ACTOR in this clip — the stimulus the student is responding to. Used as context by the scorer and the Feedback LLM. Do not describe the expected student response here; that belongs in the rubric.",
        accepts: "One or more tags from the vocabulary, or custom values. E.g. raised_voice, aggressive_posture, direct_eye_contact.",
    },
    scoring_mode: {
        what:    "Controls how the Evaluation container scores the student's response. 'rubric' gives a graded score that rewards positive signals and penalises negative ones. 'threshold' only penalises clear escalation — absence of positive signals is not penalised. Use threshold for high-difficulty clips where any calm response is a reasonable outcome.",
        accepts: "rubric or threshold.",
    },
    de_escalation_rubric: {
        what:    "Weighted list of positive student signals for this clip. The scorer rewards the student when these signals are detected. Weights are relative — they do not need to sum to 1.0; the scorer normalises them internally.",
        accepts: "One or more signal names from the positive vocabulary, each with a weight between 0.0 and 1.0. E.g. calm_voice at 0.9, empathy_phrase at 1.0.",
    },
    escalation_rubric: {
        what:    "Weighted list of negative student signals for this clip. The scorer penalises the student when these signals are detected.",
        accepts: "One or more signal names from the negative vocabulary, each with a weight between 0.0 and 1.0. E.g. raised_voice at 1.0, fast_speech at 0.7.",
    },
    critical_failures: {
        what:    "Signal names that apply a hard score penalty when detected, regardless of how many positive signals are also present. Use sparingly — only for signals that represent a genuine pedagogical failure where no amount of empathy can compensate. Not shown to the student; use response_warnings for student-facing guidance.",
        accepts: "Optional. Signal names from the rubric vocabulary. E.g. raised_voice.",
    },
    score_range: {
        what:    "Clamps the escalation_score produced for this clip after the weighted scorer runs. Useful when a clip's difficulty means even the best student response still results in some measured tension — prevents a false-positive high score. Defaults to min -1.0 / max 1.0.",
        accepts: "min and max as floats in [-1.0, 1.0]. min must be less than max.",
    },
    clip_learning_objectives: {
        what:    "Competency labels specifically targeted by this clip. When present, the Feedback LLM uses these for this turn's coaching advice instead of the scenario-level learning_objectives. Useful when a scenario trains different competencies across different clips.",
        accepts: "Optional tags in the scenario language. Leave empty to fall back to scenario-level objectives.",
    },
    ideal_response: {
        what:    "A brief description of what a skilled student should do or say when responding to this clip. Used by the Feedback LLM only — not used by the scorer. Helps the LLM give concrete, clip-specific coaching rather than generic advice.",
        accepts: "Optional free text. One to three sentences covering verbal and non-verbal behaviour. E.g. 'Erken de frustratie zonder in de verdediging te schieten. Stel een open vraag.'",
    },
    response_warnings: {
        what:    "Specific student behaviours or phrases that are particularly counterproductive on this clip. The Feedback LLM references these when the student's transcript or signal summary suggests a warning was triggered. Not used by the scorer.",
        accepts: "Optional tags, one warning per tag. E.g. 'ga niet in de verdediging', 'vermijd sarcasme of een verwijtende toon'.",
    },
    branch_conditions: {
        what:    "Determines which clip plays next based on the escalation_score returned by the Evaluation container. Conditions are evaluated in order — the first match wins. Together they must cover the full range from -1.0 to 1.0 with no gaps. Set next_clip to null to mark a terminal clip.",
        accepts: "One or more conditions. min_score is inclusive, max_score is exclusive. Use 1.01 as the upper bound of the last condition to safely include score 1.0.",
    },
};

// ─── Shared styles ────────────────────────────────────────────────────────────

export const st: Record<string, React.CSSProperties> = {
    root:                { fontFamily: "monospace", background: "#1a1a1a", color: "#e0e0e0", minHeight: "100vh", boxSizing: "border-box" },
    statusBar:           { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px", padding: "8px 16px", background: "#111", borderBottom: "1px solid #333" },
    appTitle:            { fontSize: "12px", fontWeight: "bold", color: "#666", textTransform: "uppercase", letterSpacing: "0.08em" },
    body:                { maxWidth: "900px", margin: "0 auto", padding: "24px", display: "flex", flexDirection: "column", gap: "24px" },
    btn:                 { padding: "5px 10px", fontSize: "12px", cursor: "pointer", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px" },
    btnDanger:           { background: "#4a1a1a", borderColor: "#822", color: "#fca5a5" },
    btnPrimary:          { background: "#1a2a4a", borderColor: "#2a4a8a", color: "#7ab0f0" },
    input:               { padding: "5px 8px", fontSize: "12px", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", width: "220px", boxSizing: "border-box" },
    textarea:            { padding: "6px 8px", fontSize: "12px", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", resize: "vertical", boxSizing: "border-box", fontFamily: "monospace" },
    hint:                { fontSize: "11px", color: "#555" },
    errorBox:            { background: "#2c1010", border: "1px solid #8b2121", borderRadius: "6px", padding: "12px 16px", fontSize: "12px", color: "#fca5a5", lineHeight: "1.8" },
    section:             { display: "flex", flexDirection: "column", gap: "12px" },
    sectionLabel:        { fontSize: "10px", color: "#555", textTransform: "uppercase", letterSpacing: "0.07em", paddingBottom: "4px", borderBottom: "1px solid #2a2a2a" },
    fieldRow:            { display: "flex", gap: "12px", alignItems: "flex-start" },
    fieldLabel:          { fontSize: "11px", color: "#888", width: "160px", paddingTop: "7px", flexShrink: 0 },
    fieldValue:          { flex: 1 },
    radioLabel:          { fontSize: "12px", color: "#e0e0e0", cursor: "pointer" },
    tagWrap:             { display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center", background: "#2c2c2c", border: "1px solid #444", borderRadius: "4px", padding: "4px 6px", minHeight: "32px" },
    tag:                 { display: "inline-flex", alignItems: "center", gap: "4px", background: "#1a3050", border: "1px solid #2a5090", borderRadius: "3px", padding: "2px 6px", fontSize: "11px", color: "#7ab0f0" },
    tagRemove:           { background: "none", border: "none", color: "#7ab0f0", cursor: "pointer", padding: "0 2px", fontSize: "13px", lineHeight: 1 },
    dropdown:            { position: "absolute", zIndex: 100, top: "100%", left: 0, background: "#242424", border: "1px solid #444", borderRadius: "4px", minWidth: "200px", maxHeight: "200px", overflowY: "auto" },
    dropItem:            { padding: "6px 10px", fontSize: "12px", cursor: "pointer", color: "#e0e0e0" },
    clipCard:            { background: "#202020", border: "1px solid #333", borderRadius: "6px", overflow: "hidden" },
    clipHeader:          { display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", background: "#1e1e1e", borderBottom: "1px solid #2a2a2a" },
    clipTitle:           { fontSize: "12px", fontWeight: "bold", color: "#aaa" },
    clipSummary:         { fontSize: "11px", color: "#555" },
    clipBody:            { padding: "16px", display: "flex", flexDirection: "column", gap: "10px" },
    collapseBtn:         { background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: "10px", padding: "0 4px" },
    iconBtn:             { background: "none", border: "1px solid #444", borderRadius: "3px", color: "#888", cursor: "pointer", fontSize: "11px", padding: "2px 6px" },
    gate:                { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" },
    gateBox:             { background: "#222", border: "1px solid #333", borderRadius: "8px", padding: "32px", textAlign: "center" },
    tooltipAnchor:       { display: "inline-flex", alignItems: "center", gap: "4px", cursor: "default" },
    tooltipIcon:         { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "13px", height: "13px", borderRadius: "50%", background: "#333", border: "1px solid #555", color: "#888", fontSize: "9px", flexShrink: 0, cursor: "help", userSelect: "none" },
    tooltipBox:          { position: "fixed", zIndex: 9999, width: "316px", background: "#1e1e1e", border: "1px solid #444", borderRadius: "6px", padding: "12px 14px", boxShadow: "0 4px 20px rgba(0,0,0,0.6)", pointerEvents: "auto" },
    tooltipWhat:         { fontSize: "11px", color: "#ccc", lineHeight: "1.6", marginBottom: "8px" },
    tooltipAcceptsLabel: { fontSize: "9px", color: "#555", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "3px" },
    tooltipAccepts:      { fontSize: "11px", color: "#7ab0f0", lineHeight: "1.5" },
};