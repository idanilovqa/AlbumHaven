"""Authored real native Top/taste/baseline SQL contracts; not executed.

Uses the retained favorites_db owned synthetic library/account fixture, which
commits setup and its own cleanup. This is not a rollback-only fixture. Optional
baseline/settings/rating schema must be separately prepared; no DDL here. No
canonical library, user files, provider history or playback is modified.
"""
from uuid import uuid4
import pytest
from music_app.services.owned_album_tops import normalize_top_command,AlbumTopError
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.album_top_current_listening import PostgresTopCurrentListening
from music_app.services.playback_capture import CaptureError
from tests.py.album_favorites_postgres_support import favorites_db

@pytest.fixture
def top_db(favorites_db):
    db=favorites_db;db.config['ALBUM_HAVEN_TOP_LISTENING_PRESENTATION_ENABLED']=True
    owner=PostgresOwnedAlbumTopsService(db.config,connect=db.app_connect,clock=lambda:db.clock_time)
    ref=owner.admit_inventory_album(db.context(),album_id=db.albums[0]['id'])['album_ref']
    receipt=None
    try:
        receipt=owner.execute(db.context(),normalize_top_command('create',dict(request_key=str(uuid4()),
            title='Synthetic current listening',description='',album_refs=[ref])))
        with db.connect() as con:
            item=con.execute('select ref,catalog_ref,listening_baseline_at from app.album_list_items where top_ref=%s',
                (receipt['top_ref'],)).fetchone()
        db.top_receipt=receipt;db.top_item=item;db.top_owner=owner
        db.top_service=PostgresTopCurrentListening(db.config,connect=db.app_connect,clock=lambda:db.clock_time)
        yield db
    finally:
        with db.connect() as con:
            if receipt:
                con.execute('delete from app.album_list_operations where top_ref=%s',(receipt['top_ref'],))
                con.execute('delete from app.album_lists where ref=%s',(receipt['top_ref'],))
            # This catalog identity was admitted solely from this fixture's unique
            # owned local album. Never delete unrelated shared catalog fixtures.
            con.execute('delete from library.catalog_album_links where library_id=%s and catalog_ref=%s',(db.library,ref))
            # The retained native fixture owns account/library cleanup; shared
            # catalog retention is intentional, matching native admission policy.


def project(db,**patch):
    return db.top_service.project(db.context(),top_ref=db.top_receipt['top_ref'],
        top_revision=db.top_receipt['revision'],item_refs=[str(db.top_item['ref'])],enabled=lambda:True,**patch)


def raw_counts(db):
    with db.connect() as con:
        return tuple(con.execute('select count(*) as n from integration.'+table+' where account_id=%s',
            (db.owner.account_id,)).fetchone()['n'] for table in (
                'playback_capture_history_revision','playback_capture_budget','playback_capture_session'))


def test_real_browse_only_no_capture_account_keeps_rating_without_media_or_h3(top_db):
    db=top_db;db.patch(db.albums[0],{'rating':8})
    before=raw_counts(db);result=project(db);row=result['items'][0]
    assert before==(0,0,0) and raw_counts(db)==before
    assert row['predicates']['rated'] is True
    assert row['membership_revision'] is None
    assert row['full_progress']['status']=='not_started'
    assert row['predicates']['listened'] is None and not row['automatic_completed']


def test_new_participation_baseline_is_created_by_actual_top_mutation_not_metrics_read(top_db):
    db=top_db
    with db.connect() as con:
        activity=con.execute('select started_at from app.album_list_activity where account_id=%s and top_ref=%s',
            (db.owner.account_id,db.top_receipt['top_ref'])).fetchone()
    assert activity is not None and db.top_item['listening_baseline_at'] is not None
    assert project(db)['items'][0]['baseline_status']=='ready'
    assert raw_counts(db)==(0,0,0)


def test_legacy_self_start_is_acknowledged_once_and_never_initializes_capture(top_db):
    db=top_db
    with db.connect() as con:
        con.execute('update app.album_list_items set listening_baseline_at=null where ref=%s',(db.top_item['ref'],))
    assert project(db)['items'][0]['baseline_status']=='needs_explicit_start'
    first=project(db,advance=0)['items'][0]
    assert first['baseline_status']=='ready' and first['baseline_changed'] is True
    again=project(db,advance=0)['items'][0]
    assert again['baseline_changed'] is False and raw_counts(db)==(0,0,0)
    with db.connect() as con:
        progress=con.execute('select revision,manual_completed_at from app.album_list_item_progress where top_ref=%s and account_id=%s',
            (db.top_receipt['top_ref'],db.owner.account_id)).fetchone()
    assert progress==dict(revision=1,manual_completed_at=None)
    # Genuine detail read acknowledges that CAS revision; no client-side rewrite.
    detail=db.top_owner.read(db.context(),top_ref=db.top_receipt['top_ref'])
    overlay=detail['top_viewer_overlay']['item_progress'][str(db.top_item['catalog_ref'])]
    assert overlay==dict(progress_revision='1',manual_completed_at=None)
    command=normalize_top_command('set_manual_completion',dict(request_key=str(uuid4()),
        album_ref=str(db.top_item['catalog_ref']),progress_revision=overlay['progress_revision'],completed=True),
        top_ref=db.top_receipt['top_ref'])
    receipt=db.top_owner.execute(db.context(),command)
    assert receipt['progress_revision']=='2' and receipt['manual_completed_at'] is not None


def test_manual_completion_survives_missing_native_mapping(top_db):
    db=top_db
    with db.connect() as con:
        con.execute('''insert into app.album_list_item_progress
            (account_id,library_id,top_ref,catalog_ref,revision,manual_completed_at)
            values(%s,%s,%s,%s,1,clock_timestamp())''',
            (db.owner.account_id,db.library,db.top_receipt['top_ref'],db.top_item['catalog_ref']))
        con.execute('delete from library.catalog_album_links where library_id=%s and catalog_ref=%s',
            (db.library,db.top_item['catalog_ref']))
    row=project(db)['items'][0]
    assert row['status']=='unavailable' and row['manual_completed'] is True
    assert 'full_progress' not in row


def test_other_account_cannot_read_private_top_or_start_its_baseline(top_db):
    db=top_db
    with pytest.raises(AlbumTopError):
        db.top_service.project(db.context(db.peer),top_ref=db.top_receipt['top_ref'],
            top_revision=db.top_receipt['revision'],item_refs=[str(db.top_item['ref'])],advance=0,enabled=lambda:True)
    assert raw_counts(db)==(0,0,0)


def test_final_feature_withdrawal_rolls_back_legacy_start(top_db):
    db=top_db
    with db.connect() as con:
        con.execute('update app.album_list_items set listening_baseline_at=null where ref=%s',(db.top_item['ref'],))
    calls=[]
    def enabled():
        calls.append(True);return len(calls)<3
    with pytest.raises(CaptureError):
        db.top_service.project(db.context(),top_ref=db.top_receipt['top_ref'],top_revision=db.top_receipt['revision'],
            item_refs=[str(db.top_item['ref'])],advance=0,enabled=enabled)
    with db.connect() as con:
        assert con.execute('select 1 from app.album_list_item_progress where account_id=%s and top_ref=%s',
            (db.owner.account_id,db.top_receipt['top_ref'])).fetchone() is None
    assert raw_counts(db)==(0,0,0)


def test_real_permitted_track_scope_keeps_allowed_track_when_a_sibling_is_denied(top_db):
    from dataclasses import replace
    from music_app.services.current_actor import CapabilityGrant
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    from music_app.services.private_library_authority import current_library_transaction
    from music_app.services.album_top_fresh_scope import current_top_listening_scope,FreshTrackScope
    from music_app.services.local_album_full_state import _new_pass,_advance_fresh,_projection
    db=top_db;album=db.albums[0]
    capability=sibling=None
    try:
        with db.connect() as con:
            capability=con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'capability.play','library',%s) returning id",
                (db.owner.account_id,db.library)).fetchone()['id']
            sibling=con.execute("""insert into library.local_tracks(library_id,artist_id,album_id,track_key,title)
                values(%s,%s,%s,%s,'Denied synthetic sibling') returning id""",
                (db.library,album['artist'],album['id'],album['key']+':denied')).fetchone()['id']
        actor=replace(db.owner,capability_grants=db.owner.capability_grants+(CapabilityGrant('capability.play','library',db.library),))
        def constraints(context):
            denied=context.resource is not None and context.resource.resource_kind=='track' and context.resource.resource_ref==str(sibling)
            return PolicyEvaluationConstraints(request_origin_allowed=not denied)
        with current_library_transaction(db.app_url,db.context(actor),connect=db.app_connect,
                clock=lambda:db.clock_time,constraints=constraints) as (con,live,now):
            scope,rows=current_top_listening_scope(con,live,album['key'],constraints)
            assert isinstance(scope,FreshTrackScope) and scope.track_ids==(album['track'],)
            full_scope,_=current_top_listening_scope(con,live,album['key'],None)
            assert full_scope.membership_revision!=scope.membership_revision
            history=dict(invalidation_revision=1,proof_revision=1,append_revision=1,raw_checkpoint_cut=1)
            state=_new_pass(scope,{(album['track'],album['file'],1):'a'*64},history,{})
            # Declared reader-input seam: synthetic admitted rows test the actual fold,
            # not a claim that this fixture produced a server decoder observation.
            _advance_fresh(state,[dict(parent_id=1,observed_ref='synthetic-observation',observed_opened_at=now,
                observed_file=album['file'],observed_root=1,track_id=album['track'],source_version='a'*64,
                has_loss=False,frames=480001)])
            projected=_projection({'state_revision':1},state,history)
            assert projected['fresh_play']['status']=='supported' and projected['full'] is None
            assert state['geometry'] is None
    finally:
        # Exact additional owned rows, removed before the retained fixture's
        # strict ownership-ledger cleanup. Do not broaden that ledger.
        with db.connect() as con:
            if sibling is not None:
                removed=con.execute("""delete from library.local_tracks where id=%s and library_id=%s
                    and album_id=%s and track_key=%s returning id""",
                    (sibling,db.library,album['id'],album['key']+':denied')).fetchall()
                assert removed==[{'id':sibling}]
            if capability is not None:
                removed=con.execute("""delete from app.capabilities where id=%s and account_id=%s
                    and capability_key='capability.play' and scope_kind='library' and scope_id=%s returning id""",
                    (capability,db.owner.account_id,db.library)).fetchall()
                assert removed==[{'id':capability}]
