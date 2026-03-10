FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies before copying source so the layer is cached
COPY transcription/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY transcription/src ./src

# FastAPI runs from inside src/ so Python can resolve local imports
WORKDIR /app/src

EXPOSE 8003

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]