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

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AppConfig {
    port:           number;
    evaluationUrl:  string;
    feedbackUrl:    string;
    coordinator:    CoordinatorConfig;
    sessionManager: SessionManagerConfig;
}

export function loadConfig(): AppConfig {
    return {
        port:          intEnv("PORT", 3000),
        evaluationUrl: requireEnv("EVALUATION_URL"),
        feedbackUrl:   requireEnv("FEEDBACK_URL"),
        coordinator: {
            evaluationUrl:      requireEnv("EVALUATION_URL"),
            minFramesPerWindow: intEnv("MIN_FRAMES_PER_WINDOW", 10),
            windowMs:           intEnv("WINDOW_MS", 2_000),
        },
        sessionManager: {
            maxSessions:      intEnv("MAX_SESSIONS",       32),
            maxQueueSize:     intEnv("MAX_QUEUE_SIZE",     10),
            capacityPolicy:   enumEnv("CAPACITY_POLICY",  ["QUEUE", "REJECT"], "QUEUE"),
            sessionTimeoutMs: intEnv("SESSION_TIMEOUT_MS", 30_000),
            recoveryWindowMs: intEnv("RECOVERY_WINDOW_MS", 30_000),
        },
    };
}
