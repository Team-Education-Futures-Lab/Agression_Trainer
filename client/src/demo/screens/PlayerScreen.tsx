// =============================================================================
// PlayerScreen
//
// Full-page layout during an active clip. Left column: scenario video (or
// graceful fallback if the file is missing/fails) + clip context. Right
// column: live webcam feed + "done" button.
//
// The scenario video is attempted from clipMeta.video_url. If it errors, or
// if no URL is present, the left column falls back to showing the transcript
// and notable features as the primary content so the session can continue
// normally without any video files being present.
//
// The single <video ref={videoRef}> element in the right column is the same
// element owned by Demo.tsx and driven by CaptureSession. It must never be
// conditionally unmounted — it is always present, here acting as the visible
// webcam feed for the student.
// =============================================================================

import { useState } from "react";
import type { ClipData } from "@ar-training/shared";

interface PlayerScreenProps {
    videoRef:      React.RefObject<HTMLVideoElement | null>;
    currentClipId: string;
    clipMeta:      ClipData | null;
    onClipEnded:   (clipId: string) => void;
}

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
    const [confirmed,   setConfirmed]   = useState(false);
    const [videoFailed, setVideoFailed] = useState(false);

    const handleDone = () => {
        setConfirmed(true);
        onClipEnded(currentClipId);
    };

    const videoUrl     = clipMeta?.video_url ?? null;
    const showVideo    = videoUrl !== null && !videoFailed;
    const showFallback = !showVideo;

    return (
        <div style={s.root}>

            {/* ── Left column ─────────────────────────────────────────── */}
            <div style={s.left}>

                {/* Scenario video — hidden (but mounted) when failed so we
                    don't keep a broken element in the visual flow */}
                {videoUrl && (
                    <video
                        key={videoUrl}           // remount on clip change for fresh load attempt
                        src={videoUrl}
                        controls
                        style={{ ...s.scenarioVideo, display: showVideo ? "block" : "none" }}
                        onError={() => setVideoFailed(true)}
                    />
                )}

                {/* Fallback header — shown when video is unavailable */}
                {showFallback && (
                    <div style={s.fallbackHeader}>
                        <span style={s.fallbackLabel}>Scenario video niet beschikbaar</span>
                        <span style={s.fallbackClipId}>{currentClipId}</span>
                    </div>
                )}

                {/* Transcript — always shown; visually promoted when video is absent */}
                {clipMeta?.transcript && (
                    <div style={{ ...s.transcriptBox, ...(showFallback ? s.transcriptBoxPromoted : {}) }}>
                        <span style={s.sectionLabel}>Wat de ander zegt</span>
                        <p style={s.transcriptText}>"{clipMeta.transcript}"</p>
                    </div>
                )}

                {/* Notable features — always shown */}
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

                {/* Placeholder shown only when there is genuinely nothing to display */}
                {!clipMeta && (
                    <div style={s.emptyPlaceholder}>
                        <span style={s.fallbackLabel}>Clipgegevens laden…</span>
                        <span style={s.fallbackClipId}>{currentClipId}</span>
                    </div>
                )}
            </div>

            {/* ── Right column ────────────────────────────────────────── */}
            <div style={s.right}>
                <div style={s.webcamCard}>
                    <span style={s.sectionLabel}>Jouw reactie</span>
                    {/* This is the same videoRef element owned by Demo.tsx —
                        CaptureSession is already bound to it. Here it serves
                        double duty as the visible webcam preview. */}
                    <video ref={videoRef} muted playsInline style={s.webcam} />
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

const s: Record<string, React.CSSProperties> = {
    root: {
        minHeight:           "100vh",
        display:             "grid",
        gridTemplateColumns: "1fr 340px",
        background:          "#0f172a",
    },
    left: {
        display:       "flex",
        flexDirection: "column",
        gap:           "16px",
        padding:       "24px",
        borderRight:   "1px solid #1e293b",
        overflowY:     "auto",
    },
    scenarioVideo: {
        width:        "100%",
        aspectRatio:  "16/9",
        borderRadius: "10px",
        background:   "#000",
        border:       "1px solid #334155",
        display:      "block",
        flexShrink:   0,
    },
    fallbackHeader: {
        width:          "100%",
        aspectRatio:    "16/9",
        background:     "#1e293b",
        borderRadius:   "10px",
        border:         "1px dashed #334155",
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "center",
        justifyContent: "center",
        gap:            "6px",
        flexShrink:     0,
    },
    emptyPlaceholder: {
        width:          "100%",
        aspectRatio:    "16/9",
        background:     "#1e293b",
        borderRadius:   "10px",
        border:         "1px solid #334155",
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "center",
        justifyContent: "center",
        gap:            "6px",
        flexShrink:     0,
    },
    fallbackLabel: {
        fontSize:      "12px",
        color:         "#475569",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
    },
    fallbackClipId: {
        fontSize:   "13px",
        color:      "#64748b",
        fontFamily: "monospace",
    },
    transcriptBox: {
        background:   "#1e293b",
        borderRadius: "8px",
        padding:      "14px 16px",
        borderLeft:   "3px solid #6366f1",
    },
    transcriptBoxPromoted: {
        padding:    "20px 20px",
        fontSize:   "16px",
        borderLeft: "4px solid #6366f1",
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
        flexWrap:  "wrap",
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
        flexDirection: "column",
        gap:           "16px",
        padding:       "24px",
    },
    webcamCard: {
        display:       "flex",
        flexDirection: "column",
        gap:           "8px",
    },
    webcam: {
        width:        "100%",
        aspectRatio:  "4/3",
        objectFit:    "cover",
        borderRadius: "8px",
        display:      "block",
        background:   "#0c1221",
        border:       "1px solid #334155",
        transform:    "scaleX(-1)",
    },
    sectionLabel: {
        display:       "block",
        fontSize:      "10px",
        color:         "#475569",
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        marginBottom:  "2px",
    },
    btn: {
        width:        "100%",
        padding:      "14px",
        fontSize:     "15px",
        fontWeight:   "600",
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
};