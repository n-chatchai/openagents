# -*- coding: utf-8 -*-
"""
A bot the workspace runs is "working" in a room while its run is open there.

Agents through the connector say so themselves in their heartbeat
(presence_state, busy_channels; mods/workspace_mod.py). Bots the workspace
runs (Pixel Bot, Hermes, Grok Bot, ChatGPT dots, API-key bots) have no
heartbeat, so the run marks it: the room joins the bot's busy_channels when
the run starts and leaves when it ends, however it ends, and presence_state is
"working" while any room is busy. Pixel Team shows "<bot> กำลังทำ…" from it
(founder, 2026-11-27: the app had no progress while a bot worked).

A server stopped mid-run leaves rooms marked: they are cleared at startup
(clear_cloud).
"""

import logging
from contextlib import asynccontextmanager

from sqlalchemy import select

from app.database import SessionLocal
from app.models import WorkspaceMember

logger = logging.getLogger(__name__)

_MAX = 50


def mark(workspace_id: str, agent_name: str, channel: str, busy: bool) -> None:
    """The room in or out of the bot's busy rooms; never raises."""
    if not channel:
        return
    db = SessionLocal()
    try:
        member = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == str(workspace_id),
                WorkspaceMember.agent_name == agent_name,
            ).with_for_update()
        ).scalar_one_or_none()
        if member is None:
            return
        rooms = [c for c in (member.busy_channels or []) if c != channel]
        if busy:
            rooms.append(channel)
        member.busy_channels = rooms[-_MAX:]
        member.presence_state = "working" if rooms else "idle"
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("bot_presence: could not mark %s in %s", agent_name, channel, exc_info=True)
    finally:
        db.close()


@asynccontextmanager
async def running(workspace_id: str, agent_name: str, channel_target: str):
    """Working in this room for as long as the block runs."""
    channel = (channel_target or "").removeprefix("channel/")
    mark(workspace_id, agent_name, channel, True)
    try:
        yield
    finally:
        mark(workspace_id, agent_name, channel, False)


def clear_cloud() -> None:
    """At startup: no run of a bot the workspace runs survives a restart."""
    db = SessionLocal()
    try:
        for member in db.execute(
            select(WorkspaceMember).where(WorkspaceMember.agent_type.like("cloud:%"))
        ).scalars():
            if member.busy_channels or member.presence_state == "working":
                member.busy_channels = []
                member.presence_state = "idle"
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("bot_presence: could not clear at startup", exc_info=True)
    finally:
        db.close()
