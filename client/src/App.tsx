// =============================================================================
// App — Debug harness
//
// Developer dashboard showing the live state of capture and session in real
// time. Reviewed from an engineering correctness perspective, not UX.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import type { ServerMessage } from "@ar-training/shared";
import { useCapture } from "./hooks/useCapture.ts";
import { useSession } from "./hooks/useSession.ts";
import { LandmarkOverlay } from "./components/LandmarkOverlay.tsx";
import { MfccSpectrogram } from "./components/MfccSpectrogram.tsx";

export function App() {
    const { capture, ready, videoRef } = useCapture();
    const {
        handler, state, lastMessage,
        sessionId, transcript, queuePos, clipScore,
        connect, disconnect,
    } = useSession(capture);

    // ── Capture start/stop ────────────────────────────────────────────────────
    const [capturing,   setCapturing]   = useState(false);
    const [captureError, setCaptureError] = useState<string | null>(null);

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

    const stopCapture = () => {
        capture.stop();
        setCapturing(false);
    };

    // ── Counters ──────────────────────────────────────────────────────────────
    const [frameCount, setFrameCount] = useState(0);
    const [chunkCount, setChunkCount] = useState(0);
    const [fps,        setFps]        = useState(0);

    // Latest MFCC frame for the spectrogram
    const [latestMfccs, setLatestMfccs] = useState<number[][]>([]);

    useEffect(() => {
        if (!capturing) return;
        let fc = 0, cc = 0;
        let cancelled = false;

        void (async () => {
            for await (const frame of capture.frames()) {
                if (cancelled) break;
                fc++;
                setFrameCount(fc);
                setFps(frame.frame_id > 0 ? Math.round(fc / frame.timestamp) : 0);
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

    // ── ClipEnded control ─────────────────────────────────────────────────────
    const [clipIdInput, setClipIdInput] = useState("");

    // ── Latest RawVideoFrame for overlay ─────────────────────────────────────
    const [latestFrame, setLatestFrame] = useState<{
        face_landmarks: { x: number; y: number; z: number; visibility: number }[];
        left_hand:      { x: number; y: number; z: number; visibility: number }[];
        right_hand:     { x: number; y: number; z: number; visibility: number }[];
    } | null>(null);

    useEffect(() => {
        if (!capturing) return;
        let cancelled = false;
        void (async () => {
            for await (const frame of capture.frames()) {
                if (cancelled) break;
                setLatestFrame(frame);
            }
        })();
        return () => { cancelled = true; };
    }, [capturing, capture]);

    // ── Last server message display ───────────────────────────────────────────
    const lastMsgRef = useRef<ServerMessage | null>(null);
    lastMsgRef.current = lastMessage;

    return (
        <div style={styles.root}>
            <h2 style={styles.heading}>AR Training — Debug Harness</h2>

            {/* ── Top row: video + spectrogram ──────────────────────────── */}
            <div style={styles.topRow}>
                {/* Video panel */}
                <div style={styles.videoPanel}>
                    <div style={styles.videoWrap}>
                        <video
                            ref={videoRef}
                            style={styles.video}
                            muted
                            playsInline
                        />
                        {showOverlay && capturing && latestFrame && (
                            <LandmarkOverlay
                                frame={latestFrame}
                                width={640}
                                height={480}
                            />
                        )}
                    </div>
                    <div style={styles.videoControls}>
                        <label style={styles.checkLabel}>
                            <input
                                type="checkbox"
                                checked={showVideo}
                                onChange={e => handleShowVideo(e.target.checked)}
                            />
                            {" "}Video
                        </label>
                        <label style={styles.checkLabel}>
                            <input
                                type="checkbox"
                                checked={showOverlay}
                                onChange={e => setShowOverlay(e.target.checked)}
                            />
                            {" "}Landmarks
                        </label>
                        <span style={styles.fpsTag}>
                            {capturing ? `${fps} fps` : "—"}
                        </span>
                    </div>
                </div>

                {/* MFCC spectrogram */}
                <div style={styles.spectrogramPanel}>
                    <div style={styles.panelLabel}>MFCC spectrogram</div>
                    <MfccSpectrogram mfccs={latestMfccs} />
                </div>
            </div>

            {/* ── Middle row: session status + counters ─────────────────── */}
            <div style={styles.statusRow}>
                <StatusBadge state={state} />
                <Kv k="Session ID"    v={sessionId   ?? "—"} />
                <Kv k="Queue pos"     v={queuePos !== null ? String(queuePos) : "—"} />
                <Kv k="Clip score"    v={clipScore !== null ? clipScore.toFixed(3) : "—"} />
                <Kv k="Frames sent"   v={String(frameCount)} />
                <Kv k="Chunks sent"   v={String(chunkCount)} />
            </div>

            {/* ── Transcript ────────────────────────────────────────────── */}
            <div style={styles.transcriptBox}>
                <span style={styles.panelLabel}>Live transcript </span>
                <span style={styles.transcriptText}>
                    {transcript || <em style={{ opacity: 0.4 }}>waiting…</em>}
                </span>
            </div>

            {/* ── Controls ──────────────────────────────────────────────── */}
            <div style={styles.controls}>
                {!capturing ? (
                    <button
                        style={styles.btn}
                        onClick={() => void startCapture()}
                        disabled={!ready}
                    >
                        {ready ? "Start capture" : "Loading models…"}
                    </button>
                ) : (
                    <button style={styles.btn} onClick={stopCapture}>
                        Stop capture
                    </button>
                )}

                {state === "idle" ? (
                    <button
                        style={styles.btn}
                        onClick={() => void connect()}
                        disabled={!capturing}
                    >
                        Connect session
                    </button>
                ) : (
                    <button style={{ ...styles.btn, ...styles.btnDanger }} onClick={disconnect}>
                        Disconnect
                    </button>
                )}

                <input
                    style={styles.input}
                    placeholder="clip_id"
                    value={clipIdInput}
                    onChange={e => setClipIdInput(e.target.value)}
                />
                <button
                    style={styles.btn}
                    disabled={state !== "active" || !clipIdInput.trim()}
                    onClick={() => {
                        handler.sendClipEnded(clipIdInput.trim());
                    }}
                >
                    Send ClipEnded
                </button>
            </div>

            {captureError && (
                <div style={styles.errorBox}>Capture error: {captureError}</div>
            )}

            {/* ── Last server message ───────────────────────────────────── */}
            <div style={styles.msgPanel}>
                <div style={styles.panelLabel}>Last server message</div>
                <pre style={styles.pre}>
                    {lastMessage
                        ? JSON.stringify(lastMessage, null, 2)
                        : "—"}
                </pre>
            </div>
        </div>
    );
}

// ─── Small sub-components ─────────────────────────────────────────────────────

function StatusBadge({ state }: { state: string }) {
    const colour: Record<string, string> = {
        idle:       "#555",
        connecting: "#e6a817",
        queued:     "#e6a817",
        active:     "#27ae60",
        paused:     "#2980b9",
        completed:  "#8e44ad",
        dropped:    "#e74c3c",
        error:      "#c0392b",
    };
    return (
        <span style={{
            ...styles.badge,
            background: colour[state] ?? "#555",
        }}>
            {state}
        </span>
    );
}

function Kv({ k, v }: { k: string; v: string }) {
    return (
        <span style={styles.kv}>
            <span style={styles.kvKey}>{k}</span>
            <span style={styles.kvVal}>{v}</span>
        </span>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
    root: {
        fontFamily:  "monospace",
        background:  "#1a1a1a",
        color:       "#e0e0e0",
        minHeight:   "100vh",
        padding:     "16px",
        boxSizing:   "border-box" as const,
    },
    heading: {
        margin:      "0 0 12px",
        fontSize:    "14px",
        fontWeight:  "bold" as const,
        color:       "#aaa",
        textTransform: "uppercase" as const,
        letterSpacing: "0.08em",
    },
    topRow: {
        display:     "flex",
        gap:         "16px",
        marginBottom: "12px",
        flexWrap:    "wrap" as const,
    },
    videoPanel: {
        display:     "flex",
        flexDirection: "column" as const,
        gap:         "6px",
    },
    videoWrap: {
        position:    "relative" as const,
        width:       "640px",
        height:      "480px",
        background:  "#000",
        flexShrink:  0,
    },
    video: {
        width:       "100%",
        height:      "100%",
        objectFit:   "cover" as const,
        display:     "block",
    },
    videoControls: {
        display:     "flex",
        alignItems:  "center",
        gap:         "12px",
    },
    checkLabel: {
        fontSize:    "12px",
        cursor:      "pointer",
    },
    fpsTag: {
        fontSize:    "12px",
        color:       "#aaa",
    },
    spectrogramPanel: {
        display:     "flex",
        flexDirection: "column" as const,
        gap:         "6px",
        flex:        1,
        minWidth:    "200px",
    },
    statusRow: {
        display:     "flex",
        alignItems:  "center",
        gap:         "12px",
        marginBottom: "8px",
        flexWrap:    "wrap" as const,
    },
    badge: {
        display:     "inline-block",
        padding:     "2px 10px",
        borderRadius: "4px",
        fontSize:    "12px",
        fontWeight:  "bold" as const,
        color:       "#fff",
        textTransform: "uppercase" as const,
        letterSpacing: "0.05em",
    },
    kv: {
        fontSize:    "12px",
        display:     "inline-flex",
        gap:         "4px",
    },
    kvKey: {
        color:       "#888",
    },
    kvVal: {
        color:       "#e0e0e0",
    },
    transcriptBox: {
        background:  "#252525",
        border:      "1px solid #333",
        borderRadius: "4px",
        padding:     "8px 10px",
        marginBottom: "10px",
        fontSize:    "12px",
        lineHeight:  "1.5",
    },
    transcriptText: {
        whiteSpace:  "pre-wrap" as const,
    },
    controls: {
        display:     "flex",
        gap:         "8px",
        alignItems:  "center",
        flexWrap:    "wrap" as const,
        marginBottom: "10px",
    },
    btn: {
        padding:     "5px 12px",
        fontSize:    "12px",
        cursor:      "pointer",
        background:  "#2c2c2c",
        color:       "#e0e0e0",
        border:      "1px solid #444",
        borderRadius: "4px",
    },
    btnDanger: {
        background:  "#4a1a1a",
        borderColor: "#822",
    },
    input: {
        padding:     "5px 8px",
        fontSize:    "12px",
        background:  "#2c2c2c",
        color:       "#e0e0e0",
        border:      "1px solid #444",
        borderRadius: "4px",
        width:       "140px",
    },
    errorBox: {
        background:  "#4a1a1a",
        border:      "1px solid #822",
        borderRadius: "4px",
        padding:     "6px 10px",
        fontSize:    "12px",
        color:       "#f88",
        marginBottom: "10px",
    },
    msgPanel: {
        background:  "#252525",
        border:      "1px solid #333",
        borderRadius: "4px",
        padding:     "8px 10px",
    },
    panelLabel: {
        fontSize:    "11px",
        color:       "#666",
        textTransform: "uppercase" as const,
        letterSpacing: "0.06em",
        marginBottom: "4px",
        display:     "block",
    },
    pre: {
        margin:      0,
        fontSize:    "11px",
        color:       "#b0c4de",
        whiteSpace:  "pre-wrap" as const,
        maxHeight:   "200px",
        overflowY:   "auto" as const,
    },
} as const;
