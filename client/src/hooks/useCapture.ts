// =============================================================================
// useCapture
//
// Owns a CaptureSession for the lifetime of the component that mounts it.
// Exposes the session instance, a ready flag, and the live video element ref
// that capture.start() binds to.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { CaptureSession } from "../capture.ts";

export interface UseCaptureResult {
    capture:  CaptureSession;
    ready:    boolean;       // true once init() has completed
    videoRef: React.RefObject<HTMLVideoElement | null>;
}

export function useCapture(): UseCaptureResult {
    const captureRef = useRef<CaptureSession | null>(null);
    const videoRef   = useRef<HTMLVideoElement | null>(null);
    const [ready, setReady] = useState(false);

    if (!captureRef.current) {
        captureRef.current = new CaptureSession();
    }
    const capture = captureRef.current;

    useEffect(() => {
        let cancelled = false;

        capture.init().then(() => {
            if (!cancelled) setReady(true);
        }).catch((e: unknown) => {
            console.error("[useCapture] init failed:", e);
        });

        return () => {
            cancelled = true;
            capture.stop();
        };
    }, [capture]);

    return { capture, ready, videoRef };
}
