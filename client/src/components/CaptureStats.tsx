// =============================================================================
// CaptureStats
//
// Isolated component that owns frame / chunk / fps display state. Updating
// these counters must not cause any sibling component to re-render; housing
// them here satisfies that constraint.
//
// The parent calls the imperative `update(frameId, chunkId, fps)` handle from
// inside the capture consumer loops — no parent setState is involved.
// =============================================================================

import { forwardRef, useImperativeHandle, useState } from "react";

export interface CaptureStatsHandle {
    update(frameId: number, chunkId: number, fps: number): void;
    reset(): void;
}

interface CaptureStatsProps {
    /** Whether capture is currently running (controls FPS display fallback). */
    capturing: boolean;
}

export const CaptureStats = forwardRef<CaptureStatsHandle, CaptureStatsProps>(
    function CaptureStats({ capturing }, ref) {
        const [frameCount, setFrameCount] = useState(0);
        const [chunkCount, setChunkCount] = useState(0);
        const [fps,        setFps]        = useState(0);

        useImperativeHandle(ref, () => ({
            update(frameId: number, chunkId: number, nextFps: number) {
                setFrameCount(frameId);
                setChunkCount(chunkId);
                setFps(nextFps);
            },
            reset() {
                setFrameCount(0);
                setChunkCount(0);
                setFps(0);
            },
        }), []);

        return (
            <div style={st.row}>
                <Kv k="Frames" v={String(frameCount)} />
                <Kv k="Chunks" v={String(chunkCount)} />
                <Kv k="FPS"    v={capturing ? String(fps) : "—"} />
            </div>
        );
    }
);

function Kv({ k, v }: { k: string; v: string }) {
    return (
        <span style={st.kv}>
            <span style={st.kvKey}>{k}</span>
            <span style={st.kvVal}>{v}</span>
        </span>
    );
}

const st = {
    row:   { display: "flex", gap: "12px", alignItems: "center" },
    kv:    { fontSize: "11px", display: "inline-flex", gap: "4px" },
    kvKey: { color: "#666" },
    kvVal: { color: "#e0e0e0" },
} as const;