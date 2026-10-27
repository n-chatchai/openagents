# -*- coding: utf-8 -*-
"""
Grok Bot: the MCP server its plugin reaches, and the setup steps around it.

POST /v1/mcp/grok                       MCP (streamable HTTP, stateless, JSON
                                        responses) for Grok Bot's plugin;
                                        x-workspace-key: <connection key>
GET  /v1/grokbot/{name}                 What the owner needs to set Grok Bot up:
                                        plugin URL, header and key, routine prompt
PUT  /v1/grokbot/{name}/routine         Save the routine's webhook URL and key,
                                        then wake it with a challenge
POST /v1/grokbot/{name}/test            Wake it with a challenge again

The MCP path is the one part of the API a door (oauth2-proxy) lets through
unsigned-in: the caller is Grok's servers, and the connection key is its
credential (app/services/grokbot_agent.py).
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import config
from app.database import get_db
from app.models import CloudAgentConfig, WorkspaceMember
from app.response import ResponseCode, json_response, success_response
from app.routers.network import _resolve_workspace, _verify_workspace_access
from app.services import grokbot_agent as grok
from app.services.hermes_agent import AgentRunError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["Grok Bot"])


# ---------------------------------------------------------------------------
# POST /v1/mcp/grok
# ---------------------------------------------------------------------------

def _origin_ok(request: Request) -> bool:
    # Grok's servers send no Origin. A browser does, and only this
    # workspace's own pages may make it call here.
    origin = request.headers.get("origin")
    if not origin:
        return True
    own = urlsplit(config.FRONTEND_BASE_URL)
    return origin.rstrip("/") == f"{own.scheme}://{own.netloc}"


@router.post("/mcp/grok")
async def grok_mcp(request: Request, db: Session = Depends(get_db)):
    if not _origin_ok(request):
        return JSONResponse({"error": "origin not allowed"}, status_code=403)
    key = request.headers.get(grok.KEY_HEADER) or request.headers.get("authorization")
    cfg = grok.resolve_key(db, key)
    if cfg is None:
        return JSONResponse({"error": "unknown or revoked workspace key"}, status_code=401)
    try:
        body = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError):
        return JSONResponse(grok._rpc_error(None, -32700, "Parse error"), status_code=400)
    grok.touch_contact(db, cfg)
    if isinstance(body, list):
        replies = [r for r in [await grok.handle_mcp_message(db, cfg, m) for m in body] if r is not None]
        return JSONResponse(replies) if replies else Response(status_code=202)
    reply = await grok.handle_mcp_message(db, cfg, body)
    if reply is None:
        return Response(status_code=202)
    return JSONResponse(reply)


@router.get("/mcp/grok")
async def grok_mcp_stream():
    # Stateless server: no event stream to open.
    return Response(status_code=405, headers={"Allow": "POST"})


# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

def _owned_grokbot(db: Session, network: str, agent_name: str,
                   token: Optional[str], authorization: Optional[str]):
    """(workspace, cfg, member) for the caller's own Grok Bot, or an error response."""
    workspace = _resolve_workspace(db, network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")
    cfg = db.execute(
        select(CloudAgentConfig).where(
            CloudAgentConfig.workspace_id == str(workspace.id),
            CloudAgentConfig.agent_name == agent_name,
            CloudAgentConfig.provider == grok.GROKBOT_PROVIDER,
        )
    ).scalar_one_or_none()
    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == str(workspace.id),
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()
    if cfg is None or member is None or member.status == "removed":
        return json_response(ResponseCode.NOT_FOUND, f"No Grok Bot named '{agent_name}' here")
    # The connection key acts as the agent in every thread: a signed-in
    # caller must be the person who added it, or the workspace's creator. A
    # caller with no identity got this far on the workspace token, which
    # already administers everything here.
    from app.access import resolve_current_user
    caller = resolve_current_user(db, authorization)
    if caller is not None:
        email = (caller.email or "").lower()
        allowed = {(member.owner_email or "").lower(), (workspace.creator_email or "").lower()} - {""}
        if allowed and email not in allowed:
            return json_response(ResponseCode.FORBIDDEN, "Only this Grok Bot's owner can set it up")
    return workspace, cfg, member


def _setup(workspace, cfg, member) -> dict:
    return {
        "agentName": cfg.agent_name,
        "pluginName": grok.PLUGIN_NAME,
        "mcpUrl": f"{config.PUBLIC_API_BASE.rstrip('/')}{grok.MCP_PATH}",
        "headerName": grok.KEY_HEADER,
        "connectionKey": grok.connection_key(cfg),
        "routineName": f"{grok.PLUGIN_NAME} — {workspace.name}",
        "routinePrompt": grok.routine_prompt(workspace.name or "workspace", cfg.agent_name),
        "webhookSet": bool((cfg.base_url or "").strip() and (cfg.api_key or "").strip()),
        "lastContactAt": member.last_heartbeat.isoformat() if member.last_heartbeat else None,
    }


@router.get("/grokbot/{agent_name}")
def grokbot_setup(
    agent_name: str,
    network: str = Query(...),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    found = _owned_grokbot(db, network, agent_name, x_workspace_token, authorization)
    if not isinstance(found, tuple):
        return found
    return success_response(_setup(*found))


class RoutineRequest(BaseModel):
    network: str
    webhook_url: str
    webhook_key: str


class TestRequest(BaseModel):
    network: str


def _test(db: Session, workspace, cfg, member):
    sent_at = datetime.now(timezone.utc)
    problem = None
    try:
        asyncio.run(grok.send_verify(cfg))
    except AgentRunError as exc:
        problem = str(exc)
    logger.info("grokbot: verify wake for %s in %s: %s", cfg.agent_name, workspace.id, problem or "sent")
    return success_response({
        **_setup(workspace, cfg, member),
        "testSentAt": sent_at.isoformat(),
        "testProblem": problem,
    })


@router.put("/grokbot/{agent_name}/routine")
def grokbot_routine(
    agent_name: str,
    body: RoutineRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    found = _owned_grokbot(db, body.network, agent_name, x_workspace_token, authorization)
    if not isinstance(found, tuple):
        return found
    problem = grok.check_webhook_url(body.webhook_url) or grok.check_webhook_key(body.webhook_key)
    if problem:
        return json_response(ResponseCode.BAD_REQUEST, problem)
    workspace, cfg, member = found
    cfg.base_url = body.webhook_url.strip()
    cfg.api_key = body.webhook_key.strip()
    db.commit()
    return _test(db, workspace, cfg, member)


@router.post("/grokbot/{agent_name}/test")
def grokbot_test(
    agent_name: str,
    body: TestRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    found = _owned_grokbot(db, body.network, agent_name, x_workspace_token, authorization)
    if not isinstance(found, tuple):
        return found
    return _test(db, *found)
