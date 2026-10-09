# Backend container. Build from the backend/ directory:
#   docker build -t reavailable-backend .
#
# The image defaults to production mode. It refuses to start until you set AUDIOBOOK_API_KEY and
# the Azure speech settings (see README.md). Run it behind HTTPS.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    AUDIOBOOK_ENVIRONMENT=production \
    AUDIOBOOK_DATA_DIR=/data

WORKDIR /app
COPY pyproject.toml ./
COPY app ./app
RUN pip install . \
    && useradd --uid 10001 --create-home --home-dir /home/audiobook audiobook \
    && mkdir -p /data \
    && chown audiobook:audiobook /data

USER audiobook
VOLUME ["/data"]

# Hosting platforms usually pass the port in PORT. It defaults to 8000.
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/v1/health' % os.environ.get('PORT', '8000'), timeout=4)"

CMD ["sh", "-c", "exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT:-8000}"]
