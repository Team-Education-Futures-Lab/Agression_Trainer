import Fastify from "fastify";
// noinspection TypeScriptCheckImport
import websocketPlugin from "@fastify/websocket";
// noinspection TypeScriptCheckImport
import cors from "@fastify/cors";
// noinspection TypeScriptCheckImport
import multipart from "@fastify/multipart";
// noinspection TypeScriptCheckImport
import fastifyJwt from "@fastify/jwt";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { Coordinator } from "./coordinator.js";
import { FileScenarioLoader, ScenarioExistsError } from "./scenario-loader.js";
import type { RawScenario } from "./scenario-loader.js";
import { FeedbackClient } from "./feedback-client.js";
import { ClipController } from "./clip-controller.js";
import { UserStore } from "./auth/user-store.js";
import { AuthService } from "./auth/auth-service.js";
import { authRoutes } from "./auth/auth-routes.js";
import argon2 from "argon2";
import type { CreateSessionRequest, ClientMessage } from "@ar-training/shared";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config        = loadConfig();
const app           = Fastify({
    logger: {
        // Redact the Authorization header from all request/response logs so
        // INTERNAL_API_KEY, ADMIN_API_KEY, and user JWTs never appear in logs.
        redact: ["req.headers.authorization"],
    },
});

// ── Auth setup ────────────────────────────────────────────────────────────────

const userStore    = new UserStore(config.dbPath);
const authService  = new AuthService(userStore, config.jwtSecret, config.jwtExpiry);

// Register @fastify/jwt on the instance for route-level use if needed in future.
// The AuthService uses fast-jwt directly for standalone token operations so that
// tokens can be issued and verified outside a request context.
await app.register(fastifyJwt, { secret: config.jwtSecret });

// ── Token blocklist maintenance ───────────────────────────────────────────────

// Prune expired tokens on startup, then every 24 hours. Runs synchronously via
// better-sqlite3's synchronous API — fast for small tables, does not block the
// event loop in any meaningful way.
userStore.pruneExpiredTokens();
setInterval(() => userStore.pruneExpiredTokens(), 24 * 60 * 60 * 1000);

// ── Bootstrap admin account ───────────────────────────────────────────────────

if (config.bootstrapAdminUsername && config.bootstrapAdminPassword) {
    const password = config.bootstrapAdminPassword;
    if (password.length < 8) {
        process.stderr.write(
            "[WARN] BOOTSTRAP_ADMIN_PASSWORD is too short (minimum 8 characters). Bootstrap skipped.\n"
        );
    } else {
        const passwordHash = await argon2.hash(password);
        userStore.bootstrapAdminIfEmpty(config.bootstrapAdminUsername, passwordHash);

        // If bootstrap ran (users table was empty), warn about changing the credentials.
        // We detect this by checking if the bootstrap user now exists.
        const bootstrappedUser = userStore.findByUsername(config.bootstrapAdminUsername);
        if (bootstrappedUser) {
            process.stderr.write(
                `[WARN] Bootstrap admin account "${config.bootstrapAdminUsername}" created. ` +
                "Change this password and unset BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD " +
                "from your .env file after logging in for the first time.\n"
            );
        }
    }
}

// ── Core services ─────────────────────────────────────────────────────────────

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

// ── Fastify plugins ───────────────────────────────────────────────────────────

await app.register(websocketPlugin);
await app.register(cors, { origin: config.corsOrigin });
await app.register(multipart, {
    limits: { fileSize: 500 * 1024 * 1024 },
});

// ── Auth routes ───────────────────────────────────────────────────────────────

await app.register(authRoutes, {
    authService,
    allowRegistration: config.allowRegistration,
});

// ─── Health ───────────────────────────────────────────────────────────────────

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

    // Admin mode: accept a valid JWT with role "admin". Falls back to student
    // session if the token is absent, invalid, or has a non-admin role.
    // No error is returned for a missing or invalid token — sessions are public
    // for students.
    const authHeader   = req.headers["authorization"];
    const tokenPayload = authService.extractAndVerify(authHeader);
    const isAdmin      = tokenPayload?.role === "admin";

    // When a verified JWT is present, use the authenticated user_id from the
    // token rather than the client-supplied value.
    const effectiveUserId = tokenPayload?.sub ?? user_id;

    // Legacy fallback: if no JWT was present but ADMIN_API_KEY is configured
    // and the header matches, honour the old mechanism. This preserves backwards
    // compatibility for any tooling that still uses the static key.
    const legacyAdmin = !tokenPayload && sessions.isAdminToken(
        authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined
    );

    const result = sessions.createSession(effectiveUserId, language, isAdmin || legacyAdmin);

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
 * Protected by admin JWT (primary) or ADMIN_API_KEY (backwards-compatible fallback).
 * The auth check happens before consuming the multipart body to prevent
 * unauthenticated requests from streaming large payloads.
 */
app.post("/scenarios", async (req, reply) => {
    const authHeader = req.headers["authorization"] ?? "";

    // Primary: valid admin JWT.
    const jwtPayload = authService.extractAndVerify(authHeader);
    const jwtIsAdmin = jwtPayload?.role === "admin";

    // Fallback: legacy ADMIN_API_KEY (for backwards-compatible tooling).
    const legacyToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const legacyIsAdmin = !jwtPayload && !!config.sessionManager.adminApiKey && legacyToken === config.sessionManager.adminApiKey;

    if (!jwtIsAdmin && !legacyIsAdmin) {
        // If ADMIN_API_KEY is unset and no JWT admin, treat as admin unavailable
        // only when neither mechanism is configured at all.
        if (!config.sessionManager.adminApiKey && !config.jwtSecret) {
            return reply.code(501).send({
                error:   "admin_unavailable",
                message: "Admin key is not configured on this server.",
            });
        }
        return reply.code(401).send({
            error:   "unauthorized",
            message: "Missing or invalid admin credentials.",
        });
    }

    // Collect multipart parts.
    let metadataJson: string | null = null;
    const videoFiles = new Map<string, Buffer>();

    try {
        const parts = req.parts();
        for await (const part of parts) {
            if (part.type === "field" && part.fieldname === "metadata") {
                metadataJson = part.value as string;
            } else if (part.type === "file") {
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

const MAX_WS_MESSAGE_BYTES        = 256 * 1024;
const MAX_FRAMES_PER_SECOND       = 60;
const MAX_AUDIO_CHUNKS_PER_SECOND = 1;

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

    let frameWindowStart  = Date.now();
    let frameWindowCount  = 0;
    let audioWindowStart  = Date.now();
    let audioWindowCount  = 0;

    let lastPong: number = Date.now();
    let heartbeatInterval: NodeJS.Timeout | null = null;

    heartbeatInterval = setInterval(() => {
        if (Date.now() - lastPong > HEARTBEAT_TIMEOUT_MS) {
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

    if (ctx.state === "QUEUED") {
        sessions.setQueuedSocket(session_id, () =>
            sendFn({ type: "session_ready", session_id })
        );
    }

    socket.on("message", (raw: Buffer) => {
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
            controller.handleClipEnded(session_id, msg, sendFn).catch(err =>
                app.log.error({ err, session_id }, "clip_ended handling failed")
            );
            return;
        }

        app.log.warn({ session_id }, "Unknown WebSocket message type");
    });

    socket.on("close", () => {
        if (heartbeatInterval !== null) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }

        const current = sessions.getSession(session_id);
        if (current && (current.state === "ACTIVE" || current.state === "PAUSED")) {
            coord.deregisterSession(session_id);
            sessions.markDropped(session_id);
        }
    });

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
            if (current.state === "ACTIVE" || current.state === "PAUSED") {
                send({ type: "error", session_id, code: "activate_not_permitted",
                    message: "Session is already active. Use clip_ended to advance clips." });
                return;
            }

            if (current.state === "CONNECTING") {
                const isResumed = current.scenario_id !== null;

                if (isResumed) {
                    if (scenarioId !== current.scenario_id) {
                        send({ type: "error", session_id, code: "activate_not_permitted",
                            message: `Session is already bound to scenario "${current.scenario_id}".` });
                        return;
                    }
                } else {
                    const entryClip = scenarios.getEntryClip(scenarioId);
                    if (!current.is_admin && clipId !== entryClip) {
                        send({ type: "error", session_id, code: "activate_not_permitted",
                            message: `Only the entry clip ("${entryClip}") may be activated to start a session.` });
                        return;
                    }
                }

                sessions.setScenario(session_id, scenarioId);
                sessions.setCoachingContext(session_id, scenarios.getCoachingContext(scenarioId));
                sessions.setLearningObjectives(session_id, scenarios.getLearningObjectives(scenarioId));
                sessions.setTargetAudience(session_id, scenarios.getTargetAudience(scenarioId));
                sessions.setCurrentClip(session_id, clipId);

                coord.registerSession(session_id, clip, (m) => send(m), current.language);
                sessions.markActive(session_id);
            }
        }

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