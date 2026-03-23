import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { StubFeedbackGenerator } from "./stub-feedback-generator.js";
import { OllamaFeedbackGenerator } from "./ollama-feedback-generator.js";
import type { FeedbackGeneratorInterface } from "./interfaces.js";
import type { Feedback, FeedbackRequest } from "@ar-training/shared";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();
const app    = Fastify({ logger: true });

const generator: FeedbackGeneratorInterface =
    config.generatorImpl === "production"
        ? new OllamaFeedbackGenerator(config)
        : new StubFeedbackGenerator();

// ─── Auth helper ──────────────────────────────────────────────────────────────

function isAuthorised(authHeader: string | undefined): boolean {
    if (!authHeader?.startsWith("Bearer ")) return false;
    return authHeader?.slice(7) === config.internalApiKey;
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

        const feedback = assembleFeedback(req.body.session_id, tokens.join(""), config.generatorImpl === "stub"
            ? await generator.generate(feedbackReq)
            : undefined);

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
 * Assemble the final Feedback object for the SSE `complete` event.
 *
 * For the stub, the generator produces a deterministic object — pass it
 * directly. For Ollama, the LLM emits a JSON blob as its token stream;
 * parse the accumulated text rather than making a second Ollama call.
 */
function assembleFeedback(
    sessionId: string,
    accumulatedText: string,
    stubResult: Feedback | undefined,
): Feedback {
    if (stubResult !== undefined) return stubResult;

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