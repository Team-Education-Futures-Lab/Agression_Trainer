"""
Transcription container entrypoint.

Wires config → pool → service → FastAPI routes.
All business logic lives in TranscriptionService; this file stays thin.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import Depends, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from auth import make_verify_token, ws_verify_token
from config import load_config, TranscriptionConfig
from interfaces import HealthStatus, WorkerStatus, TranscriptionPoolInterface
from session_store import SessionStore
from transcription_service import TranscriptionService

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# How long to wait for the next message from the App container before treating
# the connection as dead. Audio chunks arrive approximately every 2 s during
# active recording. 30 s is generous enough to cover any pause in the scenario,
# while still recovering slots if the TCP connection dies silently.
_WS_RECEIVE_TIMEOUT_S = 30.0


# ─── Dependency wiring ────────────────────────────────────────────────────────

def _make_pool(cfg: TranscriptionConfig) -> TranscriptionPoolInterface:
    match cfg.pool_impl:
        case "stub":
            from stubs.stub_transcription_pool import StubTranscriptionPool
            return StubTranscriptionPool()
        case "production":
            from whisper_pool import WhisperPool
            return WhisperPool(cfg)
        case other:
            raise ValueError(f"Unknown TRANSCRIPTION_POOL value: {other!r}")


# ─── App factory ──────────────────────────────────────────────────────────────

def create_app() -> FastAPI:
    cfg   = load_config()
    store = SessionStore()
    pool  = _make_pool(cfg)
    svc   = TranscriptionService(pool, store)

    verify_token = make_verify_token(cfg.internal_api_key)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        logger.info(
            "Transcription container starting — pool=%s device=%s workers=%d default_language=%s",
            cfg.pool_impl, cfg.device, pool.worker_count, cfg.whisper_language,
        )
        yield
        logger.info("Transcription container shutting down")

    app = FastAPI(title="AR Training — Transcription", lifespan=lifespan)

    # ── WebSocket ─────────────────────────────────────────────────────────────

    @app.websocket("/ws/{session_id}")
    async def ws_transcription(session_id: str, websocket: WebSocket):
        """
        Persistent WebSocket opened by the App container once per clip.

        Accepts AudioChunk messages and streams Transcript messages back.
        Authentication is checked on the handshake headers before accepting.

        The per-session transcription language is read from the `language`
        query parameter (e.g. /ws/{session_id}?language=nl). When absent,
        the container-level WHISPER_LANGUAGE default is used. This allows the
        App container to control the transcription language per session so
        different scenarios can use different languages without restarting the
        container or changing the .env file.

        The receive loop uses asyncio.wait_for with a generous timeout so that
        a TCP connection that dies without a WebSocket close frame does not leave
        the session entry in SessionStore indefinitely. On timeout the loop exits
        and close_session() is called via the finally block.
        """
        if not await ws_verify_token(websocket, cfg.internal_api_key):
            return   # ws_verify_token already closed the connection

        # Read the per-session language from the query string.
        # Fall back to the container default when the param is absent or empty.
        language: str = websocket.query_params.get("language", "").strip()
        if not language:
            language = cfg.whisper_language
            logger.debug(
                "WS %s: no language param — using container default '%s'",
                session_id, language,
            )
        else:
            logger.debug("WS %s: language='%s'", session_id, language)

        await websocket.accept()
        svc.open_session(session_id, websocket, language)
        logger.info("WS connected: session=%s language=%s", session_id, language)

        try:
            while True:
                try:
                    raw = await asyncio.wait_for(
                        websocket.receive_text(),
                        timeout=_WS_RECEIVE_TIMEOUT_S,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "WS receive timeout for session=%s — closing silently dropped connection",
                        session_id,
                    )
                    break

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("malformed JSON from session %s — skipping", session_id)
                    continue

                if msg.get("type") == "audio_chunk":
                    await svc.on_audio_chunk(session_id, msg)
                else:
                    logger.debug("unexpected message type %r from %s", msg.get("type"), session_id)

        except WebSocketDisconnect:
            logger.info("WS disconnected: session=%s", session_id)
        finally:
            svc.close_session(session_id)

    # ── HTTP endpoints ────────────────────────────────────────────────────────

    @app.post(
        "/transcription/finalise/{session_id}",
        dependencies=[Depends(verify_token)],
    )
    async def finalise(session_id: str):
        """
        Flush any in-flight audio and emit a final Transcript (is_final=True)
        over the session WebSocket. Called by the App container on ClipEnded.
        """
        ok = await svc.finalise(session_id)
        if not ok:
            return JSONResponse(
                status_code=404,
                content={"error": "session_not_found", "session_id": session_id},
            )
        return {"session_id": session_id, "status": "finalised"}

    @app.post(
        "/transcription/reset/{session_id}",
        dependencies=[Depends(verify_token)],
    )
    async def reset(session_id: str):
        """
        Clear the per-session VAD buffer between clips.
        Called by the App container after each clip transition.
        """
        svc.reset_session(session_id)
        return {"session_id": session_id, "status": "reset"}

    @app.get("/transcription/health")
    async def health():
        """Report worker pool status and inference device."""
        status = HealthStatus(
            status          = "ok",
            whisper_workers = WorkerStatus(
                total     = pool.worker_count,
                available = pool.available_workers,
            ),
            device = pool.device,
        )
        from dataclasses import asdict
        return asdict(status)

    return app


# ─── Entrypoint ───────────────────────────────────────────────────────────────

app = create_app()

if __name__ == "__main__":
    from config import load_config as _lc
    _cfg = _lc()
    uvicorn.run("main:app", host="0.0.0.0", port=_cfg.port, reload=False)