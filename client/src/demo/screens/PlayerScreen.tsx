import { useState } from "react";

interface PlayerScreenProps {
    videoRef:       React.RefObject<HTMLVideoElement | null>;
    currentClipId:  string;
    onClipEnded:    (clipId: string) => void;
}

export function PlayerScreen({ videoRef, currentClipId, onClipEnded }: PlayerScreenProps) {
    const [confirmed, setConfirmed] = useState(false);

    const handleDone = () => {
        setConfirmed(true);
        onClipEnded(currentClipId);
    };

    return (
        <div style={s.root}>
            {/* Scenario video placeholder — real video playback is out of scope
                for the demo harness; the clip ID is shown instead. */}
            <div style={s.videoArea}>
                <div style={s.videoPlaceholder}>
                    <span style={s.clipLabel}>Scenario clip</span>
                    <span style={s.clipId}>{currentClipId}</span>
                    <span style={s.videoHint}>Video playback komt hier</span>
                </div>
            </div>

            {/* Webcam inset */}
            <div style={s.webcamWrap}>
                <video
                    ref={videoRef}
                    muted
                    playsInline
                    style={s.webcam}
                />
                <div style={s.webcamLabel}>Jouw reactie</div>
            </div>

            {/* Done button */}
            <div style={s.controls}>
                <button
                    style={{ ...s.btn, ...(confirmed ? s.btnDone : {}) }}
                    disabled={confirmed}
                    onClick={handleDone}
                >
                    {confirmed ? "Verwerken…" : "Klaar met reageren"}
                </button>
            </div>
        </div>
    );
}

const s = {
    root: {
        minHeight:      "100vh",
        display:        "flex",
        flexDirection:  "column" as const,
        alignItems:     "center",
        justifyContent: "center",
        gap:            "24px",
        background:     "#0f172a",
        padding:        "24px",
    },
    videoArea: {
        width:     "100%",
        maxWidth:  "720px",
    },
    videoPlaceholder: {
        width:          "100%",
        aspectRatio:    "16/9",
        background:     "#1e293b",
        borderRadius:   "10px",
        border:         "1px solid #334155",
        display:        "flex",
        flexDirection:  "column" as const,
        alignItems:     "center",
        justifyContent: "center",
        gap:            "8px",
    },
    clipLabel: {
        fontSize:  "11px",
        color:     "#475569",
        textTransform: "uppercase" as const,
        letterSpacing: "0.1em",
    },
    clipId: {
        fontSize:   "18px",
        fontWeight: "600" as const,
        color:      "#94a3b8",
        fontFamily: "monospace",
    },
    videoHint: {
        fontSize: "12px",
        color:    "#334155",
    },
    webcamWrap: {
        position: "relative" as const,
        width:    "200px",
    },
    webcam: {
        width:        "100%",
        aspectRatio:  "4/3",
        objectFit:    "cover" as const,
        borderRadius: "8px",
        display:      "block",
        background:   "#0f172a",
        border:       "1px solid #334155",
    },
    webcamLabel: {
        position:   "absolute" as const,
        bottom:     "6px",
        left:       "8px",
        fontSize:   "10px",
        color:      "#94a3b8",
        background: "rgba(0,0,0,0.5)",
        padding:    "2px 6px",
        borderRadius: "4px",
    },
    controls: {
        width:    "100%",
        maxWidth: "720px",
    },
    btn: {
        width:        "100%",
        padding:      "14px",
        fontSize:     "16px",
        fontWeight:   "600" as const,
        background:   "#6366f1",
        color:        "#fff",
        border:       "none",
        borderRadius: "8px",
        cursor:       "pointer",
    },
    btnDone: {
        background: "#1e293b",
        color:      "#475569",
        cursor:     "not-allowed",
    },
} as const;
