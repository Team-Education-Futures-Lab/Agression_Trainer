import type { ClipMetadata } from "@ar-training/shared";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ScenarioLoader {
    /**
     * Returns the ClipMetadata for the given clip, or null if the scenario
     * or clip does not exist.
     */
    getClip(scenarioId: string, clipId: string): ClipMetadata | null;

    /**
     * Returns the entry clip ID for a scenario, or null if the scenario
     * does not exist.
     */
    getEntryClip(scenarioId: string): string | null;
}

// ─── Stub ─────────────────────────────────────────────────────────────────────

/**
 * Stub implementation for development.
 * Returns a single hardcoded scenario so the full pipeline can be exercised
 * before real scenario files exist.
 *
 * Replace with FileScenarioLoader once scenarios/ directory is populated.
 */
export class StubScenarioLoader implements ScenarioLoader {
    private readonly clips: Map<string, ClipMetadata> = new Map([
        ["scenario_01:clip_01_intro", {
            clip_id:           "clip_01_intro",
            scenario_id:       "scenario_01",
            transcript:        "Dit is niet eerlijk! Ik heb zo hard gewerkt.",
            notable_features:  ["raised_voice", "aggressive_posture"],
            branch_conditions: [
                { min_score: -1.0, max_score:  0.2,  next_clip: "clip_02_calm" },
                { min_score:  0.2, max_score:  1.01, next_clip: "clip_02_escalated" },
            ],
        }],
        ["scenario_01:clip_02_calm", {
            clip_id:           "clip_02_calm",
            scenario_id:       "scenario_01",
            transcript:        "Oké... misschien heb ik me laten meeslepen.",
            notable_features:  ["calm_voice", "open_posture"],
            branch_conditions: [
                { min_score: -1.0, max_score: 1.01, next_clip: null },
            ],
        }],
        ["scenario_01:clip_02_escalated", {
            clip_id:           "clip_02_escalated",
            scenario_id:       "scenario_01",
            transcript:        "Ziet u wel! U luistert toch niet.",
            notable_features:  ["raised_voice", "pointing_gesture"],
            branch_conditions: [
                { min_score: -1.0, max_score: 1.01, next_clip: null },
            ],
        }],
    ]);

    getClip(scenarioId: string, clipId: string): ClipMetadata | null {
        return this.clips.get(`${scenarioId}:${clipId}`) ?? null;
    }

    getEntryClip(scenarioId: string): string | null {
        if (scenarioId === "scenario_01") return "clip_01_intro";
        return null;
    }
}
