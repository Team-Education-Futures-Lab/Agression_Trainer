"""
Evaluation container entrypoint.

Wires config → analyser → FastAPI routes.
All business logic lives in BehaviourAnalyserInterface implementations;
this file stays thin.

Startup sequence
----------------
1. create_app() instantiates the analyser synchronously.
   For the production analyser this is fast — only opensmile and config
   loading happen here.  The sentiment model download is deferred.
2. uvicorn starts listening.  GET /evaluate/health returns immediately
   with model_ready=False while warm-up is still running.
3. The lifespan handler spawns warm_up() as a background task.
   When warm_up() completes, model_ready flips to True.
4. GET /evaluate/analyse blocks on the warm-up event if a request
   arrives before warm-up finishes, then proceeds normally.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import asdict

import uvicorn
from fastapi import Depends, FastAPI, Header
from pydantic import BaseModel, ConfigDict

from auth import make_verify_token
from config import EvaluationConfig, load_config
from interfaces import (
    AnalysisWindow,
    BehaviourAnalyserInterface,
    BranchCondition,
    ClipMetadata,
    HealthStatus,
    Landmark,
    RubricEntry,
    ScoreRange,
    VideoFrame,
    WordTiming,
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
            from behaviour_analyser import BehaviourAnalyser
            return BehaviourAnalyser(cfg)
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


class RubricEntryModel(BaseModel):
    signal: str
    weight: float


class WordTimingModel(BaseModel):
    word:  str
    start: float
    end:   float


class ScoreRangeModel(BaseModel):
    min: float = -1.0
    max: float =  1.0


class ClipMetadataModel(BaseModel):
    # Extra fields sent by the App container (e.g. video_url) are accepted but
    # ignored — the Evaluation container only needs the fields listed here.
    model_config = ConfigDict(extra="ignore")

    clip_id:               str
    scenario_id:           str
    transcript:            str
    clip_duration_seconds: float
    notable_features:      list[str]
    scoring_mode:          str
    de_escalation_rubric:  list[RubricEntryModel]
    escalation_rubric:     list[RubricEntryModel]
    critical_failures:     list[str]                = []
    score_range:           ScoreRangeModel          = ScoreRangeModel()
    branch_conditions:     list[BranchConditionModel]
    # Feedback-only fields — accepted and forwarded but not used by the scorer
    clip_learning_objectives: list[str]  = []
    ideal_response:           str | None = None
    response_warnings:        list[str]  = []


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
    words:         list[WordTimingModel] = []
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
        clip_id               = m.clip_id,
        scenario_id           = m.scenario_id,
        transcript            = m.transcript,
        clip_duration_seconds = m.clip_duration_seconds,
        notable_features      = m.notable_features,
        scoring_mode          = m.scoring_mode,
        de_escalation_rubric  = [RubricEntry(signal=e.signal, weight=e.weight) for e in m.de_escalation_rubric],
        escalation_rubric     = [RubricEntry(signal=e.signal, weight=e.weight) for e in m.escalation_rubric],
        critical_failures     = m.critical_failures,
        score_range           = ScoreRange(min=m.score_range.min, max=m.score_range.max),
        branch_conditions     = [
            BranchCondition(
                min_score = bc.min_score,
                max_score = bc.max_score,
                next_clip = bc.next_clip,
            )
            for bc in m.branch_conditions
        ],
        clip_learning_objectives = m.clip_learning_objectives,
        ideal_response           = m.ideal_response,
        response_warnings        = m.response_warnings,
    )


def _to_analysis_window(m: AnalysisWindowModel) -> AnalysisWindow:
    return AnalysisWindow(
        window_id     = m.window_id,
        session_id    = m.session_id,
        frames        = [_to_video_frame(f) for f in m.frames],
        mfccs         = m.mfccs,
        transcript    = m.transcript,
        words         = [WordTiming(word=w.word, start=w.start, end=w.end) for w in m.words],
        clip_metadata = _to_clip_metadata(m.clip_metadata),
    )


# ─── App factory ──────────────────────────────────────────────────────────────

def create_app() -> FastAPI:
    cfg      = load_config()
    analyser = _make_analyser(cfg)

    verify_token = make_verify_token(cfg.internal_api_key)

    # asyncio.Event that is set once warm_up() completes.
    # analyse() awaits this before processing any request, so a request that
    # arrives before warm-up finishes will wait rather than fail.
    _ready = asyncio.Event()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        logger.info(
            "Evaluation container starting — analyser=%s device=%s",
            cfg.analyser_impl, cfg.device,
        )

        async def _run_warmup() -> None:
            try:
                await analyser.warm_up()
                logger.info("Analyser warm-up complete — model_ready=True")
            except Exception:
                logger.exception(
                    "Analyser warm-up failed — POST /evaluate/analyse will be "
                    "unavailable until the container is restarted"
                )
            finally:
                # Set the event regardless so that a failed warm-up doesn't
                # leave analyse() waiting forever; the analyser itself will
                # raise on the first real request if the model never loaded.
                _ready.set()

        asyncio.create_task(_run_warmup())

        yield

        logger.info("Evaluation container shutting down")

    app = FastAPI(title="AR Training — Evaluation", lifespan=lifespan)

    # ── POST /evaluate/analyse ────────────────────────────────────────────────

    @app.post(
        "/evaluate/analyse",
        dependencies=[Depends(verify_token)],
    )
    async def analyse(
        body: AnalysisWindowModel,
        x_debug: str | None = Header(default=None, alias="X-Debug"),
    ):
        """
        Analyse a complete clip window and return a BehaviourResult.
        Called exactly once per clip by the App container.

        Blocks until warm_up() has completed so that the first request never
        races against model initialisation.

        When the request carries X-Debug: true (admin sessions only), the
        response includes an additional top-level `debug` field with
        analyser_id and implementation-specific stage intermediates.
        """
        await _ready.wait()

        collect_debug = x_debug is not None and x_debug.lower() == "true"
        window        = _to_analysis_window(body)
        result, stages = await analyser.analyse(window, collect_debug=collect_debug)

        response = asdict(result)

        if collect_debug:
            response["debug"] = {
                "analyser_id": analyser.analyser_id,
                "stages":      stages,
            }

        return response

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
        """
        Report analyser implementation, inference device, and model readiness.

        model_ready is False while the production analyser is still downloading
        or initialising its sentiment model.  The container responds immediately
        on startup so the Docker healthcheck never times out; the App container
        treats model_ready=False as degraded rather than unreachable.
        """
        status = HealthStatus(
            status      = "ok",
            device      = cfg.device,
            model_ready = analyser.model_ready,
        )
        return asdict(status)

    # ── GET /evaluate/debug/config ────────────────────────────────────────────

    @app.get(
        "/evaluate/debug/config",
        dependencies=[Depends(verify_token)],
    )
    async def debug_config():
        """
        Return the active threshold configuration and lexical phrase lists.
        Only available on the production analyser — the stub has no config.

        Protected by INTERNAL_API_KEY. Useful for verifying that a deployed
        container is running with the expected configuration without reading
        the filesystem. In a multi-instance deployment, query each instance
        separately to confirm all instances are running identical config.
        """
        from behaviour_analyser import BehaviourAnalyser
        if not isinstance(analyser, BehaviourAnalyser):
            return {
                "analyser_id": analyser.analyser_id,
                "note":        "debug/config is only available for the production analyser",
            }
        return {
            "analyser_id": analyser.analyser_id,
            "device":      cfg.device,
            **analyser.debug_config(),
        }

    return app


# ─── Entrypoint ───────────────────────────────────────────────────────────────

app = create_app()

if __name__ == "__main__":
    from config import load_config as _lc
    _cfg = _lc()
    uvicorn.run("main:app", host="0.0.0.0", port=_cfg.port, reload=False)