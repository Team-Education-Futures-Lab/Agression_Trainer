# Optional: Deploying with Dokploy

This document explains what [Dokploy](https://dokploy.com) adds when running this
platform, and where it does *not* add much. Dokploy is **optional** — the system runs
fine with plain `docker compose` using [`docker-compose.yml`](../docker-compose.yml).
A Dokploy-specific variant, [`dokploy-compose.yml`](../dokploy-compose.yml), is
included in the repository and is the intended production path.

**Short version:** there is real value, but it is in *operational convenience*, not in
capability.

---

## What Dokploy is

A self-hosted PaaS (a Heroku/Vercel-style layer) built on top of Docker and Traefik,
driven by a web UI. It manages Docker Compose deployments, domains, TLS, environment
variables, git-based deploys, logs, health, rollbacks, and resource monitoring.

The repository is already prepared for it: `dokploy-compose.yml` uses `expose:` instead
of `ports:` (domains are bound in the Dokploy UI), bakes in non-secret defaults, and
expects roughly five secrets to be set in Dokploy's **Environment Variables** tab, with
the `VITE_*` values set in the **Build Args** tab.

---

## Where Dokploy genuinely helps

| Area | What Dokploy solves | Why it matters here |
|------|---------------------|---------------------|
| **TLS + domains** | Traefik with automatic Let's Encrypt certificates; bind a domain per service in the UI | [`architecture.md`](architecture.md) explicitly states that multi-server TLS must be handled "at the infrastructure layer" (Caddy or a reverse proxy). The client needs public `VITE_APP_HTTP_URL` / `wss://` URLs; Traefik handles the WebSocket upgrade and HTTPS with no certificate management inside the containers. |
| **Git-based deploy** | Push to the branch → rebuild + redeploy, with rollback | Scenario content is managed through Git (`scenarios/**/*.mp4` via Git LFS). "Add a new scenario" becomes commit + push instead of SSH + `docker compose up --build`. |
| **Env / secrets management** | UI for `INTERNAL_API_KEY`, `JWT_SECRET`, `BOOTSTRAP_ADMIN_PASSWORD`, and the `VITE_*` build args | `dokploy-compose.yml` is already written for this: only a handful of secrets in the UI, everything else baked-in defaults. |
| **Operability without the CLI** | Logs, restart, redeploy, health, resource graphs in a browser | Matches the audience described in the docs ("IT departments never need to touch application code"). Day-to-day operation needs no CLI knowledge. |
| **Auto-restart / healthchecks** | Restart on crash; a deploy only goes live once the healthcheck passes | The Compose healthchecks already exist; Dokploy makes them visible and actionable. |

---

## Where the value is thin

- **A single classroom server you administer yourself:** `docker compose up` already
  works. Dokploy is then an extra component to maintain (its own server, Traefik, its
  own database). The gain is HTTPS plus a UI.
- **This app's scaling model is custom:** the App container pins each session by hash
  and reads comma-separated `EVALUATION_URL` / `TRANSCRIPTION_URL` lists. That is not
  Dokploy's load balancing, and Dokploy's Swarm replicas do not map cleanly onto it.
  `--scale` is Compose-native anyway.
- **GPU scheduling across multiple nodes** is not something Dokploy does well — and
  `transcription`, `evaluation`, and `ollama` all want CUDA.
- **Long-lived streams:** the feedback SSE stream runs up to 150 s
  (`FEEDBACK_TIMEOUT_MS`), plus persistent WebSockets. Traefik proxy timeouts must be
  raised accordingly; default proxy settings can cut those streams. Solvable, but a
  gotcha to be aware of.

---

## Recommendation

| Situation | Guidance |
|-----------|----------|
| Single server, technical administrator, one box | Dokploy is optional. The benefit is automatic HTTPS plus a UI; if you are comfortable with the CLI, it is marginal. |
| Internet-facing, multiple teachers/schools, or an operator without CLI knowledge who must deploy and push scenarios | Dokploy provides clear value — chiefly automatic TLS, git deploys with rollback, and secrets management. The presence of `dokploy-compose.yml` in the repo indicates this is the intended production path. |

---

## If you do use Dokploy

1. Create an application from this repository, using `dokploy-compose.yml` as the
   compose file.
2. Set the required secrets in the **Environment Variables** tab:
   `INTERNAL_API_KEY`, `JWT_SECRET`, `BOOTSTRAP_ADMIN_PASSWORD`, `VITE_APP_HTTP_URL`,
   `VITE_BASE_PATH` (see the header of `dokploy-compose.yml` for the full list and
   optional overrides).
3. Set `VITE_APP_WS_URL` and `VITE_APP_HTTP_URL` in the **Build Args** tab — they are
   baked into the client at build time and have no effect as runtime env vars (see
   [`dev_setup.md`](dev_setup.md) and [`../client/README.md`](../client/README.md)).
4. Bind domains to the `client` and `app` services in the Dokploy UI (both use
   `expose:` only).
5. Raise the Traefik proxy read/write timeouts to comfortably exceed
   `FEEDBACK_TIMEOUT_MS` so feedback streams and WebSockets are not cut.
6. Remove `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` after the first
   deploy once the admin account is confirmed working (see [`auth.md`](auth.md)).
