"""The room note: who is in the thread, whose bot is whose, who is asking."""

import uuid

from app.models import Channel, ChannelHumanMember, ChannelMember, User, WorkspaceMember, WorkspaceMembership
from app.services.room_roster import room_note, verified_sender

SOMCHAI = "somchai@team.test"
SOMYING = "somying@team.test"
OUTSIDER = "outsider@team.test"


def _person(db, ws_id, email, name):
    user = User(email=email, display_name=name)
    db.add(user)
    db.flush()
    db.add(WorkspaceMembership(workspace_id=ws_id, user_id=user.id, role="member"))


def _bot(db, ws_id, channel, name, owner, display=None):
    member = db.get(WorkspaceMember, (ws_id, name))
    if member is None:
        member = WorkspaceMember(workspace_id=ws_id, agent_name=name)
        db.add(member)
    member.owner_email, member.display_name, member.status = owner, display, "online"
    db.add(ChannelMember(channel_id=channel.id, agent_name=name))


def _room(db, workspace, visibility="public"):
    ws_id = workspace["id"]
    channel = Channel(id=str(uuid.uuid4()), workspace_id=ws_id, name="sales", title="ยอดขาย",
                      visibility=visibility, owner_email=SOMCHAI)
    db.add(channel)
    _person(db, ws_id, SOMCHAI, "สมชาย")
    _person(db, ws_id, SOMYING, "สมหญิง")
    _bot(db, ws_id, channel, "nok", SOMCHAI, "นก")
    _bot(db, ws_id, channel, "grok", SOMYING, "Grok")
    db.commit()
    return channel


def _human(email):
    return f"human:{email}", {"acting_for": email}


def test_the_owner_calling_is_named_as_the_owner(workspace, db):
    _room(db, workspace)
    note = room_note(db, workspace["id"], "channel/sales", "nok", *_human(SOMCHAI))
    assert "Who is in this room (#ยอดขาย):" in note
    assert "สมชาย (your owner)" in note and "สมหญิง" in note
    assert "นก (you, owned by สมชาย)" in note and "Grok (owned by สมหญิง)" in note
    assert note.endswith("This message is from สมชาย, your owner.")


def test_a_teammate_calling_is_not_the_owner(workspace, db):
    _room(db, workspace)
    note = room_note(db, workspace["id"], "sales", "nok", *_human(SOMYING))
    assert note.endswith("This message is from สมหญิง, a teammate, not your owner.")


def test_no_email_address_reaches_the_bot(workspace, db):
    _room(db, workspace)
    note = room_note(db, workspace["id"], "channel/sales", "grok", *_human(SOMCHAI))
    assert "@" not in note


def test_a_sender_the_server_did_not_stamp_is_not_believed(workspace, db):
    _room(db, workspace)
    # A machine declaring itself the owner, with no server-stamped acting_for.
    note = room_note(db, workspace["id"], "channel/sales", "nok", f"human:{SOMCHAI}", {})
    assert note.endswith("Who sent this message is not verified.")
    assert verified_sender(f"human:{SOMCHAI}", {"acting_for": SOMYING}) is None


def test_another_bot_calling_is_named_with_its_owner(workspace, db):
    _room(db, workspace)
    note = room_note(db, workspace["id"], "channel/sales", "grok", "openagents:nok", {})
    assert note.endswith("This message is from the bot นก (owned by สมชาย).")


def test_a_private_room_lists_only_its_participants(workspace, db):
    channel = _room(db, workspace, visibility="private")
    _person(db, workspace["id"], OUTSIDER, "คนนอก")
    db.add(ChannelHumanMember(channel_id=channel.id, user_email=SOMYING))
    db.commit()
    note = room_note(db, workspace["id"], "channel/sales", "nok", *_human(SOMYING))
    assert "สมชาย (your owner), สมหญิง" in note
    assert "คนนอก" not in note


def test_no_note_outside_a_thread(workspace, db):
    assert room_note(db, workspace["id"], "dm:somebody", "nok", *_human(SOMCHAI)) == ""


def test_a_hermes_run_starts_with_the_room_note(workspace, db, monkeypatch):
    import asyncio
    import time
    from types import SimpleNamespace

    from app.services import cloud_agent, hermes_agent

    _room(db, workspace)
    sent, posted = [], []

    async def fake_run(target, text, session_key, event_id, notes):
        sent.append(text)
        return "done"

    async def fake_post(db_, ws, channel, agent, text, depth, **_k):
        posted.append(text)

    monkeypatch.setattr(hermes_agent, "_run", fake_run)
    monkeypatch.setattr(cloud_agent, "_post_response", fake_post)
    source, metadata = _human(SOMYING)
    event = {"id": "evt-1", "source": source, "target": "channel/sales", "metadata": metadata,
             "payload": {"content": "@nok สรุปยอดขาย"}, "timestamp": int(time.time() * 1000)}
    cfg = SimpleNamespace(agent_name="nok")
    target = hermes_agent.RunTarget(root="https://hermes.test/v1", api_key="k")
    asyncio.run(hermes_agent.invoke_run_agent(db, workspace["id"], event, cfg, 0, target))

    (text,) = sent
    assert text.startswith("Who is in this room (#ยอดขาย):")
    assert "This message is from สมหญิง, a teammate, not your owner." in text
    assert text.rstrip().endswith("@nok สรุปยอดขาย")
    assert posted == ["done"]


def test_facts_for_erawans_own_platform_carry_verified_addresses(workspace, db):
    from app.services.room_roster import room_facts
    _room(db, workspace)
    facts = room_facts(db, workspace["id"], "channel/sales", "nok", *_human(SOMYING))
    assert facts["room"] == "sales" and facts["workspace"] == workspace["id"]
    assert facts["room_title"] == "ยอดขาย" and facts["agent_display"] == "นก"
    assert facts["requester_email"] == SOMYING and facts["owner_email"] == SOMCHAI
    assert set(facts["people"]) == {SOMCHAI, SOMYING}
    # An unstamped sender is nobody the platform may trust.
    assert room_facts(db, workspace["id"], "channel/sales", "nok", f"human:{SOMCHAI}", {})["requester_email"] is None


def _platform_run(monkeypatch, workspace, db, token, ops=False):
    import asyncio
    import time
    from types import SimpleNamespace

    from app.services import changbot_agent, cloud_agent, hermes_agent

    bodies = []

    class Resp:
        status_code = 202
        def json(self):
            return {"run_id": "r1"}

    class Client:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, url, headers=None, json=None):
            bodies.append((url, json))
            return Resp()

    async def follow(*a, **k):
        return ("completed", "ok", None)

    async def fake_post(*a, **k):
        return None

    monkeypatch.setattr(hermes_agent.httpx, "AsyncClient", Client)
    monkeypatch.setattr(hermes_agent, "_follow_stream", follow)
    monkeypatch.setattr(cloud_agent, "_post_response", fake_post)
    source, metadata = _human(SOMYING)
    event = {"id": "evt-9", "source": source, "target": "channel/sales", "metadata": metadata,
             "payload": {"content": "@nok สถานะ"}, "timestamp": int(time.time() * 1000)}
    cfg = SimpleNamespace(agent_name="nok", api_key=token)
    invoke = changbot_agent.invoke_erawanops_agent if ops else changbot_agent.invoke_changbot_agent
    asyncio.run(invoke(db, workspace["id"], event, cfg, 0))
    return bodies


def test_a_pixel_bot_connection_tells_the_gateway_the_room(workspace, db, monkeypatch):
    _room(db, workspace)
    ((url, body),) = _platform_run(monkeypatch, workspace, db, "pbc_token")
    assert "/v1/agent/runs" in url
    assert body["room"]["requester_email"] == SOMYING and SOMCHAI in body["room"]["people"]


def test_erawan_ops_runs_go_to_the_platforms_ops_door(workspace, db, monkeypatch):
    _room(db, workspace)
    ((url, body),) = _platform_run(monkeypatch, workspace, db, "eops_abc.def", ops=True)
    assert url.endswith("/internal/ops/workspace/v1/runs")
    assert body["room"]["people"] and body["session_key"]


def test_a_third_partys_hermes_gets_no_addresses(workspace, db, monkeypatch):
    from app.services import hermes_agent
    target = hermes_agent.RunTarget(root="https://hermes.test/v1", api_key="k")
    assert target.room_facts is False


def test_an_ops_key_in_the_pixel_bot_card_is_sent_to_the_right_card():
    import asyncio
    from app.services import changbot_agent
    why = asyncio.run(changbot_agent.probe("eops_abc.def"))
    assert why and "Erawan OPS card" in why
    assert "eops_" in asyncio.run(changbot_agent.probe_ops("pbc_token"))
