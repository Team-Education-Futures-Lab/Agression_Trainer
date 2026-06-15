# =============================================================================
# AR Training — Transcription Container
# Build context must be the repo root (docker compose handles this).
#
# Architecture-aware Multi-Platform Setup
# ---------------------------------------
# - amd64 (x86_64): Installs the standard binary wheel straight from PyPI,
#   which natively packs pre-compiled CUDA 12.x capabilities.
# - arm64 (aarch64): PyPI binaries are strictly CPU-only. For deployment on 
#   NVIDIA DGX Spark / Grace Hopper configurations, we pull the source repository
#   and compile the CUDA/C++ binding binaries directly against the local GPU hardware.
# =============================================================================

# ── Architecture-specific base images ─────────────────────────────────────────
# Note: ARM64 maps to a development layer (-devel) to access nvcc and headers.
FROM nvidia/cuda:13.0.0-devel-ubuntu24.04 AS base-arm64
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base-amd64

ARG TARGETARCH
FROM base-${TARGETARCH} AS final

ARG TARGETARCH

# ── System dependencies ────────────────────────────────────────────────────────
# cmake, git, and build-essential are required strictly during the ARM64 compile path.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-dev \
        build-essential \
        cmake \
        git \
        curl \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# ── Environmental Mapping ──────────────────────────────────────────────────────
# Ensures CTranslate2 and underlying CUDA dependencies bind cleanly at runtime 
# regardless of differences in underlying OS filesystem layouts.
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH}

# ── Python & Component Installation ───────────────────────────────────────────
COPY transcription/requirements.txt .

# 1. Install regular application dependencies
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

# 2. Branch conditionally based on CPU target architecture
RUN if [ "$TARGETARCH" = "arm64" ] ; then \
        echo "Building CTranslate2 from source with CUDA support for ARM64 (DGX/Grace Hopper)..." && \
        git clone --recursive https://github.com/OpenNMT/CTranslate2.git /tmp/ctranslate2 && \
        mkdir /tmp/ctranslate2/build && cd /tmp/ctranslate2/build && \
        cmake .. -DWITH_CUDA=ON -DWITH_MKL=OFF -DWITH_DNNL=OFF && \
        make -j$(nproc) && make install && ldconfig && \
        cd /tmp/ctranslate2/python && \
        pip install --no-cache-dir --break-system-packages -r install_requirements.txt && \
        python setup.py bdist_wheel && \
        pip install --no-cache-dir --break-system-packages --force-reinstall dist/*.whl && \
        rm -rf /tmp/ctranslate2 ; \
    else \
        echo "Installing standard stable CTranslate2 wheels with CUDA support for AMD64..." && \
        pip install --no-cache-dir --break-system-packages --force-reinstall ctranslate2 ; \
    fi

# ── Multi-Stage Layer Clean up ─────────────────────────────────────────────────
# Strips development packages to keep production image size lean.
RUN apt-get purge -y cmake git build-essential && apt-get autoremove -y

# ── Source Allocation ─────────────────────────────────────────────────────────
COPY transcription/src ./src

WORKDIR /app/src

EXPOSE 8003

CMD ["python", "main.py"]
