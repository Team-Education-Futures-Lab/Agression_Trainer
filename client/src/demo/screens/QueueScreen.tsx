import type { CSSProperties } from "react";

export function QueueScreen() {
    return (
        <div style={qs.root}>
            <div style={qs.card}>
                <div style={qs.dotsRow}>
                    {[0, 1, 2].map(i => (
                        <div key={i} style={dotStyle(i)} />
                    ))}
                    <style>{`
                        @keyframes qbounce {
                            0%,100% { transform: translateY(0); opacity:.4; }
                            50%      { transform: translateY(-8px); opacity:1; }
                        }
                    `}</style>
                </div>
                <h2 style={qs.heading}>Even geduld…</h2>
                <p style={qs.sub}>Er zijn momenteel veel actieve sessies. Je bent in de wachtrij geplaatst.</p>
                <div style={qs.posCard}>
                    <span style={qs.posLabel}>Jouw positie</span>
                    <span style={qs.posNum}>3</span>
                </div>
                <p style={qs.hint}>De pagina wordt automatisch bijgewerkt zodra je aan de beurt bent.</p>
            </div>
        </div>
    );
}

// Pulled out of the style record — called directly in JSX
function dotStyle(i: number): CSSProperties {
    return { width: 12, height: 12, borderRadius: "50%", background: "#1f6feb", animation: `qbounce 1.2s ease-in-out ${i * 0.2}s infinite` };
}

const qs: Record<string, CSSProperties> = {
    root:     { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d1117" },
    card:     { maxWidth: 400, width: "100%", background: "#161b22", border: "1px solid #30363d", borderRadius: 16, padding: "48px 40px", display: "flex", flexDirection: "column", alignItems: "center", gap: 20, textAlign: "center" },
    dotsRow:  { display: "flex", gap: 10 },
    heading:  { fontSize: 22, fontWeight: 700, color: "#e6edf3" },
    sub:      { fontSize: 14, color: "#8b949e", lineHeight: 1.6 },
    posCard:  { background: "#0d1117", border: "1px solid #30363d", borderRadius: 12, padding: "20px 40px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
    posLabel: { fontSize: 11, color: "#484f58", letterSpacing: 2, textTransform: "uppercase" },
    posNum:   { fontSize: 48, fontWeight: 700, color: "#388bfd" },
    hint:     { fontSize: 12, color: "#484f58" },
};
