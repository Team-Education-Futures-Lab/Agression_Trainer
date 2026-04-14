// =============================================================================
// ScenarioScreen
//
// Shown while state === "selecting". Displays all available scenarios with
// title and description. Shows a spinner while scenarios.length === 0.
// Tapping a scenario card calls onSelect, which triggers selectScenario()
// and starts the capture pipeline.
// =============================================================================

import type { ScenarioSummary } from "@ar-training/shared";

interface ScenarioScreenProps {
    scenarios: ScenarioSummary[];
    onSelect:  (scenario: ScenarioSummary) => void;
}

export function ScenarioScreen({ scenarios, onSelect }: ScenarioScreenProps) {
    return (
        <div style={s.root}>
            <div style={s.container}>
                <h2 style={s.title}>Kies een scenario</h2>
                <p style={s.subtitle}>
                    Selecteer het scenario dat je wilt oefenen. Je kunt meerdere
                    sessies doen om verschillende situaties te oefenen.
                </p>

                {scenarios.length === 0 ? (
                    <div style={s.loadingWrap}>
                        <div style={s.spinner} />
                        <p style={s.loadingText}>Scenario's worden geladen…</p>
                    </div>
                ) : (
                    <div style={s.list}>
                        {scenarios.map(sc => (
                            <button
                                key={sc.scenario_id}
                                style={s.card}
                                onClick={() => onSelect(sc)}
                            >
                                <span style={s.cardTitle}>{sc.title}</span>
                                <span style={s.cardDesc}>{sc.description}</span>
                                <span style={s.cardCta}>Begin →</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

const s: Record<string, React.CSSProperties> = {
    root: {
        minHeight:      "100vh",
        display:        "flex",
        alignItems:     "flex-start",
        justifyContent: "center",
        background:     "#0f172a",
        padding:        "48px 24px",
    },
    container: {
        maxWidth: "560px",
        width:    "100%",
    },
    title: {
        margin:     "0 0 10px",
        fontSize:   "24px",
        fontWeight: "700",
        color:      "#f1f5f9",
    },
    subtitle: {
        margin:     "0 0 32px",
        fontSize:   "15px",
        color:      "#94a3b8",
        lineHeight: 1.6,
    },
    loadingWrap: {
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "center",
        gap:            "16px",
        padding:        "40px 0",
    },
    spinner: {
        width:          "36px",
        height:         "36px",
        borderRadius:   "50%",
        border:         "3px solid #334155",
        borderTopColor: "#6366f1",
        animation:      "spin 0.9s linear infinite",
    },
    loadingText: {
        margin:    0,
        fontSize:  "14px",
        color:     "#475569",
        fontStyle: "italic",
    },
    list: {
        display:       "flex",
        flexDirection: "column",
        gap:           "12px",
    },
    card: {
        display:       "flex",
        flexDirection: "column",
        alignItems:    "flex-start",
        gap:           "6px",
        width:         "100%",
        padding:       "20px 22px",
        background:    "#1e293b",
        border:        "1px solid #334155",
        borderRadius:  "10px",
        cursor:        "pointer",
        textAlign:     "left",
        transition:    "border-color 0.15s",
    },
    cardTitle: {
        fontSize:   "16px",
        fontWeight: "600",
        color:      "#f1f5f9",
    },
    cardDesc: {
        fontSize:   "13px",
        color:      "#94a3b8",
        lineHeight: 1.5,
    },
    cardCta: {
        marginTop:  "6px",
        fontSize:   "13px",
        fontWeight: "600",
        color:      "#6366f1",
    },
};