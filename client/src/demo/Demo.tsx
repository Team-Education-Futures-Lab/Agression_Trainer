import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { CaptureSession } from "../capture";
import { WebSocketTransport } from "../transport";
import { SessionHandler } from "../sessionHandler";
import {
    LandingScreen,
    ScenarioPlayerScreen,
    EvaluatingScreen,
    DebriefScreen,
    QueueScreen,
} from "./screens";

// ─── Config ───────────────────────────────────────────────────────────────────

const WS_BASE    = import.meta.env.VITE_APP_WS_URL  ?? "ws://localhost:3001";
const HTTP_BASE  = import.meta.env.VITE_APP_HTTP_URL ?? "http://localhost:3001";
const VIDEO_BASE = import.meta.env.VITE_VIDEO_BASE   ?? "/scenarios/scenario_01";

// Entry clip for scenario_01. The App container does not return this in
// CreateSessionResponse — it is fixed by the scenario metadata.
const ENTRY_CLIP = "clip_01_intro";

// ─── Singletons ───────────────────────────────────────────────────────────────
// One set of instances for the page lifetime.
// On restart, disconnect() + capture.stop() resets their internal state;
// subsequent connect() + capture.start() reuses the same objects cleanly.

const capture   = new CaptureSession();
const transport = new WebSocketTransport(WS_BASE);
const session   = new SessionHandler(transport, capture, {
    httpBase:   HTTP_BASE,
    userId:     `student-${Math.random().toString(36).slice(2, 9)}`,
    scenarioId: "scenario_01",
    language:   "nl",
});

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen = "landing" | "queue" | "player" | "evaluating" | "debrief";

interface DebriefData {
    advice:     string;
    severity:   "low" | "medium" | "high";
    highlights: string[];
}

// ─── Demo ─────────────────────────────────────────────────────────────────────

export default function Demo() {
    const [screen,    setScreen]    = useState<Screen>("landing");
    const [error,     setError]     = useState<string | null>(null);
    const [clipId,    setClipId]    = useState(ENTRY_CLIP);
    const [clipNum,   setClipNum]   = useState(1);
    const [queuePos,  setQueuePos]  = useState(1);
    const [debrief,   setDebrief]   = useState<DebriefData | null>(null);

    // Hidden video element that MediaPipe drives its detection loop against.
    // CaptureSession requires a <video> to call detectForVideo(); we don't
    // show this to the user — ScenarioPlayerScreen shows its own inset via
    // capture.getStream() directly.
    const dummyVideoRef = useRef<HTMLVideoElement | null>(null);

    // ── Wire callbacks once ────────────────────────────────────────────────────
    // Registered once at mount. onStateChange / onMessage / onQueuePosition each
    // store a single callback on the singleton, so calling them again on re-render
    // would silently replace the handler. We prevent that with an empty dep array.

    useEffect(() => {
        session.onStateChange(state => {
            if (state === "queued") {
                setScreen("queue");
            }
            if (state === "active") {
                // Session is open and frame/audio loops are running.
                // Show the player for the entry clip.
                setClipId(ENTRY_CLIP);
                setClipNum(1);
                setScreen("player");
            }
            if (state === "dropped" || state === "error") {
                setError("Verbinding verbroken. Probeer de sessie opnieuw te starten.");
            }
        });

        session.onQueuePosition(pos => setQueuePos(pos));

        session.onMessage(msg => {
            switch (msg.type) {

                // App sent us the result of clip evaluation and the next clip to play.
                case "clip_ready": {
                    if (msg.next_clip_id === null) {
                        // Terminal clip — scenario complete. Stay on the evaluating
                        // screen; SessionComplete will arrive shortly and move us on.
                        setScreen("evaluating");
                    } else {
                        setClipId(msg.next_clip_id);
                        setClipNum(n => n + 1);
                        setScreen("player");
                    }
                    break;
                }

                // Streaming tokens from the Feedback container — nothing to render
                // yet, we wait for the full SessionComplete to show the debrief.
                case "feedback_token":
                    break;

                // Full debrief — transition to the debrief screen.
                case "session_complete": {
                    setDebrief({
                        advice:     msg.advice,
                        severity:   msg.severity,
                        highlights: msg.highlights,
                    });
                    setScreen("debrief");
                    break;
                }

                // App signalled a recoverable or fatal error.
                case "error": {
                    setError(`${msg.code}: ${msg.message}`);
                    break;
                }

                // session_update carries a debug transcript — intentionally ignored.
            }
        });

        return () => {
            // Clean up capture on unmount. In practice this component never
            // unmounts during a normal session, but we want to be tidy.
            capture.stop();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Handlers ──────────────────────────────────────────────────────────────

    const handleStart = async () => {
        setError(null);

        // Initialise MediaPipe models and request camera/mic permission.
        // Must happen inside a user-gesture handler so the permission prompt
        // appears in a direct gesture context (required by some browsers).
        try {
            if (!dummyVideoRef.current) {
                const v = document.createElement("video");
                v.muted = true;
                v.style.cssText = "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px";
                document.body.appendChild(v);
                dummyVideoRef.current = v;
            }
            await capture.init();
            await capture.start(dummyVideoRef.current);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
            return;
        }

        // Open a session with the App container.
        // SessionHandler handles the full lifecycle:
        //   POST /session/create → (optional queue polling) → WebSocket /ws/{id}
        //   → frame loop + audio loop
        // State changes and server messages arrive via the callbacks registered
        // above in the useEffect.
        try {
            await session.connect();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    const handleClipEnd = () => {
        // Signal the App container that the clip has finished playing and the
        // student has responded. The App will finalise the transcript, dispatch
        // an AnalysisWindow to Evaluation, and send back ClipReady (or in the
        // terminal case, start feedback generation and send SessionComplete).
        // We move to the evaluating screen while we wait.
        session.sendClipEnded(clipId);
        setScreen("evaluating");
    };

    const handleRestart = () => {
        // Tear down the current session and capture pipeline, then return to
        // the landing screen. The singletons are reusable — connect() checks
        // for idle/error state, and capture.stop() resets its internal channels.
        session.disconnect();
        capture.stop();
        setDebrief(null);
        setClipId(ENTRY_CLIP);
        setClipNum(1);
        setError(null);
        setScreen("landing");
    };

    // ── Derived ───────────────────────────────────────────────────────────────

    const videoSrc = `${VIDEO_BASE}/${clipId}.mp4`;

    // ── Render ────────────────────────────────────────────────────────────────

    switch (screen) {

        case "landing":
            return (
                <>
                    <LandingScreen onStart={handleStart} />
                    {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
                </>
            );

        case "queue":
            return <QueueScreen position={queuePos} />;

        case "player":
            return (
                <>
                    <ScenarioPlayerScreen
                        capture={capture}
                        videoSrc={videoSrc}
                        clipId={clipId}
                        clipNum={clipNum}
                        onClipEnd={handleClipEnd}
                    />
                    {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
                </>
            );

        case "evaluating":
            return (
                <>
                    <EvaluatingScreen />
                    {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
                </>
            );

        case "debrief":
            // Guard: if SessionComplete arrives before we've set debrief state
            // (shouldn't happen, but be defensive), stay on evaluating.
            if (!debrief) return <EvaluatingScreen />;
            return (
                <DebriefScreen
                    advice={debrief.advice}
                    severity={debrief.severity}
                    highlights={debrief.highlights}
                    onRestart={handleRestart}
                />
            );
    }
}

// ─── Error banner ─────────────────────────────────────────────────────────────

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    return (
        <div style={eb.wrap}>
            <span>⚠ {message}</span>
            <button style={eb.btn} onClick={onDismiss}>×</button>
            <style>{`@keyframes slide-up { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }`}</style>
        </div>
    );
}

const eb: Record<string, CSSProperties> = {
    wrap: {
        position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
        background: "#2d0d0d", border: "1px solid #f85149", borderRadius: 10,
        padding: "12px 20px", color: "#f85149", fontSize: 13,
        display: "flex", alignItems: "center", gap: 16,
        zIndex: 100, animation: "slide-up 0.2s ease",
        maxWidth: "calc(100vw - 48px)",
    },
    btn: {
        background: "none", border: "none", color: "#f85149",
        fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 0,
    },
};