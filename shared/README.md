# @ar-training/shared

Shared TypeScript type definitions for the AR Training platform. This is the single source of truth for all data transfer objects (DTOs) that cross container boundaries.

This package is not a runnable service — it contains only type definitions and has no build step.

---

## Usage

The package is referenced as a local npm dependency. Add it to any TypeScript service that needs the shared types:

```json
// package.json
{
    "dependencies": {
        "@ar-training/shared": "file:../shared"
    }
}
```

Then run `npm install` to link the package, and import types directly:

```typescript
import type { VideoFrame, AudioChunk, SessionState } from "@ar-training/shared";
```

---

## What's in here

All types are defined and documented in `types.ts`. The main categories are:

- **Wire types** — `VideoFrame`, `AudioChunk`, `SessionUpdate`, `SessionComplete`, `FeedbackToken`, `ServerError` — the exact shapes sent over WebSocket
- **Capture types** — `RawVideoFrame`, `RawAudioChunk` — client-internal types produced by the capture pipeline before a session ID is known
- **HTTP types** — `CreateSessionRequest`, `CreateSessionResponse`, `ResumeSessionResponse`, `QueueStatusResponse`
- **Scenario types** — `ClipMetadata`, `BranchCondition`
- **Primitives** — `Landmark`, `WindowID`, `SessionState`

---

## Usage in Docker

Because `shared/` is a local package, any service that depends on it must have access to it during the Docker build. This means **Dockerfiles for services that use `@ar-training/shared` must be built with the repo root as the build context**, not the service directory.

In `docker-compose.yml` this is handled automatically:

```yaml
services:
  app:
    build:
      context: .                  # repo root — shared/ is visible
      dockerfile: app/Dockerfile
```

Inside the Dockerfile, paths are written relative to the repo root:

```dockerfile
COPY shared/ ./shared/
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ .
```

Do not run `docker build` directly from inside a service directory — the build will fail because `shared/` will be outside the build context. Always use `docker compose` from the repo root, or explicitly set the build context:

```bash
# correct
docker build -f app/Dockerfile .

# wrong — shared/ is not visible
cd app && docker build .
```

---

## Python equivalent

The `evaluation/` container is Python and cannot use this package directly. Its equivalent type definitions live in `evaluation/src/interfaces.py` as dataclasses, and must be kept manually in sync with this file and the shapes defined in `docs/API_CONTRACT.md`.