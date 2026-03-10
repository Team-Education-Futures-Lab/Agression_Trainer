# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /repo

COPY shared/ ./shared/
COPY app/ ./app/

WORKDIR /repo/app

RUN test -f /repo/shared/types.ts && test -f /repo/shared/package.json || \
    { echo "ERROR: shared/ package not found. Build from repo root: docker build -f app/Dockerfile ."; exit 1; }

# Install with shared/ already in place so the file: symlink resolves correctly
RUN npm ci

RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /repo

COPY shared/ ./shared/
COPY app/package.json app/package-lock.json ./app/

WORKDIR /repo/app

RUN npm ci --omit=dev

COPY --from=builder /repo/app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]