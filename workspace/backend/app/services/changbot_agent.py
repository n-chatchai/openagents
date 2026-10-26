# -*- coding: utf-8 -*-
"""
Chang Bot as a workspace agent: somebody's own bot, through Erawan's gateway.

Chang Bot (an Erawan Solution) is one person's Hermes Agent in a home of its
own on Erawan Cloud. Its owner makes a connection token in the Chang Bot app
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

_LABEL = "Chang Bot"


def _root() -> str:
    gateway = os.environ.get("CHANGBOT_GATEWAY_URL", "https://changbot.erawan.cloud").rstrip("/")
    return f"{gateway}/v1/agent"


async def invoke_changbot_agent(db, workspace_id: str, event_data: dict, cloud_config, depth: int) -> None:
    """Run the addressed Chang Bot on the trigger message and post its answer."""
    target = RunTarget(root=_root(), api_key=cloud_config.api_key, label=_LABEL,
                       session_in_body=True, approvals="owner")
    await invoke_run_agent(db, workspace_id, event_data, cloud_config, depth, target)


async def probe(token: str) -> Optional[str]:
    """None when the gateway takes this connection token, else why not."""
    return await probe_root(_root(), token, _LABEL, credential="connection token")
