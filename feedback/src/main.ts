import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.js";
import { StubFeedbackGenerator } from "./stub-feedback-generator.js";
import { OllamaFeedbackGenerator } from "./ollama-feedback-generator.js";
import type { FeedbackGeneratorInterface } from "./interfaces.js";
import type { Feedback, FeedbackRequest } from "@ar-training/shared";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();
const app    = Fastify({
    logger: {
        // Redact the Authorization header from all request/response logs so
        // INTERNAL_API_KEY never appears in log output.
        redact: ["req.headers.authorization"],
    },
});

const generator: FeedbackGeneratorInterface =
    config.generatorImpl === "production"
        ? new OllamaFeedbackGenerator(config)
        : new StubFeedbackGenerator();

// ─── Auth helper ──────────────────────────────────────────────────────────────

/**
 * Validates the Authorization header using a timing-safe comparison to prevent
 * key enumeration via timing attacks.
 *
 * Returns false when the header is absent, malformed, or the token does not
 * match INTERNAL_API_KEY.
 */
function isAuthorised(authHeader: string | undefined): boolean {
    if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
    const token    = authHeader.slice(7);
    const expected = config.internalApiKey;
    // Length mismatch is non-secret information; early false here is acceptable.
    if (token.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/feedback/health", async (_req, reply) => {
    let ollamaReachable = false;
    if (config.generatorImpl === "production") {
        ollamaReachable = await fetch(`${config.ollamaHost}/api/version`, {
            signal: AbortSignal.timeout(5_000),
        })
            .then(r => r.ok)
            .catch(() => false);
    }

    return reply.code(200).send({
        status:           "ok",
        ollama_reachable: ollamaReachable,
        model:            config.ollamaModel,
    });
});

// ─── POST /feedback/generate ─────────────────────────────────────────────────

app.post<{ Body: FeedbackRequest }>("/feedback/generate", async (req, reply) => {
    if (!isAuthorised(req.headers["authorization"])) {
        return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid Authorization header." });
    }

    const feedback = await generator.generate(req.body);
    return reply.code(200).send(feedback);
});

// ─── POST /feedback/generate/stream ──────────────────────────────────────────

app.post<{ Body: FeedbackRequest }>("/feedback/generate/stream", async (req, reply) => {
    if (!isAuthorised(req.headers["authorization"])) {
        return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid Authorization header." });
    }

    const feedbackReq = req.body;

    reply.raw.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
    });

    const tokens: string[] = [];

    try {
        for await (const token of generator.generateStream(feedbackReq)) {
            tokens.push(token);
            reply.raw.write(`data: ${JSON.stringify({ type: "token", token })}\n\n`);
        }

        // Assemble the complete Feedback object for the `complete` event.
        // Both stub and Ollama paths accumulate the full text in `tokens`; the
        // only difference is how that text is parsed (plain string vs JSON blob).
        const feedback = assembleFeedback(feedbackReq.session_id, tokens.join(""));

        reply.raw.write(`data: ${JSON.stringify({ type: "complete", feedback })}\n\n`);
    } catch (err) {
        app.log.error({ err, session_id: feedbackReq.session_id }, "Feedback generation failed");
        reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "Generation failed" })}\n\n`);
    } finally {
        reply.raw.end();
    }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Assemble the final Feedback object for the SSE `complete` event from the
 * accumulated token stream.
 *
 * For the Ollama (production) path the LLM emits a JSON blob as its token
 * stream, which is parsed here. For the stub path, generateStream() also
 * yields the canned advice string which is treated as plain text — the JSON
 * parse will fail and the fallback wraps it directly as `advice`.
 *
 * This unified path avoids making a second generate() call for the stub.
 */
function assembleFeedback(
    sessionId: string,
    accumulatedText: string,
): Feedback {
    const cleaned = accumulatedText.replace(/```json|```/g, "").trim();
    try {
        const parsed = JSON.parse(cleaned) as {
            advice?:     string;
            severity?:   "low" | "medium" | "high";
            highlights?: string[];
        };
        return {
            session_id: sessionId,
            advice:     parsed.advice     ?? "",
            severity:   parsed.severity   ?? "medium",
            highlights: parsed.highlights ?? [],
        };
    } catch {
        // Not valid JSON — treat the whole text as the advice string.
        // This is the normal path for the stub, whose token stream is plain text.
        return {
            session_id: sessionId,
            advice:     accumulatedText.trim(),
            severity:   "medium",
            highlights: [],
        };
    }
}

// ─── Start ────────────────────────────────────────────────────────────────────

try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
    app.log.error(err);
    process.exit(1);
}