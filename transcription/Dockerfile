# =============================================================================
# AR Training — Transcription Container
# Build context must be the repo root (docker compose handles this).
#
# Architecture-aware & Platform-Agnostic Build
# --------------------------------------------
# faster-whisper uses ctranslate2 for inference. The default PyPI wheels for 
# ctranslate2 often fail to resolve compiled CUDA components on modern runtimes
# (like ARM64 platforms with CUDA 13 or specific x86 workstation setups).
#
# This Dockerfile automatically handles base selection using TARGETARCH and builds
# target-agnostic Python steps that pull heavily optimized packages from NVIDIA's
# registry, fallback cleanly to standard PyPI mirrors, and configure the necessary
# runtime paths for GPU execution.
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

# ── Environment & Library Discovery ───────────────────────────────────────────
# Explicitly ensure that any underlying CUDA or Nvidia components can find their 
# respective libraries during CTranslate2 runtime binding.
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH}

# ── Python dependencies ───────────────────────────────────────────────────────
# We install standard dependencies first. Then, we execute a force reinstall on 
# ctranslate2 leveraging NVIDIA's index as a high-priority source while falling
# back gracefully to PyPI. 
#
# --break-system-packages is required on Ubuntu 24.04+ (PEP 668) inside the container.
COPY transcription/requirements.txt .

RUN pip install --no-cache-dir --break-system-packages -r requirements.txt \
    && pip install --no-cache-dir --break-system-packages --force-reinstall \
        ctranslate2 --extra-index-url https://pypi.nvidia.com

# ── Source ────────────────────────────────────────────────────────────────────
COPY transcription/src ./src

WORKDIR /app/src

EXPOSE 8003

CMD ["python", "main.py"]
