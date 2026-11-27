"""Grok Bot: setup, the MCP server its plugin reaches, and the wake."""

import asyncio
import uuid

import pytest
from sqlalchemy import select

from app.config import config
from app.models import CloudAgentConfig, EventRecord, WorkspaceMember
from app.services import grokbot_agent as grok
from app.services.hermes_agent import AgentRunError

WEBHOOK = "https://api2.cursor.sh/automations/webhook/routine-1"
HUMAN = "human:founder@pace6.tech"
CHANNEL = "channel/general"


@pytest.fixture(autouse=True)
def session_secret(monkeypatch):
    monkeypatch.setattr(config, "WORKSPACE_SESSION_SECRET", "test-secret-0123456789abcdef")


@pytest.fixture(autouse=True)
def quiet_side_effects(monkeypatch):
    import app.services.integrations as integrations
    import app.services.push as push
    import app.services.watches as watches
    import app.services.workflow as workflow

    monkeypatch.setattr(push, "fanout_for_event", lambda *_a, **_k: None)
    monkeypatch.setattr(workflow, "advance_workflow", lambda *_a, **_k: None)
    monkeypatch.setattr(integrations, "relay_for_event", lambda *_a, **_k: None)
    monkeypatch.setattr(watches, "notify_watchers", lambda *_a, **_k: None)


def _headers(ws):
    return {"X-Workspace-Token": ws["token"]}


def _add_grok(client, ws, name="grok"):
    r = client.post("/v1/cloud-agents", headers=_headers(ws), json={
        "network": ws["id"], "agent_name": name, "provider": "grokbot", "model": "grokbot", "api_key": "",
    })
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _setup(client, ws, name="grok"):
    r = client.get(f"/v1/grokbot/{name}", params={"network": ws["id"]}, headers=_headers(ws))
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _mcp(client, key, method, params=None, msg_id=1):
    body = {"jsonrpc": "2.0", "id": msg_id, "method": method}
    if params is not None:
        body["params"] = params
    return client.post("/v1/mcp/grok", headers={grok.KEY_HEADER: key}, json=body)


def _call(client, key, tool, arguments):
    r = _mcp(client, key, "tools/call", {"name": tool, "arguments": arguments})
    assert r.status_code == 200, r.text
    return r.json()["result"]


def test_joins_without_a_key_and_hands_out_its_plugin_setup(client, workspace):
    added = _add_grok(client, workspace)
    assert added["provider"] == "grokbot"
    setup = _setup(client, workspace)
    assert setup["mcpUrl"].endswith("/v1/mcp/grok")
    assert setup["headerName"] == "x-workspace-key"
    assert setup["connectionKey"].startswith("gbk_")
    assert "@grok" in setup["routinePrompt"]
    # Added by asking a Bot in chat: the message carries the URL and the key.
    assert setup["mcpUrl"] in setup["pluginPrompt"] and setup["connectionKey"] in setup["pluginPrompt"]
    assert setup["webhookSet"] is False


def test_mcp_lists_its_tools_for_the_right_key_only(client, workspace):
    _add_grok(client, workspace)
    key = _setup(client, workspace)["connectionKey"]

    r = _mcp(client, key, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    assert r.json()["result"]["capabilities"] == {"tools": {"listChanged": False}}
    names = {t["name"] for t in _mcp(client, key, "tools/list").json()["result"]["tools"]}
    assert names == {"workspace_read_thread", "workspace_post_reply", "workspace_ack",
                     "workspace_search_knowledge", "workspace_read_knowledge",
                     "workspace_list_boards", "workspace_list_issues", "workspace_create_issue"}
    # A notification has no answer.
    note = client.post("/v1/mcp/grok", headers={grok.KEY_HEADER: key},
                       json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert note.status_code == 202

    assert _mcp(client, key[:-2] + "xx", "tools/list").status_code == 401
    assert _mcp(client, "", "tools/list").status_code == 401
    forged = client.post("/v1/mcp/grok", headers={grok.KEY_HEADER: key, "Origin": "https://evil.example"},
                         json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert forged.status_code == 403


def test_a_key_does_nothing_once_its_owner_has_no_grok_bot_here(client, workspace):
    _add_grok(client, workspace)
    key = _setup(client, workspace)["connectionKey"]
    r = client.delete("/v1/cloud-agents/grok", params={"network": workspace["id"]}, headers=_headers(workspace))
    assert r.status_code == 200, r.text
    assert _mcp(client, key, "ping").status_code == 401


def _route(db, name, url=WEBHOOK, key="crsr_abc"):
    cfg = db.execute(select(CloudAgentConfig).where(CloudAgentConfig.agent_name == name)).scalar_one()
    cfg.base_url, cfg.api_key = url, key
    db.commit()
    return cfg


def _wake_for(db, ws, cfg, monkeypatch):
    sent = []

    async def fake_wake(url, key, body):
        sent.append(body)

    async def answered(*_a):
        return True

    monkeypatch.setattr(grok, "_wake", fake_wake)
    monkeypatch.setattr(grok, "_answered", answered)
    asyncio.run(grok.invoke_grokbot_agent(db, ws["id"], _trigger(db, ws), cfg, 0))
    return sent[0]


def test_one_plugin_serves_all_of_a_persons_grok_bots(client, workspace, db, monkeypatch):
    _add_grok(client, workspace, "grok-research")
    _add_grok(client, workspace, "grok-writer")
    first = _setup(client, workspace, "grok-research")
    second = _setup(client, workspace, "grok-writer")
    assert first["connectionKey"] == second["connectionKey"]
    assert first["routineName"] != second["routineName"]
    # Until the plugin has carried a call, the second Bot's setup still shows it.
    assert second["pluginUsedBy"] is None

    wake = _wake_for(db, workspace, _route(db, "grok-writer"), monkeypatch)
    posted = _call(client, first["connectionKey"], "workspace_post_reply",
                   {"reference": wake["reference"], "text": "From the writer."})
    assert posted["isError"] is False
    db.expire_all()
    reply = db.execute(select(EventRecord).where(EventRecord.source == "openagents:grok-writer")).scalar_one()
    assert reply.payload["content"] == "From the writer."
    # The call used the writer's reference: its contact, not the researcher's.
    assert _setup(client, workspace, "grok-writer")["lastContactAt"] is not None
    assert _setup(client, workspace, "grok-research")["lastContactAt"] is None
    assert _setup(client, workspace, "grok-research")["pluginUsedBy"] == "grok-writer"
    bots = {b["agentName"]: b for b in _setup(client, workspace, "grok-research")["bots"]}
    assert set(bots) == {"grok-research", "grok-writer"}
    assert bots["grok-writer"]["webhookSet"] is True and bots["grok-writer"]["lastContactAt"]
    assert bots["grok-research"]["webhookSet"] is False


def test_a_plugin_call_without_a_reference_is_nobodys_contact(client, workspace):
    _add_grok(client, workspace)
    key = _setup(client, workspace)["connectionKey"]
    assert _mcp(client, key, "ping").status_code == 200
    assert _setup(client, workspace)["lastContactAt"] is None


@pytest.mark.parametrize("url", [
    "http://api2.cursor.sh/automations/webhook/x",
    "https://10.0.0.5/automations/webhook/x",
    "https://localhost/automations/webhook/x",
    "https://erawan-api.erawan.svc.cluster.local/x",
    "https://[::1]/automations/webhook/x",
    "https://user:pw@api2.cursor.sh/automations/webhook/x",
    "",
])
def test_only_a_grok_routine_webhook_is_taken(client, workspace, url):
    _add_grok(client, workspace)
    r = client.put("/v1/grokbot/grok/routine", headers=_headers(workspace), json={
        "network": workspace["id"], "webhook_url": url, "webhook_key": "crsr_abc",
    })
    assert r.status_code == 400


@pytest.mark.parametrize("url", [
    "https://api.x.ai/v1/routines/r-1/webhook",
    "https://hooks.grok.com/routine/r-1",
])
def test_a_routine_webhook_on_any_public_host_is_taken(client, workspace, monkeypatch, url):
    # xAI's docs never name the "POST to" host, so none is assumed.
    _add_grok(client, workspace)

    async def fake_wake(url, key, body):
        return None

    monkeypatch.setattr(grok, "_wake", fake_wake)
    r = client.put("/v1/grokbot/grok/routine", headers=_headers(workspace), json={
        "network": workspace["id"], "webhook_url": url, "webhook_key": "crsr_abc",
    })
    assert r.status_code == 200 and r.json()["data"]["webhookSet"] is True


@pytest.mark.parametrize("addrs", [["127.0.0.1"], ["10.1.2.3"], ["93.184.216.34", "192.168.1.9"], []])
def test_a_wake_never_goes_to_a_name_that_resolves_inside(monkeypatch, addrs):
    async def fake_resolve(host):
        return set(addrs)

    monkeypatch.setattr(grok, "_resolve", fake_resolve)
    with pytest.raises(AgentRunError, match="isn't a public one"):
        asyncio.run(grok._wake("https://sneaky.example/hook", "crsr_abc", {}))


def test_saving_the_routine_wakes_it_with_a_challenge_it_can_hand_back(client, workspace, monkeypatch):
    _add_grok(client, workspace)
    sent = []

    async def fake_wake(url, key, body):
        sent.append((url, key, body))

    monkeypatch.setattr(grok, "_wake", fake_wake)
    r = client.put("/v1/grokbot/grok/routine", headers=_headers(workspace), json={
        "network": workspace["id"], "webhook_url": WEBHOOK, "webhook_key": "crsr_abc",
    })
    data = r.json()["data"]
    assert data["webhookSet"] is True and data["testProblem"] is None and data["testSentAt"]
    (url, key, body), = sent
    assert (url, key) == (WEBHOOK, "crsr_abc")
    assert body["schema"] == grok.WAKE_SCHEMA and body["kind"] == "verify"

    conn = data["connectionKey"]
    ok = _call(client, conn, "workspace_ack", {"challenge": body["challenge"]})
    assert ok["isError"] is False
    bad = _call(client, conn, "workspace_ack", {"challenge": body["challenge"] + "x"})
    assert bad["isError"] is True


def test_a_refused_test_says_why(client, workspace, monkeypatch):
    _add_grok(client, workspace)

    async def refused(url, key, body):
        raise AgentRunError("Grok Bot refused the routine key.")

    monkeypatch.setattr(grok, "_wake", refused)
    r = client.put("/v1/grokbot/grok/routine", headers=_headers(workspace), json={
        "network": workspace["id"], "webhook_url": WEBHOOK, "webhook_key": "crsr_abc",
    })
    assert r.json()["data"]["testProblem"] == "Grok Bot refused the routine key."


def _trigger(db, ws, content="@grok what changed?", target=CHANNEL, source=HUMAN):
    event = EventRecord(
        id=str(uuid.uuid4()), network_id=ws["id"], type="workspace.message.posted",
        source=source, target=target, payload={"content": content, "message_type": "chat"},
        metadata_={}, timestamp=1_000, visibility="channel" if target.startswith("channel/") else "direct",
    )
    db.add(event)
    db.commit()
    return {"id": event.id, "source": source, "target": target, "timestamp": 1_000,
            "payload": event.payload, "metadata": {}}


def test_a_mention_wakes_grok_which_reads_the_thread_and_answers_in_it(client, workspace, db, monkeypatch):
    _add_grok(client, workspace)
    cfg = db.execute(select(CloudAgentConfig).where(CloudAgentConfig.agent_name == "grok")).scalar_one()
    cfg.base_url, cfg.api_key = WEBHOOK, "crsr_abc"
    db.commit()
    event = _trigger(db, workspace)
    sent = []

    async def fake_wake(url, key, body):
        sent.append(body)

    async def answered(*_a):
        return True

    monkeypatch.setattr(grok, "_wake", fake_wake)
    monkeypatch.setattr(grok, "_answered", answered)
    asyncio.run(grok.invoke_grokbot_agent(db, workspace["id"], event, cfg, 0))

    (wake,) = sent
    assert wake["kind"] == "message" and wake["agent"] == "grok"
    # References only: what was said goes over MCP.
    assert "what changed" not in str(wake)

    key = _setup(client, workspace)["connectionKey"]
    thread = _call(client, key, "workspace_read_thread", {"reference": wake["reference"]})
    assert thread["isError"] is False
    assert "what changed?" in thread["content"][0]["text"]

    posted = _call(client, key, "workspace_post_reply", {"reference": wake["reference"], "text": "Three things."})
    assert posted["isError"] is False
    db.expire_all()
    reply = db.execute(
        select(EventRecord).where(EventRecord.source == "openagents:grok", EventRecord.target == CHANNEL)
    ).scalar_one()
    assert reply.payload["content"] == "Three things."
    assert (reply.metadata_ or {}).get("in_reply_to") == event["id"]


def test_somebody_elses_key_cannot_use_a_reference(client, workspace, db, monkeypatch):
    _add_grok(client, workspace, "grok")
    _add_grok(client, workspace, "their-grok")
    member = db.execute(select(WorkspaceMember).where(WorkspaceMember.agent_name == "their-grok")).scalar_one()
    member.owner_email = "someone-else@pace6.tech"
    db.commit()
    wake = _wake_for(db, workspace, _route(db, "grok"), monkeypatch)

    theirs = _setup(client, workspace, "their-grok")["connectionKey"]
    assert theirs != _setup(client, workspace, "grok")["connectionKey"]
    stolen = _call(client, theirs, "workspace_post_reply", {"reference": wake["reference"], "text": "hi"})
    assert stolen["isError"] is True
    read = _call(client, theirs, "workspace_read_thread", {"reference": wake["reference"]})
    assert read["isError"] is True


def test_no_answer_in_time_is_said_in_the_thread(workspace, db, monkeypatch):
    cfg = CloudAgentConfig(workspace_id=workspace["id"], agent_name="grok", provider="grokbot",
                           model="grokbot", api_key="crsr_abc", base_url=WEBHOOK)
    db.add(cfg)
    db.commit()

    async def fake_wake(*_a):
        return None

    async def silent(*_a):
        return False

    monkeypatch.setattr(grok, "_wake", fake_wake)
    monkeypatch.setattr(grok, "_answered", silent)
    with pytest.raises(AgentRunError, match="hasn't answered"):
        asyncio.run(grok.invoke_grokbot_agent(db, workspace["id"], _trigger(db, workspace), cfg, 0))


def test_a_grok_without_its_webhook_says_to_finish_setup(workspace, db):
    cfg = CloudAgentConfig(workspace_id=workspace["id"], agent_name="grok", provider="grokbot",
                           model="grokbot", api_key="", base_url=None)
    db.add(cfg)
    db.commit()
    with pytest.raises(AgentRunError, match="Finish its setup"):
        asyncio.run(grok.invoke_grokbot_agent(db, workspace["id"], _trigger(db, workspace), cfg, 0))


def test_routine_refusals_are_worded_for_the_room():
    import httpx

    def r(code, body):
        return httpx.Response(code, json=body)

    assert "switched off" in grok._refusal(r(400, {"success": False, "error": "Automation abc is disabled"}))
    assert "too many" in grok._refusal(r(400, {"error": "Automation run rate limit exceeded"}))
    assert "routine key" in grok._refusal(r(401, {"code": "error", "message": "Invalid API key"}))


# ---------------------------------------------------------------------------
# The team's knowledge base, read-only (app/services/bot_knowledge.py)
# ---------------------------------------------------------------------------

OWNER = "founder@pace6.tech"


def _entry(db, ws, title, text, visibility="public", owner=None):
    from app.models import KnowledgeEntry
    from app.storage import get_file_store

    entry_id = str(uuid.uuid4())
    key = get_file_store().save(ws["id"], entry_id, f"{entry_id}.md", text.encode())
    db.add(KnowledgeEntry(id=entry_id, workspace_id=ws["id"], slug=entry_id, title=title, storage_key=key,
                          created_by=owner or "human:someone@pace6.tech", owner=owner, visibility=visibility))
    db.commit()
    return entry_id


def _grant(db, ws, kind, rid, grantee_kind, grantee_id, rights=("read", "act")):
    from app.models import ResourceGrant

    db.add(ResourceGrant(workspace_id=ws["id"], resource_kind=kind, resource_id=rid,
                         grantee_kind=grantee_kind, grantee_id=grantee_id, rights=list(rights)))
    db.commit()


def _knowledge_setup(client, ws, db, monkeypatch):
    _add_grok(client, ws)
    member = db.execute(select(WorkspaceMember).where(WorkspaceMember.agent_name == "grok")).scalar_one()
    member.owner_email = OWNER
    db.commit()
    ids = {
        "public": _entry(db, ws, "Refund policy", "Refunds within 14 days, with the receipt."),
        "owners": _entry(db, ws, "Salary bands", "Band C pays 80k.", "private", f"human:{OWNER}"),
        "bots": _entry(db, ws, "Price list", "Hobby is 249 baht.", "private", "human:someone@pace6.tech"),
        "others": _entry(db, ws, "Board notes", "Raise in March.", "private", "human:someone@pace6.tech"),
    }
    _grant(db, ws, "knowledge", ids["bots"], "agent", "grok", ("read",))
    wake = _wake_for(db, ws, _route(db, "grok"), monkeypatch)
    key = _setup(client, ws)["connectionKey"]
    return ids, wake, key


def _found(client, key, wake, query=""):
    got = _call(client, key, "workspace_search_knowledge", {"reference": wake["reference"], "query": query})
    assert got["isError"] is False
    return got["content"][0]["text"]


def test_a_bot_only_its_owner_calls_reads_what_its_owner_may(client, workspace, db, monkeypatch):
    ids, wake, key = _knowledge_setup(client, workspace, db, monkeypatch)
    listed = _found(client, key, wake)
    assert "Refund policy" in listed and "Salary bands" in listed and "Price list" in listed
    assert "Board notes" not in listed
    # Found by what the document says, not only its title.
    assert "Refund policy" in _found(client, key, wake, "receipt")
    read = _call(client, key, "workspace_read_knowledge", {"reference": wake["reference"], "id": ids["owners"]})
    assert read["isError"] is False and "Band C pays 80k." in read["content"][0]["text"]
    hidden = _call(client, key, "workspace_read_knowledge", {"reference": wake["reference"], "id": ids["others"]})
    assert hidden["isError"] is True


def test_a_bot_others_may_call_does_not_read_its_owners_private_entries(client, workspace, db, monkeypatch):
    ids, wake, key = _knowledge_setup(client, workspace, db, monkeypatch)
    # Anyone in the room may call it now.
    _grant(db, workspace, "agent", "grok", "human", "teammate@pace6.tech")
    listed = _found(client, key, wake)
    assert "Refund policy" in listed and "Price list" in listed
    assert "Salary bands" not in listed
    read = _call(client, key, "workspace_read_knowledge", {"reference": wake["reference"], "id": ids["owners"]})
    assert read["isError"] is True
    shared = _call(client, key, "workspace_read_knowledge", {"reference": wake["reference"], "id": ids["bots"]})
    assert shared["isError"] is False and "Hobby is 249 baht." in shared["content"][0]["text"]


def test_knowledge_needs_a_fresh_reference_of_your_own(client, workspace, db, monkeypatch):
    ids, wake, key = _knowledge_setup(client, workspace, db, monkeypatch)
    stale = _call(client, key, "workspace_search_knowledge", {"reference": "nope", "query": ""})
    assert stale["isError"] is True
    _add_grok(client, workspace, "their-grok")
    member = db.execute(select(WorkspaceMember).where(WorkspaceMember.agent_name == "their-grok")).scalar_one()
    member.owner_email = "someone-else@pace6.tech"
    db.commit()
    theirs = _setup(client, workspace, "their-grok")["connectionKey"]
    stolen = _call(client, theirs, "workspace_read_knowledge", {"reference": wake["reference"], "id": ids["public"]})
    assert stolen["isError"] is True


# ---------------------------------------------------------------------------
# Issues (app/services/bot_issues.py)
# ---------------------------------------------------------------------------

def _issue_setup(client, ws, db, monkeypatch):
    from app.models import Channel
    _add_grok(client, ws)
    member = db.execute(select(WorkspaceMember).where(WorkspaceMember.agent_name == "grok")).scalar_one()
    member.owner_email = OWNER
    if not db.execute(select(Channel).where(Channel.workspace_id == ws["id"], Channel.name == "general")).scalar_one_or_none():
        db.add(Channel(id=str(uuid.uuid4()), workspace_id=ws["id"], name="general", title="general"))
    db.commit()
    wake = _wake_for(db, ws, _route(db, "grok"), monkeypatch)
    return wake, _setup(client, ws)["connectionKey"]


def test_a_bot_opens_an_issue_on_the_team_board_linked_to_the_thread(client, workspace, db, monkeypatch):
    from app.models import Issue, IssueThread
    wake, key = _issue_setup(client, workspace, db, monkeypatch)
    got = _call(client, key, "workspace_create_issue", {"reference": wake["reference"], "title": "ยอดขายตก", "description": "ดูช่อง Shopee"})
    assert got["isError"] is False and "#1" in got["content"][0]["text"]
    db.expire_all()
    issue = db.execute(select(Issue).where(Issue.workspace_id == workspace["id"])).scalar_one()
    assert issue.board_id is None and issue.created_by == "openagents:grok" and issue.number == 1
    assert issue.participants == [{"source": "openagents:grok", "name": "grok"}] or issue.participants[0]["source"] == "openagents:grok"
    assert db.execute(select(IssueThread).where(IssueThread.issue_id == issue.id)).scalar_one_or_none() is not None


def test_a_board_is_named_and_made_only_when_asked(client, workspace, db, monkeypatch):
    from app.models import Issue, IssueBoard
    wake, key = _issue_setup(client, workspace, db, monkeypatch)
    missing = _call(client, key, "workspace_create_issue", {"reference": wake["reference"], "title": "a", "board": "Marketing"})
    assert missing["isError"] is True and "create_board" in missing["content"][0]["text"]
    made = _call(client, key, "workspace_create_issue",
                 {"reference": wake["reference"], "title": "a", "board": "Marketing", "create_board": True})
    assert made["isError"] is False and "new board" in made["content"][0]["text"]
    again = _call(client, key, "workspace_create_issue", {"reference": wake["reference"], "title": "b", "board": "marketing"})
    assert again["isError"] is False
    db.expire_all()
    (board,) = db.execute(select(IssueBoard).where(IssueBoard.workspace_id == workspace["id"])).scalars().all()
    assert board.name == "Marketing" and board.created_by == f"human:{OWNER}"
    numbers = sorted(i.number for i in db.execute(select(Issue).where(Issue.board_id == board.id)).scalars())
    assert numbers == [1, 2]
    listed = _call(client, key, "workspace_list_boards", {"reference": wake["reference"]})
    assert "Team issues" in listed["content"][0]["text"] and "Marketing" in listed["content"][0]["text"]


def test_a_bot_gives_the_issue_to_the_person_who_asked(client, workspace, db, monkeypatch):
    from app.models import Issue, User, WorkspaceMembership
    wake, key = _issue_setup(client, workspace, db, monkeypatch)
    user = db.execute(select(User).where(User.email == OWNER)).scalar_one_or_none() or User(email=OWNER)
    db.add(user)
    db.flush()
    db.add(WorkspaceMembership(workspace_id=workspace["id"], user_id=user.id, role="member"))
    db.commit()
    nobody = _call(client, key, "workspace_create_issue", {"reference": wake["reference"], "title": "a", "assignee": "nobody@else.test"})
    assert nobody["isError"] is True
    got = _call(client, key, "workspace_create_issue", {"reference": wake["reference"], "title": "a", "assignee": "asker"})
    assert got["isError"] is False, got
    db.expire_all()
    issue = db.execute(select(Issue).where(Issue.workspace_id == workspace["id"])).scalar_one()
    assert issue.assignee == f"human:{OWNER}"
    assert {p["source"] for p in issue.participants} == {"openagents:grok", issue.assignee}


def test_issue_tools_need_a_fresh_reference(client, workspace, db, monkeypatch):
    _wake, key = _issue_setup(client, workspace, db, monkeypatch)
    assert _call(client, key, "workspace_create_issue", {"reference": "nope", "title": "x"})["isError"] is True
