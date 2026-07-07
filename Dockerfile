FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    gcc \
    python3-dev \
    cpulimit \
    && apt-get install -y --no-install-recommends \
    libva-drm2 libva-x11-2 vainfo mesa-va-drivers \
    || true \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./
RUN mkdir -p /app/static

EXPOSE 6767

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "6767"]
