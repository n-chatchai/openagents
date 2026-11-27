"""Issues for bots that call no MCP server of ours (routers/bot_tools.py, services/bot_issues.py)."""

import asyncio
import re
import time
import uuid

from sqlalchemy import select

from app.models import Channel, CloudAgentConfig, Issue, IssueBoard, Node, User, WorkspaceMember, WorkspaceMembership
from app.services import bot_issues

import pytest

ASKER = "somchai@team.test"


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    from app.config import config
    monkeypatch.setattr(config, "WORKSPACE_SESSION_SECRET", "test-session-secret-at-least-32-bytes")


def _team(db, ws, provider="changbot"):
    db.add(WorkspaceMember(workspace_id=ws["id"], agent_name="nok", owner_email=ASKER, status="online", display_name="นก"))
    cfg = CloudAgentConfig(id=str(uuid.uuid4()), workspace_id=ws["id"], agent_name="nok", provider=provider, model=provider, api_key="k")
    db.add(cfg)
    if not db.execute(select(Channel).where(Channel.workspace_id == ws["id"], Channel.name == "general")).scalar_one_or_none():
        db.add(Channel(id=str(uuid.uuid4()), workspace_id=ws["id"], name="general", title="general"))
    user = User(email=ASKER)
    db.add(user)
    db.flush()
    db.add(WorkspaceMembership(workspace_id=ws["id"], user_id=user.id, role="member"))
    db.commit()
    return cfg


def _post(client, body):
    return client.post("/v1/bot-tools", json=body).json()["data"]


def test_a_run_carries_a_note_with_its_own_reference(workspace, db, monkeypatch):
    from app.services import cloud_agent, hermes_agent
    cfg = _team(db, workspace)
    sent = []

    async def fake_run(target, text, session_key, event_id, notes):
        sent.append(text)
        return "ok"

    async def fake_post(*_a, **_k):
        return None

    monkeypatch.setattr(hermes_agent, "_run", fake_run)
    monkeypatch.setattr(cloud_agent, "_post_response", fake_post)
    event = {"id": "evt-1", "source": f"human:{ASKER}", "target": "channel/general", "metadata": {},
             "payload": {"content": "@nok เปิด issue ให้หน่อย"}, "timestamp": int(time.time() * 1000)}
    target = hermes_agent.RunTarget(root="https://hermes.test/v1", api_key="k")
    asyncio.run(hermes_agent.invoke_run_agent(db, workspace["id"], event, cfg, 0, target))
    (text,) = sent
    assert "/v1/bot-tools" in text and text.rstrip().endswith("@nok เปิด issue ให้หน่อย")
    reference = re.search(r'"reference": "([^"]+)"', text).group(1)
    from app.services.grokbot_agent import _unsign
    assert _unsign(bot_issues.RUN_PURPOSE, reference)["a"] == cfg.id


def test_a_run_opens_an_issue_for_the_asker_on_a_board_it_makes(client, workspace, db):
    cfg = _team(db, workspace)
    ref = bot_issues.run_reference(cfg, "channel/general", f"human:{ASKER}")
    got = _post(client, {"reference": ref, "tool": "workspace_create_issue",
                         "args": {"title": "ยอดตก", "board": "ขาย", "create_board": True, "assignee": "asker"}})
    assert got["ok"] is True and "#1" in got["text"]
    db.expire_all()
    issue = db.execute(select(Issue).where(Issue.workspace_id == workspace["id"])).scalar_one()
    board = db.execute(select(IssueBoard).where(IssueBoard.workspace_id == workspace["id"])).scalar_one()
    assert issue.created_by == "openagents:nok" and issue.assignee == f"human:{ASKER}" and issue.board_id == board.id
    listed = _post(client, {"reference": ref, "tool": "workspace_list_boards", "args": {}})
    assert "ขาย" in listed["text"]


def test_a_bot_with_the_tool_is_told_the_tool_alone_never_a_url_to_post():
    note = bot_issues.run_note("ref", tool_only=True)
    assert "workspace_issue tool" in note and "workspace_list_issues" in note and "ref" in note
    assert "POST" not in note and "Never curl" in note
    assert "POST" in bot_issues.run_note("ref")


def test_pixel_bot_runs_carry_the_tool_only_note():
    from app.services.changbot_agent import _pixelbot_target
    assert _pixelbot_target("tok").issue_tool is True


def test_a_run_lists_the_issues_open_ones_first_by_board_and_by_asker(client, workspace, db):
    cfg = _team(db, workspace)
    ref = bot_issues.run_reference(cfg, "channel/general", f"human:{ASKER}")
    _post(client, {"reference": ref, "tool": "workspace_create_issue", "args": {"title": "ยอดตก", "assignee": "asker"}})
    _post(client, {"reference": ref, "tool": "workspace_create_issue",
                   "args": {"title": "หน้าเว็บช้า", "board": "เว็บ", "create_board": True}})
    _post(client, {"reference": ref, "tool": "workspace_create_issue", "args": {"title": "ปิดแล้ว"}})
    db.expire_all()
    done = db.execute(select(Issue).where(Issue.workspace_id == workspace["id"], Issue.title == "ปิดแล้ว")).scalar_one()
    done.status = "closed"
    db.commit()

    got = _post(client, {"reference": ref, "tool": "workspace_list_issues", "args": {}})
    assert got["ok"] is True and "ยอดตก" in got["text"] and "หน้าเว็บช้า" in got["text"] and "ปิดแล้ว" not in got["text"]
    assert "#1 ยอดตก | open | Team issues | " in got["text"]
    assert "ปิดแล้ว" in _post(client, {"reference": ref, "tool": "workspace_list_issues", "args": {"status": "all"}})["text"]
    by_board = _post(client, {"reference": ref, "tool": "workspace_list_issues", "args": {"board": "เว็บ"}})["text"]
    assert "หน้าเว็บช้า" in by_board and "ยอดตก" not in by_board
    mine = _post(client, {"reference": ref, "tool": "workspace_list_issues", "args": {"assignee": "asker"}})["text"]
    assert "ยอดตก" in mine and "หน้าเว็บช้า" not in mine
    assert _post(client, {"reference": ref, "tool": "workspace_list_issues", "args": {"board": "ไม่มี"}})["ok"] is False
    one = _post(client, {"reference": ref, "tool": "workspace_list_issues", "args": {"limit": 1}})["text"]
    assert "newest 1 of 2" in one


def test_a_run_closes_moves_and_reassigns_an_issue_by_number(client, workspace, db):
    from app.models import IssueComment
    cfg = _team(db, workspace)
    ref = bot_issues.run_reference(cfg, "channel/general", f"human:{ASKER}")
    _post(client, {"reference": ref, "tool": "workspace_create_issue", "args": {"title": "ยอดตก", "board": "เว็บ", "create_board": True}})
    upd = lambda args: _post(client, {"reference": ref, "tool": "workspace_update_issue", "args": args})

    got = upd({"number": 1, "status": "closed", "board": "Team issues", "assignee": "asker"})
    assert got["ok"] is True and "#1" in got["text"] and "open → closed" in got["text"]
    db.expire_all()
    issue = db.execute(select(Issue).where(Issue.workspace_id == workspace["id"])).scalar_one()
    assert issue.status == "closed" and issue.board_id is None and issue.assignee == f"human:{ASKER}"
    kinds = {c.kind for c in db.execute(select(IssueComment).where(IssueComment.issue_id == issue.id)).scalars()}
    assert {"status", "activity"} <= kinds
    assert "nothing changed" in upd({"number": 1, "status": "closed"})["text"]
    assert "#1" in upd({"number": "#1", "status": "open"})["text"]
    assert upd({"number": 99, "status": "closed"})["ok"] is False
    assert upd({"number": 1, "status": "gone"})["ok"] is False
    assert upd({"number": 1, "board": "ไม่มี"})["ok"] is False


def test_a_run_may_not_give_away_an_issue_neither_it_nor_its_asker_holds(client, workspace, db):
    cfg = _team(db, workspace)
    db.add(Issue(workspace_id=workspace["id"], number=1, title="ของคนอื่น", created_by="human:other@team.test"))
    db.commit()
    stranger = bot_issues.run_reference(cfg, "channel/general", "human:someone@team.test")
    got = _post(client, {"reference": stranger, "tool": "workspace_update_issue", "args": {"number": 1, "assignee": "none"}})
    assert got["ok"] is False and "opened" in got["text"]
    closed = _post(client, {"reference": stranger, "tool": "workspace_update_issue", "args": {"number": 1, "status": "closed"}})
    assert closed["ok"] is True


def test_a_forged_or_stale_reference_does_nothing(client, workspace, db, monkeypatch):
    cfg = _team(db, workspace)
    assert _post(client, {"reference": "x.y", "tool": "workspace_list_boards"})["ok"] is False
    ref = bot_issues.run_reference(cfg, "channel/general", "")
    from app.services import grokbot_agent
    real = time.time
    monkeypatch.setattr(grokbot_agent.time, "time", lambda: real() + bot_issues.RUN_AGE + 60)
    assert _post(client, {"reference": ref, "tool": "workspace_list_boards"})["ok"] is False


def test_a_removed_bot_cannot_use_its_reference(client, workspace, db):
    cfg = _team(db, workspace)
    ref = bot_issues.run_reference(cfg, "channel/general", "")
    db.get(WorkspaceMember, (workspace["id"], "nok")).status = "removed"
    db.commit()
    assert _post(client, {"reference": ref, "tool": "workspace_list_boards"})["ok"] is False


def test_without_a_secret_a_run_goes_on_without_the_note(workspace, db, monkeypatch):
    from app.config import config
    from app.services import cloud_agent, hermes_agent
    cfg = _team(db, workspace)
    monkeypatch.setattr(config, "WORKSPACE_SESSION_SECRET", "")
    sent = []

    async def fake_run(target, text, session_key, event_id, notes):
        sent.append(text)
        return "ok"

    async def fake_post(*_a, **_k):
        return None

    monkeypatch.setattr(hermes_agent, "_run", fake_run)
    monkeypatch.setattr(cloud_agent, "_post_response", fake_post)
    event = {"id": "evt-2", "source": f"human:{ASKER}", "target": "channel/general", "metadata": {},
             "payload": {"content": "@nok hi"}, "timestamp": int(time.time() * 1000)}
    asyncio.run(hermes_agent.invoke_run_agent(db, workspace["id"], event, cfg, 0, hermes_agent.RunTarget(root="https://h.test/v1", api_key="k")))
    assert sent and "/v1/bot-tools" not in sent[0]


def test_a_connector_agent_opens_one_with_its_token(client, workspace, db):
    _team(db, workspace)
    h = {"X-Workspace-Token": workspace["token"]}
    got = client.post(f"/v1/bot-tools/agent?network={workspace['id']}", headers=h, json={
        "agent_name": "nok", "channel": "general", "requester": ASKER, "tool": "workspace_create_issue",
        "args": {"title": "ตรวจสต็อก", "assignee": "asker"}}).json()["data"]
    assert got["ok"] is True
    db.expire_all()
    assert db.execute(select(Issue.assignee).where(Issue.workspace_id == workspace["id"])).scalar_one() == f"human:{ASKER}"
    assert client.post(f"/v1/bot-tools/agent?network={workspace['id']}", json={
        "agent_name": "nok", "channel": "general", "tool": "workspace_list_boards"}).status_code == 403
    assert client.post(f"/v1/bot-tools/agent?network={workspace['id']}", headers=h, json={
        "agent_name": "ghost", "channel": "general", "tool": "workspace_list_boards"}).status_code == 404
