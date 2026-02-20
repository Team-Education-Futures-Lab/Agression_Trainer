# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy shared package first — needed before client can install
COPY ../shared ./shared

WORKDIR /app/client

# Install dependencies (postinstall copies MediaPipe WASM to public/)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# ── Stage 2: Serve ────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

# Copy built assets to nginx
COPY --from=builder /app/client/dist /usr/share/nginx/html

# Nginx config — single page app routing + correct MIME type for WASM
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
