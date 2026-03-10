import type { CSSProperties } from "react";

// No props — this screen is purely presentational.
// Transitions away from it are driven by incoming server messages
// (ClipReady or SessionComplete), not by a local timer.
export function EvaluatingScreen() {
    return (
        <div style={ev.root}>
            <div style={ev.card}>
                <div style={ev.spinnerWrap}>
                    <svg width="72" height="72" viewBox="0 0 72 72" style={ev.spinSvg}>
                        <circle cx="36" cy="36" r="30" fill="none" stroke="#21262d" strokeWidth="5" />
                        <circle
                            cx="36" cy="36" r="30" fill="none"
                            stroke="#1f6feb" strokeWidth="5"
                            strokeLinecap="round"
                            strokeDasharray={`${2 * Math.PI * 30 * 0.75} ${2 * Math.PI * 30 * 0.25}`}
                            transform="rotate(-90 36 36)"
                        />
                    </svg>
                </div>
                <h2 style={ev.heading}>Reactie wordt geanalyseerd…</h2>
                <p style={ev.sub}>
                    Het systeem verwerkt je spraak, gezichtsuitdrukking en lichaamshouding.
                </p>
                <div style={ev.pills}>
                    <Pill label="Stemanalyse" />
                    <Pill label="Gezichtsherkenning" />
                    <Pill label="Gedragsclassificatie" />
                </div>
                <style>{`
                    @keyframes spin { to { transform: rotate(360deg); } }
                    @keyframes pill-fade {
                        0%, 66% { opacity: 0.3; }
                        33%     { opacity: 1;   }
                    }
                `}</style>
            </div>
        </div>
    );
}

function Pill({ label }: { label: string }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#484f58" }}>
            <span>○</span>
            <span>{label}</span>
        </div>
    );
}

const ev: Record<string, CSSProperties> = {
    root:        { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d1117" },
    card:        { maxWidth: 420, width: "100%", background: "#161b22", border: "1px solid #30363d", borderRadius: 16, padding: "48px 40px", display: "flex", flexDirection: "column", alignItems: "center", gap: 20 },
    spinnerWrap: { width: 72, height: 72 },
    spinSvg:     { animation: "spin 1s linear infinite" },
    heading:     { fontSize: 20, fontWeight: 700, color: "#e6edf3", textAlign: "center" },
    sub:         { fontSize: 13, color: "#8b949e", textAlign: "center", lineHeight: 1.6 },
    pills:       { display: "flex", flexDirection: "column", gap: 8, alignSelf: "flex-start", width: "100%" },
};