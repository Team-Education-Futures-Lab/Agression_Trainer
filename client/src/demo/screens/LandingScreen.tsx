interface LandingScreenProps {
    ready:     boolean;
    onConnect: () => Promise<void>;
}

export function LandingScreen({ ready, onConnect }: LandingScreenProps) {
    const handleStart = async () => {
        await onConnect();
    };

    return (
        <div style={s.root}>
            <div style={s.card}>
                <h1 style={s.title}>De-escalatietraining</h1>
                <p style={s.description}>
                    Je krijgt een videoscenario te zien van een uitdagende situatie in de klas.
                    Reageer zoals je dat in het echt zou doen — je reactie wordt geanalyseerd
                    en aan het einde ontvang je persoonlijke feedback.
                </p>
                <p style={s.hint}>
                    Zorg dat je camera en microfoon beschikbaar zijn voordat je begint.
                </p>
                <button
                    style={{ ...s.btn, ...(!ready ? s.btnDisabled : {}) }}
                    disabled={!ready}
                    onClick={() => void handleStart()}
                >
                    {ready ? "Begin sessie" : "Modellen laden…"}
                </button>
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
        padding:        "24px",
    },
    card: {
        maxWidth:     "480px",
        width:        "100%",
        background:   "#1e293b",
        borderRadius: "12px",
        padding:      "40px 36px",
        boxShadow:    "0 8px 32px rgba(0,0,0,0.4)",
    },
    title: {
        margin:     "0 0 16px",
        fontSize:   "24px",
        fontWeight: "700" as const,
        color:      "#f1f5f9",
        lineHeight: 1.2,
    },
    description: {
        margin:     "0 0 16px",
        fontSize:   "15px",
        color:      "#94a3b8",
        lineHeight: 1.6,
    },
    hint: {
        margin:       "0 0 32px",
        fontSize:     "13px",
        color:        "#475569",
        lineHeight:   1.5,
        borderLeft:   "3px solid #334155",
        paddingLeft:  "12px",
    },
    btn: {
        width:        "100%",
        padding:      "14px",
        fontSize:     "16px",
        fontWeight:   "600" as const,
        background:   "#6366f1",
        color:        "#fff",
        border:       "none",
        borderRadius: "8px",
        cursor:       "pointer",
    },
    btnDisabled: {
        background: "#334155",
        color:      "#64748b",
        cursor:     "not-allowed",
    },
} as const;
