# -*- coding: utf-8 -*-
"""A bot removed from a workspace leaves its rooms too."""

from sqlalchemy import select

from app.models import Channel, ChannelMember, WorkspaceMember


def _room_with(db, workspace, *agents):
    ch = db.execute(select(Channel).where(Channel.workspace_id == workspace["id"])).scalars().first()
    for a in agents:
        if not db.get(ChannelMember, {"channel_id": ch.id, "agent_name": a}):
            db.add(ChannelMember(channel_id=ch.id, agent_name=a))
    ch.master_agent = agents[0]
    db.commit()
    return ch


def test_removing_a_bot_takes_it_out_of_every_room(client, workspace, db):
    db.add(WorkspaceMember(workspace_id=workspace["id"], agent_name="rox", status="offline"))
    db.commit()
    ch = _room_with(db, workspace, "rox", "agent-alpha")
    r = client.delete(f"/v1/workspaces/{workspace['id']}/members/rox", headers={"X-Workspace-Token": workspace["token"]})
    assert r.status_code == 200, r.text
    db.expire_all()
    names = {m.agent_name for m in db.execute(select(ChannelMember).where(ChannelMember.channel_id == ch.id)).scalars()}
    assert "rox" not in names and "agent-alpha" in names
    assert db.get(Channel, ch.id).master_agent == "agent-alpha"
