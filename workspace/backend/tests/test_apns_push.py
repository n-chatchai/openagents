# -*- coding: utf-8 -*-
"""Raw APNs registrations (Pixel Team): sent straight to Apple, under the signed-in person's email."""

import json

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app import access
from app.config import config
from app.services import apns_client, push
from app.services.fcm_client import PushAlert


@pytest.fixture
def apns_key(monkeypatch):
    pem = ec.generate_private_key(ec.SECP256R1()).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    monkeypatch.setattr(config, "APNS_KEY", pem)
    monkeypatch.setattr(config, "APNS_KEY_ID", "KEY1234567")
    monkeypatch.setattr(config, "APNS_TEAM_ID", "TEAM123456")
    monkeypatch.setattr(config, "APNS_TOPIC", "cloud.erawan.pixelteam")
    apns_client._jwt_cache.update(token="", at=0.0)


def _apple(answers):
    """A stand-in for Apple: `answers` maps (host, token) to (status, reason)."""
    seen = []

    def handler(request: httpx.Request):
        token = request.url.path.rsplit("/", 1)[-1]
        seen.append((request.url.host, token, request.headers, json.loads(request.content)))
        status, reason = answers.get((request.url.host, token), (200, ""))
        body = json.dumps({"reason": reason}).encode() if reason else b""
        return httpx.Response(status, content=body, headers={"apns-id": "id-" + token})

    return httpx.Client(transport=httpx.MockTransport(handler)), seen


class TestApnsClient:
    def test_unconfigured_sends_nothing(self, monkeypatch):
        monkeypatch.setattr(config, "APNS_KEY", "")
        report = apns_client.send_report(["tok"], PushAlert("t", "b"), {})
        assert not report.configured and report.sent_ok == [] and report.dead_tokens == []

    def test_sends_to_production_with_expo_data(self, apns_key):
        client, seen = _apple({})
        report = apns_client.send_report(
            ["tokA"], PushAlert("Grok", "done", thread_id="sales"), {"reason": "chat", "channel": "sales"}, client
        )
        assert report.sent_ok == ["tokA"] and report.dead_tokens == []
        host, _, headers, payload = seen[0]
        assert host == "api.push.apple.com"
        assert headers["apns-topic"] == "cloud.erawan.pixelteam"
        assert headers["authorization"].startswith("bearer ")
        assert payload["aps"]["alert"] == {"title": "Grok", "body": "done"}
        assert payload["aps"]["thread-id"] == "sales"
        # expo-notifications reads a remote notification's data from `body`.
        assert payload["body"] == {"reason": "chat", "channel": "sales"}

    def test_a_sandbox_token_is_retried_in_the_sandbox(self, apns_key):
        client, seen = _apple({("api.push.apple.com", "dev"): (400, "BadDeviceToken")})
        report = apns_client.send_report(["dev"], PushAlert("t", "b"), {}, client)
        assert report.sent_ok == ["dev"]
        assert [s[0] for s in seen] == ["api.push.apple.com", "api.sandbox.push.apple.com"]

    def test_a_removed_app_is_a_dead_token(self, apns_key):
        client, _ = _apple({("api.push.apple.com", "gone"): (410, "Unregistered")})
        report = apns_client.send_report(["gone"], PushAlert("t", "b"), {}, client)
        assert report.dead_tokens == ["gone"] and report.sent_ok == []


class TestTransportSplit:
    def test_apns_devices_go_to_apple_and_the_rest_to_fcm(self, monkeypatch):
        calls = {}
        monkeypatch.setattr(push, "send_push", lambda t, a, d: (calls.setdefault("fcm", t), ["f-dead"]))
        monkeypatch.setattr(push.apns_client, "send_push", lambda t, a, d: (calls.setdefault("apns", t), ["a-dead"]))

        class D:
            def __init__(self, token, kind):
                self.fcm_token, self.device_type = token, kind

        dead = push.send_to_devices([D("f1", "android"), D("a1", "apns"), D("f2", "ios")], PushAlert("t", "b"), {})
        assert calls == {"fcm": ["f1", "f2"], "apns": ["a1"]}
        assert sorted(dead) == ["a-dead", "f-dead"]


class TestRegisterUnderOwnEmail:
    def _signed_in(self, monkeypatch, email):
        monkeypatch.setattr(access, "verify_identity_claims", lambda tok: {"email": email} if tok == "me" else None)
        return {"Authorization": "Bearer me"}

    def test_a_person_cannot_register_under_someone_elses_email(self, client, workspace, db, monkeypatch):
        from app.models import DeviceToken

        h = self._signed_in(monkeypatch, "test@example.com")
        r = client.post("/v1/devices/register", json={
            "network": workspace["id"], "fcm_token": "APNS-1", "device_type": "apns",
            "user_email": "boss@example.com",
        }, headers=h)
        assert r.status_code == 200, r.text
        row = db.query(DeviceToken).filter_by(fcm_token="APNS-1").one()
        assert row.user_email == "test@example.com"
        assert row.device_type == "apns"

    def test_a_machine_caller_may_still_name_the_email(self, client, workspace, db):
        from app.models import DeviceToken

        r = client.post("/v1/devices/register", json={
            "network": workspace["id"], "fcm_token": "FCM-1", "device_type": "android",
            "user_email": "Someone@Example.com",
        }, headers={"X-Workspace-Token": workspace["token"]})
        assert r.status_code == 200, r.text
        assert db.query(DeviceToken).filter_by(fcm_token="FCM-1").one().user_email == "someone@example.com"


class TestPushCredentialsAreNotALogin:
    def test_firebase_tokens_are_refused_without_a_project_id(self, monkeypatch):
        from app import firebase_auth

        monkeypatch.setattr(config, "FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr(config, "FIREBASE_CREDENTIALS_JSON", '{"type": "service_account"}')
        called = []
        monkeypatch.setattr(firebase_auth, "_init_firebase", lambda: called.append(1) or True)
        assert firebase_auth.verify_firebase_token("any.firebase.token") is None
        assert called == []
