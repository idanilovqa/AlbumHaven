"""Task 7 measured ledger contracts through existing public history services.

Uses the same isolated contract DB variables as the saved-loop contracts; no
schema-wide cleanup or test-owned migration runner is introduced.
"""
import copy
import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Barrier
from urllib.parse import urlparse
import pytest
from music_app.services import listen_history as history
from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter


@pytest.fixture
def ledger(tmp_path):
    import psycopg
    from psycopg.rows import dict_row
    app_url=os.environ.get('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL','')
    if not app_url:pytest.skip('Requires isolated Postgres contract database')
    setup_url=os.environ.get('DATABASE_MIGRATOR_URL','')
    parsed=urlparse(app_url)
    assert parsed.hostname in {'localhost','127.0.0.1','::1'}
    assert re.fullmatch(r'(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*',parsed.path.lstrip('/'))
    assert setup_url and urlparse(setup_url).path==parsed.path
    def connect():return psycopg.connect(setup_url,row_factory=dict_row)
    accounts=[];libraries=[];token=uuid.uuid4().hex
    def scope(connection):
        username=f'measured-{token}-{len(accounts)}'
        account=connection.execute('insert into app.accounts(display_name,username_display,username_normalized,contact_email,contact_email_normalized) values(%s,%s,%s,%s,%s) returning id',(username,username,username,username+'@example.test',username+'@example.test')).fetchone()['id'];accounts.append(account)
        library=connection.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',(account,username)).fetchone()['id'];libraries.append(library)
        track=connection.execute('insert into library.local_tracks(library_id,track_key,title,duration_seconds) values(%s,%s,%s,120) returning id',(library,username,'Same title')).fetchone()['id']
        path=(tmp_path/f'{username}.flac').resolve();path.write_bytes(b'track-identity-fixture')
        connection.execute('insert into library.local_track_files(track_id,private_path) values(%s,%s)',(track,str(path)))
        return {'account_id':account,'library_id':library,'track_id':track,'path':str(path)}
    try:
        with connect() as connection:own=scope(connection);other=scope(connection)
        yield {'config':{'ALBUM_HAVEN_APP_DATABASE_URL':app_url},'connect':connect,'own':own,'other':other}
    finally:
        with connect() as connection:
            for library in libraries:connection.execute('delete from library.libraries where id=%s',(library,))
            for account in accounts:connection.execute('delete from app.accounts where id=%s',(account,))


def measured(scope,**changes):
    result={'measurement_version':'rendered-pcm-v1','device_id':str(uuid.uuid4()),'session_id':str(uuid.uuid4()),
        'sequence':1,'measured_listened_seconds':12.5,'max_measured_contiguous_seconds':11.0,'finalized':False,
        'path':scope['path'],'track_ref':scope['path'],'canonical_match':{'library_track_id':str(scope['track_id'])},
        'started_at':'2026-09-09T12:00:00+00:00','started_at_unix':1788955200,'ended_at':'2026-09-09T12:00:13+00:00',
        'title':'Same title','artist':'Artist','duration_seconds':120,'total_listened_seconds':400,
        'max_contiguous_seconds':400,'source_provenance':{'kind':'local_playback','provider':'album_haven'},'scrobbled':False}
    result.update(changes);return result


def append(store,item,scope=None):
    owner=scope or store['own']
    return history.append_listen_history_entry(store['config'],copy.deepcopy(item),account_id=owner['account_id'],library_id=owner['library_id'])


def rows(store,scope=None):
    owner=scope or store['own']
    with store['connect']() as connection:
        return connection.execute('select * from integration.listen_history where account_id=%s and library_id=%s order by id',(owner['account_id'],owner['library_id'])).fetchall()


def test_identical_completion_retry_keeps_one_measured_row_and_identity(ledger):
    entry=measured(ledger['own']);first=append(ledger,entry);second=append(ledger,entry)
    assert first['id']==second['id']
    stored=rows(ledger);assert len(stored)==1
    assert stored[0]['track_id']==ledger['own']['track_id']
    assert float(stored[0]['measured_listened_seconds'])==12.5 and stored[0]['last_sequence']==1
    assert str(stored[0]['session_id'])==entry['session_id']


def test_concurrent_identical_completions_atomically_deduplicate(ledger):
    entry=measured(ledger['own']);barrier=Barrier(2)
    def complete():barrier.wait(timeout=5);return append(ledger,entry)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _index:complete(),range(2)))
    assert results[0]['id']==results[1]['id'] and len(rows(ledger))==1


def test_concurrent_conflicting_same_sequence_has_one_commit_and_one409(ledger):
    entry=measured(ledger['own']);barrier=Barrier(2)
    def complete(total):
        barrier.wait(timeout=5)
        try:append(ledger,{**entry,'measured_listened_seconds':total});return 200
        except ValueError as error:return getattr(error,'status_code',None)
    with ThreadPoolExecutor(max_workers=2) as pool:statuses=list(pool.map(complete,[12.5,14.5]))
    assert sorted(statuses)==[200,409] and len(rows(ledger))==1


def test_newer_monotonic_update_reuses_row_and_older_sequence_is_ignored(ledger):
    entry=measured(ledger['own']);append(ledger,entry);row_id=rows(ledger)[0]['id']
    append(ledger,{**entry,'sequence':2,'measured_listened_seconds':20,'max_measured_contiguous_seconds':15,'finalized':True})
    append(ledger,entry)
    row=rows(ledger)[0]
    assert row['id']==row_id and row['last_sequence']==2 and float(row['measured_listened_seconds'])==20 and row['finalized'] is True


@pytest.mark.parametrize('changes',[
    {'measured_listened_seconds':11},{'max_measured_contiguous_seconds':10},
    {'started_at':'2026-09-09T13:00:00+00:00'},
    {'source_provenance':{'kind':'import','provider':'foreign'}},
])
def test_newer_sequence_cannot_rewrite_identity_or_regress_counters(ledger,changes):
    entry=measured(ledger['own']);append(ledger,entry);before=rows(ledger)
    with pytest.raises(ValueError) as caught:append(ledger,{**entry,'sequence':2,**changes})
    assert getattr(caught.value,'status_code',None) in (400,409)
    assert rows(ledger)==before


def test_finalized_session_cannot_be_reopened(ledger):
    entry=measured(ledger['own'],finalized=True);append(ledger,entry)
    with pytest.raises(ValueError):append(ledger,{**entry,'sequence':2,'finalized':False,'measured_listened_seconds':15})
    assert rows(ledger)[0]['finalized'] is True


@pytest.mark.parametrize('changes',[
    {'measured_listened_seconds':float('nan')},{'measured_listened_seconds':float('inf')},
    {'measured_listened_seconds':-1},{'max_measured_contiguous_seconds':13},
    {'sequence':True},{'sequence':-1},{'sequence':1.5},
    {'device_id':'not-a-uuid'},{'session_id':None},
])
def test_malformed_measurement_never_inserts_a_ledger_row(ledger,changes):
    with pytest.raises(ValueError):append(ledger,measured(ledger['own'],**changes))
    assert rows(ledger)==[]


def test_same_device_and_session_ids_remain_independent_across_scopes(ledger):
    own=measured(ledger['own']);append(ledger,own)
    other=measured(ledger['other'],device_id=own['device_id'],session_id=own['session_id'])
    append(ledger,other,ledger['other'])
    assert len(rows(ledger))==len(rows(ledger,ledger['other']))==1
    assert rows(ledger)[0]['id']!=rows(ledger,ledger['other'])[0]['id']


def test_foreign_track_cannot_be_claimed_by_payload_or_matching_display_text(ledger):
    entry=measured(ledger['other'])
    with pytest.raises(ValueError):append(ledger,entry)
    assert rows(ledger)==[] and rows(ledger,ledger['other'])==[]


def test_scrobble_update_changes_same_scoped_row_without_duplicate(ledger):
    entry=append(ledger,measured(ledger['own']));row_id=rows(ledger)[0]['id']
    owner=ledger['own']
    history.update_listen_history_entry(ledger['config'],entry['id'],{'scrobbled':True},account_id=owner['account_id'],library_id=owner['library_id'])
    assert len(rows(ledger))==1 and rows(ledger)[0]['id']==row_id
    other=ledger['other'];before=rows(ledger)
    assert history.update_listen_history_entry(ledger['config'],entry['id'],{'scrobbled':False},account_id=other['account_id'],library_id=other['library_id']) is None
    assert rows(ledger)==before


def test_legacy_collection_save_preserves_measured_family(ledger, monkeypatch):
    from music_app.services import listen_history_postgres as repository
    owner = ledger['own']
    monkeypatch.setattr(repository, '_bootstrap_context_sql', lambda: (
        f"with bootstrap_context as (select {owner['account_id']}::bigint account_id, {owner['library_id']}::bigint library_id)"
    ))
    append(ledger,measured(ledger['own']));before=rows(ledger)
    surviving=[]
    @contextmanager
    def rollback_connection():
        with ledger['connect']() as connection:
            # Exercise legacy replacement without committing changes to any
            # pre-existing legacy rows in this shared isolated contract DB.
            with connection.transaction(force_rollback=True):
                yield connection
                surviving.extend(connection.execute('select id from integration.listen_history where id=%s',(before[0]['id'],)).fetchall())
    PostgresListenHistoryAdapter(ledger['config'],connect=lambda _url:rollback_connection()).save_items([])
    assert [row['id'] for row in surviving]==[before[0]['id']]
    assert rows(ledger)==before


@pytest.mark.parametrize('total,expected',[(0,False),(10,False),(10.001,True)])
def test_local_meaningful_threshold_uses_measured_time_not_media_distance(total,expected):
    entry={'measurement_version':'rendered-pcm-v1','measured_listened_seconds':total,
        'max_measured_contiguous_seconds':min(total,5),'total_listened_seconds':400,'max_contiguous_seconds':400}
    assert history.is_meaningful_listen_session(entry) is expected


@pytest.mark.parametrize("changes", [
    {"ended_at": "2026-09-09T12:00:14+00:00"},
    {"total_listened_seconds": 399},
    {"title": "Changed title"},
])
def test_same_sequence_requires_identical_accepted_completion_payload(ledger, changes):
    entry = measured(ledger["own"])
    append(ledger, entry)
    before = rows(ledger)
    with pytest.raises(ValueError) as caught:
        append(ledger, {**entry, **changes})
    assert getattr(caught.value, "status_code", None) == 409
    assert rows(ledger) == before
