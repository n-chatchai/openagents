# -*- coding: utf-8 -*-
"""
Push straight to Apple's APNs, for apps that carry no Firebase SDK.

Every other client registers an FCM token and goes through
`fcm_client.py`. Erawan's Pixel Team app (Expo, expo-notifications) gets the
raw APNs device token instead and registers it with `device_type="apns"`;
`push.send_to_devices` hands those tokens here and the rest to FCM.

Token auth with an APNs `.p8` (config APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID,
topic APNS_TOPIC). A device token belongs to one APNs environment: an app
installed from Xcode is in the sandbox, TestFlight and the App Store are in
production, and the app cannot tell which. So each send tries production
first and, on `BadDeviceToken`, the sandbox.

The data rides under the `body` key, which is where expo-notifications reads
a remote notification's data from, so a tap hands the app the same keys an
FCM push carries (`reason`, `channel`, `notification_id`, ...).

Synchronous on purpose, like `fcm_client.send_push`: the fan-out runs in
Starlette's threadpool via BackgroundTasks.
"""

from __future__ import annotations

import base64
import json
import logging
import threading
import time
from typing import Optional

import httpx
import jwt

from app.config import config
from app.services.fcm_client import PushAlert, PushFailure, PushSendReport

logger = logging.getLogger(__name__)

HOSTS = {"production": "api.push.apple.com", "sandbox": "api.sandbox.push.apple.com"}

# Apple refuses a provider token older than an hour and throttles one renewed
# more often than every 20 minutes.
_TOKEN_LIFE_S = 40 * 60
_BODY_MAX = 240

_lock = threading.Lock()
_jwt_cache: dict[str, object] = {"token": "", "at": 0.0}


def _key_pem() -> Optional[bytes]:
    raw = (config.APNS_KEY or "").strip()
    if not raw:
        return None
    if raw.startswith("-----BEGIN"):
        return raw.replace("\\n", "\n").encode()
    try:
        return base64.b64decode(raw)
    except ValueError:
        return None


def configured() -> bool:
    return bool(_key_pem() and config.APNS_KEY_ID and config.APNS_TEAM_ID and config.APNS_TOPIC)


def _provider_token() -> str:
    """The JWT Apple asks for, signed ES256 with the .p8, reused for 40 minutes."""
    with _lock:
        now = time.time()
        if _jwt_cache["token"] and now - float(_jwt_cache["at"]) < _TOKEN_LIFE_S:
            return str(_jwt_cache["token"])
        token = jwt.encode(
            {"iss": config.APNS_TEAM_ID, "iat": int(now)},
            _key_pem(),
            algorithm="ES256",
            headers={"kid": config.APNS_KEY_ID},
        )
        _jwt_cache["token"], _jwt_cache["at"] = token, now
        return token


def build_payload(alert: PushAlert, data: dict) -> dict:
    body = " ".join((alert.body or "").split())
    if len(body) > _BODY_MAX:
        body = body[: _BODY_MAX - 1] + "…"
    aps: dict = {"alert": {"title": alert.title, "body": body}, "sound": "default"}
    if alert.thread_id:
        aps["thread-id"] = alert.thread_id
    return {"aps": aps, "body": {k: str(v) for k, v in (data or {}).items() if v is not None}}


def _send_one(client: httpx.Client, token: str, env: str, payload: bytes) -> tuple[int, str, str]:
    resp = client.post(
        f"https://{HOSTS[env]}/3/device/{token}",
        content=payload,
        headers={
            "authorization": f"bearer {_provider_token()}",
            "apns-topic": config.APNS_TOPIC,
            "apns-push-type": "alert",
            "apns-priority": "10",
        },
    )
    reason = ""
    if resp.status_code != 200 and resp.content:
        try:
            reason = str(resp.json().get("reason", ""))
        except ValueError:
            pass
    return resp.status_code, reason, resp.headers.get("apns-id", "")


def send_report(
    tokens: list[str],
    alert: PushAlert,
    data: dict,
    client: Optional[httpx.Client] = None,
) -> PushSendReport:
    """Send to each APNs token; the same report shape as FCM's diagnostic."""
    if not tokens:
        return PushSendReport(configured(), [], [], [], [])
    if not configured():
        logger.info("apns: not configured, would push to %d device(s): %s", len(tokens), alert.title)
        return PushSendReport(False, [], [], [], [])

    payload = json.dumps(build_payload(alert, data), ensure_ascii=False).encode()
    sent: list[str] = []
    dead: list[str] = []
    failures: list[PushFailure] = []
    ids: list[str] = []
    own = client is None
    http = client or httpx.Client(http2=True, timeout=10.0)
    try:
        for token in tokens:
            outcome = None
            for env in ("production", "sandbox"):
                try:
                    status, reason, apns_id = _send_one(http, token, env, payload)
                except httpx.HTTPError as exc:
                    failures.append(PushFailure(token, "NETWORK", type(exc).__name__, str(exc)[:200], True, False))
                    outcome = "failed"
                    break
                if status == 200:
                    sent.append(token)
                    ids.append(apns_id)
                    outcome = "sent"
                    break
                if status == 400 and reason == "BadDeviceToken":
                    continue  # the other environment's token
                if status == 410 or reason == "Unregistered":
                    break  # removed from the phone
                failures.append(PushFailure(token, reason or str(status), "APNs", f"{status} {reason}", status >= 500, False))
                outcome = "failed"
                break
            if outcome is None:
                # Unknown to both environments, or the app was removed: dead.
                dead.append(token)
                failures.append(PushFailure(token, "UNREGISTERED", "APNs", "token unknown or app removed", False, True))
                logger.info("apns: dead token %s…", token[:8])
    finally:
        if own:
            http.close()
    return PushSendReport(True, sent, dead, failures, ids)


def send_push(tokens: list[str], alert: PushAlert, data: dict) -> tuple[list[str], list[str]]:
    """(sent_ok, dead), like `fcm_client.send_push`. Never raises."""
    try:
        report = send_report(tokens, alert, data)
    except Exception:  # noqa: BLE001 — a push must never fail the request behind it
        logger.exception("apns: send failed")
        return [], []
    return report.sent_ok, report.dead_tokens
