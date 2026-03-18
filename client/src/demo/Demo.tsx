// =============================================================================
// Demo — Scenario flow
//
// Screen order:
//   LandingScreen   — idle / error
//   QueueScreen     — queued
//   ScenarioScreen  — selecting (connected, scenarios loaded, no choice yet)
//   PlayerScreen    — active (clip loaded and playing)
//   EvaluatingScreen — paused (clip ended, waiting for clip_selected)
//   DebriefScreen   — completed
// =============================================================================

import { useEffect, useRef, useState } from "react";
import type { SessionComplete, ServerMessage, ScenarioSummary } from "@ar-training/shared";
import { useCapture }        from "../hooks/useCapture.ts";
import { useSession }        from "../hooks/useSession.ts";
import { LandingScreen }     from "./screens/LandingScreen.tsx";
import { QueueScreen }       from "./screens/QueueScreen.tsx";
import { ScenarioScreen }    from "./screens/ScenarioScreen.tsx";
import { PlayerScreen }      from "./screens/PlayerScreen.tsx";
import { EvaluatingScreen }  from "./screens/EvaluatingScreen.tsx";
import { DebriefScreen }     from "./screens/DebriefScreen.tsx";

const styleEl = document.createElement("style");
styleEl.textContent = `
    @keyframes spin   { to { transform: rotate(360deg); } }
    @keyframes bounce { to { transform: scaleY(2.2); } }
    @keyframes blink  { 50% { opacity: 0; } }
`;
document.head.appendChild(styleEl);

export function Demo() {
    const { capture, ready, videoRef } = useCapture();

    const [streamedAdvice,  setStreamedAdvice]  = useState("");
    const [finalMessage,    setFinalMessage]    = useState<SessionComplete | null>(null);

    const demoStateRef = useRef({ finalMessage });
    demoStateRef.current = { finalMessage };

    const handleMessage = (msg: ServerMessage) => {
        if (msg.type === "feedback_token") {
            setStreamedAdvice(prev => prev + msg.token);
        }
        if (msg.type === "session_complete" && demoStateRef.current.finalMessage === null) {
            setFinalMessage(msg);
        }
        // Preload candidate clips in the background when clip_candidates arrives.
        if (msg.type === "clip_candidates") {
            msg.candidates.forEach(c => {
                const link = document.createElement("link");
                link.rel  = "preload";
                link.as   = "video";
                link.href = c.video_url;
                document.head.appendChild(link);
            });
        }
    };

    const {
        state, queuePos, scenarios, currentClipData, feedbackUnavailable,
        connect, disconnect, selectScenario, preloadClip, sendClipEnded,
    } = useSession(capture, { onMessage: handleMessage });

    // ── Connect (called from LandingScreen) ───────────────────────────────────
    const handleConnect = async () => {
        // Start capture immediately so MediaPipe warms up while the user reads
        // the scenario list. Capture does not send data until selectScenario()
        // transitions the session to active.
        if (videoRef.current) await capture.start(videoRef.current);
        await connect();
    };

    // ── Scenario selection ────────────────────────────────────────────────────
    const handleSelectScenario = (sc: ScenarioSummary) => {
        selectScenario(sc.scenario_id, sc.entry_clip_id);
    };

    // ── Clip ended ────────────────────────────────────────────────────────────
    const handleClipEnded = (clipId: string) => {
        sendClipEnded(clipId);
    };

    // ── Preload next candidates ────────────────────────────────────────────────
    // When clip_data arrives for a non-activating request (preload), we don't
    // need to do anything extra — preloadClip() is called from the debug harness
    // or anywhere callers want to prefetch. The browser handles caching.
    void preloadClip; // acknowledge the import; used via selectScenario internally

    // ── Restart ───────────────────────────────────────────────────────────────
    const handleRestart = () => {
        disconnect();
        setStreamedAdvice("");
        setFinalMessage(null);
    };

    // ── Capture cleanup on error / disconnect ─────────────────────────────────
    useEffect(() => {
        if (state === "idle") {
            capture.stop();
        }
    }, [state, capture]);

    // ─── Persistent hidden video element ─────────────────────────────────────
    // The <video> element is kept mounted for the entire session so srcObject
    // binding is never broken. PlayerScreen renders it in-place via the ref;
    // all other screens see only the hidden copy below.
    const hiddenVideo = (
        <video
            ref={videoRef}
            muted
            playsInline
            style={{ position: "fixed", opacity: 0, pointerEvents: "none", width: 1, height: 1, top: 0, left: 0 }}
        />
    );

    // ─── Screen selection ─────────────────────────────────────────────────────

    if (state === "idle" || state === "error") {
        return (
            <>{hiddenVideo}
                <LandingScreen ready={ready} onConnect={handleConnect} />
            </>
        );
    }

    if (state === "queued") {
        return <>{hiddenVideo}<QueueScreen queuePos={queuePos} /></>;
    }

    if (state === "selecting" || state === "connecting") {
        // "connecting" covers the brief window between session_ready and
        // scenarios_list arriving. Show the scenario screen with an empty list;
        // it displays a loading message until scenarios populate.
        return (
            <>{hiddenVideo}
                <ScenarioScreen scenarios={scenarios} onSelect={handleSelectScenario} />
            </>
        );
    }

    if (state === "completed" || finalMessage !== null) {
        return (
            <>{hiddenVideo}
                <DebriefScreen
                    streamedAdvice={streamedAdvice}
                    finalMessage={finalMessage}
                    feedbackUnavailable={feedbackUnavailable}
                    onRestart={handleRestart}
                />
            </>
        );
    }

    if (state === "paused") {
        return <>{hiddenVideo}<EvaluatingScreen /></>;
    }

    if (state === "active" && currentClipData !== null) {
        return (
            <PlayerScreen
                videoRef={videoRef}
                currentClipId={currentClipData.clip_id}
                clipMeta={currentClipData}
                onClipEnded={handleClipEnded}
            />
        );
    }

    // active but clip_data not yet arrived — transitional
    return (
        <>{hiddenVideo}
            <div style={loadingStyle}>
                <p style={{ color: "#94a3b8", fontFamily: "sans-serif" }}>Clip laden…</p>
            </div>
        </>
    );
}

const loadingStyle: React.CSSProperties = {
    minHeight: "100vh", display: "flex",
    alignItems: "center", justifyContent: "center",
    background: "#0f172a",
};