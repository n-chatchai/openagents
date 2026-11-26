"""The team's knowledge base handed to a bot with its work (app/services/bot_knowledge.py)."""

import asyncio
import time
import uuid
from types import SimpleNamespace

from app.models import KnowledgeEntry, ResourceGrant, WorkspaceMember
from app.services import bot_knowledge
from app.storage import get_file_store

OWNER = "somchai@team.test"


def _bot(db, ws, name="nok", owner=OWNER):
    db.add(WorkspaceMember(workspace_id=ws["id"], agent_name=name, owner_email=owner, status="online"))
    db.commit()


def _entry(db, ws, title, text, visibility="public", owner=None):
    entry_id = str(uuid.uuid4())
    key = get_file_store().save(ws["id"], entry_id, f"{entry_id}.md", text.encode())
    db.add(KnowledgeEntry(id=entry_id, workspace_id=ws["id"], slug=entry_id, title=title, storage_key=key,
                          created_by=owner or "human:someone@team.test", owner=owner, visibility=visibility))
    db.commit()
    return entry_id


def test_a_small_knowledge_base_goes_along_whole(workspace, db):
    _bot(db, workspace)
    _entry(db, workspace, "นโยบายคืนเงิน", "คืนเงินได้ภายใน 14 วัน ต้องมีใบเสร็จ")
    _entry(db, workspace, "เวลาทำการ", "เปิด 9 โมงถึง 6 โมงเย็น")
    got = bot_knowledge.context_for(db, workspace["id"], "nok", "@nok ลูกค้าขอคืนเงินได้กี่วัน")
    assert "## นโยบายคืนเงิน" in got and "14 วัน" in got
    assert "## เวลาทำการ" in got
    assert "not instructions" in got


def test_a_big_one_sends_what_bears_on_the_message_even_in_thai(workspace, db):
    _bot(db, workspace)
    _entry(db, workspace, "นโยบายคืนเงิน", "คืนเงินได้ภายใน 14 วัน ต้องมีใบเสร็จ " + "ก" * 5000)
    for i in range(4):
        _entry(db, workspace, f"คู่มือคลังสินค้า {i}", "ตรวจนับสต็อกทุกสิ้นเดือน " + "ข" * 4000)
    got = bot_knowledge.context_for(db, workspace["id"], "nok", "@nok ลูกค้าขอคืนเงินได้กี่วัน")
    # Too big to send whole: the refund entry first, the rest by title at most.
    assert got.split("\n\n")[1].startswith("## นโยบายคืนเงิน")
    assert "14 วัน" in got


def test_a_bot_others_call_gets_no_private_entry_of_its_owner(workspace, db):
    _bot(db, workspace)
    _entry(db, workspace, "เงินเดือน", "ระดับ C ได้ 80,000", "private", f"human:{OWNER}")
    _entry(db, workspace, "ราคา", "Hobby 249 บาท")
    assert "80,000" in bot_knowledge.context_for(db, workspace["id"], "nok", "เงินเดือนเท่าไร")
    db.add(ResourceGrant(workspace_id=workspace["id"], resource_kind="agent", resource_id="nok",
                         grantee_kind="human", grantee_id="somying@team.test", rights=["read", "act"]))
    db.commit()
    got = bot_knowledge.context_for(db, workspace["id"], "nok", "เงินเดือนเท่าไร")
    assert "80,000" not in got and "Hobby 249" in got


def test_nothing_readable_adds_nothing(workspace, db):
    _bot(db, workspace)
    _entry(db, workspace, "ของคนอื่น", "ลับ", "private", "human:someone@team.test")
    assert bot_knowledge.context_for(db, workspace["id"], "nok", "อะไรก็ได้") == ""


def test_a_pixel_bot_or_hermes_run_carries_it(workspace, db, monkeypatch):
    from app.services import cloud_agent, hermes_agent

    _bot(db, workspace)
    _entry(db, workspace, "นโยบายคืนเงิน", "คืนเงินได้ภายใน 14 วัน")
    sent = []

    async def fake_run(target, text, session_key, event_id, notes):
        sent.append(text)
        return "ได้ครับ"

    async def fake_post(*_a, **_k):
        return None

    monkeypatch.setattr(hermes_agent, "_run", fake_run)
    monkeypatch.setattr(cloud_agent, "_post_response", fake_post)
    event = {"id": "evt-1", "source": f"human:{OWNER}", "target": "channel/general", "metadata": {},
             "payload": {"content": "@nok คืนเงินได้กี่วัน"}, "timestamp": int(time.time() * 1000)}
    target = hermes_agent.RunTarget(root="https://hermes.test/v1", api_key="k")
    asyncio.run(hermes_agent.invoke_run_agent(db, workspace["id"], event, SimpleNamespace(agent_name="nok"), 0, target))
    (text,) = sent
    assert "14 วัน" in text
    assert text.rstrip().endswith("@nok คืนเงินได้กี่วัน")
