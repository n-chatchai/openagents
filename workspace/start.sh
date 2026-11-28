#!/bin/bash
# The Workspace on Erawan (Dockerfile): migrations, the backend, the web app,
# and the door last, once the backend answers. If any one exits, the app
# exits and Erawan restarts it: a half-running Workspace is worse.
set -euo pipefail
: "${PUBLIC_URL:?set PUBLIC_URL, e.g. https://team.erawan.cloud}"
: "${DATABASE_URL:?add the postgres add-on}"
: "${REDIS_URL:?add the redis add-on}"
# Erawan mints DOOR_COOKIE_KEY as 64 hex characters; oauth2-proxy takes a
# cookie secret of 16, 24 or 32 bytes.
export OAUTH2_PROXY_COOKIE_SECRET="${DOOR_COOKIE_KEY:0:32}"
[ "${#OAUTH2_PROXY_COOKIE_SECRET}" = 32 ] || { echo "DOOR_COOKIE_KEY is missing or short" >&2; exit 1; }
# The door signs people in with the Workspace's own Google OAuth client.
export OAUTH2_PROXY_CLIENT_ID="${GOOGLE_CLIENT_ID:?set GOOGLE_CLIENT_ID}"
export OAUTH2_PROXY_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:?set GOOGLE_CLIENT_SECRET}"

export FILE_STORAGE_PATH="${FILE_STORAGE_PATH:-/disk/files}"
mkdir -p "$FILE_STORAGE_PATH"
export FRONTEND_BASE_URL="$PUBLIC_URL" PUBLIC_API_BASE="$PUBLIC_URL" CORS_ORIGINS="$PUBLIC_URL"
export GOOGLE_OAUTH_REDIRECT_URI="$PUBLIC_URL/v1/cloud-agents/google/callback"

# The web app was built against a placeholder address (Dockerfile).
grep -rlF "https://workspace-public-url.invalid" /web --include='*.js' --include='*.html' --include='*.json' \
  | xargs -r sed -i "s#https://workspace-public-url.invalid#${PUBLIC_URL%/}#g"

cd /app
alembic upgrade head

uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log &
(cd /web && HOSTNAME=127.0.0.1 PORT=3000 NODE_ENV=production exec node server.js) &

# The door opens only once the backend answers, so nobody meets a 502.
for _ in $(seq 1 90); do
  python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=2)" 2>/dev/null && break
  sleep 2
done

oauth2-proxy \
  --http-address="0.0.0.0:${PORT}" \
  --upstream=http://127.0.0.1:8000/v1/ \
  --upstream=http://127.0.0.1:8000/door/ \
  --upstream=http://127.0.0.1:3000/ \
  --provider=oidc \
  --provider-display-name=Google \
  --oidc-issuer-url=https://accounts.google.com \
  --redirect-url="$PUBLIC_URL/oauth2/callback" \
  --code-challenge-method=S256 \
  --scope="openid email profile" \
  --prompt=select_account \
  --email-domain='*' \
  --oidc-groups-claim=hd \
  --allowed-group="${DOOR_ALLOWED_DOMAIN:-pace6.tech}" \
  --skip-provider-button=true \
  --cookie-name=__Host-erawan-openagents-door \
  --cookie-secure=true \
  --cookie-samesite=lax \
  --cookie-expire=8h \
  --reverse-proxy=true \
  --trusted-proxy-ip=10.42.0.0/16 \
  --pass-user-headers=true \
  --pass-access-token=true \
  --api-route='^/door/' \
  --skip-auth-route='^/v1/' \
  --silence-ping-logging=true &

wait -n
echo "a process exited; stopping the app" >&2
exit 1
