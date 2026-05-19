// =============================================================================
// DevTools — Development-only database inspection and user management tool.
//
// THIS PAGE MUST NEVER BE ACCESSIBLE IN PRODUCTION.
//
// It performs unauthenticated database operations via /auth/dev/* endpoints.
// It is only compiled into the build output when VITE_DEV_TOOLS=true is set
// during `vite build`. Production builds must never include this page.
//
// The server also guards these endpoints with DEV_TOOLS_ENABLED=true at
// runtime — but that is a second layer. Build-time exclusion is primary.
// =============================================================================

import { useCallback, useEffect, useState } from "react";

// ─── Styles ───────────────────────────────────────────────────────────────────

const st = {
    root: {
        background: "#1a1a1a",
        color: "#ccc",
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: "13px",
        minHeight: "100vh",
        margin: 0,
    } as React.CSSProperties,

    warningBar: {
        background: "#5a1a00",
        color: "#ffb347",
        borderBottom: "2px solid #ff6600",
        padding: "10px 16px",
        fontSize: "12px",
        lineHeight: "1.6",
        position: "sticky" as const,
        top: 0,
        zIndex: 1000,
    } as React.CSSProperties,

    warningTitle: {
        fontWeight: "bold",
        fontSize: "13px",
        letterSpacing: "0.05em",
        marginBottom: "2px",
    } as React.CSSProperties,

    statusBar: {
        background: "#111",
        borderBottom: "1px solid #333",
        padding: "8px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
    } as React.CSSProperties,

    appTitle: {
        color: "#888",
        fontSize: "12px",
        fontWeight: "bold",
        letterSpacing: "0.04em",
    } as React.CSSProperties,

    body: {
        padding: "16px",
        maxWidth: "1100px",
    } as React.CSSProperties,

    panel: {
        border: "1px solid #333",
        borderRadius: "4px",
        marginBottom: "16px",
        overflow: "hidden",
    } as React.CSSProperties,

    panelDanger: {
        border: "1px solid #5c2e00",
        borderRadius: "4px",
        marginBottom: "16px",
        overflow: "hidden",
        background: "#1e0e00",
    } as React.CSSProperties,

    panelHeader: {
        background: "#222",
        padding: "8px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "pointer",
        userSelect: "none" as const,
        borderBottom: "1px solid #333",
    } as React.CSSProperties,

    panelHeaderDanger: {
        background: "#2a0e00",
        padding: "8px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "pointer",
        userSelect: "none" as const,
        borderBottom: "1px solid #5c2e00",
        color: "#ff8c42",
    } as React.CSSProperties,

    panelTitle: {
        color: "#aaa",
        fontWeight: "bold",
        fontSize: "12px",
        letterSpacing: "0.05em",
    } as React.CSSProperties,

    panelBody: {
        padding: "14px",
    } as React.CSSProperties,

    table: {
        width: "100%",
        borderCollapse: "collapse" as const,
        fontSize: "12px",
    } as React.CSSProperties,

    th: {
        textAlign: "left" as const,
        padding: "6px 10px",
        color: "#666",
        borderBottom: "1px solid #2a2a2a",
        fontWeight: "normal",
        fontSize: "11px",
        letterSpacing: "0.05em",
    } as React.CSSProperties,

    td: {
        padding: "6px 10px",
        borderBottom: "1px solid #1e1e1e",
        verticalAlign: "top" as const,
    } as React.CSSProperties,

    mono: {
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: "11px",
        color: "#aaa",
    } as React.CSSProperties,

    tagAdmin: {
        background: "#3a2800",
        color: "#f5c518",
        border: "1px solid #5c4a00",
        borderRadius: "3px",
        padding: "1px 6px",
        fontSize: "11px",
    } as React.CSSProperties,

    tagStudent: {
        background: "#002840",
        color: "#4da6ff",
        border: "1px solid #004c80",
        borderRadius: "3px",
        padding: "1px 6px",
        fontSize: "11px",
    } as React.CSSProperties,

    btn: {
        background: "#2a2a2a",
        border: "1px solid #444",
        color: "#bbb",
        padding: "4px 10px",
        fontSize: "12px",
        cursor: "pointer",
        borderRadius: "3px",
        fontFamily: "'Courier New', Courier, monospace",
    } as React.CSSProperties,

    btnDanger: {
        background: "#3a1a00",
        border: "1px solid #5c2e00",
        color: "#ff8c42",
    } as React.CSSProperties,

    btnConfirm: {
        background: "#3a0000",
        border: "1px solid #7a0000",
        color: "#ff6b6b",
    } as React.CSSProperties,

    btnPrimary: {
        background: "#003a1a",
        border: "1px solid #005a2a",
        color: "#6fcf8f",
    } as React.CSSProperties,

    input: {
        background: "#111",
        border: "1px solid #333",
        color: "#ccc",
        padding: "4px 8px",
        fontSize: "12px",
        borderRadius: "3px",
        fontFamily: "'Courier New', Courier, monospace",
        outline: "none",
    } as React.CSSProperties,

    select: {
        background: "#111",
        border: "1px solid #333",
        color: "#ccc",
        padding: "4px 8px",
        fontSize: "12px",
        borderRadius: "3px",
        fontFamily: "'Courier New', Courier, monospace",
        outline: "none",
    } as React.CSSProperties,

    error: {
        color: "#cf6f6f",
        background: "#3a1a1a",
        border: "1px solid #5c2e2e",
        borderRadius: "3px",
        padding: "8px 10px",
        fontSize: "12px",
        marginTop: "8px",
    } as React.CSSProperties,

    errorDev: {
        color: "#ff8c42",
        background: "#2a1500",
        border: "1px solid #5c3000",
        borderRadius: "3px",
        padding: "10px 12px",
        fontSize: "12px",
        marginTop: "8px",
    } as React.CSSProperties,

    success: {
        color: "#6fcf6f",
        background: "#1a3a1a",
        border: "1px solid #2e5c2e",
        borderRadius: "3px",
        padding: "8px 10px",
        fontSize: "12px",
        marginTop: "8px",
    } as React.CSSProperties,

    loading: {
        color: "#666",
        fontStyle: "italic",
        fontSize: "12px",
        padding: "8px 0",
    } as React.CSSProperties,

    hint: {
        color: "#555",
        fontSize: "11px",
        marginTop: "4px",
    } as React.CSSProperties,

    confirmRow: {
        background: "#2a0e00",
        border: "1px solid #5c2e00",
        borderRadius: "3px",
        padding: "8px 10px",
        marginTop: "6px",
        display: "flex",
        gap: "8px",
        alignItems: "center",
        fontSize: "12px",
        color: "#ff8c42",
    } as React.CSSProperties,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface UserRow {
    user_id:    string;
    username:   string;
    role:       "student" | "admin";
    created_at: string;
}

interface TokenRow {
    jti:        string;
    expires_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, n = 16): string {
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ─── Collapsible panel ────────────────────────────────────────────────────────

function Panel({
                   title,
                   danger,
                   defaultOpen = true,
                   children,
               }: {
    title: string;
    danger?: boolean;
    defaultOpen?: boolean;
    children: React.ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div style={danger ? st.panelDanger : st.panel}>
            <div
                style={danger ? st.panelHeaderDanger : st.panelHeader}
                onClick={() => setOpen(v => !v)}
            >
                <span style={st.panelTitle}>{title}</span>
                <span style={{ color: "#555", fontSize: "11px" }}>{open ? "▲" : "▼"}</span>
            </div>
            {open && <div style={st.panelBody}>{children}</div>}
        </div>
    );
}

// ─── Users panel ─────────────────────────────────────────────────────────────

function UsersPanel({ serverUrl, onRefresh }: { serverUrl: string; onRefresh: () => void }) {
    const [users, setUsers]       = useState<UserRow[]>([]);
    const [loading, setLoading]   = useState(false);
    const [loadErr, setLoadErr]   = useState<string | null>(null);
    const [devErr, setDevErr]     = useState(false);

    // Confirm-delete state: user_id being confirmed, or null
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

    // Create-user form
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newRole, setNewRole]         = useState<"student" | "admin">("student");
    const [createMsg, setCreateMsg]     = useState<string | null>(null);
    const [createErr, setCreateErr]     = useState<string | null>(null);
    const [creating, setCreating]       = useState(false);

    const load = useCallback(async () => {
        if (!serverUrl.trim()) return;
        setLoading(true);
        setLoadErr(null);
        setDevErr(false);
        try {
            const res = await fetch(`${serverUrl.trim().replace(/\/$/, "")}/auth/dev/users`);
            if (res.status === 403) {
                const body = await res.json() as { error?: string };
                if (body.error === "dev_tools_disabled") {
                    setDevErr(true);
                    setUsers([]);
                    return;
                }
            }
            if (!res.ok) {
                setLoadErr(`Server returned ${res.status}. Is DEV_TOOLS_ENABLED=true?`);
                return;
            }
            const body = await res.json() as { users: UserRow[] };
            setUsers(body.users);
        } catch (err) {
            setLoadErr(`Could not reach server: ${String(err instanceof Error ? err.message : err)}`);
        } finally {
            setLoading(false);
        }
    }, [serverUrl]);

    useEffect(() => { void load(); }, [load]);

    const handleDelete = async (userId: string) => {
        setDeleteMsg(null);
        try {
            const res = await fetch(
                `${serverUrl.trim().replace(/\/$/, "")}/auth/dev/users/${userId}`,
                { method: "DELETE" }
            );
            if (!res.ok) {
                const body = await res.json() as { message?: string };
                setDeleteMsg(`Delete failed: ${body.message ?? res.status}`);
                return;
            }
            setConfirmId(null);
            await load();
            onRefresh();
        } catch (err) {
            setDeleteMsg(`Error: ${String(err instanceof Error ? err.message : err)}`);
        }
    };

    const handleCreate = async () => {
        setCreateErr(null);
        setCreateMsg(null);
        if (!newUsername.trim()) { setCreateErr("Username is required."); return; }
        if (!newPassword)        { setCreateErr("Password is required."); return; }
        setCreating(true);
        try {
            const res = await fetch(
                `${serverUrl.trim().replace(/\/$/, "")}/auth/dev/users`,
                {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({ username: newUsername.trim(), password: newPassword, role: newRole }),
                }
            );
            if (res.ok) {
                setCreateMsg(`User "${newUsername.trim()}" created.`);
                setNewUsername("");
                setNewPassword("");
                setNewRole("student");
                await load();
                onRefresh();
            } else {
                const body = await res.json() as { message?: string };
                setCreateErr(body.message ?? `Server returned ${res.status}`);
            }
        } catch (err) {
            setCreateErr(`Error: ${String(err instanceof Error ? err.message : err)}`);
        } finally {
            setCreating(false);
        }
    };

    return (
        <Panel title="Users">
            {devErr && (
                <div style={st.errorDev}>
                    ⚠ The server has dev tools disabled.
                    Set <code>DEV_TOOLS_ENABLED=true</code> in the App container's <code>.env</code> to use this page.
                </div>
            )}
            {loading && <div style={st.loading}>Loading users…</div>}
            {loadErr && <div style={st.error}>{loadErr}</div>}

            {!loading && !loadErr && !devErr && (
                <>
                    <div style={{ ...st.hint, marginBottom: "8px" }}>
                        Note: the dev endpoint allows deleting the last admin — there is no protection here.
                        Use <code>DELETE /auth/users/:id</code> (authenticated) if you need that protection.
                    </div>
                    <table style={st.table}>
                        <thead>
                        <tr>
                            <th style={st.th}>User ID</th>
                            <th style={st.th}>Username</th>
                            <th style={st.th}>Role</th>
                            <th style={st.th}>Created At</th>
                            <th style={st.th}>Actions</th>
                        </tr>
                        </thead>
                        <tbody>
                        {users.length === 0 && (
                            <tr>
                                <td style={{ ...st.td, color: "#555" }} colSpan={5}>No users found.</td>
                            </tr>
                        )}
                        {users.map(u => (
                            <>
                                <tr key={u.user_id}>
                                    <td style={{ ...st.td, ...st.mono }} title={u.user_id}>{truncate(u.user_id, 12)}</td>
                                    <td style={st.td}>{u.username}</td>
                                    <td style={st.td}>
                                            <span style={u.role === "admin" ? st.tagAdmin : st.tagStudent}>
                                                {u.role}
                                            </span>
                                    </td>
                                    <td style={{ ...st.td, ...st.mono, fontSize: "11px" }}>{u.created_at}</td>
                                    <td style={st.td}>
                                        {confirmId === u.user_id ? (
                                            <button
                                                style={{ ...st.btn, ...st.btnDanger }}
                                                onClick={() => setConfirmId(null)}
                                            >
                                                Cancel
                                            </button>
                                        ) : (
                                            <button
                                                style={{ ...st.btn, ...st.btnDanger }}
                                                onClick={() => { setDeleteMsg(null); setConfirmId(u.user_id); }}
                                            >
                                                Delete
                                            </button>
                                        )}
                                    </td>
                                </tr>
                                {confirmId === u.user_id && (
                                    <tr key={`${u.user_id}-confirm`}>
                                        <td colSpan={5} style={{ padding: "0 10px 8px" }}>
                                            <div style={st.confirmRow}>
                                                <span>Are you sure? This cannot be undone.</span>
                                                <button
                                                    style={{ ...st.btn, ...st.btnConfirm }}
                                                    onClick={() => void handleDelete(u.user_id)}
                                                >
                                                    Confirm delete
                                                </button>
                                                <button
                                                    style={st.btn}
                                                    onClick={() => setConfirmId(null)}
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </>
                        ))}
                        </tbody>
                    </table>
                    {deleteMsg && <div style={st.error}>{deleteMsg}</div>}

                    <div style={{ marginTop: "16px", borderTop: "1px solid #2a2a2a", paddingTop: "14px" }}>
                        <div style={{ ...st.panelTitle, marginBottom: "10px" }}>Create user</div>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                                <label style={st.hint}>Username</label>
                                <input
                                    style={st.input}
                                    value={newUsername}
                                    placeholder="username"
                                    onChange={e => setNewUsername(e.target.value)}
                                />
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                                <label style={st.hint}>Password</label>
                                <input
                                    type="password"
                                    style={st.input}
                                    value={newPassword}
                                    placeholder="password"
                                    onChange={e => setNewPassword(e.target.value)}
                                />
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                                <label style={st.hint}>Role</label>
                                <select
                                    style={st.select}
                                    value={newRole}
                                    onChange={e => setNewRole(e.target.value as "student" | "admin")}
                                >
                                    <option value="student">student</option>
                                    <option value="admin">admin</option>
                                </select>
                            </div>
                            <button
                                style={{ ...st.btn, ...st.btnPrimary }}
                                onClick={() => void handleCreate()}
                                disabled={creating}
                            >
                                {creating ? "Creating…" : "Create"}
                            </button>
                        </div>
                        {createErr && <div style={st.error}>{createErr}</div>}
                        {createMsg && <div style={st.success}>{createMsg}</div>}
                    </div>
                </>
            )}
        </Panel>
    );
}

// ─── Token blocklist panel ────────────────────────────────────────────────────

function TokensPanel({ serverUrl }: { serverUrl: string }) {
    const [tokens, setTokens]     = useState<TokenRow[]>([]);
    const [loading, setLoading]   = useState(false);
    const [loadErr, setLoadErr]   = useState<string | null>(null);
    const [devErr, setDevErr]     = useState(false);

    const load = useCallback(async () => {
        if (!serverUrl.trim()) return;
        setLoading(true);
        setLoadErr(null);
        setDevErr(false);
        try {
            const res = await fetch(`${serverUrl.trim().replace(/\/$/, "")}/auth/dev/tokens`);
            if (res.status === 403) {
                const body = await res.json() as { error?: string };
                if (body.error === "dev_tools_disabled") {
                    setDevErr(true);
                    setTokens([]);
                    return;
                }
            }
            if (!res.ok) {
                setLoadErr(`Server returned ${res.status}. Is DEV_TOOLS_ENABLED=true?`);
                return;
            }
            const body = await res.json() as { tokens: TokenRow[] };
            setTokens(body.tokens);
        } catch (err) {
            setLoadErr(`Could not reach server: ${String(err instanceof Error ? err.message : err)}`);
        } finally {
            setLoading(false);
        }
    }, [serverUrl]);

    useEffect(() => { void load(); }, [load]);

    return (
        <Panel title="Token blocklist" defaultOpen={false}>
            {devErr && (
                <div style={st.errorDev}>
                    ⚠ The server has dev tools disabled.
                    Set <code>DEV_TOOLS_ENABLED=true</code> in the App container's <code>.env</code>.
                </div>
            )}
            {loading && <div style={st.loading}>Loading tokens…</div>}
            {loadErr && <div style={st.error}>{loadErr}</div>}
            {!loading && !loadErr && !devErr && (
                <>
                    <div style={{ ...st.hint, marginBottom: "8px" }}>
                        Non-expired blocklist entries. Expired entries are pruned automatically at startup and every 24 hours.
                    </div>
                    {tokens.length === 0 ? (
                        <div style={{ color: "#555", fontSize: "12px" }}>No blocked tokens.</div>
                    ) : (
                        <table style={st.table}>
                            <thead>
                            <tr>
                                <th style={st.th}>JTI</th>
                                <th style={st.th}>Expires At</th>
                            </tr>
                            </thead>
                            <tbody>
                            {tokens.map(t => (
                                <tr key={t.jti}>
                                    <td style={{ ...st.td, ...st.mono }} title={t.jti}>{truncate(t.jti, 20)}</td>
                                    <td style={{ ...st.td, ...st.mono, fontSize: "11px" }}>{t.expires_at}</td>
                                </tr>
                            ))}
                            </tbody>
                        </table>
                    )}
                </>
            )}
        </Panel>
    );
}

// ─── Danger zone panel ────────────────────────────────────────────────────────

function DangerPanel({ serverUrl, onRefresh }: { serverUrl: string; onRefresh: () => void }) {
    const [step, setStep]         = useState<"idle" | "confirm">("idle");
    const [result, setResult]     = useState<string | null>(null);
    const [error, setError]       = useState<string | null>(null);
    const [running, setRunning]   = useState(false);

    const handleReset = async () => {
        setError(null);
        setResult(null);
        setRunning(true);
        try {
            const res = await fetch(
                `${serverUrl.trim().replace(/\/$/, "")}/auth/dev/reset`,
                { method: "POST" }
            );
            if (res.status === 403) {
                const body = await res.json() as { error?: string };
                if (body.error === "dev_tools_disabled") {
                    setError("Server has dev tools disabled. Set DEV_TOOLS_ENABLED=true.");
                    setStep("idle");
                    return;
                }
            }
            if (!res.ok) {
                const body = await res.json() as { message?: string };
                setError(body.message ?? `Server returned ${res.status}`);
                setStep("idle");
                return;
            }
            const body = await res.json() as { users_deleted: number; tokens_deleted: number };
            setResult(`Database reset. Deleted ${body.users_deleted} user(s) and ${body.tokens_deleted} token(s). The server will need to be bootstrapped again.`);
            setStep("idle");
            onRefresh();
        } catch (err) {
            setError(`Error: ${String(err instanceof Error ? err.message : err)}`);
            setStep("idle");
        } finally {
            setRunning(false);
        }
    };

    return (
        <Panel title="⚠ Danger zone — these actions are irreversible" danger defaultOpen={false}>
            <div style={{ marginBottom: "12px" }}>
                <div style={{ color: "#ff8c42", fontWeight: "bold", marginBottom: "6px", fontSize: "12px" }}>
                    Reset database
                </div>
                <div style={{ color: "#888", fontSize: "12px", marginBottom: "10px" }}>
                    Wipes all users and all token blocklist entries. Equivalent to a fresh install.
                    The App container must be restarted or bootstrap credentials set to create the first admin account again.
                </div>

                {step === "idle" && (
                    <button
                        style={{ ...st.btn, ...st.btnDanger }}
                        onClick={() => { setResult(null); setError(null); setStep("confirm"); }}
                    >
                        Reset database…
                    </button>
                )}

                {step === "confirm" && (
                    <div style={st.confirmRow}>
                        <span style={{ color: "#ff6b6b" }}>
                            This will delete ALL users and tokens. The server will need bootstrapping again. This cannot be undone.
                        </span>
                        <button
                            style={{ ...st.btn, ...st.btnConfirm }}
                            onClick={() => void handleReset()}
                            disabled={running}
                        >
                            {running ? "Resetting…" : "Confirm reset"}
                        </button>
                        <button
                            style={st.btn}
                            onClick={() => setStep("idle")}
                            disabled={running}
                        >
                            Cancel
                        </button>
                    </div>
                )}

                {error  && <div style={st.error}>{error}</div>}
                {result && <div style={st.success}>{result}</div>}
            </div>
        </Panel>
    );
}

// ─── Root component ───────────────────────────────────────────────────────────

export function DevTools() {
    const [serverUrl, setServerUrl] = useState<string>(
        () => sessionStorage.getItem("ar_devtools_server_url") ?? ""
    );
    const [refreshKey, setRefreshKey] = useState(0);

    const handleServerUrlChange = (url: string) => {
        setServerUrl(url);
        sessionStorage.setItem("ar_devtools_server_url", url);
    };

    const refresh = () => setRefreshKey(k => k + 1);

    return (
        <div style={st.root}>
            {/* ── Persistent warning bar — MUST NOT be removed, hidden, or made dismissable ── */}
            <div style={st.warningBar}>
                <div style={st.warningTitle}>
                    ⚠ DEVELOPMENT TOOL — UNAUTHENTICATED DATABASE ACCESS
                </div>
                <div>
                    This page performs unauthenticated database operations (user creation, deletion, full database reset).
                    IT MUST NOT BE ACCESSIBLE IN PRODUCTION.
                    Ensure <code>VITE_DEV_TOOLS</code> is NOT set during production builds,
                    and <code>DEV_TOOLS_ENABLED</code> is NOT set in the App container's production <code>.env</code>.
                </div>
            </div>

            {/* ── Status bar ── */}
            <div style={st.statusBar}>
                <span style={st.appTitle}>AR Training — Developer Tools</span>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <label style={{ color: "#555", fontSize: "11px" }}>Server URL</label>
                    <input
                        style={{ ...st.input, width: "260px" }}
                        value={serverUrl}
                        placeholder="http://localhost:3001"
                        onChange={e => handleServerUrlChange(e.target.value)}
                    />
                    <button
                        style={st.btn}
                        onClick={refresh}
                    >
                        Refresh
                    </button>
                </div>
            </div>

            {/* ── Panels ── */}
            <div style={st.body}>
                {!serverUrl.trim() && (
                    <div style={{ ...st.hint, padding: "12px 0" }}>
                        Enter the App container URL above to begin (e.g. <code>http://localhost:3001</code>).
                    </div>
                )}

                <UsersPanel key={`users-${refreshKey}`} serverUrl={serverUrl} onRefresh={refresh} />
                <TokensPanel key={`tokens-${refreshKey}`} serverUrl={serverUrl} />
                <DangerPanel key={`danger-${refreshKey}`} serverUrl={serverUrl} onRefresh={refresh} />
            </div>
        </div>
    );
}