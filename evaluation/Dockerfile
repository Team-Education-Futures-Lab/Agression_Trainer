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


# ── Model pre-download (optional build-time cache) ───────────────────────────
# Bakes the sentiment model into the image at build time so the first request
# doesn't stall on a download.
#
# The emotion model (opensmile eGeMAPS) requires no download — it ships with
# the opensmile package.
#
# To override the model at build time:
#   docker compose build --build-arg SENTIMENT_MODEL=some/other-model evaluation
#
ARG SENTIMENT_MODEL=lxyuan/distilbert-base-multilingual-cased-sentiments-student
ENV SENTIMENT_MODEL=${SENTIMENT_MODEL}
RUN python3 -c " \
import os \
from transformers import pipeline \
pipeline('text-classification', model=os.environ['SENTIMENT_MODEL']) \
"

# ── Python dependencies ───────────────────────────────────────────────────────
COPY evaluation/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Source and config ─────────────────────────────────────────────────────────
COPY evaluation/src ./src
COPY evaluation/evaluation_config.toml ./evaluation_config.toml

EXPOSE 8001

# ── Model pre-download (optional build-time cache) ───────────────────────────
# Uncomment to bake the sentiment model into the image at build time.
# The emotion model (opensmile eGeMAPS) requires no download — it ships with
# the opensmile package. The sentiment model ships safetensors so it loads
# cleanly regardless of torch version.
#
# ARG SENTIMENT_MODEL=lxyuan/distilbert-base-multilingual-cased-sentiments-student
# RUN python3 -c "
# from transformers import pipeline
# pipeline('text-classification', model='${SENTIMENT_MODEL}')
# "

CMD ["python", "src/main.py"]