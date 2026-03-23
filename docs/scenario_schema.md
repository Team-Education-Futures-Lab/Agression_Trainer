# Scenario Metadata Schema

Scenario metadata is stored as a single JSON file per scenario in the `scenarios/` directory. Each file describes all clips in that scenario, their content, and the branching logic that connects them.

The file is loaded once at App container startup by `FileScenarioLoader`. Clip metadata is also forwarded to the Evaluation container as part of each `AnalysisWindow` and to the Feedback container as part of each `ConversationTurn`.

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
    "coaching_context": "string (optional) — one or two sentences describing the professional role and situation the student is practising. Passed verbatim to the Feedback container's LLM prompt so coaching feedback is framed correctly for this scenario. When absent, the Feedback container falls back to a generic de-escalation description.",

    "clips": {
        "<clip_id>": {
            "file": "string — filename relative to the scenario directory",
            "transcript": "string — verbatim transcript of what is said/shown in the clip",
            "notable_features": [
                "string — observable behaviours in the clip relevant to de-escalation",
                "e.g. 'raised_voice', 'aggressive_posture', 'crying', 'crossed_arms', 'direct_eye_contact'"
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

### Notes on `coaching_context`

This field is the primary way scenarios communicate professional context to the Feedback container's LLM. The system prompt is intentionally generic — it describes the tool's purpose without assuming any specific role. `coaching_context` fills that gap, allowing the same Feedback container to serve scenarios across different professions without code changes.

Write it as one or two plain sentences describing what the student is practising and what the goal is:

| Scenario type                   | Example `coaching_context`                                                                                                                                                                                                |
|---------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Teacher / student conflict      | `"De student oefent de rol van MBO-docent die geconfronteerd wordt met een boze student. Het doel is om kalm en constructief te blijven en de situatie te de-escaleren zonder de relatie met de student te beschadigen."` |
| Retail / angry customer         | `"De student oefent de rol van winkelmedewerker die te maken krijgt met een agressieve klant. Het doel is de klant te kalmeren en tot een oplossing te komen zonder de situatie te laten escaleren."`                     |
| Healthcare / distressed patient | `"De student oefent de rol van zorgmedewerker die een verwarde en boze patiënt probeert te kalmeren. Het doel is de patiënt zich gehoord en veilig te laten voelen."`                                                     |

Keep it factual and brief. The LLM uses it to frame its feedback — it is not shown to the student.

### Notes on `branch_conditions`

- Conditions are evaluated in order. The first matching condition wins.
- Together, conditions must cover the full range from `-1.0` to `1.0` with no gaps.
- A `next_clip` of `null` marks a terminal clip — the session ends and feedback is generated.
- The `escalation_score` used for branching is the score from the single `BehaviourResult` returned by the Evaluation container for that clip. The Evaluation container receives the student's complete response — all frames, MFCCs, and full transcript — and produces one result.

### Notes on `notable_features`

These are free-text strings used as context by the classifier and the LLM. Use consistent vocabulary across scenarios so the LLM can reason about them uniformly. Recommended values:

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

    "clips": {
        "clip_01_intro": {
            "file": "clip_01_intro.mp4",
            "transcript": "Dit is niet eerlijk! Ik heb zo hard gewerkt en dan krijg ik toch een onvoldoende. U snapt gewoon niet hoe moeilijk dit voor mij is.",
            "notable_features": ["raised_voice", "aggressive_posture", "direct_eye_contact"],
            "branch_conditions": [
                { "min_score": -1.0, "max_score": 0.2,  "next_clip": "clip_02_calm" },
                { "min_score":  0.2, "max_score": 1.01, "next_clip": "clip_02_escalated" }
            ]
        },

        "clip_02_calm": {
            "file": "clip_02_calm.mp4",
            "transcript": "Oké... misschien heb ik me laten meeslepen. Kunt u me uitleggen wat er precies mis was?",
            "notable_features": ["calm_voice", "open_posture"],
            "branch_conditions": [
                { "min_score": -1.0, "max_score": 0.3,  "next_clip": "clip_03_end_good" },
                { "min_score":  0.3, "max_score": 1.01, "next_clip": "clip_03_end_bad" }
            ]
        },

        "clip_02_escalated": {
            "file": "clip_02_escalated.mp4",
            "transcript": "Ziet u wel! U luistert toch niet. Dit is altijd hetzelfde met u!",
            "notable_features": ["raised_voice", "pointing_gesture", "aggressive_posture"],
            "branch_conditions": [
                { "min_score": -1.0, "max_score": 0.0,  "next_clip": "clip_03_end_bad" },
                { "min_score":  0.0, "max_score": 1.01, "next_clip": "clip_03_end_bad" }
            ]
        },

        "clip_03_end_good": {
            "file": "clip_03_end_good.mp4",
            "transcript": "Dank u wel. Ik begrijp het nu beter. Ik zal er de volgende keer beter op letten.",
            "notable_features": ["calm_voice", "open_posture", "backing_away"],
            "branch_conditions": [
                { "min_score": -1.0, "max_score": 1.01, "next_clip": null }
            ]
        },

        "clip_03_end_bad": {
            "file": "clip_03_end_bad.mp4",
            "transcript": "Laat maar. Ik ga dit melden bij de schoolleiding.",
            "notable_features": ["raised_voice", "aggressive_posture"],
            "branch_conditions": [
                { "min_score": -1.0, "max_score": 1.01, "next_clip": null }
            ]
        }
    }
}
```