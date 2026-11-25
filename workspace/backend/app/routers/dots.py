# -*- coding: utf-8 -*-
"""
ChatGPT dots: the MCP server their plugin reaches, and the setup around it.

POST /v1/mcp/dots/{key}        MCP (streamable HTTP, stateless, JSON responses)
                               with MCP Events, for the dot's plugin. The key
                               is in the path: ChatGPT's plugin form has no
                               header field.
GET  /v1/dots/{name}           What the owner needs: plugin URL, the message
                               that subscribes the dot, whether it has
POST /v1/dots/{name}/test      Send the dot a challenge it must hand back

/v1/ passes the door unsigned-in (infra/manifests/openagents.yaml): the caller
is ChatGPT's servers, and the connection key is its credential
(app/services/dots_agent.py).
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import CloudAgentConfig
from app.response import ResponseCode, json_response, success_response
from app.routers.grokbot import _member, _origin_ok
from app.routers.network import _resolve_workspace, _verify_workspace_access
from app.services import dots_agent as dots
from app.services.grokbot_agent import _rpc_error
from app.services.hermes_agent import AgentRunError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["ChatGPT dots"])


@router.post("/mcp/dots/{key}")
async def dots_mcp(key: str, request: Request, db: Session = Depends(get_db)):
    if not _origin_ok(request):
        return JSONResponse({"error": "origin not allowed"}, status_code=403)
    link = dots.resolve_key(db, key)
    if link is None:
        return JSONResponse({"error": "unknown or revoked workspace key"}, status_code=401)
    try:
        body = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError):
        return JSONResponse(_rpc_error(None, -32700, "Parse error"), status_code=400)
    if isinstance(body, list):
        replies = [r for r in [await dots.handle_mcp_message(db, link, m) for m in body] if r is not None]
        return JSONResponse(replies) if replies else Response(status_code=202)
    reply = await dots.handle_mcp_message(db, link, body)
    if reply is None:
        return Response(status_code=202)
    return JSONResponse(reply)


@router.get("/mcp/dots/{key}")
async def dots_mcp_stream(key: str):
    # Stateless server: no event stream to open.
    return Response(status_code=405, headers={"Allow": "POST"})


def _owned_dot(db: Session, network: str, agent_name: str,
               token: Optional[str], authorization: Optional[str]):
    """(workspace, cfg, member) for the caller's own dot, or an error response."""
    workspace = _resolve_workspace(db, network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")
    cfg = db.execute(
        select(CloudAgentConfig).where(
            CloudAgentConfig.workspace_id == str(workspace.id),
            CloudAgentConfig.agent_name == agent_name,
            CloudAgentConfig.provider == dots.DOTS_PROVIDER,
        )
    ).scalar_one_or_none()
    member = _member(db, workspace, agent_name)
    if cfg is None or member is None or member.status == "removed":
        return json_response(ResponseCode.NOT_FOUND, f"No dot named '{agent_name}' here")
    # The connection key acts as the dot in every thread: only the person who
    # added it, or the workspace's creator, may see it.
    from app.access import resolve_current_user
    caller = resolve_current_user(db, authorization)
    if caller is not None:
        email = (caller.email or "").lower()
        allowed = {(member.owner_email or "").lower(), (workspace.creator_email or "").lower()} - {""}
        if allowed and email not in allowed:
            return json_response(ResponseCode.FORBIDDEN, "Only this dot's owner can set it up")
    return workspace, cfg, member


def _setup(workspace, cfg, member) -> dict:
    key = dots.connection_key(str(workspace.id), member.owner_email)
    sub = dots.subscription(cfg)
    until = sub["until"] if sub else None
    return {
        "agentName": cfg.agent_name,
        "pluginName": dots.PLUGIN_NAME,
        "pluginUrl": dots.plugin_url(key),
        "subscribePrompt": dots.subscribe_prompt(cfg.agent_name),
        "subscribed": sub is not None,
        "subscribedUntil": datetime.fromtimestamp(until, timezone.utc).isoformat() if until else None,
        "lastContactAt": member.last_heartbeat.isoformat() if member.last_heartbeat else None,
    }


@router.get("/dots/{agent_name}")
def dots_setup(
    agent_name: str,
    network: str = Query(...),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    found = _owned_dot(db, network, agent_name, x_workspace_token, authorization)
    if not isinstance(found, tuple):
        return found
    return success_response(_setup(*found))


class TestRequest(BaseModel):
    network: str


@router.post("/dots/{agent_name}/test")
def dots_test(
    agent_name: str,
    body: TestRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    found = _owned_dot(db, body.network, agent_name, x_workspace_token, authorization)
    if not isinstance(found, tuple):
        return found
    workspace, cfg, member = found
    sent_at = datetime.now(timezone.utc)
    try:
        asyncio.run(dots.send_verify(db, cfg))
    except AgentRunError as exc:
        return json_response(ResponseCode.BAD_REQUEST, str(exc))
    logger.info("dots: verify sent to %s in %s", cfg.agent_name, workspace.id)
    return success_response({**_setup(workspace, cfg, member), "testSentAt": sent_at.isoformat()})
