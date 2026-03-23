// =============================================================================
// Demo — Scenario flow
//
// Screen order:
//   LandingScreen    — idle / error
//   QueueScreen      — queued
//   ScenarioScreen   — selecting (connected, scenarios loaded, awaiting choice)
//   PlayerScreen     — active (clip loaded and playing)
//   EvaluatingScreen — paused (clip ended, waiting for clip_selected)
//   DebriefScreen    — completed
//
// Every state that depends on a server response has a timeout. If the expected
// message does not arrive within RESPONSE_TIMEOUT_MS, an inline error is shown
// with a disconnect button so the user is never stuck indefinitely.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import type { SessionComplete, ServerMessage, ScenarioSummary } from "@ar-training/shared";
import { useCapture }       from "../hooks/useCapture.ts";
import { useSession }       from "../hooks/useSession.ts";
import { LandingScreen }    from "./screens/LandingScreen.tsx";
import { QueueScreen }      from "./screens/QueueScreen.tsx";
import { ScenarioScreen }   from "./screens/ScenarioScreen.tsx";
import { PlayerScreen }     from "./screens/PlayerScreen.tsx";
import { EvaluatingScreen } from "./screens/EvaluatingScreen.tsx";
import { DebriefScreen }    from "./screens/DebriefScreen.tsx";

const styleEl = document.createElement("style");
styleEl.textContent = `
    @keyframes spin   { to { transform: rotate(360deg); } }
    @keyframes bounce { to { transform: scaleY(2.2); } }
    @keyframes blink  { 50% { opacity: 0; } }
`;
document.head.appendChild(styleEl);

/** After this many ms without the expected response, show the timeout screen. */
const RESPONSE_TIMEOUT_MS = 15_000;

// ─── useStuckTimeout ─────────────────────────────────────────────────────────
// Returns true when the given condition has been true for longer than the
// threshold without being cleared. `condition` going false resets the timer.

function useStuckTimeout(condition: boolean, ms = RESPONSE_TIMEOUT_MS): boolean {
    const [stuck, setStuck] = useState(false);
    useEffect(() => {
        if (!condition) { setStuck(false); return; }
        const id = setTimeout(() => setStuck(true), ms);
        return () => clearTimeout(id);
    }, [condition, ms]);
    return stuck;
}

// ─── TimeoutScreen ────────────────────────────────────────────────────────────

function TimeoutScreen({ message, onDisconnect }: { message: string; onDisconnect: () => void }) {
    return (
        <div style={ts.root}>
            <div style={ts.card}>
                <p style={ts.icon}>⚠</p>
                <h2 style={ts.title}>Er ging iets mis</h2>
                <p style={ts.body}>{message}</p>
                <button style={ts.btn} onClick={onDisconnect}>Opnieuw proberen</button>
            </div>
        </div>
    );
}

const ts = {
    root:  { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f172a", padding: "24px" },
    card:  { maxWidth: "400px", width: "100%", background: "#1e293b", borderRadius: "12px", padding: "36px", textAlign: "center" as const, boxShadow: "0 8px 32px rgba(0,0,0,0.4)" },
    icon:  { margin: "0 0 12px", fontSize: "32px" },
    title: { margin: "0 0 12px", fontSize: "20px", fontWeight: "600" as const, color: "#f1f5f9" },
    body:  { margin: "0 0 24px", fontSize: "14px", color: "#94a3b8", lineHeight: 1.6 },
    btn:   { width: "100%", padding: "12px", fontSize: "15px", fontWeight: "600" as const, background: "#6366f1", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" },
} as const;

// ─── Demo ─────────────────────────────────────────────────────────────────────

export function Demo() {
    const { capture, ready, videoRef } = useCapture();

    const [streamedAdvice, setStreamedAdvice] = useState("");
    const [finalMessage,   setFinalMessage]   = useState<SessionComplete | null>(null);

    const demoStateRef = useRef({ finalMessage });
    demoStateRef.current = { finalMessage };

    const handleMessage = (msg: ServerMessage) => {
        if (msg.type === "feedback_token") {
            setStreamedAdvice(prev => prev + msg.token);
        }
        if (msg.type === "session_complete" && demoStateRef.current.finalMessage === null) {
            setFinalMessage(msg);
        }
        if (msg.type === "clip_candidates") {
            msg.candidates.forEach(c => {
                const link = document.createElement("link");
                link.rel = "preload"; link.as = "video"; link.href = c.video_url;
                document.head.appendChild(link);
            });
        }
    };

    const {
        state, queuePos, scenarios, currentClipData, feedbackUnavailable,
        connect, disconnect, selectScenario, sendClipEnded,
    } = useSession(capture, { onMessage: handleMessage });

    // ── Timeout conditions ────────────────────────────────────────────────────
    // Each boolean is true only while we are waiting for a specific response.
    const waitingForScenarios = (state === "connecting" || state === "selecting") && scenarios.length === 0;
    const waitingForClipData  = state === "active" && currentClipData === null;
    const waitingForEval      = state === "paused";
    const waitingForFeedback  = state === "completed" && finalMessage === null && !feedbackUnavailable;

    const scenariosTimedOut = useStuckTimeout(waitingForScenarios);
    const clipDataTimedOut  = useStuckTimeout(waitingForClipData);
    const evalTimedOut      = useStuckTimeout(waitingForEval);
    const feedbackTimedOut  = useStuckTimeout(waitingForFeedback);

    // ── Connect ───────────────────────────────────────────────────────────────
    const handleConnect = async () => {
        if (videoRef.current) await capture.start(videoRef.current);
        await connect();
    };

    const handleSelectScenario = (sc: ScenarioSummary) => {
        selectScenario(sc.scenario_id, sc.entry_clip_id);
    };

    const handleRestart = () => {
        disconnect();
        setStreamedAdvice("");
        setFinalMessage(null);
    };

    useEffect(() => {
        if (state === "idle") capture.stop();
    }, [state, capture]);

    // ─── Persistent hidden video element ──────────────────────────────────────
    const hiddenVideo = (
        <video ref={videoRef} muted playsInline
               style={{ position: "fixed", opacity: 0, pointerEvents: "none", width: 1, height: 1, top: 0, left: 0 }}
        />
    );

    // ─── Screen selection ─────────────────────────────────────────────────────

    if (state === "idle" || state === "error") {
        return <>{hiddenVideo}<LandingScreen ready={ready} onConnect={handleConnect} /></>;
    }

    if (state === "queued") {
        return <>{hiddenVideo}<QueueScreen queuePos={queuePos} /></>;
    }

    if (state === "connecting" || state === "selecting") {
        if (scenariosTimedOut) {
            return <>{hiddenVideo}<TimeoutScreen
                message="De server reageerde niet op tijd. Controleer de verbinding en probeer het opnieuw."
                onDisconnect={handleRestart}
            /></>;
        }
        return <>{hiddenVideo}<ScenarioScreen scenarios={scenarios} onSelect={handleSelectScenario} /></>;
    }

    if (state === "completed" || finalMessage !== null) {
        return <>{hiddenVideo}<DebriefScreen
            streamedAdvice={streamedAdvice}
            finalMessage={finalMessage}
            feedbackUnavailable={feedbackUnavailable || feedbackTimedOut}
            onRestart={handleRestart}
        /></>;
    }

    if (state === "paused") {
        if (evalTimedOut) {
            return <>{hiddenVideo}<TimeoutScreen
                message="De analyse duurde te lang. Mogelijk is er een probleem met de evaluatieservice."
                onDisconnect={handleRestart}
            /></>;
        }
        return <>{hiddenVideo}<EvaluatingScreen /></>;
    }

    if (state === "active") {
        if (clipDataTimedOut) {
            return <>{hiddenVideo}<TimeoutScreen
                message="De clipgegevens kwamen niet aan. Controleer of de scenario's correct zijn geconfigureerd."
                onDisconnect={handleRestart}
            /></>;
        }
        if (currentClipData !== null) {
            return <PlayerScreen
                videoRef={videoRef}
                currentClipId={currentClipData.clip_id}
                clipMeta={currentClipData}
                onClipEnded={sendClipEnded}
            />;
        }
        // clip_data not yet arrived — transitional, timeout guard above handles the hang
        return <>{hiddenVideo}
            <div style={loadingStyle}>
                <p style={{ color: "#94a3b8", fontFamily: "sans-serif" }}>Clip laden…</p>
            </div>
        </>;
    }

    return null;
}

const loadingStyle: React.CSSProperties = {
    minHeight: "100vh", display: "flex",
    alignItems: "center", justifyContent: "center",
    background: "#0f172a",
};