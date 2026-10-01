# syntax=docker/dockerfile:1
# What Happened Here? 2.0 — Hugging Face Spaces (Docker SDK)
#
# The space listens on $PORT (HF expects 7860), binds 0.0.0.0 via the HOST
# env read by server.py, and the startup warm-up thread downloads YAMNet
# (~5 MB) on the first boot.
FROM python:3.12-slim

# ffmpeg for m4a/mp3 uploads — soundfile already covers wav/flac/ogg/mp3
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# dependencies first so this layer caches across code pushes
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

COPY . .

ENV HOST=0.0.0.0 \
    PORT=7860
EXPOSE 7860

CMD ["python", "server.py"]
