// =============================================================================
// LandingScreen
//
// Shown while state === "idle" or "error".
//
// Permission flow:
//   On mount, call getUserMedia to request camera + mic access. The returned
//   stream is stopped immediately after the grant — CaptureSession.start()
//   opens its own stream when the session actually begins.
//
//   permissionState: "pending" | "granted" | "denied"
//
//   Both `ready` (MediaPipe models loaded) and `permissionState === "granted"`
//   must be true for "Begin sessie" to be enabled.
// =============================================================================

import { useEffect, useState } from "react";

type PermissionState = "pending" | "granted" | "denied";

interface LandingScreenProps {
    ready:     boolean;
    onConnect: () => Promise<void>;
}

export function LandingScreen({ ready, onConnect }: LandingScreenProps) {
    const [permission, setPermission] = useState<PermissionState>("pending");

    useEffect(() => {
        let cancelled = false;

        const request = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: true,
                });
                // Stop tracks immediately — we only needed the permission grant.
                // CaptureSession.start() opens its own stream later.
                stream.getTracks().forEach(t => t.stop());
                if (!cancelled) setPermission("granted");
            } catch {
                if (!cancelled) setPermission("denied");
            }
        };

        void request();
        return () => { cancelled = true; };
    }, []);

    const canStart   = ready && permission === "granted";
    const loadingBtn = !ready;
    const waitingPerm = ready && permission === "pending";

    const btnLabel = loadingBtn
        ? "Modellen laden…"
        : waitingPerm
            ? "Wacht op toestemming…"
            : permission === "denied"
                ? "Toestemming vereist"
                : "Begin sessie";

    return (
        <div style={s.root}>
            <div style={s.card}>
                <h1 style={s.title}>De-escalatietraining</h1>
                <p style={s.description}>
                    Je krijgt een videoscenario te zien van een uitdagende situatie in de klas.
                    Reageer zoals je dat in het echt zou doen — je reactie wordt geanalyseerd
                    en aan het einde ontvang je persoonlijke feedback.
                </p>

                {/* Permission status indicator */}
                <div style={s.permRow}>
                    <PermissionDot state={permission} />
                    <span style={s.permLabel}>
                        {permission === "pending" && "Camera en microfoon — toestemming gevraagd…"}
                        {permission === "granted" && "Camera en microfoon — toegang verleend"}
                        {permission === "denied"  && "Camera en microfoon — toegang geweigerd"}
                    </span>
                </div>

                {permission === "denied" && (
                    <div style={s.deniedBox}>
                        <p style={s.deniedText}>
                            Toegang tot de camera en microfoon is geweigerd. Om de training te starten
                            moet je in de browserinstellingen toestemming geven voor deze pagina.
                            Ververs daarna de pagina en probeer het opnieuw.
                        </p>
                    </div>
                )}

                <button
                    style={{ ...s.btn, ...(!canStart ? s.btnDisabled : {}) }}
                    disabled={!canStart}
                    onClick={() => void onConnect()}
                >
                    {btnLabel}
                </button>

                {!ready && (
                    <p style={s.hint}>
                        De analysemodellen worden geladen. Dit kan even duren bij de eerste keer.
                    </p>
                )}
            </div>
        </div>
    );
}

function PermissionDot({ state }: { state: PermissionState }) {
    const color =
        state === "granted" ? "#22c55e" :
            state === "denied"  ? "#ef4444" :
                "#f59e0b";
    return <span style={{ ...s.dot, background: color }} />;
}

const s: Record<string, React.CSSProperties> = {
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
        fontWeight: "700",
        color:      "#f1f5f9",
        lineHeight: 1.2,
    },
    description: {
        margin:     "0 0 24px",
        fontSize:   "15px",
        color:      "#94a3b8",
        lineHeight: 1.6,
    },
    permRow: {
        display:      "flex",
        alignItems:   "center",
        gap:          "10px",
        marginBottom: "16px",
    },
    dot: {
        display:      "inline-block",
        width:        "10px",
        height:       "10px",
        borderRadius: "50%",
        flexShrink:   0,
    },
    permLabel: {
        fontSize:   "13px",
        color:      "#94a3b8",
        lineHeight: 1.4,
    },
    deniedBox: {
        background:   "#1c0e0e",
        border:       "1px solid #7f1d1d",
        borderRadius: "8px",
        padding:      "14px 16px",
        marginBottom: "20px",
    },
    deniedText: {
        margin:     0,
        fontSize:   "13px",
        color:      "#fca5a5",
        lineHeight: 1.6,
    },
    btn: {
        width:        "100%",
        padding:      "14px",
        fontSize:     "16px",
        fontWeight:   "600",
        background:   "#6366f1",
        color:        "#fff",
        border:       "none",
        borderRadius: "8px",
        cursor:       "pointer",
        marginTop:    "8px",
    },
    btnDisabled: {
        background: "#334155",
        color:      "#64748b",
        cursor:     "not-allowed",
    },
    hint: {
        margin:      "12px 0 0",
        fontSize:    "12px",
        color:       "#475569",
        lineHeight:  1.5,
        textAlign:   "center",
    },
};