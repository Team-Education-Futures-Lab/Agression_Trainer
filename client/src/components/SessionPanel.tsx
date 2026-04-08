// =============================================================================
// SessionPanel
//
// Left-column section: session connect/disconnect controls and clip control
// panel. Re-renders only on discrete session state changes — never at frame rate.
// =============================================================================

import { useEffect, useState } from "react";
import type { SessionState, ScenarioSummary, ClipData } from "@ar-training/shared";

interface SessionPanelProps {
    state:           SessionState;
    capturing:       boolean;
    sessionId:       string | null;
    scenarios:       ScenarioSummary[];
    currentClipData: ClipData | null;
    connect:         (userId?: string, language?: string, adminKey?: string) => Promise<void>;
    disconnect:      () => void;
    selectScenario:  (scenarioId: string, entryClipId: string) => void;
    preloadClip:     (scenarioId: string, clipId: string) => void;
    sendClipEnded:   (clipId: string) => void;
}

export function SessionPanel({
                                 state,
                                 capturing,
                                 sessionId,
                                 scenarios,
                                 currentClipData,
                                 connect,
                                 disconnect,
                                 selectScenario,
                                 preloadClip,
                                 sendClipEnded,
                             }: SessionPanelProps) {
    // ── Connect inputs ────────────────────────────────────────────────────────
    const [userId,    setUserId]    = useState("dev-user");
    const [language,  setLanguage]  = useState("nl");
    const [adminKey,  setAdminKey]  = useState("");

    // ── Clip control state ────────────────────────────────────────────────────
    const [rcScenarioId, setRcScenarioId] = useState("");
    const [rcClipId,     setRcClipId]     = useState("");
    const [clipEndedId,  setClipEndedId]  = useState("");

    // Auto-populate scenario/clip from scenarios_list
    useEffect(() => {
        if (scenarios.length > 0 && rcScenarioId === "") {
            setRcScenarioId(scenarios[0]!.scenario_id);
            setRcClipId(scenarios[0]!.entry_clip_id);
        }
    }, [scenarios, rcScenarioId]);

    const handleScenarioChange = (id: string) => {
        setRcScenarioId(id);
        const sc = scenarios.find(s => s.scenario_id === id);
        if (sc) setRcClipId(sc.entry_clip_id);
    };

    // Auto-populate clip ID from the most recent activating clip_data
    useEffect(() => {
        if (currentClipData) {
            setRcClipId(currentClipData.clip_id);
            setClipEndedId(currentClipData.clip_id);
        }
    }, [currentClipData]);

    const hasSession = state !== "idle";

    return (
        <div style={st.panel}>
            {/* Session controls */}
            <div style={st.controlGroup}>
                <SectionLabel>Session</SectionLabel>
                {state === "idle"
                    ? <>
                        <div style={st.row}>
                            <input
                                style={{ ...st.input, width: "100px" }}
                                placeholder="user_id"
                                value={userId}
                                onChange={e => setUserId(e.target.value)}
                            />
                            <input
                                style={{ ...st.input, width: "50px" }}
                                placeholder="lang"
                                value={language}
                                onChange={e => setLanguage(e.target.value)}
                            />
                            <button
                                style={st.btn}
                                disabled={!capturing}
                                onClick={() => void connect(
                                    userId.trim()   || undefined,
                                    language.trim() || undefined,
                                    adminKey.trim() || undefined,
                                )}
                            >
                                Connect
                            </button>
                        </div>
                        <div style={{ ...st.row, marginTop: "4px" }}>
                            <input
                                style={{ ...st.input, width: "220px", ...st.adminKeyInput }}
                                placeholder="Admin key (optional)"
                                value={adminKey}
                                onChange={e => setAdminKey(e.target.value)}
                            />
                            {adminKey && (
                                <span style={st.adminKeyHint}>admin session</span>
                            )}
                        </div>
                    </>
                    : <div style={st.row}>
                        <button style={{ ...st.btn, ...st.btnDanger }} onClick={disconnect}>
                            Disconnect
                        </button>
                    </div>
                }
            </div>

            {/* Clip control panel — shown whenever a session exists */}
            {hasSession && (
                <div style={st.controlGroup}>
                    <SectionLabel>Clip control</SectionLabel>

                    {/* Scenario selector */}
                    <div style={{ ...st.row, marginBottom: "6px" }}>
                        {scenarios.length > 0
                            ? <select
                                style={st.select}
                                value={rcScenarioId}
                                onChange={e => handleScenarioChange(e.target.value)}
                            >
                                {scenarios.map(sc => (
                                    <option key={sc.scenario_id} value={sc.scenario_id}>
                                        {sc.scenario_id} — {sc.title}
                                    </option>
                                ))}
                            </select>
                            : <input
                                style={st.input}
                                placeholder="scenario_id"
                                value={rcScenarioId}
                                onChange={e => setRcScenarioId(e.target.value)}
                            />
                        }
                    </div>

                    {/* Clip ID + request/activate buttons */}
                    <div style={{ ...st.row, marginBottom: "6px" }}>
                        <input
                            style={st.input}
                            placeholder="clip_id"
                            value={rcClipId}
                            onChange={e => setRcClipId(e.target.value)}
                        />
                        <button
                            style={st.btn}
                            disabled={!sessionId || !rcScenarioId || !rcClipId}
                            onClick={() => preloadClip(rcScenarioId, rcClipId)}
                            title="Sends request_clip with activate: false"
                        >
                            Request clip
                        </button>
                        <button
                            style={{ ...st.btn, ...st.btnPrimary }}
                            disabled={state !== "selecting" || !rcScenarioId || !rcClipId}
                            onClick={() => selectScenario(rcScenarioId, rcClipId)}
                            title="Sends request_clip with activate: true — only valid in selecting state"
                        >
                            Activate clip
                        </button>
                    </div>

                    {/* ClipEnded */}
                    <div style={st.row}>
                        <input
                            style={st.input}
                            placeholder="clip_id for ClipEnded"
                            value={clipEndedId}
                            onChange={e => setClipEndedId(e.target.value)}
                        />
                        <button
                            style={st.btn}
                            disabled={state !== "active" || !clipEndedId.trim()}
                            onClick={() => sendClipEnded(clipEndedId.trim())}
                        >
                            Send ClipEnded
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <div style={st.sectionLabel}>{children}</div>;
}

const st = {
    panel:         { display: "flex", flexDirection: "column" as const, gap: "12px" },
    controlGroup:  { display: "flex", flexDirection: "column" as const, gap: "2px" },
    sectionLabel:  { fontSize: "10px", color: "#555", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: "4px" },
    row:           { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" as const },
    btn:           { padding: "5px 10px", fontSize: "12px", cursor: "pointer", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px" },
    btnDanger:     { background: "#4a1a1a", borderColor: "#822" },
    btnPrimary:    { background: "#1a2a4a", borderColor: "#2a4a8a", color: "#7ab0f0" },
    input:         { padding: "5px 8px", fontSize: "12px", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", width: "140px" },
    select:        { padding: "5px 8px", fontSize: "12px", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", maxWidth: "340px" },
    adminKeyInput: { border: "1px solid #7a5400", color: "#f5a623" } as React.CSSProperties,
    adminKeyHint:  { fontSize: "11px", color: "#f5a623", opacity: 0.8 } as React.CSSProperties,
} as const;