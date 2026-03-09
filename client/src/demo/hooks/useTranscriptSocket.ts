import { useEffect, useRef, useState } from "react";
import type { CaptureSession } from "../../capture";
import type { AudioChunk } from "@ar-training/shared";

// Browser WebSocket cannot send custom headers, so the token is passed as a
// query parameter instead. The Transcription container's ws_verify_token()
// accepts either Authorization: Bearer <key> (server-to-server) or
// ?token=<key> (browser clients).
//
// Set VITE_TRANSCRIPTION_TOKEN in client/.env to enable auth.
// Leave it unset (or set INTERNAL_API_KEY= in transcription/.env) for
// fully open dev mode.

const TRANSCRIPTION_WS    = import.meta.env.VITE_TRANSCRIPTION_WS_URL ?? "ws://localhost:8003";
const TRANSCRIPTION_TOKEN = import.meta.env.VITE_TRANSCRIPTION_TOKEN  ?? "CHANGE_ME";
const SESSION_ID          = "demo-session-001";

function wsUrl(sessionId: string): string {
    const base = `${TRANSCRIPTION_WS}/ws/${sessionId}`;
    return TRANSCRIPTION_TOKEN ? `${base}?token=${encodeURIComponent(TRANSCRIPTION_TOKEN)}` : base;
}

interface TranscriptMessage {
    type:       "transcript";
    session_id: string;
    text:       string;
    window_seq: number;
    is_final:   boolean;
    confidence: number;
}

interface UseTranscriptionSocketResult {
    transcript: string;
    connected:  boolean;
    sessionId:  string;
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

    useEffect(() => {
        if (!active || !capture) return;

        const ws = new WebSocket(wsUrl(SESSION_ID));
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
            setTranscript("");
        };
    }, [active, capture]);

    return { transcript, connected, sessionId: SESSION_ID };
}