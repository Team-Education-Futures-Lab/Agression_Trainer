// =============================================================================
// QueueScreen
//
// Shown while state === "queued". Polls queue position and lets the student
// leave the queue via the "Verlaat wachtrij" button.
// =============================================================================

import { useEffect, useState } from "react";

interface QueueScreenProps {
    queuePos:     number | null;
    onDisconnect: () => void;
}

export function QueueScreen({ queuePos, onDisconnect }: QueueScreenProps) {
    const [dots, setDots] = useState(".");
    useEffect(() => {
        const id = setInterval(() => {
            setDots(d => d.length >= 3 ? "." : d + ".");
        }, 500);
        return () => clearInterval(id);
    }, []);

    return (
        <div style={s.root}>
            <div style={s.card}>
                <div style={s.spinner}>
                    <div style={s.ring} />
                </div>
                <h2 style={s.title}>Wachten op een plekje{dots}</h2>
                <p style={s.subtitle}>
                    {queuePos !== null
                        ? `Je staat op positie ${queuePos} in de wachtrij.`
                        : "Je positie wordt opgehaald…"}
                </p>
                <p style={s.hint}>Dit duurt meestal maar even. Sluit dit venster niet.</p>

                <button style={s.leaveBtn} onClick={onDisconnect}>
                    Verlaat wachtrij
                </button>
            </div>
        </div>
    );
}

const RING_SIZE = 56;

const s: Record<string, React.CSSProperties> = {
    root: {
        minHeight:      "100vh",
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        background:     "#0f172a",
    },
    card: {
        textAlign:    "center",
        padding:      "48px 40px",
        background:   "#1e293b",
        borderRadius: "12px",
        maxWidth:     "360px",
        width:        "100%",
        boxShadow:    "0 8px 32px rgba(0,0,0,0.4)",
    },
    spinner: {
        display:        "flex",
        justifyContent: "center",
        marginBottom:   "24px",
    },
    ring: {
        width:          `${RING_SIZE}px`,
        height:         `${RING_SIZE}px`,
        borderRadius:   "50%",
        border:         "4px solid #334155",
        borderTopColor: "#6366f1",
        animation:      "spin 0.9s linear infinite",
    },
    title: {
        margin:     "0 0 10px",
        fontSize:   "20px",
        fontWeight: "600",
        color:      "#f1f5f9",
    },
    subtitle: {
        margin:   "0 0 12px",
        fontSize: "15px",
        color:    "#94a3b8",
    },
    hint: {
        margin:       "0 0 24px",
        fontSize:     "12px",
        color:        "#475569",
    },
    leaveBtn: {
        width:        "100%",
        padding:      "10px",
        fontSize:     "14px",
        fontWeight:   "500",
        background:   "transparent",
        color:        "#64748b",
        border:       "1px solid #334155",
        borderRadius: "8px",
        cursor:       "pointer",
    },
};