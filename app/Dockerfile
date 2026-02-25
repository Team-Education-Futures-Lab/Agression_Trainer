# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /repo

# Copy shared package first — available because build context is the repo root.
# See docs/CONTRIBUTING.md for why builds must be run from the repo root.
COPY shared/ ./shared/

WORKDIR /repo/app

# Verify shared package is present — fails with a clear message if the build
# context is not the repo root (e.g. docker build run from app/ directly)
RUN test -f /repo/shared/types.ts && test -f /repo/shared/package.json || \
    { echo "ERROR: shared/ package not found. Build from repo root: docker build -f app/Dockerfile ."; exit 1; }

# Install dependencies
COPY app/package.json app/package-lock.json ./
RUN npm ci

# Copy source and build
COPY app/ .
RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /repo

COPY shared/ ./shared/

WORKDIR /repo/app

COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /repo/app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]
