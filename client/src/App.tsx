// =============================================================================
// App — Debug Harness
//
// Two-column layout:
//   Left  — camera feed, landmark overlay, MFCC spectrogram, capture controls,
//            session controls, clip control panel
//   Right — scrollable data panels (transcript, clip_data, candidates,
//            clip_selected, scenarios, feedback stream, error log)
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
    const [showVideo,    setShowVideo]    = useState(true);
    const [showOverlay,  setShowOverlay]  = useState(true);

    const startCapture = async () => {
        if (!videoRef.current) return;
        try {
            await capture.start(videoRef.current);
            setCapturing(true);
            setCaptureError(null);
        } catch (e) {
            setCaptureError(String(e));
        }
    };
    const stopCapture = () => { capture.stop(); setCapturing(false); };

    const handleShowVideo = (v: boolean) => {
        setShowVideo(v);
        if (videoRef.current) videoRef.current.style.opacity = v ? "1" : "0";
    };

    // ── Counters / live frame data ────────────────────────────────────────────
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
            case "scenarios_list":   setLastScenariosMsg(lastMessage);    break;
            case "clip_data":        setLastClipDataMsg(lastMessage);     break;
            case "clip_selected":    setLastClipSelectedMsg(lastMessage); break;
            case "session_complete": setLastSessionComplete(lastMessage); break;
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

    // Auto-populate scenario/clip from scenarios_list
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

    // Auto-populate clip ID from the most recent activating clip_data
    const [clipEndedId, setClipEndedId] = useState("");
    useEffect(() => {
        if (currentClipData) {
            setRcClipId(currentClipData.clip_id);
            setClipEndedId(currentClipData.clip_id);
        }
    }, [currentClipData]);

    // ── Feedback streaming ────────────────────────────────────────────────────
    const [feedbackTokens, setFeedbackTokens] = useState("");
    useEffect(() => {
        if (lastMessage?.type === "feedback_token")
            setFeedbackTokens(prev => prev + lastMessage.token);
        if (lastMessage?.type === "session_complete")
            setFeedbackTokens("");
    }, [lastMessage]);

    // ── Collapsible panel state ───────────────────────────────────────────────
    const [openPanels, setOpenPanels] = useState<Record<string, boolean>>({
        transcript: true,
        clip_data: true,
        candidates: true,
        clip_selected: true,
        scenarios: true,
        feedback: true,
        errors: true,
    });
    const togglePanel = (key: string) =>
        setOpenPanels(p => ({ ...p, [key]: !p[key] }));

    const hasSession = state !== "idle";

    return (
        <div style={st.root}>
            {/* ── Persistent hidden capture video ──────────────────────────── */}
            <video ref={videoRef}
                   muted playsInline
                   style={{ position: "fixed", opacity: 0, pointerEvents: "none", width: 1, height: 1, top: 0, left: 0 }}
            />

            {/* ── Status bar ───────────────────────────────────────────────── */}
            <div style={st.statusBar}>
                <span style={st.appTitle}>AR Training — Debug Harness</span>
                <div style={st.statusItems}>
                    <StatusBadge state={state} />
                    <Kv k="Session" v={sessionId ?? "—"} />
                    <Kv k="Queue"   v={queuePos !== null ? String(queuePos) : "—"} />
                    <Kv k="Score"   v={clipScore !== null ? clipScore.toFixed(3) : "—"} />
                    <Kv k="Frames"  v={String(frameCount)} />
                    <Kv k="Chunks"  v={String(chunkCount)} />
                    <Kv k="FPS"     v={capturing ? String(fps) : "—"} />
                    {feedbackUnavailable && <span style={st.warnBadge}>feedback unavailable</span>}
                </div>
            </div>

            {/* ── Two-column body ───────────────────────────────────────────── */}
            <div style={st.columns}>

                {/* ════════════════════ LEFT COLUMN ═══════════════════════════ */}
                <div style={st.leftCol}>

                    {/* Camera feed + overlay */}
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
                        <span style={st.dimText}>{capturing ? `${fps} fps` : "—"}</span>
                    </div>

                    {/* MFCC spectrogram */}
                    <div style={st.spectrogramWrap}>
                        <SectionLabel>MFCC spectrogram</SectionLabel>
                        <MfccSpectrogram mfccs={latestMfccs} />
                    </div>

                    {/* Capture controls */}
                    <div style={st.controlGroup}>
                        <SectionLabel>Capture</SectionLabel>
                        <div style={st.row}>
                            {!capturing
                                ? <button style={st.btn} onClick={() => void startCapture()} disabled={!ready}>
                                    {ready ? "Start capture" : "Loading models…"}
                                </button>
                                : <button style={st.btn} onClick={stopCapture}>Stop capture</button>
                            }
                        </div>
                        {captureError && <div style={st.errorBox}>Capture error: {captureError}</div>}
                    </div>

                    {/* Session controls */}
                    <div style={st.controlGroup}>
                        <SectionLabel>Session</SectionLabel>
                        {state === "idle"
                            ? <div style={st.row}>
                                <input style={{ ...st.input, width: "100px" }} placeholder="user_id"
                                       value={userIdInput} onChange={e => setUserIdInput(e.target.value)} />
                                <input style={{ ...st.input, width: "50px" }} placeholder="lang"
                                       value={languageInput} onChange={e => setLanguageInput(e.target.value)} />
                                <button style={st.btn} disabled={!capturing}
                                        onClick={() => void connect(
                                            userIdInput.trim() || undefined,
                                            languageInput.trim() || undefined,
                                        )}>
                                    Connect
                                </button>
                            </div>
                            : <div style={st.row}>
                                <button style={{ ...st.btn, ...st.btnDanger }} onClick={disconnect}>
                                    Disconnect
                                </button>
                            </div>
                        }
                    </div>

                    {/* Clip control panel — shown whenever a session exists */}
                    {hasSession && (
                        <div style={st.controlGroup}>
                            <SectionLabel>Clip control</SectionLabel>

                            {/* Scenario selector */}
                            <div style={{ ...st.row, marginBottom: "6px" }}>
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
                                             value={rcScenarioId}
                                             onChange={e => setRcScenarioId(e.target.value)} />
                                }
                            </div>

                            {/* Clip ID + request/activate buttons */}
                            <div style={{ ...st.row, marginBottom: "6px" }}>
                                <input style={st.input} placeholder="clip_id"
                                       value={rcClipId}
                                       onChange={e => setRcClipId(e.target.value)} />
                                <button style={st.btn}
                                        disabled={!sessionId || !rcScenarioId || !rcClipId}
                                        onClick={() => preloadClip(rcScenarioId, rcClipId)}
                                        title="Sends request_clip with activate: false">
                                    Request clip
                                </button>
                                <button style={{ ...st.btn, ...st.btnPrimary }}
                                        disabled={state !== "selecting" || !rcScenarioId || !rcClipId}
                                        onClick={() => selectScenario(rcScenarioId, rcClipId)}
                                        title="Sends request_clip with activate: true — only valid in selecting state">
                                    Activate clip
                                </button>
                            </div>

                            {/* ClipEnded */}
                            <div style={st.row}>
                                <input style={st.input} placeholder="clip_id for ClipEnded"
                                       value={clipEndedId}
                                       onChange={e => setClipEndedId(e.target.value)} />
                                <button style={st.btn}
                                        disabled={state !== "active" || !clipEndedId.trim()}
                                        onClick={() => sendClipEnded(clipEndedId.trim())}>
                                    Send ClipEnded
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* ════════════════════ RIGHT COLUMN ══════════════════════════ */}
                <div style={st.rightCol}>

                    {/* Live transcript */}
                    <CollapsiblePanel
                        label="Live transcript"
                        panelKey="transcript"
                        open={openPanels["transcript"] ?? true}
                        onToggle={togglePanel}
                    >
                        <span style={st.transcriptText}>
                            {transcript || <em style={{ opacity: 0.4 }}>waiting…</em>}
                        </span>
                    </CollapsiblePanel>

                    {/* current clip_data */}
                    <CollapsiblePanel
                        label="current clip_data"
                        panelKey="clip_data"
                        open={openPanels["clip_data"] ?? true}
                        onToggle={togglePanel}
                    >
                        {lastClipDataMsg
                            ? <ClipDataView clip={lastClipDataMsg} />
                            : <em style={st.empty}>none yet</em>}
                    </CollapsiblePanel>

                    {/* clip_candidates */}
                    <CollapsiblePanel
                        label={`clip_candidates (${clipCandidates.length})`}
                        panelKey="candidates"
                        open={openPanels["candidates"] ?? true}
                        onToggle={togglePanel}
                    >
                        {clipCandidates.length > 0
                            ? clipCandidates.map(c => (
                                <div key={c.clip_id} style={st.candidateRow}>
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
                            ))
                            : <em style={st.empty}>none yet</em>}
                    </CollapsiblePanel>

                    {/* clip_selected */}
                    <CollapsiblePanel
                        label="clip_selected"
                        panelKey="clip_selected"
                        open={openPanels["clip_selected"] ?? true}
                        onToggle={togglePanel}
                    >
                        {lastClipSelectedMsg
                            ? <ClipSelectedView msg={lastClipSelectedMsg} />
                            : <em style={st.empty}>none yet</em>}
                    </CollapsiblePanel>

                    {/* scenarios_list */}
                    <CollapsiblePanel
                        label={`scenarios_list (${lastScenariosMsg?.scenarios.length ?? 0})`}
                        panelKey="scenarios"
                        open={openPanels["scenarios"] ?? true}
                        onToggle={togglePanel}
                    >
                        {lastScenariosMsg
                            ? lastScenariosMsg.scenarios.map(sc => (
                                <div key={sc.scenario_id} style={st.candidateRow}>
                                    <span style={st.mono}>{sc.scenario_id}</span>
                                    <span style={st.dimText}>{sc.title}</span>
                                    <button style={{ ...st.btn, ...st.btnSmall }}
                                            disabled={state !== "selecting"}
                                            onClick={() => selectScenario(sc.scenario_id, sc.entry_clip_id)}>
                                        Select
                                    </button>
                                </div>
                            ))
                            : <em style={st.empty}>none yet</em>}
                    </CollapsiblePanel>

                    {/* Feedback stream / session_complete */}
                    <CollapsiblePanel
                        label={lastSessionComplete ? "session_complete" : "feedback stream"}
                        panelKey="feedback"
                        open={openPanels["feedback"] ?? true}
                        onToggle={togglePanel}
                    >
                        {lastSessionComplete
                            ? <SessionCompleteView msg={lastSessionComplete} />
                            : feedbackTokens
                                ? <span style={st.transcriptText}>{feedbackTokens}</span>
                                : <em style={st.empty}>none yet</em>}
                    </CollapsiblePanel>

                    {/* Error log */}
                    <CollapsiblePanel
                        label={`Error log (${errors.length})`}
                        panelKey="errors"
                        open={openPanels["errors"] ?? true}
                        onToggle={togglePanel}
                        danger={errors.length > 0}
                    >
                        {errors.length > 0
                            ? errors.map((e, i) => <div key={i} style={st.errorEntry}>{e}</div>)
                            : <em style={st.empty}>no errors</em>}
                    </CollapsiblePanel>

                </div>
            </div>
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

const cp = {
    panel:   { background: "#252525", border: "1px solid #333", borderRadius: "4px", marginBottom: "8px" },
    danger:  { background: "#2a1a1a", borderColor: "#822" },
    header:  { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "none", border: "none", cursor: "pointer", color: "inherit" },
    label:   { fontSize: "11px", color: "#666", textTransform: "uppercase" as const, letterSpacing: "0.06em" },
    chevron: { fontSize: "11px", color: "#555" },
    body:    { padding: "6px 10px 10px" },
} as const;

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

// ─── Small helpers ────────────────────────────────────────────────────────────

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

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <div style={st.sectionLabel}>{children}</div>;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const st = {
    root:          { fontFamily: "monospace", background: "#1a1a1a", color: "#e0e0e0", minHeight: "100vh", boxSizing: "border-box" as const },
    statusBar:     { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: "12px", padding: "8px 16px", background: "#111", borderBottom: "1px solid #333" },
    appTitle:      { fontSize: "12px", fontWeight: "bold" as const, color: "#666", textTransform: "uppercase" as const, letterSpacing: "0.08em" },
    statusItems:   { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" as const },
    columns:       { display: "grid", gridTemplateColumns: "660px 1fr", minHeight: "calc(100vh - 37px)" },
    leftCol:       { padding: "16px", borderRight: "1px solid #2a2a2a", display: "flex", flexDirection: "column" as const, gap: "12px" },
    rightCol:      { padding: "16px", overflowY: "auto" as const },
    videoWrap:     { position: "relative" as const, width: "628px", height: "471px", background: "#000", flexShrink: 0 },
    video:         { width: "100%", height: "100%", objectFit: "cover" as const, display: "block" },
    videoControls: { display: "flex", alignItems: "center", gap: "12px" },
    spectrogramWrap: { display: "flex", flexDirection: "column" as const, gap: "4px" },
    sectionLabel:  { fontSize: "10px", color: "#555", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: "4px" },
    controlGroup:  { display: "flex", flexDirection: "column" as const, gap: "2px" },
    row:           { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" as const },
    btn:           { padding: "5px 10px", fontSize: "12px", cursor: "pointer", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px" },
    btnSmall:      { padding: "3px 8px", fontSize: "11px" },
    btnDanger:     { background: "#4a1a1a", borderColor: "#822" },
    btnPrimary:    { background: "#1a2a4a", borderColor: "#2a4a8a", color: "#7ab0f0" },
    input:         { padding: "5px 8px", fontSize: "12px", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", width: "140px" },
    select:        { padding: "5px 8px", fontSize: "12px", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", maxWidth: "340px" },
    checkLabel:    { fontSize: "12px", cursor: "pointer" },
    dimText:       { fontSize: "11px", color: "#555" },
    badge:         { display: "inline-block", padding: "2px 10px", borderRadius: "4px", fontSize: "11px", fontWeight: "bold" as const, color: "#fff", textTransform: "uppercase" as const, letterSpacing: "0.05em" },
    warnBadge:     { display: "inline-block", padding: "2px 10px", borderRadius: "4px", fontSize: "11px", background: "#7f1d1d", color: "#fca5a5" },
    kv:            { fontSize: "11px", display: "inline-flex", gap: "4px" },
    kvKey:         { color: "#666" },
    kvVal:         { color: "#e0e0e0" },
    transcriptText: { fontSize: "12px", whiteSpace: "pre-wrap" as const, lineHeight: 1.5 },
    errorBox:      { background: "#4a1a1a", border: "1px solid #822", borderRadius: "4px", padding: "6px 10px", fontSize: "12px", color: "#f88" },
    errorEntry:    { fontSize: "11px", color: "#f88", marginBottom: "2px", whiteSpace: "pre-wrap" as const },
    candidateRow:  { display: "flex", alignItems: "center", gap: "10px", padding: "4px 0", borderBottom: "1px solid #2a2a2a" },
    mono:          { fontSize: "11px", color: "#888", minWidth: "120px", flexShrink: 0, fontFamily: "monospace" },
    empty:         { fontSize: "12px", color: "#444", fontStyle: "italic" as const },
} as const;

// ─── ClipDataView styles ──────────────────────────────────────────────────────

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

// ─── ClipSelectedView styles ──────────────────────────────────────────────────

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

// ─── SessionCompleteView styles ───────────────────────────────────────────────

const sc = {
    root:   { padding: "4px 0" },
    header: { marginBottom: "6px" },
    badge:  { fontSize: "12px", fontWeight: "bold" as const, letterSpacing: "0.05em" },
    advice: { margin: "0 0 8px", fontSize: "12px", color: "#cbd5e1", lineHeight: 1.6, whiteSpace: "pre-wrap" as const },
    list:   { margin: 0, padding: "0 0 0 14px" },
    item:   { fontSize: "11px", color: "#94a3b8", lineHeight: 1.6, marginBottom: "2px" },
} as const;