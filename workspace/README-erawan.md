# The Workspace on Erawan Cloud

Pixel Team's Workspace (team.erawan.cloud) runs as one Erawan Cloud app,
`pixelteam-workspace`, in the Pixel Team account. Three files here make it:

- `Dockerfile`: the door (oauth2-proxy), the backend and the web app in one
  image. The web app is built against a placeholder address that `start.sh`
  replaces with `PUBLIC_URL`, so one image serves any address.
- `start.sh`: migrations, the backend and the web app, then the door once the
  backend answers. If any process exits, the app exits and Erawan restarts it.
- `erawan.yaml`: the Postgres and Redis add-ons, the app's disk, and its keys.

## Deploy

```
erawan deploy https://github.com/pace6/openagents --ref erawan --subdir workspace --name pixelteam-workspace
```

Or from a checkout: `cd workspace && erawan deploy . --name pixelteam-workspace`.
The app's env stays from one deploy to the next; set it once (below).

## Keys

| Name | Who sets it |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | A person, on the app's Secrets tab: the OAuth client "Pixel Team Workspace" in the Google Cloud project Erawan Pixel (pace6.tech, Internal). Its redirect URI is `<PUBLIC_URL>/oauth2/callback`. |
| `DOOR_COOKIE_KEY`, `WORKSPACE_SESSION_SECRET` | Erawan, once, at the first deploy. Nobody sees them. |
| `ROUTER_LLM_API_KEY`, `MESSAGE_ROUTER_API_KEY` | A person: the team's OpenRouter key (the same value in both). |
| `APNS_KEY`, `APNS_KEY_ID` | A person: the APNs key for `cloud.erawan.pixelteam`. Without them iPhones get no push. |
| `FIREBASE_CREDENTIALS_JSON` | A person: the FCM service account. Without it Android gets no push. |
| `ERAWAN_BUILDER_KEY` | A person: the key Erawan Builder and the Workspace share. |

## Env

```
PUBLIC_URL=https://team.erawan.cloud
AUTH_MODE=workspace_token
IDENTITY_MODE=standalone
DOOR_EMAIL_HEADER=X-Forwarded-Email
WORKSPACE_SESSION_TTL_DAYS=1
SHARED_TOKEN_NEEDS_PERSON=1
CLOUD_AGENT_WORKERS=4
DB_POOL_SIZE=10
DB_MAX_OVERFLOW=5
ANALYTICS_ENABLED=0
YUMI_ENABLED=false
ROUTER_LLM_ENABLED=true
ROUTER_LLM_PROVIDER=openai
ROUTER_LLM_BASE_URL=https://openrouter.ai/api/v1
ROUTER_LLM_MODEL=openai/gpt-6-luna
MESSAGE_ROUTER_API=decisions
MESSAGE_ROUTER_MODEL=~typesafe/jev-latest
MESSAGE_ROUTER_BASE_URL=https://openrouter.ai/api/alpha
APNS_TEAM_ID=BYKSV6ZDH3
APNS_TOPIC=cloud.erawan.pixelteam
CHANGBOT_GATEWAY_URL=https://pixelbot.erawan.cloud
ERAWAN_BUILDER_WORKSPACE=<the workspace Erawan Builder opens threads in>
ERAWAN_BUILDER_OWNER=<the person those threads are opened for>
ERAWAN_BUILDER_PROGRESS_URL=https://api.erawan.cloud/v1/builder/workspace/progress
```

`DOOR_ALLOWED_DOMAIN` (default `pace6.tech`) is the Google Workspace domain the
door lets in.

## What other services expect

- Pixel Bot's gateway reaches the Workspace at its public `https://` address.
- Erawan Builder calls `/v1/erawan/builder` with `ERAWAN_BUILDER_KEY`; the
  Workspace's agent `erawan-builder` calls back at
  `https://api.erawan.cloud/v1/builder/workspace` with the same key.
