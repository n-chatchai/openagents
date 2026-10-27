# -*- coding: utf-8 -*-
"""
The workspace's shared token opens nothing on its own (SHARED_TOKEN_NEEDS_PERSON=1).

Upstream's model: the API is on the internet and the workspace token — the
one in every ?token= link — is a machine credential with full trust
(app/access.py rule 1). A deployment that puts the API on the internet past
its door (Erawan does, so the launcher on a laptop and Grok Bot's plugin can
reach /v1/) may not want a link that leaks to open the workspace from there.

With SHARED_TOKEN_NEEDS_PERSON=1, a request that carries any workspace's
shared token where the API reads credentials — X-Workspace-Token,
Authorization, the query string or the body — is refused unless
a signed-in person comes with it: a bearer or an `access_token` that verifies
as a person. Members' browsers always send their session alongside the token,
so they never notice. Devices use the token they were given for redeeming a
pairing code (nodes.token), which this does not touch, and cloud agents run
inside the server, never over HTTP.

One guard at the edge rather than a change at each place that compares the
token (access.py, approvals, visibility, nodes, workspace_mod, workspaces),
so a route added upstream later cannot miss the rule.
"""

import json
import logging
import os
from typing import Iterable, Optional
from urllib.parse import parse_qs

from sqlalchemy import select

logger = logging.getLogger(__name__)

# The headers the API reads credentials from. Not Cookie or Referer: a page
# opened by its ?token= link sends the token there on every call, the backend
# never reads it from either, and the call that fetches the person's session
# (POST /door/session) has no person yet.
_CREDENTIAL_HEADERS = ("x-workspace-token", "authorization")
# A request body is read in full to look for the token; past this it is refused
# rather than buffered (an upload that large is not a device's).
_MAX_BODY = 64 * 1024 * 1024

REFUSAL = (
    "This workspace's shared token works only together with a signed-in person. "
    "Devices pair with a code from Connect Agent and use their own token."
)


def enabled() -> bool:
    return os.environ.get("SHARED_TOKEN_NEEDS_PERSON", "") == "1"


def _is_person(candidates: Iterable[Optional[str]]) -> bool:
    from app.firebase_auth import verify_identity_claims

    for raw in candidates:
        token = (raw or "").strip()
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        if not token:
            continue
        try:
            claims = verify_identity_claims(token)
        except Exception:  # an unreadable bearer is simply not a person
            claims = None
        if claims and claims.get("email"):
            return True
    return False


class SharedTokenGuard:
    """Pure ASGI: it may read the body, then hands the same bytes on."""

    def __init__(self, app, is_enabled=enabled, load_tokens=None):
        self.app = app
        self._enabled = is_enabled
        self._load = load_tokens

    @staticmethod
    def _load_from_db() -> Iterable[str]:
        from app.database import SessionLocal
        from app.models import Workspace

        db = SessionLocal()
        try:
            return db.execute(
                select(Workspace.password_hash).where(Workspace.password_hash.isnot(None))
            ).scalars().all()
        finally:
            db.close()

    def _shared_tokens(self) -> frozenset:
        # Read fresh every time (a handful of rows): a workspace made a second
        # ago must not get a window in which its token works alone.
        load = self._load or self._load_from_db
        # Random url-safe strings; anything short is not one and would match by accident.
        return frozenset(t for t in load() if t and len(t) >= 16)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not self._enabled():
            return await self.app(scope, receive, send)

        headers = [(k.decode("latin-1").lower(), v.decode("latin-1")) for k, v in scope.get("headers") or []]
        query = scope.get("query_string", b"").decode("latin-1")
        authorization = [v for k, v in headers if k == "authorization"]
        if _is_person(authorization + parse_qs(query).get("access_token", [])):
            return await self.app(scope, receive, send)

        tokens = self._shared_tokens()
        if not tokens:
            return await self.app(scope, receive, send)

        seen = " ".join(v for k, v in headers if k in _CREDENTIAL_HEADERS) + " " + query
        hit = any(t in seen for t in tokens)

        body = b""
        if not hit:
            chunks, size, more = [], 0, True
            while more:
                message = await receive()
                if message["type"] != "http.request":
                    return  # the client went away
                chunk = message.get("body", b"")
                size += len(chunk)
                if size > _MAX_BODY:
                    return await _refuse(send, 413, "Request body too large")
                chunks.append(chunk)
                more = message.get("more_body", False)
            body = b"".join(chunks)
            hit = any(t.encode() in body for t in tokens)

        if hit:
            logger.info("shared_token_guard: refused %s %s (shared token, no person)",
                        scope.get("method"), scope.get("path"))
            return await _refuse(send, 403, REFUSAL)

        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


async def _refuse(send, status: int, message: str) -> None:
    payload = json.dumps({"code": status, "message": message, "data": None}).encode()
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode())],
    })
    await send({"type": "http.response.body", "body": payload})
