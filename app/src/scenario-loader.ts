import type { BranchCondition, ClipMetadata, RubricEntry, ScoreRange } from "@ar-training/shared";
import type { ScenarioSummary } from "@ar-training/shared";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown by registerScenario when the given scenario_id is already loaded.
 * The route handler maps this to a 409 response.
 */
export class ScenarioExistsError extends Error {
    constructor(scenarioId: string) {
        super(`Scenario "${scenarioId}" already exists. Delete it before uploading a new version.`);
        this.name = "ScenarioExistsError";
    }
}

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
     */
    getCoachingContext(scenarioId: string): string | null;

    /**
     * Returns the learning_objectives array for a scenario, or null if the
     * scenario does not exist or its metadata omits the field.
     */
    getLearningObjectives(scenarioId: string): string[] | null;

    /**
     * Returns the target_audience string for a scenario, or null if the
     * scenario does not exist or its metadata omits the field.
     */
    getTargetAudience(scenarioId: string): string | null;

    /**
     * Returns all ClipMetadata entries for the given scenario, in the order
     * they were defined in metadata.json.
     *
     * Returns an empty array if the scenario does not exist. Intended for
     * debugging and tooling — use getClip() when you already know the clip ID.
     */
    listClips(scenarioId: string): ClipMetadata[];

    /**
     * Registers a new scenario from a parsed metadata object and a map of
     * video file contents (filename → Buffer). Writes files to disk and updates
     * the in-memory index — in-memory state is only updated after all disk
     * writes succeed.
     *
     * Rejects if the scenario_id already exists (overwrite is not permitted
     * while sessions may be active on the existing scenario).
     *
     * Throws ScenarioExistsError if the scenario_id is already loaded.
     * Throws Error (with a descriptive message) if:
     * - The metadata fails validation.
     * - A declared video filename is missing from `videoFiles`.
     * - The disk write fails (full disk, read-only mount, etc.).
     */
    registerScenario(raw: RawScenario, videoFiles: Map<string, Buffer>): Promise<void>;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

// Raw shape of a rubric entry inside metadata.json.
interface RawRubricEntry {
    signal: string;
    weight: number;
}

// Raw shape of a score_range entry inside metadata.json.
interface RawScoreRange {
    min: number;
    max: number;
}

// Raw shape of a clip entry inside metadata.json.
// Validated on load; errors are thrown at startup rather than at request time.
interface RawClip {
    file:                       string;
    transcript:                 string;
    clip_duration_seconds:      number;
    notable_features:           string[];
    scoring_mode:               "rubric" | "threshold";
    de_escalation_rubric:       RawRubricEntry[];
    escalation_rubric:          RawRubricEntry[];
    critical_failures?:         string[];
    score_range?:               RawScoreRange;
    clip_learning_objectives?:  string[];
    ideal_response?:            string;
    response_warnings?:         string[];
    branch_conditions:          BranchCondition[];
}

// Exported so main.ts can type the parsed metadata body from the upload route.
export interface RawScenario {
    scenario_id:          string;
    title:                string;
    description:          string;
    language:             string;
    entry_clip:           string;
    clips:                Record<string, RawClip>;
    coaching_context?:    string;
    learning_objectives?: string[];
    target_audience?:     string;
}

// ─── FileScenarioLoader ───────────────────────────────────────────────────────

/**
 * Loads scenario metadata from the scenarios/ directory at startup.
 * Each subdirectory must contain a metadata.json following the schema
 * documented in docs/scenario_schema.md.
 *
 * Throws at construction time if any metadata.json is missing required fields,
 * so misconfigured scenarios are caught before any session is served.
 *
 * Supports live registration of new scenarios via registerScenario() without
 * restarting the container.
 */
export class FileScenarioLoader implements ScenarioLoader {
    // Stored so registerScenario can write new scenario directories.
    private readonly scenariosDir: string;

    // Keyed by "scenario_id:clip_id"
    private readonly clips:              Map<string, ClipMetadata>   = new Map();
    // Keyed by scenario_id → ordered list of ClipMetadata (insertion order = metadata.json order)
    private readonly clipsByScenario:    Map<string, ClipMetadata[]> = new Map();
    // Keyed by scenario_id
    private readonly entryClips:         Map<string, string>         = new Map();
    // Keyed by scenario_id → coaching_context
    private readonly coachingContexts:   Map<string, string>         = new Map();
    // Keyed by scenario_id → learning_objectives
    private readonly learningObjectives: Map<string, string[]>       = new Map();
    // Keyed by scenario_id → target_audience
    private readonly targetAudiences:    Map<string, string>         = new Map();
    // Ordered list of summaries for scenarios_list responses
    private readonly summaries:          ScenarioSummary[]           = [];
    // Keyed by "scenario_id:clip_id" → browser-relative URL
    private readonly videoUrls:          Map<string, string>         = new Map();

    constructor(scenariosDir: string) {
        this.scenariosDir = scenariosDir;
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

    getLearningObjectives(scenarioId: string): string[] | null {
        return this.learningObjectives.get(scenarioId) ?? null;
    }

    getTargetAudience(scenarioId: string): string | null {
        return this.targetAudiences.get(scenarioId) ?? null;
    }

    listClips(scenarioId: string): ClipMetadata[] {
        return this.clipsByScenario.get(scenarioId) ?? [];
    }

    async registerScenario(raw: RawScenario, videoFiles: Map<string, Buffer>): Promise<void> {
        // 1. Validate metadata structure (reuses existing logic).
        this.validate(raw, "(upload)");

        // 2. Reject if the scenario already exists.
        if (this.entryClips.has(raw.scenario_id)) {
            throw new ScenarioExistsError(raw.scenario_id);
        }

        // 3. Verify that every clip's declared file has a corresponding buffer.
        //    Also check for duplicate file values — two clips with the same
        //    filename would cause a silent overwrite during disk writes.
        const declaredFiles = new Set<string>();
        for (const [clipId, clip] of Object.entries(raw.clips)) {
            if (declaredFiles.has(clip.file)) {
                throw new Error(
                    `(upload): clip "${clipId}" declares file "${clip.file}" which is already declared by another clip. Each clip must have a unique filename.`
                );
            }
            declaredFiles.add(clip.file);

            if (!videoFiles.has(clip.file)) {
                throw new Error(
                    `(upload): clip "${clipId}" declares file "${clip.file}" but no file part with that name was received.`
                );
            }
        }

        // 4. Write all files to disk. In-memory maps are NOT updated until
        //    all writes succeed. If any write fails, attempt cleanup and rethrow.
        const scenarioDir = join(this.scenariosDir, raw.scenario_id);

        try {
            await mkdir(scenarioDir, { recursive: true });
            await writeFile(
                join(scenarioDir, "metadata.json"),
                JSON.stringify(raw, null, 4),
                "utf-8",
            );
            for (const [filename, buffer] of videoFiles) {
                // Only write files that are actually declared by a clip.
                if (declaredFiles.has(filename)) {
                    await writeFile(join(scenarioDir, filename), buffer);
                }
            }
        } catch (err) {
            // Attempt to clean up any partially-written directory.
            try {
                await rm(scenarioDir, { recursive: true, force: true });
            } catch (cleanupErr) {
                // Log cleanup failure but rethrow the original error.
                process.stderr.write(
                    `[WARN] registerScenario: cleanup of partial write at "${scenarioDir}" failed: ${String(cleanupErr)}\n`
                );
            }
            throw err;
        }

        // 5. All disk writes succeeded. Update in-memory maps by re-reading the
        //    metadata.json we just wrote — this reuses all the existing parsing
        //    and normalisation logic in loadScenario().
        this.loadScenario(join(scenarioDir, "metadata.json"));
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
        if (raw.learning_objectives?.length) {
            this.learningObjectives.set(raw.scenario_id, raw.learning_objectives);
        }
        if (raw.target_audience) {
            this.targetAudiences.set(raw.scenario_id, raw.target_audience);
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

            // Defaults for optional fields
            const scoreRange: ScoreRange = clip.score_range
                ? { min: clip.score_range.min, max: clip.score_range.max }
                : { min: -1.0, max: 1.0 };

            const deRubric: RubricEntry[] = (clip.de_escalation_rubric ?? []).map(e => ({
                signal: e.signal,
                weight: e.weight,
            }));

            const escRubric: RubricEntry[] = (clip.escalation_rubric ?? []).map(e => ({
                signal: e.signal,
                weight: e.weight,
            }));

            const meta: ClipMetadata = {
                clip_id:                  clipId,
                scenario_id:              raw.scenario_id,
                video_url:                videoUrl,
                transcript:               clip.transcript,
                clip_duration_seconds:    clip.clip_duration_seconds,
                notable_features:         clip.notable_features,
                scoring_mode:             clip.scoring_mode,
                de_escalation_rubric:     deRubric,
                escalation_rubric:        escRubric,
                critical_failures:        clip.critical_failures ?? [],
                score_range:              scoreRange,
                clip_learning_objectives: clip.clip_learning_objectives ?? [],
                ideal_response:           clip.ideal_response ?? null,
                response_warnings:        clip.response_warnings ?? [],
                branch_conditions:        clip.branch_conditions,
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
        // when used to construct browser-relative video URLs.
        if (/\\|(?:^|\/)\.\.(?:\/|$)/.test(raw.scenario_id)) {
            throw new Error(`${path}: scenario_id "${raw.scenario_id}" contains illegal path characters`);
        }

        if (!(raw.entry_clip in raw.clips)) {
            throw new Error(`${path}: entry_clip "${raw.entry_clip}" not found in clips`);
        }

        for (const [clipId, clip] of Object.entries(raw.clips)) {
            if (!clip.file) {
                throw new Error(`${path}: clip "${clipId}" missing file`);
            }
            if (/\\|(?:^|\/)\.\.(?:\/|$)/.test(clip.file)) {
                throw new Error(`${path}: clip "${clipId}" file "${clip.file}" contains illegal path characters`);
            }
            if (clip.clip_duration_seconds == null || clip.clip_duration_seconds <= 0) {
                throw new Error(`${path}: clip "${clipId}" missing or invalid clip_duration_seconds`);
            }
            if (clip.scoring_mode !== "rubric" && clip.scoring_mode !== "threshold") {
                throw new Error(`${path}: clip "${clipId}" scoring_mode must be "rubric" or "threshold"`);
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