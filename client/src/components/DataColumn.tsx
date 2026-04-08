// =============================================================================
// DataColumn
//
// Right column: all collapsible data panels. Re-renders only on discrete
// server messages — never at frame rate.
// =============================================================================

import { useState } from "react";
import type { ClipData, ServerMessage } from "@ar-training/shared";
import type { SessionHistoryEntry, DebugEvalPayload } from "../hooks/useSession.ts";

interface DataColumnProps {
    transcript:         string;
    currentClipData:    ClipData | null;
    clipCandidates:     import("@ar-training/shared").ClipCandidateData[];
    lastClipSelected:   Extract<ServerMessage, { type: "clip_selected" }> | null;
    lastScenariosList:  Extract<ServerMessage, { type: "scenarios_list" }> | null;
    lastSessionComplete: Extract<ServerMessage, { type: "session_complete" }> | null;
    feedbackTokens:     string;
    errors:             string[];
    sessionHistory:     SessionHistoryEntry[];
    isAdmin:            boolean;
    sessionState:       import("@ar-training/shared").SessionState;
    onSelectScenario:   (scenarioId: string, entryClipId: string) => void;
    onPreloadClip:      (scenarioId: string, clipId: string) => void;
}

export function DataColumn({
                               transcript,
                               currentClipData,
                               clipCandidates,
                               lastClipSelected,
                               lastScenariosList,
                               lastSessionComplete,
                               feedbackTokens,
                               errors,
                               sessionHistory,
                               isAdmin,
                               sessionState,
                               onSelectScenario,
                               onPreloadClip,
                           }: DataColumnProps) {
    const [openPanels, setOpenPanels] = useState<Record<string, boolean>>({
        transcript:    true,
        clip_data:     true,
        candidates:    true,
        clip_selected: true,
        scenarios:     true,
        feedback:      true,
        errors:        true,
        history:       true,
        eval_debug:    true,
    });
    const toggle = (key: string) =>
        setOpenPanels(p => ({ ...p, [key]: !p[key] }));

    const [debugTurnIndex, setDebugTurnIndex] = useState<number | null>(null);

    // Auto-select the most recent turn that has debugEval data.
    // We derive this from sessionHistory without an effect to avoid an extra render.
    const latestDebugIdx = (() => {
        for (let i = sessionHistory.length - 1; i >= 0; i--) {
            if (sessionHistory[i]!.debugEval !== undefined) return i;
        }
        return null;
    })();

    // Advance auto-select when a new debug turn arrives.
    const effectiveDebugIndex =
        debugTurnIndex !== null && debugTurnIndex < sessionHistory.length
            ? debugTurnIndex
            : latestDebugIdx;

    return (
        <div style={st.col}>
            <CollapsiblePanel label="Live transcript" panelKey="transcript" open={openPanels["transcript"] ?? true} onToggle={toggle}>
                <span style={st.transcriptText}>
                    {transcript || <em style={{ opacity: 0.4 }}>waiting…</em>}
                </span>
            </CollapsiblePanel>

            <CollapsiblePanel label="current clip_data" panelKey="clip_data" open={openPanels["clip_data"] ?? true} onToggle={toggle}>
                {currentClipData
                    ? <ClipDataView clip={currentClipData} />
                    : <em style={st.empty}>none yet</em>}
            </CollapsiblePanel>

            <CollapsiblePanel label={`clip_candidates (${clipCandidates.length})`} panelKey="candidates" open={openPanels["candidates"] ?? true} onToggle={toggle}>
                {clipCandidates.length > 0
                    ? clipCandidates.map(c => (
                        <div key={c.clip_id} style={st.candidateRow}>
                            <span style={st.mono}>{c.clip_id}</span>
                            <span style={st.dimText} title={c.video_url}>{c.video_url}</span>
                            <button
                                style={{ ...st.btn, ...st.btnSmall }}
                                onClick={() => {
                                    if (currentClipData)
                                        onPreloadClip(currentClipData.scenario_id, c.clip_id);
                                }}
                            >
                                Preload
                            </button>
                        </div>
                    ))
                    : <em style={st.empty}>none yet</em>}
            </CollapsiblePanel>

            <CollapsiblePanel label="clip_selected" panelKey="clip_selected" open={openPanels["clip_selected"] ?? true} onToggle={toggle}>
                {lastClipSelected
                    ? <ClipSelectedView msg={lastClipSelected} />
                    : <em style={st.empty}>none yet</em>}
            </CollapsiblePanel>

            <CollapsiblePanel label={`scenarios_list (${lastScenariosList?.scenarios.length ?? 0})`} panelKey="scenarios" open={openPanels["scenarios"] ?? true} onToggle={toggle}>
                {lastScenariosList
                    ? lastScenariosList.scenarios.map(sc => (
                        <div key={sc.scenario_id} style={st.candidateRow}>
                            <span style={st.mono}>{sc.scenario_id}</span>
                            <span style={st.dimText}>{sc.title}</span>
                            <button
                                style={{ ...st.btn, ...st.btnSmall }}
                                disabled={sessionState !== "selecting"}
                                onClick={() => onSelectScenario(sc.scenario_id, sc.entry_clip_id)}
                            >
                                Select
                            </button>
                        </div>
                    ))
                    : <em style={st.empty}>none yet</em>}
            </CollapsiblePanel>

            <CollapsiblePanel
                label={lastSessionComplete ? "session_complete" : "feedback stream"}
                panelKey="feedback"
                open={openPanels["feedback"] ?? true}
                onToggle={toggle}
            >
                {lastSessionComplete
                    ? <SessionCompleteView msg={lastSessionComplete} />
                    : feedbackTokens
                        ? <span style={st.transcriptText}>{feedbackTokens}</span>
                        : <em style={st.empty}>none yet</em>}
            </CollapsiblePanel>

            <CollapsiblePanel
                label={`Error log (${errors.length})`}
                panelKey="errors"
                open={openPanels["errors"] ?? true}
                onToggle={toggle}
                danger={errors.length > 0}
            >
                {errors.length > 0
                    ? errors.map((e, i) => <div key={i} style={st.errorEntry}>{e}</div>)
                    : <em style={st.empty}>no errors</em>}
            </CollapsiblePanel>

            <CollapsiblePanel label={`Session history (${sessionHistory.length})`} panelKey="history" open={openPanels["history"] ?? true} onToggle={toggle}>
                {sessionHistory.length > 0
                    ? sessionHistory.map(e => <HistoryEntryView key={e.turn} entry={e} />)
                    : <em style={st.empty}>no turns yet</em>}
            </CollapsiblePanel>

            <CollapsiblePanel label={`Eval debug${isAdmin ? "" : " (admin only)"}`} panelKey="eval_debug" open={openPanels["eval_debug"] ?? true} onToggle={toggle}>
                <EvalDebugPanel
                    history={sessionHistory}
                    selectedIndex={effectiveDebugIndex}
                    onSelectIndex={setDebugTurnIndex}
                />
            </CollapsiblePanel>
        </div>
    );
}

// ─── CollapsiblePanel ─────────────────────────────────────────────────────────

interface CollapsiblePanelProps {
    label:    string;
    panelKey: string;
    open:     boolean;
    onToggle: (key: string) => void;
    danger?:  boolean;
    children: React.ReactNode;
}

function CollapsiblePanel({ label, panelKey, open, onToggle, danger, children }: CollapsiblePanelProps) {
    return (
        <div style={{ ...cp.panel, ...(danger ? cp.danger : {}) }}>
            <button style={cp.header} onClick={() => onToggle(panelKey)}>
                <span style={cp.label}>{label}</span>
                <span style={cp.chevron}>{open ? "▾" : "▸"}</span>
            </button>
            {open && <div style={cp.body}>{children}</div>}
        </div>
    );
}

// ─── EvalDebugPanel ───────────────────────────────────────────────────────────

function EvalDebugPanel({
                            history,
                            selectedIndex,
                            onSelectIndex,
                        }: {
    history:       SessionHistoryEntry[];
    selectedIndex: number | null;
    onSelectIndex: (i: number) => void;
}) {
    const turnsWithDebug = history.filter(e => e.debugEval !== undefined);

    if (turnsWithDebug.length === 0) {
        return <em style={st.empty}>no debug data — connect with an admin key to receive eval debug messages</em>;
    }

    const selected = selectedIndex !== null ? history[selectedIndex] : null;
    const payload  = selected?.debugEval ?? null;

    return (
        <div>
            <div style={ed.turnRow}>
                {history.map((e, i) =>
                    e.debugEval !== undefined
                        ? <button
                            key={e.turn}
                            style={{ ...ed.turnBtn, ...(i === selectedIndex ? ed.turnBtnActive : {}) }}
                            onClick={() => onSelectIndex(i)}
                        >
                            #{e.turn}
                        </button>
                        : null
                )}
            </div>
            {payload === null
                ? <em style={st.empty}>select a turn above</em>
                : <EvalDebugPayloadView payload={payload} />
            }
        </div>
    );
}

function EvalDebugPayloadView({ payload }: { payload: DebugEvalPayload }) {
    const { result, analyser_id, stages, app_meta, transcript } = payload;
    const { signal_summary: ss } = result;

    const score = result.escalation_score;
    const pct   = ((score + 1) / 2) * 100;
    const scoreColor = score < -0.2 ? "#27ae60" : score > 0.2 ? "#e74c3c" : "#e6a817";

    return (
        <div style={ed.payloadRoot}>
            {/* Scores & classification */}
            <div style={ed.section}>
                <div style={ed.sectionTitle}>Scores &amp; classification</div>
                <div style={ed.kvGrid}>
                    <span style={ed.kvKey}>escalation_score</span>
                    <span>
                        <span style={{ ...ed.kvVal, color: scoreColor, fontWeight: "bold" }}>
                            {score.toFixed(4)}
                        </span>
                        <div style={{ ...cs.barTrack, marginTop: "4px", width: "140px" }}>
                            <div style={cs.barMid} />
                            <div style={{ ...cs.barFill, width: `${pct}%`, background: scoreColor }} />
                        </div>
                    </span>
                    <span style={ed.kvKey}>dominant_emotion</span>
                    <span style={ed.kvVal}>{result.dominant_emotion}</span>
                    <span style={ed.kvKey}>confidence</span>
                    <span style={ed.kvVal}>{(result.confidence * 100).toFixed(1)}%</span>
                    <span style={ed.kvKey}>analyser_id</span>
                    <span style={{ ...ed.kvVal, ...ed.monoTag }}>{analyser_id}</span>
                </div>
            </div>

            {/* Signal summary */}
            <div style={ed.section}>
                <div style={ed.sectionTitle}>Signal summary</div>
                <table style={ed.table}>
                    <tbody>
                    <SignalRow k="vocal_tension"      v={ss.vocal_tension.toFixed(3)} />
                    <SignalRow k="speech_pace"        v={`${ss.speech_pace.toFixed(2)} syl/s`} />
                    <SignalRow k="gesture_activity"   v={ss.gesture_activity.toFixed(3)} />
                    <SignalRow k="open_gesture_ratio" v={ss.open_gesture_ratio !== null ? ss.open_gesture_ratio.toFixed(3) : "null"} />
                    <SignalRow k="head_nod_frequency" v={`${ss.head_nod_frequency.toFixed(3)} Hz`} />
                    <SignalRow k="facing_ratio"       v={ss.facing_ratio.toFixed(3)} />
                    <SignalRow k="silence_ratio"      v={ss.silence_ratio.toFixed(3)} />
                    <SignalRow k="response_tone"      v={ss.response_tone} />
                    <tr>
                        <td style={ed.tdKey}>lexical_markers</td>
                        <td style={ed.tdVal}>
                            {ss.lexical_markers.length > 0
                                ? <div style={ed.pillRow}>
                                    {ss.lexical_markers.map((m, i) => <span key={i} style={ed.pill}>{m}</span>)}
                                </div>
                                : <span style={{ color: "#555" }}>(none)</span>}
                        </td>
                    </tr>
                    <tr>
                        <td style={ed.tdKey}>notable_signals</td>
                        <td style={ed.tdVal}>
                            {ss.notable_signals.length > 0
                                ? <div style={ed.pillRow}>
                                    {ss.notable_signals.map((s, i) => {
                                        const isCrit = s.startsWith("critical_failure:");
                                        return <span key={i} style={{ ...ed.pill, ...(isCrit ? ed.pillWarn : {}) }}>{s}</span>;
                                    })}
                                </div>
                                : <span style={{ color: "#555" }}>(none)</span>}
                        </td>
                    </tr>
                    </tbody>
                </table>
            </div>

            {/* App metadata */}
            <div style={ed.section}>
                <div style={ed.sectionTitle}>App metadata</div>
                <div style={ed.metaRow}>
                    <MetaCell label="frames"  value={String(app_meta.frame_count)} />
                    <MetaCell label="chunks"  value={String(app_meta.chunk_count)} />
                    <MetaCell label="words"   value={String(app_meta.word_count)} />
                    <MetaCell label="latency" value={`${app_meta.eval_latency_ms} ms`} />
                    {app_meta.eval_fallback && <span style={ed.fallbackBadge}>FALLBACK</span>}
                </div>
                {transcript.final_text && (
                    <div style={ed.transcriptBlock}>
                        <span style={ed.transcriptLabel}>final transcript</span>
                        <span style={ed.transcriptText2}>{transcript.final_text}</span>
                    </div>
                )}
            </div>

            {/* Stage intermediates */}
            {stages !== null && (
                <div style={ed.section}>
                    <div style={ed.sectionTitle}>Stage intermediates</div>
                    <StageIntermediates analyser_id={analyser_id} stages={stages} />
                </div>
            )}
        </div>
    );
}

// ─── Stage intermediates ──────────────────────────────────────────────────────

interface ProductionStages {
    stage_a: Record<string, unknown>;
    stage_b: Record<string, unknown>;
    stage_c: Record<string, unknown>;
    scorer:  Record<string, unknown>;
}

function StageIntermediates({ analyser_id, stages }: { analyser_id: string; stages: Record<string, unknown> }) {
    if (analyser_id === "stub") {
        return <span style={{ ...ed.kvVal, color: "#555", fontStyle: "italic" }}>stub mode — no stage data</span>;
    }
    if (analyser_id === "production") {
        const s = stages as unknown as ProductionStages;
        const labels: Record<string, string> = {
            stage_a: "Stage A — Audio Emotion",
            stage_b: "Stage B — Landmark Features",
            stage_c: "Stage C — Transcript Features",
            scorer:  "Scorer",
        };
        return (
            <div>
                {(["stage_a", "stage_b", "stage_c", "scorer"] as const).map(k => {
                    const data = s[k] as Record<string, unknown> | undefined;
                    if (!data) return null;
                    return (
                        <div key={k} style={ed.stageBlock}>
                            <div style={ed.stageLabel}>{labels[k]}</div>
                            <div style={ed.kvGrid}>
                                {Object.entries(data).map(([field, val]) => (
                                    <>
                                        <span key={`${field}-k`} style={ed.kvKey}>{field}</span>
                                        <span key={`${field}-v`} style={{ ...ed.kvVal, color: "#8a9ab8" }}>
                                            {typeof val === "number"
                                                ? (Number.isInteger(val) ? String(val) : val.toFixed(4))
                                                : String(val)}
                                        </span>
                                    </>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    }
    return <pre style={ed.rawJson}>{JSON.stringify(stages, null, 2)}</pre>;
}

// ─── Message views ────────────────────────────────────────────────────────────

function ClipDataView({ clip }: { clip: ClipData }) {
    return (
        <div style={cv.root}>
            <div style={cv.idRow}>
                <span style={cv.clipId}>{clip.clip_id}</span>
                <span style={cv.scenarioId}>{clip.scenario_id}</span>
                {clip.video_url && (
                    <a href={clip.video_url} target="_blank" rel="noreferrer" style={cv.videoLink}>
                        {clip.video_url}
                    </a>
                )}
            </div>
            {clip.transcript && <p style={cv.transcript}>"{clip.transcript}"</p>}
            {clip.notable_features.length > 0 && (
                <div style={cv.tagRow}>
                    {clip.notable_features.map(f => <span key={f} style={cv.tag}>{f}</span>)}
                </div>
            )}
            <table style={cv.table}>
                <thead>
                <tr>
                    <th style={cv.th}>min</th>
                    <th style={cv.th}>max</th>
                    <th style={cv.th}>next_clip</th>
                </tr>
                </thead>
                <tbody>
                {clip.branch_conditions.map((bc, i) => (
                    <tr key={i}>
                        <td style={cv.td}>{bc.min_score.toFixed(2)}</td>
                        <td style={cv.td}>{bc.max_score.toFixed(2)}</td>
                        <td style={{ ...cv.td, ...(bc.next_clip === null ? cv.tdNull : {}) }}>
                            {bc.next_clip ?? "null (terminal)"}
                        </td>
                    </tr>
                ))}
                </tbody>
            </table>
        </div>
    );
}

function ClipSelectedView({ msg }: { msg: Extract<ServerMessage, { type: "clip_selected" }> }) {
    const score = msg.clip_score;
    const pct   = ((score + 1) / 2) * 100;
    const color = score < -0.2 ? "#27ae60" : score > 0.2 ? "#e74c3c" : "#e6a817";
    return (
        <div style={cs.root}>
            <div style={cs.row}>
                <span style={cs.label}>next clip</span>
                <span style={cs.value}>
                    {msg.clip_id
                        ? <span style={cs.clipId}>{msg.clip_id}</span>
                        : <span style={cs.terminal}>terminal</span>}
                </span>
            </div>
            <div style={cs.row}>
                <span style={cs.label}>escalation score</span>
                <span style={{ ...cs.scoreNum, color }}>{score.toFixed(4)}</span>
            </div>
            <div style={cs.barWrap}>
                <div style={cs.barTrack}>
                    <div style={cs.barMid} />
                    <div style={{ ...cs.barFill, width: `${pct}%`, background: color }} />
                </div>
                <div style={cs.barLabels}>
                    <span>−1.0</span><span>0</span><span>+1.0</span>
                </div>
            </div>
        </div>
    );
}

function SessionCompleteView({ msg }: { msg: Extract<ServerMessage, { type: "session_complete" }> }) {
    const sevColor: Record<string, string> = {
        low: "#27ae60", medium: "#e6a817", high: "#e74c3c",
    };
    return (
        <div style={sc.root}>
            <div style={sc.header}>
                <span style={{ ...sc.badge, color: sevColor[msg.severity] ?? "#aaa" }}>
                    {msg.severity.toUpperCase()}
                </span>
            </div>
            <p style={sc.advice}>{msg.advice}</p>
            {msg.highlights.length > 0 && (
                <ul style={sc.list}>
                    {msg.highlights.map((h, i) => <li key={i} style={sc.item}>{h}</li>)}
                </ul>
            )}
        </div>
    );
}

function HistoryEntryView({ entry }: { entry: SessionHistoryEntry }) {
    const score = entry.score;
    const pct   = ((score + 1) / 2) * 100;
    const color = score < -0.2 ? "#27ae60" : score > 0.2 ? "#e74c3c" : "#e6a817";
    const txDisplay = entry.transcript.length > 120
        ? entry.transcript.slice(0, 120) + "…"
        : entry.transcript || "(no transcript)";
    return (
        <div style={he.row}>
            <div style={he.mainRow}>
                <span style={he.turn}>#{entry.turn}</span>
                <span style={he.endedClip}>{entry.endedClipId}</span>
                <span style={{ ...he.score, color }}>{score.toFixed(3)}</span>
                <div style={he.miniBarTrack}>
                    <div style={he.miniBarMid} />
                    <div style={{ ...he.miniBarFill, width: `${pct}%`, background: color }} />
                </div>
                <span style={he.arrow}>→</span>
                {entry.nextClipId
                    ? <span style={he.nextClip}>{entry.nextClipId}</span>
                    : <span style={he.terminal}>— terminal —</span>}
                {entry.debugEval !== undefined && (
                    <span style={he.debugTag}>debug</span>
                )}
            </div>
            <div style={he.txRow}>
                <span style={he.txText} title={entry.transcript}>{txDisplay}</span>
            </div>
        </div>
    );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function SignalRow({ k, v }: { k: string; v: string }) {
    return (
        <tr>
            <td style={ed.tdKey}>{k}</td>
            <td style={ed.tdVal}>{v}</td>
        </tr>
    );
}

function MetaCell({ label, value }: { label: string; value: string }) {
    return (
        <span style={ed.metaCell}>
            <span style={ed.metaLabel}>{label}</span>
            <span style={ed.metaValue}>{value}</span>
        </span>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const st = {
    col:            { padding: "16px", overflowY: "auto" as const },
    transcriptText: { fontSize: "12px", whiteSpace: "pre-wrap" as const, lineHeight: 1.5 },
    candidateRow:   { display: "flex", alignItems: "center", gap: "10px", padding: "4px 0", borderBottom: "1px solid #2a2a2a" },
    mono:           { fontSize: "11px", color: "#888", minWidth: "120px", flexShrink: 0, fontFamily: "monospace" },
    dimText:        { fontSize: "11px", color: "#555" },
    btn:            { padding: "5px 10px", fontSize: "12px", cursor: "pointer", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px" },
    btnSmall:       { padding: "3px 8px", fontSize: "11px" },
    errorEntry:     { fontSize: "11px", color: "#f88", marginBottom: "2px", whiteSpace: "pre-wrap" as const },
    empty:          { fontSize: "12px", color: "#444", fontStyle: "italic" as const },
} as const;

const cp = {
    panel:   { background: "#252525", border: "1px solid #333", borderRadius: "4px", marginBottom: "8px" },
    danger:  { background: "#2a1a1a", borderColor: "#822" },
    header:  { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "none", border: "none", cursor: "pointer", color: "inherit" },
    label:   { fontSize: "11px", color: "#666", textTransform: "uppercase" as const, letterSpacing: "0.06em" },
    chevron: { fontSize: "11px", color: "#555" },
    body:    { padding: "6px 10px 10px" },
} as const;

const cv = {
    root:       { padding: "4px 0" },
    idRow:      { display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "6px", flexWrap: "wrap" as const },
    clipId:     { fontSize: "13px", fontWeight: "bold" as const, color: "#e0e0e0" },
    scenarioId: { fontSize: "11px", color: "#666" },
    videoLink:  { fontSize: "11px", color: "#5b8dee", textDecoration: "none", overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const, maxWidth: "260px" },
    transcript: { margin: "0 0 6px", fontSize: "12px", color: "#94a3b8", lineHeight: 1.5, fontStyle: "italic" },
    tagRow:     { display: "flex", flexWrap: "wrap" as const, gap: "4px", marginBottom: "8px" },
    tag:        { padding: "1px 7px", borderRadius: "999px", fontSize: "11px", background: "#2c3040", color: "#7a90b0", border: "1px solid #3a4a60" },
    table:      { width: "100%", borderCollapse: "collapse" as const, fontSize: "11px" },
    th:         { textAlign: "left" as const, color: "#555", padding: "2px 6px", fontWeight: "normal" as const, borderBottom: "1px solid #2a2a2a" },
    td:         { padding: "2px 6px", color: "#b0c4de", borderBottom: "1px solid #222" },
    tdNull:     { color: "#8e44ad", fontStyle: "italic" as const },
} as const;

const cs = {
    root:      { padding: "4px 0" },
    row:       { display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" },
    label:     { fontSize: "11px", color: "#666", minWidth: "100px" },
    value:     { fontSize: "12px" },
    clipId:    { color: "#e0e0e0", fontFamily: "monospace" },
    terminal:  { color: "#8e44ad", fontStyle: "italic" as const },
    scoreNum:  { fontFamily: "monospace", fontWeight: "bold" as const, fontSize: "13px" },
    barWrap:   { marginTop: "6px" },
    barTrack:  { position: "relative" as const, height: "6px", background: "#2a2a2a", borderRadius: "3px", overflow: "hidden" as const },
    barMid:    { position: "absolute" as const, left: "50%", top: 0, width: "1px", height: "100%", background: "#444" },
    barFill:   { position: "absolute" as const, left: 0, top: 0, height: "100%", borderRadius: "3px", transition: "width 0.3s ease" },
    barLabels: { display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#555", marginTop: "2px" },
} as const;

const sc = {
    root:   { padding: "4px 0" },
    header: { marginBottom: "6px" },
    badge:  { fontSize: "12px", fontWeight: "bold" as const, letterSpacing: "0.05em" },
    advice: { margin: "0 0 8px", fontSize: "12px", color: "#cbd5e1", lineHeight: 1.6, whiteSpace: "pre-wrap" as const },
    list:   { margin: 0, padding: "0 0 0 14px" },
    item:   { fontSize: "11px", color: "#94a3b8", lineHeight: 1.6, marginBottom: "2px" },
} as const;

const he = {
    row:          { borderBottom: "1px solid #2a2a2a", padding: "5px 0" },
    mainRow:      { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" as const },
    turn:         { fontSize: "11px", color: "#555", minWidth: "24px", flexShrink: 0 },
    endedClip:    { fontSize: "11px", color: "#e0e0e0", fontFamily: "monospace", flexShrink: 0 },
    score:        { fontSize: "12px", fontFamily: "monospace", fontWeight: "bold" as const, flexShrink: 0 },
    miniBarTrack: { position: "relative" as const, width: "60px", height: "4px", background: "#2a2a2a", borderRadius: "2px", overflow: "hidden" as const, flexShrink: 0 },
    miniBarMid:   { position: "absolute" as const, left: "50%", top: 0, width: "1px", height: "100%", background: "#444" },
    miniBarFill:  { position: "absolute" as const, left: 0, top: 0, height: "100%", borderRadius: "2px" },
    arrow:        { fontSize: "11px", color: "#555", flexShrink: 0 },
    nextClip:     { fontSize: "11px", color: "#7ab0f0", fontFamily: "monospace" },
    terminal:     { fontSize: "11px", color: "#8e44ad", fontStyle: "italic" as const },
    debugTag:     { fontSize: "10px", color: "#f5a623", border: "1px solid #7a5400", borderRadius: "3px", padding: "0 4px", background: "#2a1a00" },
    txRow:        { paddingLeft: "32px", marginTop: "2px" },
    txText:       { fontSize: "11px", color: "#666", lineHeight: 1.4 },
} as const;

const ed = {
    turnRow:         { display: "flex", flexWrap: "wrap" as const, gap: "4px", marginBottom: "10px" },
    turnBtn:         { padding: "2px 8px", fontSize: "11px", cursor: "pointer", background: "#2c2c2c", color: "#888", border: "1px solid #3a3a3a", borderRadius: "3px" },
    turnBtnActive:   { background: "#1e2a1e", color: "#7ab87a", border: "1px solid #3a6a3a" },
    payloadRoot:     { display: "flex", flexDirection: "column" as const, gap: "10px" },
    section:         { background: "#1e1e1e", border: "1px solid #2a2a2a", borderRadius: "3px", padding: "8px 10px" },
    sectionTitle:    { fontSize: "10px", color: "#666", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: "6px" },
    kvGrid:          { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "3px 12px", alignItems: "start" },
    kvKey:           { fontSize: "11px", color: "#666", whiteSpace: "nowrap" as const },
    kvVal:           { fontSize: "11px", color: "#c0ccd8", fontFamily: "monospace" },
    monoTag:         { background: "#2a3040", border: "1px solid #3a4a60", borderRadius: "3px", padding: "0 5px", color: "#7a90b0" },
    table:           { width: "100%", borderCollapse: "collapse" as const, fontSize: "11px" },
    tdKey:           { color: "#666", padding: "2px 8px 2px 0", verticalAlign: "top" as const, whiteSpace: "nowrap" as const, width: "1px" },
    tdVal:           { color: "#c0ccd8", fontFamily: "monospace", padding: "2px 0" },
    pillRow:         { display: "flex", flexWrap: "wrap" as const, gap: "3px" },
    pill:            { padding: "1px 6px", borderRadius: "999px", fontSize: "10px", background: "#2c3040", color: "#7a90b0", border: "1px solid #3a4a60" },
    pillWarn:        { background: "#3a1800", color: "#f5a623", border: "1px solid #7a4000" },
    metaRow:         { display: "flex", gap: "12px", flexWrap: "wrap" as const, alignItems: "center" },
    metaCell:        { display: "flex", flexDirection: "column" as const, gap: "1px" },
    metaLabel:       { fontSize: "10px", color: "#555", textTransform: "uppercase" as const, letterSpacing: "0.05em" },
    metaValue:       { fontSize: "12px", color: "#c0ccd8", fontFamily: "monospace" },
    fallbackBadge:   { padding: "2px 8px", borderRadius: "3px", fontSize: "11px", fontWeight: "bold" as const, background: "#4a1a1a", color: "#f88", border: "1px solid #822" },
    transcriptBlock: { marginTop: "8px", borderTop: "1px solid #2a2a2a", paddingTop: "6px" },
    transcriptLabel: { display: "block", fontSize: "10px", color: "#555", textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: "3px" },
    transcriptText2: { fontSize: "11px", color: "#94a3b8", lineHeight: 1.5, whiteSpace: "pre-wrap" as const },
    stageBlock:      { marginBottom: "8px" },
    stageLabel:      { fontSize: "10px", color: "#8a7040", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: "4px", fontWeight: "bold" as const },
    rawJson:         { fontSize: "10px", color: "#8a9ab8", background: "#1a1a2a", border: "1px solid #2a2a3a", borderRadius: "3px", padding: "8px", overflow: "auto" as const, maxHeight: "300px", margin: 0 },
} as const;