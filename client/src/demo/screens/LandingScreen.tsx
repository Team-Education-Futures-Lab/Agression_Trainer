import type { CSSProperties } from "react";

interface Props { onStart: () => void; }

export function LandingScreen({ onStart }: Props) {
    return (
        <div style={ls.root}>
            <div style={ls.card}>
                <div style={ls.badge}>🇳🇱 NL</div>
                <div style={ls.logo}>AR Training</div>
                <h1 style={ls.heading}>De-escalatietraining</h1>
                <p style={ls.body}>
                    In deze oefening reageer je op realistische klaslokaalscenario's.
                    Je ziet een videofragment van een lastige situatie. Reageer daarna
                    hardop, alsof je de persoon in het echt aanspreekt. Het systeem
                    analyseert je reactie en geeft aan het einde persoonlijke feedback.
                </p>
                <ul style={ls.steps}>
                    <li style={ls.step}><span style={ls.num}>1</span> Bekijk het videofragment aandachtig</li>
                    <li style={ls.step}><span style={ls.num}>2</span> Reageer hardop op de situatie</li>
                    <li style={ls.step}><span style={ls.num}>3</span> Druk op <em>Klaar</em> als je klaar bent</li>
                </ul>
                <p style={ls.hint}>Zorg dat je microfoon en camera zijn ingeschakeld.</p>
                <button style={ls.btn} onClick={onStart}>Training starten →</button>
            </div>
        </div>
    );
}

const ls: Record<string, CSSProperties> = {
    root:    { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d1117", padding: 24 },
    card:    { maxWidth: 560, width: "100%", background: "#161b22", border: "1px solid #30363d", borderRadius: 16, padding: "48px 40px", display: "flex", flexDirection: "column", gap: 20 },
    badge:   { fontSize: 13, color: "#8b949e", letterSpacing: 1 },
    logo:    { fontSize: 12, fontWeight: 700, letterSpacing: 3, color: "#388bfd", textTransform: "uppercase" },
    heading: { fontSize: 28, fontWeight: 700, color: "#e6edf3", lineHeight: 1.2 },
    body:    { fontSize: 15, color: "#8b949e", lineHeight: 1.7 },
    steps:   { listStyle: "none", display: "flex", flexDirection: "column", gap: 12 },
    step:    { display: "flex", alignItems: "center", gap: 12, fontSize: 14, color: "#c9d1d9" },
    num:     { width: 24, height: 24, borderRadius: "50%", background: "#1f6feb", color: "#fff", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } as CSSProperties,
    hint:    { fontSize: 13, color: "#484f58", borderTop: "1px solid #21262d", paddingTop: 16 },
    btn:     { marginTop: 4, padding: "14px 0", background: "#1f6feb", color: "#fff", border: "none", borderRadius: 10, fontSize: 16, fontWeight: 700, cursor: "pointer", letterSpacing: 0.5 },
};
