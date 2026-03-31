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

function secretEnv(key: string, knownBadValue = "CHANGE_ME"): string {
    const value = requireEnv(key);
    if (value === knownBadValue) {
        // Write directly to stderr — Fastify's JSON logger is not yet available
        // at config load time. The key itself is never included in the message.
        process.stderr.write(
            `[WARN] ${key} is set to the default placeholder value. ` +
            "Generate a secure key with: openssl rand -hex 32\n"
        );
    }
    return value;
}

/** Pattern for a valid SHA-256 digest in the form `sha256:<64 hex chars>`. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Reads and validates OLLAMA_MODEL_DIGEST.
 * Returns null when the variable is not set (digest verification disabled).
 * Throws at startup when the variable is set but does not match the expected
 * format — prevents silent skipping of verification due to a typo.
 */
function digestEnv(key: string): string | null {
    const val = process.env[key];
    if (!val) return null;
    if (!DIGEST_RE.test(val)) {
        throw new Error(
            `Environment variable ${key} is set but does not match the required format ` +
            `"sha256:<64 hex chars>". Got: "${val}". ` +
            `Correct the value or unset the variable to disable digest verification.`
        );
    }
    return val;
}

// ─── Config types ─────────────────────────────────────────────────────────────

export interface FeedbackConfig {
    port:                number;
    internalApiKey:      string;
    generatorImpl:       "stub" | "production";
    ollamaHost:          string;
    ollamaModel:         string;
    ollamaTimeoutMs:     number;
    /**
     * When set, the exact SHA-256 digest the Ollama model manifest must match.
     * Format: `sha256:<64 hex chars>`.
     * When null, digest verification is skipped (development only).
     */
    ollamaModelDigest:   string | null;
    /**
     * Timeout for the model pull operation in milliseconds.
     * Distinct from ollamaTimeoutMs which governs generation requests.
     * Large models can take several minutes to download; the default is 10 min.
     */
    ollamaPullTimeoutMs: number;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export function loadConfig(): FeedbackConfig {
    return {
        port:                intEnv("PORT", 8002),
        internalApiKey:      secretEnv("INTERNAL_API_KEY", "CHANGE_ME"),
        generatorImpl:       enumEnv("FEEDBACK_GENERATOR", ["stub", "production"], "stub"),
        ollamaHost:          process.env["OLLAMA_HOST"]  ?? "http://ollama:11434",
        ollamaModel:         process.env["OLLAMA_MODEL"] ?? "llama3.2",
        ollamaTimeoutMs:     intEnv("OLLAMA_TIMEOUT_MS", 120_000),
        ollamaModelDigest:   digestEnv("OLLAMA_MODEL_DIGEST"),
        ollamaPullTimeoutMs: intEnv("OLLAMA_PULL_TIMEOUT_MS", 600_000),
    };
}