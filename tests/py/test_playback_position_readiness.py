"""Authored structural checks with explicit catalog-row fixtures, not live schema evidence."""
from copy import deepcopy
import pytest
from music_app.services import playback_position_transport as transport
from music_app.services.playback_capture import CaptureError


def catalog():
    row=dict(replication_role='origin',schema_usage=True,tables=[],columns=[],constraints=[],triggers=[],indexes=[])
    for table,columns in transport._COLUMNS.items():
        row['tables'].append(dict(relname=table,can_select=True,can_insert=True,can_update=True,can_delete=True,relrowsecurity=False))
        for name,(kind,required) in columns.items():
            row['columns'].append(dict(relname=table,attname=name,kind=kind,attnotnull=required,attidentity='a' if name=='id' else ''))
    for table,names in transport._REQUIRED_CHECKS.items():
        for name in names:row['constraints'].append(dict(relname=table,conname=name,contype='c',convalidated=True))
    for (table,key),(schema,target,target_key,delete) in transport._FOREIGN_KEYS.items():
        row['constraints'].append(dict(relname=table,conname=table+'_'+key,contype='f',convalidated=True,
            keys=[key],foreign_schema=schema,foreign_table=target,foreign_keys=[target_key],confdeltype={'cascade':'c','set null':'n'}[delete]))
    for name,(table,function,kind,deferred,initial) in transport._TRIGGERS.items():
        row['triggers'].append(dict(tgname=name,relname=table,proname=function,tgtype=kind,tgdeferrable=deferred,
            tginitdeferred=initial,tgnargs=0,unconditional=True,tgenabled='O',function_schema='integration',pronargs=0,returns_trigger=True,
            prosecdef=False,can_execute=True,attrs=['account_id'] if name=='playback_capture_anonymize_owner' else []))
    for table,keys in transport._KEYS.items():
        for key,where in keys:row['indexes'].append(dict(relname=table,keys=list(key),indnkeyatts=len(key),no_expressions=True,predicate=where,indisunique=True,indisvalid=True,indisready=True))
    return row


class Connection:
    def __init__(self,row):self.row=row;self.calls=[]
    def execute(self,sql,params):self.calls.append((sql,params));return self
    def fetchone(self):return self.row


def test_one_bounded_catalog_query_has_no_cross_request_cache():
    row=catalog();connection=Connection(row)
    transport.require_position_storage(connection);assert len(connection.calls)==1
    row['triggers'][0]['tgenabled']='D'
    with pytest.raises(CaptureError,match='capture_unavailable'):transport.require_position_storage(connection)
    assert len(connection.calls)==2


@pytest.mark.parametrize('mutation',[
    lambda r:r.update(replication_role='replica'),lambda r:r.update(schema_usage=False),
    lambda r:r['triggers'][0].update(tgnargs=1),lambda r:r['triggers'][0].update(unconditional=False),
    lambda r:r['indexes'][0].update(no_expressions=False),lambda r:r['indexes'][0].update(indnkeyatts=99),
    lambda r:r['tables'].pop(),lambda r:r['columns'].pop(),lambda r:r['triggers'].pop(),
    lambda r:r['tables'][0].update(can_select=False),lambda r:r['tables'][0].update(can_insert=False),
    lambda r:r['tables'][0].update(relrowsecurity=True),
    lambda r:r['columns'][0].update(attidentity='d'),lambda r:r['columns'][0].update(kind='text'),lambda r:r['columns'][0].update(attnotnull=not r['columns'][0]['attnotnull']),
    lambda r:r['constraints'][0].update(convalidated=False),lambda r:r['constraints'].clear(),
    lambda r:r['triggers'][0].update(proname='wrong_function'),lambda r:r['triggers'][0].update(relname='wrong_table'),
    lambda r:r['triggers'][0].update(tgtype=0),lambda r:r['triggers'][0].update(pronargs=1),
    lambda r:r['triggers'][0].update(tgenabled='R'),lambda r:r['triggers'][0].update(can_execute=False),
    lambda r:r['triggers'][0].update(attrs=['unrelated']),lambda r:r['triggers'][0].update(prosecdef=True),
    lambda r:r['indexes'][0].update(indisunique=False),lambda r:r['indexes'][0].update(indisvalid=False),
    lambda r:r['indexes'][0].update(predicate='false'),lambda r:r['indexes'][0].update(keys=['wrong']),
])
def test_incompatible_structure_never_advertises(mutation):
    row=catalog();mutation(row)
    with pytest.raises(CaptureError,match='capture_unavailable'):transport.require_position_storage(Connection(row))


def test_foreign_key_deletion_semantics_are_checked_not_only_names():
    row=catalog();next(x for x in row['constraints'] if x['contype']=='f')['confdeltype']='r'
    with pytest.raises(CaptureError,match='capture_unavailable'):transport.require_position_storage(Connection(row))


@pytest.mark.parametrize('extension',['absent','full','partial'])
@pytest.mark.parametrize('enabled',[False,True])
def test_context_optional_extension_is_absent_or_ready_never_partial(monkeypatch,extension,enabled):
    from contextlib import contextmanager
    from music_app.services import private_library_authority as authority
    from music_app.services import playback_capture_postgres as writer
    from music_app.services import playback_edition_selection as selection
    class OptionalConnection:
        def execute(self,*args):return self
        def fetchone(self):return {'present':extension!='absent'}
    @contextmanager
    def transaction(*args,**kwargs):yield OptionalConnection(),object(),None
    monkeypatch.setattr(authority,'current_library_transaction',transaction)
    monkeypatch.setattr(authority,'require_private_action',lambda *a,**k:None)
    monkeypatch.setattr(writer,'_selector',lambda *a:None)
    monkeypatch.setattr(writer,'_final_authority',lambda *a:None)
    monkeypatch.setattr(transport,'require_position_storage',lambda *a:None)
    monkeypatch.setattr(selection,'selection_schema_ready',lambda *a:extension=='full')
    if extension=='partial':
        with pytest.raises(CaptureError):transport.check_position_capture_context('fixture',object(),selections=enabled)
    else:
        assert transport.check_position_capture_context('fixture',object(),selections=enabled)==(enabled and extension=='full')
