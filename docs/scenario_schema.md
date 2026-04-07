# Scenario Metadata Schema

Scenario metadata is stored as a single JSON file per scenario in the `scenarios/` directory. Each file describes all clips in that scenario, their content, the branching logic that connects them, and the rubric data that drives the Evaluation container's deterministic scorer.

The file is loaded once at App container startup by `FileScenarioLoader`. Clip metadata is forwarded to the Evaluation container as part of each `AnalysisWindow` and to the Feedback container as part of each `ConversationTurn`.

---

## Directory Structure

```
scenarios/
├── scenario_01/
│   ├── metadata.json       ← schema described below
│   ├── clip_01_intro.mp4
│   ├── clip_02_escalated.mp4
│   ├── clip_02_calm.mp4
│   ├── clip_03_end_good.mp4
│   └── clip_03_end_bad.mp4
├── scenario_02/
│   └── ...
```

---

## Schema

```json
{
    "scenario_id": "string — unique identifier, matches directory name",
    "title": "string — human-readable title shown in the UI",
    "description": "string — brief description shown to the student before the session",
    "language": "string — ISO 639-1 code, e.g. 'nl'",
    "entry_clip": "string — clip_id of the first clip to play",

    "coaching_context": "string (optional) — one or two sentences describing the professional role and situation the student is practising. Passed verbatim to the Feedback LLM prompt. When absent, the Feedback container falls back to a generic de-escalation description.",

    "learning_objectives": [
        "string (optional) — de-escalation competency this scenario trains, in the scenario's language",
        "e.g. 'actief luisteren', 'emotieregulatie', 'open vragen stellen'"
    ],

    "target_audience": "string (optional) — the MBO level or professional context this scenario is designed for, e.g. 'MBO niveau 3-4, zorg en welzijn'. Used by the Feedback LLM to calibrate the vocabulary and complexity of its coaching advice.",

    "clips": {
        "<clip_id>": {
            "file": "string — filename relative to the scenario directory",
            "transcript": "string — verbatim transcript of what is said/shown in the clip",
            "clip_duration_seconds": "float — expected duration of the clip in seconds. Used by the Evaluation container to interpret rate-based signals (speech_pace, silence_ratio, head_nod_frequency) correctly. Must be set by the scenario author; the Evaluation container does not read video files.",

            "notable_features": [
                "string — observable behaviours of the ACTOR in this clip relevant to de-escalation",
                "describes the stimulus the student is responding to — NOT the expected student response",
                "e.g. 'raised_voice', 'aggressive_posture', 'crying', 'crossed_arms', 'direct_eye_contact'"
            ],

            "scoring_mode": "string — 'rubric' or 'threshold'. Controls how the Evaluation container scores this clip. See field description below.",

            "de_escalation_rubric": [
                {
                    "signal": "string — signal name from the controlled vocabulary",
                    "weight": "float — importance of this signal on this clip, 0.0 to 1.0"
                }
            ],

            "escalation_rubric": [
                {
                    "signal": "string — signal name from the controlled vocabulary",
                    "weight": "float — importance of this signal on this clip, 0.0 to 1.0"
                }
            ],

            "critical_failures": [
                "string (optional) — signal names that apply a hard score penalty regardless of other positive signals",
                "e.g. 'raised_voice' when the actor is in a fragile emotional state"
            ],

            "score_range": {
                "min": "float (optional) — minimum achievable escalation_score on this clip, default -1.0",
                "max": "float (optional) — maximum achievable escalation_score on this clip, default 1.0"
            },

            "clip_learning_objectives": [
                "string (optional) — competency labels specifically targeted by this clip, overrides or supplements scenario-level learning_objectives in Feedback coaching"
            ],

            "ideal_response": "string (optional) — a brief plain-language description of what a good student response to this clip looks like. Used by the Feedback LLM only. E.g. 'acknowledge the frustration, stay calm, ask an open question without becoming defensive.'",

            "response_warnings": [
                "string (optional) — specific student behaviours or phrases to avoid in response to this clip, used by the Feedback LLM only",
                "e.g. 'ga niet in de verdediging', 'minimaliseer de emotie niet'"
            ],

            "branch_conditions": [
                {
                    "min_score": "float — inclusive lower bound of escalation_score range (-1.0 to 1.0)",
                    "max_score": "float — exclusive upper bound of escalation_score range",
                    "next_clip": "string | null — clip_id to play next, null = end of scenario"
                }
            ]
        }
    }
}
```

---

## Field Descriptions

### Scenario-level fields

#### `coaching_context`

The primary way scenarios communicate professional context to the Feedback LLM. The system prompt is intentionally generic; `coaching_context` fills the role-specific gap, allowing the same Feedback container to serve scenarios across different professions without code changes.

Write it as one or two plain sentences describing what the student is practising and what the goal is. It is not shown to the student.

| Scenario type                   | Example `coaching_context`                                                                                                                                                                                                |
|---------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Teacher / student conflict      | `"De student oefent de rol van MBO-docent die geconfronteerd wordt met een boze student. Het doel is om kalm en constructief te blijven en de situatie te de-escaleren zonder de relatie met de student te beschadigen."` |
| Retail / angry customer         | `"De student oefent de rol van winkelmedewerker die te maken krijgt met een agressieve klant. Het doel is de klant te kalmeren en tot een oplossing te komen zonder de situatie te laten escaleren."`                     |
| Healthcare / distressed patient | `"De student oefent de rol van zorgmedewerker die een verwarde en boze patiënt probeert te kalmeren. Het doel is de patiënt zich gehoord en veilig te laten voelen."`                                                     |

#### `learning_objectives`

An array of de-escalation competencies the scenario trains, written in the scenario's language. The Feedback LLM uses these to anchor its advice to the educator's intended outcomes. Aim for three to five short, concrete skill labels. This field is optional; when absent, advice is based on general de-escalation principles.

#### `target_audience`

A free-text description of the MBO level or professional context the scenario targets. Used by the Feedback LLM to calibrate vocabulary and depth. Optional; travels to Feedback only.

---

### Clip-level fields

#### `clip_duration_seconds`

The expected duration of the clip in seconds. Required. The Evaluation container never reads video files — it receives only landmark frames, MFCCs, and transcript. Without a declared duration it cannot correctly compute `silence_ratio` (which divides non-speech time by total clip time), interpret `speech_pace` in context, or normalise `head_nod_frequency`. Set this to the actual video duration when creating or updating a clip.

#### `notable_features`

Describes observable behaviours of the **actor** in this clip — the stimulus the student is responding to. Used by the Evaluation container as contextual input to the scorer, and by the Feedback LLM when describing what the student faced.

> **Important:** `notable_features` always describes the actor, never the student. The student's expected response signals belong in `de_escalation_rubric` and `escalation_rubric`. Authors who conflate these will produce incorrect scoring.

#### `scoring_mode`

Required. Controls how the Evaluation container interprets the rubric for this clip.

| Value | Behaviour |
|---|---|
| `"rubric"` | The scorer evaluates the student's signals against both `de_escalation_rubric` and `escalation_rubric` and produces a graded score. Use for clips where specific positive behaviours are expected and should be rewarded. |
| `"threshold"` | The scorer only checks whether the student crossed into clear escalation territory. Absence of positive signals is not penalised. Use for clips where the actor is very difficult and any calm, non-escalating response is a reasonable outcome — penalising a student for not smiling during a threatening scene is pedagogically counterproductive. |

#### `de_escalation_rubric` and `escalation_rubric`

The machine-readable scoring rubric for this clip. Each entry pairs a signal name from the controlled vocabulary with a weight (0.0–1.0) indicating how important that signal is relative to others on this clip.

The scorer computes a weighted sum of detected positive signals and detected negative signals and derives the `escalation_score` from their balance. Weights do not need to sum to 1.0; the scorer normalises them.

Both fields are required (they may be empty arrays for terminal clips that have no meaningful rubric). Use consistent signal names from the vocabulary table below so the scorer can map computed signals to rubric entries.

#### `critical_failures`

An optional list of signal names that apply a hard score penalty when detected, regardless of how many positive signals are also present. Use sparingly and only for signals that represent a genuine pedagogical failure on this specific clip — where no amount of empathy phrases can compensate for, for example, shouting at a crying actor.

`critical_failures` affect the Evaluation container's scorer only. They are not shown to the student and are not forwarded to the Feedback LLM; `response_warnings` serves that role.

#### `score_range`

An optional `{ min, max }` pair that clamps the `escalation_score` produced for this clip. Both fields default to `{ min: -1.0, max: 1.0 }` when absent.

Use this when a clip's actor behaviour makes the best possible student response still result in some measurable tension — for example, a clip where the actor escalates regardless of what the student does. Setting `max: 0.2` prevents the scorer from producing a false positive `escalation_score` on a clip where the student genuinely did well given the constraints.

#### `clip_learning_objectives`

Optional. Competency labels specifically targeted by this clip. When present, the Feedback LLM uses these alongside or instead of the scenario-level `learning_objectives` for the coaching advice on this turn. Useful when a scenario covers multiple competencies across different clips and you want the feedback to be more targeted per clip.

#### `ideal_response`

A brief plain-language description of what a skilled student should do or say when responding to this clip. Written by the scenario author. Used by the Feedback LLM only — it is not used by the Evaluation container. Write one to three sentences covering both verbal and non-verbal behaviour.

#### `response_warnings`

A list of student behaviours or phrases that are particularly counterproductive on this clip. Used by the Feedback LLM only — not used by the Evaluation container. The LLM references these when the student's transcript or signal summary indicates a warning was triggered. Enables targeted coaching rather than generic advice.

#### `branch_conditions`

Conditions are evaluated in order; the first match wins. Together they must cover the full range from `-1.0` to `1.0` with no gaps. A `next_clip` of `null` marks a terminal clip. The `escalation_score` used is the one returned by the Evaluation container for this clip, after `score_range` clamping has been applied.

---

## Vocabulary Reference

### `notable_features` — actor behaviour only

| Feature              | Meaning                                    |
|----------------------|--------------------------------------------|
| `raised_voice`       | Character speaks loudly or with sharp tone |
| `calm_voice`         | Character speaks slowly and quietly        |
| `aggressive_posture` | Leaning in, squared shoulders, tense body  |
| `open_posture`       | Relaxed, non-threatening body language     |
| `crossed_arms`       | Defensive or closed-off gesture            |
| `direct_eye_contact` | Character maintains sustained eye contact  |
| `crying`             | Character shows visible emotional distress |
| `pointing_gesture`   | Character points at the student/camera     |
| `backing_away`       | Character physically retreats              |
| `silence`            | Extended pause, no dialogue                |

### Rubric signal vocabulary — student response

Use these names in `de_escalation_rubric`, `escalation_rubric`, and `critical_failures`. The Evaluation container maps these names to computed signals from its pipeline; unrecognised names are ignored with a warning.

**Positive (de-escalation) signals**

| Signal                | Maps to computed signal      | Meaning                                                          |
|-----------------------|------------------------------|------------------------------------------------------------------|
| `calm_voice`          | `vocal_tension` (low)        | Student speaks with low tension and relaxed delivery             |
| `measured_pace`       | `speech_pace` (low-mid)      | Student speaks at a deliberate, unhurried pace                   |
| `active_listening`    | `head_nod_frequency` (high)  | Student nods and shows physical engagement                       |
| `open_posture`        | `facing_ratio` (high)        | Student faces forward, shoulders relaxed and symmetric           |
| `open_gesture`        | `open_gesture_ratio` (high)  | Student's hands are open rather than closed or pointing          |
| `empathy_phrase`      | `lexical_markers`            | Student uses a recognised Dutch empathy acknowledgement          |
| `open_question`       | `lexical_markers`            | Student asks a question that invites the actor to elaborate      |
| `validation`          | `lexical_markers`            | Student explicitly validates the actor's perspective or feeling  |
| `positive_tone`       | `response_tone` (positive)   | Student's overall transcript sentiment is positive               |
| `appropriate_silence` | `silence_ratio` (mid)        | Student pauses before responding, signalling reflection          |

**Negative (escalation) signals**

| Signal                | Maps to computed signal      | Meaning                                                         |
|-----------------------|------------------------------|-----------------------------------------------------------------|
| `raised_voice`        | `vocal_tension` (high)       | Student speaks with high tension or loud delivery               |
| `fast_speech`         | `speech_pace` (high)         | Student speaks at a rushed pace that matches or raises tension  |
| `turning_away`        | `facing_ratio` (low)         | Student faces away or is frequently non-symmetric               |
| `closed_gesture`      | `open_gesture_ratio` (low)   | Student's hands are closed or in a pointing configuration       |
| `negative_tone`       | `response_tone` (negative)   | Student's overall transcript sentiment is negative              |
| `long_silence`        | `silence_ratio` (high)       | Student fails to respond when the actor expects a reaction      |
| `no_empathy`          | `lexical_markers` (absent)   | Student uses no recognised de-escalation language               |

> **Signal mapping note:** The Evaluation container maps rubric signal names to computed signal ranges (e.g. `calm_voice` → `vocal_tension < threshold`). The thresholds are defined in the Evaluation container's configuration, not in the metadata. Scenario authors do not need to set thresholds; they only specify which signals matter and how much they matter on each clip.

---

## Field Propagation

This table states which fields travel to each AI container at runtime. Fields not listed here are consumed by the App container only (e.g. `file`, `branch_conditions`) or are discarded after loading.

| Field                      | `ClipMetadata` → Evaluation | `FeedbackRequest` → Feedback | Notes                                                  |
|----------------------------|:---------------------------:|:----------------------------:|--------------------------------------------------------|
| `clip_id`                  |              ✓              |              ✓               | Via `ClipMetadata` in `ConversationTurn`               |
| `scenario_id`              |              ✓              |              ✓               |                                                        |
| `transcript` (actor)       |              ✓              |              ✓               | Actor's clip dialogue                                  |
| `clip_duration_seconds`    |              ✓              |              —               | Required for signal normalisation; not relevant to LLM |
| `notable_features`         |              ✓              |              ✓               | Actor behaviour; context for scorer and LLM            |
| `scoring_mode`             |              ✓              |              —               | Evaluation only                                        |
| `de_escalation_rubric`     |              ✓              |              —               | Evaluation only                                        |
| `escalation_rubric`        |              ✓              |              —               | Evaluation only                                        |
| `critical_failures`        |              ✓              |              —               | Evaluation only                                        |
| `score_range`              |              ✓              |              —               | Evaluation only                                        |
| `clip_learning_objectives` |              —              |              ✓               | Feedback only                                          |
| `ideal_response`           |              —              |              ✓               | Feedback only                                          |
| `response_warnings`        |              —              |              ✓               | Feedback only                                          |
| `branch_conditions`        |              ✓              |              ✓               | Included in `ClipMetadata`; used by App for branching  |
| `video_url`                |              ✓              |              —               | Constructed by App; ignored by Evaluation              |
| `coaching_context`         |              —              |              ✓               | Scenario-level                                         |
| `learning_objectives`      |              —              |              ✓               | Scenario-level                                         |
| `target_audience`          |              —              |              ✓               | Scenario-level                                         |

**Client exposure:** None of the rubric fields (`de_escalation_rubric`, `escalation_rubric`, `critical_failures`, `score_range`, `scoring_mode`, `ideal_response`, `response_warnings`, `clip_learning_objectives`) are exposed to the browser client in `ClipData` or `ClipCandidates` messages. They are evaluation/feedback-internal data and must not be shown to the student during a session.

---

## Example — `scenarios/scenario_01/metadata.json`

```json
{
    "scenario_id": "scenario_01",
    "title": "Boze student",
    "description": "Een student is boos over een onvoldoende en confronteert de docent. Oefen met het behouden van een kalme, constructieve toon onder druk.",
    "language": "nl",
    "entry_clip": "clip_01_intro",
    "coaching_context": "De student oefent de rol van MBO-docent die geconfronteerd wordt met een boze student. Het doel is om kalm en constructief te blijven en de situatie te de-escaleren zonder de relatie met de student te beschadigen.",
    "learning_objectives": [
        "actief luisteren",
        "emotieregulatie",
        "open vragen stellen",
        "empathie tonen"
    ],
    "target_audience": "MBO niveau 3-4, pedagogisch-didactische context",

    "clips": {
        "clip_01_intro": {
            "file": "clip_01_intro.mp4",
            "transcript": "Dit is niet eerlijk! Ik heb zo hard gewerkt en dan krijg ik toch een onvoldoende. U snapt gewoon niet hoe moeilijk dit voor mij is.",
            "clip_duration_seconds": 12.0,
            "notable_features": ["raised_voice", "aggressive_posture", "direct_eye_contact"],
            "scoring_mode": "rubric",
            "de_escalation_rubric": [
                { "signal": "calm_voice",      "weight": 0.9 },
                { "signal": "empathy_phrase",  "weight": 1.0 },
                { "signal": "open_question",   "weight": 0.8 },
                { "signal": "open_posture",    "weight": 0.5 },
                { "signal": "measured_pace",   "weight": 0.6 }
            ],
            "escalation_rubric": [
                { "signal": "raised_voice",    "weight": 1.0 },
                { "signal": "fast_speech",     "weight": 0.7 },
                { "signal": "negative_tone",   "weight": 0.8 },
                { "signal": "turning_away",    "weight": 0.6 }
            ],
            "critical_failures": ["raised_voice"],
            "score_range": { "min": -0.9, "max": 0.9 },
            "clip_learning_objectives": ["emotieregulatie", "empathie tonen"],
            "ideal_response": "Erken de frustratie zonder in de verdediging te schieten. Spreek rustig op een lage toon. Stel een open vraag zoals 'Kun je me vertellen wat er voor jou niet klopte aan de beoordeling?'",
            "response_warnings": [
                "ga niet in de verdediging over de beoordeling",
                "minimaliseer de emotie niet met zinnen als 'rustig maar'",
                "vermijd sarcasme of een verwijtende toon"
            ],
            "branch_conditions": [
                { "min_score": -1.0, "max_score": 0.2,  "next_clip": "clip_02_calm" },
                { "min_score":  0.2, "max_score": 1.01, "next_clip": "clip_02_escalated" }
            ]
        },

        "clip_02_calm": {
            "file": "clip_02_calm.mp4",
            "transcript": "Oké... misschien heb ik me laten meeslepen. Kunt u me uitleggen wat er precies mis was?",
            "clip_duration_seconds": 8.0,
            "notable_features": ["calm_voice", "open_posture"],
            "scoring_mode": "rubric",
            "de_escalation_rubric": [
                { "signal": "calm_voice",       "weight": 0.7 },
                { "signal": "validation",        "weight": 1.0 },
                { "signal": "open_question",    "weight": 0.9 },
                { "signal": "active_listening", "weight": 0.6 }
            ],
            "escalation_rubric": [
                { "signal": "negative_tone",    "weight": 0.9 },
                { "signal": "fast_speech",      "weight": 0.5 }
            ],
            "critical_failures": [],
            "score_range": { "min": -0.9, "max": 0.8 },
            "clip_learning_objectives": ["actief luisteren", "open vragen stellen"],
            "ideal_response": "Bevestig de de-escalatie en geef een heldere, feitelijke uitleg van de beoordeling. Blijf open en benaderbaar; dit is het moment om de relatie te herstellen.",
            "response_warnings": [
                "ga nu niet alsnog in de verdediging",
                "vermijd een bestraffende toon bij het uitleggen"
            ],
            "branch_conditions": [
                { "min_score": -1.0, "max_score": 0.3,  "next_clip": "clip_03_end_good" },
                { "min_score":  0.3, "max_score": 1.01, "next_clip": "clip_03_end_bad" }
            ]
        },

        "clip_02_escalated": {
            "file": "clip_02_escalated.mp4",
            "transcript": "Ziet u wel! U luistert toch niet. Dit is altijd hetzelfde met u!",
            "clip_duration_seconds": 7.0,
            "notable_features": ["raised_voice", "pointing_gesture", "aggressive_posture"],
            "scoring_mode": "threshold",
            "de_escalation_rubric": [
                { "signal": "calm_voice",    "weight": 1.0 },
                { "signal": "open_posture",  "weight": 0.7 },
                { "signal": "measured_pace", "weight": 0.8 }
            ],
            "escalation_rubric": [
                { "signal": "raised_voice",  "weight": 1.0 },
                { "signal": "fast_speech",   "weight": 0.8 },
                { "signal": "turning_away",  "weight": 0.7 }
            ],
            "critical_failures": ["raised_voice"],
            "score_range": { "min": -0.5, "max": 1.0 },
            "clip_learning_objectives": ["emotieregulatie"],
            "ideal_response": "Blijf kalm ondanks de escalatie. Stel een grens als dat nodig is, maar doe dit vriendelijk en zonder verwijt.",
            "response_warnings": [
                "reageer niet defensief op de persoonlijke aanval",
                "stem de eigen toon niet mee omhoog"
            ],
            "branch_conditions": [
                { "min_score": -1.0, "max_score": 0.0,  "next_clip": "clip_03_end_bad" },
                { "min_score":  0.0, "max_score": 1.01, "next_clip": "clip_03_end_bad" }
            ]
        },

        "clip_03_end_good": {
            "file": "clip_03_end_good.mp4",
            "transcript": "Dank u wel. Ik begrijp het nu beter. Ik zal er de volgende keer beter op letten.",
            "clip_duration_seconds": 6.0,
            "notable_features": ["calm_voice", "open_posture", "backing_away"],
            "scoring_mode": "rubric",
            "de_escalation_rubric": [
                { "signal": "calm_voice",       "weight": 0.8 },
                { "signal": "active_listening", "weight": 0.7 },
                { "signal": "positive_tone",    "weight": 0.6 }
            ],
            "escalation_rubric": [],
            "critical_failures": [],
            "score_range": { "min": -1.0, "max": 0.2 },
            "ideal_response": "Sluit het gesprek positief af. Bevestig de openheid van de student en geef een bemoedigende afsluiting die de relatie intact laat.",
            "response_warnings": [],
            "branch_conditions": [
                { "min_score": -1.0, "max_score": 1.01, "next_clip": null }
            ]
        },

        "clip_03_end_bad": {
            "file": "clip_03_end_bad.mp4",
            "transcript": "Laat maar. Ik ga dit melden bij de schoolleiding.",
            "clip_duration_seconds": 5.0,
            "notable_features": ["raised_voice", "aggressive_posture"],
            "scoring_mode": "threshold",
            "de_escalation_rubric": [
                { "signal": "calm_voice",    "weight": 1.0 },
                { "signal": "open_posture",  "weight": 0.6 },
                { "signal": "measured_pace", "weight": 0.7 }
            ],
            "escalation_rubric": [
                { "signal": "raised_voice",  "weight": 1.0 },
                { "signal": "negative_tone", "weight": 0.8 }
            ],
            "critical_failures": [],
            "score_range": { "min": -0.3, "max": 1.0 },
            "ideal_response": "Ook in een geëscaleerde situatie is het belangrijk kalm te blijven en de deur open te houden voor een later gesprek.",
            "response_warnings": [
                "ga niet mee in de dreiging",
                "sluit het gesprek niet af op een afwijzende manier"
            ],
            "branch_conditions": [
                { "min_score": -1.0, "max_score": 1.01, "next_clip": null }
            ]
        }
    }
}
```