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

    /**
     * Returns the coaching_context string for a scenario, or null if the
     * scenario does not exist or its metadata omits the field.
     *
     * Used by SessionManager.buildFeedbackRequest() to populate
     * FeedbackRequest.coaching_context so the Feedback container can frame
     * its coaching prompt for the specific professional context being practised.
     */
    getCoachingContext(scenarioId: string): string | null;

    /**
     * Returns all ClipMetadata entries for the given scenario, in the order
     * they were defined in metadata.json.
     *
     * Returns an empty array if the scenario does not exist. Intended for
     * debugging and tooling — use getClip() when you already know the clip ID.
     */
    listClips(scenarioId: string): ClipMetadata[];
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
    scenario_id:      string;
    title:            string;
    description:      string;
    language:         string;
    entry_clip:       string;
    clips:            Record<string, RawClip>;
    /**
     * Optional free-text description of the professional role and context
     * the student is practising. Forwarded to the Feedback container as
     * FeedbackRequest.coaching_context so the LLM can tailor its debrief.
     *
     * e.g. "De student oefent het de-escaleren van een boze persoon in de
     * rol van docent in het MBO."
     */
    coaching_context?: string;
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
    private readonly clips:           Map<string, ClipMetadata>  = new Map();
    // Keyed by scenario_id → ordered list of ClipMetadata (insertion order = metadata.json order)
    private readonly clipsByScenario: Map<string, ClipMetadata[]> = new Map();
    // Keyed by scenario_id
    private readonly entryClips:      Map<string, string>        = new Map();
    // Keyed by scenario_id → coaching_context (undefined when not set in metadata)
    private readonly coachingContexts: Map<string, string>       = new Map();
    // Ordered list of summaries for scenarios_list responses
    private readonly summaries:       ScenarioSummary[]          = [];
    // Keyed by "scenario_id:clip_id" → browser-relative URL
    private readonly videoUrls:       Map<string, string>        = new Map();

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

    getCoachingContext(scenarioId: string): string | null {
        return this.coachingContexts.get(scenarioId) ?? null;
    }

    listClips(scenarioId: string): ClipMetadata[] {
        return this.clipsByScenario.get(scenarioId) ?? [];
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

        if (raw.coaching_context) {
            this.coachingContexts.set(raw.scenario_id, raw.coaching_context);
        }

        this.summaries.push({
            scenario_id:   raw.scenario_id,
            title:         raw.title,
            description:   raw.description,
            language:      raw.language,
            entry_clip_id: raw.entry_clip,
        });

        const scenarioClips: ClipMetadata[] = [];

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
            scenarioClips.push(meta);
        }

        this.clipsByScenario.set(raw.scenario_id, scenarioClips);
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

        // Reject scenario_id values that could escape the scenarios directory
        // when used to construct browser-relative video URLs. A scenario_id
        // of "../etc" would produce a URL of "/scenarios/../etc/..." which
        // some proxies may resolve. Disallow any value containing a path
        // separator or traversal sequence.
        if (/[/\\]|\.\./.test(raw.scenario_id)) {
            throw new Error(`${path}: scenario_id "${raw.scenario_id}" contains illegal path characters`);
        }

        if (!(raw.entry_clip in raw.clips)) {
            throw new Error(`${path}: entry_clip "${raw.entry_clip}" not found in clips`);
        }
        for (const [clipId, clip] of Object.entries(raw.clips)) {
            if (!clip.file) {
                throw new Error(`${path}: clip "${clipId}" missing file`);
            }
            // Reject clip filenames that could escape the scenario directory.
            if (/[/\\]|\.\./.test(clip.file)) {
                throw new Error(`${path}: clip "${clipId}" file "${clip.file}" contains illegal path characters`);
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