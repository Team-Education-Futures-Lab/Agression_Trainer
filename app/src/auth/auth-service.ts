// =============================================================================
// AuthService — Auth business logic.
//
// Wraps UserStore with password hashing (argon2) and JWT signing/verification.
//
// Uses fast-jwt directly (the signing engine underlying @fastify/jwt) so that
// tokens can be issued and verified outside a Fastify request context (e.g.
// at login, in middleware). @fastify/jwt is still registered on the Fastify
// instance for any future route-level use.
// =============================================================================

import argon2 from "argon2";
import { createSigner, createVerifier } from "fast-jwt";
import { randomUUID } from "node:crypto";
import type { UserStore, User } from "./user-store.js";
import { UserExistsError } from "./user-store.js";

// Re-export for convenience in routes and main.ts
export type { User };
export { UserExistsError };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenPayload {
    /** user_id */
    sub:      string;
    username: string;
    role:     "student" | "admin";
    /** Unique JWT ID — used for blocklist lookup. */
    jti:      string;
    iat?:     number;
    exp?:     number;
}

export interface LoginResult {
    token:      string;
    user_id:    string;
    username:   string;
    role:       "student" | "admin";
    /** ISO 8601 expiry timestamp. */
    expires_at: string;
}

// ─── AuthService ──────────────────────────────────────────────────────────────

export class AuthService {
    private readonly store:      UserStore;
    private readonly jwtExpiry:  string;
    // fast-jwt signer / verifier — synchronous, no CJS shimming required.
    private readonly signer:     (payload: Record<string, unknown>) => string;
    private readonly verifier:   (token: string) => TokenPayload;

    constructor(store: UserStore, jwtSecret: string, jwtExpiry: string) {
        this.store     = store;
        this.jwtExpiry = jwtExpiry;

        this.signer = createSigner({
            key:       jwtSecret,
            algorithm: "HS256",
            expiresIn: this._expiryToMs(jwtExpiry),
        }) as (payload: Record<string, unknown>) => string;

        this.verifier = createVerifier({
            key:       jwtSecret,
            algorithms: ["HS256"],
        }) as (token: string) => TokenPayload;
    }

    // ── Registration ──────────────────────────────────────────────────────────

    /**
     * Register a new user. Role is always forced to "student" unless the caller
     * is an authenticated admin — the `requestedRole` value from an
     * unauthenticated or non-admin client is silently discarded.
     *
     * Throws UserExistsError if the username is already taken.
     */
    async register(
        username:         string,
        password:         string,
        requestedRole:    string,
        requesterIsAdmin: boolean,
    ): Promise<User> {
        const role: "student" | "admin" =
            requesterIsAdmin && requestedRole === "admin" ? "admin" : "student";
        const passwordHash = await argon2.hash(password);
        return this.store.createUser(username, passwordHash, role);
    }

    // ── Login ─────────────────────────────────────────────────────────────────

    /**
     * Validate credentials and return a signed JWT on success.
     * Returns null when credentials are invalid. Callers must return 401
     * and must not distinguish "username not found" from "wrong password".
     */
    async login(username: string, password: string): Promise<LoginResult | null> {
        const user = this.store.findByUsername(username);

        if (!user) {
            // Perform a dummy argon2 verification so the response time is
            // indistinguishable from a real failed comparison, preventing
            // timing-based username enumeration.
            await argon2.verify(
                // Well-formed argon2id hash of a dummy string, guaranteed to fail
                // for any real password input.
                "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$" +
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                password,
            ).catch(() => false);
            return null;
        }

        const valid = await argon2.verify(user.password_hash, password).catch(() => false);
        if (!valid) return null;

        return this._issueToken(user);
    }

    // ── Token verification ────────────────────────────────────────────────────

    /**
     * Verify a JWT string. Returns the decoded payload if the signature is
     * valid, the token has not expired, and the JTI is not on the blocklist.
     * Returns null for any failure (expired, malformed, blocklisted).
     */
    verifyToken(token: string): TokenPayload | null {
        let payload: TokenPayload;
        try {
            payload = this.verifier(token);
        } catch {
            return null;
        }

        if (!payload.jti) return null;
        if (this.store.isTokenBlocked(payload.jti)) return null;

        return payload;
    }

    // ── Logout ────────────────────────────────────────────────────────────────

    /**
     * Add the token's JTI to the blocklist so it cannot be reused until expiry.
     */
    logout(jti: string, expiresAt: Date): void {
        this.store.addTokenToBlocklist(jti, expiresAt);
    }

    // ── Convenience helpers ───────────────────────────────────────────────────

    /**
     * Extract and verify a bearer token from an Authorization header string.
     * Returns null for a missing, malformed, or invalid token.
     */
    extractAndVerify(authHeader: string | undefined): TokenPayload | null {
        if (!authHeader) return null;
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (!token) return null;
        return this.verifyToken(token);
    }

    /**
     * Returns true if the Authorization header carries a valid JWT with the
     * admin role. Used as a one-liner gate in route handlers.
     */
    isAdmin(authHeader: string | undefined): boolean {
        return this.extractAndVerify(authHeader)?.role === "admin";
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private _issueToken(user: User): LoginResult {
        const jti = randomUUID();

        const token = this.signer({
            sub:      user.user_id,
            username: user.username,
            role:     user.role,
            jti,
        });

        // Decode the signed token to read the actual exp timestamp that fast-jwt
        // embedded (accounts for clock drift, expiresIn rounding, etc.).
        const decoded  = this.verifyToken(token);
        const expiresAt = decoded?.exp
            ? new Date(decoded.exp * 1000).toISOString()
            : new Date(Date.now() + this._expiryToMs(this.jwtExpiry)).toISOString();

        return {
            token,
            user_id:    user.user_id,
            username:   user.username,
            role:       user.role,
            expires_at: expiresAt,
        };
    }

    /**
     * Convert a human-readable expiry string (e.g. "8h", "30m", "1d") to
     * milliseconds for fast-jwt's `expiresIn` option.
     * Defaults to 8 hours for unrecognised formats.
     */
    private _expiryToMs(expiry: string): number {
        const match = /^(\d+)([smhd])$/.exec(expiry);
        if (!match) return 8 * 3_600_000;
        const n = parseInt(match[1]!, 10);
        switch (match[2]) {
            case "s": return n * 1_000;
            case "m": return n * 60_000;
            case "h": return n * 3_600_000;
            case "d": return n * 86_400_000;
            default:  return 8 * 3_600_000;
        }
    }
}