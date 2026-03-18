// =============================================================================
// App — Debug harness
//
// Developer dashboard showing the live state of capture and session in real
// time. Reviewed from an engineering correctness perspective, not UX.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { useCapture }  from "./hooks/useCapture.ts";
import { useSession }  from "./hooks/useSession.ts";
import { LandmarkOverlay }  from "./components/LandmarkOverlay.tsx";
import { MfccSpectrogram }  from "./components/MfccSpectrogram.tsx";

export function App() {
    const { capture, ready, videoRef } = useCapture();
    const {
        state, lastMessage,
        sessionId, transcript, queuePos, clipScore,
        scenarios, clipCandidates, currentClipData, feedbackUnavailable,
        connect, disconnect, selectScenario, preloadClip, sendClipEnded,
    } = useSession(capture);

    // ── Capture start/stop ────────────────────────────────────────────────────
    const [capturing,    setCapturing]    = useState(false);
    const [captureError, setCaptureError] = useState<string | null>(null);

    const startCapture = async () => {
        if (!videoRef.current) return;
        try {
            await capture.start(videoRef.current);
            setCapturing(true);
            setCaptureError(null);
        } catch (e) { setCaptureError(String(e)); }
    };

    const stopCapture = () => { capture.stop(); setCapturing(false); };

    // ── Counters ──────────────────────────────────────────────────────────────
    const [frameCount,   setFrameCount]   = useState(0);
    const [chunkCount,   setChunkCount]   = useState(0);
    const [fps,          setFps]          = useState(0);
    const [latestMfccs,  setLatestMfccs]  = useState<number[][]>([]);
    const [latestFrame,  setLatestFrame]  = useState<{
        face_landmarks: { x: number; y: number; z: number; visibility: number }[];
        left_hand:      { x: number; y: number; z: number; visibility: number }[];
        right_hand:     { x: number; y: number; z: number; visibility: number }[];
    } | null>(null);

    useEffect(() => {
        if (!capturing) return;
        let fc = 0, cc = 0, cancelled = false;

        void (async () => {
            for await (const frame of capture.frames()) {
                if (cancelled) break;
                fc++;
                setFrameCount(fc);
                setFps(frame.frame_id > 0 ? Math.round(fc / frame.timestamp) : 0);
                setLatestFrame(frame);
            }
        })();

        void (async () => {
            for await (const chunk of capture.audio()) {
                if (cancelled) break;
                cc++;
                setChunkCount(cc);
                setLatestMfccs(chunk.mfccs);
            }
        })();

        return () => { cancelled = true; };
    }, [capturing, capture]);

    // ── Overlay / video toggles ───────────────────────────────────────────────
    const [showOverlay, setShowOverlay] = useState(true);
    const [showVideo,   setShowVideo]   = useState(true);

    const handleShowVideo = (v: boolean) => {
        setShowVideo(v);
        if (videoRef.current) videoRef.current.style.opacity = v ? "1" : "0";
    };

    // ── Connect inputs ────────────────────────────────────────────────────────
    const [userIdInput,   setUserIdInput]   = useState("dev-user");
    const [languageInput, setLanguageInput] = useState("nl");

    // ── request_clip control ──────────────────────────────────────────────────
    const [rcScenarioId, setRcScenarioId] = useState("scenario_01");
    const [rcClipId,     setRcClipId]     = useState("clip_01_intro");
    const [rcActivate,   setRcActivate]   = useState(false);

    // ── ClipEnded control ─────────────────────────────────────────────────────
    const [clipEndedId, setClipEndedId] = useState("");

    // ── Error log ─────────────────────────────────────────────────────────────
    const [errors, setErrors] = useState<string[]>([]);
    const errRef = useRef<string[]>([]);

    // Patch useSession's handler onError to also push to the local log.
    // We do this via the lastMessage pathway — errors arrive as error messages.
    useEffect(() => {
        if (lastMessage?.type === "error") {
            const entry = `[${new Date().toLocaleTimeString()}] [${lastMessage.code}] ${lastMessage.message}`;
            errRef.current = [entry, ...errRef.current].slice(0, 20);
            setErrors([...errRef.current]);
        }
    }, [lastMessage]);

    return (
        <div style={st.root}>
            <h2 style={st.heading}>AR Training — Debug Harness</h2>

            {/* ── Row 1: video + spectrogram ────────────────────────────── */}
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

            {/* ── Row 2: session status ─────────────────────────────────── */}
            <div style={st.statusRow}>
                <StatusBadge state={state} />
                <Kv k="Session ID"   v={sessionId   ?? "—"} />
                <Kv k="Queue pos"    v={queuePos    !== null ? String(queuePos) : "—"} />
                <Kv k="Clip score"   v={clipScore   !== null ? clipScore.toFixed(3) : "—"} />
                <Kv k="Frames sent"  v={String(frameCount)} />
                <Kv k="Chunks sent"  v={String(chunkCount)} />
                {feedbackUnavailable && (
                    <span style={st.warnBadge}>feedback unavailable</span>
                )}
            </div>

            {/* ── Transcript ────────────────────────────────────────────── */}
            <div style={st.transcriptBox}>
                <span style={st.panelLabel}>Live transcript</span>
                <span style={st.transcriptText}>
                    {transcript || <em style={{ opacity: 0.4 }}>waiting…</em>}
                </span>
            </div>

            {/* ── Controls ──────────────────────────────────────────────── */}
            <div style={st.controls}>
                {!capturing ? (
                    <button style={st.btn} onClick={() => void startCapture()} disabled={!ready}>
                        {ready ? "Start capture" : "Loading models…"}
                    </button>
                ) : (
                    <button style={st.btn} onClick={stopCapture}>Stop capture</button>
                )}

                {state === "idle" ? (
                    <>
                        <input style={{ ...st.input, width: "90px" }}
                               placeholder="user_id" value={userIdInput}
                               onChange={e => setUserIdInput(e.target.value)} />
                        <input style={{ ...st.input, width: "50px" }}
                               placeholder="lang" value={languageInput}
                               onChange={e => setLanguageInput(e.target.value)} />
                        <button style={st.btn}
                                onClick={() => void connect(userIdInput.trim() || undefined,
                                    languageInput.trim() || undefined)}
                                disabled={!capturing}>
                            Connect
                        </button>
                    </>
                ) : (
                    <button style={{ ...st.btn, ...st.btnDanger }} onClick={disconnect}>
                        Disconnect
                    </button>
                )}
            </div>

            {captureError && (
                <div style={st.errorBox}>Capture error: {captureError}</div>
            )}

            {/* ── Scenarios panel ───────────────────────────────────────── */}
            {scenarios.length > 0 && (
                <div style={st.panel}>
                    <div style={st.panelLabel}>Scenarios</div>
                    {scenarios.map(sc => (
                        <div key={sc.scenario_id} style={st.scenarioRow}>
                            <span style={st.scenarioId}>{sc.scenario_id}</span>
                            <span style={st.scenarioTitle}>{sc.title}</span>
                            <button style={{ ...st.btn, ...st.btnSmall }}
                                    disabled={state !== "selecting"}
                                    onClick={() => selectScenario(sc.scenario_id, sc.entry_clip_id)}>
                                Select
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Current clip ──────────────────────────────────────────── */}
            <div style={st.panel}>
                <div style={st.panelLabel}>Clip control</div>
                <div style={st.controls}>
                    <input style={st.input}
                           placeholder="scenario_id"
                           value={rcScenarioId}
                           onChange={e => setRcScenarioId(e.target.value)} />
                    <input style={st.input}
                           placeholder="clip_id"
                           value={rcClipId}
                           onChange={e => setRcClipId(e.target.value)} />
                    <label style={st.checkLabel}>
                        <input type="checkbox" checked={rcActivate}
                               onChange={e => setRcActivate(e.target.checked)} />
                        {" "}activate
                    </label>
                    <button style={st.btn}
                            disabled={!sessionId}
                            onClick={() => {
                                if (rcActivate) {
                                    selectScenario(rcScenarioId.trim(), rcClipId.trim());
                                } else {
                                    preloadClip(rcScenarioId.trim(), rcClipId.trim());
                                }
                            }}>
                        request_clip
                    </button>
                </div>
                {currentClipData && (
                    <div style={st.kvRow}>
                        <Kv k="current clip" v={currentClipData.clip_id} />
                        <Kv k="scenario"     v={currentClipData.scenario_id} />
                    </div>
                )}
                <div style={{ ...st.controls, marginTop: "6px" }}>
                    <input style={st.input}
                           placeholder="clip_id for ClipEnded"
                           value={clipEndedId}
                           onChange={e => setClipEndedId(e.target.value)} />
                    <button style={st.btn}
                            disabled={state !== "active" || !clipEndedId.trim()}
                            onClick={() => sendClipEnded(clipEndedId.trim())}>
                        Send ClipEnded
                    </button>
                </div>
            </div>

            {/* ── Candidates panel ──────────────────────────────────────── */}
            {clipCandidates.length > 0 && (
                <div style={st.panel}>
                    <div style={st.panelLabel}>Clip candidates</div>
                    {clipCandidates.map(c => (
                        <div key={c.clip_id} style={st.scenarioRow}>
                            <span style={st.scenarioId}>{c.clip_id}</span>
                            <span style={st.scenarioTitle} title={c.video_url}>{c.video_url}</span>
                            <button style={{ ...st.btn, ...st.btnSmall }}
                                    onClick={() => {
                                        if (currentClipData) {
                                            preloadClip(currentClipData.scenario_id, c.clip_id);
                                        }
                                    }}>
                                Preload
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Last server message ───────────────────────────────────── */}
            <div style={st.panel}>
                <div style={st.panelLabel}>Last server message</div>
                <pre style={st.pre}>
                    {lastMessage ? JSON.stringify(lastMessage, null, 2) : "—"}
                </pre>
            </div>

            {/* ── Error log ─────────────────────────────────────────────── */}
            {errors.length > 0 && (
                <div style={{ ...st.panel, ...st.errorPanel }}>
                    <div style={st.panelLabel}>Error log</div>
                    {errors.map((e, i) => (
                        <div key={i} style={st.errorEntry}>{e}</div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ state }: { state: string }) {
    const colour: Record<string, string> = {
        idle:       "#555",
        connecting: "#e6a817",
        queued:     "#e6a817",
        selecting:  "#2980b9",
        active:     "#27ae60",
        paused:     "#2980b9",
        completed:  "#8e44ad",
        dropped:    "#e74c3c",
        error:      "#c0392b",
    };
    return (
        <span style={{ ...st.badge, background: colour[state] ?? "#555" }}>
            {state}
        </span>
    );
}

function Kv({ k, v }: { k: string; v: string }) {
    return (
        <span style={st.kv}>
            <span style={st.kvKey}>{k}</span>
            <span style={st.kvVal}>{v}</span>
        </span>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const st = {
    root: {
        fontFamily:  "monospace",
        background:  "#1a1a1a",
        color:       "#e0e0e0",
        minHeight:   "100vh",
        padding:     "16px",
        boxSizing:   "border-box" as const,
    },
    heading: {
        margin:        "0 0 12px",
        fontSize:      "14px",
        fontWeight:    "bold" as const,
        color:         "#aaa",
        textTransform: "uppercase" as const,
        letterSpacing: "0.08em",
    },
    topRow: {
        display:      "flex",
        gap:          "16px",
        marginBottom: "12px",
        flexWrap:     "wrap" as const,
    },
    videoPanel: {
        display:       "flex",
        flexDirection: "column" as const,
        gap:           "6px",
    },
    videoWrap: {
        position:   "relative" as const,
        width:      "640px",
        height:     "480px",
        background: "#000",
        flexShrink: 0,
    },
    video: {
        width:     "100%",
        height:    "100%",
        objectFit: "cover" as const,
        display:   "block",
    },
    videoControls: {
        display:    "flex",
        alignItems: "center",
        gap:        "12px",
    },
    checkLabel: { fontSize: "12px", cursor: "pointer" },
    fpsTag:     { fontSize: "12px", color: "#aaa" },
    spectrogramPanel: {
        display:       "flex",
        flexDirection: "column" as const,
        gap:           "6px",
        flex:          1,
        minWidth:      "200px",
    },
    statusRow: {
        display:      "flex",
        alignItems:   "center",
        gap:          "12px",
        marginBottom: "8px",
        flexWrap:     "wrap" as const,
    },
    badge: {
        display:       "inline-block",
        padding:       "2px 10px",
        borderRadius:  "4px",
        fontSize:      "12px",
        fontWeight:    "bold" as const,
        color:         "#fff",
        textTransform: "uppercase" as const,
        letterSpacing: "0.05em",
    },
    warnBadge: {
        display:      "inline-block",
        padding:      "2px 10px",
        borderRadius: "4px",
        fontSize:     "12px",
        background:   "#7f1d1d",
        color:        "#fca5a5",
    },
    kv: {
        fontSize: "12px",
        display:  "inline-flex",
        gap:      "4px",
    },
    kvKey: { color: "#888" },
    kvVal: { color: "#e0e0e0" },
    kvRow: {
        display:    "flex",
        gap:        "12px",
        flexWrap:   "wrap" as const,
        marginTop:  "4px",
    },
    transcriptBox: {
        background:   "#252525",
        border:       "1px solid #333",
        borderRadius: "4px",
        padding:      "8px 10px",
        marginBottom: "10px",
        fontSize:     "12px",
        lineHeight:   "1.5",
    },
    transcriptText: { whiteSpace: "pre-wrap" as const },
    controls: {
        display:      "flex",
        gap:          "8px",
        alignItems:   "center",
        flexWrap:     "wrap" as const,
        marginBottom: "10px",
    },
    btn: {
        padding:      "5px 12px",
        fontSize:     "12px",
        cursor:       "pointer",
        background:   "#2c2c2c",
        color:        "#e0e0e0",
        border:       "1px solid #444",
        borderRadius: "4px",
    },
    btnSmall: {
        padding:  "3px 8px",
        fontSize: "11px",
    },
    btnDanger: {
        background:  "#4a1a1a",
        borderColor: "#822",
    },
    input: {
        padding:      "5px 8px",
        fontSize:     "12px",
        background:   "#2c2c2c",
        color:        "#e0e0e0",
        border:       "1px solid #444",
        borderRadius: "4px",
        width:        "140px",
    },
    panel: {
        background:   "#252525",
        border:       "1px solid #333",
        borderRadius: "4px",
        padding:      "8px 10px",
        marginBottom: "10px",
    },
    errorPanel: {
        background:  "#2a1a1a",
        borderColor: "#822",
    },
    panelLabel: {
        fontSize:      "11px",
        color:         "#666",
        textTransform: "uppercase" as const,
        letterSpacing: "0.06em",
        marginBottom:  "6px",
        display:       "block",
    },
    pre: {
        margin:     0,
        fontSize:   "11px",
        color:      "#b0c4de",
        whiteSpace: "pre-wrap" as const,
        maxHeight:  "200px",
        overflowY:  "auto" as const,
    },
    errorBox: {
        background:   "#4a1a1a",
        border:       "1px solid #822",
        borderRadius: "4px",
        padding:      "6px 10px",
        fontSize:     "12px",
        color:        "#f88",
        marginBottom: "10px",
    },
    errorEntry: {
        fontSize:     "11px",
        color:        "#f88",
        marginBottom: "2px",
        whiteSpace:   "pre-wrap" as const,
    },
    scenarioRow: {
        display:    "flex",
        alignItems: "center",
        gap:        "10px",
        padding:    "4px 0",
        borderBottom: "1px solid #333",
    },
    scenarioId: {
        fontSize:  "11px",
        color:     "#888",
        minWidth:  "100px",
        flexShrink: 0,
    },
    scenarioTitle: {
        fontSize: "12px",
        color:    "#ccc",
        flex:     1,
        overflow: "hidden" as const,
        textOverflow: "ellipsis" as const,
        whiteSpace: "nowrap" as const,
    },
} as const;