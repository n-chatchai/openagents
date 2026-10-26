# -*- coding: utf-8 -*-
"""
Hermes Agent as a workspace agent: the room calls a Hermes API server.

A cloud agent whose provider is ``hermes`` is somebody's own Hermes Agent
(github.com/NousResearch/hermes-agent), running wherever its owner runs it.
The workspace holds its API server's address and key (base_url, api_key on
CloudAgentConfig) and, when the agent is addressed, starts a run there:

  POST {base}/v1/runs                 {"input": ...}  -> 202 {"run_id"}
  GET  {base}/v1/runs/{id}/events     SSE: message.delta, tool.*, approval.request,
                                      run.completed {output} / run.failed / run.cancelled
  GET  {base}/v1/runs/{id}            status and output, when the stream is lost
  POST {base}/v1/runs/{id}/approval   {"choice": "deny", "request_id"}
  POST {base}/v1/runs/{id}/stop

Unlike the OpenAI-compatible path every other cloud agent takes, this is the
whole agent — its tools, memory and skills — and a run is not cut off after
two minutes. One Hermes conversation per thread (X-Hermes-Session-Key), so
Hermes keeps its own history of the thread; each run carries only what other
people said since its last reply. Paperclip's hermes_gateway adapter talks to
Hermes the same way.

Not yet: Hermes asking for approval is answered "deny" with a note in the
thread (the workspace's approvals are not wired to it), and progress is not
shown while it works.
"""

import asyncio
import json
import logging
import os
import time
from typing import AsyncIterator, Optional

import httpx

logger = logging.getLogger(__name__)

HERMES_PROVIDER = "hermes"

# A run may take as long as its owner's Hermes needs (browsing, code); this
# only stops one that never ends.
_RUN_TIMEOUT = float(os.environ.get("HERMES_RUN_TIMEOUT_SECONDS", "1800"))
# Silence on the event stream before falling back to polling the run.
_STREAM_IDLE = float(os.environ.get("HERMES_STREAM_IDLE_SECONDS", "120"))
# What other people said since Hermes last spoke, at most.
_CONTEXT_CHARS = int(os.environ.get("HERMES_CONTEXT_CHARS", "12000"))

_TERMINAL = {"completed", "failed", "cancelled"}


def api_base(base_url: Optional[str]) -> str:
    """The API server root, whatever form the owner pasted: with or without
    a trailing slash or /v1."""
    base = (base_url or "").strip().rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return base


async def invoke_hermes_agent(db, workspace_id: str, event_data: dict, cloud_config, depth: int) -> None:
    """Run the addressed Hermes on the trigger message and post its answer."""
    from app.services.cloud_agent import (
        _build_conversation_context,
        _event_order_boundary,
        _post_response,
        speaker_label,
    )

    channel_target = event_data.get("target", "")
    agent_name = cloud_config.agent_name
    base = api_base(cloud_config.base_url)
    api_key = cloud_config.api_key
    if not base:
        raise ValueError("this Hermes agent has no API server address")

    payload = event_data.get("payload", {}) or {}
    content = (payload.get("content") or "").strip()
    if not content:
        return

    history = _build_conversation_context(
        db,
        workspace_id,
        channel_target,
        agent_name,
        conversation_source=event_data.get("source"),
        exclude_event_id=event_data.get("id"),
        before_timestamp=_event_order_boundary(event_data),
        max_chars=_CONTEXT_CHARS,
        attribute_speakers=True,
    )
    # Release the DB connection for the length of the run (see _invoke_chat_agent).
    db.rollback()

    text = _compose_input(history, speaker_label(event_data.get("source") or "", payload), content)
    session_key = f"openagents:{workspace_id}:{channel_target}"
    logger.info("hermes_agent: run for %s on %s in %s at %s", agent_name, event_data.get("id"), channel_target, base)

    notes: list[str] = []
    answer = await _run(base, api_key, text, session_key, event_data.get("id"), notes)
    if notes:
        answer = (answer + "\n\n" if answer else "") + "\n".join(notes)

    await _post_response(
        db, workspace_id, channel_target, agent_name,
        answer or "(Hermes finished without a reply)", depth,
        in_reply_to=event_data.get("id"),
        trigger_source=event_data.get("source"),
    )


def _compose_input(history: list[dict], speaker: str, content: str) -> str:
    """The trigger, preceded by what others said since Hermes's last reply.

    Hermes already holds its own earlier turns in this thread's session, so
    resending them would only spend its context.
    """
    since = history
    for i in range(len(history) - 1, -1, -1):
        if history[i].get("role") == "assistant":
            since = history[i + 1:]
            break
    lines = [m.get("content", "") for m in since if m.get("content")]
    message = f"[{speaker}] {content}" if speaker else content
    if not lines:
        return message
    return (
        "Messages in this workspace thread since your last reply, oldest first:\n"
        + "\n".join(lines)
        + "\n\nThe message addressed to you:\n"
        + message
    )


def _headers(api_key: str, session_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}", "X-Hermes-Session-Key": session_key}


async def _run(base: str, api_key: str, text: str, session_key: str,
               idempotency_key: Optional[str], notes: list) -> str:
    """Start a run and follow it to the end; the answer text, or raise."""
    headers = _headers(api_key, session_key)
    deadline = time.monotonic() + _RUN_TIMEOUT
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as http:
        start_headers = dict(headers)
        if idempotency_key:
            # A retried trigger never starts a second run.
            start_headers["Idempotency-Key"] = f"openagents-{idempotency_key}"[:255]
        r = await http.post(f"{base}/v1/runs", headers=start_headers, json={"input": text})
        if r.status_code not in (200, 201, 202):
            raise RuntimeError(f"Hermes refused the run (HTTP {r.status_code}): {r.text[:200]}")
        run_id = (r.json() or {}).get("run_id")
        if not run_id:
            raise RuntimeError("Hermes did not return a run id")

        deltas: list[str] = []
        try:
            outcome = await _follow_stream(http, base, headers, run_id, deltas, deadline, notes)
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            logger.info("hermes_agent: event stream for %s lost (%s); polling", run_id, exc)
            outcome = None
        if outcome is None:
            outcome = await _poll(http, base, headers, run_id, deadline)

        status, output, error = outcome
        if status == "completed":
            return output if output else "".join(deltas).strip()
        if status == "timeout":
            await _stop(http, base, headers, run_id)
            raise RuntimeError(f"Hermes did not finish within {int(_RUN_TIMEOUT)} seconds; the run was stopped")
        raise RuntimeError(f"Hermes run {status}" + (f": {error}" if error else ""))


async def _follow_stream(http, base, headers, run_id, deltas, deadline, notes):
    """Read the run's events until a terminal one -> (status, output, error),
    or None when the stream ends or goes quiet first."""
    url = f"{base}/v1/runs/{run_id}/events"
    timeout = httpx.Timeout(30.0, read=_STREAM_IDLE)
    async with http.stream("GET", url, headers=headers, timeout=timeout) as resp:
        if resp.status_code != 200:
            return None
        async for event in _sse_events(resp):
            name = event.get("event") or ""
            if name in ("message.delta", "assistant.delta"):
                deltas.append(event.get("delta") or "")
            elif name == "approval.request":
                await _deny(http, base, headers, run_id, event, notes)
            elif name == "run.completed":
                return "completed", (event.get("output") or "").strip(), None
            elif name in ("run.failed", "run.cancelled"):
                return name.split(".", 1)[1], None, event.get("error") or event.get("turn_exit_reason")
            elif name == "error":
                return "failed", None, event.get("message")
            if time.monotonic() > deadline:
                return "timeout", None, None
    return None


async def _sse_events(resp) -> AsyncIterator[dict]:
    """JSON payloads of a server-sent event stream (comment frames skipped)."""
    data: list[str] = []
    async for line in resp.aiter_lines():
        if not line:
            if data:
                try:
                    yield json.loads("\n".join(data))
                except ValueError:
                    pass
                data = []
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip())


async def _poll(http, base, headers, run_id, deadline):
    """GET the run until it ends -> (status, output, error)."""
    while time.monotonic() < deadline:
        r = await http.get(f"{base}/v1/runs/{run_id}", headers=headers)
        if r.status_code == 200:
            body = r.json() or {}
            status = body.get("status")
            if status in _TERMINAL:
                return status, (body.get("output") or "").strip(), body.get("error")
        elif r.status_code == 404:
            return "failed", None, "Hermes no longer knows this run"
        await asyncio.sleep(3)
    return "timeout", None, None


async def _deny(http, base, headers, run_id, event, notes) -> None:
    """Say no to an approval Hermes asks for, and say so in the thread."""
    body = {"choice": "deny"}
    request_id = event.get("request_id") or event.get("approval_id")
    if request_id:
        body["request_id"] = request_id
    what = event.get("description") or event.get("command") or "an action"
    try:
        await http.post(f"{base}/v1/runs/{run_id}/approval", headers=headers, json=body)
    except httpx.HTTPError as exc:
        logger.warning("hermes_agent: could not answer approval on %s: %s", run_id, exc)
    notes.append(f"(Hermes asked for approval — {what} — which this workspace cannot give yet, so it was declined.)")


async def _stop(http, base, headers, run_id) -> None:
    try:
        await http.post(f"{base}/v1/runs/{run_id}/stop", headers=headers)
    except httpx.HTTPError:
        pass


async def probe(base_url: str, api_key: str) -> Optional[str]:
    """None when a Hermes API server answers at base_url with this key, else why not."""
    base = api_base(base_url)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as http:
            r = await http.get(f"{base}/v1/capabilities", headers={"Authorization": f"Bearer {api_key}"})
    except httpx.HTTPError as exc:
        return f"no Hermes API server answered at {base} ({exc.__class__.__name__})"
    if r.status_code in (401, 403):
        return "Hermes refused the key"
    if r.status_code != 200:
        return f"{base}/v1/capabilities answered HTTP {r.status_code}"
    return None
