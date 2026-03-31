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
} from "@ar-training/shared";
import { SessionHandler } from "../session-handler.ts";
import type { CaptureSession } from "../capture.ts";

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
}

export interface UseSessionResult {
    handler:              SessionHandler;
    state:                SessionState;
    lastMessage:          ServerMessage | null;
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
    // Stable callbacks
    connect:              (userId?: string, language?: string) => Promise<void>;
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
    const [sessionId,            setSessionId]            = useState<string | null>(null);
    const [transcript,           setTranscript]           = useState("");
    const [queuePos,             setQueuePos]             = useState<number | null>(null);
    const [clipScore,            setClipScore]            = useState<number | null>(null);
    const [scenarios,            setScenarios]            = useState<ScenarioSummary[]>([]);
    const [clipCandidates,       setClipCandidates]       = useState<ClipCandidateData[]>([]);
    const [currentClipData,      setCurrentClipData]      = useState<ClipData | null>(null);
    const [feedbackUnavailable,  setFeedbackUnavailable]  = useState(false);
    const [sessionHistory,       setSessionHistory]       = useState<SessionHistoryEntry[]>([]);

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
                    updateTranscript("");
                    setQueuePos(null);
                    setClipScore(null);
                    setScenarios([]);
                    setClipCandidates([]);
                    updateCurrentClipData(null);
                    setFeedbackUnavailable(false);
                    setSessionHistory([]);
                    turnCounterRef.current = 0;
                }
            },
            onActivatingClipData: (msg) => {
                updateCurrentClipData(msg);
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
                            endedClipId: endedClip?.clip_id ?? "(unknown)",
                            score:       msg.clip_score,
                            transcript:  snapTx,
                            nextClipId:  msg.clip_id,
                        };

                        setSessionHistory(prev => [...prev, entry]);
                        setClipScore(msg.clip_score);
                        updateTranscript(""); // clear for next clip
                        setClipCandidates([]);
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

    useEffect(() => {
        return () => { handler.disconnect(); };
    }, [handler]);

    const connect        = useCallback((userId?: string, language?: string) =>
        handler.connect(userId, language), [handler]);
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
        sessionId,
        transcript,
        queuePos,
        clipScore,
        scenarios,
        clipCandidates,
        currentClipData,
        feedbackUnavailable,
        sessionHistory,
        connect,
        disconnect,
        selectScenario,
        preloadClip,
        sendClipEnded,
    };
}