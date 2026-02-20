import type {ServerMessage, SessionState} from "@ar-training/shared"
import {CaptureSession} from "./capture.ts";
import {WebSocketTransport} from "./transport.ts";
import {useEffect, useRef, useState} from "react";

// ─── Config ───────────────────────────────────────────────────────────────────

const WS_BASE  = import.meta.env.VITE_APP_WS_URL   ?? "ws://localhost:8000";
const HTTP_BASE = import.meta.env.VITE_APP_HTTP_URL ?? "http://localhost:8000";

// Singletons — created once for the lifetime of the page
const capture   = new CaptureSession();
const transport = new WebSocketTransport(WS_BASE);

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
    const videoRef = useRef<HTMLVideoElement>(null);

    const [ready, setReady]                 = useState(false);
    const [sessionState, setSessionState]   = useState<SessionState>("idle");
    const [sessionId, setSessionId]         = useState<string | null>(null);
    const [escalationScore, setEscalation]  = useState<number | null>(null);
    const [frameCount, setFrameCount]       = useState(0);
    const [chunkCount, setChunkCount]       = useState(0);
    const [lastMessage, setLastMessage]     = useState<string>("");
    const [error, setError]                 = useState<string | null>(null);

    // ── Init MediaPipe on mount ────────────────────────────────────────────────

    useEffect(() => {
        capture.init()
            .then(() => setReady(true))
            .catch(err => setError(`MediaPipe init failed: ${err.message}`));
    }, []);

    // ── Wire transport → state ─────────────────────────────────────────────────

    useEffect(() => {
        transport.onMessage((msg: ServerMessage) => {
            setLastMessage(JSON.stringify(msg, null, 2));
            switch (msg.type) {
                case "session_update":
                    setEscalation(msg.escalation_score);
                    if (msg.queue_position != null) setSessionState("queued");
                    break;
                case "session_complete":
                    setSessionState("completed");
                    break;
                case "error":
                    setError(msg.message);
                    setSessionState("error");
                    break;
            }
        });

        transport.onStateChange(state => {
            if (state === "disconnected")   setSessionState(s => s === "idle" ? "idle" : "dropped");
            if (state === "error")          setSessionState("error");
        });
    }, []);

    // ── Session start ──────────────────────────────────────────────────────────

    const handleStart = async () => {
        if (!videoRef.current) return;

        setError(null);
        setSessionState("connecting");

        try {
            const res = await fetch(`${HTTP_BASE}/session/create`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    user_id: "dev-user",
                    scenario_id: "scenario_01",
                    language: "nl",
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.message ?? `HTTP status ${res.status}`);
            }

            const data = await res.json();
            const sid: string = data.session_id;
            setSessionId(sid);

            await transport.connect(sid);
            setSessionState("active");

            await capture.start({
                sessionId: sid,
                videoEl: videoRef.current,
                onFrame: (frame) => {
                    transport.sendFrame(frame);
                    setFrameCount(n => n + 1);
                },
                onAudio: (chunk) => {
                    transport.sendAudio(chunk);
                    setChunkCount(n => n + 1);
                },
                onError: (e) => {
                    setError(e.message);
                    setSessionState("error");
                },
            });
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setError(msg);
            setSessionState("error");
        }
    };

    // ── Session stop ───────────────────────────────────────────────────────────

    const handleStop = () => {
        capture.stop();
        transport.disconnect();
        setSessionState("idle");
        setSessionId(null);
        setEscalation(null);
        setFrameCount(0);
        setChunkCount(0);
        setLastMessage("");
    };

    // ── Render ─────────────────────────────────────────────────────────────────

    const isActive = sessionState === "active";

    return (
        <div style={styles.page}>
            <h1 style={styles.title}>AR Training — Dev Harness</h1>
            <p style={styles.subtitle}>
                {ready ? "✓ MediaPipe ready" : "⏳ Loading MediaPipe…"}
            </p>

            <video
                ref={videoRef}
                muted
                playsInline
                style={{ ...styles.video, borderColor: isActive ? "#10b981" : "#334155" }}
            />

            <div style={styles.controls}>
                <button
                    onClick={handleStart}
                    disabled={!ready || isActive}
                    style={btnStyle(!ready || isActive)}
                >
                    Start Session
                </button>
                <button
                    onClick={handleStop}
                    disabled={!isActive}
                    style={btnStyle(!isActive, true)}
                >
                    Stop Session
                </button>
            </div>

            <div style={styles.grid}>
                <Stat label="Session State"     value={sessionState}                          color={stateColor(sessionState)} />
                <Stat label="Session ID"        value={sessionId ? sessionId.slice(0, 8) + "…" : "—"} />
                <Stat label="Escalation Score"  value={escalationScore != null ? escalationScore.toFixed(3) : "—"} color={scoreColor(escalationScore)} />
                <Stat label="Frames Sent"       value={String(frameCount)} />
                <Stat label="Audio Chunks Sent" value={String(chunkCount)} />
            </div>

            {error && (
                <div style={styles.errorBanner}>⚠ {error}</div>
            )}

            {lastMessage && (
                <div style={styles.messageBox}>
                    <div style={styles.messageLabel}>LAST SERVER MESSAGE</div>
                    <pre style={styles.messagePre}>{lastMessage}</pre>
                </div>
            )}
        </div>
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Stat({ label, value, color = "#94a3b8" }: { label: string; value: string; color?: string }) {
    return (
        <div style={styles.stat}>
            <div style={styles.statLabel}>{label}</div>
            <div style={{ ...styles.statValue, color }}>{value}</div>
        </div>
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function btnStyle(disabled: boolean, danger = false): React.CSSProperties {
    const bg = disabled ? "#334155" : danger ? "#ef4444" : "#6366f1";
    return {
        padding: "8px 20px", borderRadius: 8, border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        background: bg, color: "#fff", fontSize: 13,
        fontWeight: "bold", opacity: disabled ? 0.5 : 1,
    };
}

function stateColor(s: SessionState): string {
    const map: Record<SessionState, string> = {
        idle: "#475569", connecting: "#f59e0b", queued: "#f59e0b",
        active: "#10b981", paused: "#6366f1", completed: "#10b981",
        dropped: "#ef4444", error: "#ef4444",
    };
    return map[s];
}

function scoreColor(s: number | null): string {
    if (s == null) return "#94a3b8";
    if (s < -0.3)  return "#10b981";  // de-escalating
    if (s >  0.3)  return "#ef4444";  // escalating
    return "#f59e0b";                  // neutral
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
    page:         { fontFamily: "monospace", background: "#0f0f1a", minHeight: "100vh", color: "#e2e8f0", padding: 24 } as React.CSSProperties,
    title:        { color: "#a5b4fc", marginBottom: 4 } as React.CSSProperties,
    subtitle:     { color: "#475569", marginBottom: 20, fontSize: 12 } as React.CSSProperties,
    video:        { width: 480, height: 360, borderRadius: 12, border: "2px solid", background: "#1e293b", display: "block", marginBottom: 16 } as React.CSSProperties,
    controls:     { display: "flex", gap: 12, marginBottom: 24 } as React.CSSProperties,
    grid:         { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 24, maxWidth: 720 } as React.CSSProperties,
    stat:         { background: "#1e293b", borderRadius: 8, padding: "10px 14px" } as React.CSSProperties,
    statLabel:    { color: "#475569", fontSize: 10, letterSpacing: 1, marginBottom: 4 } as React.CSSProperties,
    statValue:    { fontSize: 14, fontWeight: "bold" } as React.CSSProperties,
    errorBanner:  { background: "#450a0a", border: "1px solid #ef4444", borderRadius: 8, padding: 12, marginBottom: 16, color: "#fca5a5", maxWidth: 720 } as React.CSSProperties,
    messageBox:   { maxWidth: 720 } as React.CSSProperties,
    messageLabel: { color: "#475569", fontSize: 11, marginBottom: 4 } as React.CSSProperties,
    messagePre:   { background: "#1e293b", borderRadius: 8, padding: 12, fontSize: 11, color: "#94a3b8", overflow: "auto" } as React.CSSProperties,
} as const;