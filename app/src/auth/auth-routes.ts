// =============================================================================
// authRoutes — Fastify plugin for all /auth/* endpoints.
//
// Registered as a plugin in main.ts with { authService } passed as options.
// All endpoints defined in docs/admin_and_tooling_api.md § Auth.
// =============================================================================

import type { FastifyPluginAsync } from "fastify";
import type { AuthService } from "./auth-service.js";
import { UserExistsError } from "./auth-service.js";

// ─── Plugin ───────────────────────────────────────────────────────────────────

export const authRoutes: FastifyPluginAsync<{ authService: AuthService; allowRegistration: boolean }> =
    async (fastify, opts) => {
        const { authService, allowRegistration } = opts;

        // ── POST /auth/register ───────────────────────────────────────────────

        fastify.post<{
            Body: { username?: string; password?: string; role?: string };
        }>("/auth/register", async (req, reply) => {
            if (!allowRegistration) {
                return reply.code(403).send({
                    error:   "registration_disabled",
                    message: "Registration is disabled on this server.",
                });
            }

            const { username, password, role } = req.body ?? {};

            if (!username || typeof username !== "string" || username.trim().length === 0) {
                return reply.code(400).send({
                    error:   "validation_error",
                    message: "username is required.",
                });
            }
            if (!password || typeof password !== "string") {
                return reply.code(400).send({
                    error:   "validation_error",
                    message: "password is required.",
                });
            }

            const requesterIsAdmin = authService.isAdmin(req.headers["authorization"]);
            const requestedRole    = typeof role === "string" ? role : "student";

            try {
                const user = await authService.register(
                    username.trim(),
                    password,
                    requestedRole,
                    requesterIsAdmin,
                );
                return reply.code(201).send({
                    user_id:  user.user_id,
                    username: user.username,
                    role:     user.role,
                });
            } catch (err) {
                if (err instanceof UserExistsError) {
                    return reply.code(409).send({
                        error:   "conflict",
                        message: err.message,
                    });
                }
                throw err;
            }
        });

        // ── POST /auth/login ──────────────────────────────────────────────────

        fastify.post<{
            Body: { username?: string; password?: string };
        }>("/auth/login", async (req, reply) => {
            const { username, password } = req.body ?? {};

            if (!username || typeof username !== "string" || !password || typeof password !== "string") {
                return reply.code(400).send({
                    error:   "validation_error",
                    message: "username and password are required.",
                });
            }

            const result = await authService.login(username, password);
            if (!result) {
                return reply.code(401).send({
                    error:   "unauthorized",
                    message: "Invalid credentials.",
                });
            }

            return reply.code(200).send(result);
        });

        // ── POST /auth/logout ─────────────────────────────────────────────────

        fastify.post("/auth/logout", async (req, reply) => {
            const payload = authService.extractAndVerify(req.headers["authorization"]);
            if (!payload) {
                return reply.code(401).send({
                    error:   "unauthorized",
                    message: "Missing or invalid token.",
                });
            }

            const expiresAt = payload.exp
                ? new Date(payload.exp * 1000)
                : new Date(Date.now() + 8 * 3_600_000); // fallback: 8h from now

            authService.logout(payload.jti, expiresAt);
            return reply.code(200).send({ message: "Logged out." });
        });

        // ── GET /auth/me ──────────────────────────────────────────────────────

        fastify.get("/auth/me", async (req, reply) => {
            const payload = authService.extractAndVerify(req.headers["authorization"]);
            if (!payload) {
                return reply.code(401).send({
                    error:   "unauthorized",
                    message: "Missing or invalid token.",
                });
            }

            return reply.code(200).send({
                user_id:  payload.sub,
                username: payload.username,
                role:     payload.role,
            });
        });

        // ── GET /auth/users (admin only) ──────────────────────────────────────

        fastify.get("/auth/users", async (req, reply) => {
            if (!authService.isAdmin(req.headers["authorization"])) {
                return reply.code(403).send({
                    error:   "forbidden",
                    message: "Admin access required.",
                });
            }

            // Import UserStore type through AuthService's store accessor is not
            // available externally, so we use a small type assertion via the
            // authService.extractAndVerify path — the list is retrieved by calling
            // through to authService which wraps the store.
            // For user listing we need direct store access; it's passed in via opts.
            const users = opts.authService["store"].listUsers().map((u: {
                user_id: string; username: string; role: string; created_at: string;
            }) => ({
                user_id:    u.user_id,
                username:   u.username,
                role:       u.role,
                created_at: u.created_at,
            }));

            return reply.code(200).send({ users });
        });

        // ── DELETE /auth/users/:user_id (admin only) ──────────────────────────

        fastify.delete<{
            Params: { user_id: string };
        }>("/auth/users/:user_id", async (req, reply) => {
            if (!authService.isAdmin(req.headers["authorization"])) {
                return reply.code(403).send({
                    error:   "forbidden",
                    message: "Admin access required.",
                });
            }

            const store = opts.authService["store"] as {
                countAdmins: () => number;
                findById:    (id: string) => { role: string } | null;
                deleteUser:  (id: string) => boolean;
            };

            const target = store.findById(req.params.user_id);
            if (!target) {
                return reply.code(404).send({
                    error:   "not_found",
                    message: "User not found.",
                });
            }

            // Prevent deleting the last admin account.
            if (target.role === "admin" && store.countAdmins() <= 1) {
                return reply.code(403).send({
                    error:   "forbidden",
                    message: "Cannot delete the last admin account.",
                });
            }

            store.deleteUser(req.params.user_id);
            return reply.code(200).send({ message: "User deleted." });
        });
    };