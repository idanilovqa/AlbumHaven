"""Real SQL capture contracts using uniquely owned rows in admitted synthetic DBs."""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
from uuid import uuid4

import pytest

from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.current_library_selector import canonical_library_selector_sql
from music_app.services.playback_capture import CaptureError, capture_scope
from music_app.services.playback_capture_postgres import record_capture_checkpoint
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from tests.py.test_owned_album_tops_postgres import urls
from tests.py.test_playback_capture import envelope


class CaptureDatabase:
    def __init__(self, urls):
        self.app_url,self.setup_url=urls
        self.now=datetime.now(timezone.utc)
        self.account=None; self.root=None; self.album=None; self.track=None
        self.token=uuid4().hex
        self.sql=[]

    def connect(self):
        import psycopg
        from psycopg.rows import dict_row
        return psycopg.connect(self.setup_url,row_factory=dict_row)

    def connector(self, *, after=None, fail_commit=False):
        observed=self.sql
        @contextmanager
        def connect(url):
            import psycopg
            from psycopg.rows import dict_row
            with psycopg.connect(url,row_factory=dict_row) as connection:
                class Observed:
                    def execute(self,sql,params=None):
                        observed.append(' '.join(sql.lower().split()))
                        result=connection.execute(sql,params)
                        if after: after(sql,params)
                        return result
                yield Observed()
            if fail_commit:
                raise OSError('synthetic acknowledgement loss after actual commit')
        return connect

    def setup(self):
        with self.connect() as c:
            selected=c.execute(canonical_library_selector_sql()).fetchone()
            assert selected is not None, 'Admitted synthetic database must have normal canonical-library setup'
            self.library=selected['id']
            name='capture-'+self.token
            self.account=c.execute('''insert into app.accounts(display_name,account_kind,username_display,
                username_normalized,contact_email,contact_email_normalized)
                values(%s,'managed_user',%s,%s,%s,%s) returning id''',
                (name,name,name,name+'@example.test',name+'@example.test')).fetchone()['id']
            self.session=c.execute('''insert into app.account_sessions(account_id,session_token_hash,
                created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
                values(%s,%s,%s,%s,%s,%s,%s) returning id''',
                (self.account,hashlib.sha256(uuid4().bytes).digest(),self.now,self.now,self.now,
                 self.now+timedelta(days=3),self.now+timedelta(days=3))).fetchone()['id']
            c.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')",
                      (self.account,self.library))
            for action in ('library.browse.read','library.media.read'):
                c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                          (self.account,action,self.library))
            self.root=c.execute('''insert into library.library_roots(library_id,root_path,is_active)
                values(%s,%s,true) returning id''',(self.library,'/synthetic/capture-'+self.token)).fetchone()['id']
            self.album=c.execute('''insert into library.local_albums(library_id,album_key,title)
                values(%s,%s,'Synthetic capture album') returning id''',(self.library,self.token)).fetchone()['id']
            self.track=c.execute('''insert into library.local_tracks(library_id,album_id,track_key,title,disc_number,track_number)
                values(%s,%s,%s,'Synthetic capture track',2,3) returning id''',
                (self.library,self.album,self.token)).fetchone()['id']
            self.path='/synthetic/capture-'+self.token+'/track.flac'
            self.file=c.execute('''insert into library.local_track_files(track_id,library_root_id,private_path)
                values(%s,%s,%s) returning id''',(self.track,self.root,self.path)).fetchone()['id']
        self.actor=CurrentActor(state=ActorState.ACTIVE,account_id=self.account,session_id=self.session,
            authenticated_at=self.now,current_library_id=self.library,
            library_relationships=(LibraryRelationship(self.library,'member',False),),
            capability_grants=tuple(CapabilityGrant(a,'library',self.library) for a in ('library.browse.read','library.media.read')))
        self.context=PolicyContext.build(actor=self.actor,action='library.media.read',library_id=self.library,
            deployment_mode='self_hosted',request_origin=RequestOrigin('network','synthetic:capture'),client_surface_class='private_web')
        self.guard=capture_scope(self.context,{'hmac':{'secret':'synthetic-capture-policy-key-32-bytes','key_version':1}})
        self.payload=envelope(); self.payload['initial_path']=self.path
        self.payload['device_uuid']=str(uuid4()); self.payload['capture_uuid']=str(uuid4())

    def record(self, payload=None, **kwargs):
        return record_capture_checkpoint(self.app_url,self.context,payload or self.payload,expected_scope=self.guard,
            clock=lambda:self.now,connect=kwargs.pop('connect',self.connector()),**kwargs)

    def next(self,sequence=2):
        payload=deepcopy(self.payload);payload['sequence']=sequence
        payload.pop('initial_path',None)
        payload['evidence']['runs'][0].update(ordinal_start=128*(sequence-1),output_start=256+128*(sequence-1))
        return payload

    def rows(self):
        with self.connect() as c:
            return c.execute('select * from integration.playback_capture_session where account_id=%s',(self.account,)).fetchall()

    def cleanup(self):
        with self.connect() as c:
            # Delete by scenario-owned source snapshot even after anonymization.
            if self.track is not None:
                c.execute('delete from integration.playback_capture_session where original_track_id=%s',(self.track,))
                c.execute('delete from library.local_tracks where id=%s',(self.track,))
            if self.album is not None:c.execute('delete from library.local_albums where id=%s',(self.album,))
            if self.root is not None:c.execute('delete from library.library_roots where id=%s',(self.root,))
            if self.account is not None:c.execute('delete from app.accounts where id=%s',(self.account,))


@pytest.fixture
def capture_db(urls):
    db=CaptureDatabase(urls)
    try:
        db.setup()
        yield db
    finally:
        db.cleanup()


def test_exact_replay_and_lost_commit_ack_do_not_duplicate_frames(capture_db):
    db=capture_db
    with pytest.raises(OSError): db.record(connect=db.connector(fail_commit=True))
    first=db.record()
    altered=deepcopy(db.payload);altered['initial_path']='/missing/locator'
    assert db.record(altered) == first
    assert first['accepted_known_frames'] == 128
    assert len(db.rows()) == 1
    with db.connect() as c:
        assert c.execute('select count(*) as n from integration.playback_capture_checkpoint where session_id=%s',
                         (db.rows()[0]['id'],)).fetchone()['n']==1


def test_frozen_terminal_replay_and_new_sequence_rejection(capture_db):
    db=capture_db; first=db.record()
    final=db.next();final['evidence'].update(runs=[],terminal=True,terminal_reason='ended')
    receipt=db.record(final)
    assert receipt['accepted_known_frames']==128 and receipt['terminal']
    assert db.record(final)==receipt and db.record()==first
    with pytest.raises(CaptureError,match='capture_terminal'):db.record(db.next(3))


def test_conflict_and_out_of_order_sequence_roll_back(capture_db):
    db=capture_db;db.record()
    conflict=deepcopy(db.payload);conflict['evidence']['runs'][0]['frames']=64
    with pytest.raises(CaptureError,match='capture_conflict'):db.record(conflict)
    with pytest.raises(CaptureError,match='capture_sequence'):db.record(db.next(3))
    assert db.rows()[0]['accepted_known_frames']==128


def test_retag_and_source_deletion_preserve_admission_album_and_allow_history_delta(capture_db):
    db=capture_db;db.record()
    with db.connect() as c:
        c.execute('update library.local_tracks set album_id=null where id=%s',(db.track,))
        c.execute('delete from library.local_tracks where id=%s',(db.track,))
    second=db.record(db.next())
    row=db.rows()[0]
    assert second['accepted_known_frames']==256
    assert row['original_album_id']==db.album and row['original_track_id']==db.track
    assert row['live_track_id'] is None


@pytest.mark.parametrize('mutation',["update library.library_roots set is_active=false where id=%s",
                                     "update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache}',jsonb_build_object('stale',true)) where id=%s",
                                     "delete from library.local_track_files where id=%s"])
def test_first_admission_requires_current_source(capture_db,mutation):
    db=capture_db
    with db.connect() as c:c.execute(mutation,(db.root if 'library_roots' in mutation else db.file,))
    with pytest.raises(CaptureError,match='source_unavailable'):db.record()
    assert not db.rows()


def test_current_dynamic_track_denial_rejects_replay(capture_db):
    db=capture_db;db.record()
    calls=[]
    def resolver(context):
        calls.append(context.resource)
        return PolicyEvaluationConstraints(request_origin_allowed=context.resource is None)
    with pytest.raises(PrivateLibraryAuthorityError):db.record(constraints=resolver)
    assert any(r and r.resource_ref==str(db.track) for r in calls)


def test_rate_bucket_and_twenty_four_hour_terminal_exception(capture_db):
    db=capture_db; first=db.record()
    for _ in range(7):assert db.record()==first
    with pytest.raises(CaptureError,match='capture_rate_limited'):db.record()
    db.now+=timedelta(hours=25)
    assert db.record()==first
    with pytest.raises(CaptureError,match='capture_limit'):db.record(db.next())
    final=db.next();final['evidence'].update(runs=[],terminal=True,terminal_reason='capture_limit')
    assert db.record(final)['terminal'] is True


def test_known_run_overlap_rejected_without_using_gap_envelope_as_cursor(capture_db):
    db=capture_db; db.record()
    overlap=db.next();overlap['evidence']['runs'][0]['ordinal_start']=64
    with pytest.raises(CaptureError,match='capture_conflict'):db.record(overlap)
    next_payload=db.next();next_payload['evidence']['gaps']=[dict(ordinal_start=0,ordinal_end=1024,
        positive_frames=32,output_start=0,output_end=2048,epoch=None,reasons=['buffer_credit'])]
    assert db.record(next_payload)['accepted_lost_frames']==32
    assert db.record(db.next(3))['accepted_known_frames']==384


def test_final_dynamic_recheck_rolls_back_every_charge(capture_db):
    db=capture_db
    track_checks=0
    def resolver(context):
        nonlocal track_checks
        if context.resource is not None:track_checks+=1
        return PolicyEvaluationConstraints(request_origin_allowed=track_checks<2)
    with pytest.raises(PrivateLibraryAuthorityError):db.record(constraints=resolver)
    assert not db.rows()
    with db.connect() as c:
        assert c.execute('select id from integration.playback_capture_budget where account_id=%s',(db.account,)).fetchone() is None


def test_anchor_reference_is_parent_local_and_values_are_immutable(capture_db):
    db=capture_db
    anchor=dict(epoch=1,probe_id=1,output_frame=256,utc_lower_ms=None,utc_upper_ms=None,
                monotonic_probe_span_ms=400,max_quantum_frames=128,quality='unknown')
    db.payload['evidence']['anchors']=[anchor]
    db.payload['evidence']['runs'][0]['anchor_before']=[1,1]
    db.record()
    second=db.next();second['evidence']['anchors']=[]
    assert db.record(second)['accepted_known_frames']==256
    third=db.next(3);third['evidence']['anchors'][0]['output_frame']=300
    with pytest.raises(CaptureError,match='capture_conflict'):db.record(third)
    third['evidence']['anchors']=[];third['evidence']['runs'][0]['anchor_before']=[1,2]
    with pytest.raises(CaptureError,match='invalid_capture'):db.record(third)


def test_publication_fence_precedes_authority_and_single_transaction(capture_db):
    db=capture_db;db.record()
    statements=db.sql
    fence=next(i for i,s in enumerate(statements) if 'local-inventory-publication' in s)
    first_account=next(i for i,s in enumerate(statements) if 'app.accounts' in s)
    assert statements[:3]==['set transaction isolation level read committed',"set local lock_timeout = '250ms'", "set local statement_timeout = '1000ms'"]
    assert fence<first_account
    assert sum(s=='set transaction isolation level read committed' for s in statements)==1


def test_scope_guard_change_cannot_rebind_an_existing_parent(capture_db):
    db=capture_db;db.record();db.guard='v1:'+'0'*64
    with pytest.raises(CaptureError,match='capture_scope_changed'):db.record(db.next())
    assert db.rows()[0]['accepted_known_frames']==128


def test_session_expiry_at_final_recheck_rolls_back(capture_db):
    db=capture_db
    def after(sql,params):
        if sql.lower().startswith('insert into integration.playback_capture_checkpoint'):
            db.now+=timedelta(days=4)
    with pytest.raises(PrivateLibraryAuthorityError):db.record(connect=db.connector(after=after))
    assert not db.rows()


def test_first_v1_linkage_is_never_late_attached_or_changed(capture_db):
    db=capture_db;db.record()
    second=db.next();second['v1_session_uuid']=str(uuid4())
    db.record(second)
    assert db.rows()[0]['v1_session_uuid'] is None


def test_anchor_only_new_bracket_is_accepted_but_identical_only_batch_is_empty(capture_db):
    db=capture_db;db.record()
    second=db.next();second['evidence']['runs']=[]
    second['evidence']['anchors']=[dict(epoch=1,probe_id=1,output_frame=1024,utc_lower_ms=1000,
        utc_upper_ms=1005,monotonic_probe_span_ms=2,max_quantum_frames=128,quality='bounded')]
    assert db.record(second)['accepted_known_frames']==128
    duplicate_only=deepcopy(second);duplicate_only['sequence']=3
    with pytest.raises(CaptureError,match='invalid_capture'):db.record(duplicate_only)


def test_anchor_cap_rejects_atomically_without_rewriting_evidence(capture_db):
    db=capture_db;db.record()
    with db.connect() as c:c.execute('update integration.playback_capture_session set anchor_count=17282 where account_id=%s',(db.account,))
    second=db.next();second['evidence']['anchors']=[dict(epoch=1,probe_id=99,output_frame=1024,
        utc_lower_ms=None,utc_upper_ms=None,monotonic_probe_span_ms=300,max_quantum_frames=128,quality='unknown')]
    with pytest.raises(CaptureError,match='capture_limit'):db.record(second)
    assert db.rows()[0]['accepted_known_frames']==128
    second['evidence']['anchors']=[]
    assert db.record(second)['accepted_known_frames']==256


def test_inactive_parent_cap_is_time_scoped_and_does_not_evict_history(capture_db):
    db=capture_db
    for _ in range(32):
        db.payload['capture_uuid']=str(uuid4())
        db.record();db.now+=timedelta(seconds=1)
    db.payload['capture_uuid']=str(uuid4())
    with pytest.raises(CaptureError,match='capture_limit'):db.record()
    db.now+=timedelta(seconds=121)
    db.record()
    assert len(db.rows())==33


def test_concurrent_exact_submission_commits_only_once(capture_db):
    from concurrent.futures import ThreadPoolExecutor
    db=capture_db
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(db.record) for _ in range(2)]
        receipts=[future.result(timeout=5) for future in futures]
    assert receipts[0]==receipts[1]
    assert db.rows()[0]['accepted_known_frames']==128


def test_root_lock_timeout_preserves_atomic_rollback(capture_db):
    import psycopg
    db=capture_db
    with db.connect() as c:
        c.execute('update library.library_roots set is_active=false where id=%s',(db.root,))
        with pytest.raises(psycopg.errors.LockNotAvailable):db.record()
        c.rollback()
    assert not db.rows()
    assert db.record()['accepted_known_frames']==128


def test_bounded_same_epoch_bracket_accepts_only_compatible_intervals(capture_db):
    db=capture_db
    def anchor(probe,output,lo,hi):
        return dict(epoch=1,probe_id=probe,output_frame=output,utc_lower_ms=lo,utc_upper_ms=hi,
                    monotonic_probe_span_ms=2,max_quantum_frames=128,quality='bounded')
    db.payload['evidence']['anchors']=[anchor(1,256,-1000,-995),anchor(2,512,-995,-990)]
    db.payload['evidence']['runs'][0].update(anchor_before=[1,1],anchor_after=[1,2],quality='bounded')
    assert db.record()['accepted_known_frames']==128
    second=db.next();second['evidence']['anchors']=[anchor(3,1000,5000,5005)]
    second['evidence']['runs'][0].update(anchor_before=[1,1],anchor_after=[1,3])
    with pytest.raises(CaptureError,match='invalid_capture'):db.record(second)
    assert db.rows()[0]['accepted_known_frames']==128


def test_other_parent_anchor_cannot_satisfy_reference(capture_db):
    db=capture_db
    db.payload['evidence']['anchors']=[dict(epoch=1,probe_id=1,output_frame=256,utc_lower_ms=None,
        utc_upper_ms=None,monotonic_probe_span_ms=500,max_quantum_frames=128,quality='unknown')]
    db.record()
    other=deepcopy(db.payload);other['capture_uuid']=str(uuid4())
    other['evidence']['anchors']=[];other['evidence']['runs'][0]['anchor_before']=[1,1]
    with pytest.raises(CaptureError,match='invalid_capture'):db.record(other)
    assert len(db.rows())==1


def test_source_retag_before_admission_snapshots_current_transaction(capture_db):
    db=capture_db
    with db.connect() as c:c.execute('update library.local_tracks set album_id=null,disc_number=4,track_number=5 where id=%s',(db.track,))
    db.record()
    row=db.rows()[0]
    assert row['original_album_id'] is None and row['disc_number']==4 and row['track_number']==5


def test_bracket_beyond_ten_seconds_cannot_claim_bounded_quality(capture_db):
    db=capture_db
    db.payload['evidence']['anchors']=[
        dict(epoch=1,probe_id=1,output_frame=256,utc_lower_ms=1000,utc_upper_ms=1005,
             monotonic_probe_span_ms=2,max_quantum_frames=128,quality='bounded'),
        dict(epoch=1,probe_id=2,output_frame=480257,utc_lower_ms=11000,utc_upper_ms=11005,
             monotonic_probe_span_ms=2,max_quantum_frames=128,quality='bounded')]
    db.payload['evidence']['runs'][0].update(anchor_before=[1,1],anchor_after=[1,2],quality='bounded')
    with pytest.raises(CaptureError,match='invalid_capture'):db.record()
    assert not db.rows()
