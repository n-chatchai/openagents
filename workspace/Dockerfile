# The Workspace as one Erawan app (erawan.yaml): the door (oauth2-proxy) on
# $PORT in front of the backend (uvicorn, 127.0.0.1:8000) and the web app (Next
# standalone, 127.0.0.1:3000). Postgres and Redis are Erawan add-ons; files
# live on the app's disk. One image serves any address: the web app is built
# against a placeholder that start.sh replaces with $PUBLIC_URL.
#
#   erawan deploy https://github.com/pace6/openagents --ref erawan --subdir workspace

FROM node:20-bookworm-slim AS web
WORKDIR /web
ENV NEXT_PUBLIC_API_URL=https://workspace-public-url.invalid \
    NEXT_PUBLIC_DOOR_LOGIN=1 NEXT_TELEMETRY_DISABLED=1
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build \
 && mkdir -p .next/standalone/.next \
 && cp -r .next/static .next/standalone/.next/static \
 && cp -r public .next/standalone/public

FROM quay.io/oauth2-proxy/oauth2-proxy:v7.15.5 AS door

FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt backend/requirements.production.lock ./
RUN pip install --no-cache-dir -r requirements.txt -c requirements.production.lock 'PyYAML>=6.0'
COPY backend/app/ ./app/
COPY backend/alembic/ ./alembic/
COPY backend/openagents/ ./openagents/
COPY backend/cloud_providers/ ./cloud_providers/
COPY backend/registry/ ./registry/
COPY backend/alembic.ini ./
COPY --from=node:20-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=web /web/.next/standalone /web
COPY --from=door /bin/oauth2-proxy /usr/local/bin/oauth2-proxy
COPY start.sh /start.sh
RUN chmod +x /start.sh && useradd -u 1000 -m app && mkdir -p /disk \
 && chown -R app /disk /web
USER 1000
ENV PYTHONPATH=/app PYTHONUNBUFFERED=1 PORT=8080
EXPOSE 8080
CMD ["/start.sh"]
