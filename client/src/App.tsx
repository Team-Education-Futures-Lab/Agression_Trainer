import { useEffect, useRef, useState } from "react";
import { CaptureSession } from "./capture";
import { WebSocketTransport } from "./transport";
import { SessionHandler } from "./sessionHandler";
import type { SessionHandlerState } from "./sessionHandler";
import type { ServerMessage, SessionUpdate } from "@ar-training/shared";
import type { RawVideoFrame, RawAudioChunk } from "./types";
import DebugOverlay from "./DebugOverlay";

// ─── Config ───────────────────────────────────────────────────────────────────

const WS_BASE   = import.meta.env.VITE_APP_WS_URL   ?? "ws://localhost:8000";
const HTTP_BASE = import.meta.env.VITE_APP_HTTP_URL  ?? "http://localhost:8000";

// ─── Singletons ───────────────────────────────────────────────────────────────
// Created once for the lifetime of the page — not inside the component
// so they survive React re-renders.

const capture   = new CaptureSession();
const transport = new WebSocketTransport(WS_BASE);
const session   = new SessionHandler(transport, capture, {
    httpBase:   HTTP_BASE,
    userId:     "dev-user",
    scenarioId: "scenario_01",
    language:   "nl",
});

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
    const videoRef = useRef<HTMLVideoElement | null>(null);

    // Initialisation
    const [ready, setReady]   = useState(false);
    const [error, setError]   = useState<string | null>(null);

    // Session
    const [sessionState, setSessionState] = useState<SessionHandlerState>("idle");
    const [sessionId, setSessionId]       = useState<string | null>(null);
    const [lastMessage, setLastMessage]   = useState<ServerMessage | null>(null);

    const [showDebug, setShowDebug] = useState(false);

    // Capture metrics — for debug display
    const [frameCount, setFrameCount]   = useState(0);
    const [chunkCount, setChunkCount]   = useState(0);
    const [lastFrame, setLastFrame]     = useState<RawVideoFrame | null>(null);
    const [lastChunk, setLastChunk]     = useState<RawAudioChunk | null>(null);

    // ── Init MediaPipe + start capture on mount ────────────────────────────────

    useEffect(() => {
        if (!videoRef.current) return;
        const videoEl = videoRef.current;

        capture.init()
            .then(() => capture.start(videoEl))
            .then(() => {
                setReady(true);
                // Subscribe to capture streams for debug display only —
                // SessionHandler handles forwarding to transport separately
                consumeFrames();
                consumeAudio();
            })
            .catch(e => setError(`Capture init failed: ${e.message}`));

        return () => capture.stop();
    }, []);

    // ── Wire session state + messages ──────────────────────────────────────────

    useEffect(() => {
        session.onStateChange(state => {
            setSessionState(state);
            setSessionId(session.getSessionId());
        });
        session.onMessage(msg => setLastMessage(msg));
    }, []);

    // ── Debug consumers ────────────────────────────────────────────────────────
    // These run independently of the session — capture is always streaming.

    async function consumeFrames() {
        for await (const frame of capture.frames()) {
            setLastFrame(frame);
            setFrameCount(n => n + 1);
        }
    }

    async function consumeAudio() {
        for await (const chunk of capture.audio()) {
            setLastChunk(chunk);
            setChunkCount(n => n + 1);
        }
    }

    // ── Handlers ───────────────────────────────────────────────────────────────

    const handleConnect = async () => {
        setError(null);
        try {
            await session.connect();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    const handleDisconnect = () => session.disconnect();

    // ── Derived state ──────────────────────────────────────────────────────────

    const isActive     = sessionState === "active";
    const isConnecting = sessionState === "connecting" || sessionState === "queued";
    const escalation   = lastMessage?.type === "session_update"
        ? (lastMessage as SessionUpdate).escalation_score
        : null;

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
        <div style={s.page}>

            {/* Top bar */}
            <div style={s.topBar}>
                <span style={s.title}>AR Training</span>
                <span style={s.divider}>|</span>
                <span style={s.subtitle}>Development Harness</span>
                <div style={{ flex: 1 }} />
                <div style={s.stateDot(sessionState)} />
                <span style={{ ...s.stateLabel, color: stateColor(sessionState) }}>
          {sessionState.toUpperCase()}
        </span>
            </div>

            <div style={s.body}>

                {/* ── Left panel ── */}
                <div style={s.leftPanel}>

                    {/* Camera feeds */}
                    <Section title="CAMERA" color="#6366f1">
                        <div style={s.videoRow}>
                            <div style={s.videoPanel}>
                                <span style={s.panelLabel}>RAW</span>
                                <video
                                    ref={videoRef}
                                    muted
                                    playsInline
                                    style={s.video}
                                />
                            </div>
                            <div style={s.videoPanel}>
                                <span style={s.panelLabel}>LANDMARKS</span>
                                {/* DebugOverlay canvas goes here */}
                                <div style={{ ...s.video, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    <span style={{ color: "#334155", fontSize: 11 }}>overlay coming soon</span>
                                </div>
                            </div>
                        </div>
                    </Section>

                    {/* Controls */}
                    <Section title="CONTROLS" color="#ec4899">
                        <div style={s.controls}>
                            <Btn
                                label="Connect Session"
                                color="#10b981"
                                disabled={!ready || isActive || isConnecting}
                                onClick={handleConnect}
                            />
                            <Btn
                                label="Disconnect"
                                color="#ef4444"
                                disabled={!isActive && !isConnecting}
                                onClick={handleDisconnect}
                            />
                            <Btn
                                label={showDebug ? "Hide Debug" : "Show Debug"}
                                color="#334155"
                                disabled={false}
                                onClick={() => setShowDebug(v => !v)}
                            />
                        </div>
                        {error && <div style={s.errorBanner}>⚠ {error}</div>}
                    </Section>

                </div>

                {/* ── Right panel ── */}
                <div style={s.rightPanel}>

                    {/* Session stats */}
                    <Section title="SESSION" color="#10b981">
                        <div style={s.grid}>
                            <Badge label="SESSION ID"    value={sessionId ? sessionId.slice(0, 8) + "…" : "—"} mono />
                            <Badge label="ESCALATION"    value={escalation != null ? escalation.toFixed(3) : "—"} color={scoreColor(escalation)} />
                            <Badge label="FRAMES SENT"   value={frameCount.toLocaleString()} />
                            <Badge label="CHUNKS SENT"   value={chunkCount.toLocaleString()} />
                        </div>
                    </Section>

                    {/* Capture stats */}
                    <Section title="CAPTURE" color="#0ea5e9">
                        <div style={s.grid}>
                            <Badge label="FACE LANDMARKS" value={lastFrame ? String(lastFrame.face_landmarks.length) : "—"} />
                            <Badge label="LEFT HAND"      value={lastFrame ? (lastFrame.left_hand.length > 0 ? "detected" : "none") : "—"} />
                            <Badge label="RIGHT HAND"     value={lastFrame ? (lastFrame.right_hand.length > 0 ? "detected" : "none") : "—"} />
                            <Badge label="MFCC FRAMES"    value={lastChunk ? String(lastChunk.mfccs.length) : "—"} />
                        </div>
                    </Section>

                    {/* Last server message */}
                    <Section title="LAST SERVER MESSAGE" color="#f59e0b">
            <pre style={s.pre}>
              {lastMessage ? JSON.stringify(lastMessage, null, 2) : "—"}
            </pre>
                    </Section>

                </div>
            </div>

            {showDebug && (
                <div style={{ padding: "0 20px 20px" }}>
                    <DebugOverlay capture={capture} />
                </div>
            )}
        </div>
    );
}

// ─── Small components ─────────────────────────────────────────────────────────

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <div style={{ width: 3, height: 12, background: color, borderRadius: 2 }} />
                <span style={{ color: "#475569", fontSize: 10, letterSpacing: 2 }}>{title}</span>
            </div>
            {children}
        </div>
    );
}

function Badge({ label, value, color = "#94a3b8", mono = false }: { label: string; value: string; color?: string; mono?: boolean }) {
    return (
        <div style={{ background: "#1e293b", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ color: "#475569", fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>{label}</div>
            <div style={{ color, fontSize: 13, fontWeight: "bold", fontFamily: mono ? "monospace" : "inherit" }}>{value}</div>
        </div>
    );
}

function Btn({ label, color, disabled, onClick }: { label: string; color: string; disabled: boolean; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            style={{
                flex: 1, padding: "8px 0", borderRadius: 8, border: "none",
                background: disabled ? "#1e293b" : color,
                color: disabled ? "#475569" : "#fff",
                fontSize: 12, fontWeight: "bold", cursor: disabled ? "not-allowed" : "pointer",
                fontFamily: "monospace",
            }}
        >
            {label}
        </button>
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stateColor(s: SessionHandlerState): string {
    const map: Record<SessionHandlerState, string> = {
        idle: "#475569", connecting: "#f59e0b", queued: "#f59e0b",
        active: "#10b981", completed: "#10b981", dropped: "#ef4444", error: "#ef4444",
    };
    return map[s];
}

function scoreColor(s: number | null): string {
    if (s == null) return "#94a3b8";
    if (s < -0.3)  return "#10b981";
    if (s >  0.3)  return "#ef4444";
    return "#f59e0b";
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
    page:       { fontFamily: "monospace", background: "#0f0f1a", minHeight: "100vh", color: "#e2e8f0", display: "flex", flexDirection: "column" } as React.CSSProperties,
    topBar:     { background: "#0c1221", borderBottom: "1px solid #1e293b", padding: "10px 20px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 } as React.CSSProperties,
    title:      { color: "#6366f1", fontWeight: "bold", fontSize: 14 } as React.CSSProperties,
    divider:    { color: "#334155" } as React.CSSProperties,
    subtitle:   { color: "#475569", fontSize: 11 } as React.CSSProperties,
    stateLabel: { fontSize: 12 } as React.CSSProperties,
    stateDot:   (state: SessionHandlerState): React.CSSProperties => ({
        width: 8, height: 8, borderRadius: "50%", background: stateColor(state),
    }),
    body:       { display: "flex", flex: 1, overflow: "hidden" } as React.CSSProperties,
    leftPanel:  { width: 500, borderRight: "1px solid #1e293b", padding: 20, flexShrink: 0, overflowY: "auto" } as React.CSSProperties,
    rightPanel: { flex: 1, padding: 20, overflowY: "auto" } as React.CSSProperties,
    videoRow:   { display: "flex", gap: 8 } as React.CSSProperties,
    videoPanel: { flex: 1, display: "flex", flexDirection: "column", gap: 6 } as React.CSSProperties,
    panelLabel: { color: "#334155", fontSize: 10 } as React.CSSProperties,
    video:      { width: "100%", aspectRatio: "4/3", borderRadius: 8, background: "#0c1221", border: "1px solid #1e293b", display: "block" } as React.CSSProperties,
    controls:   { display: "flex", gap: 8 } as React.CSSProperties,
    errorBanner:{ background: "#450a0a", border: "1px solid #ef4444", borderRadius: 8, padding: 10, marginTop: 8, color: "#fca5a5", fontSize: 12 } as React.CSSProperties,
    grid:       { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } as React.CSSProperties,
    pre:        { background: "#0c1221", border: "1px solid #1e293b", borderRadius: 8, padding: 12, fontSize: 11, color: "#94a3b8", overflow: "auto", margin: 0 } as React.CSSProperties,
} as const;
