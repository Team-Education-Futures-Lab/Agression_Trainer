// =============================================================================
// LandmarkOverlay
//
// Imperative canvas drawn on top of the webcam feed. Renders the MediaPipe
// face mesh connections + dots and hand skeleton connections + dots.
// Positioned absolutely so it overlays the <video> element exactly.
//
// The component exposes a `draw(frame)` method via an imperative ref handle
// rather than being driven by React state. The parent calls draw() directly
// from inside the frame consumer loop so this component never re-renders
// after its initial mount.
// =============================================================================

import { forwardRef, useImperativeHandle, useRef } from "react";
import type { Landmark } from "@ar-training/shared";

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

export interface LandmarkFrame {
    face_landmarks: Landmark[];
    left_hand:      Landmark[];
    right_hand:     Landmark[];
}

export interface LandmarkOverlayHandle {
    /** Draw one frame imperatively. Never triggers a React re-render. */
    draw(frame: LandmarkFrame): void;
    /** Clear the canvas (e.g. when capture stops). */
    clear(): void;
}

interface LandmarkOverlayProps {
    width:  number;
    height: number;
}

export const LandmarkOverlay = forwardRef<LandmarkOverlayHandle, LandmarkOverlayProps>(
    function LandmarkOverlay({ width, height }, ref) {
        const canvasRef = useRef<HTMLCanvasElement | null>(null);

        useImperativeHandle(ref, () => ({
            draw(frame: LandmarkFrame) {
                const canvas = canvasRef.current;
                if (!canvas) return;
                const ctx = canvas.getContext("2d");
                if (!ctx) return;

                ctx.clearRect(0, 0, width, height);

                // Face — cyan connections + small dots
                drawConnections(ctx, frame.face_landmarks, FACE_CONNECTIONS, width, height, "#22d3ee", 0.8);
                for (const lm of frame.face_landmarks) {
                    drawDot(ctx, lm.x * width, lm.y * height, "#67e8f9", 1.5);
                }

                // Left hand — purple
                drawConnections(ctx, frame.left_hand, HAND_CONNECTIONS, width, height, "#a78bfa", 1.5);
                for (const lm of frame.left_hand) {
                    drawDot(ctx, lm.x * width, lm.y * height, "#c4b5fd", 3);
                }

                // Right hand — green
                drawConnections(ctx, frame.right_hand, HAND_CONNECTIONS, width, height, "#34d399", 1.5);
                for (const lm of frame.right_hand) {
                    drawDot(ctx, lm.x * width, lm.y * height, "#6ee7b7", 3);
                }
            },
            clear() {
                const canvas = canvasRef.current;
                if (!canvas) return;
                const ctx = canvas.getContext("2d");
                ctx?.clearRect(0, 0, width, height);
            },
        }), [width, height]);

        return (
            <canvas
                ref={canvasRef}
                width={width}
                height={height}
                style={{
                    position:      "absolute",
                    top:           0,
                    left:          0,
                    width:         "100%",
                    height:        "100%",
                    pointerEvents: "none",
                }}
            />
        );
    }
);

// ─── Canvas helpers ───────────────────────────────────────────────────────────

function drawDot(
    ctx:    CanvasRenderingContext2D,
    x:      number,
    y:      number,
    colour: string,
    r:      number,
): void {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
}

function drawConnections(
    ctx:         CanvasRenderingContext2D,
    landmarks:   Landmark[],
    connections: [number, number][],
    w:           number,
    h:           number,
    colour:      string,
    lineWidth:   number,
): void {
    if (landmarks.length === 0) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth   = lineWidth;
    for (const [a, b] of connections) {
        const pa = landmarks[a];
        const pb = landmarks[b];
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x * w, pa.y * h);
        ctx.lineTo(pb.x * w, pb.y * h);
        ctx.stroke();
    }
}