# -*- coding: utf-8 -*-
"""
The workspace's tools for bots that call no MCP server of ours.

POST /v1/bot-tools                    {reference, tool, args}: a run of Hermes or
                                      Pixel Bot, with the reference its input
                                      carried (services/bot_issues.py)
POST /v1/bot-tools/agent?network=     {agent_name, channel, requester, tool, args}:
                                      an agent through the connector, with its
                                      machine token (X-Workspace-Token)

Both answer {ok, text}: the text is what the bot reads back. The tools are the
issue tools Grok Bot and ChatGPT dots have over MCP.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Node, WorkspaceMember
from app.response import success_response
from app.routers.network import _resolve_workspace, _verify_workspace_access
from app.services import bot_issues

router = APIRouter(prefix="/v1", tags=["Bot tools"])


class RunCall(BaseModel):
    reference: str = Field(max_length=2000)
    tool: str = Field(max_length=64)
    args: dict = Field(default_factory=dict)


class AgentCall(BaseModel):
    agent_name: str = Field(max_length=200)
    channel: str = Field(max_length=200)
    # The person whose message the agent is answering: "asker" gives them the issue.
    requester: Optional[str] = Field(default=None, max_length=320)
    tool: str = Field(max_length=64)
    args: dict = Field(default_factory=dict)


def _answer(result: dict) -> dict:
    return success_response({"ok": not result.get("isError"), "text": result["content"][0]["text"]})


@router.post("/bot-tools")
def run_tool(body: RunCall, db: Session = Depends(get_db)):
    return _answer(bot_issues.call_with_reference(db, body.reference, body.tool, body.args))


@router.post("/bot-tools/agent")
def agent_tool(
    body: AgentCall,
    network: str = Query(...),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
):
    workspace = _resolve_workspace(db, network)
    # A machine credential only: a person opens issues through /v1/issues.
    if workspace is None or not x_workspace_token or not _verify_workspace_access(workspace, x_workspace_token, None):
        raise HTTPException(403, "A workspace or node token is needed")
    member = db.get(WorkspaceMember, (str(workspace.id), body.agent_name))
    if member is None or member.status == "removed":
        raise HTTPException(404, "No such agent in this workspace")
    node = db.execute(select(Node).where(Node.token == x_workspace_token, Node.workspace_id == workspace.id)).scalar_one_or_none()
    if node is not None and str(member.node_id or "") != str(node.id):
        raise HTTPException(403, "This computer does not run that agent")
    if body.tool == "workspace_list_boards":
        return _answer(bot_issues._text(bot_issues.list_boards(db, workspace.id)))
    requester = (body.requester or "").strip().lower()
    asker = f"human:{requester}" if "@" in requester else ""
    if body.tool == "workspace_list_issues":
        return _answer(bot_issues.list_issues(db, workspace.id, body.args, asker))
    if body.tool != "workspace_create_issue":
        raise HTTPException(422, "Unknown tool")
    channel = body.channel.removeprefix("channel/")
    return _answer(bot_issues.create_issue(db, workspace.id, body.agent_name, f"channel/{channel}", body.args, asker))
