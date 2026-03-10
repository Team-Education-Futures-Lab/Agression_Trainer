import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { CaptureSession } from "../../capture";

interface Props {
    capture:   CaptureSession;
    /** URL of the scenario clip to play, or null if not yet available. */
    videoSrc:  string | null;
    clipId:    string;
    clipNum:   number;
    onClipEnd: () => void;
}

export function ScenarioPlayerScreen({ capture, videoSrc, clipId, clipNum, onClipEnd }: Props) {
    const webcamRef   = useRef<HTMLVideoElement | null>(null);
    const scenarioRef = useRef<HTMLVideoElement | null>(null);
    const [videoError, setVideoError] = useState(false);

    // Attach webcam stream to the inset preview
    useEffect(() => {
        const el = webcamRef.current;
        if (!el) return;
        const stream = capture.getStream();
        if (!stream) return;
        el.srcObject = stream;
        el.play().catch(() => {});
    }, [capture]);

    // Load scenario clip whenever videoSrc changes
    useEffect(() => {
        setVideoError(false);
        const el = scenarioRef.current;
        if (!el || !videoSrc) return;
        el.load();
    }, [videoSrc]);

    const showPlaceholder = !videoSrc || videoError;

    return (
        <div style={ps.root}>
            <div style={ps.header}>
                <span style={ps.logo}>AR Training</span>
                <span style={ps.clip}>Beurt {clipNum}</span>
                <div style={{ flex: 1 }} />
                <StatusIndicator clipId={clipId} />
            </div>

            <div style={ps.main}>
                <div style={ps.videoCol}>
                    {/* ── Scenario video / placeholder ── */}
                    <div style={ps.videoWrap}>
                        {showPlaceholder ? (
                            <div style={ps.placeholder}>
                                <div style={ps.playIcon}>▶</div>
                                <span style={ps.playLabel}>Scenario — Beurt {clipNum}</span>
                                {videoError && (
                                    <span style={ps.playHint}>Videofragment niet beschikbaar</span>
                                )}
                            </div>
                        ) : (
                            <video
                                ref={scenarioRef}
                                src={videoSrc}
                                controls
                                autoPlay
                                style={ps.scenarioVideo}
                                onError={() => setVideoError(true)}
                            />
                        )}

                        {/* Webcam inset */}
                        <div style={ps.insetWrap}>
                            <video ref={webcamRef} muted playsInline style={ps.inset} />
                            <div style={ps.insetLabel}>Jij</div>
                        </div>
                    </div>

                    {/* Status bar — replaces transcript panel */}
                    <div style={ps.statusBar}>
                        <span style={ps.statusDot} />
                        <span style={ps.statusText}>Reactie wordt opgenomen — spreek nu</span>
                    </div>
                </div>

                <div style={ps.rightCol}>
                    <div style={ps.infoCard}>
                        <h2 style={ps.infoHeading}>Situatie</h2>
                        <p style={ps.infoText}>
                            Een student is gefrustreerd over zijn cijfer en spreekt je direct aan.
                            Probeer de situatie te de-escaleren met een rustige, constructieve reactie.
                        </p>
                        <div style={ps.tagRow}>
                            <Tag text="Verhoogde stem" />
                            <Tag text="Agressieve houding" />
                        </div>
                    </div>

                    <div style={ps.infoCard}>
                        <h2 style={ps.infoHeading}>Tips</h2>
                        <ul style={ps.tipsList}>
                            <li style={ps.tip}>Spreek kalm en duidelijk</li>
                            <li style={ps.tip}>Erken de gevoelens van de student</li>
                            <li style={ps.tip}>Vermijd defensieve taal</li>
                        </ul>
                    </div>

                    <button style={ps.doneBtn} onClick={onClipEnd}>
                        Klaar met reageren →
                    </button>
                </div>
            </div>
        </div>
    );
}

function StatusIndicator({ clipId }: { clipId: string }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={recDot} />
            <span style={recLabel}>REC</span>
            <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }`}</style>
            <span style={clipLabel}>{clipId}</span>
        </div>
    );
}

const recDot: CSSProperties = {
    width: 8, height: 8, borderRadius: "50%", background: "#f85149",
    animation: "pulse 1.4s ease-in-out infinite",
};
const recLabel: CSSProperties  = { fontSize: 12, color: "#f85149", fontWeight: 600, letterSpacing: 0.5 };
const clipLabel: CSSProperties = { fontSize: 11, color: "#484f58", marginLeft: 4 };

function Tag({ text }: { text: string }) {
    return (
        <span style={{ background: "#21262d", border: "1px solid #30363d", borderRadius: 6, padding: "3px 10px", fontSize: 12, color: "#8b949e" }}>
            {text}
        </span>
    );
}

const ps: Record<string, CSSProperties> = {
    root:          { minHeight: "100vh", display: "flex", flexDirection: "column", background: "#0d1117", color: "#e6edf3" },
    header:        { padding: "12px 24px", borderBottom: "1px solid #21262d", display: "flex", alignItems: "center", gap: 16, flexShrink: 0 },
    logo:          { fontSize: 13, fontWeight: 700, letterSpacing: 3, color: "#388bfd", textTransform: "uppercase" },
    clip:          { fontSize: 12, color: "#484f58", background: "#161b22", border: "1px solid #30363d", borderRadius: 6, padding: "2px 10px" },
    main:          { flex: 1, display: "flex", gap: 20, padding: 24, overflow: "hidden" },
    videoCol:      { flex: 1, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 },
    videoWrap:     { position: "relative", borderRadius: 12, overflow: "hidden", background: "#161b22", border: "1px solid #21262d", aspectRatio: "16/9" },
    scenarioVideo: { width: "100%", height: "100%", display: "block", objectFit: "contain", background: "#000" },
    placeholder:   { width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 },
    playIcon:      { fontSize: 40, color: "#30363d" },
    playLabel:     { fontSize: 13, color: "#484f58", letterSpacing: 1 },
    playHint:      { fontSize: 11, color: "#f85149", marginTop: 4 },
    insetWrap:     { position: "absolute", bottom: 12, right: 12, width: 120, borderRadius: 8, overflow: "hidden", border: "2px solid #30363d", background: "#0d1117" },
    inset:         { width: "100%", display: "block", aspectRatio: "4/3", objectFit: "cover" },
    insetLabel:    { position: "absolute", bottom: 4, left: 6, fontSize: 10, color: "#8b949e", background: "#0d111799", padding: "1px 4px", borderRadius: 3 },
    statusBar:     { background: "#161b22", border: "1px solid #21262d", borderRadius: 12, padding: "12px 20px", display: "flex", alignItems: "center", gap: 10 },
    statusDot:     { width: 7, height: 7, borderRadius: "50%", background: "#3fb950", flexShrink: 0 },
    statusText:    { fontSize: 13, color: "#8b949e" },
    rightCol:      { width: 280, display: "flex", flexDirection: "column", gap: 16, flexShrink: 0 },
    infoCard:      { background: "#161b22", border: "1px solid #21262d", borderRadius: 12, padding: "16px 20px" },
    infoHeading:   { fontSize: 12, fontWeight: 700, color: "#388bfd", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 },
    infoText:      { fontSize: 14, color: "#8b949e", lineHeight: 1.6 },
    tagRow:        { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 },
    tipsList:      { listStyle: "none", display: "flex", flexDirection: "column", gap: 8 },
    tip:           { fontSize: 13, color: "#8b949e", paddingLeft: 12, borderLeft: "2px solid #1f6feb" },
    doneBtn:       { marginTop: "auto", padding: "14px 0", background: "#238636", color: "#fff", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer" },
};