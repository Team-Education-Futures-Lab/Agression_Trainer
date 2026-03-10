import type { CSSProperties } from "react";

interface Props {
    advice:     string;
    severity:   "low" | "medium" | "high";
    highlights: string[];
    onRestart:  () => void;
}

export function DebriefScreen({ advice, severity, highlights, onRestart }: Props) {
    return (
        <div style={db.root}>
            <div style={db.card}>
                <div style={db.topRow}>
                    <span style={db.logo}>AR Training</span>
                    <SeverityBadge severity={severity} />
                </div>

                <h1 style={db.heading}>Sessie afgerond</h1>
                <p style={db.subhead}>Hier is je persoonlijke terugkoppeling</p>

                <div style={db.section}>
                    <h2 style={db.sectionTitle}>Advies</h2>
                    <p style={db.advice}>{advice}</p>
                </div>

                {highlights.length > 0 && (
                    <div style={db.section}>
                        <h2 style={db.sectionTitle}>Opvallende momenten</h2>
                        <ul style={db.highlights}>
                            {highlights.map((hl, i) => (
                                <li key={i} style={db.highlight}>
                                    <span style={db.hlIcon}>↑</span>
                                    {hl}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <div style={db.btnRow}>
                    <button style={db.secondaryBtn} onClick={onRestart}>Opnieuw proberen</button>
                    <button style={db.primaryBtn}   onClick={onRestart}>Sessie beëindigen</button>
                </div>
            </div>
        </div>
    );
}

function SeverityBadge({ severity }: { severity: "low" | "medium" | "high" }) {
    const cfg = {
        low:    { label: "Laag risico", bg: "#0f2d1a", border: "#238636", text: "#3fb950" },
        medium: { label: "Gemiddeld",   bg: "#2d1f00", border: "#9e6a03", text: "#d29922" },
        high:   { label: "Hoog risico", bg: "#2d0d0d", border: "#f85149", text: "#f85149" },
    }[severity];
    return (
        <div style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 8, padding: "4px 12px", fontSize: 12, fontWeight: 700, color: cfg.text }}>
            {cfg.label}
        </div>
    );
}

const db: Record<string, CSSProperties> = {
    root:         { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d1117", padding: 24 },
    card:         { maxWidth: 640, width: "100%", background: "#161b22", border: "1px solid #30363d", borderRadius: 16, padding: "40px", display: "flex", flexDirection: "column", gap: 24 },
    topRow:       { display: "flex", alignItems: "center", justifyContent: "space-between" },
    logo:         { fontSize: 12, fontWeight: 700, letterSpacing: 3, color: "#388bfd", textTransform: "uppercase" },
    heading:      { fontSize: 26, fontWeight: 700, color: "#e6edf3" },
    subhead:      { fontSize: 14, color: "#8b949e", marginTop: -16 },
    section:      { display: "flex", flexDirection: "column", gap: 12 },
    sectionTitle: { fontSize: 11, fontWeight: 700, color: "#388bfd", letterSpacing: 2, textTransform: "uppercase" },
    advice:       { fontSize: 15, color: "#c9d1d9", lineHeight: 1.8, background: "#0d1117", borderRadius: 10, padding: "16px 20px" },
    highlights:   { listStyle: "none", display: "flex", flexDirection: "column", gap: 10 },
    highlight:    { display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, color: "#8b949e", background: "#0d1117", borderRadius: 8, padding: "10px 14px" },
    hlIcon:       { color: "#388bfd", fontWeight: 700, flexShrink: 0, marginTop: 1 },
    btnRow:       { display: "flex", gap: 12, paddingTop: 8 },
    secondaryBtn: { flex: 1, padding: "12px 0", background: "transparent", color: "#8b949e", border: "1px solid #30363d", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" },
    primaryBtn:   { flex: 1, padding: "12px 0", background: "#1f6feb", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" },
};