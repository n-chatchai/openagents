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


# Erawan OPS, the operators' agent, comes in the same way (bring your own
# bot): an operator makes a key on the ops page and pastes it here. Its key
# says it is OPS, and its runs go to the platform's own door for it, which
# answers only a room of operators (control plane ops_agent.py).
OPS_KEY_PREFIX = "eops_"
_OPS_LABEL = "Erawan OPS"


def _root() -> str:
    gateway = os.environ.get("CHANGBOT_GATEWAY_URL", "https://changbot.erawan.cloud").rstrip("/")
    return f"{gateway}/v1/agent"


def _ops_root() -> str:
    base = os.environ.get("ERAWAN_OPS_WORKSPACE_URL",
                          "http://erawan-api.erawan.svc.cluster.local:9001/internal/ops/workspace")
    return f"{base.rstrip('/')}/v1"


def is_ops_key(token: Optional[str]) -> bool:
    return bool(token) and str(token).startswith(OPS_KEY_PREFIX)


def target_for(token: str) -> RunTarget:
    """Where this connection's runs go: the Pixel Bot gateway, or Erawan OPS's door."""
    if is_ops_key(token):
        return RunTarget(root=_ops_root(), api_key=token, label=_OPS_LABEL, session_in_body=True,
                         approvals="owner", own_errors=True, room_facts=True)
    return RunTarget(root=_root(), api_key=token, label=_LABEL, session_in_body=True,
                     approvals="owner", own_errors=True, room_facts=True)


async def invoke_changbot_agent(db, workspace_id: str, event_data: dict, cloud_config, depth: int) -> None:
    """Run the addressed Chang Bot (or Erawan OPS) on the trigger message and post its answer."""
    await invoke_run_agent(db, workspace_id, event_data, cloud_config, depth, target_for(cloud_config.api_key))


async def probe(token: str) -> Optional[str]:
    """None when the gateway (or OPS's door) takes this connection token, else why not."""
    target = target_for(token)
    return await probe_root(target.root, token, target.label, credential="connection token")
