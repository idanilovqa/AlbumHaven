"""Authored-only service fixtures. No threads or SQL execute during authoring.

OPEN/RUNNING transitions below are explicit scheduler hooks, not startup proof.
Real service admission, lifecycle, retry, and business owners remain in use.
"""
from contextlib import contextmanager
import json

from music_app.services import foobar_account_import_service as s
from music_app.services import foobar_account_retry_reconciliation as reconciliation
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.foobar_account_matching_composed_boundary import (
    install as install_db, prepare, apply_command, context, command,
    PAYLOAD,CAPACITY,SOURCE,GEN,KEY,APPLY_KEY,p,a,f,
)
from tests.py.test_foobar_account_matching_chain import install_status_boundary

CONFIG={
    'ALBUM_HAVEN_FOOBAR_ACCOUNT_IMPORT_ENABLED':True,
    'ALBUM_HAVEN_FOOBAR_IMPORT_INTAKE_BYTES':512*1024*1024,
    'ALBUM_HAVEN_FOOBAR_IMPORT_TOTAL_LOGICAL_BYTES':1024*1024*1024,
}


def handles(monkeypatch,count=1,*,open=True):
    monkeypatch.setattr(s,'_PROCESS_OWNER',None)
    configuration=dict(CONFIG)
    result=tuple(s.create_foobar_import_service(configuration,database_url='synthetic:no-network')
                 for unused in range(count))
    if open:
        result[0].owner.state=s._State.OPEN  # Controlled scheduler boundary only.
    return result


def begin_prepare(handle,cmd=None,ctx=None,constraints=None):
    return handle.begin_prepare(context=ctx or context(),
        constraints=constraints or PolicyEvaluationConstraints(),command=cmd or command(),length=len(PAYLOAD))


def dispatch_prepare(handle,cmd=None,ctx=None,constraints=None):
    ticket=begin_prepare(handle,cmd,ctx,constraints)
    handle.append_prepare(ticket,PAYLOAD)
    handle.finish_prepare(ticket)
    handle.owner.current.stage=s._Stage.RUNNING
    return ticket


def begin_apply(handle,cmd,ctx=None):
    ticket=handle.begin_apply(context=ctx or context(),constraints=PolicyEvaluationConstraints(),command=cmd)
    handle.owner.current.stage=s._Stage.RUNNING
    return ticket


def install_reconciliation(monkeypatch,db):
    status=install_status_boundary(monkeypatch,db)
    dispatch=db.dispatch

    @contextmanager
    def outer(url,live,*,constraints=None):
        with db.outer(url,live,matching_library_id=None,constraints=constraints) as result:
            yield result

    def query(sql,params):
        if sql==reconciliation._KEY_SQL:
            frame=json.loads(params[0])
            assert frame[:4]==[1,None,SOURCE,GEN]
            key=db.keys.get(frame[4])
            if key is None:
                return []
            return [dict(key,created_at=db.receipt['created_at'],retired_at=None,
                         retired_reason=None,observed_at=db.now)]
        return dispatch(sql,params)

    monkeypatch.setattr(reconciliation,'current_foobar_account_transaction',outer)
    monkeypatch.setattr(db,'dispatch',query)
    return status
