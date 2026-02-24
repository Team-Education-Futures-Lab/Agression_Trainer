# Client

Browser-based React application. Captures webcam and microphone input, extracts landmarks and audio features client-side, and communicates with the App container over WebSocket.

---

## Development

```bash
cd client
npm install       # also copies MediaPipe WASM files to public/mediapipe/ via postinstall
npm run dev       # starts Vite dev server at http://localhost:5173
```

---

## Architecture

The client separates two concerns that have no dependency on each other:

### Capture pipeline (`capture.ts`)

A continuous media stream that runs independently of any session. It starts on page load and keeps running regardless of whether a backend session exists. It has no knowledge of sessions, transport, or the server.

- Extracts face and hand landmarks from the webcam using MediaPipe.js
- Computes MFCCs from the microphone using Meyda.js
- Accumulates raw PCM audio and resamples to 16kHz for Whisper
- Emits `RawVideoFrame` and `RawAudioChunk` events continuously

Consumers subscribe to these events and unsubscribe when done:

```typescript
const unsub = capture.on("frame", (frame: RawVideoFrame) => { ... });
// later:
unsub();
```

### Session handler (`App.tsx`)

Manages the session lifecycle. When a session connects, it subscribes to the capture stream, stamps each item with the current `session_id`, and forwards it to transport. On disconnect it unsubscribes.

This separation means the camera preview and debug overlay are always functional, even when no backend is available.

---

## Key files

| File                   | Responsibility                                        |
|------------------------|-------------------------------------------------------|
| `src/capture.ts`       | Continuous MediaPipe + audio stream, session-agnostic |
| `src/transport.ts`     | `TransportInterface` + WebSocket implementation       |
| `src/App.tsx`          | Session lifecycle, wires capture → transport          |
| `src/DebugOverlay.tsx` | Landmark visualisation + MFCC heatmap (dev only)      |

---

## Client-internal types

`RawVideoFrame` and `RawAudioChunk` are defined in `@ar-training/shared` but are **client-internal only** — they are never sent over the wire. The session handler stamps them with a `session_id` to produce the wire-format `VideoFrame` and `AudioChunk` defined in `docs/API_CONTRACT.md`.

---

## MediaPipe WASM

MediaPipe requires WebAssembly files to be served locally. These are copied from `node_modules` into `public/mediapipe/` automatically during `npm install` via the `postinstall` script. This folder is not committed to version control.

If the WASM files are missing, run:

```bash
node scripts/copy-mediapipe-wasm.js
```

---

## Environment variables

| Variable            | Default                 | Description                         |
|---------------------|-------------------------|-------------------------------------|
| `VITE_APP_WS_URL`   | `ws://localhost:8000`   | WebSocket URL for the App container |
| `VITE_APP_HTTP_URL` | `http://localhost:8000` | HTTP URL for the App container      |

Create a `.env.local` file in the `client/` directory to override these during development.

---

## Production build

The production image is a static nginx container. The React app is compiled to static files by Vite and served by nginx with SPA routing and correct WASM MIME types.

```bash
docker compose up --build client
```

Do not run `docker build` directly from the `client/` directory — the build context must be the repo root so that `shared/` is available. See `docs/CONTRIBUTING.md` for details.