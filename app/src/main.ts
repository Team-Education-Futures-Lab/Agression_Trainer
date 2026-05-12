import Fastify from "fastify";
// noinspection TypeScriptCheckImport
import websocketPlugin from "@fastify/websocket";
// noinspection TypeScriptCheckImport
import cors from "@fastify/cors";
// noinspection TypeScriptCheckImport
import multipart from "@fastify/multipart";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { Coordinator } from "./coordinator.js";
import { FileScenarioLoader, ScenarioExistsError } from "./scenario-loader.js";
import type { RawScenario } from "./scenario-loader.js";
import { FeedbackClient } from "./feedback-client.js";
import { ClipController } from "./clip-controller.js";
import type { CreateSessionRequest, ClientMessage } from "@ar-training/shared";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config        = loadConfig();
const app           = Fastify({
    logger: {
        // Redact the Authorization header from all request/response logs so
        // INTERNAL_API_KEY and ADMIN_API_KEY never appear in log output.
        redact: ["req.headers.authorization"],
    },
});
const sessions      = new SessionManager(config.sessionManager);
const coord         = new Coordinator(config.coordinator);
const scenarios     = new FileScenarioLoader(config.scenariosDir);
const feedback      = new FeedbackClient(
    config.feedbackUrl,
    config.internalApiKey,
    config.feedbackTimeoutMs,
    config.heartbeatIntervalMs,
);
const controller    = new ClipController(sessions, coord, scenarios, feedback);

await app.register(websocketPlugin);
await app.register(cors, { origin: config.corsOrigin });
await app.register(multipart, {
    // Maximum size per individual file part (500 MB).
    limits: { fileSize: 500 * 1024 * 1024 },
});

// ─── Health ───────────────────────────────────────────────────────────────────

// Timeout for individual backend health-check fetches. Short enough that a
// single hanging service does not stall the overall health response.
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

app.get("/health", async (_req, reply) => {
    const [evalResults, transcriptionResults] = await Promise.all([
        Promise.allSettled(
            config.evaluationUrls.map(url =>
                fetch(`${url}/evaluate/health`, {
                    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
                }).then(r => r.ok).catch(() => false)
            )
        ),
        Promise.allSettled(
            config.transcriptionUrls.map(url =>
                fetch(`${url}/transcription/health`, {
                    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
                }).then(r => r.ok).catch(() => false)
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

    const feedOk = await fetch(`${config.feedbackUrl}/feedback/health`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    }).then(r => r.ok).catch(() => false);
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

// ─── Scenario routes ──────────────────────────────────────────────────────────

app.get<{ Params: { scenario_id: string } }>("/scenarios/:scenario_id/clips", async (req, reply) => {
    const { scenario_id } = req.params;
    const entryClipId = scenarios.getEntryClip(scenario_id);
    if (entryClipId === null) {
        return reply.code(404).send({ error: "scenario_not_found", message: `Scenario "${scenario_id}" not found.` });
    }
    return reply.code(200).send({
        scenario_id,
        entry_clip_id: entryClipId,
        clips: scenarios.listClips(scenario_id),
    });
});

/**
 * POST /scenarios
 *
 * Accepts a multipart/form-data upload containing:
 *   - A part named "metadata" with the scenario's JSON metadata as a string.
 *   - One binary file part per clip, named exactly as declared in the clip's
 *     "file" field in the metadata.
 *
 * Protected by ADMIN_API_KEY. Returns 501 if ADMIN_API_KEY is not configured.
 * The Authorization header is checked BEFORE consuming any multipart body to
 * prevent unauthenticated requests from streaming large payloads.
 *
 * Processing strategy: all parts are buffered (metadata as string, files as
 * Buffer), then metadata is parsed and validated, then registerScenario() is
 * called to write files and update the in-memory index atomically.
 */
app.post("/scenarios", async (req, reply) => {
    const adminKey = config.sessionManager.adminApiKey;

    // Check admin key availability before touching the request body.
    if (!adminKey) {
        return reply.code(501).send({
            error:   "admin_unavailable",
            message: "Admin key is not configured on this server. Set ADMIN_API_KEY to enable scenario upload.",
        });
    }

    // Authenticate before consuming any multipart body.
    const authHeader = req.headers["authorization"] ?? "";
    const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (token !== adminKey) {
        return reply.code(401).send({
            error:   "unauthorized",
            message: "Missing or invalid admin key.",
        });
    }

    // Collect all multipart parts.
    // - "metadata" → JSON string
    // - everything else → treated as a video file Buffer, keyed by fieldname
    let metadataJson: string | null = null;
    const videoFiles = new Map<string, Buffer>();

    try {
        const parts = req.parts();
        for await (const part of parts) {
            if (part.type === "field" && part.fieldname === "metadata") {
                metadataJson = part.value as string;
            } else if (part.type === "file") {
                // part.fieldname is the declared filename (e.g. "clip_01_intro.mp4")
                const buf = await part.toBuffer();
                videoFiles.set(part.fieldname, buf);
            }
        }
    } catch (err) {
        app.log.warn({ err }, "POST /scenarios: error reading multipart body");
        return reply.code(400).send({
            error:   "validation_error",
            message: `Failed to read multipart body: ${String(err instanceof Error ? err.message : err)}`,
        });
    }

    // Parse metadata JSON.
    if (metadataJson === null) {
        return reply.code(400).send({
            error:   "validation_error",
            message: "Missing required multipart field: metadata",
        });
    }

    let raw: RawScenario;
    try {
        raw = JSON.parse(metadataJson) as RawScenario;
    } catch {
        return reply.code(400).send({
            error:   "validation_error",
            message: "The metadata field is not valid JSON.",
        });
    }

    // Register — validate, write disk, update maps.
    try {
        await scenarios.registerScenario(raw, videoFiles);
    } catch (err) {
        if (err instanceof ScenarioExistsError) {
            return reply.code(409).send({
                error:   "scenario_exists",
                message: err.message,
            });
        }
        app.log.warn({ err }, "POST /scenarios: registerScenario failed");
        return reply.code(400).send({
            error:   "validation_error",
            message: String(err instanceof Error ? err.message : err),
        });
    }

    const clipCount = Object.keys(raw.clips).length;
    app.log.info({ scenario_id: raw.scenario_id, clips: clipCount }, "scenario registered via upload");

    return reply.code(201).send({
        scenario_id:      raw.scenario_id,
        clips_registered: clipCount,
        message:          `Scenario "${raw.scenario_id}" registered with ${clipCount} clip(s).`,
    });
});

// ─── WebSocket handler ────────────────────────────────────────────────────────

// Maximum raw WebSocket message size accepted from the client (bytes).
// A legitimate video_frame with 478 face + 42 hand landmarks is ~15 KB as JSON.
// A legitimate audio_chunk with 2 s of PCM at 16kHz is ~64 KB base64 + MFCCs.
// 256 KB gives ample headroom for both while blocking obviously oversized payloads.
const MAX_WS_MESSAGE_BYTES = 256 * 1024;

// Rate limits for incoming WebSocket messages.
// Applied as a fixed-window-per-second sliding rate limiter.
// Messages above the limit are silently dropped — no error is sent to the client.
//
// Target rates: video_frame at 30 fps, audio_chunk at one per 2 s.
// Limits are set at 2× the target to accommodate normal client-side jitter.
// A well-behaved client operating at target rates will never hit these limits.
//
// The limits apply continuously for the lifetime of the WebSocket connection
// and are not reset between clips. Clip length does not affect the limits.
const MAX_FRAMES_PER_SECOND       = 60;
const MAX_AUDIO_CHUNKS_PER_SECOND = 1;

// ─── Heartbeat constants ──────────────────────────────────────────────────────
//
// The server sends a WebSocket protocol-level ping to each client every
// HEARTBEAT_INTERVAL_MS. Browsers respond automatically with a pong frame —
// no application code is needed on the client side.
//
// If no pong is received within HEARTBEAT_TIMEOUT_MS (default ≈ 2.3 intervals),
// the connection is treated as dead: the socket is terminated and the session
// is marked dropped. The client may resume via POST /session/{id}/resume within
// the recovery window.
//
// These values are read from config (populated from HEARTBEAT_INTERVAL_MS and
// HEARTBEAT_TIMEOUT_MS environment variables) so operators can tune them without
// rebuilding the image. The module-level constants below are resolved once at
// startup from the loaded config.
const HEARTBEAT_INTERVAL_MS = config.heartbeatIntervalMs;
const HEARTBEAT_TIMEOUT_MS  = config.heartbeatTimeoutMs;

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

    // Per-connection sliding window state for rate limiting.
    // Two variables per message type: the timestamp of the current window's
    // start and the number of messages received within that window.
    // Windows reset automatically when a second has elapsed.
    let frameWindowStart  = Date.now();
    let frameWindowCount  = 0;
    let audioWindowStart  = Date.now();
    let audioWindowCount  = 0;

    // ── Heartbeat ─────────────────────────────────────────────────────────────
    //
    // lastPong tracks the most recent pong from the client.
    // On each interval tick we either detect a dead connection (no pong in
    // HEARTBEAT_TIMEOUT_MS) or send another ping to keep the connection alive.
    //
    // The interval is stored so it can be cleared on every close path —
    // both clean and unexpected. A leaked setInterval after socket close
    // would fire against a dead socket and hold the session in memory.
    let lastPong: number = Date.now();
    let heartbeatInterval: NodeJS.Timeout | null = null;

    heartbeatInterval = setInterval(() => {
        if (Date.now() - lastPong > HEARTBEAT_TIMEOUT_MS) {
            // No pong received within the timeout window — treat as a dead
            // connection. Clean up and mark the session as dropped so the
            // recovery timer starts and the slot is released if not resumed.
            app.log.warn({ session_id }, "WebSocket heartbeat timeout — marking session dropped");
            clearInterval(heartbeatInterval!);
            heartbeatInterval = null;
            socket.terminate();
            coord.deregisterSession(session_id);
            sessions.markDropped(session_id);
        } else {
            socket.ping();
        }
    }, HEARTBEAT_INTERVAL_MS);

    socket.on("pong", () => {
        lastPong = Date.now();
    });

    // If the session is queued, the socket is open but we wait for a slot.
    // session_ready is sent when the session is promoted (see promoteNext in
    // SessionManager — it transitions to CONNECTING, and the timer is running;
    // the client must then send request_clip { activate: true } to go ACTIVE).
    if (ctx.state === "QUEUED") {
        sessions.setQueuedSocket(session_id, () =>
            sendFn({ type: "session_ready", session_id })
        );
    }

    socket.on("message", (raw: Buffer) => {
        // Reject oversized messages before parsing — prevents memory exhaustion
        // from a client sending a single enormous JSON payload.
        if (raw.length > MAX_WS_MESSAGE_BYTES) {
            app.log.warn({ session_id, bytes: raw.length }, "WebSocket message exceeds size limit — dropped");
            return;
        }

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
            // Use the authoritative session_id from the URL path, not from the
            // message body, to prevent session confusion attacks.
            const now = Date.now();
            if (now - frameWindowStart >= 1000) {
                frameWindowStart = now;
                frameWindowCount = 0;
            }
            frameWindowCount++;
            if (frameWindowCount > MAX_FRAMES_PER_SECOND) {
                app.log.warn({ session_id }, `video_frame rate limit exceeded (${frameWindowCount}/${MAX_FRAMES_PER_SECOND} fps) — dropping frame`);
                return;
            }
            coord.onFrame(session_id, msg);
            return;
        }

        if (msg.type === "audio_chunk") {
            // Same reasoning as video_frame above.
            const now = Date.now();
            if (now - audioWindowStart >= 1000) {
                audioWindowStart = now;
                audioWindowCount = 0;
            }
            audioWindowCount++;
            if (audioWindowCount > MAX_AUDIO_CHUNKS_PER_SECOND) {
                app.log.warn({ session_id }, `audio_chunk rate limit exceeded (${audioWindowCount}/${MAX_AUDIO_CHUNKS_PER_SECOND} cps) — dropping chunk`);
                return;
            }
            coord.onAudio(session_id, msg);
            return;
        }

        if (msg.type === "clip_ended") {
            // Pass the authoritative session_id from the URL path — same
            // session confusion defence as video_frame and audio_chunk.
            controller.handleClipEnded(session_id, msg, sendFn).catch(err =>
                app.log.error({ err, session_id }, "clip_ended handling failed")
            );
            return;
        }

        app.log.warn({ session_id }, "Unknown WebSocket message type");
    });

    socket.on("close", () => {
        // Always clear the heartbeat interval on close — regardless of whether
        // the close was clean or unexpected — to prevent a leaked setInterval
        // from firing against a dead socket.
        if (heartbeatInterval !== null) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }

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
                send({ type: "error", session_id, code: "activate_not_permitted",
                    message: "Session is already active. Use clip_ended to advance clips." });
                return;
            }

            if (current.state === "CONNECTING") {
                const isResumed = current.scenario_id !== null;

                if (isResumed) {
                    // Resumed session: the scenario is already bound. Reject any
                    // attempt to activate a clip from a different scenario — the
                    // session history belongs to the original scenario.
                    if (scenarioId !== current.scenario_id) {
                        send({ type: "error", session_id, code: "activate_not_permitted",
                            message: `Session is already bound to scenario "${current.scenario_id}".` });
                        return;
                    }
                } else {
                    // Fresh session: must activate the entry clip unless admin.
                    const entryClip = scenarios.getEntryClip(scenarioId);
                    if (!current.is_admin && clipId !== entryClip) {
                        send({ type: "error", session_id, code: "activate_not_permitted",
                            message: `Only the entry clip ("${entryClip}") may be activated to start a session.` });
                        return;
                    }
                }

                // Bind scenario and coaching context (no-ops on a resumed session
                // because setScenario and setCoachingContext guard on scenario_id !== null).
                sessions.setScenario(session_id, scenarioId);
                sessions.setCoachingContext(session_id, scenarios.getCoachingContext(scenarioId));
                sessions.setLearningObjectives(session_id, scenarios.getLearningObjectives(scenarioId));
                sessions.setTargetAudience(session_id, scenarios.getTargetAudience(scenarioId));
                sessions.setCurrentClip(session_id, clipId);

                // Register with coordinator and transition to ACTIVE.
                coord.registerSession(session_id, clip, (m) => send(m), current.language);
                sessions.markActive(session_id);
            }
        }

        // Send clip_data regardless of activate — always a data response.
        send({
            type:              "clip_data",
            session_id,
            clip_id:           clip.clip_id,
            scenario_id:       clip.scenario_id,
            video_url:         clip.video_url,
            transcript:        clip.transcript,
            notable_features:  clip.notable_features,
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