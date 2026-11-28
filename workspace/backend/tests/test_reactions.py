from sqlalchemy import select
from app.models import EventRecord, MessageReaction
from app.routers import reactions
from tests.test_visibility import people, no_push, _bearer, _create_thread


def test_reactions_are_personal_idempotent_and_do_not_dispatch(client,workspace,people,db):
    _create_thread(client,workspace,name='react',by='mia',visibility='public')
    db.add(EventRecord(id='human-msg',network_id=workspace['id'],type='workspace.message.posted',source='human:mia@acme.test',target='channel/react',payload={'content':'Hello'},timestamp=1))
    db.commit()
    url=f"/v1/reactions/human-msg?network={workspace['id']}"
    for _ in range(2):
        response=client.put(url,headers=_bearer('mia'),json={'emoji':'👍','active':True})
        assert response.status_code==200,response.text
        assert response.json()['data']==[{'emoji':'👍','count':1,'mine':True,'people':['mia@acme.test']}]
    response=client.put(url,headers=_bearer('adam'),json={'emoji':'👍','active':True})
    # Who gave it, in the order they did.
    assert response.json()['data']==[{'emoji':'👍','count':2,'mine':True,'people':['mia@acme.test','adam@acme.test']}]
    response=client.put(url,headers=_bearer('mia'),json={'emoji':'👍','active':False})
    assert response.json()['data']==[{'emoji':'👍','count':1,'mine':False,'people':['adam@acme.test']}]
    assert len(db.execute(select(MessageReaction)).scalars().all())==1
    assert len(db.execute(select(EventRecord).where(EventRecord.type=='workspace.message.posted')).scalars().all())==1
    assert client.put(url,headers=_bearer('adam'),json={'emoji':'bad','active':True}).status_code==422


def test_reactions_respect_private_threads_and_dms(client,workspace,people,db):
    _create_thread(client,workspace,name='secret-react',by='mia')
    for mid,source,target in [('private','human:mia@acme.test','channel/secret-react'),('dm','human:mia@acme.test','human:vic@acme.test'),('agent','openagents:agent-alpha','channel/secret-react')]:
        db.add(EventRecord(id=mid,network_id=workspace['id'],type='workspace.message.posted',source=source,target=target,payload={'content':'secret'},timestamp=1))
    db.commit()
    for mid in ['private','dm','agent']:
        assert client.put(f"/v1/reactions/{mid}?network={workspace['id']}",headers=_bearer('adam'),json={'emoji':'❤️','active':True}).status_code==404
    result=client.post(f"/v1/reactions/query?network={workspace['id']}",headers=_bearer('adam'),json={'ids':['private','dm','agent']})
    assert result.json()['data']=={}
    assert client.put(f"/v1/reactions/dm?network={workspace['id']}",headers=_bearer('mia'),json={'emoji':'❤️','active':True}).status_code==200


def test_query_checks_each_room_once_per_request(client, workspace, people, db, monkeypatch):
    _create_thread(client, workspace, name="visible-room", by="mia", visibility="public")
    _create_thread(client, workspace, name="hidden-room", by="mia")
    rooms = {"visible-room": 20, "hidden-room": 2}
    ids = []
    for room, count in rooms.items():
        for index in range(count):
            msg_id = f"{room}-{index}"
            ids.append(msg_id)
            db.add(EventRecord(id=msg_id, network_id=workspace["id"], type="workspace.message.posted",
                               source="human:mia@acme.test", target=f"channel/{room}",
                               payload={"content": "Hello"}, timestamp=index))
    db.commit()

    checked = []
    original = reactions.can_view_channel

    def record_check(db, workspace_id, viewer, channel):
        checked.append(channel.name)
        return original(db, workspace_id, viewer, channel)

    monkeypatch.setattr(reactions, "can_view_channel", record_check)
    result = client.post(f"/v1/reactions/query?network={workspace['id']}",
                         headers=_bearer("adam"), json={"ids": ids})
    assert result.status_code == 200, result.text
    assert set(result.json()["data"]) == set(ids[:20])
    assert sorted(checked) == sorted(rooms)


def test_people_react_to_a_bots_answer_but_not_its_status(client,workspace,people,db):
    _create_thread(client,workspace,name='bot-react',by='mia',visibility='public')
    db.add(EventRecord(id='bot-answer',network_id=workspace['id'],type='workspace.message.posted',source='openagents:agent-alpha',target='channel/bot-react',payload={'content':'Done'},timestamp=1))
    db.add(EventRecord(id='bot-status',network_id=workspace['id'],type='workspace.message.posted',source='openagents:agent-alpha',target='channel/bot-react',payload={'content':'working','message_type':'status'},timestamp=2))
    db.commit()
    response=client.put(f"/v1/reactions/bot-answer?network={workspace['id']}",headers=_bearer('mia'),json={'emoji':'✅','active':True})
    assert response.status_code==200,response.text
    assert response.json()['data']==[{'emoji':'✅','count':1,'mine':True,'people':['mia@acme.test']}]
    assert client.put(f"/v1/reactions/bot-status?network={workspace['id']}",headers=_bearer('mia'),json={'emoji':'✅','active':True}).status_code==404
    # A reaction is no message: nothing new for an agent to pick up.
    assert len(db.execute(select(EventRecord).where(EventRecord.type=='workspace.message.posted')).scalars().all())==2
