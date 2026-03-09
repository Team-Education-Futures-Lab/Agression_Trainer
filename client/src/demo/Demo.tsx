import { useEffect, useRef, useState } from "react";
import { CaptureSession } from "../capture";
import { useTranscriptionSocket } from "./hooks/useTranscriptSocket";
import {
    LandingScreen,
    ScenarioPlayerScreen,
    EvaluatingScreen,
    DebriefScreen,
    QueueScreen,
} from "./screens";

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen = "landing" | "queue" | "player" | "evaluating" | "debrief";

// ─── Singleton capture — survives re-renders ───────────────────────────────────

const capture = new CaptureSession();

// ─── Demo ─────────────────────────────────────────────────────────────────────

export default function Demo() {
    const [screen, setScreen]     = useState<Screen>("landing");
    const [clipNum, setClipNum]   = useState(1);
    const [ready,   setReady]     = useState(false);
    const [initErr, setInitErr]   = useState<string | null>(null);
    useRef<HTMLVideoElement | null>(null);
    // Transcription socket — active only while the player screen is shown
    const captureActive = screen === "player";
    const { transcript, connected } = useTranscriptionSocket(
        ready ? capture : null,
        captureActive,
    );

    // ── Init capture on first interaction ─────────────────────────────────────
    // We defer until "Training starten" so the browser permission prompt appears
    // in a direct user-gesture context, which some browsers require.

    const initCapture = async () => {
        if (ready) return;
        try {
            await capture.init();
            // start() needs a video element for MediaPipe — use a hidden one
            // ScenarioPlayerScreen attaches its own ref to the stream directly
            const dummy = document.createElement("video");
            dummy.muted = true;
            dummy.style.display = "none";
            document.body.appendChild(dummy);
            await capture.start(dummy);
            setReady(true);
        } catch (e: unknown) {
            setInitErr(e instanceof Error ? e.message : String(e));
        }
    };

    // ── Cleanup ────────────────────────────────────────────────────────────────
    useEffect(() => {
        return () => capture.stop();
    }, []);

    // ── Transitions ────────────────────────────────────────────────────────────

    const handleStart = async () => {
        await initCapture();
        // In a real session we'd POST /session/create here and handle queued state.
        // For the demo, always go straight to the player.
        setClipNum(1);
        setScreen("player");
    };

    const handleClipEnd = () => {
        setScreen("evaluating");
    };

    const handleEvalDone = () => {
        // Mock: after clip 1 → clip 2; after clip 2 → debrief
        if (clipNum < 2) {
            setClipNum(n => n + 1);
            setScreen("player");
        } else {
            setScreen("debrief");
        }
    };

    const handleRestart = () => {
        setClipNum(1);
        setScreen("landing");
    };

    // ── Render ─────────────────────────────────────────────────────────────────

    if (initErr) {
        return (
            <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d1117" }}>
                <div style={{ maxWidth: 400, background: "#161b22", border: "1px solid #f85149", borderRadius: 12, padding: 32, color: "#f85149", fontFamily: "monospace", fontSize: 13 }}>
                    <strong>Capture fout</strong><br /><br />
                    {initErr}<br /><br />
                    <span style={{ color: "#8b949e" }}>Controleer of je browser toegang heeft tot de microfoon en camera, en vernieuw de pagina.</span>
                </div>
            </div>
        );
    }

    switch (screen) {
        case "landing":
            return <LandingScreen onStart={handleStart} />;

        case "queue":
            return <QueueScreen />;

        case "player":
            return (
                <ScenarioPlayerScreen
                    capture={capture}
                    transcript={transcript}
                    connected={connected}
                    clipNum={clipNum}
                    onClipEnd={handleClipEnd}
                />
            );

        case "evaluating":
            return <EvaluatingScreen onDone={handleEvalDone} />;

        case "debrief":
            return <DebriefScreen onRestart={handleRestart} />;
    }
}
