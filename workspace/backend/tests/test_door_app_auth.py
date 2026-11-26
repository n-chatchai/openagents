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


def test_app_start_goes_straight_back_to_the_app_with_a_code(client):
    r = client.get("/door/app-start", params={"challenge": CHALLENGE}, headers=DOOR, follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("pixelteam://auth?code=")
    from urllib.parse import parse_qs, urlparse
    code = parse_qs(urlparse(loc).query)["code"][0]
    ok = client.post("/v1/auth/app-session", json={"code": code, "verifier": VERIFIER})
    assert ok.status_code == 200 and ok.json()["data"]["email"] == "somchai@team.test"


def test_app_start_says_why_to_the_app_rather_than_to_a_page(client, monkeypatch):
    def where(**kw):
        return client.get("/door/app-start", follow_redirects=False, **kw).headers["location"]
    assert where(params={"challenge": CHALLENGE}) == "pixelteam://auth?error=not_signed_in"
    assert where(params={"challenge": "x"}, headers=DOOR) == "pixelteam://auth?error=bad_request"
    monkeypatch.setattr(config, "DOOR_EMAIL_HEADER", "")
    assert where(params={"challenge": CHALLENGE}, headers=DOOR) == "pixelteam://auth?error=no_door"



# Name and photo from the door's Google sign-in (oauth2-proxy --pass-access-token)

def _google(monkeypatch, info, status=200):
    asked = []

    class Answer:
        status_code = status

        def json(self):
            return info

    def fake_get(url, headers=None, timeout=None):
        asked.append((url, headers))
        return Answer()

    monkeypatch.setattr(door_auth.httpx, "get", fake_get)
    return asked


def _profile(db, email="somchai@team.test"):
    from sqlalchemy import select
    from app.models import User
    db.expire_all()
    return db.execute(select(User).where(User.email == email)).scalar_one_or_none()


def test_sign_in_keeps_the_google_name_and_photo(client, db, monkeypatch):
    asked = _google(monkeypatch, {"email": "somchai@team.test", "email_verified": True,
                                  "name": "Somchai Jaidee", "picture": "https://lh3.googleusercontent.com/a/x"})
    r = client.post("/door/app-code", json={"challenge": CHALLENGE}, headers={**DOOR, "X-Forwarded-Access-Token": "ya29.t"})
    assert r.status_code == 200, r.text
    assert asked[0][1] == {"Authorization": "Bearer ya29.t"}
    user = _profile(db)
    assert user.display_name == "Somchai Jaidee"
    assert user.avatar_url == "https://lh3.googleusercontent.com/a/x"


def test_a_photo_of_your_own_is_never_replaced(client, db, monkeypatch):
    from app.access import get_or_create_user
    get_or_create_user(db, {"email": "somchai@team.test", "email_verified": True,
                            "avatar_url": "data:image/jpeg;base64,AAAA"})
    db.commit()
    _google(monkeypatch, {"email": "somchai@team.test", "email_verified": True, "picture": "https://lh3.googleusercontent.com/a/x"})
    client.post("/door/session", headers={**DOOR, "X-Forwarded-Access-Token": "ya29.t"})
    assert _profile(db).avatar_url == "data:image/jpeg;base64,AAAA"


def test_a_token_for_somebody_else_keeps_nothing(client, db, monkeypatch):
    _google(monkeypatch, {"email": "mallory@team.test", "email_verified": True, "picture": "https://evil.example/p"})
    r = client.post("/door/session", headers={**DOOR, "X-Forwarded-Access-Token": "ya29.t"})
    assert r.status_code == 200, r.text
    user = _profile(db)
    assert user is None or user.avatar_url is None


def test_google_down_does_not_stop_sign_in(client, monkeypatch):
    def broken(*_a, **_k):
        raise door_auth.httpx.ConnectError("down")

    monkeypatch.setattr(door_auth.httpx, "get", broken)
    r = client.post("/door/app-code", json={"challenge": CHALLENGE}, headers={**DOOR, "X-Forwarded-Access-Token": "ya29.t"})
    assert r.status_code == 200, r.text
