"""Erawan Builder's door: Erawan's control plane opens a website job's thread.

Erawan Builder (Erawan's own platform, erawan/src/erawan/builder.py there)
talks with a customer until their site's brief is right; when they confirm
it, the job becomes a thread here, where the team hands it to Claude Code on
a Mac. Nothing else in this API lets a machine open a thread — every other
way is a person, or an agent answering in a thread it was already in — so
this door does exactly two things, for one workspace, with one key:

  POST /v1/erawan/builder/jobs            {"job": 12, "title": "...", "text": "..."}
       → {"channel": "channel/<name>"}    a thread opened for ERAWAN_BUILDER_OWNER,
                                           with ERAWAN_BUILDER_THREAD_AGENTS in it,
                                           the brief posted by ERAWAN_BUILDER_AGENT
  POST /v1/erawan/builder/jobs/messages   {"channel": "channel/<name>", "text": "..."}
       → {}                               one more line in that thread, by the same agent

The thread is opened the way Yumi opens one (app/services/yumi.py): through
this API, as the owner — so it is theirs, with the access a thread they made
by hand would have. The lines are posted the way a cloud agent's answer is
(cloud_agent._post_response), as the agent, waking nobody: the team decides
who works it, by @mention. Both push to the phone as any message does.

Erawan's control plane also runs Erawan Builder in these threads; that is an
ordinary Hermes agent here (provider "hermes"), whose address is the control
plane's door for it. Nothing in this file is involved in that.
"""

from __future__ import annotations

import hmac
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import config
from app.database import get_db
from app.models import Channel, Workspace

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/erawan/builder", tags=["erawan-builder"])


class NewJob(BaseModel):
    job: int
    title: str = Field(min_length=1, max_length=160)
    text: str = Field(min_length=1, max_length=20000)


class JobLine(BaseModel):
    channel: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=20000)


def _key(authorization: Optional[str] = Header(None)) -> None:
    if not config.ERAWAN_BUILDER_KEY:
        raise HTTPException(404)
    scheme, _, presented = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        presented.encode("latin-1", "replace"), config.ERAWAN_BUILDER_KEY.encode()
    ):
        raise HTTPException(401, "bad key")


def _workspace(db: Session) -> Workspace:
    ref = config.ERAWAN_BUILDER_WORKSPACE
    ws = db.execute(select(Workspace).where(or_(Workspace.id == ref, Workspace.slug == ref))).scalar_one_or_none() \
        if ref else None
    if ws is None or not config.ERAWAN_BUILDER_OWNER:
        raise HTTPException(503, "Erawan Builder has no workspace or owner set here")
    return ws


async def _post(db: Session, ws: Workspace, channel: str, text: str) -> None:
    from app.services.cloud_agent import _post_response

    await _post_response(db, str(ws.id), channel, config.ERAWAN_BUILDER_AGENT, text, 0, explicit_targets=[])


@router.post("/jobs", dependencies=[Depends(_key)])
async def open_job(body: NewJob, db: Session = Depends(get_db)) -> dict:
    from app.services.yumi import WorkspaceApi

    ws = _workspace(db)
    agents = [a.strip() for a in config.ERAWAN_BUILDER_THREAD_AGENTS.split(",") if a.strip()]
    if config.ERAWAN_BUILDER_AGENT not in agents:
        agents.insert(0, config.ERAWAN_BUILDER_AGENT)
    api = WorkspaceApi(str(ws.id), config.ERAWAN_BUILDER_OWNER)
    made = await api.post("/v1/events", json={
        "type": "network.channel.create",
        "source": f"human:{config.ERAWAN_BUILDER_OWNER}",
        "target": "core",
        "payload": {"title": body.title, "participants": agents},
        "metadata": {"erawan_builder_job": body.job},
        "network": str(ws.id),
    })
    name = ((made.get("data") or {}).get("metadata") or {}).get("channel_name") if made.get("ok") else None
    if not name:
        logger.warning("erawan_builder: job %s: no thread (%s)", body.job, made.get("error"))
        raise HTTPException(502, f"the thread was not opened: {made.get('error') or 'no name'}")
    channel = f"channel/{name}"
    await _post(db, ws, channel, body.text)
    logger.info("erawan_builder: job %s opened %s", body.job, channel)
    return {"channel": channel}


@router.post("/jobs/messages", dependencies=[Depends(_key)])
async def job_line(body: JobLine, db: Session = Depends(get_db)) -> dict:
    ws = _workspace(db)
    if not body.channel.startswith("channel/"):
        raise HTTPException(422, "a thread: channel/<name>")
    name = body.channel[len("channel/"):]
    found = db.execute(select(Channel).where(Channel.workspace_id == ws.id, Channel.name == name)).scalar_one_or_none()
    if found is None:
        raise HTTPException(404, "no such thread")
    await _post(db, ws, body.channel, body.text)
    return {}
