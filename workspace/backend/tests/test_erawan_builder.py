"""Erawan Builder's door: the control plane opens a website job's thread and adds lines to it."""

import pytest
from sqlalchemy import select

from app.config import config
from app.models import Channel, EventRecord
from tests.conftest import acting_api

KEY = {"Authorization": "Bearer builder-key"}


@pytest.fixture
def builder(workspace, monkeypatch):
    acting_api(workspace["id"], "owner@team.test", "owner")
    monkeypatch.setattr(config, "ERAWAN_BUILDER_KEY", "builder-key")
    monkeypatch.setattr(config, "ERAWAN_BUILDER_WORKSPACE", workspace["slug"])
    monkeypatch.setattr(config, "ERAWAN_BUILDER_OWNER", "owner@team.test")
    # The workspace's starter agent stands in for Erawan Builder.
    monkeypatch.setattr(config, "ERAWAN_BUILDER_AGENT", "agent-alpha")
    return workspace


def _messages(db, workspace_id, channel):
    return db.execute(select(EventRecord).where(EventRecord.network_id == workspace_id, EventRecord.target == channel,
                                          EventRecord.type == "workspace.message.posted")).scalars().all()


def test_a_job_opens_a_thread_with_the_brief_in_it(client, db, builder):
    r = client.post("/v1/erawan/builder/jobs", headers=KEY,
                    json={"job": 12, "title": "งานเว็บ #12 · ไฟดี", "text": "ธุรกิจ: ติดตั้งที่ชาร์จ EV"})
    assert r.status_code == 200, r.text
    channel = r.json()["channel"]
    assert channel.startswith("channel/")
    row = db.execute(select(Channel).where(Channel.name == channel[len("channel/"):])).scalar_one()
    assert row.title == "งานเว็บ #12 · ไฟดี"
    posted = _messages(db, builder["id"], channel)
    assert [(e.source, e.payload["content"]) for e in posted] == [("openagents:agent-alpha", "ธุรกิจ: ติดตั้งที่ชาร์จ EV")]
    # Posted waking nobody: the team decides who works it.
    assert posted[0].metadata_.get("explicit_targets") == []


def test_a_line_goes_into_the_jobs_thread(client, db, builder):
    channel = client.post("/v1/erawan/builder/jobs", headers=KEY,
                          json={"job": 3, "title": "งานเว็บ #3", "text": "โจทย์"}).json()["channel"]
    r = client.post("/v1/erawan/builder/jobs/messages", headers=KEY, json={"channel": channel, "text": "ลูกค้า: มีรูป 6 รูป"})
    assert r.status_code == 200, r.text
    assert [e.payload["content"] for e in _messages(db, builder["id"], channel)] == ["โจทย์", "ลูกค้า: มีรูป 6 รูป"]
    missing = client.post("/v1/erawan/builder/jobs/messages", headers=KEY, json={"channel": "channel/nope", "text": "x"})
    assert missing.status_code == 404


def test_the_key_is_the_door(client, builder, monkeypatch):
    body = {"job": 1, "title": "t", "text": "x"}
    assert client.post("/v1/erawan/builder/jobs", json=body).status_code == 401
    assert client.post("/v1/erawan/builder/jobs", json=body, headers={"Authorization": "Bearer nope"}).status_code == 401
    monkeypatch.setattr(config, "ERAWAN_BUILDER_KEY", "")
    assert client.post("/v1/erawan/builder/jobs", json=body, headers=KEY).status_code == 404


def test_the_workspace_is_named_by_slug_or_id(client, db, builder, monkeypatch):
    from app.routers import erawan_builder

    seen = []
    real = db.execute

    def spy(stmt, *a, **kw):
        seen.append(str(stmt))
        return real(stmt, *a, **kw)

    # A slug is never compared with the id column: Postgres refuses a non-UUID
    # there, which was a 500 on every job (SQLite here would let it pass).
    monkeypatch.setattr(db, "execute", spy)
    assert erawan_builder._workspace(db).id is not None
    assert "workspaces.id" not in seen[-1].split("WHERE", 1)[1]
    monkeypatch.setattr(config, "ERAWAN_BUILDER_WORKSPACE", str(builder["id"]))
    assert str(erawan_builder._workspace(db).id) == str(builder["id"])


def test_no_workspace_set_is_said_plainly(client, builder, monkeypatch):
    monkeypatch.setattr(config, "ERAWAN_BUILDER_WORKSPACE", "")
    r = client.post("/v1/erawan/builder/jobs", headers=KEY, json={"job": 1, "title": "t", "text": "x"})
    assert r.status_code == 503


def test_a_job_and_a_line_wake_the_worker_they_name(client, db, builder, monkeypatch):
    from app.services import cloud_agent
    seen = []

    async def post(db_, ws_id, channel, agent, text, depth, explicit_targets=None, **kw):
        seen.append((channel, agent, text, explicit_targets))

    monkeypatch.setattr(cloud_agent, "_post_response", post)
    r = client.post("/v1/erawan/builder/jobs", headers=KEY,
                    json={"job": 7, "title": "งานเว็บ #7", "text": "@agent-alpha ทำเว็บ", "wake": ["agent-alpha"]})
    assert r.status_code == 200, r.text
    channel = r.json()["channel"]
    assert seen[-1] == (channel, "agent-alpha", "@agent-alpha ทำเว็บ", ["agent-alpha"])
    row = db.execute(select(Channel).where(Channel.name == channel[len("channel/"):])).scalar_one()
    assert "agent-alpha" in [m.agent_name for m in (row.participants or [])]
    client.post("/v1/erawan/builder/jobs/messages", headers=KEY, json={"channel": channel, "text": "ลูกค้า: x"})
    assert seen[-1][3] == []
    client.post("/v1/erawan/builder/jobs/messages", headers=KEY,
                json={"channel": channel, "text": "@agent-alpha ลูกค้าขอแก้", "wake": ["agent-alpha"]})
    assert seen[-1][3] == ["agent-alpha"]


def test_the_workers_and_whether_they_are_online(client, db, builder, monkeypatch):
    from app.models import WorkspaceMember

    q = "/v1/erawan/builder/workers?names=agent-alpha,ghost"
    assert client.get(q).status_code == 401
    assert client.get("/v1/erawan/builder/workers", headers=KEY).json() == {"workers": []}
    r = client.get(q, headers=KEY).json()
    assert [w["name"] for w in r["workers"]] == ["agent-alpha", "ghost"]
    assert r["workers"][1]["online"] is False
    from app.routers import network
    monkeypatch.setattr(network, "effective_agent_status", lambda m, now=None: "online")
    r = client.get(q, headers=KEY).json()
    assert r["workers"][0]["online"] is True and r["workers"][1]["online"] is False


def test_a_workers_progress_line_is_sent_on_and_nothing_else(client, db, builder, monkeypatch):
    from app.routers import erawan_builder

    sent = []
    monkeypatch.setattr(config, "ERAWAN_BUILDER_PROGRESS_URL", "http://cp.test/progress")
    import httpx
    monkeypatch.setattr(httpx, "post", lambda url, **kw: sent.append((url, kw["json"], kw["headers"])))

    def event(**kw):
        base = {"type": "workspace.message.posted", "source": "openagents:builder-claude", "target": "channel/job-1",
                "payload": {"message_type": "status", "content": "ความคืบหน้า: วางแบบเสร็จ"}}
        base.update(kw)
        return base

    erawan_builder.forward_progress(str(builder["id"]), event())
    assert sent == [("http://cp.test/progress", {"channel": "channel/job-1", "agent": "builder-claude", "text": "วางแบบเสร็จ"},
                     {"Authorization": "Bearer builder-key"})]
    # Other status lines, chat lines, people, other workspaces: nothing.
    erawan_builder.forward_progress(str(builder["id"]), event(payload={"message_type": "status", "content": "Thinking…"}))
    erawan_builder.forward_progress(str(builder["id"]), event(payload={"message_type": "chat", "content": "ความคืบหน้า: x"}))
    erawan_builder.forward_progress(str(builder["id"]), event(source="human:a@b.c"))
    erawan_builder.forward_progress("another-workspace", event())
    assert len(sent) == 1
