"""ChatGPT dots: setup, the MCP server with MCP Events, and the wake."""

import asyncio
import base64
import hashlib
import hmac
import json
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.config import config
from app.models import CloudAgentConfig, EventRecord, WorkspaceMember
from app.services import dots_agent as dots
from app.services import grokbot_agent as grok
from app.services.hermes_agent import AgentRunError

CALLBACK = "https://chatgpt.com/backend-api/mcp-events/callback_123"
SECRET = "whsec_" + base64.b64encode(b"k" * 32).decode()
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


class FakeChatGPT:
    """The callback end: echoes challenges, keeps the events it was handed."""

    def __init__(self, status=200, echo=True):
        self.status, self.echo = status, echo
        self.posts = []

    async def __call__(self, url, secret, sub_id, msg_id, body):
        sent = json.loads(body)
        self.posts.append({"url": url, "secret": secret, "sub": sub_id, "id": msg_id, "body": sent})
        if sent.get("type") == "verification":
            return httpx.Response(200, json={"challenge": sent["challenge"] if self.echo else "nope"})
        return httpx.Response(self.status)

    @property
    def events(self):
        return [p["body"] for p in self.posts if p["body"].get("name") == dots.EVENT_NAME]


@pytest.fixture
def chatgpt(monkeypatch):
    fake = FakeChatGPT()
    monkeypatch.setattr(dots, "_post", fake)
    return fake


def _headers(ws):
    return {"X-Workspace-Token": ws["token"]}


def _add_dot(client, ws, name="dot"):
    r = client.post("/v1/cloud-agents", headers=_headers(ws), json={
        "network": ws["id"], "agent_name": name, "provider": "dots", "model": "dots", "api_key": "",
    })
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _setup(client, ws, name="dot"):
    r = client.get(f"/v1/dots/{name}", params={"network": ws["id"]}, headers=_headers(ws))
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _key(setup):
    return setup["pluginUrl"].rsplit("/", 1)[1]


def _mcp(client, key, method, params=None, msg_id=1, headers=None):
    body = {"jsonrpc": "2.0", "id": msg_id, "method": method}
    if params is not None:
        body["params"] = params
    return client.post(f"/v1/mcp/dots/{key}", json=body, headers=headers or {})


def _subscribe(client, key, bot="dot", url=CALLBACK, secret=SECRET, **extra):
    return _mcp(client, key, "events/subscribe", {
        "name": "message.created", "arguments": {"bot": bot},
        "delivery": {"mode": "webhook", "url": url, "secret": secret}, "cursor": None, **extra,
    }).json()


def _call(client, key, tool, arguments):
    r = _mcp(client, key, "tools/call", {"name": tool, "arguments": arguments})
    assert r.status_code == 200, r.text
    return r.json()["result"]


def _trigger(db, ws, content="@dot what changed?", target=CHANNEL, source=HUMAN):
    event = EventRecord(
        id=str(uuid.uuid4()), network_id=ws["id"], type="workspace.message.posted",
        source=source, target=target, payload={"content": content, "message_type": "chat"},
        metadata_={}, timestamp=1_000, visibility="channel" if target.startswith("channel/") else "direct",
    )
    db.add(event)
    db.commit()
    return {"id": event.id, "source": source, "target": target, "timestamp": 1_000,
            "payload": event.payload, "metadata": {}}


def _cfg(db, name="dot"):
    db.expire_all()
    return db.execute(select(CloudAgentConfig).where(CloudAgentConfig.agent_name == name)).scalar_one()


def test_joins_without_a_key_and_hands_out_a_plugin_url_and_subscribe_message(client, workspace):
    added = _add_dot(client, workspace)
    assert added["provider"] == "dots"
    setup = _setup(client, workspace)
    assert "/v1/mcp/dots/dtk_" in setup["pluginUrl"]
    assert 'bot = "dot"' in setup["subscribePrompt"] and "message.created" in setup["subscribePrompt"]
    assert setup["subscribed"] is False and setup["lastContactAt"] is None


def test_mcp_advertises_events_and_tools_for_the_right_key_only(client, workspace):
    _add_dot(client, workspace)
    key = _key(_setup(client, workspace))

    init = _mcp(client, key, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}}).json()
    assert init["result"]["capabilities"] == {"tools": {"listChanged": False}, "events": {}}
    tools = {t["name"] for t in _mcp(client, key, "tools/list").json()["result"]["tools"]}
    assert tools == {"workspace_read_thread", "workspace_post_reply", "workspace_ack",
                     "workspace_search_knowledge", "workspace_read_knowledge",
                     "workspace_list_boards", "workspace_list_issues", "workspace_update_issue", "workspace_create_issue"}
    (event,) = _mcp(client, key, "events/list").json()["result"]["events"]
    assert event["name"] == "message.created" and event["delivery"] == ["webhook"]
    assert event["inputSchema"]["required"] == ["bot"]

    assert _mcp(client, key[:-2] + "xx", "tools/list").status_code == 401
    assert _mcp(client, "gbk_x", "tools/list").status_code == 401
    forged = _mcp(client, key, "tools/list", headers={"Origin": "https://evil.example"})
    assert forged.status_code == 403


def test_subscribing_proves_the_callback_then_stores_it(client, workspace, chatgpt):
    _add_dot(client, workspace)
    key = _key(_setup(client, workspace))
    result = _subscribe(client, key, ttlMs=3_600_000)["result"]
    assert result["id"].startswith("sub_") and result["cursor"] is None and result["truncated"] is False
    assert result["refreshBefore"].endswith("Z")
    (challenge,) = chatgpt.posts
    assert challenge["body"]["type"] == "verification" and challenge["id"].startswith("msg_verification_")
    assert challenge["sub"] == result["id"]
    setup = _setup(client, workspace)
    assert setup["subscribed"] is True and setup["subscribedUntil"] and setup["lastContactAt"]

    # A refresh with the same callback and secret is not challenged again, and
    # keeps the same id.
    again = _subscribe(client, key)["result"]
    assert again["id"] == result["id"] and len(chatgpt.posts) == 1


def test_a_callback_that_does_not_echo_is_refused(client, workspace, monkeypatch):
    monkeypatch.setattr(dots, "_post", FakeChatGPT(echo=False))
    _add_dot(client, workspace)
    key = _key(_setup(client, workspace))
    error = _subscribe(client, key)["error"]
    assert error["code"] == -32015 and error["data"]["reason"] == "challenge_failed"
    assert _setup(client, workspace)["subscribed"] is False


@pytest.mark.parametrize("bad", [
    {"bot": "nobody"},
    {"url": "http://chatgpt.com/cb"},
    {"url": "https://chatgpt.com:8443/cb"},
    {"secret": "whsec_" + base64.b64encode(b"short").decode()},
    {"secret": "not-a-secret"},
    {"ttlMs": 5},
])
def test_bad_subscriptions_are_invalid_params(client, workspace, chatgpt, bad):
    _add_dot(client, workspace)
    key = _key(_setup(client, workspace))
    error = _subscribe(client, key, **bad)["error"]
    assert error["code"] == -32602
    assert chatgpt.posts == []


def test_unsubscribe_stops_delivery(client, workspace, chatgpt, db):
    _add_dot(client, workspace)
    key = _key(_setup(client, workspace))
    _subscribe(client, key)
    r = _mcp(client, key, "events/unsubscribe", {
        "name": "message.created", "arguments": {"bot": "dot"}, "delivery": {"mode": "webhook", "url": CALLBACK},
    }).json()
    assert r["result"] == {}
    assert _setup(client, workspace)["subscribed"] is False
    with pytest.raises(AgentRunError, match="isn't subscribed"):
        asyncio.run(dots.invoke_dots_agent(db, workspace["id"], _trigger(db, workspace), _cfg(db), 0))


def test_a_mention_is_an_event_the_dot_answers_through_its_tools(client, workspace, chatgpt, db, monkeypatch):
    _add_dot(client, workspace)
    key = _key(_setup(client, workspace))
    sub_id = _subscribe(client, key)["result"]["id"]
    event = _trigger(db, workspace)

    async def answered(*_a):
        return True

    monkeypatch.setattr(grok, "_answered", answered)
    asyncio.run(dots.invoke_dots_agent(db, workspace["id"], event, _cfg(db), 0))

    (sent,) = chatgpt.events
    post = chatgpt.posts[-1]
    assert post["url"] == CALLBACK and post["secret"] == SECRET and post["sub"] == sub_id
    assert post["id"] == sent["eventId"] and sent["cursor"] is None
    data = sent["data"]
    assert data["kind"] == "message" and data["bot"] == "dot" and "what changed?" in data["text"]

    thread = _call(client, key, "workspace_read_thread", {"reference": data["reference"]})
    assert thread["isError"] is False and "what changed?" in thread["content"][0]["text"]
    posted = _call(client, key, "workspace_post_reply", {"reference": data["reference"], "text": "Three things."})
    assert posted["isError"] is False
    db.expire_all()
    reply = db.execute(
        select(EventRecord).where(EventRecord.source == "openagents:dot", EventRecord.target == CHANNEL)
    ).scalar_one()
    assert reply.payload["content"] == "Three things."
    assert (reply.metadata_ or {}).get("in_reply_to") == event["id"]


def test_a_grok_reference_or_key_does_not_work_here(client, workspace, chatgpt, db):
    _add_dot(client, workspace)
    key = _key(_setup(client, workspace))
    grok_ref = grok._sign("grokbot-wake", {"a": _cfg(db).id, "c": CHANNEL, "t": 9_999_999_999})
    assert _call(client, key, "workspace_post_reply", {"reference": grok_ref, "text": "x"})["isError"] is True


def test_somebody_elses_key_cannot_subscribe_or_use_a_reference(client, workspace, chatgpt, db, monkeypatch):
    _add_dot(client, workspace, "dot")
    _add_dot(client, workspace, "their-dot")
    member = db.execute(select(WorkspaceMember).where(WorkspaceMember.agent_name == "their-dot")).scalar_one()
    member.owner_email = "someone-else@pace6.tech"
    db.commit()
    mine, theirs = _key(_setup(client, workspace, "dot")), _key(_setup(client, workspace, "their-dot"))
    assert mine != theirs
    assert _subscribe(client, theirs, bot="dot")["error"]["code"] == -32602

    _subscribe(client, mine)

    async def answered(*_a):
        return True

    monkeypatch.setattr(grok, "_answered", answered)
    asyncio.run(dots.invoke_dots_agent(db, workspace["id"], _trigger(db, workspace), _cfg(db), 0))
    ref = chatgpt.events[0]["data"]["reference"]
    assert _call(client, theirs, "workspace_post_reply", {"reference": ref, "text": "hi"})["isError"] is True


def test_the_test_button_sends_a_challenge_the_dot_hands_back(client, workspace, chatgpt):
    _add_dot(client, workspace)
    key = _key(_setup(client, workspace))
    r = client.post("/v1/dots/dot/test", headers=_headers(workspace), json={"network": workspace["id"]})
    assert r.status_code == 400 and "isn't subscribed" in r.json()["message"]

    _subscribe(client, key)
    r = client.post("/v1/dots/dot/test", headers=_headers(workspace), json={"network": workspace["id"]})
    assert r.status_code == 200, r.text
    (sent,) = chatgpt.events
    assert sent["data"]["kind"] == "verify"
    assert _call(client, key, "workspace_ack", {"challenge": sent["data"]["challenge"]})["isError"] is False
    assert _call(client, key, "workspace_ack", {"challenge": sent["data"]["challenge"] + "x"})["isError"] is True


def test_a_gone_subscription_is_dropped(client, workspace, chatgpt, db):
    _add_dot(client, workspace)
    _subscribe(client, _key(_setup(client, workspace)))
    chatgpt.status = 410
    with pytest.raises(AgentRunError, match="isn't subscribed"):
        asyncio.run(dots.send_verify(db, _cfg(db)))
    assert _setup(client, workspace)["subscribed"] is False


def test_signature_is_standard_webhooks():
    body = b'{"a":1}'
    sig = dots._signature(SECRET, "evt_1", 1700000000, body)
    expected = base64.b64encode(
        hmac.new(b"k" * 32, b"evt_1.1700000000." + body, hashlib.sha256).digest()
    ).decode()
    assert sig == "v1," + expected
