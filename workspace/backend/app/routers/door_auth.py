# -*- coding: utf-8 -*-
"""
Sign-in through a door: a self-hosted workspace behind an authenticating proxy.

POST /door/session   Mint a workspace session for the person the door signed in.

Outside /v1/ on purpose: a door that lets machines reach /v1/ unsigned-in (the
launcher on a laptop, Grok Bot's plugin) still holds this path behind its
sign-in, so the header below only ever arrives from the door itself.

Background: a self-hosted deployment has no openagents.org login (no Firebase
handoff), so people enter by ?token= link and the workspace never learns who
they are — no names, no memberships, no named approvers. Erawan runs this
backend behind oauth2-proxy (Google, one Workspace domain), which already knows
the person and passes their verified email to the upstream as a header
(`--pass-user-headers`: X-Forwarded-Email).

This endpoint turns that header into the same workspace session JWT that
POST /v1/auth/session mints, so the rest of the API — memberships, roles,
approvals, mentions — sees an ordinary signed-in user.

Trust: the header is believed ONLY because the operator says the backend is
reachable through the door alone. Off unless DOOR_EMAIL_HEADER names the
header. oauth2-proxy strips a client's own copy of every header it injects
before injecting its own (SkipAuthStripHeaders defaults to true), so a browser
cannot forge it through the door; a deployment that exposes this backend any
other way must leave DOOR_EMAIL_HEADER unset.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Request

from app.config import config
from app.firebase_auth import mint_workspace_session, workspace_session_enabled
from app.response import ResponseCode, json_response, success_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/door", tags=["Auth"])


@router.post("/session")
def create_door_session(request: Request):
    """Mint a workspace session for the email the door vouches for.

    Responses:
      200 {session_token, expires_at, email, display_name}
      401 the door sent no email (the request did not come through it)
      404 this deployment has no door (DOOR_EMAIL_HEADER unset)
      503 WORKSPACE_SESSION_SECRET is not configured on this deployment
    """
    header = config.DOOR_EMAIL_HEADER
    if not header:
        return json_response(ResponseCode.NOT_FOUND, "No door on this deployment")
    if not workspace_session_enabled():
        return json_response(
            ResponseCode.INTERNAL_ERROR,
            "Workspace sessions are not enabled on this server",
            status_code=503,
        )

    email = (request.headers.get(header) or "").strip().lower()
    if not email or "@" not in email:
        return json_response(ResponseCode.UNAUTHORIZED, "Not signed in at the door")

    # The door verified the address with Google before it let the request in.
    claims = {"email": email, "display_name": None, "email_verified": True}
    token, exp = mint_workspace_session(claims)
    logger.info("door_auth: issued workspace session for %s", email)
    return success_response({
        "session_token": token,
        "expires_at": datetime.fromtimestamp(exp, tz=timezone.utc).isoformat(),
        "email": email,
        "display_name": None,
    })


# ---------------------------------------------------------------------------
# The phone app's way through the door
# ---------------------------------------------------------------------------
#
# A phone app cannot read the door's cookie, and the door answers /door/ with
# a 401 rather than a sign-in page. So the app opens the door's own sign-in
# (/oauth2/start) in the system's sign-in sheet, with /door/app-start as where
# to go after; that answers with a redirect to the app's URL scheme carrying a
# short code. (The web page /auth/app, which asks POST /door/app-code and
# hands the code back from the browser, does the same for a door that cannot
# take a return path.) The app then trades the code at
# POST /v1/auth/app-session (outside the door, as all of /v1/ is) for the same
# session /door/session mints.
#
# The code is bound to a secret only the app holds (PKCE's S256: the app sends
# the SHA-256 of a random verifier, and must show the verifier to trade the
# code), so a code caught on its way back to the app — another app claiming
# the same URL scheme, say — is worth nothing. It is signed with the session
# secret and lives two minutes; nothing is stored.

import base64
import hashlib
import hmac
import json
import re
import secrets
import time

from pydantic import BaseModel, Field

APP_CODE_TTL = 120
_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_VERIFIER = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(body: str) -> str:
    key = ("door-app-code:" + config.WORKSPACE_SESSION_SECRET).encode()
    return _b64(hmac.new(key, body.encode(), hashlib.sha256).digest())


def sign_app_code(email: str, challenge: str, now: Optional[float] = None) -> str:
    now = time.time() if now is None else now
    body = _b64(json.dumps({"e": email, "c": challenge, "x": int(now) + APP_CODE_TTL,
                            "n": secrets.token_hex(8)}, separators=(",", ":")).encode())
    return f"{body}.{_mac(body)}"


def read_app_code(code: str, verifier: str, now: Optional[float] = None) -> Optional[str]:
    """The email the code was made for, if it is ours, fresh, and the verifier matches."""
    now = time.time() if now is None else now
    body, _, mac = (code or "").partition(".")
    if not body or not mac or not hmac.compare_digest(mac, _mac(body)):
        return None
    try:
        claims = json.loads(_unb64(body))
    except (ValueError, TypeError):
        return None
    if not isinstance(claims, dict) or int(claims.get("x", 0)) < now:
        return None
    expected = _b64(hashlib.sha256((verifier or "").encode()).digest())
    if not hmac.compare_digest(expected, str(claims.get("c", ""))):
        return None
    email = str(claims.get("e", "")).strip().lower()
    return email if "@" in email else None


class AppCodeRequest(BaseModel):
    challenge: str = Field(..., min_length=43, max_length=43)


@router.post("/app-code")
def create_app_code(body: AppCodeRequest, request: Request):
    """A two-minute code for the phone app, for the person the door signed in.

    Responses:
      200 {code, expires_in}
      400 the challenge is not a base64url SHA-256
      401 the door sent no email
      404 this deployment has no door
      503 WORKSPACE_SESSION_SECRET is not configured
    """
    header = config.DOOR_EMAIL_HEADER
    if not header:
        return json_response(ResponseCode.NOT_FOUND, "No door on this deployment")
    if not workspace_session_enabled():
        return json_response(ResponseCode.INTERNAL_ERROR,
                             "Workspace sessions are not enabled on this server", status_code=503)
    if not _CHALLENGE.match(body.challenge):
        return json_response(ResponseCode.BAD_REQUEST, "challenge must be base64url SHA-256")
    email = (request.headers.get(header) or "").strip().lower()
    if not email or "@" not in email:
        return json_response(ResponseCode.UNAUTHORIZED, "Not signed in at the door")
    logger.info("door_auth: app code for %s", email)
    return success_response({"code": sign_app_code(email, body.challenge), "expires_in": APP_CODE_TTL})


APP_RETURN = "pixelteam://auth"


@router.get("/app-start")
def app_start(request: Request, challenge: str = ""):
    """The phone app's sign-in, straight back to the app: no page of ours between.

    The app opens the door's own sign-in, /oauth2/start?rd=/door/app-start?challenge=…,
    in the system's sign-in sheet. Once the door has signed the person in it
    sends them here, and this answers with a redirect to the app's scheme
    carrying the code — or the reason there is none — which the sheet catches.
    """
    from urllib.parse import urlencode
    from fastapi.responses import RedirectResponse

    def back(**params):
        return RedirectResponse(f"{APP_RETURN}?{urlencode(params)}", status_code=302)

    header = config.DOOR_EMAIL_HEADER
    if not header or not workspace_session_enabled():
        return back(error="no_door")
    if not _CHALLENGE.match(challenge or ""):
        return back(error="bad_request")
    email = (request.headers.get(header) or "").strip().lower()
    if not email or "@" not in email:
        return back(error="not_signed_in")
    logger.info("door_auth: app sign-in for %s", email)
    return back(code=sign_app_code(email, challenge))


app_router = APIRouter(prefix="/v1/auth", tags=["Auth"])


class AppSessionRequest(BaseModel):
    code: str = Field(..., min_length=10, max_length=1024)
    verifier: str = Field(..., min_length=43, max_length=128)


@app_router.post("/app-session")
def create_app_session(body: AppSessionRequest):
    """Trade the door's app code and the app's verifier for a workspace session.

    Responses:
      200 {session_token, expires_at, email, display_name}
      401 the code is not ours, has expired, or the verifier does not match
      404 this deployment has no door
      503 WORKSPACE_SESSION_SECRET is not configured
    """
    if not config.DOOR_EMAIL_HEADER:
        return json_response(ResponseCode.NOT_FOUND, "No door on this deployment")
    if not workspace_session_enabled():
        return json_response(ResponseCode.INTERNAL_ERROR,
                             "Workspace sessions are not enabled on this server", status_code=503)
    if not _VERIFIER.match(body.verifier):
        return json_response(ResponseCode.UNAUTHORIZED, "Sign-in code rejected")
    email = read_app_code(body.code, body.verifier)
    if not email:
        return json_response(ResponseCode.UNAUTHORIZED, "Sign-in code rejected")
    token, exp = mint_workspace_session({"email": email, "display_name": None, "email_verified": True})
    logger.info("door_auth: app session for %s", email)
    return success_response({
        "session_token": token,
        "expires_at": datetime.fromtimestamp(exp, tz=timezone.utc).isoformat(),
        "email": email,
        "display_name": None,
    })
