# Client

Browser-based React application. Captures webcam and microphone input, extracts landmarks and audio features client-side, and communicates with the App container over WebSocket.

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

`RawVideoFrame` and `RawAudioChunk` are defined in `src/types.ts` and are **client-internal only** — they never cross a container boundary. The session handler stamps them with a `session_id` to produce the wire-format `VideoFrame` and `AudioChunk` defined in `docs/API_CONTRACT.md`.

---

## MediaPipe WASM

MediaPipe requires WebAssembly files to be served locally. These are copied from `node_modules` into `public/mediapipe/` automatically during `npm install` via the `postinstall` script. This folder is not committed to version control.

If the files are missing, run:

```bash
node scripts/copy-mediapipe-wasm.js
```

---

## Environment variables

| Variable            | Default                 | Description                         |
|---------------------|-------------------------|-------------------------------------|
| `VITE_APP_WS_URL`   | `ws://localhost:8000`   | WebSocket URL for the App container |
| `VITE_APP_HTTP_URL` | `http://localhost:8000` | HTTP URL for the App container      |

Copy `.env.local.example` to `.env.local` and adjust for your setup.

---

## Future considerations

- **MediaPipe GPU delegate** — currently set to `CPU` for compatibility. Switch to `GPU` in `capture.ts` once tested on target hardware.
- **AudioWorklet migration** — `ScriptProcessorNode` is deprecated. Migrate to `AudioWorkletNode` before production.
- **Web Worker for MediaPipe** — running MediaPipe inference in a Worker would free the main thread for React rendering. The `CaptureSession` interface is already isolated to make this straightforward.

---

## Production build

The production image is a static nginx container. Vite compiles the React app to static files which nginx serves with SPA routing and correct WASM MIME types.

```bash
# Always build from the repo root
docker compose up --build client
```

Do not run `docker build` directly from the `client/` directory — the build context must include `shared/`. See `docs/CONTRIBUTING.md` for details.