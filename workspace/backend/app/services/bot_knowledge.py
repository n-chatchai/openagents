# -*- coding: utf-8 -*-
"""
The workspace's knowledge base, read by the bots that reach us over MCP
(Grok Bot, ChatGPT dots): two tools, search and read, both read-only.

What a bot may read is what the access model says the bot itself may read
(app/services/access_model.py: explain), with one narrowing. A bot other
people can call (its owner granted it to the team's everyone group, a group,
people or other agents) reads only entries open to it on their own: public
ones, ones shared with the bot, and its own. It does not inherit its owner's
private entries, or anyone in the room could have the bot read them out. A
bot only its owner calls inherits the owner's access, as on the web.

Every call carries the wake's reference, so the tools only ever act as the
bot a wake was meant for, while the reference is fresh.
"""

from typing import Optional

from sqlalchemy import or_, select

from app.models import KnowledgeEntry
from app.services.access_model import Principal, agent_usable_by, explain, resource_for_knowledge
from app.storage import get_file_store

TOOLS = [
    {
        "name": "workspace_search_knowledge",
        "description": (
            "Search the team's knowledge base (shared documents) for what the message asks about. "
            "Returns the entries you may read: id, title, folder and the start of each."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "reference": {"type": "string", "description": "The wake payload's reference, exactly as received."},
                "query": {"type": "string", "description": "Words to look for; empty lists the most recent entries."},
            },
            "required": ["reference"],
            "additionalProperties": False,
        },
    },
    {
        "name": "workspace_read_knowledge",
        "description": "Read one knowledge base entry in full, by the id workspace_search_knowledge gave.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "reference": {"type": "string", "description": "The wake payload's reference, exactly as received."},
                "id": {"type": "string", "description": "The entry's id."},
            },
            "required": ["reference", "id"],
            "additionalProperties": False,
        },
    },
]
NAMES = {t["name"] for t in TOOLS}

_SHOWN = 10
_SCANNED = 200
_PREVIEW = 160
_MAX_READ = 60_000


def _content(entry: KnowledgeEntry) -> str:
    if not entry.storage_key:
        return ""
    try:
        return get_file_store().read(entry.storage_key).decode("utf-8", errors="replace")
    except (FileNotFoundError, OSError):
        return ""


def _reader(db, workspace_id: str, agent_name: str, owner_email: Optional[str]):
    """A check `entry -> may this bot read it`, with the narrowing above."""
    wid = str(workspace_id)
    bot = Principal("agent", agent_name=agent_name, owner_email=(owner_email or "").strip().lower() or None, workspace_id=wid)
    usable = agent_usable_by(db, wid, [agent_name]).get(agent_name) or {}
    shared = bool(usable.get("everyone") or usable.get("groups") or usable.get("people") or usable.get("agents"))

    def may_read(entry: KnowledgeEntry) -> bool:
        why = explain(db, bot, resource_for_knowledge(entry), "read", wid)
        return why.allowed and not (shared and why.reason == "inherited_from_owner")

    return may_read


def search(db, workspace_id: str, agent_name: str, owner_email: Optional[str], query) -> str:
    may_read = _reader(db, workspace_id, agent_name, owner_email)
    words = (query if isinstance(query, str) else "").strip()
    base = select(KnowledgeEntry).where(KnowledgeEntry.workspace_id == str(workspace_id), KnowledgeEntry.status == "active")
    rows = db.execute(base.order_by(KnowledgeEntry.updated_at.desc()).limit(_SCANNED)).scalars().all()
    found = []
    if words:
        like = f"%{words}%"
        named = db.execute(base.where(or_(
            KnowledgeEntry.title.ilike(like), KnowledgeEntry.description.ilike(like),
            KnowledgeEntry.folder_path.ilike(like), KnowledgeEntry.slug.ilike(like),
        )).limit(_SCANNED)).scalars().all()
        seen = set()
        for e in named:
            if may_read(e):
                found.append((e, None)); seen.add(e.id)
        # Then what the documents say, among the most recent ones.
        low = words.lower()
        for e in rows:
            if len(found) >= _SHOWN:
                break
            if e.id in seen or not may_read(e):
                continue
            text = _content(e)
            at = text.lower().find(low)
            if at >= 0:
                found.append((e, text[max(0, at - 60): at + _PREVIEW]))
    else:
        found = [(e, None) for e in rows if may_read(e)]
    found = found[:_SHOWN]
    if not found:
        return "Nothing in the knowledge base you may read matches that." if words else "The knowledge base has nothing you may read."
    lines = []
    for e, hit in found:
        preview = hit if hit is not None else (e.description or _content(e)[:_PREVIEW])
        preview = " ".join((preview or "").split())[:_PREVIEW]
        folder = f" · {e.folder_path}" if e.folder_path else ""
        lines.append(f"- id {e.id} · {e.title}{folder}\n  {preview}")
    return "\n".join(lines)


def read(db, workspace_id: str, agent_name: str, owner_email: Optional[str], entry_id) -> Optional[str]:
    """The entry as text, or None when it is not there or not the bot's to read."""
    if not isinstance(entry_id, str) or not entry_id.strip():
        return None
    e = db.execute(select(KnowledgeEntry).where(
        KnowledgeEntry.workspace_id == str(workspace_id), KnowledgeEntry.id == entry_id.strip(),
        KnowledgeEntry.status == "active",
    )).scalar_one_or_none()
    if e is None or not _reader(db, workspace_id, agent_name, owner_email)(e):
        return None
    text = _content(e)
    if len(text) > _MAX_READ:
        text = text[:_MAX_READ] + "\n\n[cut: the entry goes on]"
    head = f"# {e.title}\n" + (f"Folder: {e.folder_path}\n" if e.folder_path else "")
    return head + "\n" + text


def call(db, name: str, cfg, owner_email: Optional[str], args: dict) -> dict:
    """One of the two tools for the bot `cfg` (a CloudAgentConfig), as an MCP tool result."""
    def text(t: str, error: bool = False) -> dict:
        return {"content": [{"type": "text", "text": t}], "isError": error}
    if name == "workspace_search_knowledge":
        return text(search(db, cfg.workspace_id, cfg.agent_name, owner_email, args.get("query")))
    got = read(db, cfg.workspace_id, cfg.agent_name, owner_email, args.get("id"))
    return text(got) if got is not None else text("No entry with that id that you may read.", error=True)
