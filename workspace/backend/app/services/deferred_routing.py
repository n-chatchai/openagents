"""Pick the agent for a person's room message after the send has answered.

A person's message with no @ in a room of several agents (or several
people) asks a routing model which agent it is for. That call takes from a
second to the router's timeout, and POST /v1/events used to wait for it
before answering, so a phone showed the message as still sending for that
long (Pixel Team, 2026-11-28).

Now the pipeline stores the message with no agent woken and
``metadata.routing_deferred = {"candidates": [...]}`` (workspace_mod.
_conversation_targets with ``defer``), POST /v1/events answers, and this
background task asks the model. Its answer is acted on the way a person's
own pick is (routers/events.py resolve_routing_choice): an agent chosen is
woken by a hidden copy of the message carrying ``routing_assignment``,
which clients leave out of the timeline and the router out of history; an
unclear answer becomes the message's pending ``routing_choice``; "stop"
wakes nobody. The original keeps ``target_agents = ["__no_response__"]``,
so an agent polling it never answers it twice.
"""

import asyncio
import json as _json
import logging
from copy import deepcopy

from sqlalchemy import select

from app import cache
from app.database import SessionLocal
from app.models import Channel, EventRecord, Workspace
from openagents.core.onm_events import Event

logger = logging.getLogger(__name__)

PENDING = "routing_deferred"


def _snapshot(event_id, type_, source, target, payload, metadata, timestamp, visibility="channel"):
    return {"id": event_id, "type": type_, "source": source, "target": target, "payload": payload,
            "metadata": metadata, "timestamp": timestamp, "visibility": visibility}


def route_deferred(workspace_id: str, event_id: str) -> None:
    """Background task (FastAPI runs it in the threadpool after the response)."""
    try:
        _route(workspace_id, event_id)
    except Exception:  # never raise out of a background task
        logger.exception("deferred_routing: routing %s failed", event_id)


def _route(workspace_id: str, event_id: str) -> None:
    from app.mods.workspace_mod import _route_with_llm, _routing_choice
    from app.pipeline_factory import pipeline
    from app.routers.events import _invalidate_poll_cache
    from app.services.cloud_agent import _run_cloud_invocation
    from openagents.core.onm_mods import EventRejected, PipelineContext

    db = SessionLocal()
    try:
        def load(lock):
            query = select(EventRecord).where(
                EventRecord.id == event_id, EventRecord.network_id == workspace_id,
                EventRecord.type == "workspace.message.posted",
            )
            return db.execute(query.with_for_update() if lock else query).scalar_one_or_none()

        # Read without a lock: the model call below takes seconds.
        record = load(False)
        pending = ((record.metadata_ or {}) if record else {}).get(PENDING)
        if not record or not isinstance(pending, dict):
            return
        candidates = [str(name) for name in pending.get("candidates") or []]
        metadata = dict(record.metadata_ or {})
        metadata.pop(PENDING, None)
        workspace = db.get(Workspace, workspace_id)
        channel = db.execute(select(Channel).where(
            Channel.workspace_id == workspace_id, Channel.name == str(record.target)[len("channel/"):],
            Channel.status == "active",
        )).scalar_one_or_none() if workspace else None
        if metadata.get("recalled") or not channel or not candidates:
            # Taken back, or the room is gone, before the model was asked.
            record.metadata_ = metadata
            db.commit()
            return

        event = Event(id=record.id, type=record.type, source=record.source, target=record.target,
                      payload=deepcopy(record.payload or {}), metadata=dict(metadata),
                      timestamp=record.timestamp, network=str(workspace_id))
        targets = asyncio.run(_route_with_llm(channel, event, db, workspace,
                                               allow_human_stop=True, allowed_agents=candidates))
        targets = [name for name in targets if name in candidates]
        db.rollback()  # end the read; take the row for the write
        record = load(True)
        current = dict((record.metadata_ or {}) if record else {})
        if not record or not isinstance(current.get(PENDING), dict):
            db.rollback()
            return  # another worker got here first
        current.pop(PENDING, None)
        metadata = current
        if metadata.get("recalled"):
            record.metadata_ = metadata
            db.commit()
            return
        for key in ("routing_decision", "router_unavailable"):
            if key in event.metadata:
                metadata[key] = event.metadata[key]
        if not targets and event.metadata.get("routing_decision") != "stop":
            _routing_choice(event, candidates)
            metadata["routing_decision"] = "ask"
            if event.metadata.get("routing_choice"):
                metadata["routing_choice"] = event.metadata["routing_choice"]
        record.metadata_ = metadata

        assignment = None
        if targets:
            payload = deepcopy(record.payload or {})
            payload["message_type"] = "chat"
            sender = str(record.source)[len("human:"):].lower()
            assignment = Event(
                type="workspace.message.posted", source=record.source, target=record.target,
                visibility=record.visibility or "channel", payload=payload,
                metadata={"routing_assignment": {"message_id": record.id, "agent": targets[0], "agents": targets,
                                                 "thread_id": channel.id, "automatic": True},
                          "acting_for": sender},
            )
            context = PipelineContext(network_id=str(workspace_id), agent_address=record.source,
                                      db=db, workspace=workspace, token=workspace.password_hash,
                                      routing_assignment_agents=targets)
            try:
                assignment = asyncio.run(pipeline.process(assignment, context))
            except EventRejected as exc:
                logger.warning("deferred_routing: %s not delivered: %s", event_id, exc.reason)
                assignment = None
        db.commit()
        logger.info("deferred_routing: %s -> %s", event_id, targets or metadata.get("routing_decision"))

        _invalidate_poll_cache(str(workspace_id), record.type)
        updates = [_snapshot(record.id, record.type, record.source, record.target, record.payload,
                             record.metadata_, record.timestamp, record.visibility or "channel")]
        if assignment is not None:
            updates.append(_snapshot(assignment.id, assignment.type, assignment.source, assignment.target,
                                     assignment.payload, assignment.metadata, assignment.timestamp))
        for snapshot in updates:
            try:
                cache.publish_event(f"ws:{workspace_id}:events",
                                    _json.dumps(snapshot, default=str, separators=(",", ":")).encode())
            except Exception:
                pass
        if assignment is not None:
            _run_cloud_invocation(str(workspace_id), updates[-1])
    finally:
        db.close()
