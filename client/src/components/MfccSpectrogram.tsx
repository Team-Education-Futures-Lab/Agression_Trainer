// =============================================================================
// MfccSpectrogram
//
// A scrolling heatmap of MFCC frames. Each column is one ~43ms MFCC frame;
// each row is one of the 13 coefficients (0 = bottom). Colour maps from
// blue (low) to red (high) via a perceptually uniform ramp.
//
// The component exposes a `push(mfccs)` method via an imperative ref handle
// rather than being driven by React state. The parent calls push() directly
// from inside the audio consumer loop so this component never re-renders
// after its initial mount.
// =============================================================================

import { forwardRef, useImperativeHandle, useRef } from "react";

const CANVAS_W  = 400;
const CANVAS_H  = 130;
const N_COEFFS  = 13;
const COL_WIDTH = 4;                          // pixels per MFCC frame column
const MAX_COLS  = Math.floor(CANVAS_W / COL_WIDTH);

const VAL_MIN = -40;
const VAL_MAX =  40;

export interface MfccSpectrogramHandle {
    /** Append MFCC frames from one audio chunk. Never triggers a React re-render. */
    push(mfccs: number[][]): void;
    /** Clear the canvas (e.g. when capture stops). */
    clear(): void;
}

export const MfccSpectrogram = forwardRef<MfccSpectrogramHandle, Record<never, never>>(
    function MfccSpectrogram(_props, ref) {
        const canvasRef  = useRef<HTMLCanvasElement | null>(null);
        const historyRef = useRef<number[][]>([]);

        useImperativeHandle(ref, () => ({
            push(mfccs: number[][]) {
                if (mfccs.length === 0) return;

                const hist = historyRef.current;
                for (const frame of mfccs) {
                    const col = frame.map(v =>
                        Math.max(0, Math.min(1, (v - VAL_MIN) / (VAL_MAX - VAL_MIN)))
                    );
                    hist.push(col);
                }
                if (hist.length > MAX_COLS) {
                    hist.splice(0, hist.length - MAX_COLS);
                }

                const canvas = canvasRef.current;
                if (!canvas) return;
                const ctx = canvas.getContext("2d");
                if (!ctx) return;

                ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
                const rowH = CANVAS_H / N_COEFFS;

                hist.forEach((col, ci) => {
                    const x = ci * COL_WIDTH;
                    col.forEach((val, ri) => {
                        const y = CANVAS_H - (ri + 1) * rowH;
                        ctx.fillStyle = heatColour(val);
                        ctx.fillRect(x, y, COL_WIDTH, rowH);
                    });
                });
            },
            clear() {
                historyRef.current = [];
                const canvas = canvasRef.current;
                if (!canvas) return;
                const ctx = canvas.getContext("2d");
                ctx?.clearRect(0, 0, CANVAS_W, CANVAS_H);
            },
        }), []);

        return (
            <canvas
                ref={canvasRef}
                width={CANVAS_W}
                height={CANVAS_H}
                style={{
                    display:        "block",
                    width:          "100%",
                    height:         `${CANVAS_H}px`,
                    background:     "#111",
                    borderRadius:   "3px",
                    imageRendering: "pixelated",
                }}
            />
        );
    }
);

// ─── Colour ramp ──────────────────────────────────────────────────────────────

function heatColour(t: number): string {
    const stops: [number, number, number][] = [
        [  0,   0, 180],
        [  0, 200, 200],
        [  0, 180,   0],
        [220, 200,   0],
        [220,  20,   0],
    ];
    const seg = (stops.length - 1) * Math.max(0, Math.min(1, t));
    const lo  = Math.floor(seg);
    const hi  = Math.min(lo + 1, stops.length - 1);
    const f   = seg - lo;
    const a   = stops[lo]!;
    const b   = stops[hi]!;
    const r   = Math.round(a[0] + f * (b[0] - a[0]));
    const g   = Math.round(a[1] + f * (b[1] - a[1]));
    const bv  = Math.round(a[2] + f * (b[2] - a[2]));
    return `rgb(${r},${g},${bv})`;
}