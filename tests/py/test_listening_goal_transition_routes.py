"""Actual private middleware, session resolver and SQL rollover route."""
import pytest
from tests.py.test_listening_goal_bonus_postgres import bonus_db, urls
from tests.py.test_listening_goal_transition_postgres import command, due
from tests.py.test_listening_goals_routes import application, headers, request, ready

PATH='/account/goals/transition'


def test_real_http_transition_without_library_and_exact_receipt(bonus_db):
    db=bonus_db
    db.add();due(db)
    # Existing real resolver returns account-only context without membership in
    # its bootstrap-selected library. No fake resolver or service is installed.
    with db.connect() as connection:
        connection.execute('delete from library.library_memberships where account_id=%s',(db.owner.account_id,))
    app=application(db)
    auth=headers(app,db)
    intent=command(db).payload()
    result=ready(app,'POST',PATH,headers=auth,payload=intent)
    assert result['action']=='transition' and result['changed']
    assert ready(app,'POST',PATH,headers=auth,payload=intent)==result
    assert ready(app,'GET','/account/goals',headers=auth)['revision']==result['revision']


@pytest.mark.parametrize('failure',['anonymous','csrf','origin','context'])
def test_private_boundary_prevents_transition(bonus_db,failure):
    db=bonus_db
    db.add();due(db)
    app=application(db)
    auth=headers(app,db)
    if failure=='anonymous':auth={}
    elif failure=='csrf':auth.pop('x-album-haven-csrf')
    elif failure=='origin':auth['origin']='https://other.example.test'
    else:auth['x-albumhaven-account-context']='0'*64
    before=db.snapshot()
    status,body,response_headers=request(app,'POST',PATH,headers=auth,payload=command(db).payload())
    assert status==(401 if failure=='anonymous' else 409 if failure=='context' else 403)
    assert response_headers[b'cache-control']==b'private, no-store'
    assert db.snapshot()==before


@pytest.mark.parametrize('field,value',[('carry_refs',[]),('bonus_origin_refs',[]),
    ('account_id',1),('library_id',1),('source_top_ref','forged')])
def test_transition_rejects_client_authority_and_membership_selection(bonus_db,field,value):
    db=bonus_db
    db.add();due(db)
    app=application(db)
    before=db.snapshot()
    status,body,response_headers=request(app,'POST',PATH,headers=headers(app,db),
        payload={**command(db).payload(),field:value})
    assert status==400 and body=={'ok':False,'error':'invalid_command'}
    assert response_headers[b'cache-control']==b'private, no-store'
    assert db.snapshot()==before
