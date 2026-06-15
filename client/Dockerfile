# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# ── Dokploy build configuration ───────────────────────────────────────────────
# VITE_* variables are baked into the compiled output at build time.
# They must be set in Dokploy's "Build Args" tab — NOT "Environment Variables".
# Setting them in "Environment Variables" has no effect because the Nginx
# container serving the built files has no way to inject them at runtime.
#
# Required build args for a Dokploy deployment:
#
#   VITE_BASE_PATH       The URL prefix Traefik routes to this container.
#                        Must begin and end with /. E.g.: /client/
#
#   VITE_APP_HTTP_URL    The public HTTP URL of the App container.
#                        E.g.: https://myserver.example.com/app
#
#   VITE_APP_WS_URL      The public WebSocket URL of the App container.
#                        E.g.: wss://myserver.example.com/app
#
# Optional build args:
#
#   VITE_DEV_TOOLS       Set to "true" to include the developer tools page.
#                        NEVER set this in a production deployment.
# ──────────────────────────────────────────────────────────────────────────────

WORKDIR /app

COPY shared/ ./shared/
COPY client/ ./client/

WORKDIR /app/client

RUN test -f /app/shared/types.ts && test -f /app/shared/package.json || \
    { echo "ERROR: shared/ package not found. Build from repo root: docker build -f client/Dockerfile ."; exit 1; }

RUN npm ci

ARG VITE_BASE_PATH=/
ARG VITE_APP_HTTP_URL=http://localhost:3001
ARG VITE_APP_WS_URL=ws://localhost:3001
ARG VITE_DEV_TOOLS=false

RUN VITE_BASE_PATH=${VITE_BASE_PATH} \
    VITE_APP_HTTP_URL=${VITE_APP_HTTP_URL} \
    VITE_APP_WS_URL=${VITE_APP_WS_URL} \
    VITE_DEV_TOOLS=${VITE_DEV_TOOLS} \
    npm run build

# ── Stage 2: Serve ────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

COPY --from=builder /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]