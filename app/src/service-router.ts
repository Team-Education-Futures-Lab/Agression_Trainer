// ─── ServiceRouter ────────────────────────────────────────────────────────────
//
// Generic session-pinned router for any multi-instance backend service.
//
// Guarantees that all calls for a given session always reach the same instance,
// which is required for any service that maintains per-session state (e.g. a
// Transcription container with per-session VAD buffers).
//
// Selection strategy: the session ID is hashed to a stable index into the
// instance list on first access. The mapping is stored until releaseSession()
// is called. This avoids round-robin state while distributing sessions evenly.
//
// When only one URL is configured, all sessions resolve to that URL with no
// hashing overhead.
// ─────────────────────────────────────────────────────────────────────────────

export class ServiceRouter {
    private readonly instances: string[];
    private readonly pinned: Map<string, string> = new Map();

    constructor(instances: string[]) {
        if (instances.length === 0) {
            throw new Error("ServiceRouter requires at least one instance URL");
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
     * Returns the WebSocket URL for a session.
     * Derives from the same pinned instance as getUrl() so HTTP and WebSocket
     * calls always reach the same container.
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
     * Deterministic hash of a string to a non-negative integer.
     * Uses FNV-1a (32-bit) — fast, no dependencies, good distribution for UUIDs.
     */
    private hash(value: string): number {
        let h = 0x811c9dc5;
        for (let i = 0; i < value.length; i++) {
            h ^= value.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h;
    }
}