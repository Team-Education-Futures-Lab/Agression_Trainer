import type { FastifyBaseLogger } from "fastify";
import type { FeedbackConfig } from "./config.js";

// ─── Ollama API shapes (local — not exported) ─────────────────────────────────

interface OllamaModel {
    name:        string;
    digest:      string;
    modified_at: string;
    size:        number;
}

interface OllamaTagsResponse {
    models: OllamaModel[];
}

interface OllamaShowResponse {
    digest: string;
    [key: string]: unknown;
}

// ─── ensureModel ──────────────────────────────────────────────────────────────

/**
 * Ensures the configured Ollama model is available before the Feedback
 * container begins serving requests.
 *
 * Sequence:
 *   1. List locally available models via GET /api/tags.
 *   2. If the model is absent, pull it via POST /api/pull (blocking).
 *      On failure: log the error and exit with code 1.
 *   3. If OLLAMA_MODEL_DIGEST is set, verify the model's digest via
 *      POST /api/show. On mismatch: log expected vs actual and exit with code 1.
 *   4. Log success — model name and digest (if verified).
 *
 * Called once during startup when FEEDBACK_GENERATOR=production, before the
 * OllamaFeedbackGenerator is instantiated. The stub path bypasses this entirely.
 */
export async function ensureModel(
    config: FeedbackConfig,
    log: FastifyBaseLogger,
): Promise<void> {
    const { ollamaHost, ollamaModel, ollamaModelDigest, ollamaPullTimeoutMs } = config;

    // ── Step 1: check whether the model is already present ────────────────────

    const alreadyPresent = await isModelPresent(ollamaHost, ollamaModel, log);

    // ── Step 2: pull if absent ────────────────────────────────────────────────

    if (!alreadyPresent) {
        log.info({ model: ollamaModel }, "Ollama model not found locally — pulling");

        try {
            const res = await fetch(`${ollamaHost}/api/pull`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ name: ollamaModel, stream: false }),
                signal:  AbortSignal.timeout(ollamaPullTimeoutMs),
            });

            if (!res.ok) {
                const body = await res.text().catch(() => "(unreadable)");
                log.error(
                    { model: ollamaModel, status: res.status, body },
                    "Ollama model pull failed — container cannot start"
                );
                process.exit(1);
            }

            log.info({ model: ollamaModel }, "Ollama model pull completed");
        } catch (err) {
            log.error(
                { model: ollamaModel, err },
                "Ollama model pull failed — container cannot start"
            );
            process.exit(1);
        }
    }

    // ── Step 3: digest verification (always, when digest is configured) ───────

    if (ollamaModelDigest !== null) {
        log.info({ model: ollamaModel }, "Verifying Ollama model digest");

        let actualDigest: string;
        try {
            const res = await fetch(`${ollamaHost}/api/show`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ name: ollamaModel }),
                signal:  AbortSignal.timeout(10_000),
            });

            if (!res.ok) {
                const body = await res.text().catch(() => "(unreadable)");
                log.error(
                    { model: ollamaModel, status: res.status, body },
                    "Failed to retrieve model info for digest verification — container cannot start"
                );
                process.exit(1);
            }

            const data = (await res.json()) as OllamaShowResponse;
            actualDigest = data.digest ?? "";
        } catch (err) {
            log.error(
                { model: ollamaModel, err },
                "Failed to retrieve model info for digest verification — container cannot start"
            );
            process.exit(1);
        }

        if (actualDigest !== ollamaModelDigest) {
            log.error(
                {
                    model:    ollamaModel,
                    expected: ollamaModelDigest,
                    actual:   actualDigest,
                },
                "Ollama model digest mismatch — the pulled model does not match the " +
                "expected digest configured in OLLAMA_MODEL_DIGEST. " +
                "Container cannot start. Verify the model name and digest, or unset " +
                "OLLAMA_MODEL_DIGEST to disable verification."
            );
            process.exit(1);
        }

        log.info(
            { model: ollamaModel, digest: actualDigest },
            "Ollama model digest verified — model ready"
        );
    } else {
        log.info(
            { model: ollamaModel },
            "Ollama model ready (digest verification disabled — set OLLAMA_MODEL_DIGEST to enable)"
        );
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if `model` appears in Ollama's local model list.
 * Treats `llama3.2` and `llama3.2:latest` as equivalent — Ollama's tags
 * response always includes the tag suffix even for implicit-latest references.
 */
async function isModelPresent(
    ollamaHost: string,
    model: string,
    log: FastifyBaseLogger,
): Promise<boolean> {
    try {
        const res = await fetch(`${ollamaHost}/api/tags`, {
            signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
            // Treat a non-OK response as "unknown" — proceed to pull attempt.
            log.warn(
                { status: res.status },
                "Could not list Ollama models — will attempt pull"
            );
            return false;
        }

        const data  = (await res.json()) as OllamaTagsResponse;
        const names = (data.models ?? []).map(m => m.name);

        // Match exact name or name with implicit :latest tag appended.
        const tagged = model.includes(":") ? model : `${model}:latest`;
        return names.includes(model) || names.includes(tagged);
    } catch (err) {
        log.warn(
            { err },
            "Could not reach Ollama to list models — will attempt pull"
        );
        return false;
    }
}