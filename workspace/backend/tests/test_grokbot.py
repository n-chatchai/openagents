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
    assert setup["webhookSet"] is False


def test_mcp_lists_its_tools_for_the_right_key_only(client, workspace):
    _add_grok(client, workspace)
    key = _setup(client, workspace)["connectionKey"]

    r = _mcp(client, key, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    assert r.json()["result"]["capabilities"] == {"tools": {"listChanged": False}}
    names = {t["name"] for t in _mcp(client, key, "tools/list").json()["result"]["tools"]}
    assert names == {"workspace_read_thread", "workspace_post_reply", "workspace_ack"}
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
    "https://evil.example/automations/webhook/x",
    "https://user:pw@api2.cursor.sh/automations/webhook/x",
    "",
])
def test_only_a_grok_routine_webhook_is_taken(client, workspace, url):
    _add_grok(client, workspace)
    r = client.put("/v1/grokbot/grok/routine", headers=_headers(workspace), json={
        "network": workspace["id"], "webhook_url": url, "webhook_key": "crsr_abc",
    })
    assert r.status_code == 400


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
