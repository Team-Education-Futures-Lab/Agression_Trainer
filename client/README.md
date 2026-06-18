# Client

Browser-based React application. Captures webcam and microphone input, extracts landmarks and audio features client-side, and communicates with the App container over WebSocket.

---

## Pages

The client builds four separate entry points. Each is a self-contained React app at its own URL:

| URL         | File            | Purpose                                                                                                                                                        |
|-------------|-----------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `/`         | `index.html`    | Debug harness — raw session controls for integration testing. Allows connecting as admin, watching frames and transcript arrive, and forcing clip transitions. |
| `/demo`     | `demo.html`     | Student-facing session player. Two-phase flow per clip: watch the clip, then respond during a countdown. The entry point used in actual classroom sessions.    |
| `/admin`    | `admin.html`    | Scenario Builder — upload and manage scenarios. Requires an admin login (JWT obtained via `POST /auth/login`).                                                 |
| `/devtools` | `devtools.html` | Development-only database management UI. **Only compiled when `VITE_DEV_TOOLS=true` at build time.** Never deploy a build with this flag set.                  |

---

## Development

```bash
cd client
npm install                # also copies MediaPipe WASM files to public/mediapipe/
cp .env.local.example .env.local   # configure App container URLs
npm run dev                # starts Vite dev server at http://localhost:5173
```

---

## Architecture

The client separates two concerns that have no dependency on each other:

### Capture pipeline (`capture.ts`)

A continuous media stream that runs independently of any session. Starts on page load and keeps running regardless of whether a backend session exists. Has no knowledge of sessions, transport, or the server.

- Extracts face and hand landmarks from the webcam using MediaPipe.js
- Computes MFCCs from the microphone using Meyda.js
- Accumulates raw PCM audio and resamples to 16kHz for Whisper
- Uses an `AudioWorkletNode` (`pcm-processor.ts`) for non-blocking audio processing
- Exposes `frames()` and `audio()` as async iterables that broadcast to multiple consumers independently

```typescript
// Any number of consumers can subscribe independently
for await (const frame of capture.frames()) { ... }
for await (const chunk of capture.audio()) { ... }
```

### Session handler (`sessionHandler.ts`)

Manages the session lifecycle. When a session connects, subscribes to the capture streams, stamps each item with the current `session_id`, and forwards to transport. Unsubscribes on disconnect.

### Transport (`transport.ts`)

`TransportInterface` abstracts all server communication. The default implementation uses WebSocket. Can be swapped for WebRTC or another protocol without changing anything else.

---

## Client-internal types

`RawVideoFrame` and `RawAudioChunk` are defined in `src/types.ts` and are **client-internal only** — they never cross a container boundary. The session handler stamps them with a `session_id` to produce the wire-format `VideoFrame` and `AudioChunk` defined in `docs/api_contract.md`.

---

## MediaPipe WASM

MediaPipe requires WebAssembly files to be served locally. These are copied from `node_modules` into `public/mediapipe/` automatically during `npm install` via the `postinstall` script. This folder is not committed to version control.

If the files are missing, run:

```bash
node scripts/copy-mediapipe-wasm.js
```

---

## Build arguments

`VITE_APP_WS_URL` and `VITE_APP_HTTP_URL` are **Vite build-time arguments**, not runtime environment variables. Vite bakes them into the compiled output at build time. Setting them as container runtime env vars has no effect.

Pass them as Docker build arguments:

```bash
docker build \
  --build-arg VITE_APP_WS_URL=ws://your-server:3001 \
  --build-arg VITE_APP_HTTP_URL=http://your-server:3001 \
  -f client/Dockerfile .
```

In Dokploy, set them in the **Build Args** tab, not the Environment Variables tab.

For local development, set them in `.env.local` (Vite reads this file automatically at `npm run dev` time — it is not used in Docker builds):

| Variable            | Default                  | Description                         |
|---------------------|--------------------------|-------------------------------------|
| `VITE_APP_WS_URL`   | `ws://localhost:3001`    | WebSocket URL for the App container |
| `VITE_APP_HTTP_URL` | `http://localhost:3001`  | HTTP URL for the App container      |

Copy `.env.local.example` to `.env.local` and adjust for your setup.

`VITE_BASE_PATH` controls the URL prefix for all asset references in the built output (used when serving the client behind a Traefik strip-prefix). Also a build arg; defaults to `/`. See `vite.config.ts` for details.

`VITE_DEV_TOOLS` — when set to `true` at build time, the `/devtools` page is included in the build output. **Never set this in production builds.** The build log will emit a warning if this flag is active. See *Developer tools page* below.

---

## Developer tools page (`/devtools`)

The developer tools page is a database management UI intended for use during local development. It is compiled into the build output **only when `VITE_DEV_TOOLS=true` is passed as a build argument**. When the flag is absent or false, `devtools.html` is never compiled and cannot be served.

To run the stack with the devtools page enabled:

```bash
docker compose --profile devtools up --build
```

The `devtools` Docker Compose profile sets `VITE_DEV_TOOLS=true` in the client build args. Do not use this profile in production or shared server deployments.

---

## Future considerations

- **MediaPipe GPU delegate** — currently set to `CPU` for compatibility. Switch to `GPU` in `capture.ts` once tested on target hardware.
- **Web Worker for MediaPipe** — running MediaPipe inference in a Worker would free the main thread for React rendering. The `CaptureSession` interface is already isolated to make this straightforward.

---

## Production build

The production image is a static nginx container. Vite compiles the React app to static files which nginx serves with SPA routing and correct WASM MIME types.

```bash
# Always build from the repo root
docker compose up --build client
```

Do not run `docker build` directly from the `client/` directory — the build context must include `shared/`. See `docs/dev_setup.md` for details.

---