import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { Coordinator } from "./coordinator.js";
import { FileScenarioLoader } from "./scenario-loader.js";
import { FeedbackClient } from "./feedback-client.js";
import { ClipController } from "./clip-controller.js";
import type { CreateSessionRequest, ClientMessage } from "@ar-training/shared";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config       = loadConfig();
const app          = Fastify({ logger: true });
const sessions     = new SessionManager(config.sessionManager);
const coord = new Coordinator(config.coordinator);
const scenarios  = new FileScenarioLoader(config.scenariosDir);
const feedback   = new FeedbackClient(config.feedbackUrl, config.internalApiKey);
const controller = new ClipController(sessions, coord, scenarios, feedback);

await app.register(websocketPlugin);

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", async (_req, reply) => {
    const [evalResults, transcriptionResults] = await Promise.all([
        Promise.allSettled(
            config.evaluationUrls.map(url =>
                fetch(`${url}/evaluate/health`).then(r => r.ok)
            )
        ),
        Promise.allSettled(
            config.transcriptionUrls.map(url =>
                fetch(`${url}/transcription/health`).then(r => r.ok)
            )
        ),
    ]);

    function buildInstanceStatus(urls: string[], results: PromiseSettledResult<boolean>[]) {
        const instances: Record<string, "ok" | "unreachable"> = {};
        let okCount = 0;
        for (let i = 0; i < results.length; i++) {
            const ok = results[i].status === "fulfilled" && (results[i] as PromiseFulfilledResult<boolean>).value;
            instances[urls[i]] = ok ? "ok" : "unreachable";
            if (ok) okCount++;
        }
        const status = okCount === urls.length ? "ok"
            : okCount === 0           ? "critical"
                :                           "degraded";
        return { status, instances, okCount };
    }

    const eval_ = buildInstanceStatus(config.evaluationUrls,    evalResults);
    const trans  = buildInstanceStatus(config.transcriptionUrls, transcriptionResults);

    const feedOk     = await fetch(`${config.feedbackUrl}/feedback/health`)
        .then(r => r.ok).catch(() => false);
    const feedStatus = feedOk ? "ok" : "unreachable";

    const overallStatus =
        eval_.status === "critical" || trans.status === "critical" ? "critical"
            : eval_.status === "degraded" || trans.status === "degraded" || feedStatus === "unreachable" ? "degraded"
                : "ok";

    return reply
        .code(overallStatus === "critical" ? 503 : 200)
        .send({
            status: overallStatus,
            services: {
                evaluation:    { status: eval_.status,  instances: eval_.instances },
                transcription: { status: trans.status,  instances: trans.instances },
                feedback:      { status: feedStatus },
            },
        });
});

// ─── Session routes ───────────────────────────────────────────────────────────

app.post<{ Body: CreateSessionRequest }>("/session/create", async (req, reply) => {
    const { user_id, scenario_id, language } = req.body;
    const result = sessions.createSession(user_id, scenario_id, language);

    if (result.status === "at_capacity") {
        return reply.code(503).send({ error: "at_capacity", message: "Server is at capacity." });
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

    await coord.flushSession(session_id);
    const feedbackReq = sessions.buildFeedbackRequest(session_id);
    sessions.endSession(session_id);

    if (feedbackReq) {
        app.log.warn({ session_id }, "session/end called outside clip flow — feedback not streamed to client");
    }

    return reply.code(200).send({ session_id, state: "completed", message: "Session ended." });
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
            type: "error", session_id,
            code: "session_not_found",
            message: "Session not found or not in CONNECTING state.",
        }));
        socket.close();
        return;
    }

    const entryClipId = ctx.current_clip_id ?? scenarios.getEntryClip(ctx.scenario_id);
    const clip        = entryClipId ? scenarios.getClip(ctx.scenario_id, entryClipId) : null;

    if (!clip) {
        socket.send(JSON.stringify({
            type: "error", session_id,
            code: "scenario_not_found",
            message: `No entry clip found for scenario ${ctx.scenario_id}.`,
        }));
        socket.close();
        return;
    }

    const sendFn = (msg: object) => socket.send(JSON.stringify(msg));
    coord.registerSession(session_id, clip, sendFn);
    sessions.markActive(session_id);
    sessions.setCurrentClip(session_id, clip.clip_id);

    socket.on("message", (raw: Buffer) => {
        let msg: ClientMessage;
        try {
            msg = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
            app.log.warn({ session_id }, "Malformed WebSocket message");
            return;
        }

        if (msg.type === "video_frame") {
            coord.onFrame(msg);
        } else if (msg.type === "audio_chunk") {
            coord.onAudio(msg);
        } else if (msg.type === "clip_ended") {
            controller.handleClipEnded(msg, sendFn).catch(err =>
                app.log.error({ err, session_id }, "clip_ended handling failed")
            );
        } else {
            app.log.warn({ session_id }, "Unknown WebSocket message type");
        }
    });

    socket.on("close", () => {
        coord.deregisterSession(session_id);
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
