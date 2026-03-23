import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { FeedbackRequest, Feedback, BehaviourResult, ConversationTurn, ClipMetadata } from "@ar-training/shared";
import type { FeedbackGeneratorInterface } from "../src/interfaces.js";

// ─── Minimal test server factory ─────────────────────────────────────────────
//
// We don't import main.ts (that would bind a port and call loadConfig()).
// Instead we replicate the route registration logic inline — this mirrors the
// pattern used in the App container's test suite.
// ─────────────────────────────────────────────────────────────────────────────

const TEST_KEY = "test-internal-key";

function buildApp(generator: FeedbackGeneratorInterface): FastifyInstance {
    const app = Fastify({ logger: false });

    function isAuthorised(header: string | undefined): boolean {
        if (!header?.startsWith("Bearer ")) return false;
        return header.slice(7) === TEST_KEY;
    }

    app.get("/feedback/health", async (_req, reply) => {
        return reply.code(200).send({
            status:           "ok",
            ollama_reachable: false,
            model:            "llama3.2",
        });
    });

    app.post<{ Body: FeedbackRequest }>("/feedback/generate", async (req, reply) => {
        if (!isAuthorised(req.headers["authorization"])) {
            return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid Authorization header." });
        }
        const feedback = await generator.generate(req.body);
        return reply.code(200).send(feedback);
    });

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
        for await (const token of generator.generateStream(feedbackReq)) {
            tokens.push(token);
            reply.raw.write(`data: ${JSON.stringify({ type: "token", token })}\n\n`);
        }
        const feedback = await generator.generate(feedbackReq);
        reply.raw.write(`data: ${JSON.stringify({ type: "complete", feedback })}\n\n`);
        reply.raw.end();
    });

    return app;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeClip(clipId: string): ClipMetadata {
    return {
        clip_id:          clipId,
        scenario_id:      "scenario_01",
        video_url:        `/scenarios/scenario_01/${clipId}.mp4`,
        transcript:       "Test transcript",
        notable_features: ["raised_voice"],
        branch_conditions: [{ min_score: -1.0, max_score: 1.01, next_clip: null }],
    };
}

function makeResult(sessionId: string): BehaviourResult {
    return {
        window_id:        `${sessionId}:0`,
        session_id:       sessionId,
        escalation_score: 0.2,
        dominant_emotion: "calm",
        confidence:       1.0,
        signal_summary: {
            voice_tension:   0.4,
            speech_pace:     3.0,
            hand_velocity:   0.2,
            gaze_stability:  0.8,
            open_palm_ratio: 0.5,
            notable_signals: [],
        },
    };
}

function makeTurn(sessionId: string, turnId: number): ConversationTurn {
    return {
        turn_id:            turnId,
        clip:               makeClip(`clip_0${turnId}`),
        student_response:   makeResult(sessionId),
        student_transcript: "Test response",
    };
}

function makeRequest(sessionId: string): FeedbackRequest {
    return {
        session_id:  sessionId,
        scenario_id: "scenario_01",
        language:    "nl",
        history:     [makeTurn(sessionId, 1), makeTurn(sessionId, 2)],
    };
}

// ─── Stub generator for route tests ──────────────────────────────────────────

class RoutesTestGenerator implements FeedbackGeneratorInterface {
    async generate(req: FeedbackRequest): Promise<Feedback> {
        return {
            session_id: req.session_id,
            advice:     "Test advice.",
            severity:   "low",
            highlights: ["Turn 1: all good."],
        };
    }

    async *generateStream(req: FeedbackRequest): AsyncGenerator<string> {
        yield "Test ";
        yield "advice.";
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Feedback routes", () => {
    let app: FastifyInstance;

    beforeEach(() => {
        app = buildApp(new RoutesTestGenerator());
    });

    afterEach(async () => {
        await app.close();
    });

    // ── GET /feedback/health ──────────────────────────────────────────────────

    describe("GET /feedback/health", () => {
        it("returns 200 with status ok", async () => {
            const res = await app.inject({ method: "GET", url: "/feedback/health" });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { status: string; ollama_reachable: boolean; model: string };
            expect(body.status).toBe("ok");
        });

        it("includes ollama_reachable and model fields", async () => {
            const res = await app.inject({ method: "GET", url: "/feedback/health" });
            const body = res.json() as { status: string; ollama_reachable: boolean; model: string };
            expect(typeof body.ollama_reachable).toBe("boolean");
            expect(typeof body.model).toBe("string");
        });

        it("does not require Authorization", async () => {
            const res = await app.inject({ method: "GET", url: "/feedback/health" });
            expect(res.statusCode).toBe(200);
        });
    });

    // ── POST /feedback/generate ───────────────────────────────────────────────

    describe("POST /feedback/generate", () => {
        it("returns 401 when Authorization header is absent", async () => {
            const res = await app.inject({
                method: "POST",
                url:    "/feedback/generate",
                payload: makeRequest("sess-auth-1"),
            });
            expect(res.statusCode).toBe(401);
        });

        it("returns 401 when Authorization header has wrong key", async () => {
            const res = await app.inject({
                method:  "POST",
                url:     "/feedback/generate",
                headers: { Authorization: "Bearer wrong-key" },
                payload: makeRequest("sess-auth-2"),
            });
            expect(res.statusCode).toBe(401);
        });

        it("returns 200 with valid auth", async () => {
            const res = await app.inject({
                method:  "POST",
                url:     "/feedback/generate",
                headers: { Authorization: `Bearer ${TEST_KEY}` },
                payload: makeRequest("sess-gen-1"),
            });
            expect(res.statusCode).toBe(200);
        });

        it("response contains session_id, advice, severity, highlights", async () => {
            const res = await app.inject({
                method:  "POST",
                url:     "/feedback/generate",
                headers: { Authorization: `Bearer ${TEST_KEY}` },
                payload: makeRequest("sess-gen-2"),
            });
            const body = res.json() as Feedback;
            expect(body.session_id).toBe("sess-gen-2");
            expect(typeof body.advice).toBe("string");
            expect(["low", "medium", "high"]).toContain(body.severity);
            expect(Array.isArray(body.highlights)).toBe(true);
        });
    });

    // ── POST /feedback/generate/stream ────────────────────────────────────────

    describe("POST /feedback/generate/stream", () => {
        it("returns 401 when Authorization header is absent", async () => {
            const res = await app.inject({
                method:  "POST",
                url:     "/feedback/generate/stream",
                payload: makeRequest("sess-stream-auth-1"),
            });
            expect(res.statusCode).toBe(401);
        });

        it("returns 401 when Authorization header has wrong key", async () => {
            const res = await app.inject({
                method:  "POST",
                url:     "/feedback/generate/stream",
                headers: { Authorization: "Bearer wrong-key" },
                payload: makeRequest("sess-stream-auth-2"),
            });
            expect(res.statusCode).toBe(401);
        });

        it("returns 200 with content-type text/event-stream", async () => {
            const res = await app.inject({
                method:  "POST",
                url:     "/feedback/generate/stream",
                headers: { Authorization: `Bearer ${TEST_KEY}` },
                payload: makeRequest("sess-stream-1"),
            });
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"]).toContain("text/event-stream");
        });

        it("SSE body contains token events and a final complete event", async () => {
            const res = await app.inject({
                method:  "POST",
                url:     "/feedback/generate/stream",
                headers: { Authorization: `Bearer ${TEST_KEY}` },
                payload: makeRequest("sess-stream-2"),
            });

            const body = res.body;
            const lines = body.split("\n").filter((l: string) => l.startsWith("data:"));
            const events = lines.map((l: string) =>
                JSON.parse(l.replace(/^data: /, "")) as { type: string; token?: string; feedback?: Feedback }
            );

            const tokenEvents = events.filter(e => e.type === "token");
            const completeEvents = events.filter(e => e.type === "complete");

            expect(tokenEvents.length).toBeGreaterThan(0);
            expect(completeEvents.length).toBe(1);
        });

        it("complete event carries session_id, advice, severity, highlights", async () => {
            const res = await app.inject({
                method:  "POST",
                url:     "/feedback/generate/stream",
                headers: { Authorization: `Bearer ${TEST_KEY}` },
                payload: makeRequest("sess-stream-3"),
            });

            const lines = res.body.split("\n").filter((l: string) => l.startsWith("data:"));
            const events = lines.map((l: string) =>
                JSON.parse(l.replace(/^data: /, "")) as { type: string; feedback?: Feedback }
            );
            const complete = events.find(e => e.type === "complete");
            expect(complete).toBeDefined();
            expect(complete?.feedback?.session_id).toBe("sess-stream-3");
            expect(typeof complete?.feedback?.advice).toBe("string");
            expect(["low", "medium", "high"]).toContain(complete?.feedback?.severity);
        });

        it("token events contain non-empty token strings", async () => {
            const res = await app.inject({
                method:  "POST",
                url:     "/feedback/generate/stream",
                headers: { Authorization: `Bearer ${TEST_KEY}` },
                payload: makeRequest("sess-stream-4"),
            });

            const lines = res.body.split("\n").filter((l: string) => l.startsWith("data:"));
            const events = lines.map((l: string) =>
                JSON.parse(l.replace(/^data: /, "")) as { type: string; token?: string }
            );
            const tokenEvents = events.filter(e => e.type === "token");
            for (const ev of tokenEvents) {
                expect(typeof ev.token).toBe("string");
                expect(ev.token!.length).toBeGreaterThan(0);
            }
        });
    });
});