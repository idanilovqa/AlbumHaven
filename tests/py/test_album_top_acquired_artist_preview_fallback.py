"""Real partial Artist lock rollback and mandatory fallback policy callbacks."""
from datetime import timedelta
import pytest
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.owned_album_tops import CREATE
from tests.py.test_album_top_acquired_artist_preview_postgres import preview_case,preparations,db,urls,setup,acquire,ARTIST
from tests.py.test_album_top_acquired_artist_preview_fences import intercept
from tests.py.test_owned_album_tops_postgres import assert_error


@pytest.mark.parametrize('replay',[False,True])
def test_optional_lock_failure_releases_partial_artist_locks_before_mandatory_callback(preview_case,replay):
    case=preview_case;command,scope=setup(case,(ARTIST,),'family')
    if replay:acquire(case,command,scope)
    root,family=case.db.scope_artists[:2];assert root<family
    attempted=[];probes=[]
    def before(sql,connection):
        if 'library.local_artists' in sql and 'for share nowait' in sql:attempted.append(True)
    def cancelled():
        if attempted:
            # Final ordered lock acquired root before failing on family. Its
            # savepoint must be rolled back before fallback callbacks run.
            with case.db.connect() as probe:
                assert probe.execute('select id from library.local_artists where id=%s for update nowait',(root,)).fetchone()
            probes.append(True)
        return False
    with case.db.connect() as blocker:
        blocker.execute('select id from library.local_artists where id=%s for update',(family,)).fetchone()
        with intercept(case,before=before):result=acquire(case,command,scope,should_cancel=cancelled)
    assert attempted and probes and result['artist_scope_preview'] is None
    assert result['state']=='pending' and len(case.rows())==1 and len(case.calls)==1


@pytest.mark.parametrize('replay',[False,True])
@pytest.mark.parametrize('failure',['cancel','permission','session'])
def test_handled_optional_failure_still_runs_fatal_current_checks(preview_case,replay,failure):
    case=preview_case;command,scope=setup(case)
    if replay:acquire(case,command,scope)
    attempted=[];checks=[];old_clock=case.db.service._clock
    case.db.service._clock=lambda:old_clock()+(timedelta(days=2) if attempted and failure=='session' else timedelta())
    def before(sql,connection):
        if 'library.local_artists' in sql and 'for share nowait' in sql:attempted.append(True)
    def cancelled():
        if attempted:checks.append('cancel')
        return bool(attempted) and failure=='cancel'
    def constraints(context):
        deny=bool(attempted) and failure=='permission' and context.action==CREATE
        if deny:checks.append('permission')
        return PolicyEvaluationConstraints(request_origin_allowed=not deny)
    try:
        with case.db.connect() as blocker:
            blocker.execute('select id from library.local_artists where id=%s for update',(case.db.scope_artists[0],)).fetchone()
            with intercept(case,before=before):
                assert_error(lambda:acquire(case,command,scope,should_cancel=cancelled,constraints=constraints),
                    'provider_cancelled' if failure=='cancel' else 'forbidden',503 if failure=='cancel' else 403)
    finally:case.db.service._clock=old_clock
    assert attempted and checks and len(case.rows())==(1 if replay else 0) and len(case.calls)==1
