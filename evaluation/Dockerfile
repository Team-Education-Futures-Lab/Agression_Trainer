# =============================================================================
# AR Training — Evaluation Container
# Build context must be the repo root (docker compose handles this).
# =============================================================================

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so this layer is cached unless requirements change
COPY evaluation/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY evaluation/src ./src

EXPOSE 8001

CMD ["python", "src/main.py"]
