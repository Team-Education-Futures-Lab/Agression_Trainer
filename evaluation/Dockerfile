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
# =============================================================================

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# ── System dependencies ────────────────────────────────────────────────────────
# libsndfile1: required by soundfile (used by transformers audio feature extractor)
# libgomp1:    required by librosa (OpenMP for parallel processing)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-dev \
        python3-pip \
        curl \
        libsndfile1 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# ── PyTorch with CUDA ─────────────────────────────────────────────────────────
# Install torch and torchaudio from the official CUDA wheel index first so they
# pick up the correct CUDA variant. This layer is cached unless the versions change.
RUN pip install --no-cache-dir \
    torch==2.5.1+cu124 \
    torchaudio==2.5.1+cu124 \
    --index-url https://download.pytorch.org/whl/cu124

# ── Python dependencies ───────────────────────────────────────────────────────
# Install the rest of requirements.txt. torch and torchaudio are already
# installed above; pip will skip them here.
COPY evaluation/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Source ────────────────────────────────────────────────────────────────────
COPY evaluation/src ./src

EXPOSE 8001

# ── Model pre-download (optional build-time cache) ───────────────────────────
# Uncomment the lines below to bake the HuggingFace models into the image at
# build time. This makes the image larger (~1 GB extra) but eliminates the
# first-request download delay. In production, prefer a Docker volume mount
# at /root/.cache/huggingface so models persist across image rebuilds.
#
# ARG EMOTION_MODEL=audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim
# ARG SENTIMENT_MODEL=cardiffnlp/twitter-xlm-roberta-base-sentiment
# RUN python3 -c "
# from transformers import AutoProcessor, AutoModelForAudioClassification, pipeline
# AutoProcessor.from_pretrained('${EMOTION_MODEL}')
# AutoModelForAudioClassification.from_pretrained('${EMOTION_MODEL}')
# pipeline('text-classification', model='${SENTIMENT_MODEL}')
# "

CMD ["python", "src/main.py"]