"""Real ASGI/auth/policy/CSRF owners over synthetic DB and scheduling hooks.

No stored configuration or credentials are read. Constants below are public,
synthetic test values only. No app startup, thread or SQL executes in authoring.
"""
from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace

from starlette.requests import Request
from music_app.services import current_actor_asgi
from music_app.services.current_actor_postgres import PostgresCurrentActorResolver
from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.auth_tokens import hash_opaque_token
from music_app.routes import foobar_account_import_asgi as route
from tests.py.foobar_account_matching_synthetic import NOW
from tests.py.foobar_account_service_testing import s,CONFIG

SESSION='A'*43
AUTH={'ALBUM_HAVEN_APP_DATABASE_URL':'synthetic:no-network',
      'hmac':{'secret':'public-synthetic-test-key-not-a-credential-0000','key_version':1}}


class AuthCursor:
    def __init__(self,rows):
        self.rows=rows
    def fetchall(self):
        return self.rows


class AuthDatabase:
    def __init__(self):
        self.calls=[]
        self.session_id=3
        self.active=True
        self.revoked=False
    @contextmanager
    def connect(self,url):
        assert url=='synthetic:no-network'
        yield self
    @contextmanager
    def transaction(self):
        yield
    def execute(self,sql,params=None):
        self.calls.append(sql)
        if 'from app.account_sessions s' in sql:
            assert params[0]==hash_opaque_token(SESSION)
            return AuthCursor([dict(session_id=self.session_id,account_id=1,
                is_active=self.active,disabled_at=None,created_at=NOW,authenticated_at=NOW,
                last_seen_at=NOW,idle_expires_at=NOW+timedelta(hours=1),
                absolute_expires_at=NOW+timedelta(days=1),revoked_at=NOW if self.revoked else None,
                revocation_reason=None,user_agent=None)])
        if 'select id, is_active, disabled_at' in sql:
            assert params==(1,)
            return AuthCursor([dict(id=1,is_active=self.active,disabled_at=None)])
        if 'app.accounts.id as account_id' in sql:
            assert params==(1,)
            return AuthCursor([dict(account_id=1,username_display='Synthetic',display_name='Synthetic',
                is_active=self.active,disabled_at=None,is_bootstrap_owner=False,current_library_id=7,
                library_relationships=[dict(library_id=7,membership_role='member',is_primary_owner=False)],
                capability_grants=[dict(capability_key=action,scope_kind='library',scope_id=7)
                    for action in ('library.browse.read','library.track_preferences.manage')])])
        raise AssertionError('Unknown authentication SQL fixture')


def request(monkeypatch,body,*,handle=None,csrf=True,origin='https://synthetic.invalid',headers=()):
    db=AuthDatabase()
    sessions=PostgresAuthSessionService(AUTH,connect=db.connect,clock=lambda:NOW)
    resolver=PostgresCurrentActorResolver(AUTH,session_service=sessions,connect=db.connect)
    app=SimpleNamespace(state=SimpleNamespace(config=dict(CONFIG),auth_policy_config=dict(AUTH),
        current_actor_resolver=resolver,foobar_account_import_service=handle))
    csrf_token=issue_session_csrf(SESSION,AUTH)
    cookie=f'__Host-album_haven_session={SESSION}; __Host-album_haven_csrf={csrf_token}'
    request_headers=[(b'host',b'synthetic.invalid'),(b'origin',origin.encode()),
        (b'cookie',cookie.encode()),(b'content-type',b'application/json'),
        (b'content-length',str(len(body)).encode())]
    if csrf:
        request_headers.append((b'x-album-haven-csrf',csrf_token.encode()))
    request_headers.extend(headers)
    scope={'type':'http','method':'POST','path':'/integrations/foobar/account/apply',
        'raw_path':b'/integrations/foobar/account/apply','query_string':b'',
        'scheme':'https','server':('synthetic.invalid',443),'client':('127.0.0.1',1234),
        'headers':request_headers,'app':app,'state':{}}
    count=[0]
    async def receive():
        count[0]+=1
        return {'type':'http.request','body':body if count[0]==1 else b'','more_body':False}
    async def inline_threadpool(function,*args,**kwargs):
        return function(*args,**kwargs)
    monkeypatch.setattr(current_actor_asgi,'run_in_threadpool',inline_threadpool)
    return Request(scope,receive),db,count


def scheduler(monkeypatch,handle,*,after=None):
    """Drive genuine invocation when route polling yields; no worker thread."""
    calls=[]
    async def step(delay):
        calls.append(delay)
        owner=handle.owner
        assert owner.current is not None and owner.current.stage is s._Stage.DISPATCH
        owner.current.stage=s._Stage.RUNNING
        s._invoke(owner)
        assert not owner.current.cleanup_failed
        owner.current.stage=s._Stage.DELIVERY
        if after is not None:
            after()
    monkeypatch.setattr(route.asyncio,'sleep',step)
    return calls
