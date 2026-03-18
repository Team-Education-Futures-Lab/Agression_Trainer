import type { BranchCondition, ClipMetadata } from "@ar-training/shared";
import type { ScenarioSummary } from "@ar-training/shared";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

    /**
     * Returns summary metadata for all loaded scenarios, suitable for
     * sending in a scenarios_list message.
     */
    listScenarios(): ScenarioSummary[];

    /**
     * Returns the browser-relative video URL for a clip, or null if the
     * scenario or clip does not exist.
     * e.g. /scenarios/scenario_01/clip_01_intro.mp4
     */
    getClipVideoUrl(scenarioId: string, clipId: string): string | null;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

// Raw shape of a clip entry inside metadata.json.
// Validated on load; errors are thrown at startup rather than at request time.
interface RawClip {
    file:              string;
    transcript:        string;
    notable_features:  string[];
    branch_conditions: BranchCondition[];
}

interface RawScenario {
    scenario_id:  string;
    title:        string;
    description:  string;
    language:     string;
    entry_clip:   string;
    clips:        Record<string, RawClip>;
}

// ─── FileScenarioLoader ───────────────────────────────────────────────────────

/**
 * Loads scenario metadata from the scenarios/ directory at startup.
 * Each subdirectory must contain a metadata.json following the schema
 * documented in docs/scenario_schema.md.
 *
 * Throws at construction time if any metadata.json is missing required fields,
 * so misconfigured scenarios are caught before any session is served.
 */
export class FileScenarioLoader implements ScenarioLoader {
    // Keyed by "scenario_id:clip_id"
    private readonly clips:      Map<string, ClipMetadata>  = new Map();
    // Keyed by scenario_id
    private readonly entryClips: Map<string, string>        = new Map();
    // Ordered list of summaries for scenarios_list responses
    private readonly summaries:  ScenarioSummary[]          = [];
    // Keyed by "scenario_id:clip_id" → browser-relative URL
    private readonly videoUrls:  Map<string, string>        = new Map();

    constructor(scenariosDir: string) {
        this.load(scenariosDir);
    }

    getClip(scenarioId: string, clipId: string): ClipMetadata | null {
        return this.clips.get(`${scenarioId}:${clipId}`) ?? null;
    }

    getEntryClip(scenarioId: string): string | null {
        return this.entryClips.get(scenarioId) ?? null;
    }

    listScenarios(): ScenarioSummary[] {
        return this.summaries;
    }

    getClipVideoUrl(scenarioId: string, clipId: string): string | null {
        return this.videoUrls.get(`${scenarioId}:${clipId}`) ?? null;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private load(scenariosDir: string): void {
        let entries: string[];
        try {
            entries = readdirSync(scenariosDir, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => e.name);
        } catch {
            throw new Error(`Cannot read scenarios directory: ${scenariosDir}`);
        }

        if (entries.length === 0) {
            throw new Error(`No scenario directories found in: ${scenariosDir}`);
        }

        for (const dir of entries) {
            const metaPath = join(scenariosDir, dir, "metadata.json");
            this.loadScenario(metaPath);
        }
    }

    private loadScenario(metaPath: string): void {
        let raw: RawScenario;
        try {
            const text = readFileSync(metaPath, "utf-8");
            raw = JSON.parse(text) as RawScenario;
        } catch {
            throw new Error(`Failed to read or parse scenario metadata: ${metaPath}`);
        }

        this.validate(raw, metaPath);

        this.entryClips.set(raw.scenario_id, raw.entry_clip);

        this.summaries.push({
            scenario_id:   raw.scenario_id,
            title:         raw.title,
            description:   raw.description,
            language:      raw.language,
            entry_clip_id: raw.entry_clip,
        });

        for (const [clipId, clip] of Object.entries(raw.clips)) {
            const videoUrl = `/scenarios/${raw.scenario_id}/${clip.file}`;

            const meta: ClipMetadata = {
                clip_id:           clipId,
                scenario_id:       raw.scenario_id,
                video_url:         videoUrl,
                transcript:        clip.transcript,
                notable_features:  clip.notable_features,
                branch_conditions: clip.branch_conditions,
            };

            const key = `${raw.scenario_id}:${clipId}`;
            this.clips.set(key, meta);
            this.videoUrls.set(key, videoUrl);
        }
    }

    private validate(raw: RawScenario, path: string): void {
        if (!raw.scenario_id)   throw new Error(`${path}: missing scenario_id`);
        if (!raw.title)         throw new Error(`${path}: missing title`);
        if (!raw.description)   throw new Error(`${path}: missing description`);
        if (!raw.language)      throw new Error(`${path}: missing language`);
        if (!raw.entry_clip)    throw new Error(`${path}: missing entry_clip`);
        if (!raw.clips || Object.keys(raw.clips).length === 0) {
            throw new Error(`${path}: clips must be a non-empty object`);
        }
        if (!(raw.entry_clip in raw.clips)) {
            throw new Error(`${path}: entry_clip "${raw.entry_clip}" not found in clips`);
        }
        for (const [clipId, clip] of Object.entries(raw.clips)) {
            if (!clip.file) {
                throw new Error(`${path}: clip "${clipId}" missing file`);
            }
            if (!clip.branch_conditions?.length) {
                throw new Error(`${path}: clip "${clipId}" has no branch_conditions`);
            }
            for (const cond of clip.branch_conditions) {
                if (cond.next_clip !== null && !(cond.next_clip in raw.clips)) {
                    throw new Error(
                        `${path}: clip "${clipId}" references unknown next_clip "${cond.next_clip}"`
                    );
                }
            }
        }
    }
}