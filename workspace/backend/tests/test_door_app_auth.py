"""The phone app through the door: a code bound to the app's verifier, traded for a session."""

import base64
import hashlib

import pytest

from app.config import config
from app.routers import door_auth

VERIFIER = "v" * 20 + "0123456789abcdefghijklmnop"  # 46 characters, PKCE alphabet
CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).rstrip(b"=").decode()
DOOR = {"X-Forwarded-Email": "Somchai@Team.test"}


@pytest.fixture(autouse=True)
def door(monkeypatch):
    monkeypatch.setattr(config, "DOOR_EMAIL_HEADER", "X-Forwarded-Email")
    monkeypatch.setattr(config, "WORKSPACE_SESSION_SECRET", "test-secret-0123456789abcdef0123")


def _code(client):
    r = client.post("/door/app-code", json={"challenge": CHALLENGE}, headers=DOOR)
    assert r.status_code == 200, r.text
    return r.json()["data"]["code"]


def test_the_app_gets_a_session_for_the_person_the_door_signed_in(client):
    r = client.post("/v1/auth/app-session", json={"code": _code(client), "verifier": VERIFIER})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["email"] == "somchai@team.test"
    me = client.get("/v1/workspaces", headers={"Authorization": f"Bearer {data['session_token']}"})
    assert me.status_code == 200, me.text


def test_a_code_without_its_verifier_is_worth_nothing(client):
    code = _code(client)
    other = "w" * 46
    assert client.post("/v1/auth/app-session", json={"code": code, "verifier": other}).status_code == 401


def test_a_tampered_or_stale_code_is_refused(client):
    code = _code(client)
    body, mac = code.split(".")
    assert client.post("/v1/auth/app-session", json={"code": body + "x." + mac, "verifier": VERIFIER}).status_code == 401
    old = door_auth.sign_app_code("somchai@team.test", CHALLENGE, now=0)
    assert client.post("/v1/auth/app-session", json={"code": old, "verifier": VERIFIER}).status_code == 401


def test_no_code_without_the_door(client):
    assert client.post("/door/app-code", json={"challenge": CHALLENGE}).status_code == 401
    bad = client.post("/door/app-code", json={"challenge": "!" * 43}, headers=DOOR)
    assert bad.status_code == 400


def test_nothing_on_a_deployment_without_a_door(client, monkeypatch):
    monkeypatch.setattr(config, "DOOR_EMAIL_HEADER", "")
    assert client.post("/door/app-code", json={"challenge": CHALLENGE}, headers=DOOR).status_code == 404
    code = door_auth.sign_app_code("somchai@team.test", CHALLENGE)
    assert client.post("/v1/auth/app-session", json={"code": code, "verifier": VERIFIER}).status_code == 404
