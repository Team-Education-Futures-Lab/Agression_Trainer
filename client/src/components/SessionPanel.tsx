// =============================================================================
// SessionPanel
//
// Left-column section: session connect/disconnect controls and clip control
// panel. Re-renders only on discrete session state changes — never at frame rate.
//
// Admin auth: a collapsible login subform calls POST /auth/login and stores the
// JWT in component state. When authenticated the token is passed to connect()
// as authToken, which the server verifies to grant admin mode. The token is
// cleared on disconnect.
// =============================================================================

import { useEffect, useState } from "react";
import type { SessionState, ScenarioSummary, ClipData } from "@ar-training/shared";
import { HTTP_BASE } from "../session-handler.ts";

interface SessionPanelProps {
    state:           SessionState;
    capturing:       boolean;
    sessionId:       string | null;
    scenarios:       ScenarioSummary[];
    currentClipData: ClipData | null;
    connect:         (userId?: string, language?: string, authToken?: string) => Promise<void>;
    disconnect:      () => void;
    selectScenario:  (scenarioId: string, entryClipId: string) => void;
    preloadClip:     (scenarioId: string, clipId: string) => void;
    sendClipEnded:   (clipId: string) => void;
}

// ─── Admin auth state ─────────────────────────────────────────────────────────

interface AdminAuth {
    token:    string;
    username: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

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
    const [userId,   setUserId]   = useState("dev-user");
    const [language, setLanguage] = useState("nl");

    // ── Admin auth ────────────────────────────────────────────────────────────
    // Stored in component state — not localStorage. A page reload clears it,
    // requiring re-login, which is the correct behaviour for a debug tool.
    const [adminAuth,        setAdminAuth]        = useState<AdminAuth | null>(null);
    const [loginExpanded,    setLoginExpanded]    = useState(false);
    const [loginUsername,    setLoginUsername]    = useState("");
    const [loginPassword,    setLoginPassword]    = useState("");
    const [loginPending,     setLoginPending]     = useState(false);
    const [loginError,       setLoginError]       = useState("");

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

    // ── Admin login ───────────────────────────────────────────────────────────

    const handleAdminLogin = async () => {
        setLoginError("");
        if (!loginUsername.trim() || !loginPassword) {
            setLoginError("Username and password are required.");
            return;
        }
        setLoginPending(true);
        try {
            const res = await fetch(`${HTTP_BASE}/auth/login`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ username: loginUsername.trim(), password: loginPassword }),
            });
            if (res.ok) {
                const body = await res.json() as { token: string; username: string; role: string };
                if (body.role !== "admin") {
                    setLoginError(`"${body.username}" is not an admin account.`);
                    setLoginPending(false);
                    return;
                }
                setAdminAuth({ token: body.token, username: body.username });
                setLoginExpanded(false);
                setLoginPassword("");
                setLoginError("");
            } else if (res.status === 401) {
                setLoginError("Invalid username or password.");
            } else {
                let msg = `Server returned ${res.status}.`;
                try { const b = await res.json() as { message?: string }; if (b.message) msg = b.message; } catch { /* ignore */ }
                setLoginError(msg);
            }
        } catch (err) {
            setLoginError(`Could not reach server: ${String(err instanceof Error ? err.message : err)}`);
        } finally {
            setLoginPending(false);
        }
    };

    const handleAdminLogout = async () => {
        if (!adminAuth) return;
        try {
            await fetch(`${HTTP_BASE}/auth/logout`, {
                method:  "POST",
                headers: { "Authorization": `Bearer ${adminAuth.token}` },
            });
        } catch { /* ignore — token expires naturally */ }
        setAdminAuth(null);
        setLoginUsername("");
        setLoginExpanded(false);
    };

    const handleDisconnect = () => {
        disconnect();
        // Don't clear adminAuth on disconnect — the user may want to reconnect
        // as admin immediately. They can log out explicitly if needed.
    };

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
                                    userId.trim()           || undefined,
                                    language.trim()         || undefined,
                                    adminAuth?.token        || undefined,
                                )}
                            >
                                Connect
                            </button>
                            {adminAuth && (
                                <span style={st.adminBadge} title={`Connecting as admin: ${adminAuth.username}`}>
                                    ADMIN
                                </span>
                            )}
                        </div>

                        {/* Admin login subform */}
                        <div style={{ marginTop: "6px" }}>
                            {!adminAuth
                                ? <>
                                    <button
                                        style={{ ...st.btn, fontSize: "11px", color: "#888" }}
                                        onClick={() => setLoginExpanded(e => !e)}
                                    >
                                        {loginExpanded ? "▼ Admin login" : "▶ Admin login"}
                                    </button>
                                    {loginExpanded && (
                                        <div style={{ ...st.row, flexDirection: "column", alignItems: "flex-start", gap: "4px", marginTop: "6px", padding: "8px", background: "#1e1e1e", border: "1px solid #2a2a2a", borderRadius: "4px" }}>
                                            {loginError && (
                                                <div style={{ fontSize: "11px", color: "#cf6f6f", marginBottom: "2px" }}>
                                                    {loginError}
                                                </div>
                                            )}
                                            <div style={{ display: "flex", gap: "6px", width: "100%" }}>
                                                <input
                                                    style={{ ...st.input, ...st.adminInput, width: "120px" }}
                                                    placeholder="Username"
                                                    autoComplete="username"
                                                    value={loginUsername}
                                                    onChange={e => setLoginUsername(e.target.value)}
                                                    onKeyDown={e => { if (e.key === "Enter") void handleAdminLogin(); }}
                                                />
                                                <input
                                                    type="password"
                                                    style={{ ...st.input, ...st.adminInput, width: "120px" }}
                                                    placeholder="Password"
                                                    autoComplete="current-password"
                                                    value={loginPassword}
                                                    onChange={e => setLoginPassword(e.target.value)}
                                                    onKeyDown={e => { if (e.key === "Enter") void handleAdminLogin(); }}
                                                />
                                                <button
                                                    style={{ ...st.btn, ...st.btnAdmin, fontSize: "11px" }}
                                                    onClick={() => void handleAdminLogin()}
                                                    disabled={loginPending}
                                                >
                                                    {loginPending ? "…" : "Log in"}
                                                </button>
                                            </div>
                                            <span style={{ fontSize: "10px", color: "#555" }}>
                                                Admin sessions unlock debug_eval and unrestricted clip activation.
                                            </span>
                                        </div>
                                    )}
                                </>
                                : <div style={{ ...st.row, gap: "8px" }}>
                                    <span style={{ fontSize: "11px", color: "#f5a623" }}>
                                        Admin: <strong>{adminAuth.username}</strong>
                                    </span>
                                    <button
                                        style={{ ...st.btn, fontSize: "10px", color: "#888", padding: "3px 7px" }}
                                        onClick={() => void handleAdminLogout()}
                                    >
                                        Log out
                                    </button>
                                </div>
                            }
                        </div>
                    </>
                    : <div style={st.row}>
                        <button style={{ ...st.btn, ...st.btnDanger }} onClick={handleDisconnect}>
                            Disconnect
                        </button>
                        {adminAuth && (
                            <span style={st.adminBadge} title={`Admin session: ${adminAuth.username}`}>
                                ADMIN
                            </span>
                        )}
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

const st: Record<string, React.CSSProperties> = {
    panel:        { display: "flex", flexDirection: "column", gap: "12px" },
    controlGroup: { display: "flex", flexDirection: "column", gap: "2px" },
    sectionLabel: { fontSize: "10px", color: "#555", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "4px" },
    row:          { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
    btn:          { padding: "5px 10px", fontSize: "12px", cursor: "pointer", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px" },
    btnDanger:    { background: "#4a1a1a", borderColor: "#822" },
    btnPrimary:   { background: "#1a2a4a", borderColor: "#2a4a8a", color: "#7ab0f0" },
    btnAdmin:     { background: "#3d2800", borderColor: "#7a5400", color: "#f5a623" },
    input:        { padding: "5px 8px", fontSize: "12px", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", width: "140px" },
    select:       { padding: "5px 8px", fontSize: "12px", background: "#2c2c2c", color: "#e0e0e0", border: "1px solid #444", borderRadius: "4px", maxWidth: "340px" },
    adminInput:   { border: "1px solid #7a5400", color: "#f5a623" },
    adminBadge:   { display: "inline-block", padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "bold", background: "#3d2800", color: "#f5a623", border: "1px solid #7a5400", letterSpacing: "0.05em" },
};