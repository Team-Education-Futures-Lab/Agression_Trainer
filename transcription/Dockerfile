# =============================================================================
# AR Training — Transcription Container
# Build context must be the repo root (docker compose handles this).
#
# Architecture-aware Multi-Platform Setup
# ---------------------------------------
# - amd64 (x86_64): Installs the standard binary wheel straight from PyPI.
# - arm64 (aarch64): Compiles CTranslate2 with native GPU acceleration against
#   LTS CUDA toolkits to ensure GCC compiler compliance on DGX hardware.
# =============================================================================

# ── Architecture-specific base images ─────────────────────────────────────────
# Crucial: Using Ubuntu 22.04 base environments here guarantees GCC 11/12 compatibility 
# with the NVIDIA compiler, resolving the C++ source optimization drops.
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS base-arm64
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base-amd64

ARG TARGETARCH
FROM base-${TARGETARCH} AS final

ARG TARGETARCH

# ── System dependencies ────────────────────────────────────────────────────────
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-dev \
        python3-setuptools \
        build-essential \
        cmake \
        git \
        curl \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# ── Environmental Mapping ──────────────────────────────────────────────────────
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH}

# ── Python & Component Installation ───────────────────────────────────────────
COPY transcription/requirements.txt .

# 1. Install regular application dependencies
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

# 2. Branch conditionally based on CPU target architecture
RUN if [ "$TARGETARCH" = "arm64" ] ; then \
        echo "Building CTranslate2 from source with CUDA support for ARM64..." && \
        git clone --recursive https://github.com/OpenNMT/CTranslate2.git /tmp/ctranslate2 && \
        mkdir /tmp/ctranslate2/build && cd /tmp/ctranslate2/build && \
        # Explicitly enforce OpenMP compatibility blocks via -DOPENMP_RUNTIME=COMP
        cmake .. -DWITH_CUDA=ON -DWITH_MKL=OFF -DWITH_DNNL=OFF -DOPENMP_RUNTIME=COMP && \
        make -j$(nproc) && make install && ldconfig && \
        cd /tmp/ctranslate2/python && \
        pip install --no-cache-dir --break-system-packages --upgrade pip wheel && \
        pip install --no-cache-dir --break-system-packages -r install_requirements.txt && \
        python setup.py bdist_wheel && \
        pip install --no-cache-dir --break-system-packages --force-reinstall dist/*.whl && \
        rm -rf /tmp/ctranslate2 ; \
    else \
        echo "Installing standard stable CTranslate2 wheels with CUDA support for AMD64..." && \
        pip install --no-cache-dir --break-system-packages --force-reinstall ctranslate2 ; \
    fi

# ── Multi-Stage Layer Clean up ─────────────────────────────────────────────────
RUN apt-get purge -y cmake git build-essential && apt-get autoremove -y

# ── Source Allocation ─────────────────────────────────────────────────────────
COPY transcription/src ./src

WORKDIR /app/src

EXPOSE 8003

CMD ["python", "main.py"]
