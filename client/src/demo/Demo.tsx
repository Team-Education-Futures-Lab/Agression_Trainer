// =============================================================================
// Demo — Scenario flow
//
// Minimal walkthrough of the full session flow. Screen transitions are driven
// entirely by sessionHandler.state and the most recent ServerMessage.
// =============================================================================

import { useRef, useState } from "react";
import type { SessionComplete, ServerMessage } from "@ar-training/shared";
import { useCapture } from "../hooks/useCapture.ts";
import { useSession } from "../hooks/useSession.ts";
import { LandingScreen }    from "./screens/LandingScreen.tsx";
import { QueueScreen }      from "./screens/QueueScreen.tsx";
import { PlayerScreen }     from "./screens/PlayerScreen.tsx";
import { EvaluatingScreen } from "./screens/EvaluatingScreen.tsx";
import { DebriefScreen }    from "./screens/DebriefScreen.tsx";

// Inject keyframe animations used by child screens.
const styleEl = document.createElement("style");
styleEl.textContent = `
    @keyframes spin   { to { transform: rotate(360deg); } }
    @keyframes bounce { to { transform: scaleY(2.2); } }
    @keyframes blink  { 50% { opacity: 0; } }
`;
document.head.appendChild(styleEl);

export function Demo() {
    const { capture, ready, videoRef } = useCapture();
    const [currentClipId,  setCurrentClipId]  = useState<string | null>(null);
    const [streamedAdvice, setStreamedAdvice] = useState("");
    const [finalMessage,   setFinalMessage]   = useState<SessionComplete | null>(null);

    // Stable ref so the onMessage callback never goes stale
    const demoStateRef = useRef({ streamedAdvice, finalMessage });
    demoStateRef.current = { streamedAdvice, finalMessage };

    const handleMessage = (msg: ServerMessage) => {
        if (msg.type === "clip_ready" && msg.next_clip_id !== null) {
            setCurrentClipId(msg.next_clip_id);
        }
        if (msg.type === "feedback_token") {
            setStreamedAdvice(prev => prev + msg.token);
        }
        if (msg.type === "session_complete" && demoStateRef.current.finalMessage === null) {
            setFinalMessage(msg);
        }
    };

    const { handler, state, queuePos, connect } = useSession(capture, {
        onMessage: handleMessage,
    });

    const handleConnect = async () => {
        if (videoRef.current) await capture.start(videoRef.current);
        await connect();
    };

    const handleClipEnded = (clipId: string) => {
        handler.sendClipEnded(clipId);
    };

    const handleRestart = () => {
        handler.disconnect();
        setStreamedAdvice("");
        setFinalMessage(null);
        setCurrentClipId(null);
    };

    // ── Screen selection ──────────────────────────────────────────────────────
    // The <video> element must persist across screen transitions — capture.start()
    // binds the MediaStream to it once and it must stay mounted.
    const videoEl = (
        <video
            ref={videoRef}
            muted
            playsInline
            style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
        />
    );

    if (state === "idle" || state === "error") {
        return (
            <>
                {videoEl}
                <LandingScreen
                    ready={ready}
                    onConnect={handleConnect}
                />
            </>
        );
    }

    if (state === "queued") {
        return <>{videoEl}<QueueScreen queuePos={queuePos} /></>;
    }

    if (state === "completed" || finalMessage !== null) {
        return (
            <>{videoEl}
                <DebriefScreen
                    streamedAdvice={streamedAdvice}
                    finalMessage={finalMessage}
                    onRestart={handleRestart}
                />
            </>
        );
    }

    if (state === "paused") {
        return <>{videoEl}<EvaluatingScreen /></>;
    }

    if (currentClipId !== null) {
        return (
            <PlayerScreen
                videoRef={videoRef}
                currentClipId={currentClipId}
                onClipEnded={handleClipEnded}
            />
        );
    }

    // connecting — no clip assigned yet
    return (
        <>{videoEl}
            <div style={loadingStyle}>
                <p style={{ color: "#94a3b8", fontFamily: "sans-serif" }}>Verbinding maken…</p>
            </div>
        </>
    );
}

const loadingStyle: React.CSSProperties = {
    minHeight:      "100vh",
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    background:     "#0f172a",
};
