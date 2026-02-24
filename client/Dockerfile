# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy shared package — available because build context is the repo root.
# See docs/CONTRIBUTING.md for why builds must be run from the repo root.
COPY shared/ ./shared/

WORKDIR /app/client

# Verify shared package is present — fails with a clear message if the build
# context is not the repo root (e.g. docker build run from client/ directly)
RUN test -f /app/shared/types.ts && test -f /app/shared/package.json || \
    { echo "ERROR: shared/ package not found. Build from repo root: docker build -f client/Dockerfile ."; exit 1; }

# Copy scripts first — needed by postinstall which runs during npm ci
COPY client/scripts/ ./scripts/

# Install dependencies.
# postinstall copies MediaPipe WASM files into public/mediapipe/ automatically.
COPY client/package.json client/package-lock.json ./
RUN npm ci

# Copy source and build
COPY client/ .
RUN npm run build

# ── Stage 2: Serve ────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

COPY --from=builder /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]