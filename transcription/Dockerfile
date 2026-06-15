# =============================================================================
# AR Training — Transcription Container
# Build context must be the repo root (docker compose handles this).
#
# Architecture-aware Multi-Platform Setup
# ---------------------------------------
# - amd64 (x86_64): Installs the standard binary wheel straight from PyPI.
# - arm64 (aarch64): Compiles CTranslate2 with native GPU acceleration against
#   CUDA toolkits using explicitly declared GCC-12 compliance overrides.
# =============================================================================

# ── Architecture-specific base images ─────────────────────────────────────────
FROM nvidia/cuda:12.8.0-devel-ubuntu24.04 AS base-arm64
FROM nvidia/cuda:12.8.0-runtime-ubuntu24.04 AS base-amd64

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
        python3-wheel \
        build-essential \
        gcc-12 \
        g++-12 \
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
        cmake .. \
          -DCMAKE_C_COMPILER=gcc-12 \
          -DCMAKE_CXX_COMPILER=g++-12 \
          -DWITH_CUDA=ON \
          -DWITH_MKL=OFF \
          -DWITH_DNNL=OFF \
          -DOPENMP_RUNTIME=COMP && \
        make -j$(nproc) && make install && ldconfig && \
        cd /tmp/ctranslate2/python && \
        # Removed the problematic inline upgrade command causing the Debian drop block
        pip install --no-cache-dir --break-system-packages -r install_requirements.txt && \
        python setup.py bdist_wheel && \
        # Force-install using ignore-installed to bypass system package manager conflicts
        pip install --no-cache-dir --break-system-packages --ignore-installed --force-reinstall dist/*.whl && \
        rm -rf /tmp/ctranslate2 ; \
    else \
        echo "Installing standard stable CTranslate2 wheels with CUDA support for AMD64..." && \
        pip install --no-cache-dir --break-system-packages --force-reinstall ctranslate2 ; \
    fi

# ── Multi-Stage Layer Clean up ─────────────────────────────────────────────────
RUN apt-get purge -y cmake git build-essential gcc-12 g++-12 && apt-get autoremove -y

# ── Source Allocation ─────────────────────────────────────────────────────────
COPY transcription/src ./src

WORKDIR /app/src

EXPOSE 8003

CMD ["python", "main.py"]
