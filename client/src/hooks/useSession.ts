// =============================================================================
// useSession
//
// Owns a SessionHandler for the lifetime of the component that mounts it.
// Exposes reactive state, the last received ServerMessage, and stable
// callbacks for all session actions.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import type {
    SessionState, ServerMessage,
    ScenarioSummary, ClipData, ClipCandidateData,
    BehaviourResult, WordTiming,
} from "@ar-training/shared";
import { SessionHandler } from "../session-handler.ts";
import type { CaptureSession } from "../capture.ts";

// ─── Debug eval types (client-internal — not in shared/types.ts) ──────────────

/**
 * App-level capture statistics for one clip, mirroring the `capture` field
 * of the `debug_eval` wire message.
 */
export interface DebugAppMeta {
    frame_count:       number;
    chunk_count:       number;
    word_count:        number;
    eval_latency_ms:   number;
    eval_fallback:     boolean;
}

/**
 * The final transcript data forwarded to the Evaluation container, mirroring
 * the `transcript` field of the `debug_eval` wire message.
 */
export interface DebugTranscript {
    final_text: string;
    words:      WordTiming[];
}

/**
 * Client-internal representation of a `debug_eval` message payload.
 * Attached to the corresponding SessionHistoryEntry once received.
 *
 * `stages` is typed as `Record<string, unknown> | null` — its shape varies by
 * `analyser_id` and is narrowed at render time.
 */
export interface DebugEvalPayload {
    analyser_id: string;
    result:      BehaviourResult;
    stages:      Record<string, unknown> | null;
    app_meta:    DebugAppMeta;
    transcript:  DebugTranscript;
}

// ─── Session history ──────────────────────────────────────────────────────────

/**
 * One entry per completed clip transition, appended when clip_selected arrives.
 * UI state only — never crosses container boundaries.
 */
export interface SessionHistoryEntry {
    /** 1-indexed turn number. */
    turn:          number;
    /** clip_id of the clip that just ended (from currentClipData at snapshot time). */
    endedClipId:   string;
    /** escalation_score from clip_selected. */
    score:         number;
    /** Accumulated student transcript for the ended clip (snapshot before clear). */
    transcript:    string;
    /** Next clip_id, or null if terminal. */
    nextClipId:    string | null;
    /**
     * Full ClipData snapshot taken at turn completion. Used by the clip preview
     * panel to allow developers to rewatch any historical clip with its full
     * metadata (video URL, actor transcript, notable_features, branch_conditions).
     * Populated from currentClipDataRef.current at clip_selected time.
     */
    clipSnapshot:  ClipData | null;
    /**
     * Evaluation debug payload for this turn. Populated when the session is
     * an admin session and the server sends a `debug_eval` message after
     * `clip_selected`. Absent for non-admin sessions.
     */
    debugEval?:    DebugEvalPayload;
}

export interface UseSessionResult {
    handler:              SessionHandler;
    state:                SessionState;
    lastMessage:          ServerMessage | null;
    isAdmin:              boolean;
    // Derived convenience values
    sessionId:            string | null;
    transcript:           string;              // accumulated for current clip, cleared on clip_selected
    queuePos:             number | null;
    clipScore:            number | null;       // from the most recent clip_selected
    scenarios:            ScenarioSummary[];   // from scenarios_list; empty until received
    clipCandidates:       ClipCandidateData[]; // from most recent clip_candidates
    currentClipData:      ClipData | null;     // from most recent clip_data with activate=true
    feedbackUnavailable:  boolean;             // true if error{code:"feedback_unavailable"} received
    sessionHistory:       SessionHistoryEntry[]; // one entry per clip_selected, oldest first
    /**
     * Timestamp (Date.now()) of the most recently received transport-layer
     * heartbeat from the server. Null until the first heartbeat arrives.
     * Exposed for the debug harness to display connection liveness.
     */
    lastHeartbeat:        number | null;
    /**
     * The `status` field of the most recently received heartbeat message.
     * `"feedback_generating"` while Ollama is producing output; `"ok"` for a
     * general keepalive. Null until the first heartbeat arrives.
     */
    heartbeatStatus:      string | null;
    // Stable callbacks
    connect:              (userId?: string, language?: string, adminKey?: string) => Promise<void>;
    disconnect:           () => void;
    selectScenario:       (scenarioId: string, entryClipId: string) => void;
    preloadClip:          (scenarioId: string, clipId: string) => void;
    sendClipEnded:        (clipId: string) => void;
}

export interface UseSessionOptions {
    /** Called for every inbound ServerMessage in addition to the built-in handling. */
    onMessage?: (msg: ServerMessage) => void;
}

export function useSession(capture: CaptureSession, options: UseSessionOptions = {}): UseSessionResult {
    const handlerRef = useRef<SessionHandler | null>(null);

    const [state,                setState]               = useState<SessionState>("idle");
    const [lastMessage,          setLastMessage]          = useState<ServerMessage | null>(null);
    const [isAdmin,              setIsAdmin]              = useState(false);
    const [sessionId,            setSessionId]            = useState<string | null>(null);
    const [transcript,           setTranscript]           = useState("");
    const [queuePos,             setQueuePos]             = useState<number | null>(null);
    const [clipScore,            setClipScore]            = useState<number | null>(null);
    const [scenarios,            setScenarios]            = useState<ScenarioSummary[]>([]);
    const [clipCandidates,       setClipCandidates]       = useState<ClipCandidateData[]>([]);
    const [currentClipData,      setCurrentClipData]      = useState<ClipData | null>(null);
    const [feedbackUnavailable,  setFeedbackUnavailable]  = useState(false);
    const [sessionHistory,       setSessionHistory]       = useState<SessionHistoryEntry[]>([]);
    const [lastHeartbeat,        setLastHeartbeat]        = useState<number | null>(null);
    const [heartbeatStatus,      setHeartbeatStatus]      = useState<string | null>(null);

    // Refs that mirror mutable state values so callbacks can read the current
    // value synchronously without stale-closure issues.
    const transcriptRef      = useRef("");
    const currentClipDataRef = useRef<ClipData | null>(null);
    const turnCounterRef     = useRef(0);

    const optionsRef = useRef(options);
    optionsRef.current = options;

    // Wrapped setters that keep refs in sync.
    const updateTranscript = (t: string) => {
        transcriptRef.current = t;
        setTranscript(t);
    };
    const updateCurrentClipData = (d: ClipData | null) => {
        currentClipDataRef.current = d;
        setCurrentClipData(d);
    };

    if (!handlerRef.current) {
        handlerRef.current = new SessionHandler(capture, {
            onStateChange: (s) => {
                setState(s);
                if (s === "idle") {
                    setSessionId(null);
                    setIsAdmin(false);
                    updateTranscript("");
                    setQueuePos(null);
                    setClipScore(null);
                    setScenarios([]);
                    setClipCandidates([]);
                    updateCurrentClipData(null);
                    setFeedbackUnavailable(false);
                    setSessionHistory([]);
                    setLastHeartbeat(null);
                    setHeartbeatStatus(null);
                    turnCounterRef.current = 0;
                }
            },
            onActivatingClipData: (msg) => {
                updateCurrentClipData(msg);
            },
            onHeartbeat: (status) => {
                setLastHeartbeat(Date.now());
                setHeartbeatStatus(status);
            },
            onMessage: (msg) => {
                setLastMessage(msg);
                setSessionId(msg.session_id);
                optionsRef.current.onMessage?.(msg);

                switch (msg.type) {
                    case "session_update":
                        if (msg.queue_position !== null) {
                            setQueuePos(msg.queue_position);
                        } else {
                            updateTranscript(msg.transcript);
                        }
                        break;

                    case "scenarios_list":
                        setScenarios(msg.scenarios);
                        break;

                    case "clip_candidates":
                        setClipCandidates(msg.candidates);
                        break;

                    case "clip_selected": {
                        // Snapshot current clip and transcript before clearing them.
                        const endedClip  = currentClipDataRef.current;
                        const snapTx     = transcriptRef.current;
                        const turn       = ++turnCounterRef.current;

                        const entry: SessionHistoryEntry = {
                            turn,
                            endedClipId:  endedClip?.clip_id ?? "(unknown)",
                            score:        msg.clip_score,
                            transcript:   snapTx,
                            nextClipId:   msg.clip_id,
                            // Snapshot the full ClipData so developers can rewatch
                            // this clip's video from history without knowing the URL.
                            clipSnapshot: endedClip ?? null,
                        };

                        setSessionHistory(prev => [...prev, entry]);
                        setClipScore(msg.clip_score);
                        updateTranscript(""); // clear for next clip
                        setClipCandidates([]);
                        break;
                    }

                    case "debug_eval": {
                        // Attach debug payload to the most recently appended history entry.
                        // debug_eval always arrives after clip_selected for the same turn,
                        // so the entry is guaranteed to exist.
                        const payload: DebugEvalPayload = {
                            analyser_id: msg.analyser_id,
                            result:      msg.result,
                            stages:      msg.stages != null
                                ? (msg.stages as Record<string, unknown>)
                                : null,
                            app_meta: {
                                frame_count:     msg.capture.frame_count,
                                chunk_count:     msg.capture.audio_chunk_count,
                                word_count:      msg.capture.word_timing_count,
                                eval_latency_ms: msg.capture.eval_latency_ms,
                                eval_fallback:   msg.capture.eval_fallback,
                            },
                            transcript: {
                                final_text: msg.transcript.final_text,
                                words:      msg.transcript.words,
                            },
                        };
                        setSessionHistory(prev =>
                            prev.map((e, i) =>
                                i === prev.length - 1 ? { ...e, debugEval: payload } : e
                            )
                        );
                        // Reflect admin flag from the handler now that the first
                        // debug_eval has arrived (belt-and-suspenders alongside connect()).
                        setIsAdmin(true);
                        break;
                    }

                    case "error":
                        if (msg.code === "feedback_unavailable") {
                            setFeedbackUnavailable(true);
                        }
                        break;
                }
            },
            onError: (err) => {
                console.error("[useSession]", err);
            },
        });
    }

    const handler = handlerRef.current;

    // Sync isAdmin from handler after connect (handler.isAdmin is set synchronously
    // before the first onStateChange fires, so read it once on state change).
    useEffect(() => {
        if (state !== "idle") setIsAdmin(handler.isAdmin);
    }, [state, handler]);

    useEffect(() => {
        return () => { handler.disconnect(); };
    }, [handler]);

    const connect        = useCallback((userId?: string, language?: string, adminKey?: string) =>
        handler.connect(userId, language, adminKey), [handler]);
    const disconnect     = useCallback(() => handler.disconnect(), [handler]);
    const selectScenario = useCallback((scenarioId: string, entryClipId: string) =>
        handler.selectScenario(scenarioId, entryClipId), [handler]);
    const preloadClip    = useCallback((scenarioId: string, clipId: string) =>
        handler.preloadClip(scenarioId, clipId), [handler]);
    const sendClipEnded  = useCallback((clipId: string) =>
        handler.sendClipEnded(clipId), [handler]);

    return {
        handler,
        state,
        lastMessage,
        isAdmin,
        sessionId,
        transcript,
        queuePos,
        clipScore,
        scenarios,
        clipCandidates,
        currentClipData,
        feedbackUnavailable,
        sessionHistory,
        lastHeartbeat,
        heartbeatStatus,
        connect,
        disconnect,
        selectScenario,
        preloadClip,
        sendClipEnded,
    };
}