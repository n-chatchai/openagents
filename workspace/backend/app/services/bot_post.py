# -*- coding: utf-8 -*-
"""
A new message from a bot that reaches us over MCP (Grok Bot, ChatGPT dots),
in a room it is in, without waiting to be called. Pace6 issue #7: golf, asked
in ChatGPT to post a report in #Bug Report, could not, because
workspace_post_reply answers one wake, once, in the thread that woke it.

The connection key says whose bots these are; the bot is named (or is the
person's only one of its kind), and the room must have it as a participant,
exactly as a person must be in a room to write there. A key the bot sends with
the post makes a retry land once: a second post with the same key in the same
room within a day is reported as already posted, not posted again.

A new post wakes only the bots it @-names; the router does not pick one, so
a bot's report does not set the room's other bots talking.
"""

import re
import time
from typing import Optional

from sqlalchemy import select

from app.models import Channel, ChannelMember, EventRecord

TOOLS = [
    {
        "name": "workspace_list_rooms",
        "description": "The rooms of the team you are in, by title and name: the rooms workspace_post_message can post in.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bot": {"type": "string", "description": "Your @name in the team. Optional when the person has one bot of your kind."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "workspace_post_message",
        "description": (
            "Post a new message, under your name, in a room you are in, when the person asked you to (a report, "
            "a summary, a heads-up). To answer a message that called you, use workspace_post_reply instead. "
            "Send the same key again if you retry, so the message is posted once."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "bot": {"type": "string", "description": "Your @name in the team. Optional when the person has one bot of your kind."},
                "room": {"type": "string", "description": "The room's title (\"Bug Report\" or \"#Bug Report\") or name, from workspace_list_rooms."},
                "text": {"type": "string", "description": "The message, in Markdown. @name a bot or person to call them."},
                "key": {"type": "string", "description": "Any id you choose for this one message; the same key again is not posted twice."},
            },
            "required": ["room", "text"],
            "additionalProperties": False,
        },
    },
]

NAMES = {t["name"] for t in TOOLS}

_KEY_WINDOW_MS = 24 * 3600 * 1000
_KEY_MAX = 200


def _text(text: str, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": error}


def _bot(db, link, provider: str, name) -> tuple[Optional[object], Optional[str]]:
    from app.services import grokbot_agent as grok

    bots = grok.agents_of(db, link, provider)
    if not bots:
        return None, "You have no bot of this kind in the team."
    wanted = (name or "").strip().lstrip("@").lower() if isinstance(name, str) else ""
    if wanted:
        for cfg in bots:
            if cfg.agent_name.lower() == wanted:
                return cfg, None
        return None, f"No bot of yours is called @{wanted}. Yours: " + ", ".join("@" + b.agent_name for b in bots) + "."
    if len(bots) == 1:
        return bots[0], None
    return None, "Name the bot: " + ", ".join("@" + b.agent_name for b in bots) + "."


def _rooms(db, cfg) -> list:
    return list(db.execute(
        select(Channel)
        .join(ChannelMember, ChannelMember.channel_id == Channel.id)
        .where(
            Channel.workspace_id == cfg.workspace_id,
            ChannelMember.agent_name == cfg.agent_name,
            Channel.status == "active",
        )
        .order_by(Channel.created_at)
    ).scalars().all())


def _label(channel) -> str:
    return f"#{channel.title} ({channel.name})" if channel.title else f"#{channel.name}"


def _room(rooms: list, wanted) -> tuple[Optional[object], Optional[str]]:
    wanted = (wanted or "").strip() if isinstance(wanted, str) else ""
    wanted = wanted.removeprefix("channel/").lstrip("#").strip()
    if not wanted:
        return None, "Name the room."
    by_name = [c for c in rooms if c.name == wanted]
    if by_name:
        return by_name[0], None
    by_title = [c for c in rooms if (c.title or "").strip().lower() == wanted.lower()]
    if len(by_title) == 1:
        return by_title[0], None
    if len(by_title) > 1:
        return None, "More than one room has that title; name one: " + ", ".join(c.name for c in by_title) + "."
    known = ", ".join(_label(c) for c in rooms) or "none"
    return None, f"You are not in a room called {wanted}. Your rooms: {known}."


def _posted_before(db, cfg, target: str, key: str) -> bool:
    since = int(time.time() * 1000) - _KEY_WINDOW_MS
    rows = db.execute(
        select(EventRecord.metadata_).where(
            EventRecord.network_id == cfg.workspace_id,
            EventRecord.type == "workspace.message.posted",
            EventRecord.source == f"openagents:{cfg.agent_name}",
            EventRecord.target == target,
            EventRecord.timestamp >= since,
        ).order_by(EventRecord.timestamp.desc()).limit(500)
    ).scalars().all()
    return any((m or {}).get("post_key") == key for m in rows)


def called_room_bots(db, channel, bot: str, text: str) -> list:
    # Exact handles only, outside code and quotes (as in routers/issues.py).
    prose = re.sub(r"```[\s\S]*?```|`[^`\n]*`|(?m:^>.*$)", "", text)
    members = db.execute(
        select(ChannelMember.agent_name).where(ChannelMember.channel_id == channel.id)
    ).scalars().all()
    return [n for n in members if n != bot
            and re.search(r"(?<![\w@])@" + re.escape(n) + r"(?![\w@-]|\.[\w-])", prose)]


async def call(db, name: str, link, provider: str, args: dict) -> dict:
    from app.services import grokbot_agent as grok
    from app.services.cloud_agent import _post_response

    cfg, problem = _bot(db, link, provider, args.get("bot"))
    if cfg is None:
        return _text(problem, error=True)
    rooms = _rooms(db, cfg)
    if name == "workspace_list_rooms":
        if not rooms:
            return _text("You are in no room yet. Someone in the team adds you to one.")
        return _text("Your rooms:\n" + "\n".join("- " + _label(c) for c in rooms))

    channel, problem = _room(rooms, args.get("room"))
    if channel is None:
        return _text(problem, error=True)
    text = args.get("text")
    text = text.strip() if isinstance(text, str) else ""
    if not text:
        return _text("Nothing to post: text is empty.", error=True)
    if len(text) > grok._REPLY_CHARS:
        text = text[:grok._REPLY_CHARS] + "\n\n(cut at 16,000 characters)"
    key = args.get("key")
    key = key.strip()[:_KEY_MAX] if isinstance(key, str) else ""
    target = f"channel/{channel.name}"
    if key and _posted_before(db, cfg, target, key):
        return _text(f"Already posted in {_label(channel)} with this key; not posted again.")

    await _post_response(
        db, cfg.workspace_id, target, cfg.agent_name, text, 0,
        explicit_targets=called_room_bots(db, channel, cfg.agent_name, text),
        dispatch_room_mentions=True,
        extra_metadata={"post_key": key} if key else None,
    )
    grok.touch_contact(db, cfg)
    return _text(f"Posted in {_label(channel)}.")
