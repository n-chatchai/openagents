"""A bot the workspace runs is working in a room while its run is open (app/services/bot_presence.py)."""

import asyncio
import uuid

from app.models import CloudAgentConfig, WorkspaceMember
from app.services import bot_presence, cloud_agent


def _bot(db, ws):
    db.add(WorkspaceMember(workspace_id=ws["id"], agent_name="pixa", agent_type="cloud:changbot", status="online"))
    db.add(CloudAgentConfig(id=str(uuid.uuid4()), workspace_id=ws["id"], agent_name="pixa", provider="changbot",
                            model="changbot", api_key="k"))
    db.commit()


def _state(db, ws):
    db.expire_all()
    m = db.get(WorkspaceMember, (ws["id"], "pixa"))
    return m.presence_state, list(m.busy_channels or [])


def _event(room="channel/sales"):
    return {"id": "e1", "target": room, "source": "human:a@b.test", "payload": {"content": "@pixa hi"},
            "metadata": {"target_agents": ["pixa"]}}


def test_working_in_the_room_while_the_run_is_open_then_idle(workspace, db, monkeypatch):
    _bot(db, workspace)
    seen = []

    async def run(_db, wid, event, cfg, depth):
        seen.append(_state(db, workspace))

    monkeypatch.setattr(cloud_agent, "_invoke_single", run)
    asyncio.run(cloud_agent._invoke_cloud_agents(workspace["id"], _event()))
    assert seen == [("working", ["sales"])]
    assert _state(db, workspace) == ("idle", [])


def test_a_failed_run_is_not_left_working(workspace, db, monkeypatch):
    _bot(db, workspace)

    async def run(*_a):
        raise RuntimeError("down")

    async def quiet(*_a, **_k):
        return None

    monkeypatch.setattr(cloud_agent, "_invoke_single", run)
    monkeypatch.setattr(cloud_agent, "_post_error_message", quiet)
    asyncio.run(cloud_agent._invoke_cloud_agents(workspace["id"], _event()))
    assert _state(db, workspace) == ("idle", [])


def test_two_rooms_at_once_stay_working_until_both_end(workspace, db):
    _bot(db, workspace)
    bot_presence.mark(workspace["id"], "pixa", "a", True)
    bot_presence.mark(workspace["id"], "pixa", "b", True)
    bot_presence.mark(workspace["id"], "pixa", "a", False)
    assert _state(db, workspace) == ("working", ["b"])
    bot_presence.mark(workspace["id"], "pixa", "b", False)
    assert _state(db, workspace) == ("idle", [])


def test_a_restart_clears_what_a_stopped_run_left(workspace, db):
    _bot(db, workspace)
    bot_presence.mark(workspace["id"], "pixa", "a", True)
    bot_presence.clear_cloud()
    assert _state(db, workspace) == ("idle", [])
