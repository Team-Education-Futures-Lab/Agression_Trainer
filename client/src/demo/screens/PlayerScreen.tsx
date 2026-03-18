// =============================================================================
// PlayerScreen
//
// Full-page layout during an active clip. Left column: scenario video area +
// clip context (transcript, notable features). Right column: live webcam.
// =============================================================================

import { useState } from "react";
import type { ClipMetadata } from "@ar-training/shared";

interface PlayerScreenProps {
    videoRef:      React.RefObject<HTMLVideoElement | null>;
    currentClipId: string;
    clipMeta:      ClipMetadata | null;
    onClipEnded:   (clipId: string) => void;
}

// Human-readable labels for notable_features values
const FEATURE_LABELS: Record<string, string> = {
    raised_voice:       "Luide stem",
    calm_voice:         "Rustige stem",
    aggressive_posture: "Agressieve houding",
    open_posture:       "Open houding",
    crossed_arms:       "Gekruiste armen",
    direct_eye_contact: "Oogcontact",
    crying:             "Emotioneel",
    pointing_gesture:   "Wijzend gebaar",
    backing_away:       "Achteruit lopen",
    silence:            "Stilte",
};

export function PlayerScreen({ videoRef, currentClipId, clipMeta, onClipEnded }: PlayerScreenProps) {
    const [confirmed, setConfirmed] = useState(false);

    const handleDone = () => {
        setConfirmed(true);
        onClipEnded(currentClipId);
    };

    return (
        <div style={s.root}>

            {/* ── Left column ─────────────────────────────────────────── */}
            <div style={s.left}>

                {/* Video placeholder — fills the left column */}
                <div style={s.videoPlaceholder}>
                    <span style={s.videoPlaceholderLabel}>Scenario video</span>
                    <span style={s.videoPlaceholderSub}>{currentClipId}</span>
                </div>

                {/* Clip transcript */}
                {clipMeta?.transcript && (
                    <div style={s.transcriptBox}>
                        <span style={s.sectionLabel}>Wat de ander zegt</span>
                        <p style={s.transcriptText}>"{clipMeta.transcript}"</p>
                    </div>
                )}

                {/* Notable features */}
                {clipMeta && clipMeta.notable_features.length > 0 && (
                    <div style={s.featuresBox}>
                        <span style={s.sectionLabel}>Gedragskenmerken</span>
                        <div style={s.featureTags}>
                            {clipMeta.notable_features.map(f => (
                                <span key={f} style={s.tag}>
                                    {FEATURE_LABELS[f] ?? f}
                                </span>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* ── Right column ────────────────────────────────────────── */}
            <div style={s.right}>
                <div style={s.webcamCard}>
                    <span style={s.sectionLabel}>Jouw reactie</span>
                    {/* The persistent video element — srcObject already bound */}
                    <video
                        ref={videoRef}
                        muted
                        playsInline
                        style={s.webcam}
                    />
                </div>

                <button
                    style={{ ...s.btn, ...(confirmed ? s.btnDone : {}) }}
                    disabled={confirmed}
                    onClick={handleDone}
                >
                    {confirmed ? "Verwerken…" : "Klaar met reageren"}
                </button>

                <p style={s.hint}>
                    Reageer op de situatie zoals je dat in de klas zou doen.
                    Druk op de knop als je klaar bent.
                </p>
            </div>
        </div>
    );
}

const s = {
    root: {
        minHeight:   "100vh",
        display:     "grid",
        gridTemplateColumns: "1fr 340px",
        gap:         "0",
        background:  "#0f172a",
    },
    left: {
        display:        "flex",
        flexDirection:  "column" as const,
        gap:            "16px",
        padding:        "24px",
        borderRight:    "1px solid #1e293b",
        overflowY:      "auto" as const,
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
        gap:            "6px",
        flexShrink:     0,
    },
    videoPlaceholderLabel: {
        fontSize:      "12px",
        color:         "#475569",
        textTransform: "uppercase" as const,
        letterSpacing: "0.08em",
    },
    videoPlaceholderSub: {
        fontSize:   "14px",
        color:      "#64748b",
        fontFamily: "monospace",
    },
    transcriptBox: {
        background:   "#1e293b",
        borderRadius: "8px",
        padding:      "14px 16px",
        borderLeft:   "3px solid #6366f1",
    },
    transcriptText: {
        margin:     "6px 0 0",
        fontSize:   "15px",
        color:      "#cbd5e1",
        lineHeight: 1.6,
        fontStyle:  "italic",
    },
    featuresBox: {
        background:   "#1e293b",
        borderRadius: "8px",
        padding:      "14px 16px",
    },
    featureTags: {
        display:   "flex",
        flexWrap:  "wrap" as const,
        gap:       "6px",
        marginTop: "8px",
    },
    tag: {
        padding:      "3px 10px",
        borderRadius: "999px",
        fontSize:     "12px",
        background:   "#334155",
        color:        "#94a3b8",
        border:       "1px solid #475569",
    },
    right: {
        display:       "flex",
        flexDirection: "column" as const,
        gap:           "16px",
        padding:       "24px",
    },
    webcamCard: {
        display:       "flex",
        flexDirection: "column" as const,
        gap:           "8px",
    },
    webcam: {
        width:        "100%",
        aspectRatio:  "4/3",
        objectFit:    "cover" as const,
        borderRadius: "8px",
        display:      "block",
        background:   "#0c1221",
        border:       "1px solid #334155",
        transform:    "scaleX(-1)", // mirror — feels more natural for self-view
    },
    sectionLabel: {
        display:       "block",
        fontSize:      "10px",
        color:         "#475569",
        textTransform: "uppercase" as const,
        letterSpacing: "0.1em",
        marginBottom:  "2px",
    },
    btn: {
        width:        "100%",
        padding:      "14px",
        fontSize:     "15px",
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
    hint: {
        margin:     0,
        fontSize:   "12px",
        color:      "#475569",
        lineHeight: 1.5,
    },
} as const;