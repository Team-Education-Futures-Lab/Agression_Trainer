import type { ClipForm, RubricEntry, BranchCondition } from "./builder-types.ts";
import { st, NOTABLE_FEATURES_VOCAB, POSITIVE_SIGNALS_VOCAB, NEGATIVE_SIGNALS_VOCAB, ALL_SIGNALS_VOCAB } from "./builder-types.ts";
import { FieldRow } from "./FieldRow.tsx";
import { VideoFilePicker } from "./VideoFilePicker.tsx";
import { TagInput, VocabTagInput } from "./TagInput.tsx";
import { RubricEditor, BranchEditor } from "./RubricEditor.tsx";

export interface ClipCardProps {
    clip:       ClipForm;
    index:      number;
    total:      number;
    allClipIds: string[];
    onChange:   (patch: Partial<ClipForm>) => void;
    onRemove:   () => void;
    onMoveUp:   () => void;
    onMoveDown: () => void;
}

export function ClipCard({ clip, index, total, allClipIds, onChange, onRemove, onMoveUp, onMoveDown }: ClipCardProps) {
    const n       = index + 1;
    const summary = clip.collapsed
        ? `${clip.file?.name ?? "no file"} · ${clip.scoring_mode} · ${clip.branch_conditions.length} branch(es)`
        : null;

    return (
        <div style={st.clipCard}>
            <div style={st.clipHeader}>
                <button
                    style={st.collapseBtn}
                    onClick={() => onChange({ collapsed: !clip.collapsed })}
                    title={clip.collapsed ? "Expand" : "Collapse"}
                >
                    {clip.collapsed ? "▶" : "▼"}
                </button>
                <span style={st.clipTitle}>Clip #{n}{clip.clip_id ? ` — ${clip.clip_id}` : ""}</span>
                {summary && <span style={st.clipSummary}>{summary}</span>}
                <div style={{ marginLeft: "auto", display: "flex", gap: "4px" }}>
                    <button style={st.iconBtn} onClick={onMoveUp}   disabled={index === 0}         title="Move up">↑</button>
                    <button style={st.iconBtn} onClick={onMoveDown} disabled={index === total - 1} title="Move down">↓</button>
                    <button style={{ ...st.iconBtn, color: "#e74c3c" }} onClick={onRemove} disabled={total <= 1} title="Remove clip">✕</button>
                </div>
            </div>

            {!clip.collapsed && (
                <div style={st.clipBody}>
                    <FieldRow label="Clip ID *" docKey="clip_id">
                        <input style={st.input} value={clip.clip_id} onChange={e => onChange({ clip_id: e.target.value })} placeholder="e.g. clip_01_intro" />
                    </FieldRow>
                    <FieldRow label="Video file *" docKey="file">
                        <VideoFilePicker file={clip.file} onChange={(f: File | null) => onChange({ file: f })} />
                    </FieldRow>
                    <FieldRow label="Transcript" docKey="transcript">
                        <textarea style={{ ...st.textarea, width: "500px" }} value={clip.transcript} onChange={e => onChange({ transcript: e.target.value })} placeholder="Verbatim transcript of what is said/shown in the clip." rows={3} />
                    </FieldRow>
                    <FieldRow label="Duration (s) *" docKey="clip_duration_seconds">
                        <input style={{ ...st.input, width: "100px" }} type="number" min="0.1" step="0.1" value={clip.clip_duration_seconds} onChange={e => onChange({ clip_duration_seconds: e.target.value })} placeholder="e.g. 12.0" />
                        <span style={st.hint}>float, must match actual video duration</span>
                    </FieldRow>
                    <FieldRow label="Notable features" docKey="notable_features">
                        <VocabTagInput tags={clip.notable_features} vocab={NOTABLE_FEATURES_VOCAB} onChange={(v: string[]) => onChange({ notable_features: v })} placeholder="Select or type actor behaviour" />
                    </FieldRow>
                    <FieldRow label="Scoring mode" docKey="scoring_mode">
                        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                            <label style={st.radioLabel}>
                                <input type="radio" name={`scoring_mode_${clip.id}`} value="rubric" checked={clip.scoring_mode === "rubric"} onChange={() => onChange({ scoring_mode: "rubric" })} />
                                {" "}rubric
                            </label>
                            <label style={st.radioLabel}>
                                <input type="radio" name={`scoring_mode_${clip.id}`} value="threshold" checked={clip.scoring_mode === "threshold"} onChange={() => onChange({ scoring_mode: "threshold" })} />
                                {" "}threshold
                            </label>
                            {clip.scoring_mode === "threshold" && <span style={st.hint}>Absence of positive signals is not penalised.</span>}
                        </div>
                    </FieldRow>
                    <FieldRow label="De-escalation rubric" docKey="de_escalation_rubric">
                        <RubricEditor entries={clip.de_escalation_rubric} vocab={POSITIVE_SIGNALS_VOCAB} onChange={(v: RubricEntry[]) => onChange({ de_escalation_rubric: v })} />
                    </FieldRow>
                    <FieldRow label="Escalation rubric" docKey="escalation_rubric">
                        <RubricEditor entries={clip.escalation_rubric} vocab={NEGATIVE_SIGNALS_VOCAB} onChange={(v: RubricEntry[]) => onChange({ escalation_rubric: v })} />
                    </FieldRow>
                    <FieldRow label="Critical failures" docKey="critical_failures">
                        <VocabTagInput tags={clip.critical_failures} vocab={ALL_SIGNALS_VOCAB} onChange={(v: string[]) => onChange({ critical_failures: v })} placeholder="Select signal" />
                    </FieldRow>
                    <FieldRow label="Score range" docKey="score_range">
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            <span style={st.hint}>min</span>
                            <input style={{ ...st.input, width: "70px" }} type="number" step="0.1"  min="-1.0" max="1.0"  value={clip.score_range_min} onChange={e => onChange({ score_range_min: e.target.value })} />
                            <span style={st.hint}>max</span>
                            <input style={{ ...st.input, width: "70px" }} type="number" step="0.01" min="-1.0" max="1.01" value={clip.score_range_max} onChange={e => onChange({ score_range_max: e.target.value })} />
                        </div>
                    </FieldRow>
                    <FieldRow label="Clip learning objectives" docKey="clip_learning_objectives">
                        <TagInput tags={clip.clip_learning_objectives} onChange={(v: string[]) => onChange({ clip_learning_objectives: v })} placeholder="Type and press Enter" />
                    </FieldRow>
                    <FieldRow label="Ideal response" docKey="ideal_response">
                        <textarea style={{ ...st.textarea, width: "500px" }} value={clip.ideal_response} onChange={e => onChange({ ideal_response: e.target.value })} placeholder="Optional. Brief description of what a skilled student should do." rows={3} />
                    </FieldRow>
                    <FieldRow label="Response warnings" docKey="response_warnings">
                        <TagInput tags={clip.response_warnings} onChange={(v: string[]) => onChange({ response_warnings: v })} placeholder="Type and press Enter" />
                    </FieldRow>
                    <FieldRow label="Branch conditions *" docKey="branch_conditions">
                        <BranchEditor conditions={clip.branch_conditions} allClipIds={allClipIds} onChange={(v: BranchCondition[]) => onChange({ branch_conditions: v })} />
                    </FieldRow>
                </div>
            )}
        </div>
    );
}