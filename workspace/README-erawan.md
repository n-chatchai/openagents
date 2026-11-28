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

From a checkout of the `erawan` branch:

```
cd workspace && erawan deploy . --name pixelteam-workspace
```

Not from the GitHub URL: Erawan's repository import refuses a repository with
links in it, and `backend/Dockerfile` is upstream's link to
`backend.Dockerfile`.
The app's env stays from one deploy to the next; set it once (below).
The web container runs the backend, web app and OAuth door together.
`erawan.yaml` requests 0.5 CPU and 512 MiB and caps the container at 2 CPUs
and 2 GiB.

The web chat starts its polling fallback while a thread's live connection is
opening. Polling stops when the live connection opens.

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
- Erawan OPS, brought into a room with an operator's key, is called at
  `https://api.erawan.cloud/v1/ops/workspace` (`ERAWAN_OPS_WORKSPACE_URL`
  overrides it).

## Bot mentions in rooms

ChatGPT dots and Grok bots can wake another bot in the same room with an
explicit @mention in either a new post or a reply. Each mention starts a new
addressed request, with no handoff count limit. Stopping the room still
suppresses agent-to-agent routing until a person speaks again.

## Merging upstream

`git fetch upstream && git merge upstream/develop` (the remote is
`openagents-org/openagents`). Two things to check before the merge commit:

- **Alembic revisions.** This branch's own migrations took `101` and `102`
  before upstream did, and the running database is stamped with them. So
  upstream's migrations from 101 on are renumbered here with a `u`
  (`u101`, `u102`, …), chained after this branch's head: keep the file names,
  change `revision`/`down_revision` (and the docstring) only. A merge that
  brings a new upstream migration gives it the next `u` number and points it
  at the previous one; this branch's own new ones take `e103`, `e104`, … and
  go after the current head. Check with `alembic heads`: one head, always.
  `tests/test_migration_schema.py` cannot catch a clash, since it counts
  revisions as a set.
- **`packages/agent-connector/src/adapters/claude.js`.** Execute mode here
  runs inside Claude Code's permission checks and sandbox unless the
  computer's policy.json opts the agent out; upstream skips the checks.
  Keep that posture when upstream changes the permission flags, and run
  `node --test test/*.test.js` in `packages/agent-connector`.
