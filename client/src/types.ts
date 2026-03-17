// =============================================================================
// AR Training — Client-internal types
// These types are local to the client and never cross container boundaries.
// Wire-format DTOs live in @ar-training/shared.
// =============================================================================

import type { MfccMatrix } from "@ar-training/shared";

// ─── Capture pipeline ─────────────────────────────────────────────────────────

/**
 * Raw landmark data produced by MediaPipe on a single animation frame.
 * Not yet stamped with a session_id — that happens in SessionHandler when
 * a session is active.
 */
export interface RawVideoFrame {
    /** Monotonically increasing, reset to 0 when CaptureSession starts. */
    frame_id: number;
    /** Seconds elapsed since CaptureSession.start() was called. */
    timestamp: number;
    face_landmarks: { x: number; y: number; z: number; visibility: number }[];
    left_hand:      { x: number; y: number; z: number; visibility: number }[];
    right_hand:     { x: number; y: number; z: number; visibility: number }[];
}

/**
 * Raw audio data produced by the capture pipeline for approximately 2 seconds
 * of microphone input. Not yet stamped with a session_id.
 */
export interface RawAudioChunk {
    /** Monotonically increasing, reset to 0 when CaptureSession starts. */
    chunk_id: number;
    /** Seconds elapsed since CaptureSession.start() was called. */
    timestamp: number;
    /** Base64-encoded s16le PCM, resampled to 16000 Hz. */
    pcm: string;
    /** Always 16000 — matches the wire format requirement. */
    sample_rate: 16000;
    /**
     * MFCCs computed from the raw (pre-resampled) samples via Meyda.
     * Shape: [n_frames][13]
     */
    mfccs: MfccMatrix;
}

// ─── BroadcastChannel ─────────────────────────────────────────────────────────

/**
 * A push channel that broadcasts items to multiple independent async-iterable
 * subscribers. Each call to [Symbol.asyncIterator]() returns an independent
 * iterator with its own bounded queue.
 *
 * If a subscriber's queue fills beyond `maxQueueDepth`, the oldest item is
 * dropped to prevent slow consumers from accumulating unbounded memory.
 */
export class BroadcastChannel<T> {
    private readonly subscribers = new Set<(value: T | null) => void>();
    private readonly maxQueueDepth: number;

    constructor(maxQueueDepth = 120) {
        this.maxQueueDepth = maxQueueDepth;
    }

    /** Push an item to all current subscribers. */
    push(value: T): void {
        for (const sub of this.subscribers) sub(value);
    }

    /** Close the channel — signals done to all active iterators. */
    close(): void {
        for (const sub of this.subscribers) sub(null);
        this.subscribers.clear();
    }

    /**
     * Returns an AsyncIterator that yields items as they are pushed.
     * The iterator ends when close() is called or return() is called by the
     * consumer (e.g. a for-await-of break).
     */
    [Symbol.asyncIterator](): AsyncIterator<T> {
        const subscribers   = this.subscribers;
        const maxDepth      = this.maxQueueDepth;
        const queue: T[]    = [];
        let resolve: ((result: IteratorResult<T>) => void) | null = null;
        let done = false;

        const subscriber = (value: T | null) => {
            if (value === null) {
                done = true;
                resolve?.({ value: undefined as unknown as T, done: true });
                resolve = null;
                return;
            }
            if (resolve) {
                resolve({ value, done: false });
                resolve = null;
            } else {
                if (queue.length >= maxDepth) queue.shift(); // drop oldest
                queue.push(value);
            }
        };

        subscribers.add(subscriber);

        return {
            next(): Promise<IteratorResult<T>> {
                if (queue.length > 0) {
                    return Promise.resolve({ value: queue.shift()!, done: false });
                }
                if (done) {
                    return Promise.resolve({ value: undefined as unknown as T, done: true });
                }
                return new Promise(r => { resolve = r; });
            },
            return(): Promise<IteratorResult<T>> {
                subscribers.delete(subscriber);
                return Promise.resolve({ value: undefined as unknown as T, done: true });
            },
        };
    }
}
