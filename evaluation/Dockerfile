# =============================================================================
# AR Training — Evaluation Container
# Build context must be the repo root (docker compose handles this).
#
# Architecture-aware build
# ------------------------
# This Dockerfile automatically selects the correct CUDA base image and
# PyTorch wheel index based on the build platform:
#
#   aarch64 (ARM64) — DGX Spark, Jetson, etc.
#     Base:  nvidia/cuda:13.0.0-runtime-ubuntu24.04
#     Torch: https://download.pytorch.org/whl/cu130
#     Reason: cu124 has no ARM64 wheels; DGX Spark ships CUDA 13.0 with
#             libcudart.so.13 only — packages built against cu124 will fail
#             at runtime with "libcudart.so.12: cannot open shared object".
#
#   amd64 (x86_64) — standard server / workstation
#     Base:  nvidia/cuda:12.4.1-runtime-ubuntu22.04
#     Torch: https://download.pytorch.org/whl/cu124
#
# Docker injects TARGETARCH automatically during `docker buildx build` or any
# `docker compose` build. No manual flag is needed.
#
# Requires: NVIDIA Container Toolkit on the host and the deploy.resources
# section in docker-compose.dokploy.yml to expose the GPU to this container.
#
# Model download strategy
# -----------------------
# The HuggingFace sentiment model is NOT baked into the image.
# It is downloaded once at runtime by BehaviourAnalyser.warm_up(), which is
# called from the FastAPI lifespan handler after uvicorn is already listening.
# This keeps the image lean and ensures the healthcheck endpoint responds
# immediately on startup regardless of download speed.
#
# The model is cached in ~/.cache/huggingface inside the container.
# Bind-mount a host directory to persist it across container recreations:
#
#   volumes:
#     - ./models/hf_cache:/root/.cache/huggingface
# =============================================================================

# ── Architecture-specific base images ─────────────────────────────────────────
# Docker populates TARGETARCH automatically; we alias it to a named stage so
# the final FROM can reference whichever base is appropriate.

FROM nvidia/cuda:13.0.0-runtime-ubuntu24.04 AS base-arm64
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base-amd64

# ── Select base for this build ─────────────────────────────────────────────────
ARG TARGETARCH
FROM base-${TARGETARCH} AS final

# ── Architecture-specific PyTorch wheel index ──────────────────────────────────
# ARG defaults set here are overridden per-arch in the RUN --mount trick below.
# We use a shell script approach so a single RUN instruction handles both cases
# without needing BuildKit --mount or complex syntax.
ARG TARGETARCH

# ── System dependencies ────────────────────────────────────────────────────────
# libsndfile1: required by soundfile / librosa
# libgomp1:    required by librosa (OpenMP)
# ffmpeg:      required by opensmile for audio decoding
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-dev \
        python3-pip \
        curl \
        libsndfile1 \
        libgomp1 \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# ── PyTorch with CUDA ─────────────────────────────────────────────────────────
# Selects the wheel index based on TARGETARCH:
#   arm64  → cu130  (only index with ARM64 wheels; required for DGX Spark)
#   amd64  → cu124  (standard x86_64 CUDA 12.4 wheels)
#
# torch is NOT listed in requirements.txt to avoid version conflicts.
# This RUN instruction is the single source of truth for the torch version.
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        TORCH_INDEX="https://download.pytorch.org/whl/cu130"; \
    else \
        TORCH_INDEX="https://download.pytorch.org/whl/cu124"; \
    fi \
    && pip install --no-cache-dir \
        torch \
        torchaudio \
        --index-url "$TORCH_INDEX"

# ── Python dependencies ───────────────────────────────────────────────────────
COPY evaluation/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Source and config ─────────────────────────────────────────────────────────
COPY evaluation/src ./src
COPY evaluation/evaluation_config.toml ./evaluation_config.toml

EXPOSE 8001

CMD ["python", "src/main.py"]
