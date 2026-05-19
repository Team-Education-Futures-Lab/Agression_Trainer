# Authentication & User Management

Documents the App container's user authentication system: how accounts are created, how JWTs are issued and verified, how admin sessions work, and how the system is operated in a classroom deployment.

> **Internal container auth** — the `INTERNAL_API_KEY` mechanism used for App→Evaluation, App→Transcription, and App→Feedback requests is unchanged and is documented in `admin_and_tooling_api.md`. This document covers only human-user authentication.

---

## Overview

Authentication is built on three components inside the App container:

- **`UserStore`** — SQLite-backed persistence (`app/src/auth/user-store.ts`). Stores user accounts and a JWT blocklist. Database file lives at `$DATA_DIR/auth.db`, bind-mounted from `./data/` on the host.
- **`AuthService`** — business logic (`app/src/auth/auth-service.ts`). Wraps `UserStore` with argon2 password hashing and fast-jwt token signing/verification.
- **`authRoutes`** — Fastify plugin (`app/src/auth/auth-routes.ts`). Registers all `/auth/*` HTTP endpoints.

### Roles

| Role      | Can do                                                                                                                                                                                       |
|-----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `student` | Create sessions, play scenarios, receive feedback. Cannot access admin endpoints, scenario upload, or debug data.                                                                            |
| `admin`   | Everything a student can do, plus: create admin sessions (unrestricted clip activation, `debug_eval` messages), upload scenarios via `POST /scenarios`, access `GET /evaluate/debug/config`. |

---

## HTTP Endpoints

### `POST /auth/register`

Creates a new user account. Only functional when `ALLOW_REGISTRATION=true` in the App container's environment (default `false`). In production, admins create accounts via this endpoint using an admin JWT.

**Request**
```json
{ "username": "string", "password": "string", "role": "student | admin" }
```

The `role` field is only honoured when the request carries a valid admin JWT in `Authorization: Bearer`. Without an admin JWT, role is always forced to `"student"` regardless of what is sent.

Password minimum length: 8 characters.

**Response 201**
```json
{ "user_id": "string", "username": "string", "role": "string" }
```

**Response 403** — `{ "error": "registration_disabled" }` when `ALLOW_REGISTRATION=false`.

**Response 409** — username already taken.

**Response 400** — missing fields or password too short.

---

### `POST /auth/login`

Validates credentials and returns a signed JWT.

**Request**
```json
{ "username": "string", "password": "string" }
```

**Response 200**
```json
{
    "token":      "string  // JWT, signed HS256, expiry per JWT_EXPIRY",
    "user_id":    "string",
    "username":   "string",
    "role":       "student | admin",
    "expires_at": "string  // ISO 8601"
}
```

**Response 401** — invalid credentials. The response does not distinguish "username not found" from "wrong password" — both return the same 401.

---

### `POST /auth/logout`

Adds the token's JTI to the blocklist so it cannot be reused before its natural expiry. Requires a valid JWT in `Authorization: Bearer`.

**Response 200**
```json
{ "message": "Logged out." }
```

**Response 401** — missing or invalid token.

---

### `GET /auth/me`

Returns the current user's identity. Requires a valid JWT.

**Response 200**
```json
{ "user_id": "string", "username": "string", "role": "string" }
```

**Response 401** — missing or invalid token.

---

### `GET /auth/users`

Lists all registered users. Admin JWT required.

**Response 200**
```json
{
    "users": [
        { "user_id": "string", "username": "string", "role": "string", "created_at": "string" }
    ]
}
```

**Response 403** — non-admin token.

---

### `DELETE /auth/users/:user_id`

Deletes a user account. Admin JWT required. Cannot delete the last admin account.

**Response 200** — `{ "message": "User deleted." }`

**Response 403** — non-admin token, or attempt to delete the last admin.

**Response 404** — user not found.

---

## Changes to Existing Endpoints

### `POST /session/create`

Previously gated on `ADMIN_API_KEY` for admin sessions. Now uses JWT-based auth as the primary mechanism, with `ADMIN_API_KEY` retained as a backwards-compatible fallback.

**Behaviour:**
- If `Authorization: Bearer <token>` is present and the token is a valid JWT with `role: "admin"`, an admin session is created.
- If the header is absent or the token is invalid, a student session is created. No error is returned — sessions are public for students.
- If `ADMIN_API_KEY` is configured and the header matches it exactly (legacy path), an admin session is created. This path exists only for tooling that predates JWT auth.

When a valid JWT is present, `user_id` is taken from the token's `sub` claim rather than the request body.

### `POST /scenarios`

Previously gated on `ADMIN_API_KEY` only. Now accepts either a valid admin JWT (primary) or `ADMIN_API_KEY` (backwards-compatible fallback for existing tooling). Returns `401` if neither is present or valid.

---

## JWT Details

| Property  | Value                                                                                                  |
|-----------|--------------------------------------------------------------------------------------------------------|
| Algorithm | HS256                                                                                                  |
| Secret    | `JWT_SECRET` env var (required)                                                                        |
| Expiry    | `JWT_EXPIRY` env var (default `8h`)                                                                    |
| Payload   | `{ sub: user_id, username, role, jti: uuid }`                                                          |
| Blocklist | JTIs stored in SQLite `token_blocklist` table; pruned of expired entries on startup and every 24 hours |

JWTs are stateless on the verification path: the `AuthService` verifies the signature, checks expiry, and checks the JTI against the blocklist in one pass. No database lookup is needed for valid, non-logged-out tokens.

---

## Environment Variables

The following variables are added to the App container. See `app/.env.example` for the full annotated list.

| Variable                   | Required | Default | Description                                                     |
|----------------------------|----------|---------|-----------------------------------------------------------------|
| `JWT_SECRET`               | Yes      | —       | Signing secret. Generate with `openssl rand -hex 32`.           |
| `JWT_EXPIRY`               | No       | `8h`    | Token expiry. Supports `s`, `m`, `h`, `d` suffixes.             |
| `DATA_DIR`                 | Yes      | —       | Directory for `auth.db`. Must be a persisted bind mount.        |
| `ALLOW_REGISTRATION`       | No       | `false` | Enables `POST /auth/register` for unauthenticated requests.     |
| `BOOTSTRAP_ADMIN_USERNAME` | No       | —       | Creates the first admin on startup if the users table is empty. |
| `BOOTSTRAP_ADMIN_PASSWORD` | No       | —       | Password for the bootstrap admin (min 8 characters).            |

`ADMIN_API_KEY` is retained for the legacy fallback path. It is no longer required and can be left unset in new deployments.

---

## First-Time Setup

When the database is empty (first deployment), create the initial admin account in one of two ways:

**Option A — bootstrap env vars (recommended for automated deployments)**

Set `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` in `app/.env` before the first `docker compose up`. The App container creates the account on startup and logs a warning reminding you to change the password. Once the account exists, these vars are ignored on subsequent starts — unset them from `.env` after confirming the account works.

**Option B — enable registration temporarily**

Set `ALLOW_REGISTRATION=true` in `app/.env`, start the stack, and call `POST /auth/register` with `{ "username": "...", "password": "...", "role": "admin" }`. Because no JWT is present in the request, the `role` field will be ignored and a student account is created — this only works for the first admin if you also set `ALLOW_REGISTRATION=true` *and* accept that the first account must be student-promoted manually via SQLite, or use the bootstrap path instead.

The bootstrap env var approach is cleaner. Use Option A.

---

## Data Persistence

The SQLite database lives at `$DATA_DIR/auth.db` inside the App container, backed by the bind mount `./data:/app/data` in `docker-compose.yml`. Docker Compose creates the `./data` directory automatically if it does not exist.

Deleting or moving `./data/auth.db` is equivalent to resetting all user accounts. The scenarios directory is unaffected.

The HuggingFace model cache (`./models/hf_cache`) and Ollama models (`./models`) are separate bind mounts and are not affected by auth database changes.

---

## Client Integration

### Scenario Builder (`/admin`)

The Scenario Builder's gate screen now shows a login form (username + password) instead of a raw key input. On successful login via `POST /auth/login`, the JWT is stored in component state only — not `localStorage` — so a page reload requires re-login. The server URL is persisted in `sessionStorage` for the duration of the browser tab.

If the logged-in account's role is not `admin`, the form displays an access-denied message rather than the builder.

On scenario upload, `POST /scenarios` receives `Authorization: Bearer <jwt>`.

### Debug Harness (`/`)

The `SessionPanel` component's raw "Admin key" text input has been replaced with a collapsible admin login subform (username + password → `POST /auth/login`). Once authenticated, the JWT is held in component state and passed to `connect()` as `authToken`. The ADMIN badge in the status bar reflects whether the current session was created with an admin token.

The JWT is not cleared on session disconnect, so you can reconnect as admin immediately without re-logging in. Use the "Log out" button in the login subform to explicitly clear the token.

### `SessionHandler` / `useSession`

The `connect()` method's third parameter has been renamed from `adminKey` to `authToken` to reflect that it now expects a JWT rather than a static key. The wire protocol is unchanged — the value is sent as `Authorization: Bearer <authToken>` on `POST /session/create`. Callers that passed a static ADMIN_API_KEY string will continue to work via the legacy fallback path on the server, but should migrate to JWT-based auth.

---

## Security Notes

**Password hashing:** argon2id with default parameters (memory-hard, time cost 3, parallelism 4). Each password is individually salted.

**Timing safety:** The login endpoint runs a dummy argon2 verification when the username is not found so that the response time is indistinguishable from a real failed comparison, preventing username enumeration via timing.

**Token blocklist:** Logout invalidates tokens immediately by JTI. Expired blocklist entries are pruned on startup and every 24 hours to keep the table small.

**Classroom deployment note:** `JWT_SECRET` should be a fresh secret per deployment (generated with `openssl rand -hex 32`). The same secret is used for all tokens on that instance. If the secret is rotated, all existing tokens are immediately invalidated and all users must log in again.

**What this system does not provide:** multi-tenancy, SSO, OAuth, per-token scopes, audit logging, or rate limiting on login attempts. These are appropriate omissions for a single-institution classroom tool. If the deployment grows to internet-facing use, rate limiting on `POST /auth/login` should be added.

---

## Token Blocklist Maintenance

The blocklist prune runs synchronously via `better-sqlite3`'s synchronous API. For a typical classroom deployment (a few dozen users, short JWT lifetimes) the blocklist table will contain at most a few hundred rows at any time, making the prune query effectively instantaneous. No worker thread or background job is needed.

The prune schedule:
- Once on App container startup.
- Every 24 hours via `setInterval`.

If the App container restarts frequently (e.g. during development), pruning on startup is sufficient and the interval firing is a belt-and-suspenders measure.