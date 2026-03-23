# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /repo

COPY shared/ ./shared/
COPY feedback/ ./feedback/

WORKDIR /repo/feedback

RUN test -f /repo/shared/types.ts && test -f /repo/shared/package.json || \
    { echo "ERROR: shared/ package not found. Build from repo root: docker build -f feedback/Dockerfile ."; exit 1; }

RUN npm ci

RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /repo

COPY shared/ ./shared/
COPY feedback/package.json feedback/package-lock.json ./feedback/

WORKDIR /repo/feedback

RUN npm ci --omit=dev

COPY --from=builder /repo/feedback/dist ./dist

EXPOSE 8002

CMD ["node", "dist/main.js"]