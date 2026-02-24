import { useEffect, useRef, useState } from "react";
import type { CaptureSession } from "./capture";
import type { Landmark } from "@ar-training/shared";
import type { RawVideoFrame, RawAudioChunk } from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

const W = 480;
const H = 360;
const MFCC_HISTORY = 80;
const MFCC_COEFFS  = 13;

const FACE_CONNECTIONS: [number, number][] = [
    [61,146],[146,91],[91,181],[181,84],[84,17],[17,314],[314,405],[405,321],[321,375],[375,291],
    [61,185],[185,40],[40,39],[39,37],[37,0],[0,267],[267,269],[269,270],[270,409],[409,291],
    [33,7],[7,163],[163,144],[144,145],[145,153],[153,154],[154,155],[155,133],[33,246],[246,161],
    [161,160],[160,159],[159,158],[158,157],[157,173],[173,133],
    [362,382],[382,381],[381,380],[380,374],[374,373],[373,390],[390,249],[249,263],
    [362,398],[398,384],[384,385],[385,386],[386,387],[387,388],[388,466],[466,263],
];

const HAND_CONNECTIONS: [number, number][] = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5,9],[9,13],[13,17],
];

// ─── Drawing helpers ──────────────────────────────────────────────────────────

function drawDot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, r = 1.5) {
    ctx.beginPath();
    ctx.arc(x * W, y * H, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

function drawConnections(
    ctx: CanvasRenderingContext2D,
    landmarks: Landmark[],
    connections: [number, number][],
    color: string,
    lineWidth = 1,
) {
    if (!landmarks.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth   = lineWidth;
    for (const [a, b] of connections) {
        const la = landmarks[a];
        const lb = landmarks[b];
        if (!la || !lb) continue;
        ctx.beginPath();
        ctx.moveTo(la.x * W, la.y * H);
        ctx.lineTo(lb.x * W, lb.y * H);
        ctx.stroke();
    }
}

function mfccColor(value: number, min: number, max: number): string {
    const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
    const r = Math.round(255 * Math.min(1, t * 2));
    const b = Math.round(255 * Math.min(1, (1 - t) * 2));
    return `rgb(${r},0,${b})`;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
    capture: CaptureSession;
}

export default function DebugOverlay({ capture }: Props) {
    const videoRef      = useRef<HTMLVideoElement | null>(null);
    const canvasRef     = useRef<HTMLCanvasElement | null>(null);
    const mfccCanvasRef = useRef<HTMLCanvasElement | null>(null);

    // Use refs for values read inside the async loop so they're always current
    const showVideoRef     = useRef(true);
    const showLandmarksRef = useRef(true);

    // Use state for values that drive rendering
    const [showVideo,     setShowVideo]     = useState(true);
    const [showLandmarks, setShowLandmarks] = useState(true);
    const [fps, setFps]                     = useState(0);
    const [lastChunk, setLastChunk]         = useState<RawAudioChunk | null>(null);

    const mfccHistory = useRef<number[][]>([]);
    const fpsCounter  = useRef(0);
    const fpsTimer    = useRef(performance.now());

    // Keep refs in sync with state
    const handleShowVideo = (v: boolean) => {
        showVideoRef.current = v;
        setShowVideo(v);
        // Directly update video opacity so it doesn't wait for re-render
        if (videoRef.current) videoRef.current.style.opacity = v ? "1" : "0";
    };

    const handleShowLandmarks = (v: boolean) => {
        showLandmarksRef.current = v;
        setShowLandmarks(v);
    };

    // ── Attach stream ──────────────────────────────────────────────────────────

    useEffect(() => {
        const el     = videoRef.current;
        const stream = capture.getStream();
        if (!el || !stream) return;
        el.srcObject = stream;
        el.play().catch(() => {});
    }, []);

    // ── Frame stream ───────────────────────────────────────────────────────────

    useEffect(() => {
        let active = true;

        async function run() {
            for await (const frame of capture.frames()) {
                if (!active) break;

                fpsCounter.current++;
                const now = performance.now();
                if (now - fpsTimer.current >= 1000) {
                    setFps(fpsCounter.current);
                    fpsCounter.current = 0;
                    fpsTimer.current   = now;
                }

                const ctx = canvasRef.current?.getContext("2d");
                if (!ctx) continue;
                ctx.clearRect(0, 0, W, H);

                if (showLandmarksRef.current) {
                    drawFrame(ctx, frame);
                }
            }
        }

        run();
        return () => { active = false; };
    }, [capture]);

    // ── Audio stream ───────────────────────────────────────────────────────────

    useEffect(() => {
        let active = true;
        async function run() {
            for await (const chunk of capture.audio()) {
                if (!active) break;
                setLastChunk(chunk);
            }
        }
        run();
        return () => { active = false; };
    }, [capture]);

    useEffect(() => {
        if (!lastChunk || !mfccCanvasRef.current) return;
        const ctx = mfccCanvasRef.current.getContext("2d");
        if (!ctx) return;

        mfccHistory.current.push(...lastChunk.mfccs);
        if (mfccHistory.current.length > MFCC_HISTORY)
            mfccHistory.current = mfccHistory.current.slice(-MFCC_HISTORY);

        const cw   = mfccCanvasRef.current.width;
        const ch   = mfccCanvasRef.current.height;
        const colW = cw / MFCC_HISTORY;
        const rowH = ch / MFCC_COEFFS;

        let min = Infinity, max = -Infinity;
        for (const frame of mfccHistory.current)
            for (const v of frame) {
                if (v < min) min = v;
                if (v > max) max = v;
            }

        ctx.clearRect(0, 0, cw, ch);
        mfccHistory.current.forEach((frame, col) => {
            frame.forEach((val, row) => {
                ctx.fillStyle = mfccColor(val, min, max);
                ctx.fillRect(
                    Math.round(col * colW), Math.round(row * rowH),
                    Math.ceil(colW) + 1,   Math.ceil(rowH) + 1,
                );
            });
        });
    }, [lastChunk]);

    // ── Draw landmarks ─────────────────────────────────────────────────────────

    function drawFrame(ctx: CanvasRenderingContext2D, frame: RawVideoFrame) {
        drawConnections(ctx, frame.face_landmarks, FACE_CONNECTIONS, "#22d3ee", 0.8);
        for (const lm of frame.face_landmarks) drawDot(ctx, lm.x, lm.y, "#67e8f9");

        const hands: [Landmark[], string, string][] = [
            [frame.left_hand,  "#a78bfa", "#c4b5fd"],
            [frame.right_hand, "#34d399", "#6ee7b7"],
        ];
        for (const [hand, lineColor, dotColor] of hands) {
            if (!hand.length) continue;
            drawConnections(ctx, hand, HAND_CONNECTIONS, lineColor, 1.5);
            for (const lm of hand) drawDot(ctx, lm.x, lm.y, dotColor, 3);
        }
    }

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
        <div style={{ marginTop: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div style={{ width: 3, height: 12, background: "#6366f1", borderRadius: 2 }} />
                <span style={{ color: "#475569", fontSize: 10, letterSpacing: 2 }}>DEBUG OVERLAY</span>
                <div style={{ display: "flex", gap: 6, marginLeft: 16 }}>
                    <ToggleBtn label="Video"     active={showVideo}     onClick={() => handleShowVideo(!showVideo)} />
                    <ToggleBtn label="Landmarks" active={showLandmarks} onClick={() => handleShowLandmarks(!showLandmarks)} />
                </div>
                <span style={{ color: "#10b981", fontSize: 11, marginLeft: "auto" }}>{fps} fps</span>
            </div>

            <div style={{ position: "relative", width: W, height: H, marginBottom: 12, background: "#0c1221", borderRadius: 8, border: "1px solid #1e293b" }}>
                <video
                    ref={videoRef}
                    muted playsInline
                    width={W} height={H}
                    style={{ position: "absolute", top: 0, left: 0, borderRadius: 8, display: "block", opacity: showVideo ? 1 : 0 }}
                />
                <canvas
                    ref={canvasRef}
                    width={W} height={H}
                    style={{ position: "absolute", top: 0, left: 0, borderRadius: 8, display: "block" }}
                />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ color: "#475569", fontSize: 10 }}>
          MFCC — {MFCC_COEFFS} coefficients × last {MFCC_HISTORY} frames
        </span>
                <canvas ref={mfccCanvasRef} width={W} height={80} style={{ borderRadius: 8, background: "#0c1221", border: "1px solid #1e293b", display: "block", width: W, height: 80 }} />
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10 }}>
                    <span style={{ color: "#3b82f6" }}>low</span>
                    <div style={{ flex: 1, height: 6, borderRadius: 3, background: "linear-gradient(to right, #3b82f6, #ef4444)" }} />
                    <span style={{ color: "#ef4444" }}>high</span>
                </div>
            </div>
        </div>
    );
}

function ToggleBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button onClick={onClick} style={{
            padding: "2px 10px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace",
            fontSize: 10, border: `1px solid ${active ? "#6366f1" : "#334155"}`,
            background: active ? "#6366f133" : "transparent",
            color: active ? "#a5b4fc" : "#475569",
        }}>
            {label}
        </button>
    );
}
