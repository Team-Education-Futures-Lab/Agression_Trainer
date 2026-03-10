"""
Evaluation container entrypoint.

Wires config → analyser → FastAPI routes.
All business logic lives in BehaviourAnalyserInterface implementations;
this file stays thin.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import asdict

import uvicorn
from fastapi import Depends, FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from auth import make_verify_token
from config import EvaluationConfig, load_config
from interfaces import (
    AnalysisWindow,
    BehaviourAnalyserInterface,
    BranchCondition,
    ClipMetadata,
    HealthStatus,
    Landmark,
    VideoFrame,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ─── Dependency wiring ────────────────────────────────────────────────────────

def _make_analyser(cfg: EvaluationConfig) -> BehaviourAnalyserInterface:
    match cfg.analyser_impl:
        case "stub":
            from stubs.stub_behaviour_analyser import StubBehaviourAnalyser
            return StubBehaviourAnalyser()
        case "production":
            from models.production_behaviour_analyser import ProductionBehaviourAnalyser
            return ProductionBehaviourAnalyser()
        case other:
            raise ValueError(f"Unknown BEHAVIOUR_ANALYSER value: {other!r}")


# ─── Pydantic request models ──────────────────────────────────────────────────
#
# FastAPI uses Pydantic for request body parsing. We define lightweight Pydantic
# models here that mirror the dataclasses in interfaces.py, then convert them
# before passing to the analyser. This keeps interfaces.py free of Pydantic
# and usable in tests without a running FastAPI app.

class LandmarkModel(BaseModel):
    x:          float
    y:          float
    z:          float
    visibility: float


class BranchConditionModel(BaseModel):
    min_score: float
    max_score: float
    next_clip: str | None


class ClipMetadataModel(BaseModel):
    clip_id:           str
    scenario_id:       str
    transcript:        str
    notable_features:  list[str]
    branch_conditions: list[BranchConditionModel]


class VideoFrameModel(BaseModel):
    session_id:     str
    frame_id:       int
    timestamp:      float
    face_landmarks: list[LandmarkModel]
    left_hand:      list[LandmarkModel]
    right_hand:     list[LandmarkModel]


class AnalysisWindowModel(BaseModel):
    window_id:     str
    session_id:    str
    frames:        list[VideoFrameModel]
    mfccs:         list[list[float]]
    transcript:    str
    clip_metadata: ClipMetadataModel


# ─── Conversion helpers ───────────────────────────────────────────────────────

def _to_landmark(m: LandmarkModel) -> Landmark:
    return Landmark(x=m.x, y=m.y, z=m.z, visibility=m.visibility)


def _to_video_frame(m: VideoFrameModel) -> VideoFrame:
    return VideoFrame(
        session_id     = m.session_id,
        frame_id       = m.frame_id,
        timestamp      = m.timestamp,
        face_landmarks = [_to_landmark(lm) for lm in m.face_landmarks],
        left_hand      = [_to_landmark(lm) for lm in m.left_hand],
        right_hand     = [_to_landmark(lm) for lm in m.right_hand],
    )


def _to_clip_metadata(m: ClipMetadataModel) -> ClipMetadata:
    return ClipMetadata(
        clip_id           = m.clip_id,
        scenario_id       = m.scenario_id,
        transcript        = m.transcript,
        notable_features  = m.notable_features,
        branch_conditions = [
            BranchCondition(
                min_score = bc.min_score,
                max_score = bc.max_score,
                next_clip = bc.next_clip,
            )
            for bc in m.branch_conditions
        ],
    )


def _to_analysis_window(m: AnalysisWindowModel) -> AnalysisWindow:
    return AnalysisWindow(
        window_id     = m.window_id,
        session_id    = m.session_id,
        frames        = [_to_video_frame(f) for f in m.frames],
        mfccs         = m.mfccs,
        transcript    = m.transcript,
        clip_metadata = _to_clip_metadata(m.clip_metadata),
    )


# ─── App factory ──────────────────────────────────────────────────────────────

def create_app() -> FastAPI:
    cfg      = load_config()
    analyser = _make_analyser(cfg)

    verify_token = make_verify_token(cfg.internal_api_key)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        logger.info(
            "Evaluation container starting — analyser=%s device=%s",
            cfg.analyser_impl, cfg.device,
        )
        yield
        logger.info("Evaluation container shutting down")

    app = FastAPI(title="AR Training — Evaluation", lifespan=lifespan)

    # ── POST /evaluate/analyse ────────────────────────────────────────────────

    @app.post(
        "/evaluate/analyse",
        dependencies=[Depends(verify_token)],
    )
    async def analyse(body: AnalysisWindowModel):
        """
        Analyse a complete clip window and return a BehaviourResult.
        Called exactly once per clip by the App container.
        """
        window = _to_analysis_window(body)
        result = await analyser.analyse(window)
        return asdict(result)

    # ── POST /evaluate/reset/{session_id} ─────────────────────────────────────

    @app.post(
        "/evaluate/reset/{session_id}",
        dependencies=[Depends(verify_token)],
    )
    async def reset(session_id: str):
        """
        No-op reset endpoint for API symmetry with the Transcription container.
        The Evaluation container is stateless — nothing to clear between clips.
        Returns 200 unconditionally.
        """
        return {"session_id": session_id, "status": "reset"}

    # ── GET /evaluate/health ──────────────────────────────────────────────────

    @app.get("/evaluate/health")
    async def health():
        """Report analyser implementation and inference device."""
        status = HealthStatus(status="ok", device=cfg.device)
        return asdict(status)

    return app


# ─── Entrypoint ───────────────────────────────────────────────────────────────

app = create_app()

if __name__ == "__main__":
    from config import load_config as _lc
    _cfg = _lc()
    uvicorn.run("main:app", host="0.0.0.0", port=_cfg.port, reload=False)
