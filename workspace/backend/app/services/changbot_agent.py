# -*- coding: utf-8 -*-
"""
Pixel Bot as a workspace agent: somebody's own bot, through Erawan's gateway.
(The provider id is still "changbot", its name before 2026-11-05.)

Pixel Bot (an Erawan Solution) is one person's Hermes Agent in a home of its
own on Erawan Cloud. Its owner makes a connection token in the Pixel Bot app
and pastes it into Connect Agent; the workspace never sees the home's address
or key. The gateway speaks Hermes' runs protocol under its own root and
forwards each run to that person's home:

  GET  {gateway}/v1/agent/capabilities
  POST {gateway}/v1/agent/runs            {"input", "session_key"}
  GET  {gateway}/v1/agent/runs/{id}/events
  GET  {gateway}/v1/agent/runs/{id}
  POST {gateway}/v1/agent/runs/{id}/stop

Approvals stay with the owner: the gateway raises them as a card on the
owner's phone, so the room never answers one, it only waits. The runner is
Hermes' (app/services/hermes_agent.py).
"""

import os
from typing import Optional

from app.services.hermes_agent import RunTarget, invoke_run_agent, probe_root

CHANGBOT_PROVIDER = "changbot"

_LABEL = "Pixel Bot"


# Erawan OPS, the operators' agent, is a bot of its own (provider
# "erawanops", bring your own bot): an operator makes a key on the ops page
# and pastes it into the Erawan OPS card; its runs go to the platform's own
# door for it, which answers only a room of operators (control plane
# ops_agent.py). Same runs protocol as Pixel Bot, so the same runner.
ERAWANOPS_PROVIDER = "erawanops"
OPS_KEY_PREFIX = "eops_"
_OPS_LABEL = "Erawan OPS"


def _root() -> str:
    gateway = os.environ.get("CHANGBOT_GATEWAY_URL", "https://changbot.erawan.cloud").rstrip("/")
    return f"{gateway}/v1/agent"


def _ops_root() -> str:
    # Erawan's public API: this Workspace runs as an app on Erawan Cloud, which
    # cannot reach Erawan's in-cluster port (2026-11-28).
    base = os.environ.get("ERAWAN_OPS_WORKSPACE_URL", "https://api.erawan.cloud/v1/ops/workspace")
    return f"{base.rstrip('/')}/v1"


def is_ops_key(token: Optional[str]) -> bool:
    return bool(token) and str(token).startswith(OPS_KEY_PREFIX)


def _pixelbot_target(token: str) -> RunTarget:
    return RunTarget(root=_root(), api_key=token, label=_LABEL, session_in_body=True,
                     approvals="owner", own_errors=True, room_facts=True, issue_tool=True)


def _ops_target(token: str) -> RunTarget:
    return RunTarget(root=_ops_root(), api_key=token, label=_OPS_LABEL, session_in_body=True,
                     approvals="owner", own_errors=True, room_facts=True)


async def invoke_changbot_agent(db, workspace_id: str, event_data: dict, cloud_config, depth: int) -> None:
    """Run the addressed Pixel Bot on the trigger message and post its answer."""
    await invoke_run_agent(db, workspace_id, event_data, cloud_config, depth, _pixelbot_target(cloud_config.api_key))


async def invoke_erawanops_agent(db, workspace_id: str, event_data: dict, cloud_config, depth: int) -> None:
    """Run Erawan OPS on the trigger message; the platform decides whether this room may have an answer."""
    await invoke_run_agent(db, workspace_id, event_data, cloud_config, depth, _ops_target(cloud_config.api_key))


async def probe(token: str) -> Optional[str]:
    """None when the gateway takes this Pixel Bot connection token, else why not."""
    if is_ops_key(token):
        return "this is an Erawan OPS key: add it with the Erawan OPS card instead"
    return await probe_root(_root(), token, _LABEL, credential="connection token")


async def probe_ops(token: str) -> Optional[str]:
    """None when the platform's door for Erawan OPS takes this key, else why not."""
    if not is_ops_key(token):
        return "an Erawan OPS key starts with eops_ (made on the ops page: Erawan OPS in rooms)"
    return await probe_root(_ops_root(), token, _OPS_LABEL, credential="key")
