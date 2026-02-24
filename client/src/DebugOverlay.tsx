import type {VideoFrame, AudioChunk, Landmark} from "@ar-training/shared"
import {useEffect, useRef, useState} from "react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Props {
    lastFrame: VideoFrame | null;
    lastChunk: AudioChunk | null;
    rawVideoEl: HTMLVideoElement | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const W = 480;
const H = 360;
const MFCC_HISTORY = 80;   // number of columns in the MFCC heatmap
const MFCC_COEFFS  = 13;

// MediaPipe face mesh contour connections (subset — outer silhouette + eyes + lips)
// Each pair is [from, to] landmark indices
const FACE_CONNECTIONS: [number, number][] = [
    // Lips outer
    [61,146],[146,91],[91,181],[181,84],[84,17],[17,314],[314,405],[405,321],[321,375],[375,291],
    [61,185],[185,40],[40,39],[39,37],[37,0],[0,267],[267,269],[269,270],[270,409],[409,291],
    // Left eye
    [33,7],[7,163],[163,144],[144,145],[145,153],[153,154],[154,155],[155,133],[33,246],[246,161],
    [161,160],[160,159],[159,158],[158,157],[157,173],[173,133],
    // Right eye
    [362,382],[382,381],[381,380],[380,374],[374,373],[373,390],[390,249],[249,263],
    [362,398],[398,384],[384,385],[385,386],[386,387],[387,388],[388,466],[466,263],
];

const HAND_CONNECTIONS: [number, number][] = [
    [0,1],[1,2],[2,3],[3,4],       // thumb
    [0,5],[5,6],[6,7],[7,8],       // index
    [0,9],[9,10],[10,11],[11,12],  // middle
    [0,13],[13,14],[14,15],[15,16],// ring
    [0,17],[17,18],[18,19],[19,20],// pinky
    [5,9],[9,13],[13,17],          // palm
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function drawLandmarkDot(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    color: string, r = 1.5
) {
    ctx.beginPath();
    ctx.arc(x * W, y * H, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

function drawConnections(
    ctx: CanvasRenderingContext2D,
    landmarks: {x: number; y: number}[],
    connections: [number, number][],
    color: string,
    lineWidth = 1
) {
    if (!landmarks.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
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

// Map a value in [-1, 1] (or any range) to an RGB colour via a simple heatmap
function mfccColor(value: number, min: number, max: number): string {
    const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
    const r = Math.round(255 * Math.min(1, t * 2));
    const b = Math.round(255 * Math.min(1, (1 - t) * 2));
    return `rgb(${r},0,${b})`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DebugOverlay({ lastFrame, lastChunk, rawVideoEl }: Props) {
    const landmarkCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const videoMirrorRef    = useRef<HTMLVideoElement | null>(null);
    const mfccCanvasRef     = useRef<HTMLCanvasElement | null>(null);

    const [showVideo, setShowVideo]   = useState(true);
    const [fps, setFps]               = useState(0);

    // Rolling MFCC history — kept in a ref so it doesn't cause re-renders
    const mfccHistory = useRef<number[][]>([]);
    const lastFrameTime = useRef<number>(performance.now());
    const frameCounter  = useRef(0);

    // Mirror the raw stream into the debug video element
    useEffect(() => {
        if (rawVideoEl && videoMirrorRef.current) {
            videoMirrorRef.current.srcObject = rawVideoEl.srcObject;
            videoMirrorRef.current.play().catch(() => {});
        }
    }, [rawVideoEl]);

    // Draw landmarks on canvas whenever a new frame arrives
    useEffect(() => {
        if (!lastFrame || !landmarkCanvasRef.current) return;
        const ctx = landmarkCanvasRef.current.getContext("2d");
        if (!ctx) return;

        // FPS counter
        frameCounter.current++;
        const now = performance.now();
        if (now - lastFrameTime.current >= 1000) {
            setFps(frameCounter.current);
            frameCounter.current = 0;
            lastFrameTime.current = now;
        }

        ctx.clearRect(0, 0, W, H);

        // Face — connections then dots
        drawConnections(ctx, lastFrame.face_landmarks, FACE_CONNECTIONS, "#22d3ee", 0.8);
        for (const lm of lastFrame.face_landmarks) {
            drawLandmarkDot(ctx, lm.x, lm.y, "#67e8f9");
        }

        // Hands
        const hands: [Landmark[], string, string][] = [
            [lastFrame.left_hand,  "#a78bfa", "#c4b5fd"],
            [lastFrame.right_hand, "#34d399", "#6ee7b7"],
        ];
        for (const [hand, color, dotColor] of hands) {
            if (!hand?.length) continue;
            drawConnections(ctx, hand, HAND_CONNECTIONS, color, 1.5);
            for (const lm of hand) {
                if (!lm) continue;
                drawLandmarkDot(ctx, lm.x, lm.y, dotColor, 3);
            }
        }
    }, [lastFrame]);

    // Update MFCC heatmap whenever a new chunk arrives
    useEffect(() => {
        if (!lastChunk || !mfccCanvasRef.current) return;
        const ctx = mfccCanvasRef.current.getContext("2d");
        if (!ctx) return;

        // Append new columns, trim to history window
        mfccHistory.current.push(...lastChunk.mfccs);
        if (mfccHistory.current.length > MFCC_HISTORY) {
            mfccHistory.current = mfccHistory.current.slice(-MFCC_HISTORY);
        }

        const cw = mfccCanvasRef.current.width;
        const ch = mfccCanvasRef.current.height;
        const colW = cw / MFCC_HISTORY;
        const rowH = ch / MFCC_COEFFS;

        // Find global min/max for normalisation
        let min = Infinity, max = -Infinity;
        for (const frame of mfccHistory.current) {
            for (const v of frame) {
                if (v < min) min = v;
                if (v > max) max = v;
            }
        }

        ctx.clearRect(0, 0, cw, ch);
        mfccHistory.current.forEach((frame, col) => {
            frame.forEach((val, row) => {
                ctx.fillStyle = mfccColor(val, min, max);
                ctx.fillRect(
                    Math.round(col * colW),
                    Math.round(row * rowH),
                    Math.ceil(colW) + 1,
                    Math.ceil(rowH) + 1,
                );
            });
        });
    }, [lastChunk]);

    return (
        <div style={s.root}>
            <div style={s.sectionHeader}>
                <span style={s.label}>DEBUG OVERLAY</span>
                <span style={{ ...s.badge, color: "#10b981" }}>
          {fps} fps
        </span>
            </div>

            {/* ── Video panels ── */}
            <div style={s.videoRow}>
                {/* Raw feed */}
                <div style={s.panel}>
                    <div style={s.panelLabel}>RAW FEED</div>
                    <video
                        ref={videoMirrorRef}
                        muted
                        playsInline
                        width={W}
                        height={H}
                        style={s.video}
                    />
                </div>

                {/* Landmark canvas */}
                <div style={s.panel}>
                    <div style={s.panelHeader}>
                        <span style={s.panelLabel}>LANDMARKS</span>
                        <button onClick={() => setShowVideo(v => !v)} style={s.toggleBtn}>
                            {showVideo ? "Hide Video" : "Show Video"}
                        </button>
                    </div>
                    <div style={{ position: "relative", width: W, height: H }}>
                        {showVideo && (
                            <video
                                muted
                                playsInline
                                width={W}
                                height={H}
                                style={{ ...s.video, position: "absolute", opacity: 0.35 }}
                                ref={el => {
                                    if (el && rawVideoEl) {
                                        el.srcObject = rawVideoEl.srcObject;
                                        el.play().catch(() => {});
                                    }
                                }}
                            />
                        )}
                        <canvas
                            ref={landmarkCanvasRef}
                            width={W}
                            height={H}
                            style={{ ...s.video, position: "absolute", top: 0, left: 0 }}
                        />
                    </div>
                </div>
            </div>

            {/* ── MFCC heatmap ── */}
            <div style={s.panel}>
                <div style={s.panelLabel}>
                    MFCC HEATMAP — {MFCC_COEFFS} coefficients × last {MFCC_HISTORY} frames
                </div>
                <canvas
                    ref={mfccCanvasRef}
                    width={W * 2 + 16}   // span full width of both panels + gap
                    height={80}
                    style={{ ...s.video, height: 80, width: W * 2 + 16 }}
                />
                <div style={s.mfccLegend}>
                    <span style={{ color: "#3b82f6" }}>low</span>
                    <span style={s.legendBar} />
                    <span style={{ color: "#ef4444" }}>high</span>
                </div>
            </div>
        </div>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
    root:        { marginTop: 32, maxWidth: W * 2 + 16 } as React.CSSProperties,
    sectionHeader: { display: "flex", alignItems: "center", gap: 12, marginBottom: 12 } as React.CSSProperties,
    label:       { color: "#475569", fontSize: 10, letterSpacing: 2, fontFamily: "monospace" } as React.CSSProperties,
    badge:       { fontSize: 11, fontFamily: "monospace", fontWeight: "bold" } as React.CSSProperties,
    videoRow:    { display: "flex", gap: 16, marginBottom: 12 } as React.CSSProperties,
    panel:       { display: "flex", flexDirection: "column", gap: 6 } as React.CSSProperties,
    panelHeader: { display: "flex", alignItems: "center", justifyContent: "space-between" } as React.CSSProperties,
    panelLabel:  { color: "#475569", fontSize: 10, letterSpacing: 1, fontFamily: "monospace" } as React.CSSProperties,
    video:       { borderRadius: 8, background: "#0f172a", display: "block" } as React.CSSProperties,
    toggleBtn:   { padding: "2px 10px", borderRadius: 6, border: "1px solid #334155", background: "#1e293b", color: "#94a3b8", fontSize: 11, cursor: "pointer", fontFamily: "monospace" } as React.CSSProperties,
    mfccLegend:  { display: "flex", alignItems: "center", gap: 8, fontSize: 10, fontFamily: "monospace", marginTop: 2 } as React.CSSProperties,
    legendBar:   { flex: 1, height: 6, borderRadius: 3, background: "linear-gradient(to right, #3b82f6, #ef4444)" } as React.CSSProperties,
} as const;