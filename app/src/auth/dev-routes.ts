// =============================================================================
// devRoutes — Fastify plugin for all /auth/dev/* endpoints.
//
// ALL endpoints in this file return 403 with { error: "dev_tools_disabled" }
// unless devToolsEnabled is true in the plugin options.
//
// These endpoints perform unauthenticated database operations and MUST NOT be
// exposed in production deployments. Set DEV_TOOLS_ENABLED=true in the App
// container's .env only on local development machines.
//
// Relationship to auth-routes.ts:
//   - DELETE /auth/users/:user_id (auth-routes.ts) — requires admin JWT,
//     refuses to delete the last admin account.
//   - DELETE /auth/dev/users/:user_id (this file) — no auth required, WILL
//     delete the last admin account. Development nuclear option only.
// =============================================================================

import type { FastifyPluginAsync } from "fastify";
import type { UserStore } from "./user-store.js";
import argon2 from "argon2";

// ─── Plugin ───────────────────────────────────────────────────────────────────

export const devRoutes: FastifyPluginAsync<{
    userStore:       UserStore;
    devToolsEnabled: boolean;
}> = async (fastify, opts) => {
    const { userStore, devToolsEnabled } = opts;

    // ── GET /auth/dev/users ───────────────────────────────────────────────────

    fastify.get("/auth/dev/users", async (_req, reply) => {
        if (!devToolsEnabled) {
            return reply.code(403).send({
                error:   "dev_tools_disabled",
                message: "Dev tools are not enabled on this server. Set DEV_TOOLS_ENABLED=true in the App container's .env.",
            });
        }

        const users = userStore.listUsers().map(u => ({
            user_id:    u.user_id,
            username:   u.username,
            role:       u.role,
            created_at: u.created_at,
        }));

        return reply.code(200).send({ users });
    });

    // ── POST /auth/dev/users ──────────────────────────────────────────────────
    //
    // Creates a user without requiring ALLOW_REGISTRATION or admin JWT.
    // Development seeding only.

    fastify.post<{
        Body: { username?: string; password?: string; role?: string };
    }>("/auth/dev/users", async (req, reply) => {
        if (!devToolsEnabled) {
            return reply.code(403).send({
                error:   "dev_tools_disabled",
                message: "Dev tools are not enabled on this server. Set DEV_TOOLS_ENABLED=true in the App container's .env.",
            });
        }

        const { username, password, role } = req.body ?? {};

        if (!username || typeof username !== "string" || username.trim().length === 0) {
            return reply.code(400).send({ error: "validation_error", message: "username is required." });
        }
        if (!password || typeof password !== "string" || password.length < 8) {
            return reply.code(400).send({ error: "validation_error", message: "password must be at least 8 characters." });
        }

        const resolvedRole: "student" | "admin" =
            role === "admin" ? "admin" : "student";

        let passwordHash: string;
        try {
            passwordHash = await argon2.hash(password);
        } catch (err) {
            fastify.log.error({ err }, "POST /auth/dev/users: argon2 hash failed");
            return reply.code(500).send({ error: "internal_error", message: "Failed to hash password." });
        }

        try {
            const user = userStore.createUser(username.trim(), passwordHash, resolvedRole);
            return reply.code(201).send({
                user_id:  user.user_id,
                username: user.username,
                role:     user.role,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("already exists")) {
                return reply.code(409).send({ error: "conflict", message: msg });
            }
            throw err;
        }
    });

    // ── DELETE /auth/dev/users/:user_id ───────────────────────────────────────
    //
    // Deletes a user unconditionally, including the last admin.
    // Contrast with DELETE /auth/users/:user_id (auth-routes.ts) which protects
    // the last admin and requires a valid admin JWT.

    fastify.delete<{
        Params: { user_id: string };
    }>("/auth/dev/users/:user_id", async (req, reply) => {
        if (!devToolsEnabled) {
            return reply.code(403).send({
                error:   "dev_tools_disabled",
                message: "Dev tools are not enabled on this server. Set DEV_TOOLS_ENABLED=true in the App container's .env.",
            });
        }

        const deleted = userStore.deleteUser(req.params.user_id);
        if (!deleted) {
            return reply.code(404).send({ error: "not_found", message: "User not found." });
        }

        return reply.code(200).send({ message: "User deleted." });
    });

    // ── POST /auth/dev/reset ──────────────────────────────────────────────────
    //
    // Wipes the entire users table and token blocklist. Development nuclear option.
    // The App container must be restarted (or bootstrap credentials set) to
    // re-create the first admin account after a reset.

    fastify.post("/auth/dev/reset", async (_req, reply) => {
        if (!devToolsEnabled) {
            return reply.code(403).send({
                error:   "dev_tools_disabled",
                message: "Dev tools are not enabled on this server. Set DEV_TOOLS_ENABLED=true in the App container's .env.",
            });
        }

        const tokensDeleted = userStore.deleteAllTokens();
        const usersDeleted  = userStore.deleteAllUsers();

        fastify.log.warn(
            { users_deleted: usersDeleted, tokens_deleted: tokensDeleted },
            "[DEV] POST /auth/dev/reset — database wiped"
        );

        return reply.code(200).send({
            message:        "Database reset.",
            users_deleted:  usersDeleted,
            tokens_deleted: tokensDeleted,
        });
    });

    // ── GET /auth/dev/tokens ──────────────────────────────────────────────────
    //
    // Lists non-expired token blocklist entries. Useful for verifying that
    // logout correctly populates the blocklist.

    fastify.get("/auth/dev/tokens", async (_req, reply) => {
        if (!devToolsEnabled) {
            return reply.code(403).send({
                error:   "dev_tools_disabled",
                message: "Dev tools are not enabled on this server. Set DEV_TOOLS_ENABLED=true in the App container's .env.",
            });
        }

        const tokens = userStore.listBlocklistEntries();
        return reply.code(200).send({ tokens });
    });


};