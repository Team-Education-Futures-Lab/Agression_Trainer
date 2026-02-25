import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { Coordinator } from "./coordinator.js";
import { StubScenarioLoader } from "./scenario-loader.js";
import type { CreateSessionRequest, ClientMessage } from "@ar-training/shared";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config      = loadConfig();
const app         = Fastify({ logger: true });
const sessions    = new SessionManager(config.sessionManager);
const coordinator = new Coordinator(config.coordinator);
const scenarios   = new StubScenarioLoader();

await app.register(websocketPlugin);

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", async () => ({ status: "ok" }));

// ─── Session routes ───────────────────────────────────────────────────────────

app.post<{ Body: CreateSessionRequest }>("/session/create", async (req, reply) => {
    const { user_id, scenario_id, language } = req.body;
    const result = sessions.createSession(user_id, scenario_id, language);

    if (result.status === "at_capacity") {
        return reply.code(503).send({ error: "at_capacity", message: "Server is at capacity, try again later." });
    }

    if (result.status === "queued") {
        return reply.code(200).send({
            session_id:     result.context.session_id,
            state:          "queued",
            queue_position: result.queue_position,
        });
    }

    return reply.code(200).send({
        session_id:  result.context.session_id,
        state:       "active",
        scenario_id: result.context.scenario_id,
        language:    result.context.language,
    });
});

app.post<{ Params: { session_id: string } }>("/session/:session_id/resume", async (req, reply) => {
    const result = sessions.resumeSession(req.params.session_id);

    if (result.status === "not_found") {
        return reply.code(404).send({ error: "session_not_found", message: "Session not found or expired." });
    }

    const ctx = result.context;
    return reply.code(200).send({
        session_id:      ctx.session_id,
        state:           ctx.state,
        scenario_id:     ctx.scenario_id,
        current_clip_id: ctx.current_clip_id,
        turn_count:      ctx.turn_count,
    });
});

app.post<{ Params: { session_id: string } }>("/session/:session_id/end", async (req, reply) => {
    const { session_id } = req.params;
    const ctx = sessions.getSession(session_id);

    if (!ctx) {
        return reply.code(404).send({ error: "session_not_found", message: "Session not found or expired." });
    }

    await coordinator.flushSession(session_id);
    sessions.endSession(session_id);

    const feedbackReq = sessions.buildFeedbackRequest(session_id);
    if (feedbackReq) {
        coordinator.streamFeedback(session_id, feedbackReq, config.feedbackUrl).catch(err => {
            app.log.error({ err, session_id }, "Feedback streaming failed");
        });
    }

    return reply.code(200).send({
        session_id,
        state:   "completed",
        message: "Feedback generation started. Deliver via WebSocket.",
    });
});

app.get<{ Params: { session_id: string } }>("/session/:session_id/queue", async (req, reply) => {
    const result = sessions.getQueueStatus(req.params.session_id);

    if (result.state === "not_found") {
        return reply.code(404).send({ error: "session_not_found", message: "Session not found or expired." });
    }

    return reply.code(200).send({
        session_id:     req.params.session_id,
        state:          result.state,
        queue_position: result.state === "queued" ? result.queue_position : null,
    });
});

// ─── WebSocket handler ────────────────────────────────────────────────────────

app.get("/ws/:session_id", { websocket: true }, (socket, req) => {
    const { session_id } = req.params as { session_id: string };
    const ctx = sessions.getSession(session_id);

    if (!ctx || ctx.state !== "CONNECTING") {
        socket.send(JSON.stringify({
            type:       "error",
            session_id,
            code:       "session_not_found",
            message:    "Session not found or not in CONNECTING state.",
        }));
        socket.close();
        return;
    }

    const entryClipId = ctx.current_clip_id ?? scenarios.getEntryClip(ctx.scenario_id);
    const clip        = entryClipId ? scenarios.getClip(ctx.scenario_id, entryClipId) : null;

    if (!clip) {
        socket.send(JSON.stringify({
            type:       "error",
            session_id,
            code:       "scenario_not_found",
            message:    `No entry clip found for scenario ${ctx.scenario_id}.`,
        }));
        socket.close();
        return;
    }

    const sendFn = (msg: object) => socket.send(JSON.stringify(msg));
    coordinator.registerSession(session_id, clip, sendFn);
    sessions.markActive(session_id);
    sessions.setCurrentClip(session_id, clip.clip_id);

    socket.on("message", (raw: Buffer) => {
        let msg: ClientMessage;
        try {
            msg = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
            app.log.warn({ session_id }, "Received malformed WebSocket message");
            return;
        }

        if (msg.type === "video_frame") {
            coordinator.onFrame(msg);
        } else if (msg.type === "audio_chunk") {
            coordinator.onAudio(msg);
        } else {
            app.log.warn({ session_id }, "Received unknown WebSocket message type");
        }
    });

    socket.on("close", () => {
        coordinator.deregisterSession(session_id);
        sessions.markDropped(session_id);
    });
});

// ─── Start ────────────────────────────────────────────────────────────────────

try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
    app.log.error(err);
    process.exit(1);
}
