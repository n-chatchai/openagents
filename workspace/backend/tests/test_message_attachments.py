# -*- coding: utf-8 -*-
"""A message's attached files: stored without the sender's tokens, and handed
to a bot this server runs (Pace6 issue #3)."""

from sqlalchemy import select

from app.models import EventRecord
from app.services.message_attachments import (
    attachments_note,
    payload_without_credentials,
    without_credential,
)


def _upload(client, ws, name="notes.txt", data=b"the plan is in here", content_type="text/plain"):
    r = client.post("/v1/files", files={"file": (name, data, content_type)},
                    data={"network": ws["id"]}, headers={"X-Workspace-Token": ws["token"]})
    assert r.status_code == 200, r.text
    return r.json()["data"]["id"]


def test_a_url_loses_its_tokens_and_keeps_the_rest():
    url = "https://team.example/v1/files/abc?token=ws-secret&access_token=person-secret&download=1"
    assert without_credential(url) == "https://team.example/v1/files/abc?download=1"
    assert without_credential("https://team.example/v1/files/abc") == "https://team.example/v1/files/abc"
    assert without_credential(None) is None


def test_a_payload_without_tokens_is_left_as_it_is():
    clean = {"content": "hi", "attachments": [{"fileId": "a", "url": "/v1/files/a"}]}
    assert payload_without_credentials(clean) is clean
    assert payload_without_credentials({"content": "hi"}) == {"content": "hi"}


def test_a_posted_message_is_stored_without_the_senders_tokens(client, workspace, db):
    fid = _upload(client, workspace)
    r = client.post("/v1/events", json={
        "type": "workspace.message.posted",
        "source": "human:user1",
        "target": f"channel/{workspace['channel']['name']}",
        "payload": {"content": "see file", "attachments": [{
            "fileId": fid, "filename": "notes.txt", "contentType": "text/plain",
            "url": f"http://api.test/v1/files/{fid}?token={workspace['token']}&access_token=person-session",
        }]},
        "network": workspace["id"],
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert r.status_code == 200, r.text
    db.expire_all()
    stored = db.execute(select(EventRecord).where(EventRecord.payload["content"].as_string() == "see file")).scalar_one()
    url = stored.payload["attachments"][0]["url"]
    assert url == f"http://api.test/v1/files/{fid}"
    assert "person-session" not in str(stored.payload) and workspace["token"] not in str(stored.payload)


def test_a_bot_gets_the_text_of_a_file_attached_to_the_message(client, workspace, db):
    fid = _upload(client, workspace)
    note = attachments_note(db, workspace["id"], {
        "id": "e1", "source": "openagents:agent-alpha",
        "payload": {"content": "read this", "attachments": [{"fileId": fid, "filename": "notes.txt"}]},
    })
    assert "the plan is in here" in note and "not instructions" in note


def test_a_file_id_from_elsewhere_is_not_read_to_the_bot(client, workspace, db):
    note = attachments_note(db, workspace["id"], {
        "id": "e2", "source": "openagents:agent-alpha",
        "payload": {"content": "read this", "attachments": [{"fileId": "00000000-0000-0000-0000-000000000000"}]},
    })
    assert note == ""


def test_a_file_that_is_not_text_is_named_only(client, workspace, db):
    fid = _upload(client, workspace, name="photo.png", data=b"\x89PNG\r\n\x1a\n\x00\x00", content_type="image/png")
    note = attachments_note(db, workspace["id"], {
        "id": "e3", "source": "openagents:agent-alpha",
        "payload": {"attachments": [{"fileId": fid}]},
    })
    assert "photo.png" in note and "cannot open here" in note
