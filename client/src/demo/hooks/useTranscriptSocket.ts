import { useEffect, useRef, useState } from "react";
import type { CaptureSession } from "../../capture";
import type { AudioChunk } from "@ar-training/shared";

// Auth is disabled on the Transcription container in dev mode.
// When auth is re-enabled, pass the token as a query param:
//   ws://host:8003/ws/{id}?token=<INTERNAL_API_KEY>
// (Browser WebSocket does not support custom headers — query param is the
//  correct solution for browser-initiated connections. Server-side connections
//  from the App container continue to use Authorization: Bearer as normal.)

const TRANSCRIPTION_WS = import.meta.env.VITE_TRANSCRIPTION_WS_URL ?? "ws://localhost:8003";
const SESSION_ID        = "demo-session-001";

interface TranscriptMessage {
    type:       "transcript";
    session_id: string;
    text:       string;
    window_seq: number;
    is_final:   boolean;
    confidence: number;
}

interface UseTranscriptionSocketResult {
    transcript:  string;
    connected:   boolean;
    sessionId:   string;
}

/**
 * Connects directly to the Transcription container WebSocket and streams
 * AudioChunks from CaptureSession into it. Returns the accumulated live
 * transcript for the current clip.
 *
 * This is a demo-only hook — in production the App container owns this
 * WebSocket connection and mediates all audio/transcript traffic.
 */
export function useTranscriptionSocket(
    capture: CaptureSession | null,
    active:  boolean,
): UseTranscriptionSocketResult {
    const [transcript, setTranscript] = useState("");
    const [connected,  setConnected]  = useState(false);

    const wsRef        = useRef<WebSocket | null>(null);
    const abortRef     = useRef<AbortController | null>(null);
    const chunkIdRef   = useRef(0);
    const startedAtRef = useRef(performance.now());

    // Reset transcript between clips
    const resetTranscript = () => setTranscript("");

    useEffect(() => {
        if (!active || !capture) return;

        const ws = new WebSocket(`${TRANSCRIPTION_WS}/ws/${SESSION_ID}`);
        wsRef.current    = ws;
        abortRef.current = new AbortController();

        ws.onopen = () => {
            setConnected(true);
            chunkIdRef.current   = 0;
            startedAtRef.current = performance.now();
        };

        ws.onclose = () => setConnected(false);
        ws.onerror = () => setConnected(false);

        ws.onmessage = (e) => {
            try {
                const msg: TranscriptMessage = JSON.parse(e.data);
                if (msg.type !== "transcript") return;
                // Append new text — ClipSession-style accumulation
                setTranscript(prev => prev ? prev + " " + msg.text : msg.text);
            } catch {
                // ignore malformed frames
            }
        };

        // Pump audio chunks into the transcription socket
        const abort = abortRef.current;
        async function pumpAudio() {
            if (!capture) return;
            for await (const raw of capture.audio()) {
                if (abort.signal.aborted) break;
                if (ws.readyState !== WebSocket.OPEN) continue;

                const chunk: AudioChunk = {
                    type:        "audio_chunk",
                    session_id:  SESSION_ID,
                    chunk_id:    chunkIdRef.current++,
                    timestamp:   (performance.now() - startedAtRef.current) / 1000,
                    pcm:         raw.pcm,
                    sample_rate: raw.sample_rate,
                    mfccs:       raw.mfccs,
                };
                ws.send(JSON.stringify(chunk));
            }
        }

        pumpAudio();

        return () => {
            abort.abort();
            ws.close();
            wsRef.current = null;
            setConnected(false);
            resetTranscript();
        };
    }, [active, capture]);

    return { transcript, connected, sessionId: SESSION_ID };
}
