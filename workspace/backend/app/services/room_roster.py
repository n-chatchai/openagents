# -*- coding: utf-8 -*-
"""
Who is in the room, said to a bot each time it is called.

A bot from elsewhere (Pixel Bot, Hermes, Grok Bot) only ever saw the
transcript: the names of whoever had spoken lately, nothing about who owns
it, who else is in the thread, or whether the person calling it is its owner.
In a team chat where everyone brings their own bot that is the first thing a
bot needs: its owner's word is an instruction, a teammate's is a request.

``room_note`` returns a short block for the run's input:

    Who is in this room (#sales):
    People: Somchai (your owner), Somying
    Bots: Nok (you, owned by Somchai), Grok (owned by Somying)
    This message is from Somying, a teammate, not your owner.

Names only, never email addresses: the block goes to services the team does
not run (xAI, somebody's own Hermes), and a name is all a bot needs to tell
people apart. Who sent the message is believed only when the server stamped
it (``acting_for`` is written for a signed-in sender and dropped from what a
client sends); otherwise the note says the sender is not known.
"""

from typing import Optional

from sqlalchemy import select

_MAX_PEOPLE = 30
_MAX_BOTS = 20


def _norm(email) -> str:
    return (email or "").strip().lower() if isinstance(email, str) else ""


def _flat(name: str) -> str:
    """One short run of text: no line breaks or brackets to fake transcript lines."""
    import re

    return re.sub(r"[\s\[\]()]+", " ", name or "").strip()[:40]


def _people_names(db, emails) -> dict:
    from app.models import User

    emails = [e for e in emails if e]
    if not emails:
        return {}
    rows = db.execute(select(User.email, User.display_name).where(User.email.in_(emails))).all()
    names = {_norm(e): _flat(n or "") for e, n in rows}
    return {e: names.get(e) or _flat(e.split("@", 1)[0]) or "someone" for e in emails}


def _room_people(db, workspace_id: str, channel, limit: Optional[int] = _MAX_PEOPLE) -> list:
    """Emails of the people who can read the thread, owner first."""
    from app.models import User, WorkspaceMembership
    from app.services.access_model import channel_participant_emails

    owner = _norm(channel.owner_email)
    if (channel.visibility or "public") == "public":
        emails = db.execute(
            select(User.email)
            .join(WorkspaceMembership, WorkspaceMembership.user_id == User.id)
            .where(WorkspaceMembership.workspace_id == workspace_id)
        ).scalars().all()
    else:
        emails = list(channel_participant_emails(db, channel))
    ordered = ([owner] if owner else []) + sorted({_norm(e) for e in emails} - {owner, ""})
    return ordered if limit is None else ordered[:limit]


def _channel(db, workspace_id: str, channel_target: str):
    from app.models import Channel

    name = channel_target[len("channel/"):] if channel_target.startswith("channel/") else channel_target
    if not name:
        return None
    return db.execute(
        select(Channel).where(Channel.workspace_id == workspace_id, Channel.name == name)
    ).scalar_one_or_none()


def verified_sender(source: Optional[str], metadata: Optional[dict]) -> Optional[str]:
    """The sender's email when the server vouches for it, else None."""
    source = source or ""
    if not source.startswith("human:"):
        return None
    email = _norm(source[len("human:"):])
    stamped = _norm((metadata or {}).get("acting_for"))
    return email if email and "@" in email and email == stamped else None


def room_note(db, workspace_id: str, channel_target: str, agent_name: str,
              source: Optional[str], metadata: Optional[dict]) -> str:
    """The block above, or '' outside a thread (a DM) or when nothing is known."""
    from app.models import ChannelMember, WorkspaceMember

    channel = _channel(db, str(workspace_id), channel_target or "")
    if channel is None:
        return ""

    bots = db.execute(
        select(WorkspaceMember)
        .join(ChannelMember, ChannelMember.agent_name == WorkspaceMember.agent_name)
        .where(
            ChannelMember.channel_id == channel.id,
            WorkspaceMember.workspace_id == str(workspace_id),
        )
    ).scalars().all()
    bots = [b for b in bots if (b.status or "") != "removed"]
    me = db.get(WorkspaceMember, (str(workspace_id), agent_name))
    if me is not None and all(b.agent_name != agent_name for b in bots):
        bots.insert(0, me)
    bots = bots[:_MAX_BOTS]

    my_owner = _norm(me.owner_email) if me is not None else ""
    people = _room_people(db, str(workspace_id), channel)
    sender = verified_sender(source, metadata)
    names = _people_names(db, set(people) | {_norm(b.owner_email) for b in bots} | {my_owner, sender or ""})

    def person(email: str) -> str:
        label = names.get(email) or "someone"
        return f"{label} (your owner)" if email and email == my_owner else label

    def bot(b) -> str:
        label = _flat(b.display_name or "") or b.agent_name
        notes = []
        if b.agent_name == agent_name:
            notes.append("you")
        owner = _norm(b.owner_email)
        if owner:
            notes.append(f"owned by {names.get(owner) or 'someone'}")
        return f"{label} ({', '.join(notes)})" if notes else label

    title = _flat(channel.title or "") or channel.name
    lines = [f"Who is in this room (#{title}):"]
    if people:
        lines.append("People: " + ", ".join(person(e) for e in people))
    if bots:
        lines.append("Bots: " + ", ".join(bot(b) for b in bots))

    if (source or "").startswith("openagents:"):
        caller = (source or "")[len("openagents:"):]
        other = next((b for b in bots if b.agent_name == caller), None)
        lines.append(f"This message is from the bot {bot(other) if other else caller}.")
    elif sender and my_owner and sender == my_owner:
        lines.append(f"This message is from {names.get(sender)}, your owner.")
    elif sender and my_owner:
        lines.append(f"This message is from {names.get(sender)}, a teammate, not your owner.")
    elif sender:
        lines.append(f"This message is from {names.get(sender)}.")
    else:
        lines.append("Who sent this message is not verified.")
    return "\n".join(lines)


def safe_room_note(db, workspace_id, channel_target, agent_name, source, metadata) -> str:
    """room_note, or '' if it fails: the roster never stops a bot from answering."""
    import logging

    try:
        return room_note(db, str(workspace_id), channel_target or "", agent_name, source, metadata)
    except Exception as e:  # pragma: no cover - defensive
        logging.getLogger(__name__).warning("room_roster: no note for %s: %s", agent_name, e)
        try:
            db.rollback()
        except Exception:
            pass
        return ""


def room_facts(db, workspace_id: str, channel_target: str, agent_name: str,
               source: Optional[str], metadata: Optional[dict]) -> Optional[dict]:
    """The room as data, for a bot reached through Erawan's own platform.

    Unlike the note, this carries addresses: it goes to Erawan's platform (the
    Pixel Bot gateway, Erawan OPS), never to a third party, so the bot's side
    can decide by who is really there — Erawan OPS answers only a room of
    operators. The asker is set only when the server stamped the sender.
    None outside a thread.
    """
    from app.models import WorkspaceMember

    channel = _channel(db, str(workspace_id), channel_target or "")
    if channel is None:
        return None
    me = db.get(WorkspaceMember, (str(workspace_id), agent_name))
    asking_bot = (source or "")[len("openagents:"):] if (source or "").startswith("openagents:") else None
    return {
        "workspace": str(workspace_id),
        "room": channel.name,
        "requester_email": verified_sender(source, metadata),
        "requester_bot": asking_bot,
        "people": _room_people(db, str(workspace_id), channel, limit=None),
        "owner_email": _norm(me.owner_email) if me is not None else None,
        # Names as people see them, so the bot's side can show its owner which
        # room a conversation is and what the bot is called here (Pixel Bot's
        # page for the bot). Never used to decide anything.
        "room_title": _flat(channel.title or "") or channel.name,
        "agent_display": (_flat(me.display_name or "") if me is not None else "") or agent_name,
    }


def safe_room_facts(db, workspace_id, channel_target, agent_name, source, metadata) -> Optional[dict]:
    """room_facts, or None if it fails; the bot's side then refuses what it must."""
    import logging

    try:
        return room_facts(db, str(workspace_id), channel_target or "", agent_name, source, metadata)
    except Exception as e:  # pragma: no cover - defensive
        logging.getLogger(__name__).warning("room_roster: no facts for %s: %s", agent_name, e)
        try:
            db.rollback()
        except Exception:
            pass
        return None
