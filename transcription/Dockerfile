# =============================================================================
# AR Training — Transcription Container
# Build context must be the repo root (docker compose handles this).
#
# Architecture-aware build
# ------------------------
# faster-whisper uses ctranslate2 for inference. The ctranslate2 PyPI wheel
# is compiled with CUDA support, but it requires the CUDA runtime libraries
# to be present on the host at startup. The default python:3.12-slim base
# image has no CUDA libraries, causing the error:
#
#   ValueError: This CTranslate2 package was not compiled with CUDA support
#
# The fix is to use an NVIDIA CUDA base image so the runtime libraries are
# present. ctranslate2 and faster-whisper are then installed normally from PyPI.
#
#   aarch64 (ARM64) — DGX Spark
#     Base: nvidia/cuda:13.0.0-runtime-ubuntu24.04
#
#   amd64 (x86_64) — standard server / workstation
#     Base: nvidia/cuda:12.4.1-runtime-ubuntu22.04
#
# Docker injects TARGETARCH automatically. No manual flag is needed.
#
# Requires: NVIDIA Container Toolkit on the host and the deploy.resources
# section in docker-compose.dokploy.yml to expose the GPU to this container.
# =============================================================================

# ── Architecture-specific base images ─────────────────────────────────────────
FROM nvidia/cuda:13.0.0-runtime-ubuntu24.04 AS base-arm64
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base-amd64

ARG TARGETARCH
FROM base-${TARGETARCH} AS final

# ── System dependencies ────────────────────────────────────────────────────────
# curl:   used by the Docker healthcheck
# ffmpeg: required by faster-whisper for audio decoding
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        curl \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# ── Python dependencies ───────────────────────────────────────────────────────
# faster-whisper pulls in ctranslate2 from PyPI. The PyPI wheel is compiled
# with CUDA support — it just requires the CUDA runtime libraries to be present,
# which the base image above provides.
#
# --break-system-packages is required on Ubuntu 24.04 (PEP 668).
# It is safe inside a container — there is no system package manager conflict.
COPY transcription/requirements.txt .
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

# ── Source ────────────────────────────────────────────────────────────────────
COPY transcription/src ./src

WORKDIR /app/src

EXPOSE 8003

CMD ["python", "main.py"]
