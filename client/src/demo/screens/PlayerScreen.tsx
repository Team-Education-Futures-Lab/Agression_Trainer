// =============================================================================
// PlayerScreen — two-phase watch / respond flow
//
// Phase 1 — Watch
//   Scenario video autoplays (no controls, no muted). Webcam preview in right
//   column. Phase advances ONLY when the video fires onEnded — never
//   automatically on error. If the video fails, a manual "Doorgaan" button
//   appears; the student must explicitly advance.
//
// Phase 2 — Respond
//   Countdown timer (responseDurationSeconds, default 30 s) counts down.
//   "Klaar met reageren" button lets the student end early. Either path calls
//   onClipEnded(currentClipId).
//
//   The phase can only advance to "respond" once per clip mount (phaseAdvanced
//   ref). This prevents spurious double-advances if onEnded somehow fires
//   twice (e.g. browser quirk on a fully-buffered video).
//
// Webcam:
//   The stream prop is bound via useLayoutEffect. Both watch and respond phases
//   display the webcam at a fixed 4:3 aspect ratio — no flex-stretch.
//
// Live transcript:
//   Shown in respond phase as confirmation that Whisper is working.
// =============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClipData } from "@ar-training/shared";

interface PlayerScreenProps {
    videoRef:                React.RefObject<HTMLVideoElement | null>;
    stream:                  MediaStream | null;
    currentClipId:           string;
    clipMeta:                ClipData | null;
    onClipEnded:             (clipId: string) => void;
    responseDurationSeconds: number;
    liveTranscript:          string;
}

type Phase = "watch" | "respond";

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

export function PlayerScreen({
                                 videoRef,
                                 stream,
                                 currentClipId,
                                 clipMeta,
                                 onClipEnded,
                                 responseDurationSeconds,
                                 liveTranscript,
                             }: PlayerScreenProps) {
    const [phase,       setPhase]       = useState<Phase>("watch");
    const [timeLeft,    setTimeLeft]    = useState(responseDurationSeconds);
    const [ended,       setEnded]       = useState(false);
    const [videoFailed, setVideoFailed] = useState(false);

    // Guards — reset on each clip mount via the clip-change effect below.
    // endedRef:       prevents onClipEnded from firing more than once per clip.
    // phaseAdvanced:  prevents phase advancing to "respond" more than once per clip.
    const endedRef        = useRef(false);
    const phaseAdvanced   = useRef(false);
    const clipIdRef       = useRef(currentClipId);
    clipIdRef.current     = currentClipId;

    // ── Stream binding ────────────────────────────────────────────────────────
    useLayoutEffect(() => {
        const el = videoRef.current;
        if (!el || !stream) return;
        if (el.srcObject !== stream) {
            el.srcObject = stream;
            el.play().catch(() => undefined);
        }
    }, [videoRef, stream]);

    // ── Reset on clip change ──────────────────────────────────────────────────
    useEffect(() => {
        setPhase("watch");
        setTimeLeft(responseDurationSeconds);
        setEnded(false);
        setVideoFailed(false);
        endedRef.current      = false;
        phaseAdvanced.current = false;
    }, [currentClipId, responseDurationSeconds]);

    // ── Countdown timer — respond phase only ──────────────────────────────────
    useEffect(() => {
        if (phase !== "respond") return;

        const id = setInterval(() => {
            setTimeLeft(t => {
                if (t <= 1) {
                    clearInterval(id);
                    if (!endedRef.current) {
                        endedRef.current = true;
                        setEnded(true);
                        onClipEnded(clipIdRef.current);
                    }
                    return 0;
                }
                return t - 1;
            });
        }, 1000);

        return () => clearInterval(id);
    }, [phase, onClipEnded]);

    // ── Phase transition — only called when video ends naturally ──────────────
    const handleVideoEnded = () => {
        if (phaseAdvanced.current) return;  // guard: advance only once per clip
        phaseAdvanced.current = true;
        setPhase("respond");
        setTimeLeft(responseDurationSeconds);
    };

    // ── Done button ───────────────────────────────────────────────────────────
    const handleDone = () => {
        if (endedRef.current) return;
        endedRef.current = true;
        setEnded(true);
        onClipEnded(currentClipId);
    };

    const videoUrl  = clipMeta?.video_url ?? null;
    const showVideo = videoUrl !== null && !videoFailed;

    // SVG countdown arc
    const timerRadius = 24;
    const timerCirc   = 2 * Math.PI * timerRadius;
    const timerPct    = timeLeft / responseDurationSeconds;
    const timerDash   = timerCirc * timerPct;
    const timerColor  = timeLeft <= 5 ? "#ef4444" : "#6366f1";

    return (
        <>
            <style>{PLAYER_RESPONSIVE_CSS}</style>

            <div style={s.root} className="player-root">

                {/* ── Left column ─────────────────────────────────────── */}
                <div style={s.left} className="player-left">

                    {phase === "watch" ? (
                        <>
                            {/* Scenario video — no controls, no muted */}
                            {videoUrl && (
                                <video
                                    key={videoUrl}
                                    src={videoUrl}
                                    autoPlay
                                    playsInline
                                    style={{ ...s.scenarioVideo, display: showVideo ? "block" : "none" }}
                                    onEnded={handleVideoEnded}
                                    onError={() => setVideoFailed(true)}
                                />
                            )}

                            {/* Fallback — shown when video is missing or failed.
                                Student must explicitly click to advance; we do NOT
                                auto-call handleVideoEnded() here because that causes
                                the phase to flip instantly and confuses the flow. */}
                            {!showVideo && (
                                <div style={s.fallbackHeader}>
                                    <span style={s.fallbackLabel}>
                                        {videoFailed
                                            ? "Scenario video kon niet worden geladen"
                                            : "Scenario video niet beschikbaar"}
                                    </span>
                                    <span style={s.fallbackClipId}>{currentClipId}</span>
                                    <button style={s.skipBtn} onClick={handleVideoEnded}>
                                        Doorgaan naar reactie →
                                    </button>
                                </div>
                            )}

                            {clipMeta?.transcript && (
                                <div style={s.transcriptBox}>
                                    <span style={s.sectionLabel}>Wat de ander zegt</span>
                                    <p style={s.transcriptText}>"{clipMeta.transcript}"</p>
                                </div>
                            )}

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

                            {!clipMeta && (
                                <div style={s.emptyPlaceholder}>
                                    <span style={s.fallbackLabel}>Clipgegevens laden…</span>
                                </div>
                            )}

                            <p style={s.watchHint}>
                                Bekijk de video. Daarna krijg je de kans om te reageren.
                            </p>
                        </>
                    ) : (
                        /* ── Phase 2: respond panel ──────────────────── */
                        <div style={s.respondPanel}>
                            <div style={s.respondHeader}>
                                <span style={s.respondTitle}>Jouw beurt</span>
                                <p style={s.respondInstructions}>
                                    Reageer op de situatie zoals je dat in de klas zou doen.
                                    Spreek duidelijk en kijk in de camera.
                                </p>
                            </div>

                            {clipMeta?.transcript && (
                                <div style={{ ...s.transcriptBox, opacity: 0.7 }}>
                                    <span style={s.sectionLabel}>De ander zei</span>
                                    <p style={{ ...s.transcriptText, fontSize: "13px" }}>
                                        "{clipMeta.transcript}"
                                    </p>
                                </div>
                            )}

                            {clipMeta && clipMeta.notable_features.length > 0 && (
                                <div style={{ ...s.featuresBox, opacity: 0.7 }}>
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

                            {/* Live transcription indicator */}
                            <div style={s.liveTranscriptBox}>
                                <span style={s.sectionLabel}>Transcriptie (live)</span>
                                <p style={s.liveTranscriptText}>
                                    {liveTranscript
                                        ? liveTranscript
                                        : <span style={s.liveTranscriptEmpty}>Luisteren naar je stem…</span>
                                    }
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* ── Right column ────────────────────────────────────── */}
                <div style={s.right} className="player-right">

                    {/* Webcam at fixed 4:3 aspect ratio in both phases */}
                    <div style={s.webcamCard}>
                        <span style={s.sectionLabel}>
                            {phase === "watch" ? "Jouw camera is actief" : "Jouw reactie"}
                        </span>
                        <video
                            ref={videoRef}
                            muted
                            playsInline
                            style={s.webcam}
                        />
                    </div>

                    {/* Respond phase: timer + button */}
                    {phase === "respond" && (
                        <>
                            <div style={s.timerRow}>
                                <svg width={56} height={56} style={s.timerSvg}>
                                    <circle
                                        cx={28} cy={28} r={timerRadius}
                                        fill="none" stroke="#1e293b" strokeWidth={4}
                                    />
                                    <circle
                                        cx={28} cy={28} r={timerRadius}
                                        fill="none"
                                        stroke={timerColor}
                                        strokeWidth={4}
                                        strokeDasharray={`${timerDash} ${timerCirc}`}
                                        strokeLinecap="round"
                                        transform="rotate(-90 28 28)"
                                        style={{ transition: "stroke-dasharray 0.9s linear, stroke 0.3s" }}
                                    />
                                    <text
                                        x={28} y={28}
                                        dominantBaseline="central"
                                        textAnchor="middle"
                                        fill={timerColor}
                                        fontSize={13}
                                        fontWeight="600"
                                        fontFamily="monospace"
                                    >
                                        {timeLeft}
                                    </text>
                                </svg>
                                <span style={{ ...s.timerLabel, color: timerColor }}>
                                    seconden om te reageren
                                </span>
                            </div>

                            <button
                                style={{ ...s.btn, ...(ended ? s.btnDone : {}) }}
                                disabled={ended}
                                onClick={handleDone}
                            >
                                {ended ? "Verwerken…" : "Klaar met reageren"}
                            </button>
                        </>
                    )}

                    {/* Watch phase hint */}
                    {phase === "watch" && (
                        <p style={s.hint}>
                            Je wordt opgenomen. Reageer na de video.
                        </p>
                    )}
                </div>
            </div>
        </>
    );
}

const PLAYER_RESPONSIVE_CSS = `
.player-root {
    display: grid;
    grid-template-columns: 1fr 320px;
    min-height: 100vh;
    background: #0f172a;
}
@media (max-width: 640px) {
    .player-root { grid-template-columns: 1fr; }
    .player-left { border-right: none !important; border-bottom: 1px solid #1e293b; }
    .player-right { padding-top: 16px !important; }
}
`;

const s: Record<string, React.CSSProperties> = {
    root: {
        display:    "grid",
        minHeight:  "100vh",
        background: "#0f172a",
    },
    left: {
        display:       "flex",
        flexDirection: "column",
        gap:           "14px",
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
        gap:            "10px",
        flexShrink:     0,
    },
    emptyPlaceholder: {
        width:          "100%",
        aspectRatio:    "16/9",
        background:     "#1e293b",
        borderRadius:   "10px",
        border:         "1px solid #334155",
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        flexShrink:     0,
    },
    fallbackLabel: {
        fontSize:      "12px",
        color:         "#475569",
        textTransform: "uppercase" as const,
        letterSpacing: "0.08em",
    },
    fallbackClipId: {
        fontSize:   "13px",
        color:      "#64748b",
        fontFamily: "monospace",
    },
    skipBtn: {
        marginTop:    "4px",
        padding:      "6px 14px",
        fontSize:     "13px",
        fontWeight:   "500",
        background:   "#334155",
        color:        "#94a3b8",
        border:       "none",
        borderRadius: "6px",
        cursor:       "pointer",
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
    watchHint: {
        margin:     "4px 0 0",
        fontSize:   "12px",
        color:      "#334155",
        lineHeight: 1.5,
        fontStyle:  "italic",
    },
    respondPanel: {
        display:       "flex",
        flexDirection: "column",
        gap:           "14px",
        flex:          1,
    },
    respondHeader: {
        display:       "flex",
        flexDirection: "column",
        gap:           "8px",
    },
    respondTitle: {
        display:    "block",
        fontSize:   "22px",
        fontWeight: "700",
        color:      "#f1f5f9",
    },
    respondInstructions: {
        margin:     0,
        fontSize:   "14px",
        color:      "#94a3b8",
        lineHeight: 1.6,
    },
    liveTranscriptBox: {
        background:   "#0f172a",
        borderRadius: "8px",
        padding:      "12px 14px",
        border:       "1px solid #334155",
        minHeight:    "56px",
    },
    liveTranscriptText: {
        margin:     "6px 0 0",
        fontSize:   "13px",
        color:      "#94a3b8",
        lineHeight: 1.6,
        fontStyle:  "italic",
        whiteSpace: "pre-wrap" as const,
    },
    liveTranscriptEmpty: {
        color:     "#334155",
        fontStyle: "italic",
    },
    right: {
        display:       "flex",
        flexDirection: "column",
        gap:           "16px",
        padding:       "24px",
    },
    // Single webcam card — used in both phases at fixed 4:3 ratio.
    // No flex-stretch: the right column is a normal scrolling flex column.
    webcamCard: {
        display:       "flex",
        flexDirection: "column",
        gap:           "8px",
    },
    webcam: {
        width:        "100%",
        aspectRatio:  "4/3",
        objectFit:    "cover",
        borderRadius: "10px",
        display:      "block",
        background:   "#0c1221",
        border:       "1px solid #334155",
        transform:    "scaleX(-1)",
    },
    sectionLabel: {
        display:       "block",
        fontSize:      "10px",
        color:         "#475569",
        textTransform: "uppercase" as const,
        letterSpacing: "0.1em",
        marginBottom:  "2px",
    },
    timerRow: {
        display:    "flex",
        alignItems: "center",
        gap:        "12px",
    },
    timerSvg: {
        flexShrink: 0,
    },
    timerLabel: {
        fontSize:   "13px",
        lineHeight: 1.4,
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