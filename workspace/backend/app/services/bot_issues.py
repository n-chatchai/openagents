# -*- coding: utf-8 -*-
"""
Issues for the bots that reach us over MCP (Grok Bot, ChatGPT dots): see the
boards, make a board, open an issue. Founder, 2026-11-27: "bot able to create
Issue, given Board (can create if no board available)".

An issue a bot opens is the bot's (created_by openagents:<name>) and is linked
to the thread the bot was called in, so it shows there. A board a bot makes
belongs to the bot's owner, the person who may rename or delete it, as if
they had made it. The board is named; an unknown name makes it, when the
call asks to. "Team issues", the workspace's own board, is always there.
An issue may go to a person of the team: the one who called the bot
("asker", the wake's source) or one named by email, told as the web tells
an assignee.

Like the thread tools, each call carries the wake's reference, so the tools
only act as the bot a wake was meant for, in the thread it was called in.

Bots the workspace runs (Hermes, Pixel Bot) call none of our MCP servers: each
run carries a reference of its own and a note saying how to use it, and the
bot posts it to /v1/bot-tools (routers/bot_tools.py). Agents through the
connector call the same tools with their machine token, naming the thread.
Founder, 2026-11-27: "ทำ 1", every kind of bot opens issues.
"""

import time
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select

from app.models import Channel, CloudAgentConfig, Issue, IssueBoard, Workspace, WorkspaceMember

TEAM_NAME = "Team issues"

TOOLS = [
    {
        "name": "workspace_list_boards",
        "description": "The team's issue boards, by name. \"Team issues\" is always there.",
        "inputSchema": {
            "type": "object",
            "properties": {"reference": {"type": "string", "description": "The wake payload's reference, exactly as received."}},
            "required": ["reference"],
            "additionalProperties": False,
        },
    },
    {
        "name": "workspace_create_issue",
        "description": (
            "Open an issue on a board, linked to this thread. Name the board; with create_board true, "
            "a board of that name is made when there is none. Without a board it goes to \"Team issues\". "
            "Say the issue's number in your reply (#12)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "reference": {"type": "string", "description": "The wake payload's reference, exactly as received."},
                "title": {"type": "string", "description": "A short title."},
                "description": {"type": "string", "description": "What is to be done, in Markdown."},
                "board": {"type": "string", "description": "The board's name; leave out for \"Team issues\"."},
                "create_board": {"type": "boolean", "description": "Make the board when no board has this name."},
                "assignee": {"type": "string", "description": "Who it goes to: \"asker\" for the person who called you, or a team member's email. Leave out for no one."},
            },
            "required": ["reference", "title"],
            "additionalProperties": False,
        },
    },
]
NAMES = {t["name"] for t in TOOLS}


def _text(t: str, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": t}], "isError": error}


def _boards(db, workspace_id: str) -> list:
    return list(db.execute(
        select(IssueBoard).where(IssueBoard.workspace_id == str(workspace_id)).order_by(IssueBoard.created_at)
    ).scalars().all())


def list_boards(db, workspace_id: str) -> str:
    names = [TEAM_NAME] + [b.name for b in _boards(db, workspace_id)]
    return "Boards: " + "; ".join(names)


def _owner_of(db, workspace_id: str, agent_name: str) -> Optional[str]:
    m = db.get(WorkspaceMember, (str(workspace_id), agent_name))
    return (m.owner_email or "").strip().lower() or None if m else None


def create_issue(db, workspace_id: str, agent_name: str, channel_target: str, args: dict, asker: str = "") -> dict:
    from fastapi import HTTPException

    from app.routers.issues import _link_thread, _resolve_assignee, _signal_people, _snippet_of

    title = (args.get("title") or "").strip() if isinstance(args.get("title"), str) else ""
    if not title:
        return _text("An issue needs a title.", error=True)
    description = (args.get("description") or "").strip() if isinstance(args.get("description"), str) else ""
    board_name = (args.get("board") or "").strip() if isinstance(args.get("board"), str) else ""
    wid = str(workspace_id)
    workspace = db.get(Workspace, wid)
    actor = f"openagents:{agent_name}"

    wanted = (args.get("assignee") or "").strip() if isinstance(args.get("assignee"), str) else ""
    assignee = assignee_name = None
    if wanted:
        email = asker.removeprefix("human:") if wanted.casefold() == "asker" and asker.startswith("human:") else wanted.removeprefix("human:")
        try:
            assignee, assignee_name = _resolve_assignee(db, workspace, actor, f"human:{email}") if "@" in email else (None, None)
        except HTTPException:
            assignee = None
        if not assignee:
            return _text(f'"{wanted}" is not a person of this team. Use "asker", a team member\'s email, or leave assignee out.', error=True)

    board_id, board_label, made = None, TEAM_NAME, False
    if board_name and board_name.casefold() not in (TEAM_NAME.casefold(), "team"):
        board = next((b for b in _boards(db, wid) if b.name.casefold() == board_name.casefold()), None)
        if board is None:
            if args.get("create_board") is not True:
                return _text(f'No board is named "{board_name}". List the boards, or call again with create_board true.', error=True)
            owner = _owner_of(db, wid, agent_name)
            board = IssueBoard(workspace_id=wid, name=board_name[:120],
                               created_by=f"human:{owner}" if owner else f"openagents:{agent_name}")
            db.add(board)
            db.flush()
            made = True
        board_id, board_label = board.id, board.name

    member = db.get(WorkspaceMember, (wid, agent_name))
    # Consecutive numbers, as the issues API takes them (routers/issues.py).
    db.execute(select(Workspace.id).where(Workspace.id == wid).with_for_update())
    number = (db.execute(select(func.max(Issue.number)).where(Issue.workspace_id == wid)).scalar() or 0) + 1
    shown = member.display_name if member and member.display_name else agent_name
    issue = Issue(
        number=number, board_id=board_id, workspace_id=wid,
        title=title[:240], description=description[:50000],
        created_by=actor, created_by_name=shown, assignee=assignee, assignee_name=assignee_name,
        # On the issue, so "@<bot>" in a comment hands it more work (routers/issues.py).
        participants=[{"source": actor, "name": shown}] + ([{"source": assignee, "name": assignee_name}] if assignee else []),
    )
    db.add(issue)
    db.flush()
    name = (channel_target or "").removeprefix("channel/")
    channel = db.execute(select(Channel).where(Channel.workspace_id == wid, Channel.name == name)).scalar_one_or_none() if name else None
    if channel is not None:
        _link_thread(db, issue, channel)
    if assignee:
        _signal_people(db, workspace, issue, actor, {assignee.removeprefix("human:")}, "issue",
                       f"{shown} assigned you {issue.title}", _snippet_of(issue.description))
    issue.updated_at = datetime.now(timezone.utc)
    db.commit()
    where = f'on the new board "{board_label}"' if made else f'on "{board_label}"'
    given = f", given to {assignee_name}" if assignee else ""
    return _text(f"Opened issue #{issue.number} \"{issue.title}\" {where}{given}, linked to this thread. Say #{issue.number} in your reply.")


def call(db, name: str, cfg, fields: dict, args: dict) -> dict:
    """One of the tools for the bot `cfg` (a CloudAgentConfig) on the thread a wake named."""
    if name == "workspace_list_boards":
        return _text(list_boards(db, cfg.workspace_id))
    return create_issue(db, cfg.workspace_id, cfg.agent_name, fields.get("c") or "", args, fields.get("s") or "")


# ---------------------------------------------------------------------------
# A run's own reference (Hermes, Pixel Bot)
# ---------------------------------------------------------------------------

RUN_PURPOSE = "workspace-run"
# As long as a run may take (hermes_agent._RUN_TIMEOUT), and a little more.
RUN_AGE = 35 * 60
BOT_TOOLS_PATH = "/v1/bot-tools"


def run_reference(cfg, channel_target: str, source: str) -> str:
    """What a run of the bot `cfg` in this thread, for this message, may use the tools with."""
    from app.services.grokbot_agent import _sign
    return _sign(RUN_PURPOSE, {"a": cfg.id, "c": channel_target, "s": source or "", "t": int(time.time())})


def run_note(reference: str) -> str:
    """The lines a run's input carries: how to open an issue from this message."""
    from app.config import config
    url = f"{config.PUBLIC_API_BASE.rstrip('/')}{BOT_TOOLS_PATH}"
    return (
        "[Workspace issues] When asked to file work as an issue: with a workspace_issue tool, call it with url "
        + url + " and reference " + reference + "; otherwise POST " + url + " with JSON "
        '{"reference": "' + reference + '", "tool": "workspace_create_issue", "args": {"title": "...", '
        '"description": "...", "board": "<board name, optional>", "create_board": false, "assignee": "asker"}}. '
        'tool "workspace_list_boards" (args {}) names the boards. "assignee": "asker" gives it to the person '
        "who asked you; leave it out for no one. Say the issue's number (#12) in your reply. "
        "The reference works for this message only."
    )


def call_with_reference(db, reference: str, name: str, args: dict) -> dict:
    """A tool for the run a reference names, if it is fresh and its bot is still in the team."""
    from app.services.grokbot_agent import _unsign
    fields = _unsign(RUN_PURPOSE, reference if isinstance(reference, str) else "", RUN_AGE)
    if not fields or not isinstance(fields.get("c"), str) or name not in NAMES:
        return _text("This reference has expired or the tool is unknown. Ask again in the thread.", error=True)
    cfg = db.get(CloudAgentConfig, fields.get("a"))
    member = db.get(WorkspaceMember, (str(cfg.workspace_id), cfg.agent_name)) if cfg else None
    if cfg is None or member is None or member.status == "removed":
        return _text("This bot is no longer in the team.", error=True)
    return call(db, name, cfg, fields, args if isinstance(args, dict) else {})

