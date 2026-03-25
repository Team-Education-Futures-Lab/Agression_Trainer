import type { SessionManagerConfig, CoordinatorConfig } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required environment variable: ${key}`);
    return val;
}

function intEnv(key: string, fallback: number): number {
    const val = process.env[key];
    if (!val) return fallback;
    const n = parseInt(val, 10);
    if (isNaN(n)) throw new Error(`Environment variable ${key} must be an integer, got: "${val}"`);
    return n;
}

function enumEnv<T extends string>(key: string, allowed: T[], fallback: T): T {
    const val = process.env[key];
    if (!val) return fallback;
    if (!allowed.includes(val as T)) {
        throw new Error(`Environment variable ${key} must be one of [${allowed.join(", ")}], got: "${val}"`);
    }
    return val as T;
}

function secretEnv(key: string, knownBadValue: string = "CHANGE_ME"): string {
    const value = requireEnv(key);
    if (value === knownBadValue) {
        // Use the structured logger-compatible approach: log after Fastify
        // bootstraps. For config-time warnings (before Fastify starts) we
        // have no choice but to write to stderr directly. The key itself is
        // never included in the message.
        process.stderr.write(
            `[WARN] ${key} is set to the default placeholder value. ` +
            "Generate a secure key with: openssl rand -hex 32\n"
        );
    }
    return value;
}

function parseStringList(key: string): string[] {
    const val = process.env[key];
    if (val) return val.split(",").map(u => u.trim()).filter(Boolean);
    return [requireEnv(key)];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AppConfig {
    port:               number;
    evaluationUrls:     string[];
    transcriptionUrls:  string[];
    feedbackUrl:        string;
    scenariosDir:       string;
    internalApiKey:     string;
    /**
     * Allowed CORS origin for HTTP endpoints.
     * `true`   — reflect any origin (default; correct for single-server classroom use).
     * `string` — restrict to this exact origin (e.g. "http://localhost:3000").
     * Set via CORS_ORIGIN environment variable.
     */
    corsOrigin:         string | true;
    /**
     * Timeout in ms for the full feedback SSE stream from the Feedback container.
     * Should be set slightly above the Feedback container's OLLAMA_TIMEOUT_MS
     * to allow Ollama to finish and the container to write the final SSE event.
     * Default: 150 000 ms (150 s).
     */
    feedbackTimeoutMs:  number;
    coordinator:        CoordinatorConfig;
    sessionManager:     SessionManagerConfig;
}

export function loadConfig(): AppConfig {
    const internalApiKey    = secretEnv("INTERNAL_API_KEY", "CHANGE_ME");
    const evaluationUrls    = parseStringList("EVALUATION_URL");
    const transcriptionUrls = parseStringList("TRANSCRIPTION_URL");

    // CORS_ORIGIN: if unset, default to true (allow any origin).
    // If set, use the provided string as the exact allowed origin.
    const corsOriginEnv = process.env["CORS_ORIGIN"];
    const corsOrigin: string | true = corsOriginEnv ? corsOriginEnv : true;

    return {
        port:              intEnv("PORT", 3000),
        evaluationUrls,
        transcriptionUrls,
        feedbackUrl:       requireEnv("FEEDBACK_URL"),
        scenariosDir:      requireEnv("SCENARIOS_DIR"),
        internalApiKey,
        corsOrigin,
        feedbackTimeoutMs: intEnv("FEEDBACK_TIMEOUT_MS", 150_000),
        coordinator: {
            evaluationUrls,
            transcriptionUrls,
            internalApiKey,
        },
        sessionManager: {
            maxSessions:      intEnv("MAX_SESSIONS",       32),
            maxQueueSize:     intEnv("MAX_QUEUE_SIZE",     10),
            capacityPolicy:   enumEnv("CAPACITY_POLICY",  ["QUEUE", "REJECT"], "QUEUE"),
            sessionTimeoutMs: intEnv("SESSION_TIMEOUT_MS", 30_000),
            recoveryWindowMs: intEnv("RECOVERY_WINDOW_MS", 30_000),
            // Optional — if unset, admin mode is permanently unavailable.
            adminApiKey:      process.env["ADMIN_API_KEY"] || undefined,
        },
    };
}