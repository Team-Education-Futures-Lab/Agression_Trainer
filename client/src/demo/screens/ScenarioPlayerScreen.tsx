import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { CaptureSession } from "../../capture";

interface PlayerProps {
    capture:    CaptureSession;
    transcript: string;
    connected:  boolean;
    clipNum:    number;
    onClipEnd:  () => void;
}

export function ScenarioPlayerScreen({ capture, transcript, connected, clipNum, onClipEnd }: PlayerProps) {
    const webcamRef = useRef<HTMLVideoElement | null>(null);

    useEffect(() => {
        const el = webcamRef.current;
        if (!el) return;
        const stream = capture.getStream();
        if (!stream) return;
        el.srcObject = stream;
        el.play().catch(() => {});
    }, [capture]);

    return (
        <div style={ps.root}>
            <div style={ps.header}>
                <span style={ps.logo}>AR Training</span>
                <span style={ps.clip}>Beurt {clipNum}</span>
                <div style={{ flex: 1 }} />
                <RecIndicator connected={connected} />
            </div>

            <div style={ps.main}>
                <div style={ps.videoCol}>
                    <div style={ps.videoWrap}>
                        <div style={ps.videoPlaceholder}>
                            <div style={ps.playIcon}>▶</div>
                            <span style={ps.playLabel}>Scenario — Beurt {clipNum}</span>
                        </div>
                        <div style={ps.insetWrap}>
                            <video ref={webcamRef} muted playsInline style={ps.inset} />
                            <div style={ps.insetLabel}>Jij</div>
                        </div>
                    </div>

                    <div style={ps.transcriptCard}>
                        <div style={ps.transcriptHeader}>
                            <span style={transcriptDotStyle(connected)} />
                            <span style={ps.transcriptTitle}>
                                {connected ? "Live transcriptie" : "Verbinding maken…"}
                            </span>
                        </div>
                        <p style={ps.transcriptText}>
                            {transcript || <span style={{ color: "#484f58" }}>Jouw reactie verschijnt hier terwijl je spreekt…</span>}
                        </p>
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

// Pulled out of the style record — called directly in JSX
function transcriptDotStyle(connected: boolean): CSSProperties {
    return { width: 7, height: 7, borderRadius: "50%", background: connected ? "#3fb950" : "#484f58", flexShrink: 0 };
}

function RecIndicator({ connected }: { connected: boolean }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
                width: 8, height: 8, borderRadius: "50%",
                background: connected ? "#f85149" : "#484f58",
                animation: connected ? "pulse 1.4s ease-in-out infinite" : "none",
            }} />
            <span style={{ fontSize: 12, color: connected ? "#f85149" : "#484f58", fontWeight: 600, letterSpacing: 0.5 }}>
                {connected ? "REC" : "—"}
            </span>
            <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }`}</style>
        </div>
    );
}

function Tag({ text }: { text: string }) {
    return <span style={{ background: "#21262d", border: "1px solid #30363d", borderRadius: 6, padding: "3px 10px", fontSize: 12, color: "#8b949e" }}>{text}</span>;
}

const ps: Record<string, CSSProperties> = {
    root:             { minHeight: "100vh", display: "flex", flexDirection: "column", background: "#0d1117", color: "#e6edf3" },
    header:           { padding: "12px 24px", borderBottom: "1px solid #21262d", display: "flex", alignItems: "center", gap: 16, flexShrink: 0 },
    logo:             { fontSize: 13, fontWeight: 700, letterSpacing: 3, color: "#388bfd", textTransform: "uppercase" },
    clip:             { fontSize: 12, color: "#484f58", background: "#161b22", border: "1px solid #30363d", borderRadius: 6, padding: "2px 10px" },
    main:             { flex: 1, display: "flex", gap: 20, padding: 24, overflow: "hidden" },
    videoCol:         { flex: 1, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 },
    videoWrap:        { position: "relative", borderRadius: 12, overflow: "hidden", background: "#161b22", border: "1px solid #21262d", aspectRatio: "16/9" },
    videoPlaceholder: { width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 },
    playIcon:         { fontSize: 40, color: "#30363d" },
    playLabel:        { fontSize: 13, color: "#484f58", letterSpacing: 1 },
    insetWrap:        { position: "absolute", bottom: 12, right: 12, width: 120, borderRadius: 8, overflow: "hidden", border: "2px solid #30363d", background: "#0d1117" },
    inset:            { width: "100%", display: "block", aspectRatio: "4/3", objectFit: "cover" },
    insetLabel:       { position: "absolute", bottom: 4, left: 6, fontSize: 10, color: "#8b949e", background: "#0d111799", padding: "1px 4px", borderRadius: 3 },
    transcriptCard:   { background: "#161b22", border: "1px solid #21262d", borderRadius: 12, padding: "16px 20px", minHeight: 100 },
    transcriptHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
    transcriptTitle:  { fontSize: 11, color: "#8b949e", letterSpacing: 1, textTransform: "uppercase" },
    transcriptText:   { fontSize: 15, color: "#c9d1d9", lineHeight: 1.7, minHeight: 48 },
    rightCol:         { width: 280, display: "flex", flexDirection: "column", gap: 16, flexShrink: 0 },
    infoCard:         { background: "#161b22", border: "1px solid #21262d", borderRadius: 12, padding: "16px 20px" },
    infoHeading:      { fontSize: 12, fontWeight: 700, color: "#388bfd", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 },
    infoText:         { fontSize: 14, color: "#8b949e", lineHeight: 1.6 },
    tagRow:           { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 },
    tipsList:         { listStyle: "none", display: "flex", flexDirection: "column", gap: 8 },
    tip:              { fontSize: 13, color: "#8b949e", paddingLeft: 12, borderLeft: "2px solid #1f6feb" },
    doneBtn:          { marginTop: "auto", padding: "14px 0", background: "#238636", color: "#fff", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer" },
};
