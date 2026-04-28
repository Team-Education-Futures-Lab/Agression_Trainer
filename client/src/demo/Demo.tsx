// =============================================================================
// Demo — Scenario flow
//
// Screen order:
//   LandingScreen    — idle / error
//   QueueScreen      — queued
//   ScenarioScreen   — connecting / selecting
//   PlayerScreen     — active
//   EvaluatingScreen — paused
//   DebriefScreen    — completed
//
// Timeouts:
//   Only applied to pure network round-trips (scenarios list, clip data) where
//   a 60-second silence genuinely means something is broken. NOT applied to AI
//   processing operations (evaluation, feedback generation) which have variable
//   latency and will complete when they complete.
//
// Capture lifecycle:
//   capture.start() is called when the student selects a scenario, not on
//   connect. capture.stop() is called on idle and completed.
//
// Webcam stream binding:
//   capture.start() binds the stream to the hidden video element. When
//   PlayerScreen mounts it re-binds the stream to its own video element via
//   the stream prop + useLayoutEffect inside PlayerScreen. This is necessary
//   because the shared videoRef DOM element changes between the hidden element
//   (all other screens) and the visible element inside PlayerScreen.
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

/**
 * Timeout for pure network round-trips only (scenarios list, clip data).
 * Not applied to AI operations (evaluation, feedback) which have variable
 * latency and will complete when they complete.
 */
const NETWORK_TIMEOUT_MS = 60_000;

/** Duration of the student response window after the clip video ends. */
const RESPONSE_DURATION_SECONDS = 30;

// ─── useStuckTimeout ─────────────────────────────────────────────────────────

function useStuckTimeout(condition: boolean, ms = NETWORK_TIMEOUT_MS): boolean {
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
    // The live MediaStream, captured after capture.start() so PlayerScreen can
    // re-bind it to its own video element when it mounts.
    const [liveStream, setLiveStream] = useState<MediaStream | null>(null);

    const preloadEls   = useRef<HTMLVideoElement[]>([]);
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
            preloadEls.current = [];
            msg.candidates.forEach(c => {
                const el = document.createElement("video");
                el.preload = "auto";
                el.src = c.video_url;
                preloadEls.current.push(el);
            });
        }
    };

    const {
        state, queuePos, scenarios, currentClipData, feedbackUnavailable,
        transcript,
        connect, disconnect, selectScenario, sendClipEnded,
    } = useSession(capture, { onMessage: handleMessage });

    // ── Timeout conditions — network round-trips only ─────────────────────────
    // Evaluation and feedback are AI operations with unbounded latency.
    // They must never be timed out client-side — only the server knows when
    // they are done. The server already has its own FEEDBACK_TIMEOUT_MS guard
    // and will send error{code:"feedback_unavailable"} if Ollama times out.
    const waitingForScenarios = (state === "connecting" || state === "selecting") && scenarios.length === 0;
    const waitingForClipData  = state === "active" && currentClipData === null;

    const scenariosTimedOut = useStuckTimeout(waitingForScenarios);
    const clipDataTimedOut  = useStuckTimeout(waitingForClipData);

    // ── Connect / select ──────────────────────────────────────────────────────
    const handleConnect = async () => {
        await connect();
    };

    const handleSelectScenario = async (sc: ScenarioSummary) => {
        if (videoRef.current) {
            await capture.start(videoRef.current);
            // Snapshot the stream so PlayerScreen can re-bind it to its own
            // video element when it mounts. Without this, the stream is bound
            // to the hidden 1×1 element and the visible webcam shows nothing.
            setLiveStream(capture.getStream());
        }
        selectScenario(sc.scenario_id, sc.entry_clip_id);
    };

    const handleRestart = () => {
        disconnect();
        setStreamedAdvice("");
        setFinalMessage(null);
        setLiveStream(null);
        preloadEls.current = [];
    };

    useEffect(() => {
        if (state === "idle" || state === "completed") {
            capture.stop();
            setLiveStream(null);
        }
    }, [state, capture]);

    // ─── Persistent hidden video element ──────────────────────────────────────
    // Rendered on every screen EXCEPT the active+clip-data branch where
    // PlayerScreen renders its own visible <video ref={videoRef}>.
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
        return <>{hiddenVideo}<QueueScreen queuePos={queuePos} onDisconnect={handleRestart} /></>;
    }

    if (state === "connecting" || state === "selecting") {
        if (scenariosTimedOut) {
            return <>{hiddenVideo}<TimeoutScreen
                message="De server reageerde niet op tijd. Controleer de verbinding en probeer het opnieuw."
                onDisconnect={handleRestart}
            /></>;
        }
        return <>{hiddenVideo}<ScenarioScreen scenarios={scenarios} onSelect={sc => void handleSelectScenario(sc)} /></>;
    }

    if (state === "completed" || finalMessage !== null) {
        // No client-side timeout for feedback. The server sends
        // error{code:"feedback_unavailable"} if Ollama cannot respond in time —
        // that is the correct and only signal to use.
        return <>{hiddenVideo}<DebriefScreen
            streamedAdvice={streamedAdvice}
            finalMessage={finalMessage}
            feedbackUnavailable={feedbackUnavailable}
            onRestart={handleRestart}
        /></>;
    }

    if (state === "paused") {
        // No client-side timeout for evaluation. The AI stack (Whisper + classifier)
        // takes as long as it takes. EvaluatingScreen waits until clip_selected arrives.
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
                stream={liveStream}
                currentClipId={currentClipData.clip_id}
                clipMeta={currentClipData}
                onClipEnded={sendClipEnded}
                responseDurationSeconds={RESPONSE_DURATION_SECONDS}
                liveTranscript={transcript}
            />;
        }
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