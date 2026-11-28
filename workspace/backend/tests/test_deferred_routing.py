"""A person's room message answers before the routing model is asked
(services/deferred_routing.py); the pick is acted on after the response."""
from unittest.mock import patch

import pytest
from sqlalchemy import select

from app.config import config
from app.models import EventRecord
from tests.test_issues import two_members, _bearer  # noqa: F401
from tests.test_routing_choice import thread  # noqa: F401
from tests.test_visibility import no_push  # noqa: F401


@pytest.fixture
def router_on(monkeypatch, thread):
    monkeypatch.setattr(config, 'ROUTER_LLM_ENABLED', True)
    # A routing model is configured (the call itself is patched in each test).
    monkeypatch.setattr(config, 'MESSAGE_ROUTER_MODEL', 'stub/decisions')
    monkeypatch.setattr(config, 'MESSAGE_ROUTER_API_KEY', 'test-key')
    return thread


def send(client, ws, room, text='Publish this blog'):
    response = client.post('/v1/events', headers=_bearer('ann'), json={
        'network': ws['id'], 'type': 'workspace.message.posted', 'source': 'human:spoof',
        'target': f'channel/{room.name}', 'payload': {'content': text},
    })
    assert response.status_code == 200, response.text
    return response.json()['data']


def copies_of(db, event_id):
    return [r for r in db.execute(select(EventRecord)).scalars()
            if (r.metadata_ or {}).get('routing_assignment', {}).get('message_id') == event_id]


def test_send_answers_before_the_model_and_wakes_its_pick(client, workspace, router_on, db):
    async def pick(channel, event, *args, **kwargs):
        event.metadata['routing_decision'] = 'assign'
        return ['agent-beta']

    with patch('app.mods.workspace_mod._route_with_llm', side_effect=pick) as model, \
            patch('app.services.cloud_agent._run_cloud_invocation') as wake:
        data = send(client, workspace, router_on)
    # The answer came back with no agent woken and the routing still to do.
    assert data['metadata']['target_agents'] == ['__no_response__']
    assert set(data['metadata']['routing_deferred']['candidates']) == {'agent-alpha', 'agent-beta'}
    # The background task asked the model once and woke its pick by a hidden copy.
    assert model.call_count == 1
    original = db.get(EventRecord, data['id'])
    db.refresh(original)
    assert 'routing_deferred' not in original.metadata_
    assert original.metadata_['target_agents'] == ['__no_response__']
    [copy] = copies_of(db, data['id'])
    assert copy.metadata_['target_agents'] == ['agent-beta']
    assert copy.payload['content'] == 'Publish this blog'
    assert copy.source == 'human:ann@acme.test'
    assert wake.call_count == 1


def test_an_unclear_answer_becomes_the_senders_choice(client, workspace, router_on, db):
    async def unsure(channel, event, *args, **kwargs):
        event.metadata['routing_decision'] = 'ask'
        return []

    with patch('app.mods.workspace_mod._route_with_llm', side_effect=unsure):
        data = send(client, workspace, router_on)
    original = db.get(EventRecord, data['id'])
    db.refresh(original)
    assert 'routing_deferred' not in original.metadata_
    assert original.metadata_['routing_choice']['status'] == 'pending'
    assert original.metadata_['routing_choice']['requester_email'] == 'ann@acme.test'
    assert copies_of(db, data['id']) == []


def test_stop_wakes_nobody(client, workspace, router_on, db):
    async def stop(channel, event, *args, **kwargs):
        event.metadata['routing_decision'] = 'stop'
        return []

    with patch('app.mods.workspace_mod._route_with_llm', side_effect=stop):
        data = send(client, workspace, router_on, 'thanks all')
    original = db.get(EventRecord, data['id'])
    db.refresh(original)
    assert original.metadata_.get('routing_decision') == 'stop'
    assert 'routing_choice' not in original.metadata_
    assert copies_of(db, data['id']) == []


def test_no_model_configured_answers_at_once(client, workspace, router_on, db, monkeypatch):
    monkeypatch.setattr(config, 'MESSAGE_ROUTER_MODEL', '')
    monkeypatch.setattr(config, 'MESSAGE_ROUTER_API_KEY', '')
    monkeypatch.setattr('app.mods.workspace_mod._get_router_api_key', lambda: '')
    data = send(client, workspace, router_on)
    assert 'routing_deferred' not in data['metadata']
    assert data['metadata']['routing_choice']['status'] == 'pending'


def test_a_mention_is_not_deferred(client, workspace, router_on, db):
    with patch('app.mods.workspace_mod._route_with_llm') as model:
        data = send(client, workspace, router_on, '@agent-alpha publish this')
    assert model.call_count == 0
    assert data['metadata']['target_agents'] == ['agent-alpha']
    assert 'routing_deferred' not in data['metadata']
