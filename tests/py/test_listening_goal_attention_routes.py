"""Actual ASGI middleware, session resolver and PostgreSQL attention methods."""
import pytest
from tests.py.test_listening_goal_bonus_postgres import bonus_db, urls
from tests.py.test_listening_goal_attention_postgres import attention_db, intent, acknowledgments
from tests.py.test_listening_goals_routes import application, headers, request, ready

READ = '/account/goals/attention'
ACK = READ+'/ack'


def test_account_only_read_ack_receipt_and_no_store(attention_db):
    db = attention_db
    db.add()
    with db.connect() as connection:
        connection.execute('delete from library.library_memberships where account_id=%s',(db.owner.account_id,))
    app = application(db); auth = headers(app,db)
    status, body, response_headers = request(app,'GET',READ,headers=auth)
    assert status == 200 and response_headers[b'cache-control'] == b'private, no-store'
    assert body['data']['indicator'] == 'blue'
    command = intent(db).payload()
    receipt = ready(app,'POST',ACK,headers=auth,payload=command)
    assert receipt['changed'] and receipt['event'] == command['event']
    assert ready(app,'POST',ACK,headers=auth,payload=command) == receipt
    assert ready(app,'GET',READ,headers=auth)['indicator'] == 'none'
    operation = ready(app,'GET','/account/goals/operations/'+command['request_key'],headers=auth)
    assert operation == {'status':'committed','receipt':receipt}


@pytest.mark.parametrize('failure',['anonymous','csrf','origin','context'])
def test_boundary_rejects_unauthorized_ack(attention_db,failure):
    db = attention_db
    db.add(); app = application(db); auth = headers(app,db); command = intent(db).payload()
    if failure == 'anonymous': auth = {}
    elif failure == 'csrf': auth.pop('x-album-haven-csrf')
    elif failure == 'origin': auth['origin'] = 'https://other.example.test'
    else: auth['x-albumhaven-account-context'] = '0'*64
    before = db.snapshot()
    status, body, response_headers = request(app,'POST',ACK,headers=auth,payload=command)
    assert status == (401 if failure=='anonymous' else 409 if failure=='context' else 403)
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.snapshot() == before and acknowledgments(db) == []


@pytest.mark.parametrize('query',['?unknown=1','?period=week&period=month'])
@pytest.mark.parametrize('method',['GET','POST'])
def test_no_query_parameters(attention_db,method,query):
    db = attention_db
    db.add(); app = application(db)
    kwargs = {'payload':intent(db).payload()} if method=='POST' else {}
    status,body,response_headers = request(app,method,(ACK if method=='POST' else READ)+query,
        headers=headers(app,db),**kwargs)
    assert status == 400 and body == {'ok':False,'error':'invalid_query'}
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert acknowledgments(db) == []


@pytest.mark.parametrize('field',['account_id','library_id','revision','acknowledged_at','completed'])
def test_client_authority_fields_rejected(attention_db,field):
    db = attention_db
    db.add(); app = application(db); before = db.snapshot()
    status,body,_ = request(app,'POST',ACK,headers=headers(app,db),payload={**intent(db).payload(),field:1})
    assert status == 400 and body == {'ok':False,'error':'invalid_command'}
    assert db.snapshot() == before and acknowledgments(db) == []


def test_oversized_body_does_not_write(attention_db):
    db = attention_db
    db.add(); app = application(db)
    status,body,_ = request(app,'POST',ACK,headers=headers(app,db),payload={**intent(db).payload(),'padding':'x'*9000})
    assert status == 413 and body == {'ok':False,'error':'body_too_large'}
    assert acknowledgments(db) == []


def test_foreign_session_read_has_no_other_accounts_attention(attention_db):
    db = attention_db
    db.add(); command = intent(db).payload()
    with db.connect() as connection: other = db.actor(connection)
    app = application(db); auth = headers(app,db,other)
    value = ready(app,'GET',READ,headers=auth)
    assert value['goal_ref'] is None and value['weekly_event'] is None and value['indicator'] == 'none'
    status,body,_ = request(app,'POST',ACK,headers=auth,payload=command)
    assert status == 409 and body == {'ok':False,'error':'attention_event_changed'}
    assert acknowledgments(db) == []
