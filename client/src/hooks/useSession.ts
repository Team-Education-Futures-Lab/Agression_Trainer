// =============================================================================
// useSession
//
// Owns a SessionHandler for the lifetime of the component that mounts it.
// Exposes reactive state, the last received ServerMessage, and the handler
// instance for calling connect() / sendClipEnded() / disconnect().
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionState, ServerMessage } from "@ar-training/shared";
import { SessionHandler } from "../session-handler.ts";
import type { CaptureSession } from "../capture.ts";

export interface UseSessionResult {
    handler:     SessionHandler;
    state:       SessionState;
    lastMessage: ServerMessage | null;
    // Derived convenience values
    sessionId:   string | null;
    transcript:  string;        // accumulated for current clip, cleared on clip_ready
    queuePos:    number | null;
    clipScore:   number | null; // from the most recent clip_ready
    // Stable callbacks to pass to UI controls
    connect:     () => Promise<void>;
    disconnect:  () => void;
}

export interface UseSessionOptions {
    /** Called for every inbound ServerMessage in addition to the built-in handling. */
    onMessage?: (msg: ServerMessage) => void;
}

export function useSession(capture: CaptureSession, options: UseSessionOptions = {}): UseSessionResult {
    const handlerRef = useRef<SessionHandler | null>(null);

    const [state,       setState]       = useState<SessionState>("idle");
    const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null);
    const [sessionId,   setSessionId]   = useState<string | null>(null);
    const [transcript,  setTranscript]  = useState("");
    const [queuePos,    setQueuePos]    = useState<number | null>(null);
    const [clipScore,   setClipScore]   = useState<number | null>(null);

    const optionsRef = useRef(options);
    optionsRef.current = options;

    if (!handlerRef.current) {
        handlerRef.current = new SessionHandler(capture, {
            onStateChange: (s) => {
                setState(s);
                if (s === "idle") {
                    setSessionId(null);
                    setTranscript("");
                    setQueuePos(null);
                    setClipScore(null);
                }
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
                            setTranscript(msg.transcript);
                        }
                        break;
                    case "clip_ready":
                        setClipScore(msg.clip_score);
                        setTranscript(""); // clear for next clip
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

    const connect    = useCallback(() => handler.connect(), [handler]);
    const disconnect = useCallback(() => handler.disconnect(), [handler]);

    return {
        handler,
        state,
        lastMessage,
        sessionId,
        transcript,
        queuePos,
        clipScore,
        connect,
        disconnect,
    };
}
