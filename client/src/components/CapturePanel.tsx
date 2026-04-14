// =============================================================================
// CapturePanel
//
// Left-column section: display video mirror, landmark overlay, MFCC
// spectrogram, capture controls, and the isolated CaptureStats counter.
//
// Receives only stable props (refs, callbacks, booleans that change at most
// once per user interaction). Never re-renders at frame rate.
// =============================================================================

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { LandmarkOverlay }   from "./LandmarkOverlay.tsx";
import { MfccSpectrogram }   from "./MfccSpectrogram.tsx";
import { CaptureStats }      from "./CaptureStats.tsx";
import type { LandmarkOverlayHandle } from "./LandmarkOverlay.tsx";
import type { MfccSpectrogramHandle } from "./MfccSpectrogram.tsx";
import type { CaptureStatsHandle }    from "./CaptureStats.tsx";

export interface CapturePanelHandles {
    overlay:  RefObject<LandmarkOverlayHandle | null>;
    spectrogram: RefObject<MfccSpectrogramHandle | null>;
    stats:    RefObject<CaptureStatsHandle | null>;
}

interface CapturePanelProps {
    /** Live MediaStream from capture.getStream() — null until capture starts. */
    stream:       MediaStream | null;
    capturing:    boolean;
    ready:        boolean;
    showOverlay:  boolean;
    onStartCapture:  () => void;
    onStopCapture:   () => void;
    onShowVideoChange: (v: boolean) => void;
    onShowOverlayChange: (v: boolean) => void;
    captureError: string | null;
    handles:      CapturePanelHandles;
}

export function CapturePanel({
                                 stream,
                                 capturing,
                                 ready,
                                 showOverlay,
                                 onStartCapture,
                                 onStopCapture,
                                 onShowVideoChange,
                                 onShowOverlayChange,
                                 captureError,
                                 handles,
                             }: CapturePanelProps) {
    const displayVideoRef = useRef<HTMLVideoElement | null>(null);

    // Mirror the capture stream into the display video element without
    // re-requesting the camera. srcObject assignment is safe on remount.
    useEffect(() => {
        if (!displayVideoRef.current) return;
        if (stream) {
            displayVideoRef.current.srcObject = stream;
            void displayVideoRef.current.play();
        } else {
            displayVideoRef.current.srcObject = null;
        }
    }, [stream]);

    return (
        <div style={st.panel}>
            {/* Video + overlay */}
            <div style={st.videoWrap}>
                <video ref={displayVideoRef} style={st.video} muted playsInline />
                <LandmarkOverlay ref={handles.overlay} width={640} height={480} />
            </div>

            {/* Video / overlay toggles + fps display */}
            <div style={st.controlRow}>
                <label style={st.checkLabel}>
                    <input
                        type="checkbox"
                        defaultChecked
                        onChange={e => onShowVideoChange(e.target.checked)}
                    />
                    {" "}Video
                </label>
                <label style={st.checkLabel}>
                    <input
                        type="checkbox"
                        checked={showOverlay}
                        onChange={e => onShowOverlayChange(e.target.checked)}
                    />
                    {" "}Landmarks
                </label>
                <CaptureStats ref={handles.stats} capturing={capturing} />
            </div>

            {/* MFCC spectrogram */}
            <div style={st.spectrogramWrap}>
                <SectionLabel>MFCC spectrogram</SectionLabel>
                <MfccSpectrogram ref={handles.spectrogram} />
            </div>

            {/* Capture controls */}
            <div style={st.controlGroup}>
                <SectionLabel>Capture</SectionLabel>
                <div style={st.row}>
                    {!capturing
                        ? <button style={st.btn} onClick={onStartCapture} disabled={!ready}>
                            {ready ? "Start capture" : "Loading models…"}
                        </button>
                        : <button style={st.btn} onClick={onStopCapture}>Stop capture</button>
                    }
                </div>
                {captureError && (
                    <div style={st.errorBox}>Capture error: {captureError}</div>
                )}
            </div>
        </div>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <div style={st.sectionLabel}>{children}</div>;
}

const st: Record<string, React.CSSProperties> = {
    panel:           { display: "flex", flexDirection: "column", gap: "12px" },
    videoWrap:       { position: "relative", width: "628px", height: "471px", background: "#000", flexShrink: 0 },
    video:           { width: "100%", height: "100%", objectFit: "cover", display: "block" },
    controlRow:      { display: "flex", alignItems: "center", gap: "12px" },
    checkLabel:      { fontSize: "12px", cursor: "pointer" },
    spectrogramWrap: { display: "flex", flexDirection: "column", gap: "4px" },
    sectionLabel:    { fontSize: "10px", color: "#555", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "4px" },
    controlGroup:    { display: "flex", flexDirection: "column", gap: "2px" },
    row:             { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
    btn:             { padding: "5px 10px", fontSize: "12px", cursor: "pointer", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px" },
    errorBox:        { background: "#4a1a1a", border: "1px solid #822", borderRadius: "4px", padding: "6px 10px", fontSize: "12px", color: "#f88" },
};