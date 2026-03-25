import { useEffect, useState } from "react";

const STEPS = [
    "Transcriptie verwerken…",
    "Gedrag analyseren…",
    "Volgende clip bepalen…",
];

export function EvaluatingScreen() {
    const [step, setStep] = useState(0);

    useEffect(() => {
        const id = setInterval(() => {
            setStep(s => Math.min(s + 1, STEPS.length - 1));
        }, 1200);
        return () => clearInterval(id);
    }, []);

    return (
        <div style={s.root}>
            <div style={s.card}>
                <div style={s.bars}>
                    {[0, 1, 2, 3].map(i => (
                        <div key={i} style={{ ...s.bar, animationDelay: `${i * 0.15}s` }} />
                    ))}
                </div>
                <p style={s.step}>{STEPS[step]}</p>
            </div>
        </div>
    );
}

const s = {
    root: {
        minHeight:      "100vh",
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        background:     "#0f172a",
    },
    card: {
        textAlign:    "center" as const,
        padding:      "48px 40px",
        background:   "#1e293b",
        borderRadius: "12px",
        maxWidth:     "320px",
        width:        "100%",
        boxShadow:    "0 8px 32px rgba(0,0,0,0.4)",
    },
    bars: {
        display:        "flex",
        justifyContent: "center",
        alignItems:     "flex-end",
        gap:            "5px",
        height:         "40px",
        marginBottom:   "20px",
    },
    bar: {
        width:        "6px",
        borderRadius: "3px",
        background:   "#6366f1",
        animation:    "bounce 0.7s ease-in-out infinite alternate",
    },
    step: {
        margin:   0,
        fontSize: "15px",
        color:    "#94a3b8",
    },
} as const;