// =============================================================================
// ScenarioBuilder — Admin-only scenario authoring tool
//
// Generates a downloadable zip containing metadata.json and video files.
// No backend involvement — everything happens in the browser.
// =============================================================================

import { useCallback, useRef, useState } from "react";
import JSZip from "jszip";
import type { ClipForm } from "./builder-types.ts";
import { st } from "./builder-types.ts";
import { Section } from "./FieldRow.tsx";
import { FieldRow } from "./FieldRow.tsx";
import { TagInput } from "./TagInput.tsx";
import { ClipCard } from "./ClipCard.tsx";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function newId(): string {
    return `clip-${++_idCounter}`;
}

function makeEmptyClip(): ClipForm {
    return {
        id: newId(), clip_id: "", file: null, transcript: "",
        clip_duration_seconds: "", notable_features: [], scoring_mode: "rubric",
        de_escalation_rubric: [], escalation_rubric: [], critical_failures: [],
        score_range_min: "-1.0", score_range_max: "1.0",
        clip_learning_objectives: [], ideal_response: "", response_warnings: [],
        branch_conditions: [{ min_score: "-1.0", max_score: "1.01", next_clip: "__null__" }],
        collapsed: false,
    };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateForm(scenarioId: string, entryClip: string, clips: ClipForm[]): string[] {
    const errors: string[] = [];

    if (!scenarioId.trim()) {
        errors.push("Scenario ID is required.");
    } else if (!/^[a-z0-9_]+$/.test(scenarioId.trim())) {
        errors.push("Scenario ID may only contain lowercase letters, digits, and underscores.");
    }

    const definedIds = new Set(clips.map(c => c.clip_id.trim()).filter(Boolean));

    if (entryClip.trim() && !definedIds.has(entryClip.trim())) {
        errors.push(`Entry clip '${entryClip.trim()}' does not match any clip ID defined below.`);
    }

    clips.forEach((clip, i) => {
        const n = i + 1;

        if (!clip.clip_id.trim()) {
            errors.push(`Clip #${n}: Clip ID is required.`);
        } else if (/[/\\]|\.\./.test(clip.clip_id)) {
            errors.push(`Clip #${n}: Clip ID '${clip.clip_id}' contains illegal path characters.`);
        }

        const thisId = clip.clip_id.trim();
        if (thisId) {
            clips.forEach((other, j) => {
                if (j > i && other.clip_id.trim() === thisId) {
                    errors.push(`Clips #${n} and #${j + 1} share the same clip ID '${thisId}'.`);
                }
            });
        }

        if (!clip.file) {
            errors.push(`Clip #${n}: A video file is required.`);
        } else if (/[/\\]|\.\./.test(clip.file.name)) {
            errors.push(`Clip #${n}: Filename '${clip.file.name}' contains illegal path characters.`);
        }

        if (clip.branch_conditions.length === 0) {
            errors.push(`Clip #${n}: At least one branch condition is required.`);
        } else {
            const sorted = [...clip.branch_conditions]
                .map(bc => ({ min: parseFloat(bc.min_score), max: parseFloat(bc.max_score) }))
                .filter(bc => !isNaN(bc.min) && !isNaN(bc.max))
                .sort((a, b) => a.min - b.min);

            const covers = sorted.length > 0
                && Math.abs(sorted[0]!.min - (-1.0)) < 0.0001
                && Math.abs(sorted[sorted.length - 1]!.max - 1.01) < 0.0001
                && sorted.every((bc, idx) => idx === 0 || Math.abs(bc.min - sorted[idx - 1]!.max) < 0.0001);

            if (!covers) {
                errors.push(`Clip #${n}: Branch conditions must cover the full range from -1.0 to 1.0 with no gaps.`);
            }

            clip.branch_conditions.forEach(bc => {
                if (bc.next_clip !== "__null__" && !definedIds.has(bc.next_clip)) {
                    errors.push(`Clip #${n}: Branch condition references unknown clip '${bc.next_clip}'.`);
                }
            });
        }

        const min = parseFloat(clip.score_range_min);
        const max = parseFloat(clip.score_range_max);
        if (!isNaN(min) && !isNaN(max) && min >= max) {
            errors.push(`Clip #${n}: Score range min must be less than max.`);
        }
    });

    return errors;
}

// ─── Serialisation ────────────────────────────────────────────────────────────

function serialise(
    scenarioId: string, title: string, description: string, language: string,
    entryClip: string, coachingContext: string, learningObjectives: string[],
    targetAudience: string, clips: ClipForm[],
): object {
    const clipsObj: Record<string, object> = {};
    for (const clip of clips) {
        clipsObj[clip.clip_id.trim()] = {
            file: clip.file?.name ?? "",
            transcript: clip.transcript,
            clip_duration_seconds: parseFloat(clip.clip_duration_seconds) || 0,
            notable_features: clip.notable_features,
            scoring_mode: clip.scoring_mode,
            de_escalation_rubric: clip.de_escalation_rubric
                .filter(r => r.signal)
                .map(r => ({ signal: r.signal, weight: parseFloat(r.weight) || 0 })),
            escalation_rubric: clip.escalation_rubric
                .filter(r => r.signal)
                .map(r => ({ signal: r.signal, weight: parseFloat(r.weight) || 0 })),
            critical_failures: clip.critical_failures,
            score_range: {
                min: parseFloat(clip.score_range_min) || -1.0,
                max: parseFloat(clip.score_range_max) || 1.0,
            },
            clip_learning_objectives: clip.clip_learning_objectives,
            ideal_response: clip.ideal_response || null,
            response_warnings: clip.response_warnings,
            branch_conditions: clip.branch_conditions.map(bc => ({
                min_score: parseFloat(bc.min_score),
                max_score: parseFloat(bc.max_score),
                next_clip: bc.next_clip === "__null__" ? null : bc.next_clip,
            })),
        };
    }

    const out: Record<string, unknown> = {
        scenario_id: scenarioId.trim(), title, description, language,
        entry_clip: entryClip.trim(), clips: clipsObj,
    };
    if (coachingContext.trim())    out.coaching_context    = coachingContext.trim();
    if (learningObjectives.length) out.learning_objectives = learningObjectives;
    if (targetAudience.trim())     out.target_audience     = targetAudience.trim();
    return out;
}

// ─── Root component ───────────────────────────────────────────────────────────

export function ScenarioBuilder() {
    const [storedKey, setStoredKey] = useState<string>(() => localStorage.getItem("admin_key") ?? "");
    const [keyInput,  setKeyInput]  = useState("");

    const handleKeySubmit = () => {
        const k = keyInput.trim();
        if (k) { localStorage.setItem("admin_key", k); setStoredKey(k); setKeyInput(""); }
    };

    const handleClearKey = () => { localStorage.removeItem("admin_key"); setStoredKey(""); };

    if (!storedKey) {
        return (
            <div style={st.root}>
                <div style={st.gate}>
                    <div style={st.gateBox}>
                        <div style={{ fontSize: "14px", marginBottom: "12px", color: "#aaa" }}>AR Training — Scenario Builder</div>
                        <div style={{ fontSize: "12px", marginBottom: "8px", color: "#666" }}>Enter admin key to continue</div>
                        <div style={{ display: "flex", gap: "8px" }}>
                            <input
                                type="password" style={st.input} value={keyInput}
                                placeholder="Admin key" autoFocus
                                onChange={e => setKeyInput(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") handleKeySubmit(); }}
                            />
                            <button style={st.btn} onClick={handleKeySubmit}>Enter</button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return <BuilderForm onClearKey={handleClearKey} />;
}

// ─── BuilderForm ──────────────────────────────────────────────────────────────

export interface BuilderFormProps {
    onClearKey: () => void;
}

export function BuilderForm({ onClearKey }: BuilderFormProps) {
    const [scenarioId,         setScenarioId]         = useState("");
    const [title,              setTitle]              = useState("");
    const [description,        setDescription]        = useState("");
    const [language,           setLanguage]           = useState("nl");
    const [entryClip,          setEntryClip]          = useState("");
    const [coachingContext,    setCoachingContext]    = useState("");
    const [learningObjectives, setLearningObjectives] = useState<string[]>([]);
    const [targetAudience,     setTargetAudience]     = useState("");
    const [clips,              setClips]              = useState<ClipForm[]>([makeEmptyClip()]);
    const [errors,             setErrors]             = useState<string[]>([]);
    const [generating,         setGenerating]         = useState(false);
    const errorBoxRef = useRef<HTMLDivElement | null>(null);

    const updateClip = useCallback((id: string, patch: Partial<ClipForm>) => {
        setClips(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
    }, []);

    const addClip    = () => setClips(prev => [...prev, makeEmptyClip()]);
    const removeClip = (id: string) => setClips(prev => prev.length > 1 ? prev.filter(c => c.id !== id) : prev);
    const moveClip   = (id: string, dir: -1 | 1) => {
        setClips(prev => {
            const idx = prev.findIndex(c => c.id === id);
            if (idx === -1) return prev;
            const next = idx + dir;
            if (next < 0 || next >= prev.length) return prev;
            const arr = [...prev];
            [arr[idx], arr[next]] = [arr[next]!, arr[idx]!];
            return arr;
        });
    };

    const handleSubmit = async () => {
        const errs = validateForm(scenarioId, entryClip, clips);
        if (errs.length > 0) {
            setErrors(errs);
            setTimeout(() => errorBoxRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
            return;
        }
        setErrors([]);
        setGenerating(true);
        try {
            const metadata = serialise(
                scenarioId, title, description, language, entryClip,
                coachingContext, learningObjectives, targetAudience, clips,
            );
            const zip    = new JSZip();
            const folder = zip.folder(scenarioId.trim())!;
            folder.file("metadata.json", JSON.stringify(metadata, null, 4));
            const buffers = await Promise.all(clips.map(c => c.file ? c.file.arrayBuffer() : Promise.resolve(null)));
            clips.forEach((clip, i) => {
                const buf = buffers[i];
                if (buf && clip.file) folder.file(clip.file.name, buf, { binary: true });
            });
            const blob = await zip.generateAsync({ type: "blob" });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement("a");
            a.href = url; a.download = `${scenarioId.trim()}.zip`; a.click();
            URL.revokeObjectURL(url);
        } finally {
            setGenerating(false);
        }
    };

    const clipIds = clips.map(c => c.clip_id.trim()).filter(Boolean);

    return (
        <div style={st.root}>
            <div style={st.statusBar}>
                <span style={st.appTitle}>AR Training — Scenario Builder</span>
                <button style={{ ...st.btn, ...st.btnDanger, fontSize: "11px" }} onClick={onClearKey}>
                    Clear key / lock
                </button>
            </div>

            <div style={st.body}>
                {errors.length > 0 && (
                    <div ref={errorBoxRef} style={st.errorBox}>
                        <div style={{ fontWeight: "bold", marginBottom: "6px" }}>Please fix the following errors:</div>
                        {errors.map((e, i) => <div key={i}>• {e}</div>)}
                    </div>
                )}

                <Section label="Scenario">
                    <FieldRow label="Scenario ID *" docKey="scenario_id">
                        <input style={st.input} value={scenarioId} onChange={e => setScenarioId(e.target.value)} placeholder="e.g. scenario_02" />
                        <span style={st.hint}>lowercase letters, digits, underscores</span>
                    </FieldRow>
                    <FieldRow label="Title" docKey="title">
                        <input style={{ ...st.input, width: "400px" }} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Boze student" />
                    </FieldRow>
                    <FieldRow label="Description" docKey="description">
                        <textarea style={{ ...st.textarea, width: "500px" }} value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description shown to the student before the session." rows={3} />
                    </FieldRow>
                    <FieldRow label="Language" docKey="language">
                        <input style={{ ...st.input, width: "80px" }} value={language} onChange={e => setLanguage(e.target.value)} placeholder="nl" />
                        <span style={st.hint}>ISO 639-1</span>
                    </FieldRow>
                    <FieldRow label="Entry clip *" docKey="entry_clip">
                        <input style={st.input} value={entryClip} onChange={e => setEntryClip(e.target.value)} placeholder="clip_01_intro" />
                        <span style={st.hint}>must match a clip ID defined below</span>
                    </FieldRow>
                    <FieldRow label="Coaching context" docKey="coaching_context">
                        <textarea style={{ ...st.textarea, width: "500px" }} value={coachingContext} onChange={e => setCoachingContext(e.target.value)} placeholder="Optional. One or two sentences describing the professional role and situation the student is practising." rows={3} />
                    </FieldRow>
                    <FieldRow label="Learning objectives" docKey="learning_objectives">
                        <TagInput tags={learningObjectives} onChange={setLearningObjectives} placeholder="Type and press Enter" />
                    </FieldRow>
                    <FieldRow label="Target audience" docKey="target_audience">
                        <input style={{ ...st.input, width: "340px" }} value={targetAudience} onChange={e => setTargetAudience(e.target.value)} placeholder="e.g. MBO niveau 3-4, zorg en welzijn" />
                    </FieldRow>
                </Section>

                <Section label="Clips">
                    {clips.map((clip, idx) => (
                        <ClipCard
                            key={clip.id}
                            clip={clip}
                            index={idx}
                            total={clips.length}
                            allClipIds={clipIds}
                            onChange={patch => updateClip(clip.id, patch)}
                            onRemove={() => removeClip(clip.id)}
                            onMoveUp={() => moveClip(clip.id, -1)}
                            onMoveDown={() => moveClip(clip.id, 1)}
                        />
                    ))}
                    <button style={{ ...st.btn, marginTop: "8px" }} onClick={addClip}>+ Add clip</button>
                </Section>

                <div style={{ display: "flex", gap: "12px", alignItems: "center", marginTop: "8px" }}>
                    <button
                        style={{ ...st.btn, ...st.btnPrimary, fontSize: "13px", padding: "8px 20px" }}
                        onClick={() => void handleSubmit()}
                        disabled={generating}
                    >
                        {generating ? "Generating zip…" : "Generate & download zip"}
                    </button>
                    {generating && <span style={{ color: "#888", fontSize: "12px" }}>Reading video files…</span>}
                </div>
            </div>
        </div>
    );
}