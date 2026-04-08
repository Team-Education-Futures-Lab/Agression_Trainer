// =============================================================================
// App — Debug Harness root (DebugHarness)
//
// Owns useCapture and useSession. Runs the high-frequency capture consumer
// loops and routes their output to imperative canvas handles rather than
// React state, so the rest of the tree never re-renders at frame rate.
//
// Update frequencies:
//   Frame rate (~30 fps) — overlay.draw(), spectrogram.push(), stats.update()
//   Discrete events      — DataColumn, SessionPanel (on server messages)
//   User interaction     — CapturePanel controls, SessionPanel inputs
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerMessage } from "@ar-training/shared";
import { useCapture }    from "./hooks/useCapture.ts";
import { useSession }    from "./hooks/useSession.ts";
import { CapturePanel }  from "./components/CapturePanel.tsx";
import { SessionPanel }  from "./components/SessionPanel.tsx";
import { DataColumn }    from "./components/DataColumn.tsx";
import type { CapturePanelHandles } from "./components/CapturePanel.tsx";
import type { LandmarkOverlayHandle } from "./components/LandmarkOverlay.tsx";
import type { MfccSpectrogramHandle } from "./components/MfccSpectrogram.tsx";
import type { CaptureStatsHandle }    from "./components/CaptureStats.tsx";

export function App() {
    const { capture, ready, videoRef } = useCapture();

    // ── Capture state (changes at most once per user interaction) ─────────────
    const [capturing,    setCapturing]    = useState(false);
    const [captureError, setCaptureError] = useState<string | null>(null);
    const [showOverlay,  setShowOverlay]  = useState(true);
    const [stream,       setStream]       = useState<MediaStream | null>(null);

    // ── Imperative handles for high-frequency canvas components ───────────────
    const overlayRef:     React.RefObject<LandmarkOverlayHandle | null> = useRef(null);
    const spectrogramRef: React.RefObject<MfccSpectrogramHandle | null> = useRef(null);
    const statsRef:       React.RefObject<CaptureStatsHandle | null>    = useRef(null);

    const capturePanelHandles: CapturePanelHandles = {
        overlay:     overlayRef,
        spectrogram: spectrogramRef,
        stats:       statsRef,
    };

    // ── Capture consumer loops ────────────────────────────────────────────────
    // Track frame/chunk counts in refs so both loops can read each other's
    // count without stale closures and without any React setState in the hot path.
    const frameCountRef  = useRef(0);
    const chunkCountRef  = useRef(0);
    // Ref mirror of showOverlay so the frame loop responds to toggle changes
    // without needing to restart when the boolean flips.
    const showOverlayRef = useRef(showOverlay);
    showOverlayRef.current = showOverlay;

    useEffect(() => {
        if (!capturing) {
            frameCountRef.current = 0;
            chunkCountRef.current = 0;
            statsRef.current?.reset();
            return;
        }
        let cancelled = false;

        void (async () => {
            for await (const f of capture.frames()) {
                if (cancelled) break;
                frameCountRef.current++;
                if (showOverlayRef.current) overlayRef.current?.draw(f);
                else                        overlayRef.current?.clear();
                const fps = f.frame_id > 0
                    ? Math.round(frameCountRef.current / f.timestamp)
                    : 0;
                statsRef.current?.update(frameCountRef.current, chunkCountRef.current, fps);
            }
        })();

        void (async () => {
            for await (const c of capture.audio()) {
                if (cancelled) break;
                chunkCountRef.current++;
                spectrogramRef.current?.push(c.mfccs);
                // Chunk count is picked up by the frame loop on the next tick
                // (via chunkCountRef.current) so no separate stats.update() call
                // is needed here. The frame loop runs at ~30 fps, far faster than
                // the ~0.5 fps audio chunk rate, so the displayed count stays current.
            }
        })();

        return () => { cancelled = true; };
        // showOverlay intentionally excluded — handled via showOverlayRef mirror.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [capturing, capture]);

    // ── Capture controls ──────────────────────────────────────────────────────
    const startCapture = useCallback(async () => {
        if (!videoRef.current) return;
        try {
            await capture.start(videoRef.current);
            frameCountRef.current = 0;
            chunkCountRef.current = 0;
            setStream(capture.getStream());
            setCapturing(true);
            setCaptureError(null);
        } catch (e) {
            setCaptureError(String(e));
        }
    }, [capture, videoRef]);

    const stopCapture = useCallback(() => {
        capture.stop();
        setCapturing(false);
        setStream(null);
        overlayRef.current?.clear();
        spectrogramRef.current?.clear();
        statsRef.current?.reset();
    }, [capture]);

    const handleShowVideoChange = useCallback((v: boolean) => {
        if (videoRef.current) videoRef.current.style.opacity = v ? "1" : "0";
    }, [videoRef]);

    // ── Session ───────────────────────────────────────────────────────────────
    // Collect the per-type message snapshots that DataColumn needs.
    type ClipSelectedMsg    = Extract<ServerMessage, { type: "clip_selected" }>;
    type ScenariosListMsg   = Extract<ServerMessage, { type: "scenarios_list" }>;
    type SessionCompleteMsg = Extract<ServerMessage, { type: "session_complete" }>;

    const [lastClipSelected,    setLastClipSelected]    = useState<ClipSelectedMsg | null>(null);
    const [lastScenariosList,   setLastScenariosList]   = useState<ScenariosListMsg | null>(null);
    const [lastSessionComplete, setLastSessionComplete] = useState<SessionCompleteMsg | null>(null);
    const [feedbackTokens,      setFeedbackTokens]      = useState("");
    const [errors,              setErrors]              = useState<string[]>([]);
    const errRef = useRef<string[]>([]);

    const onMessage = useCallback((msg: ServerMessage) => {
        switch (msg.type) {
            case "scenarios_list":   setLastScenariosList(msg);   break;
            case "clip_selected":    setLastClipSelected(msg);    break;
            case "session_complete":
                setLastSessionComplete(msg);
                setFeedbackTokens(""); // clear streaming buffer on complete
                break;
            case "feedback_token":
                setFeedbackTokens(prev => prev + msg.token);
                break;
            case "error": {
                const e = `[${new Date().toLocaleTimeString()}] [${msg.code}] ${msg.message}`;
                errRef.current = [e, ...errRef.current].slice(0, 20);
                setErrors([...errRef.current]);
                break;
            }
        }
    }, []);

    const {
        state, sessionId, transcript, queuePos, clipScore,
        scenarios, clipCandidates, currentClipData,
        feedbackUnavailable, sessionHistory, isAdmin,
        connect, disconnect, selectScenario, preloadClip, sendClipEnded,
    } = useSession(capture, { onMessage });

    // Clear per-session message snapshots on disconnect
    useEffect(() => {
        if (state === "idle") {
            setLastClipSelected(null);
            setLastScenariosList(null);
            setLastSessionComplete(null);
            setFeedbackTokens("");
            setErrors([]);
            errRef.current = [];
        }
    }, [state]);

    // ── Status bar ────────────────────────────────────────────────────────────
    const stateColor: Record<string, string> = {
        idle: "#555", connecting: "#e6a817", queued: "#e6a817",
        selecting: "#2980b9", active: "#27ae60", paused: "#2980b9",
        completed: "#8e44ad", dropped: "#e74c3c", error: "#c0392b",
    };

    return (
        <div style={st.root}>
            {/* Hidden capture video — persists for the lifetime of the page.
                Passed to capture.start() via videoRef. MediaPipe runs on this. */}
            <video
                ref={videoRef}
                muted
                playsInline
                style={{ position: "fixed", opacity: 0, pointerEvents: "none", width: 1, height: 1, top: 0, left: 0 }}
            />

            {/* Status bar */}
            <div style={st.statusBar}>
                <span style={st.appTitle}>AR Training — Debug Harness</span>
                <div style={st.statusItems}>
                    <span style={{ ...st.badge, background: stateColor[state] ?? "#555" }}>{state}</span>
                    {isAdmin && <span style={st.adminBadge}>ADMIN</span>}
                    <Kv k="Session" v={sessionId ?? "—"} />
                    <Kv k="Queue"   v={queuePos !== null ? String(queuePos) : "—"} />
                    <Kv k="Score"   v={clipScore !== null ? clipScore.toFixed(3) : "—"} />
                    {feedbackUnavailable && <span style={st.warnBadge}>feedback unavailable</span>}
                </div>
            </div>

            {/* Two-column body */}
            <div style={st.columns}>

                {/* Left column */}
                <div style={st.leftCol}>
                    <CapturePanel
                        stream={stream}
                        capturing={capturing}
                        ready={ready}
                        showOverlay={showOverlay}
                        onStartCapture={() => void startCapture()}
                        onStopCapture={stopCapture}
                        onShowVideoChange={handleShowVideoChange}
                        onShowOverlayChange={setShowOverlay}
                        captureError={captureError}
                        handles={capturePanelHandles}
                    />
                    <SessionPanel
                        state={state}
                        capturing={capturing}
                        sessionId={sessionId}
                        scenarios={scenarios}
                        currentClipData={currentClipData}
                        connect={connect}
                        disconnect={disconnect}
                        selectScenario={selectScenario}
                        preloadClip={preloadClip}
                        sendClipEnded={sendClipEnded}
                    />
                </div>

                {/* Right column */}
                <DataColumn
                    transcript={transcript}
                    currentClipData={currentClipData}
                    clipCandidates={clipCandidates}
                    lastClipSelected={lastClipSelected}
                    lastScenariosList={lastScenariosList}
                    lastSessionComplete={lastSessionComplete}
                    feedbackTokens={feedbackTokens}
                    errors={errors}
                    sessionHistory={sessionHistory}
                    isAdmin={isAdmin}
                    sessionState={state}
                    onSelectScenario={selectScenario}
                    onPreloadClip={preloadClip}
                />
            </div>
        </div>
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    root:        { fontFamily: "monospace", background: "#1a1a1a", color: "#e0e0e0", minHeight: "100vh", boxSizing: "border-box" as const },
    statusBar:   { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: "12px", padding: "8px 16px", background: "#111", borderBottom: "1px solid #333" },
    appTitle:    { fontSize: "12px", fontWeight: "bold" as const, color: "#666", textTransform: "uppercase" as const, letterSpacing: "0.08em" },
    statusItems: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" as const },
    columns:     { display: "grid", gridTemplateColumns: "660px 1fr", minHeight: "calc(100vh - 37px)" },
    leftCol:     { padding: "16px", borderRight: "1px solid #2a2a2a", display: "flex", flexDirection: "column" as const, gap: "12px" },
    badge:       { display: "inline-block", padding: "2px 10px", borderRadius: "4px", fontSize: "11px", fontWeight: "bold" as const, color: "#fff", textTransform: "uppercase" as const, letterSpacing: "0.05em" },
    adminBadge:  { display: "inline-block", padding: "2px 10px", borderRadius: "4px", fontSize: "11px", fontWeight: "bold" as const, background: "#3d2800", color: "#f5a623", border: "1px solid #7a5400", letterSpacing: "0.05em" },
    warnBadge:   { display: "inline-block", padding: "2px 10px", borderRadius: "4px", fontSize: "11px", background: "#7f1d1d", color: "#fca5a5" },
    kv:          { fontSize: "11px", display: "inline-flex", gap: "4px" },
    kvKey:       { color: "#666" },
    kvVal:       { color: "#e0e0e0" },
} as const;