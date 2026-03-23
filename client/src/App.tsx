// =============================================================================
// App — Debug harness
// =============================================================================

import { useEffect, useRef, useState } from "react";
import type { ServerMessage, ClipData } from "@ar-training/shared";
import { useCapture }      from "./hooks/useCapture.ts";
import { useSession }      from "./hooks/useSession.ts";
import { LandmarkOverlay } from "./components/LandmarkOverlay.tsx";
import { MfccSpectrogram } from "./components/MfccSpectrogram.tsx";

type ClipSelected       = Extract<ServerMessage, { type: "clip_selected" }>;
type ScenariosListMsg   = Extract<ServerMessage, { type: "scenarios_list" }>;
type SessionCompleteMsg = Extract<ServerMessage, { type: "session_complete" }>;

export function App() {
    const { capture, ready, videoRef } = useCapture();
    const {
        state, lastMessage,
        sessionId, transcript, queuePos, clipScore,
        scenarios, clipCandidates, currentClipData, feedbackUnavailable,
        connect, disconnect, selectScenario, preloadClip, sendClipEnded,
    } = useSession(capture);

    // ── Capture ───────────────────────────────────────────────────────────────
    const [capturing,    setCapturing]    = useState(false);
    const [captureError, setCaptureError] = useState<string | null>(null);

    const startCapture = async () => {
        if (!videoRef.current) return;
        try { await capture.start(videoRef.current); setCapturing(true); setCaptureError(null); }
        catch (e) { setCaptureError(String(e)); }
    };
    const stopCapture = () => { capture.stop(); setCapturing(false); };

    // ── Counters ──────────────────────────────────────────────────────────────
    const [frameCount,  setFrameCount]  = useState(0);
    const [chunkCount,  setChunkCount]  = useState(0);
    const [fps,         setFps]         = useState(0);
    const [latestMfccs, setLatestMfccs] = useState<number[][]>([]);
    const [latestFrame, setLatestFrame] = useState<{
        face_landmarks: { x: number; y: number; z: number; visibility: number }[];
        left_hand:      { x: number; y: number; z: number; visibility: number }[];
        right_hand:     { x: number; y: number; z: number; visibility: number }[];
    } | null>(null);

    useEffect(() => {
        if (!capturing) return;
        let fc = 0, cc = 0, cancelled = false;
        void (async () => {
            for await (const f of capture.frames()) {
                if (cancelled) break;
                fc++; setFrameCount(fc);
                setFps(f.frame_id > 0 ? Math.round(fc / f.timestamp) : 0);
                setLatestFrame(f);
            }
        })();
        void (async () => {
            for await (const c of capture.audio()) {
                if (cancelled) break;
                cc++; setChunkCount(cc); setLatestMfccs(c.mfccs);
            }
        })();
        return () => { cancelled = true; };
    }, [capturing, capture]);

    // ── Overlay toggles ───────────────────────────────────────────────────────
    const [showOverlay, setShowOverlay] = useState(true);
    const [showVideo,   setShowVideo]   = useState(true);
    const handleShowVideo = (v: boolean) => {
        setShowVideo(v);
        if (videoRef.current) videoRef.current.style.opacity = v ? "1" : "0";
    };

    // ── Connect inputs ────────────────────────────────────────────────────────
    const [userIdInput,   setUserIdInput]   = useState("dev-user");
    const [languageInput, setLanguageInput] = useState("nl");

    // ── Per-type message snapshots ────────────────────────────────────────────
    const [lastScenariosMsg,    setLastScenariosMsg]    = useState<ScenariosListMsg | null>(null);
    const [lastClipDataMsg,     setLastClipDataMsg]     = useState<ClipData | null>(null);
    const [lastClipSelectedMsg, setLastClipSelectedMsg] = useState<ClipSelected | null>(null);
    const [lastSessionComplete, setLastSessionComplete] = useState<SessionCompleteMsg | null>(null);
    const [errors,              setErrors]              = useState<string[]>([]);
    const errRef = useRef<string[]>([]);

    useEffect(() => {
        if (!lastMessage) return;
        switch (lastMessage.type) {
            case "scenarios_list":  setLastScenariosMsg(lastMessage);    break;
            case "clip_data":       setLastClipDataMsg(lastMessage);     break;
            case "clip_selected":   setLastClipSelectedMsg(lastMessage); break;
            case "session_complete":setLastSessionComplete(lastMessage); break;
            case "error": {
                const e = `[${new Date().toLocaleTimeString()}] [${lastMessage.code}] ${lastMessage.message}`;
                errRef.current = [e, ...errRef.current].slice(0, 20);
                setErrors([...errRef.current]);
                break;
            }
        }
    }, [lastMessage]);

    // ── Clip control ──────────────────────────────────────────────────────────
    const [rcScenarioId, setRcScenarioId] = useState("");
    const [rcClipId,     setRcClipId]     = useState("");
    const [rcActivate,   setRcActivate]   = useState(false);

    useEffect(() => {
        if (scenarios.length > 0 && rcScenarioId === "") {
            setRcScenarioId(scenarios[0].scenario_id);
            setRcClipId(scenarios[0].entry_clip_id);
        }
    }, [scenarios, rcScenarioId]);

    const handleScenarioDropdownChange = (id: string) => {
        setRcScenarioId(id);
        const sc = scenarios.find(s => s.scenario_id === id);
        if (sc) setRcClipId(sc.entry_clip_id);
    };

    const [clipEndedId, setClipEndedId] = useState("");
    useEffect(() => {
        if (currentClipData) setClipEndedId(currentClipData.clip_id);
    }, [currentClipData]);

    // ── Feedback streaming ────────────────────────────────────────────────────
    const [feedbackTokens, setFeedbackTokens] = useState("");
    useEffect(() => {
        if (lastMessage?.type === "feedback_token")
            setFeedbackTokens(prev => prev + lastMessage.token);
        if (lastMessage?.type === "session_complete")
            setFeedbackTokens("");
    }, [lastMessage]);

    return (
        <div style={st.root}>
            <h2 style={st.heading}>AR Training — Debug Harness</h2>

            {/* ── Row 1: video + spectrogram ──────────────────────────── */}
            <div style={st.topRow}>
                <div style={st.videoPanel}>
                    <div style={st.videoWrap}>
                        <video ref={videoRef} style={st.video} muted playsInline />
                        {showOverlay && capturing && latestFrame && (
                            <LandmarkOverlay frame={latestFrame} width={640} height={480} />
                        )}
                    </div>
                    <div style={st.videoControls}>
                        <label style={st.checkLabel}>
                            <input type="checkbox" checked={showVideo}
                                   onChange={e => handleShowVideo(e.target.checked)} />
                            {" "}Video
                        </label>
                        <label style={st.checkLabel}>
                            <input type="checkbox" checked={showOverlay}
                                   onChange={e => setShowOverlay(e.target.checked)} />
                            {" "}Landmarks
                        </label>
                        <span style={st.fpsTag}>{capturing ? `${fps} fps` : "—"}</span>
                    </div>
                </div>
                <div style={st.spectrogramPanel}>
                    <div style={st.panelLabel}>MFCC spectrogram</div>
                    <MfccSpectrogram mfccs={latestMfccs} />
                </div>
            </div>

            {/* ── Row 2: status ───────────────────────────────────────── */}
            <div style={st.statusRow}>
                <StatusBadge state={state} />
                <Kv k="Session" v={sessionId ?? "—"} />
                <Kv k="Queue"   v={queuePos !== null ? String(queuePos) : "—"} />
                <Kv k="Score"   v={clipScore !== null ? clipScore.toFixed(3) : "—"} />
                <Kv k="Frames"  v={String(frameCount)} />
                <Kv k="Chunks"  v={String(chunkCount)} />
                {feedbackUnavailable && <span style={st.warnBadge}>feedback unavailable</span>}
            </div>

            {/* ── Capture + connect controls ──────────────────────────── */}
            <div style={st.controls}>
                {!capturing
                    ? <button style={st.btn} onClick={() => void startCapture()} disabled={!ready}>
                        {ready ? "Start capture" : "Loading models…"}
                    </button>
                    : <button style={st.btn} onClick={stopCapture}>Stop capture</button>
                }
                {state === "idle"
                    ? <>
                        <input style={{ ...st.input, width: "90px" }} placeholder="user_id"
                               value={userIdInput} onChange={e => setUserIdInput(e.target.value)} />
                        <input style={{ ...st.input, width: "50px" }} placeholder="lang"
                               value={languageInput} onChange={e => setLanguageInput(e.target.value)} />
                        <button style={st.btn} disabled={!capturing}
                                onClick={() => void connect(userIdInput.trim() || undefined,
                                    languageInput.trim() || undefined)}>
                            Connect
                        </button>
                    </>
                    : <button style={{ ...st.btn, ...st.btnDanger }} onClick={disconnect}>
                        Disconnect
                    </button>
                }
            </div>
            {captureError && <div style={st.errorBox}>Capture error: {captureError}</div>}

            {/* ── Live transcript ─────────────────────────────────────── */}
            <div style={st.panel}>
                <span style={st.panelLabel}>Live transcript</span>
                <span style={st.transcriptText}>
                    {transcript || <em style={{ opacity: 0.4 }}>waiting…</em>}
                </span>
            </div>

            {/* ── Clip control ────────────────────────────────────────── */}
            <div style={st.panel}>
                <span style={st.panelLabel}>Clip control</span>
                <div style={st.controls}>
                    {scenarios.length > 0
                        ? <select style={st.select} value={rcScenarioId}
                                  onChange={e => handleScenarioDropdownChange(e.target.value)}>
                            {scenarios.map(sc => (
                                <option key={sc.scenario_id} value={sc.scenario_id}>
                                    {sc.scenario_id} — {sc.title}
                                </option>
                            ))}
                        </select>
                        : <input style={st.input} placeholder="scenario_id"
                                 value={rcScenarioId} onChange={e => setRcScenarioId(e.target.value)} />
                    }
                    <input style={st.input} placeholder="clip_id"
                           value={rcClipId} onChange={e => setRcClipId(e.target.value)} />
                    <label style={st.checkLabel}>
                        <input type="checkbox" checked={rcActivate}
                               onChange={e => setRcActivate(e.target.checked)} />
                        {" "}activate
                    </label>
                    <button style={st.btn} disabled={!sessionId || !rcScenarioId || !rcClipId}
                            onClick={() => {
                                if (rcActivate) selectScenario(rcScenarioId, rcClipId);
                                else            preloadClip(rcScenarioId, rcClipId);
                            }}>
                        request_clip
                    </button>
                </div>

                {/* clip_data response — structured view */}
                {lastClipDataMsg && <ClipDataView clip={lastClipDataMsg} />}

                {/* ClipEnded control */}
                <div style={{ ...st.controls, marginTop: "8px" }}>
                    <input style={st.input} placeholder="clip_id for ClipEnded"
                           value={clipEndedId} onChange={e => setClipEndedId(e.target.value)} />
                    <button style={st.btn}
                            disabled={state !== "active" || !clipEndedId.trim()}
                            onClick={() => sendClipEnded(clipEndedId.trim())}>
                        Send ClipEnded
                    </button>
                </div>
            </div>

            {/* ── clip_selected ────────────────────────────────────────── */}
            {lastClipSelectedMsg && (
                <div style={st.panel}>
                    <span style={st.panelLabel}>clip_selected</span>
                    <ClipSelectedView msg={lastClipSelectedMsg} />
                </div>
            )}

            {/* ── Clip candidates ─────────────────────────────────────── */}
            {clipCandidates.length > 0 && (
                <div style={st.panel}>
                    <span style={st.panelLabel}>Clip candidates</span>
                    {clipCandidates.map(c => (
                        <div key={c.clip_id} style={st.scenarioRow}>
                            <span style={st.mono}>{c.clip_id}</span>
                            <span style={st.dimText} title={c.video_url}>{c.video_url}</span>
                            <button style={{ ...st.btn, ...st.btnSmall }}
                                    onClick={() => {
                                        if (currentClipData)
                                            preloadClip(currentClipData.scenario_id, c.clip_id);
                                    }}>
                                Preload
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* ── scenarios_list ──────────────────────────────────────── */}
            {lastScenariosMsg && (
                <div style={st.panel}>
                    <span style={st.panelLabel}>scenarios_list</span>
                    {lastScenariosMsg.scenarios.map(sc => (
                        <div key={sc.scenario_id} style={st.scenarioRow}>
                            <span style={st.mono}>{sc.scenario_id}</span>
                            <span style={st.dimText}>{sc.title}</span>
                            <button style={{ ...st.btn, ...st.btnSmall }}
                                    disabled={state !== "selecting"}
                                    onClick={() => selectScenario(sc.scenario_id, sc.entry_clip_id)}>
                                Select
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Feedback ────────────────────────────────────────────── */}
            {(feedbackTokens || lastSessionComplete) && (
                <div style={st.panel}>
                    <span style={st.panelLabel}>
                        {lastSessionComplete ? "session_complete" : "feedback_token stream"}
                    </span>
                    {lastSessionComplete
                        ? <SessionCompleteView msg={lastSessionComplete} />
                        : <span style={st.transcriptText}>{feedbackTokens}</span>
                    }
                </div>
            )}

            {/* ── Error log ───────────────────────────────────────────── */}
            {errors.length > 0 && (
                <div style={{ ...st.panel, ...st.errorPanel }}>
                    <span style={st.panelLabel}>Error log</span>
                    {errors.map((e, i) => <div key={i} style={st.errorEntry}>{e}</div>)}
                </div>
            )}
        </div>
    );
}

// ─── Dedicated message views ──────────────────────────────────────────────────

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

            {clip.transcript && (
                <p style={cv.transcript}>"{clip.transcript}"</p>
            )}

            {clip.notable_features.length > 0 && (
                <div style={cv.tagRow}>
                    {clip.notable_features.map(f => (
                        <span key={f} style={cv.tag}>{f}</span>
                    ))}
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
    // Map -1..1 to 0..100% for the bar. Midpoint (0) is the centre.
    const pct   = ((score + 1) / 2) * 100;
    const color = score < -0.2 ? "#27ae60" : score > 0.2 ? "#e74c3c" : "#e6a817";

    return (
        <div style={cs.root}>
            <div style={cs.row}>
                <span style={cs.label}>next clip</span>
                <span style={cs.value}>
                    {msg.clip_id
                        ? <span style={cs.clipId}>{msg.clip_id}</span>
                        : <span style={cs.terminal}>terminal</span>
                    }
                </span>
            </div>
            <div style={cs.row}>
                <span style={cs.label}>escalation score</span>
                <span style={cs.value}>
                    <span style={{ ...cs.scoreNum, color }}>{score.toFixed(4)}</span>
                </span>
            </div>
            {/* Score bar: left half = de-escalating (green), right = escalating (red) */}
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
                    {msg.highlights.map((h, i) => (
                        <li key={i} style={sc.item}>{h}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ state }: { state: string }) {
    const colour: Record<string, string> = {
        idle: "#555", connecting: "#e6a817", queued: "#e6a817",
        selecting: "#2980b9", active: "#27ae60", paused: "#2980b9",
        completed: "#8e44ad", dropped: "#e74c3c", error: "#c0392b",
    };
    return <span style={{ ...st.badge, background: colour[state] ?? "#555" }}>{state}</span>;
}

function Kv({ k, v }: { k: string; v: string }) {
    return (
        <span style={st.kv}>
            <span style={st.kvKey}>{k}</span>
            <span style={st.kvVal}>{v}</span>
        </span>
    );
}

// ─── Styles — main ────────────────────────────────────────────────────────────

const st = {
    root:         { fontFamily: "monospace", background: "#1a1a1a", color: "#e0e0e0", minHeight: "100vh", padding: "16px", boxSizing: "border-box" as const },
    heading:      { margin: "0 0 12px", fontSize: "14px", fontWeight: "bold" as const, color: "#aaa", textTransform: "uppercase" as const, letterSpacing: "0.08em" },
    topRow:       { display: "flex", gap: "16px", marginBottom: "12px", flexWrap: "wrap" as const },
    videoPanel:   { display: "flex", flexDirection: "column" as const, gap: "6px" },
    videoWrap:    { position: "relative" as const, width: "640px", height: "480px", background: "#000", flexShrink: 0 },
    video:        { width: "100%", height: "100%", objectFit: "cover" as const, display: "block" },
    videoControls:{ display: "flex", alignItems: "center", gap: "12px" },
    checkLabel:   { fontSize: "12px", cursor: "pointer" },
    fpsTag:       { fontSize: "12px", color: "#aaa" },
    spectrogramPanel: { display: "flex", flexDirection: "column" as const, gap: "6px", flex: 1, minWidth: "200px" },
    statusRow:    { display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px", flexWrap: "wrap" as const },
    badge:        { display: "inline-block", padding: "2px 10px", borderRadius: "4px", fontSize: "12px", fontWeight: "bold" as const, color: "#fff", textTransform: "uppercase" as const, letterSpacing: "0.05em" },
    warnBadge:    { display: "inline-block", padding: "2px 10px", borderRadius: "4px", fontSize: "12px", background: "#7f1d1d", color: "#fca5a5" },
    kv:           { fontSize: "12px", display: "inline-flex", gap: "4px" },
    kvKey:        { color: "#888" },
    kvVal:        { color: "#e0e0e0" },
    transcriptText: { fontSize: "12px", whiteSpace: "pre-wrap" as const, lineHeight: 1.5 },
    controls:     { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" as const, marginBottom: "10px" },
    btn:          { padding: "5px 12px", fontSize: "12px", cursor: "pointer", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px" },
    btnSmall:     { padding: "3px 8px", fontSize: "11px" },
    btnDanger:    { background: "#4a1a1a", borderColor: "#822" },
    input:        { padding: "5px 8px", fontSize: "12px", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", width: "140px" },
    select:       { padding: "5px 8px", fontSize: "12px", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", maxWidth: "280px" },
    panel:        { background: "#252525", border: "1px solid #333", borderRadius: "4px", padding: "8px 10px", marginBottom: "10px" },
    errorPanel:   { background: "#2a1a1a", borderColor: "#822" },
    panelLabel:   { fontSize: "11px", color: "#666", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: "6px", display: "block" },
    errorBox:     { background: "#4a1a1a", border: "1px solid #822", borderRadius: "4px", padding: "6px 10px", fontSize: "12px", color: "#f88", marginBottom: "10px" },
    errorEntry:   { fontSize: "11px", color: "#f88", marginBottom: "2px", whiteSpace: "pre-wrap" as const },
    scenarioRow:  { display: "flex", alignItems: "center", gap: "10px", padding: "4px 0", borderBottom: "1px solid #333" },
    mono:         { fontSize: "11px", color: "#888", minWidth: "120px", flexShrink: 0, fontFamily: "monospace" },
    dimText:      { fontSize: "12px", color: "#666", flex: 1, overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const },
} as const;

// ─── Styles — ClipDataView ────────────────────────────────────────────────────

const cv = {
    root:       { marginTop: "8px", padding: "8px", background: "#1e1e1e", borderRadius: "4px", border: "1px solid #2a2a2a" },
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
    tdNull:     { color: "#8e44ad", fontStyle: "italic" },
} as const;

// ─── Styles — ClipSelectedView ────────────────────────────────────────────────

const cs = {
    root:      { padding: "4px 0" },
    row:       { display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" },
    label:     { fontSize: "11px", color: "#666", minWidth: "100px" },
    value:     { fontSize: "12px" },
    clipId:    { color: "#e0e0e0", fontFamily: "monospace" },
    terminal:  { color: "#8e44ad", fontStyle: "italic" },
    scoreNum:  { fontFamily: "monospace", fontWeight: "bold" as const, fontSize: "13px" },
    barWrap:   { marginTop: "6px" },
    barTrack:  { position: "relative" as const, height: "6px", background: "#2a2a2a", borderRadius: "3px", overflow: "hidden" as const },
    barMid:    { position: "absolute" as const, left: "50%", top: 0, width: "1px", height: "100%", background: "#444" },
    barFill:   { position: "absolute" as const, left: 0, top: 0, height: "100%", borderRadius: "3px", transition: "width 0.3s ease" },
    barLabels: { display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#555", marginTop: "2px" },
} as const;

// ─── Styles — SessionCompleteView ─────────────────────────────────────────────

const sc = {
    root:    { padding: "4px 0" },
    header:  { marginBottom: "6px" },
    badge:   { fontSize: "12px", fontWeight: "bold" as const, letterSpacing: "0.05em" },
    advice:  { margin: "0 0 8px", fontSize: "12px", color: "#cbd5e1", lineHeight: 1.6, whiteSpace: "pre-wrap" as const },
    list:    { margin: 0, padding: "0 0 0 14px" },
    item:    { fontSize: "11px", color: "#94a3b8", lineHeight: 1.6, marginBottom: "2px" },
} as const;