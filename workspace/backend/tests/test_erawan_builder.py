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
    monkeypatch.setattr(config, "ERAWAN_BUILDER_THREAD_AGENTS", "")
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


def test_no_workspace_set_is_said_plainly(client, builder, monkeypatch):
    monkeypatch.setattr(config, "ERAWAN_BUILDER_WORKSPACE", "")
    r = client.post("/v1/erawan/builder/jobs", headers=KEY, json={"job": 1, "title": "t", "text": "x"})
    assert r.status_code == 503
