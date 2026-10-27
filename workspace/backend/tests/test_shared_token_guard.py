"""SHARED_TOKEN_NEEDS_PERSON: the workspace's shared token opens nothing alone."""

import uuid

import pytest

from app.config import config
from app.models import Node, Workspace
from app import shared_token_guard

PERSON = "test@example.com"
SECRET = "test-secret-0123456789abcdef-0123456789"


def _set(monkeypatch, name, value):
    # Some suites swap the config object a module holds: set it where it is read.
    from app import firebase_auth
    from app.routers import door_auth

    for holder in {id(c): c for c in (config, firebase_auth.config, door_auth.config)}.values():
        monkeypatch.setattr(holder, name, value)


@pytest.fixture
def guard_on(monkeypatch, db):
    from tests.conftest import TestingSessionLocal

    monkeypatch.setenv("SHARED_TOKEN_NEEDS_PERSON", "1")
    _set(monkeypatch, "WORKSPACE_SESSION_SECRET", SECRET)

    def tokens():
        session = TestingSessionLocal()
        try:
            return [w.password_hash for w in session.query(Workspace).all()]
        finally:
            session.close()

    monkeypatch.setattr(shared_token_guard.SharedTokenGuard, "_load_from_db", staticmethod(tokens))


def _session_for(email):
    from app.firebase_auth import mint_workspace_session

    token, _ = mint_workspace_session({"email": email, "display_name": None, "email_verified": True})
    return token


def _list(client, ws, headers):
    return client.get("/v1/cloud-agents", params={"network": ws["id"]}, headers=headers)


def test_off_by_default_the_token_works_alone(client, workspace):
    assert _list(client, workspace, {"X-Workspace-Token": workspace["token"]}).status_code == 200


def test_the_token_alone_is_refused(client, workspace, guard_on):
    r = _list(client, workspace, {"X-Workspace-Token": workspace["token"]})
    assert r.status_code == 403
    assert "signed-in person" in r.json()["message"]


def test_the_token_in_the_query_or_body_is_refused_too(client, workspace, guard_on):
    assert client.get(f"/v1/files/{uuid.uuid4()}", params={"token": workspace["token"]}).status_code == 403
    assert client.post("/v1/token/resolve", json={"token": workspace["token"]}).status_code == 403


def test_a_signed_in_person_with_the_token_gets_in(client, workspace, guard_on):
    headers = {"X-Workspace-Token": workspace["token"], "Authorization": f"Bearer {_session_for(PERSON)}"}
    assert _list(client, workspace, headers).status_code == 200


def test_a_made_up_bearer_does_not_count_as_a_person(client, workspace, guard_on):
    headers = {"X-Workspace-Token": workspace["token"], "Authorization": "Bearer not-a-session"}
    assert _list(client, workspace, headers).status_code == 403


def test_a_device_token_still_works(client, workspace, db, guard_on):
    node = Node(workspace_id=workspace["id"], node_key="laptop-1", owner_email=PERSON, token="device-" + "x" * 40)
    db.add(node)
    db.commit()
    r = client.post("/v1/nodes/heartbeat", headers={"X-Workspace-Token": node.token}, json={"node_id": str(node.id)})
    assert r.status_code != 403, r.text


def test_a_request_without_the_token_passes_untouched(client, guard_on):
    r = client.post("/v1/workspaces", json={"name": "Another"})
    assert r.status_code == 200


def test_a_brand_new_workspaces_token_is_refused_at_once(client, guard_on):
    made = client.post("/v1/workspaces", json={"name": "Fresh"}).json()["data"]
    r = client.get("/v1/cloud-agents", params={"network": made["workspaceId"]}, headers={"X-Workspace-Token": made["token"]})
    assert r.status_code == 403


def test_a_link_in_the_referer_or_a_cookie_is_not_a_credential(client, workspace, guard_on):
    page = f"https://pace6.erawan.cloud/{workspace['slug']}?token={workspace['token']}"
    r = client.post("/v1/workspaces", json={"name": "Another"},
                    headers={"Referer": page, "Cookie": f"oa_workspace={workspace['token']}"})
    assert r.status_code == 200


def test_the_door_session_moved_out_of_v1(client, monkeypatch):
    _set(monkeypatch, "DOOR_EMAIL_HEADER", "X-Forwarded-Email")
    _set(monkeypatch, "WORKSPACE_SESSION_SECRET", SECRET)
    assert client.post("/v1/auth/door-session", headers={"X-Forwarded-Email": PERSON}).status_code == 404
    r = client.post("/door/session", headers={"X-Forwarded-Email": PERSON})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["email"] == PERSON
