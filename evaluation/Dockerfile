# =============================================================================
# AR Training — Evaluation Container
# Build context must be the repo root (docker compose handles this).
#
# Uses an NVIDIA CUDA base image so PyTorch can use the GPU at runtime.
# The CUDA version here (12.4) should match the driver on the host server.
# If your server runs a different CUDA version, update the base image tag:
#   https://hub.docker.com/r/nvidia/cuda/tags
#
# Requires: NVIDIA Container Toolkit on the host and the `deploy.resources`
# section in docker-compose.yml to expose the GPU to this container.
#
# Model download strategy
# -----------------------
# The HuggingFace sentiment model is NOT baked into the image.
# It is downloaded once at runtime by BehaviourAnalyser.warm_up(), which is
# called from the FastAPI lifespan handler after uvicorn is already listening.
# This keeps the image lean and ensures the healthcheck endpoint responds
# immediately on startup regardless of download speed.
#
# The model is cached in the HuggingFace default cache dir inside the
# container (~/.cache/huggingface). To persist it across container
# recreations, bind-mount a host directory:
#
#   volumes:
#     - ./models/hf_cache:/root/.cache/huggingface
#
# Once cached, warm_up() loads from disk and completes in a few seconds.
# =============================================================================

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# ── System dependencies ────────────────────────────────────────────────────────
# libsndfile1: required by soundfile / librosa
# libgomp1:    required by librosa (OpenMP)
# ffmpeg:      required by opensmile for audio decoding
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-dev \
        python3-pip \
        curl \
        libsndfile1 \
        libgomp1 \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# ── PyTorch with CUDA ─────────────────────────────────────────────────────────
# Install torch and torchaudio from the official CUDA wheel index first so they
# pick up the correct CUDA variant. This layer is cached unless the versions change.
# torch is NOT listed in requirements.txt to avoid version conflicts — this is
# the single source of truth for the torch version.
RUN pip install --no-cache-dir \
    torch==2.5.1+cu124 \
    torchaudio==2.5.1+cu124 \
    --index-url https://download.pytorch.org/whl/cu124

# ── Python dependencies ───────────────────────────────────────────────────────
COPY evaluation/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Source and config ─────────────────────────────────────────────────────────
COPY evaluation/src ./src
COPY evaluation/evaluation_config.toml ./evaluation_config.toml

EXPOSE 8001

CMD ["python", "src/main.py"]