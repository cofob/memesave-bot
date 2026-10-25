# TikTok likes → memesave. Chromium runs as a normal (not headless) browser on an Xvfb virtual display:
# TikTok rejects captcha answers from headless Chromium.
#   docker build -t tiktok-sync tiktok-sync
#   docker run -it --rm -v ./data:/data tiktok-sync login     # scan the QR code
#   docker run -d --restart unless-stopped -v ./data:/data --env-file .env tiktok-sync
FROM python:3.13-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PYTHONUNBUFFERED=1 \
    HEADLESS=0 \
    PROFILE_DIR=/data/profile \
    STATE_FILE=/data/state.json

RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb xauth tini fonts-noto-color-emoji \
 && pip install --no-cache-dir playwright==1.64.1 qrcode==8.2 \
 && playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1000 app \
 && mkdir /data && chown app /data

COPY sync.py /app/sync.py
USER app
WORKDIR /data
VOLUME /data

# tini reaps the browser's processes; xvfb-run -a picks a free display for every run.
ENTRYPOINT ["tini", "--", "xvfb-run", "-a", "-s", "-screen 0 1280x900x24", "python", "/app/sync.py"]
