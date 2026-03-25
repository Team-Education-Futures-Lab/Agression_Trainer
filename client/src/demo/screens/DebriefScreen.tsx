import type { SessionComplete } from "@ar-training/shared";

interface DebriefScreenProps {
    streamedAdvice:      string;
    finalMessage:        SessionComplete | null;
    feedbackUnavailable: boolean;
    onRestart:           () => void;
}

export function DebriefScreen({
                                  streamedAdvice, finalMessage, feedbackUnavailable, onRestart,
                              }: DebriefScreenProps) {
    const complete   = finalMessage !== null;
    const advice     = complete ? finalMessage.advice : streamedAdvice;
    const severity   = finalMessage?.severity;
    const highlights = finalMessage?.highlights ?? [];

    if (feedbackUnavailable) {
        return (
            <div style={s.root}>
                <div style={s.card}>
                    <h2 style={s.title}>Sessie afgerond</h2>
                    <div style={s.errorBox}>
                        <p style={s.errorText}>
                            De feedbackservice is momenteel niet beschikbaar. Je sessie is
                            succesvol afgerond, maar er kan nu geen persoonlijke terugkoppeling
                            worden gegenereerd. Probeer het later opnieuw.
                        </p>
                    </div>
                    <button style={s.btn} onClick={onRestart}>
                        Nieuwe sessie starten
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div style={s.root}>
            <div style={s.card}>
                <div style={s.header}>
                    <h2 style={s.title}>Sessie afgerond</h2>
                    {severity && (
                        <span style={{ ...s.badge, ...severityStyle[severity] }}>
                            {severity}
                        </span>
                    )}
                </div>

                {/* Streamed advice with blinking cursor while generating */}
                <div style={s.adviceBox}>
                    <p style={s.adviceText}>
                        {advice || <span style={s.placeholder}>Feedback wordt gegenereerd…</span>}
                        {!complete && advice && <span style={s.cursor}>▋</span>}
                    </p>
                </div>

                {/* Highlights — only shown once complete */}
                {highlights.length > 0 && (
                    <div style={s.highlights}>
                        <p style={s.highlightsLabel}>Opmerkelijke momenten</p>
                        <ul style={s.highlightsList}>
                            {highlights.map((h, i) => (
                                <li key={i} style={s.highlightItem}>{h}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {complete && (
                    <button style={s.btn} onClick={onRestart}>
                        Nieuwe sessie starten
                    </button>
                )}
            </div>
        </div>
    );
}

const severityStyle: Record<string, React.CSSProperties> = {
    low:    { background: "#14532d", color: "#86efac" },
    medium: { background: "#713f12", color: "#fcd34d" },
    high:   { background: "#7f1d1d", color: "#fca5a5" },
};

const s = {
    root: {
        minHeight:      "100vh",
        display:        "flex",
        alignItems:     "flex-start",
        justifyContent: "center",
        background:     "#0f172a",
        padding:        "40px 24px",
    },
    card: {
        maxWidth:     "600px",
        width:        "100%",
        background:   "#1e293b",
        borderRadius: "12px",
        padding:      "36px",
        boxShadow:    "0 8px 32px rgba(0,0,0,0.4)",
    },
    header: {
        display:      "flex",
        alignItems:   "center",
        gap:          "12px",
        marginBottom: "20px",
    },
    title: {
        margin:     0,
        fontSize:   "22px",
        fontWeight: "700" as const,
        color:      "#f1f5f9",
    },
    badge: {
        padding:       "3px 10px",
        borderRadius:  "999px",
        fontSize:      "12px",
        fontWeight:    "600" as const,
        textTransform: "uppercase" as const,
        letterSpacing: "0.05em",
    },
    adviceBox: {
        background:   "#0f172a",
        borderRadius: "8px",
        padding:      "16px 18px",
        marginBottom: "20px",
        minHeight:    "80px",
    },
    adviceText: {
        margin:     0,
        fontSize:   "15px",
        color:      "#cbd5e1",
        lineHeight: 1.7,
        whiteSpace: "pre-wrap" as const,
    },
    placeholder: {
        color:     "#475569",
        fontStyle: "italic",
    },
    cursor: {
        color:     "#6366f1",
        animation: "blink 1s step-end infinite",
    },
    highlights: {
        marginBottom: "24px",
    },
    highlightsLabel: {
        margin:        "0 0 8px",
        fontSize:      "11px",
        color:         "#475569",
        textTransform: "uppercase" as const,
        letterSpacing: "0.08em",
    },
    highlightsList: {
        margin:  0,
        padding: "0 0 0 16px",
    },
    highlightItem: {
        fontSize:     "13px",
        color:        "#94a3b8",
        lineHeight:   1.6,
        marginBottom: "4px",
    },
    errorBox: {
        background:   "#1c1019",
        border:       "1px solid #7f1d1d",
        borderRadius: "8px",
        padding:      "16px 18px",
        marginBottom: "20px",
    },
    errorText: {
        margin:     0,
        fontSize:   "14px",
        color:      "#fca5a5",
        lineHeight: 1.6,
    },
    btn: {
        width:        "100%",
        padding:      "13px",
        fontSize:     "15px",
        fontWeight:   "600" as const,
        background:   "#6366f1",
        color:        "#fff",
        border:       "none",
        borderRadius: "8px",
        cursor:       "pointer",
    },
} as const;