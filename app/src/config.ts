import type { SessionManagerConfig, CoordinatorConfig } from "./types.js";
import { join } from "node:path";

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

function boolEnv(key: string, fallback: boolean): boolean {
    const val = process.env[key];
    if (!val) return fallback;
    if (val === "true" || val === "1")  return true;
    if (val === "false" || val === "0") return false;
    throw new Error(`Environment variable ${key} must be true/false/1/0, got: "${val}"`);
}

function secretEnv(key: string, knownBadValue: string = "CHANGE_ME"): string {
    const value = requireEnv(key);
    if (value === knownBadValue) {
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
     */
    corsOrigin:         string | true;
    feedbackTimeoutMs:  number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs:  number;

    // ── Authentication ────────────────────────────────────────────────────────

    /**
     * Secret used to sign and verify JWTs. Required. Generate with:
     *   openssl rand -hex 32
     */
    jwtSecret:                  string;
    /**
     * JWT expiry duration in shorthand notation, e.g. "8h", "30m", "1d".
     * Default: "8h" (a school day).
     */
    jwtExpiry:                  string;
    /**
     * Path to the SQLite database file for user accounts and token blocklist.
     * Constructed as `join(DATA_DIR, "auth.db")`. DATA_DIR must be a
     * bind-mounted directory that persists across container recreations.
     */
    dbPath:                     string;
    /**
     * When true, POST /auth/register is open. Default false.
     * Set to true only in development — in production, admins create accounts.
     */
    allowRegistration:          boolean;
    /**
     * Bootstrap admin username. Used only when the users table is empty and
     * both bootstrap vars are set. Ignored once any user exists.
     */
    bootstrapAdminUsername:     string | undefined;
    /**
     * Bootstrap admin password. Must be at least 8 characters.
     * Ignored once any user exists in the database.
     */
    bootstrapAdminPassword:     string | undefined;

    /**
     * When true, the /auth/dev/* endpoints are active.
     * These endpoints perform unauthenticated database operations and MUST
     * NOT be enabled in production deployments.
     *
     * Set via DEV_TOOLS_ENABLED=true in the App container's .env.
     * Default: false.
     */
    devToolsEnabled: boolean;

    coordinator:        CoordinatorConfig;
    sessionManager:     SessionManagerConfig;
}

export function loadConfig(): AppConfig {
    const internalApiKey    = secretEnv("INTERNAL_API_KEY", "CHANGE_ME");
    const evaluationUrls    = parseStringList("EVALUATION_URL");
    const transcriptionUrls = parseStringList("TRANSCRIPTION_URL");

    const corsOriginEnv = process.env["CORS_ORIGIN"];
    const corsOrigin: string | true = corsOriginEnv ? corsOriginEnv : true;

    // DATA_DIR is required; dbPath is derived from it.
    const dataDir = requireEnv("DATA_DIR");
    const dbPath  = join(dataDir, "auth.db");

    // JWT_SECRET is required; warn if it's the placeholder.
    const jwtSecret = secretEnv("JWT_SECRET", "CHANGE_ME");

    const bootstrapUsername = process.env["BOOTSTRAP_ADMIN_USERNAME"] || undefined;
    const bootstrapPassword = process.env["BOOTSTRAP_ADMIN_PASSWORD"] || undefined;

    const devToolsEnabled = boolEnv("DEV_TOOLS_ENABLED", false);
    if (devToolsEnabled) {
        process.stderr.write(
            "[WARN] DEV_TOOLS_ENABLED=true — unauthenticated database endpoints are active (/auth/dev/*).\n" +
            "       This setting must NEVER be used in production deployments.\n"
        );
    }

    return {
        port:                intEnv("PORT", 3000),
        evaluationUrls,
        transcriptionUrls,
        feedbackUrl:         requireEnv("FEEDBACK_URL"),
        scenariosDir:        requireEnv("SCENARIOS_DIR"),
        internalApiKey,
        corsOrigin,
        feedbackTimeoutMs:   intEnv("FEEDBACK_TIMEOUT_MS",    150_000),
        heartbeatIntervalMs: intEnv("HEARTBEAT_INTERVAL_MS",   30_000),
        heartbeatTimeoutMs:  intEnv("HEARTBEAT_TIMEOUT_MS",    70_000),

        jwtSecret,
        jwtExpiry:                  process.env["JWT_EXPIRY"] || "8h",
        dbPath,
        allowRegistration:          boolEnv("ALLOW_REGISTRATION", false),
        bootstrapAdminUsername:     bootstrapUsername,
        bootstrapAdminPassword:     bootstrapPassword,

        devToolsEnabled,

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
            // ADMIN_API_KEY is retained as a backwards-compatible fallback for
            // POST /scenarios tooling. Optional — if unset, only JWT auth is available.
            adminApiKey:      process.env["ADMIN_API_KEY"] || undefined,
        },
    };
}