// ─── EvaluationRouter ─────────────────────────────────────────────────────────
//
// Selects which Evaluation instance to use for a given session and keeps that
// mapping stable for the session's lifetime (session pinning).
//
// Pinning guarantees that all REST calls and the audio WebSocket for a session
// always reach the same Evaluation instance, so the per-session Whisper VAD
// buffer stays coherent across requests.
//
// Selection strategy: the session ID is hashed to an index into the instance
// list. The mapping is stored on first access and released when the session
// ends. This avoids round-robin state while still distributing sessions evenly
// across instances.
//
// When only one URL is configured, all sessions resolve to that URL with no
// hashing overhead.
// ─────────────────────────────────────────────────────────────────────────────

export class EvaluationRouter {
    private readonly instances: string[];
    private readonly pinned: Map<string, string> = new Map();

    constructor(instances: string[]) {
        if (instances.length === 0) {
            throw new Error("EvaluationRouter requires at least one instance URL");
        }
        this.instances = instances.map(u => u.replace(/\/+$/, ""));
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Returns the base HTTP URL for a session.
     * The same session ID always returns the same URL.
     */
    getUrl(sessionId: string): string {
        return this.resolve(sessionId);
    }

    /**
     * Returns the WebSocket URL for a session's audio stream.
     * Derives from the same pinned instance as getUrl() so REST calls and the
     * audio WebSocket always reach the same container.
     */
    getWsUrl(sessionId: string): string {
        return this.resolve(sessionId)
            .replace(/^http:\/\//, "ws://")
            .replace(/^https:\/\//, "wss://");
    }

    /**
     * Releases the pinned mapping for a session.
     * Call this when a session ends so memory is not held indefinitely.
     */
    releaseSession(sessionId: string): void {
        this.pinned.delete(sessionId);
    }

    /** Total number of configured instances. */
    get instanceCount(): number {
        return this.instances.length;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private resolve(sessionId: string): string {
        const existing = this.pinned.get(sessionId);
        if (existing) return existing;

        const url = this.instances[this.hash(sessionId) % this.instances.length];
        this.pinned.set(sessionId, url);
        return url;
    }

    /**
     * Deterministic hash of a session ID string to a non-negative integer.
     * Uses FNV-1a (32-bit) — fast, no dependencies, good distribution for UUIDs.
     */
    private hash(sessionId: string): number {
        let h = 0x811c9dc5;
        for (let i = 0; i < sessionId.length; i++) {
            h ^= sessionId.charCodeAt(i);
            // Unsigned 32-bit multiply: keep result in 32-bit range.
            h = (h * 0x01000193) >>> 0;
        }
        return h;
    }
}