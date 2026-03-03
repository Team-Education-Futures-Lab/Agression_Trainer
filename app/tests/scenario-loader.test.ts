import { describe, it, expect, beforeAll } from "vitest";
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

const VALID_METADATA = {
    scenario_id: "scenario_01",
    title:       "Frustrated Student",
    language:    "nl",
    entry_clip:  "clip_01_intro",
    clips: {
        clip_01_intro: {
            file:             "clip_01_intro.mp4",
            transcript:       "Dit is niet eerlijk!",
            notable_features: ["raised_voice", "aggressive_posture"],
            branch_conditions: [
                { min_score: -1.0, max_score:  0.2,  next_clip: "clip_02_calm" },
                { min_score:  0.2, max_score:  1.01, next_clip: "clip_02_escalated" },
            ],
        },
        clip_02_calm: {
            file:             "clip_02_calm.mp4",
            transcript:       "Oké, ik begrijp het nu.",
            notable_features: ["calm_voice", "open_posture"],
            branch_conditions: [
                { min_score: -1.0, max_score: 1.01, next_clip: null },
            ],
        },
        clip_02_escalated: {
            file:             "clip_02_escalated.mp4",
            transcript:       "U luistert toch niet!",
            notable_features: ["raised_voice", "pointing_gesture"],
            branch_conditions: [
                { min_score: -1.0, max_score: 1.01, next_clip: null },
            ],
        },
    },
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("FileScenarioLoader", () => {
    let tmpDir: string;

    beforeAll(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "ar-training-test-"));
    });

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
            expect(clip!.notable_features).toContain("raised_voice");
            expect(clip!.branch_conditions).toHaveLength(2);
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
    });
});