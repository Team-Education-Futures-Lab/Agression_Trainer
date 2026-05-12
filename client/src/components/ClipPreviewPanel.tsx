// =============================================================================
// ClipPreviewPanel
//
// Left-column clip preview: video player + metadata for the currently active
// clip (or any historical clip selected via the turn selector).
//
// Lives in the left column so developers can cross-reference the actor video
// against the eval debug data in the right column simultaneously.
// =============================================================================

import { useState } from "react";
import type { ClipData } from "@ar-training/shared";
import type { SessionHistoryEntry } from "../hooks/useSession.ts";

interface ClipPreviewPanelProps {
    currentClipData: ClipData | null;
    sessionHistory:  SessionHistoryEntry[];
    /** Turn number (1-indexed) being watched. Null = show current clip. */
    watchingTurn:    number | null;
    onWatchTurn:     (turn: number | null) => void;
}

export function ClipPreviewPanel({
                                     currentClipData,
                                     sessionHistory,
                                     watchingTurn,
                                     onWatchTurn,
                                 }: ClipPreviewPanelProps) {
    const [videoError, setVideoError] = useState(false);

    // Determine which clip to show: historical selection or current active clip.
    const historicalEntry = watchingTurn !== null
        ? sessionHistory.find(e => e.turn === watchingTurn) ?? null
        : null;
    const displayClip: ClipData | null = historicalEntry?.clipSnapshot ?? currentClipData;

    // Reset error state when the displayed clip changes.
    // Using key on the <video> element handles this automatically.

    const historyWithSnapshot = sessionHistory.filter(e => e.clipSnapshot !== null);

    return (
        <div style={st.panel}>
            <div style={st.header}>
                <span style={st.title}>Clip preview</span>
                {watchingTurn !== null && (
                    <button
                        style={st.clearHistBtn}
                        onClick={() => onWatchTurn(null)}
                        title="Return to current clip"
                    >
                        ✕ live
                    </button>
                )}
            </div>

            {/* Turn selector — only shown when history entries with snapshots exist */}
            {historyWithSnapshot.length > 0 && (
                <div style={st.turnRow}>
                    <span style={st.turnLabel}>History</span>
                    {historyWithSnapshot.map(e => (
                        <button
                            key={e.turn}
                            style={{
                                ...st.turnBtn,
                                ...(watchingTurn === e.turn ? st.turnBtnActive : {}),
                            }}
                            onClick={() => onWatchTurn(watchingTurn === e.turn ? null : e.turn)}
                            title={`Turn ${e.turn}: ${e.endedClipId} (score ${e.score.toFixed(3)})`}
                        >
                            #{e.turn}
                        </button>
                    ))}
                </div>
            )}

            {/* Historical view indicator */}
            {watchingTurn !== null && (
                <div style={st.historicalBanner}>
                    Viewing turn #{watchingTurn} — historical
                </div>
            )}

            {/* Video area */}
            {displayClip === null ? (
                <div style={st.noClip}>No clip active</div>
            ) : (
                <>
                    {videoError ? (
                        <div style={st.videoError}>
                            <span style={st.videoErrorTitle}>Video niet beschikbaar</span>
                            <a
                                href={displayClip.video_url}
                                target="_blank"
                                rel="noreferrer"
                                style={st.videoErrorUrl}
                                title="Open URL directly"
                            >
                                {displayClip.video_url}
                            </a>
                        </div>
                    ) : (
                        <video
                            key={displayClip.video_url}
                            controls
                            style={st.video}
                            onError={() => setVideoError(true)}
                            // Reset error flag when key changes (new URL loaded)
                            onLoadStart={() => setVideoError(false)}
                        >
                            <source src={displayClip.video_url} />
                        </video>
                    )}

                    {/* Metadata below video — always visible regardless of video status */}
                    <div style={st.meta}>
                        <div style={st.idRow}>
                            <span style={st.clipId}>{displayClip.clip_id}</span>
                            <span style={st.scenarioId}>{displayClip.scenario_id}</span>
                            <a
                                href={displayClip.video_url}
                                target="_blank"
                                rel="noreferrer"
                                style={st.urlLink}
                                title="Open video URL in new tab"
                            >
                                {displayClip.video_url}
                            </a>
                        </div>

                        {displayClip.transcript && (
                            <div style={st.transcriptBlock}>
                                <span style={st.transcriptLabel}>Actor transcript</span>
                                <p style={st.transcriptText}>"{displayClip.transcript}"</p>
                            </div>
                        )}

                        {displayClip.notable_features.length > 0 && (
                            <div style={st.tagRow}>
                                {displayClip.notable_features.map(f => (
                                    <span key={f} style={st.tag}>{f}</span>
                                ))}
                            </div>
                        )}

                        <table style={st.table}>
                            <thead>
                            <tr>
                                <th style={st.th}>min</th>
                                <th style={st.th}>max</th>
                                <th style={st.th}>next_clip</th>
                            </tr>
                            </thead>
                            <tbody>
                            {displayClip.branch_conditions.map((bc, i) => (
                                <tr key={i}>
                                    <td style={st.td}>{bc.min_score.toFixed(2)}</td>
                                    <td style={st.td}>{bc.max_score.toFixed(2)}</td>
                                    <td style={{ ...st.td, ...(bc.next_clip === null ? st.tdNull : {}) }}>
                                        {bc.next_clip ?? "null (terminal)"}
                                    </td>
                                </tr>
                            ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const st: Record<string, React.CSSProperties> = {
    panel:            { background: "#252525", border: "1px solid #333", borderRadius: "4px" },
    header:           { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderBottom: "1px solid #2a2a2a" },
    title:            { fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.06em" },
    clearHistBtn:     { padding: "2px 8px", fontSize: "10px", cursor: "pointer", background: "#2c2c2c", color: "#e6a817", border: "1px solid #7a5400", borderRadius: "3px" },

    turnRow:          { display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", padding: "6px 10px", borderBottom: "1px solid #222" },
    turnLabel:        { fontSize: "10px", color: "#555", textTransform: "uppercase", letterSpacing: "0.05em", marginRight: "4px" },
    turnBtn:          { padding: "2px 7px", fontSize: "11px", cursor: "pointer", background: "#2c2c2c", color: "#888", border: "1px solid #3a3a3a", borderRadius: "3px" },
    turnBtnActive:    { background: "#1e2a1e", color: "#7ab87a", border: "1px solid #3a6a3a" },

    historicalBanner: { fontSize: "10px", color: "#e6a817", background: "#2a1a00", borderBottom: "1px solid #7a5400", padding: "3px 10px", textAlign: "center" as const },

    noClip:           { padding: "24px 10px", textAlign: "center" as const, fontSize: "12px", color: "#444", fontStyle: "italic" },

    video:            { width: "100%", aspectRatio: "16/9", background: "#000", borderRadius: "0", display: "block" },

    videoError:       { display: "flex", flexDirection: "column" as const, gap: "4px", alignItems: "center", justifyContent: "center", aspectRatio: "16/9", background: "#1a1a1a", border: "1px dashed #444", padding: "12px" },
    videoErrorTitle:  { fontSize: "12px", color: "#888" },
    videoErrorUrl:    { fontSize: "10px", color: "#5b8dee", textDecoration: "none", wordBreak: "break-all" as const, textAlign: "center" as const },

    meta:             { padding: "8px 10px 10px" },
    idRow:            { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "6px", flexWrap: "wrap" as const },
    clipId:           { fontSize: "13px", fontWeight: "bold" as const, color: "#e0e0e0", fontFamily: "monospace" },
    scenarioId:       { fontSize: "11px", color: "#666" },
    urlLink:          { fontSize: "10px", color: "#5b8dee", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, maxWidth: "220px" },

    transcriptBlock:  { marginBottom: "8px" },
    transcriptLabel:  { display: "block", fontSize: "10px", color: "#555", textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: "3px" },
    transcriptText:   { margin: 0, fontSize: "12px", color: "#94a3b8", lineHeight: 1.5, fontStyle: "italic" },

    tagRow:           { display: "flex", flexWrap: "wrap" as const, gap: "4px", marginBottom: "8px" },
    tag:              { padding: "1px 7px", borderRadius: "999px", fontSize: "11px", background: "#2c3040", color: "#7a90b0", border: "1px solid #3a4a60" },

    table:            { width: "100%", borderCollapse: "collapse" as const, fontSize: "11px" },
    th:               { textAlign: "left" as const, color: "#555", padding: "2px 6px", fontWeight: "normal" as const, borderBottom: "1px solid #2a2a2a" },
    td:               { padding: "2px 6px", color: "#b0c4de", borderBottom: "1px solid #222" },
    tdNull:           { color: "#8e44ad", fontStyle: "italic" },
};