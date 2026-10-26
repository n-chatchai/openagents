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

The runner below is shared: Chang Bot (app/services/changbot_agent.py) is a
Hermes behind Erawan's gateway, which speaks the same runs protocol under its
own root and keeps approvals for the bot's owner.

Not yet: Hermes asking for approval is answered "deny" with a note in the
thread (the workspace's approvals are not wired to it), and progress is not
shown while it works.
"""

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Optional

import httpx

logger = logging.getLogger(__name__)

HERMES_PROVIDER = "hermes"

# A run may take as long as its owner's Hermes needs (browsing, code); this
# only stops one that never ends.
_RUN_TIMEOUT = float(os.environ.get("HERMES_RUN_TIMEOUT_SECONDS", "1800"))
# Silence on the event stream before falling back to polling the run.
_STREAM_IDLE = float(os.environ.get("HERMES_STREAM_IDLE_SECONDS", "120"))
# What other people said since the agent last spoke, at most.
_CONTEXT_CHARS = int(os.environ.get("HERMES_CONTEXT_CHARS", "12000"))

_TERMINAL = {"completed", "failed", "cancelled"}


class AgentRunError(RuntimeError):
    """A refusal or failure worded by the agent's side for the people in the
    room, shown in the thread as it is (app/services/cloud_agent.py)."""


@dataclass
class RunTarget:
    """Where a run goes and how it is spoken to.

    ``root`` is the prefix the runs live under ("{base}/v1" for a Hermes API
    server). ``session_in_body`` puts the thread's conversation key in the
    start request as ``session_key`` instead of Hermes' X-Hermes-Session-Key
    header. ``approvals`` is "deny" (answer for the owner, who is not here) or
    "owner" (somebody else answers; the room only waits).
    """
    root: str
    api_key: str
    label: str = "Hermes"
    session_in_body: bool = False
    approvals: str = "deny"
    headers: dict = field(default_factory=dict)
    # The far side words its refusals and failures for the room (the Chang Bot
    # gateway, in Thai): show them as they are, without the room's own frame.
    own_errors: bool = False


def api_base(base_url: Optional[str]) -> str:
    """The API server root, whatever form the owner pasted: with or without
    a trailing slash or /v1."""
    base = (base_url or "").strip().rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return base


async def invoke_hermes_agent(db, workspace_id: str, event_data: dict, cloud_config, depth: int) -> None:
    """Run the addressed Hermes on the trigger message and post its answer."""
    base = api_base(cloud_config.base_url)
    if not base:
        raise ValueError("this Hermes agent has no API server address")
    target = RunTarget(root=f"{base}/v1", api_key=cloud_config.api_key)
    await invoke_run_agent(db, workspace_id, event_data, cloud_config, depth, target)


async def invoke_run_agent(db, workspace_id: str, event_data: dict, cloud_config, depth: int,
                           target: RunTarget) -> None:
    """The trigger message as a run on ``target``; its answer posted in the thread."""
    from app.services.cloud_agent import (
        _build_conversation_context,
        _event_order_boundary,
        _post_response,
        speaker_label,
    )

    channel_target = event_data.get("target", "")
    agent_name = cloud_config.agent_name
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
    logger.info("hermes_agent: %s run for %s on %s in %s at %s", target.label, agent_name,
                event_data.get("id"), channel_target, target.root)

    notes: list[str] = []
    answer = await _run(target, text, session_key, event_data.get("id"), notes)
    if notes:
        answer = (answer + "\n\n" if answer else "") + "\n".join(notes)

    await _post_response(
        db, workspace_id, channel_target, agent_name,
        answer or f"({target.label} finished without a reply)", depth,
        in_reply_to=event_data.get("id"),
        trigger_source=event_data.get("source"),
    )


def _compose_input(history: list[dict], speaker: str, content: str) -> str:
    """The trigger, preceded by what others said since the agent's last reply.

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


def _headers(target: RunTarget, session_key: Optional[str] = None) -> dict:
    headers = {"Authorization": f"Bearer {target.api_key}", **target.headers}
    if session_key and not target.session_in_body:
        headers["X-Hermes-Session-Key"] = session_key
    return headers


async def _run(target: RunTarget, text: str, session_key: str,
               idempotency_key: Optional[str], notes: list) -> str:
    """Start a run and follow it to the end; the answer text, or raise."""
    headers = _headers(target, session_key)
    deadline = time.monotonic() + _RUN_TIMEOUT
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as http:
        start_headers = dict(headers)
        if idempotency_key:
            # A retried trigger never starts a second run.
            start_headers["Idempotency-Key"] = f"openagents-{idempotency_key}"[:255]
        body = {"input": text}
        if target.session_in_body:
            body["session_key"] = session_key
        r = await http.post(f"{target.root}/runs", headers=start_headers, json=body)
        if r.status_code not in (200, 201, 202):
            if target.own_errors:
                raise AgentRunError(_reason(r))
            raise RuntimeError(f"{target.label} refused the run (HTTP {r.status_code}): {_reason(r)}")
        run_id = (r.json() or {}).get("run_id")
        if not run_id:
            raise RuntimeError(f"{target.label} did not return a run id")

        deltas: list[str] = []
        try:
            outcome = await _follow_stream(http, target, headers, run_id, deltas, deadline, notes)
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            logger.info("hermes_agent: event stream for %s lost (%s); polling", run_id, exc)
            outcome = None
        if outcome is None:
            outcome = await _poll(http, target, headers, run_id, deadline)

        status, output, error = outcome
        if status == "completed":
            return output if output else "".join(deltas).strip()
        if status == "timeout":
            await _stop(http, target, headers, run_id)
            raise RuntimeError(f"{target.label} did not finish within {int(_RUN_TIMEOUT)} seconds; the run was stopped")
        if target.own_errors and error:
            raise AgentRunError(str(error.get("message") or error) if isinstance(error, dict) else str(error))
        raise RuntimeError(f"{target.label} run {status}" + (f": {error}" if error else ""))


def _reason(r) -> str:
    """The message a refusal carries, for the thread."""
    try:
        body = r.json() or {}
        err = body.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err)[:200]
        return str(body.get("message") or err or r.text)[:200]
    except ValueError:
        return r.text[:200]


async def _follow_stream(http, target, headers, run_id, deltas, deadline, notes):
    """Read the run's events until a terminal one -> (status, output, error),
    or None when the stream cannot be had.

    A stream that goes quiet is picked up again from the last event seen
    (Last-Event-ID): a long tool call sends nothing, and neither Hermes nor
    the Chang Bot gateway keeps the line alive meanwhile.
    """
    url = f"{target.root}/runs/{run_id}/events"
    timeout = httpx.Timeout(30.0, read=_STREAM_IDLE)
    last_id: list[Optional[str]] = [None]
    while time.monotonic() < deadline:
        resume = dict(headers)
        if last_id[0] is not None:
            resume["Last-Event-ID"] = last_id[0]
        try:
            async with http.stream("GET", url, headers=resume, timeout=timeout) as resp:
                if resp.status_code != 200:
                    return None
                async for event in _sse_events(resp, last_id):
                    name = event.get("event") or ""
                    if name in ("message.delta", "assistant.delta"):
                        deltas.append(event.get("delta") or "")
                    elif name == "approval.request":
                        await _on_approval(http, target, headers, run_id, event, notes)
                    elif name == "run.completed":
                        return "completed", (event.get("output") or "").strip(), None
                    elif name in ("run.failed", "run.cancelled"):
                        return name.split(".", 1)[1], None, event.get("error") or event.get("turn_exit_reason")
                    elif name == "error":
                        return "failed", None, event.get("message")
                    if time.monotonic() > deadline:
                        return "timeout", None, None
        except httpx.ReadTimeout:
            if last_id[0] is None:
                # Nothing to resume from: let the caller poll instead.
                return None
            logger.info("hermes_agent: %s quiet for %ds; resuming after event %s", run_id, int(_STREAM_IDLE), last_id[0])
            continue
        # Closed without a terminal event: the run's status says the rest.
        return None
    return "timeout", None, None


async def _sse_events(resp, last_id: Optional[list] = None) -> AsyncIterator[dict]:
    """JSON payloads of a server-sent event stream (comment frames skipped);
    each frame's ``id:`` is kept in ``last_id[0]`` for resuming."""
    data: list[str] = []
    frame_id: Optional[str] = None
    async for line in resp.aiter_lines():
        if not line:
            if data:
                try:
                    payload = json.loads("\n".join(data))
                except ValueError:
                    payload = None
                if last_id is not None and frame_id is not None:
                    last_id[0] = frame_id
                if payload is not None:
                    yield payload
                data, frame_id = [], None
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
        elif line.startswith("id:"):
            frame_id = line[3:].strip()


async def _poll(http, target, headers, run_id, deadline):
    """GET the run until it ends -> (status, output, error)."""
    while time.monotonic() < deadline:
        r = await http.get(f"{target.root}/runs/{run_id}", headers=headers)
        if r.status_code == 200:
            body = r.json() or {}
            status = body.get("status")
            if status in _TERMINAL:
                return status, (body.get("output") or "").strip(), body.get("error")
        elif r.status_code == 404:
            return "failed", None, f"{target.label} no longer knows this run"
        await asyncio.sleep(3)
    return "timeout", None, None


async def _on_approval(http, target, headers, run_id, event, notes) -> None:
    """An approval the agent asks for: answered here, or left to its owner."""
    what = event.get("description") or event.get("command") or "an action"
    if target.approvals == "owner":
        # Somebody else holds the answer (Chang Bot: a card on the owner's
        # phone). Say once what the run waits on; the stream carries on when
        # it is answered.
        note = f"({target.label} asked its owner to approve {what}.)"
        if note not in notes:
            notes.append(note)
        return
    body = {"choice": "deny"}
    request_id = event.get("request_id") or event.get("approval_id")
    if request_id:
        body["request_id"] = request_id
    try:
        await http.post(f"{target.root}/runs/{run_id}/approval", headers=headers, json=body)
    except httpx.HTTPError as exc:
        logger.warning("hermes_agent: could not answer approval on %s: %s", run_id, exc)
    notes.append(f"({target.label} asked for approval — {what} — which this workspace cannot give yet, so it was declined.)")


async def _stop(http, target, headers, run_id) -> None:
    try:
        await http.post(f"{target.root}/runs/{run_id}/stop", headers=headers)
    except httpx.HTTPError:
        pass


async def probe_root(root: str, api_key: str, label: str = "Hermes", credential: str = "key") -> Optional[str]:
    """None when a runs server answers {root}/capabilities with this credential, else why not."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as http:
            r = await http.get(f"{root}/capabilities", headers={"Authorization": f"Bearer {api_key}"})
    except httpx.HTTPError as exc:
        return f"no {label} answered at {root} ({exc.__class__.__name__})"
    if r.status_code in (401, 403):
        return f"{label} refused the {credential}"
    if r.status_code != 200:
        return f"{root}/capabilities answered HTTP {r.status_code}"
    return None


async def probe(base_url: str, api_key: str) -> Optional[str]:
    """None when a Hermes API server answers at base_url with this key, else why not."""
    return await probe_root(f"{api_base(base_url)}/v1", api_key)
