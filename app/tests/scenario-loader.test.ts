import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileScenarioLoader } from "../src/scenario-loader.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScenarioDir(base: string, scenarioId: string, metadata: object): string {
    const dir = join(base, scenarioId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "metadata.json"), JSON.stringify(metadata));
    return dir;
}

// Minimal valid rubric entry
const RUBRIC_ENTRY = { signal: "calm_voice", weight: 0.8 };

const VALID_METADATA = {
    scenario_id:  "scenario_01",
    title:        "Frustrated Student",
    description:  "A student confronts the teacher about a failing grade.",
    language:     "nl",
    entry_clip:   "clip_01_intro",
    coaching_context:   "De student oefent de rol van MBO-docent.",
    learning_objectives: ["actief luisteren", "emotieregulatie"],
    target_audience:    "MBO niveau 3-4",
    clips: {
        clip_01_intro: {
            file:                  "clip_01_intro.mp4",
            transcript:            "Dit is niet eerlijk!",
            clip_duration_seconds: 12.0,
            notable_features:      ["raised_voice", "aggressive_posture"],
            scoring_mode:          "rubric",
            de_escalation_rubric:  [{ signal: "calm_voice", weight: 0.9 }, { signal: "empathy_phrase", weight: 1.0 }],
            escalation_rubric:     [{ signal: "raised_voice", weight: 1.0 }],
            critical_failures:     ["raised_voice"],
            score_range:           { min: -0.9, max: 0.9 },
            clip_learning_objectives: ["emotieregulatie"],
            ideal_response:        "Erken de frustratie.",
            response_warnings:     ["ga niet in de verdediging"],
            branch_conditions: [
                { min_score: -1.0, max_score:  0.2,  next_clip: "clip_02_calm" },
                { min_score:  0.2, max_score:  1.01, next_clip: "clip_02_escalated" },
            ],
        },
        clip_02_calm: {
            file:                  "clip_02_calm.mp4",
            transcript:            "Oké, ik begrijp het nu.",
            clip_duration_seconds: 8.0,
            notable_features:      ["calm_voice", "open_posture"],
            scoring_mode:          "rubric",
            de_escalation_rubric:  [RUBRIC_ENTRY],
            escalation_rubric:     [],
            branch_conditions: [
                { min_score: -1.0, max_score: 1.01, next_clip: null },
            ],
        },
        clip_02_escalated: {
            file:                  "clip_02_escalated.mp4",
            transcript:            "U luistert toch niet!",
            clip_duration_seconds: 7.0,
            notable_features:      ["raised_voice", "pointing_gesture"],
            scoring_mode:          "threshold",
            de_escalation_rubric:  [RUBRIC_ENTRY],
            escalation_rubric:     [{ signal: "raised_voice", weight: 1.0 }],
            branch_conditions: [
                { min_score: -1.0, max_score: 1.01, next_clip: null },
            ],
        },
    },
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("FileScenarioLoader", () => {

    // ── Happy path ────────────────────────────────────────────────────────────

    describe("loading valid scenarios", () => {
        it("loads a scenario and returns its entry clip", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            expect(loader.getEntryClip("scenario_01")).toBe("clip_01_intro");
        });

        it("returns correct ClipMetadata for a known clip", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            const clip   = loader.getClip("scenario_01", "clip_01_intro");

            expect(clip).not.toBeNull();
            expect(clip!.clip_id).toBe("clip_01_intro");
            expect(clip!.scenario_id).toBe("scenario_01");
            expect(clip!.video_url).toBe("/scenarios/scenario_01/clip_01_intro.mp4");
            expect(clip!.notable_features).toContain("raised_voice");
            expect(clip!.branch_conditions).toHaveLength(2);
        });

        it("populates new required clip fields correctly", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            const clip   = loader.getClip("scenario_01", "clip_01_intro")!;

            expect(clip.clip_duration_seconds).toBe(12.0);
            expect(clip.scoring_mode).toBe("rubric");
            expect(clip.de_escalation_rubric).toHaveLength(2);
            expect(clip.de_escalation_rubric[0]).toMatchObject({ signal: "calm_voice", weight: 0.9 });
            expect(clip.escalation_rubric).toHaveLength(1);
            expect(clip.escalation_rubric[0]).toMatchObject({ signal: "raised_voice", weight: 1.0 });
            expect(clip.critical_failures).toContain("raised_voice");
            expect(clip.score_range).toMatchObject({ min: -0.9, max: 0.9 });
            expect(clip.clip_learning_objectives).toContain("emotieregulatie");
            expect(clip.ideal_response).toBe("Erken de frustratie.");
            expect(clip.response_warnings).toContain("ga niet in de verdediging");
        });

        it("defaults optional fields when absent", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            const clip   = loader.getClip("scenario_01", "clip_02_calm")!;

            expect(clip.critical_failures).toEqual([]);
            expect(clip.score_range).toMatchObject({ min: -1.0, max: 1.0 });
            expect(clip.clip_learning_objectives).toEqual([]);
            expect(clip.ideal_response).toBeNull();
            expect(clip.response_warnings).toEqual([]);
        });

        it("loads multiple scenarios from subdirectories", () => {
            const dir = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            makeScenarioDir(dir, "scenario_02", { ...VALID_METADATA, scenario_id: "scenario_02" });

            const loader = new FileScenarioLoader(dir);
            expect(loader.getEntryClip("scenario_01")).toBe("clip_01_intro");
            expect(loader.getEntryClip("scenario_02")).toBe("clip_01_intro");
        });

        it("returns null for an unknown scenario", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            expect(loader.getEntryClip("scenario_99")).toBeNull();
        });

        it("returns null for an unknown clip in a known scenario", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            expect(loader.getClip("scenario_01", "clip_99_unknown")).toBeNull();
        });

        it("branch_conditions are preserved correctly", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            const clip   = loader.getClip("scenario_01", "clip_01_intro")!;

            expect(clip.branch_conditions[0]).toMatchObject({ min_score: -1.0, max_score: 0.2,  next_clip: "clip_02_calm" });
            expect(clip.branch_conditions[1]).toMatchObject({ min_score:  0.2, max_score: 1.01, next_clip: "clip_02_escalated" });
        });

        it("terminal clip has next_clip: null", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            const clip   = loader.getClip("scenario_01", "clip_02_calm")!;
            expect(clip.branch_conditions[0].next_clip).toBeNull();
        });

        it("listScenarios returns summary for all loaded scenarios", () => {
            const dir = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            makeScenarioDir(dir, "scenario_02", { ...VALID_METADATA, scenario_id: "scenario_02", title: "Second Scenario" });

            const loader    = new FileScenarioLoader(dir);
            const summaries = loader.listScenarios();

            expect(summaries).toHaveLength(2);
            const s1 = summaries.find(s => s.scenario_id === "scenario_01")!;
            expect(s1.title).toBe("Frustrated Student");
            expect(s1.description).toBe("A student confronts the teacher about a failing grade.");
            expect(s1.language).toBe("nl");
            expect(s1.entry_clip_id).toBe("clip_01_intro");
        });

        it("getClipVideoUrl returns the browser-relative URL for a known clip", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            expect(loader.getClipVideoUrl("scenario_01", "clip_01_intro"))
                .toBe("/scenarios/scenario_01/clip_01_intro.mp4");
        });

        it("getClipVideoUrl returns null for an unknown clip", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            expect(loader.getClipVideoUrl("scenario_01", "clip_99")).toBeNull();
        });

        it("getCoachingContext returns the coaching context string", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            expect(loader.getCoachingContext("scenario_01")).toBe("De student oefent de rol van MBO-docent.");
        });

        it("getLearningObjectives returns the array when present", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            expect(loader.getLearningObjectives("scenario_01")).toEqual(["actief luisteren", "emotieregulatie"]);
        });

        it("getLearningObjectives returns null when absent", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = { ...VALID_METADATA, learning_objectives: undefined };
            makeScenarioDir(dir, "scenario_01", meta);
            const loader = new FileScenarioLoader(dir);
            expect(loader.getLearningObjectives("scenario_01")).toBeNull();
        });

        it("getTargetAudience returns the string when present", () => {
            const dir    = mkdtempSync(join(tmpdir(), "ar-"));
            makeScenarioDir(dir, "scenario_01", VALID_METADATA);
            const loader = new FileScenarioLoader(dir);
            expect(loader.getTargetAudience("scenario_01")).toBe("MBO niveau 3-4");
        });

        it("getTargetAudience returns null when absent", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = { ...VALID_METADATA, target_audience: undefined };
            makeScenarioDir(dir, "scenario_01", meta);
            const loader = new FileScenarioLoader(dir);
            expect(loader.getTargetAudience("scenario_01")).toBeNull();
        });
    });

    // ── Validation errors ─────────────────────────────────────────────────────

    describe("validation", () => {
        it("throws when the scenarios directory does not exist", () => {
            expect(() => new FileScenarioLoader("/nonexistent/path")).toThrow();
        });

        it("throws when the scenarios directory is empty", () => {
            const dir = mkdtempSync(join(tmpdir(), "ar-"));
            expect(() => new FileScenarioLoader(dir)).toThrow();
        });

        it("throws when metadata.json is missing", () => {
            const dir = mkdtempSync(join(tmpdir(), "ar-"));
            mkdirSync(join(dir, "scenario_01"));
            expect(() => new FileScenarioLoader(dir)).toThrow();
        });

        it("throws when metadata.json is malformed JSON", () => {
            const dir = mkdtempSync(join(tmpdir(), "ar-"));
            const s   = join(dir, "scenario_01");
            mkdirSync(s);
            writeFileSync(join(s, "metadata.json"), "{ not valid json");
            expect(() => new FileScenarioLoader(dir)).toThrow();
        });

        it("throws when scenario_id is missing", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = { ...VALID_METADATA, scenario_id: undefined };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/scenario_id/);
        });

        it("throws when title is missing", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = { ...VALID_METADATA, title: undefined };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/title/);
        });

        it("throws when description is missing", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = { ...VALID_METADATA, description: undefined };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/description/);
        });

        it("throws when language is missing", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = { ...VALID_METADATA, language: undefined };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/language/);
        });

        it("throws when entry_clip is missing", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = { ...VALID_METADATA, entry_clip: undefined };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/entry_clip/);
        });

        it("throws when entry_clip references a clip that does not exist", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = { ...VALID_METADATA, entry_clip: "clip_99_missing" };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/entry_clip/);
        });

        it("throws when clip_duration_seconds is missing", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = {
                ...VALID_METADATA,
                clips: {
                    ...VALID_METADATA.clips,
                    clip_01_intro: { ...VALID_METADATA.clips.clip_01_intro, clip_duration_seconds: undefined },
                },
            };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/clip_duration_seconds/);
        });

        it("throws when scoring_mode is missing or invalid", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = {
                ...VALID_METADATA,
                clips: {
                    ...VALID_METADATA.clips,
                    clip_01_intro: { ...VALID_METADATA.clips.clip_01_intro, scoring_mode: "invalid" },
                },
            };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/scoring_mode/);
        });

        it("throws when a clip has no branch_conditions", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = {
                ...VALID_METADATA,
                clips: {
                    ...VALID_METADATA.clips,
                    clip_01_intro: { ...VALID_METADATA.clips.clip_01_intro, branch_conditions: [] },
                },
            };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/branch_conditions/);
        });

        it("throws when a branch_condition references an unknown next_clip", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = {
                ...VALID_METADATA,
                clips: {
                    ...VALID_METADATA.clips,
                    clip_01_intro: {
                        ...VALID_METADATA.clips.clip_01_intro,
                        branch_conditions: [
                            { min_score: -1.0, max_score: 1.01, next_clip: "clip_99_ghost" },
                        ],
                    },
                },
            };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/clip_99_ghost/);
        });

        it("throws when a clip is missing its file field", () => {
            const dir  = mkdtempSync(join(tmpdir(), "ar-"));
            const meta = {
                ...VALID_METADATA,
                clips: {
                    ...VALID_METADATA.clips,
                    clip_01_intro: { ...VALID_METADATA.clips.clip_01_intro, file: undefined },
                },
            };
            makeScenarioDir(dir, "scenario_01", meta);
            expect(() => new FileScenarioLoader(dir)).toThrow(/file/);
        });
    });
});