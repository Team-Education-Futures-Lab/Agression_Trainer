# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY shared/ ./shared/
COPY client/ ./client/

WORKDIR /app/client

RUN test -f /app/shared/types.ts && test -f /app/shared/package.json || \
    { echo "ERROR: shared/ package not found. Build from repo root: docker build -f client/Dockerfile ."; exit 1; }

RUN npm ci

RUN npm run build

# ── Stage 2: Serve ────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

COPY --from=builder /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
