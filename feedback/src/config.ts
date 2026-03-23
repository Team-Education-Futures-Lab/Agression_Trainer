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
        console.warn(
            `[WARN] ${key} is set to the default placeholder value. ` +
            "Generate a secure key with: openssl rand -hex 32"
        );
    }
    return value;
}

// ─── Config types ─────────────────────────────────────────────────────────────

export interface FeedbackConfig {
    port:              number;
    internalApiKey:    string;
    generatorImpl:     "stub" | "production";
    ollamaHost:        string;
    ollamaModel:       string;
    ollamaTimeoutMs:   number;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export function loadConfig(): FeedbackConfig {
    return {
        port:            intEnv("PORT", 8002),
        internalApiKey:  secretEnv("INTERNAL_API_KEY", "CHANGE_ME"),
        generatorImpl:   enumEnv("FEEDBACK_GENERATOR", ["stub", "production"], "stub"),
        ollamaHost:      process.env["OLLAMA_HOST"]  ?? "http://ollama:11434",
        ollamaModel:     process.env["OLLAMA_MODEL"] ?? "llama3.2",
        ollamaTimeoutMs: intEnv("OLLAMA_TIMEOUT_MS", 120_000),
    };
}