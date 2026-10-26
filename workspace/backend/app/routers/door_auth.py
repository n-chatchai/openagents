# -*- coding: utf-8 -*-
"""
Sign-in through a door: a self-hosted workspace behind an authenticating proxy.

POST /v1/auth/door-session   Mint a workspace session for the person the door
                             signed in.

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

from fastapi import APIRouter, Request

from app.config import config
from app.firebase_auth import mint_workspace_session, workspace_session_enabled
from app.response import ResponseCode, json_response, success_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/auth", tags=["Auth"])


@router.post("/door-session")
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
