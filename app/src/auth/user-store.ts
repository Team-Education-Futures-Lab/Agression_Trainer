// =============================================================================
// UserStore — SQLite-backed user and token blocklist persistence.
//
// Uses better-sqlite3's synchronous API intentionally — it is faster than the
// async wrapper pattern for Node.js and does not require Promise wrapping.
// All public methods are synchronous.
//
// Schema is created on first open; no migration runner is needed because the
// schema is additive and immutable for this iteration.
// =============================================================================

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
    user_id:       string;
    username:      string;
    password_hash: string;
    role:          "student" | "admin";
    created_at:    string;
}

/**
 * A non-expired token blocklist entry.
 * Returned by listBlocklistEntries() for dev tooling only.
 */
export interface BlocklistEntry {
    jti:        string;
    expires_at: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class UserExistsError extends Error {
    constructor(username: string) {
        super(`A user with the username "${username}" already exists.`);
        this.name = "UserExistsError";
    }
}

// ─── UserStore ────────────────────────────────────────────────────────────────

export class UserStore {
    private readonly db: DatabaseType;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        // WAL mode gives better concurrent read performance; safe for single-writer
        // (App container is single-instance).
        this.db.pragma("journal_mode = WAL");
        this._runMigrations();
    }

    // ── Schema ────────────────────────────────────────────────────────────────

    private _runMigrations(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                                                 user_id       TEXT PRIMARY KEY,
                                                 username      TEXT UNIQUE NOT NULL,
                                                 password_hash TEXT NOT NULL,
                                                 role          TEXT NOT NULL CHECK(role IN ('student', 'admin')),
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
                );

            CREATE TABLE IF NOT EXISTS token_blocklist (
                                                           jti        TEXT PRIMARY KEY,
                                                           expires_at TEXT NOT NULL
            );
        `);
    }

    // ── Users ─────────────────────────────────────────────────────────────────

    /**
     * Create a new user. Throws UserExistsError if the username is already taken.
     */
    createUser(username: string, passwordHash: string, role: "student" | "admin"): User {
        const user_id   = randomUUID();
        const stmt      = this.db.prepare(`
            INSERT INTO users (user_id, username, password_hash, role)
            VALUES (?, ?, ?, ?)
        `);

        try {
            stmt.run(user_id, username, passwordHash, role);
        } catch (err) {
            // SQLite UNIQUE constraint violation has code "SQLITE_CONSTRAINT_UNIQUE"
            // or the message includes "UNIQUE constraint failed".
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("UNIQUE constraint failed")) {
                throw new UserExistsError(username);
            }
            throw err;
        }

        return this.findById(user_id)!;
    }

    findByUsername(username: string): User | null {
        const stmt = this.db.prepare<[string], User>(`
            SELECT user_id, username, password_hash, role, created_at
            FROM users
            WHERE username = ?
        `);
        return stmt.get(username) ?? null;
    }

    findById(userId: string): User | null {
        const stmt = this.db.prepare<[string], User>(`
            SELECT user_id, username, password_hash, role, created_at
            FROM users
            WHERE user_id = ?
        `);
        return stmt.get(userId) ?? null;
    }

    listUsers(): User[] {
        const stmt = this.db.prepare<[], User>(`
            SELECT user_id, username, password_hash, role, created_at
            FROM users
            ORDER BY created_at ASC
        `);
        return stmt.all();
    }

    /** Returns false if the user was not found. */
    deleteUser(userId: string): boolean {
        const stmt   = this.db.prepare(`DELETE FROM users WHERE user_id = ?`);
        const result = stmt.run(userId);
        return result.changes > 0;
    }

    countAdmins(): number {
        const stmt = this.db.prepare<[], { count: number }>(`
            SELECT COUNT(*) AS count FROM users WHERE role = 'admin'
        `);
        return stmt.get()!.count;
    }

    countUsers(): number {
        const stmt = this.db.prepare<[], { count: number }>(`
            SELECT COUNT(*) AS count FROM users
        `);
        return stmt.get()!.count;
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────

    /**
     * Creates an admin account if — and only if — the users table is currently
     * empty. No-op if any user already exists. Called on startup when
     * BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD are configured.
     */
    bootstrapAdminIfEmpty(username: string, passwordHash: string): void {
        if (this.countUsers() > 0) return;
        this.createUser(username, passwordHash, "admin");
    }

    // ── Token blocklist ───────────────────────────────────────────────────────

    addTokenToBlocklist(jti: string, expiresAt: Date): void {
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO token_blocklist (jti, expires_at)
            VALUES (?, ?)
        `);
        stmt.run(jti, expiresAt.toISOString());
    }

    isTokenBlocked(jti: string): boolean {
        const stmt = this.db.prepare<[string], { jti: string }>(`
            SELECT jti FROM token_blocklist WHERE jti = ?
        `);
        return stmt.get(jti) !== undefined;
    }

    /**
     * Removes expired entries from the token blocklist. Called on startup and
     * periodically (every 24 hours). Runs synchronously — fast for small tables.
     */
    pruneExpiredTokens(): void {
        const stmt = this.db.prepare(`
            DELETE FROM token_blocklist WHERE expires_at < datetime('now')
        `);
        stmt.run();
    }

    // ── Dev-tools-only methods ────────────────────────────────────────────────
    //
    // These methods perform destructive bulk operations on the database and
    // MUST ONLY be called from dev-routes.ts. They must never be called from
    // any production code path.

    /**
     * Deletes all rows from the users table.
     * Returns the number of rows deleted.
     *
     * @devOnly — MUST ONLY be called from dev-routes.ts.
     */
    deleteAllUsers(): number {
        const result = this.db.prepare(`DELETE FROM users`).run();
        return result.changes;
    }

    /**
     * Deletes all rows from the token_blocklist table.
     * Returns the number of rows deleted.
     *
     * @devOnly — MUST ONLY be called from dev-routes.ts.
     */
    deleteAllTokens(): number {
        const result = this.db.prepare(`DELETE FROM token_blocklist`).run();
        return result.changes;
    }

    /**
     * Returns all non-expired token blocklist entries, ordered by expiry time.
     * Used by GET /auth/dev/tokens for development inspection only.
     *
     * @devOnly — MUST ONLY be called from dev-routes.ts.
     */
    listBlocklistEntries(): BlocklistEntry[] {
        const stmt = this.db.prepare<[], BlocklistEntry>(`
            SELECT jti, expires_at
            FROM token_blocklist
            WHERE expires_at > datetime('now')
            ORDER BY expires_at ASC
        `);
        return stmt.all();
    }
}