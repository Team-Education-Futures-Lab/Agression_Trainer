import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

interface EvalProps { onDone: () => void; }

export function EvaluatingScreen({ onDone }: EvalProps) {
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        const start = performance.now();
        const duration = 2800;
        let raf: number;
        const tick = () => {
            const t = Math.min(1, (performance.now() - start) / duration);
            setProgress(t);
            if (t < 1) { raf = requestAnimationFrame(tick); }
            else { setTimeout(onDone, 300); }
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);

    const pct = Math.round(progress * 100);

    return (
        <div style={ev.root}>
            <div style={ev.card}>
                <div style={ev.spinnerWrap}>
                    <svg width="72" height="72" viewBox="0 0 72 72">
                        <circle cx="36" cy="36" r="30" fill="none" stroke="#21262d" strokeWidth="5" />
                        <circle
                            cx="36" cy="36" r="30" fill="none"
                            stroke="#1f6feb" strokeWidth="5"
                            strokeLinecap="round"
                            strokeDasharray={`${2 * Math.PI * 30}`}
                            strokeDashoffset={`${2 * Math.PI * 30 * (1 - progress)}`}
                            transform="rotate(-90 36 36)"
                            style={{ transition: "stroke-dashoffset 0.05s linear" }}
                        />
                    </svg>
                    <span style={ev.pct}>{pct}%</span>
                </div>
                <h2 style={ev.heading}>Reactie wordt geanalyseerd…</h2>
                <p style={ev.sub}>
                    Het systeem verwerkt je spraak, gezichtsuitdrukking en lichaamshouding.
                </p>
                <div style={ev.barTrack}>
                    <div style={{ ...ev.barFill, width: `${pct}%` }} />
                </div>
                <div style={ev.pills}>
                    <Pill label="Stemanalyse"          done={progress > 0.3} />
                    <Pill label="Gezichtsherkenning"   done={progress > 0.6} />
                    <Pill label="Gedragsclassificatie" done={progress > 0.9} />
                </div>
            </div>
        </div>
    );
}

function Pill({ label, done }: { label: string; done: boolean }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: done ? "#3fb950" : "#484f58" }}>
            <span>{done ? "✓" : "○"}</span>
            <span>{label}</span>
        </div>
    );
}

const ev: Record<string, CSSProperties> = {
    root:        { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d1117" },
    card:        { maxWidth: 420, width: "100%", background: "#161b22", border: "1px solid #30363d", borderRadius: 16, padding: "48px 40px", display: "flex", flexDirection: "column", alignItems: "center", gap: 20 },
    spinnerWrap: { position: "relative", width: 72, height: 72 },
    pct:         { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: "#e6edf3" },
    heading:     { fontSize: 20, fontWeight: 700, color: "#e6edf3", textAlign: "center" },
    sub:         { fontSize: 13, color: "#8b949e", textAlign: "center", lineHeight: 1.6 },
    barTrack:    { width: "100%", height: 4, background: "#21262d", borderRadius: 4, overflow: "hidden" },
    barFill:     { height: "100%", background: "#1f6feb", borderRadius: 4, transition: "width 0.05s linear" },
    pills:       { display: "flex", flexDirection: "column", gap: 8, alignSelf: "flex-start", width: "100%" },
};