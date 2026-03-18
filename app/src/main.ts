import Fastify from "fastify";
// noinspection TypeScriptCheckImport
import websocketPlugin from "@fastify/websocket";
// noinspection TypeScriptCheckImport
import cors from "@fastify/cors";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { Coordinator } from "./coordinator.js";
import { FileScenarioLoader } from "./scenario-loader.js";
import { FeedbackClient } from "./feedback-client.js";
import { ClipController } from "./clip-controller.js";
import type { CreateSessionRequest, ClientMessage } from "@ar-training/shared";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config        = loadConfig();
const app           = Fastify({ logger: true });
const sessions      = new SessionManager(config.sessionManager);
const coord         = new Coordinator(config.coordinator);
const scenarios     = new FileScenarioLoader(config.scenariosDir);
const feedback      = new FeedbackClient(config.feedbackUrl, config.internalApiKey);
const controller    = new ClipController(sessions, coord, scenarios, feedback);

await app.register(websocketPlugin);
await app.register(cors, { origin: true });

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
    const { user_id, language } = req.body;

    // Admin mode: check for a valid ADMIN_API_KEY in the Authorization header.
    // Bearer token extraction — header is "Bearer <token>" or absent.
    const authHeader = req.headers["authorization"] ?? "";
    const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const isAdmin    = sessions.isAdminToken(token);

    const result = sessions.createSession(user_id, language, isAdmin);

    if (result.status === "at_capacity") {
        return reply.code(503).send({ error: "at_capacity", message: "Server is at capacity." });
    }
    if (result.status === "queued") {
        return reply.code(200).send({
            session_id:     result.context.session_id,
            state:          "queued",
            ws_path:        `/ws/${result.context.session_id}`,
            queue_position: result.queue_position,
        });
    }
    return reply.code(200).send({
        session_id: result.context.session_id,
        state:      "active",
        ws_path:    `/ws/${result.context.session_id}`,
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
        ws_path:         `/ws/${ctx.session_id}`,
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

    if (!ctx || (ctx.state !== "CONNECTING" && ctx.state !== "QUEUED")) {
        socket.send(JSON.stringify({
            type: "error", session_id,
            code: "session_not_found",
            message: "Session not found or not in a connectable state.",
        }));
        socket.close();
        return;
    }

    const sendFn = (msg: object) => socket.send(JSON.stringify(msg));

    // If the session is queued, the socket is open but we wait for a slot.
    // session_ready is sent when the session is promoted (see promoteNext in
    // SessionManager — it transitions to CONNECTING, and the timer is running;
    // the client must then send request_clip { activate: true } to go ACTIVE).
    //
    // We notify the client immediately if they're already active/connecting,
    // and wire up the queue promotion callback if queued.
    if (ctx.state === "QUEUED") {
        // Attach the send function so SessionManager can push session_ready
        // when the slot becomes available.
        sessions.setQueuedSocket(session_id, () =>
            sendFn({ type: "session_ready", session_id })
        );
    }

    socket.on("message", (raw: Buffer) => {
        let msg: ClientMessage;
        try {
            msg = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
            app.log.warn({ session_id }, "Malformed WebSocket message");
            return;
        }

        if (msg.type === "get_scenarios") {
            sendFn({
                type:      "scenarios_list",
                session_id,
                scenarios: scenarios.listScenarios(),
            });
            return;
        }

        if (msg.type === "request_clip") {
            handleRequestClip(msg.scenario_id, msg.clip_id, msg.activate, sendFn);
            return;
        }

        if (msg.type === "video_frame") {
            coord.onFrame(msg);
            return;
        }

        if (msg.type === "audio_chunk") {
            coord.onAudio(msg);
            return;
        }

        if (msg.type === "clip_ended") {
            controller.handleClipEnded(msg, sendFn).catch(err =>
                app.log.error({ err, session_id }, "clip_ended handling failed")
            );
            return;
        }

        app.log.warn({ session_id }, "Unknown WebSocket message type");
    });

    socket.on("close", () => {
        const current = sessions.getSession(session_id);
        if (current && (current.state === "ACTIVE" || current.state === "PAUSED")) {
            coord.deregisterSession(session_id);
            sessions.markDropped(session_id);
        }
        // COMPLETED, CONNECTING, QUEUED, DROPPED, EXPIRED — do nothing.
    });

    // ── request_clip handler (closure over session_id and socket context) ─────

    function handleRequestClip(
        scenarioId: string,
        clipId:     string,
        activate:   boolean,
        send:       (msg: object) => void,
    ): void {
        const current = sessions.getSession(session_id);
        if (!current) return;

        const clip = scenarios.getClip(scenarioId, clipId);
        if (!clip) {
            send({ type: "error", session_id, code: "clip_not_found",
                message: `Clip "${clipId}" not found in scenario "${scenarioId}".` });
            return;
        }

        if (activate) {
            // Validate: only permitted from CONNECTING state (first activation)
            // or on a resumed session that already has a scenario bound.
            if (current.state === "ACTIVE" || current.state === "PAUSED") {
                // Already active — clip advancement is driven by clip_ended/clip_selected,
                // not by further activate calls.
                send({ type: "error", session_id, code: "activate_not_permitted",
                    message: "Session is already active. Use clip_ended to advance clips." });
                return;
            }

            if (current.state === "CONNECTING") {
                const entryClip = scenarios.getEntryClip(scenarioId);
                const isResumed = current.scenario_id !== null;

                // Normal mode: must activate the entry clip on a fresh session.
                // Admin mode or resumed session: any clip is valid.
                if (!isResumed && !current.is_admin && clipId !== entryClip) {
                    send({ type: "error", session_id, code: "activate_not_permitted",
                        message: `Only the entry clip ("${entryClip}") may be activated to start a session.` });
                    return;
                }

                // Bind scenario (no-op if already bound from a previous session).
                sessions.setScenario(session_id, scenarioId);
                sessions.setCurrentClip(session_id, clipId);

                // Register with coordinator and transition to ACTIVE.
                coord.registerSession(session_id, clip, (m) => send(m));
                sessions.markActive(session_id);
            }
        }

        // Send clip_data regardless of activate — always a data response.
        send({
            type:             "clip_data",
            session_id,
            clip_id:          clip.clip_id,
            scenario_id:      clip.scenario_id,
            video_url:        clip.video_url,
            transcript:       clip.transcript,
            notable_features: clip.notable_features,
            branch_conditions: clip.branch_conditions,
        });
    }
});

// ─── Start ────────────────────────────────────────────────────────────────────

try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
    app.log.error(err);
    process.exit(1);
}