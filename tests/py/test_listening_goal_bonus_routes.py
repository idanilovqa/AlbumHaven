"""Real session, middleware, CSRF, library authority and SQL bonus routes."""
import pytest
from tests.py.test_listening_goal_bonus_postgres import bonus_db, urls
from tests.py.test_listening_goals_routes import application, headers, request, ready

DRAW='/account/goals/bonus/draw'
CURRENT='/account/goals/bonus'


@pytest.fixture(autouse=True)
def real_current_library(bonus_db):
    # Same persisted resolver convention as test_listening_goals_ui_context.linked.
    # Reuse an existing anchor/library; never replace global bootstrap ownership.
    db=bonus_db
    with db.connect() as connection:
        owner=connection.execute("select account_id from app.bootstrap_owners where owner_key='local-bootstrap-owner'").fetchone()
        if owner is None:
            anchor=db.actor(connection)
            connection.execute("insert into app.bootstrap_owners(account_id,owner_key) values(%s,'local-bootstrap-owner')",(anchor.account_id,))
            anchor_id=anchor.account_id
        else:
            anchor_id=owner['account_id']
        library=connection.execute("select id from library.libraries where owner_account_id=%s and library_kind='local' order by id limit 1",(anchor_id,)).fetchone()
        if library is None:
            library=connection.execute("insert into library.libraries(owner_account_id,name) values(%s,%s) returning id",(anchor_id,'Synthetic bonus HTTP '+db.token)).fetchone()
            db.library_ids.append(library['id'])
    db.library=library['id']
    db.owner=db.member(db.owner)
    return db


def test_actual_http_draw_and_retained_read_use_existing_envelope(bonus_db):
    db=bonus_db
    _,refs=db.source()
    db.settings(enabled=True,album_mode='next')
    app=application(db)
    auth=headers(app,db)
    payload=db.draw_command().payload()
    receipt=ready(app,'POST',DRAW,headers=auth,payload=payload)
    assert receipt['catalog_ref']==refs[0] and receipt['changed']
    assert ready(app,'POST',DRAW,headers=auth,payload=payload)==receipt
    assert ready(app,'GET',CURRENT,headers=auth)=={
        'cycle_id':receipt['cycle_id'],'bonus':{'catalog_ref':refs[0],'present':True},'manual_count':0}
    state=ready(app,'GET','/account/goals',headers=auth)
    assert state['albums'][0]['catalog_ref']==refs[0]
    assert db.provider_calls==[]


@pytest.mark.parametrize('failure',['anonymous','csrf','origin','context'])
def test_draw_private_boundary_prevents_mutation(bonus_db,failure):
    db=bonus_db
    db.source()
    db.settings(enabled=True)
    app=application(db)
    auth=headers(app,db)
    if failure=='anonymous':auth={}
    elif failure=='csrf':auth.pop('x-album-haven-csrf')
    elif failure=='origin':auth['origin']='https://other.example.test'
    else:auth['x-albumhaven-context']='0'*64
    status,body,response_headers=request(app,'POST',DRAW,headers=auth,payload=db.draw_command().payload())
    assert status==(401 if failure=='anonymous' else 409 if failure=='context' else 403)
    assert response_headers[b'cache-control']==b'private, no-store'
    assert db.service.read(db.context())['goal_ref'] is None


@pytest.mark.parametrize('field,value',[('catalog_ref','forged'),('top_ref','forged'),
    ('library_id',1),('account_id',1),('random_seed',0),('period','month')])
def test_draw_rejects_all_client_admission_and_random_authority(bonus_db,field,value):
    db=bonus_db
    app=application(db)
    status,body,response_headers=request(app,'POST',DRAW,headers=headers(app,db),
        payload={**db.draw_command().payload(),field:value})
    assert status==400 and body=={'ok':False,'error':'invalid_command'}
    assert response_headers[b'cache-control']==b'private, no-store'


def test_bonus_read_has_no_library_precondition_and_rejects_query(bonus_db):
    db=bonus_db
    app=application(db)
    auth=headers(app,db)
    with db.connect() as connection:
        connection.execute('delete from library.library_memberships where account_id=%s',(db.owner.account_id,))
    assert ready(app,'GET',CURRENT,headers=auth)=={'cycle_id':None,'bonus':None,'manual_count':0}
    status,body,response_headers=request(app,'GET',CURRENT+'?account_id=1',headers=auth)
    assert status==400 and body=={'ok':False,'error':'invalid_query'}
    assert response_headers[b'cache-control']==b'private, no-store'
