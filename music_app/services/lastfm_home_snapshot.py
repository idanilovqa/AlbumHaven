"""Append account-owned remote observations to the genuine own-listens receipt.

No source row is removed; only the derived receipt avoids double-counting exact
accepted-echo matches. No friend/comparison, native association or sends here.
"""
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math

from .home_activity import HomeActivityError, _display
from .lastfm import LastfmSession
from .lastfm_history_model import binding, accepted_tuple

ROW_CHUNK = 256


def enabled_for(config, scope, query):
    return (config.get('LASTFM_HISTORY_IMPORT_ENABLED') is True
        and scope.audience == 'own' and scope.subject_account_id is None
        and scope.source_account_id == scope.account_id and query.kind == 'listens')


def account_read_allowed(context, constraints, *, account_id, session_id):
    """Actual fixed account policy; explicit denial suppresses optional remote data."""
    from .lastfm_history_authority import require_account_lastfm_history_read
    from .lastfm_history_model import HistoryStale, HistoryUnavailable
    try:
        target=require_account_lastfm_history_read(context,constraints)
    except HistoryStale:
        return False
    except HistoryUnavailable:
        raise HomeActivityError('Activity unavailable.',503,'activity_unavailable') from None
    return (target.actor.account_id==account_id and target.actor.session_id==session_id)


def connection_stamp(connection, scope):
    """Caller already holds genuine current account/session authority locks."""
    settings = connection.execute('select provider_username from integration.lastfm_settings '
        'where account_id=%s for share nowait',(scope.account_id,)).fetchone()
    if settings is None or not settings['provider_username']:
        return {'version':1,'connected':False}
    rows = connection.execute("select provider_username,metadata->>'connected_at' as connected_at "
        "from integration.lastfm_sessions where account_id=%s and provider_username=%s and is_active "
        "and session_key_encrypted is not null for share nowait",
        (scope.account_id,settings['provider_username'])).fetchmany(2)
    if not rows:
        return {'version':1,'connected':False}
    if len(rows)!=1:
        raise HomeActivityError('Last.fm history connection changed.',503,'activity_unavailable')
    try:
        username,lineage = binding(LastfmSession(rows[0]['provider_username'],'',rows[0]['connected_at']))
    except (ValueError,TypeError):
        # Invalid historical connection lineage cannot be relabelled or matched.
        return {'version':1,'connected':False,'binding_unavailable':True}
    return {'version':1,'connected':True,'provider_username':username,'connection_started_at':lineage}


def _counts_equal(connection, generation, timestamp, *, account=None, stamp=None, other_generation=None):
    observed="""select artist,track,album,occurrences as n
        from integration.lastfm_history_generation_tuples_v1
        where generation_id=%s and played_at=%s"""
    if other_generation is not None:
        other=observed
        params=(generation,timestamp,other_generation,timestamp)
    else:
        other="""select artist,track,album,count(*) as n from integration.lastfm_history_occurrences_v1
            where account_id=%s and provider_username=%s and connection_started_at=%s and played_at=%s
            group by artist,track,album"""
        params=(generation,timestamp,account,stamp['provider_username'],stamp['connection_started_at'],timestamp)
    # Database aggregation may spill; no Python whole-bucket/list-size ceiling.
    row=connection.execute('with observed as ('+observed+'), other as ('+other+
        ') select not exists(select 1 from observed full outer join other using(artist,track,album) '
        'where observed.n is distinct from other.n) as same',params).fetchone()
    return row['same'] is True


def _bucket_uncertain(connection, scope, stamp, timestamp):
    params=(scope.account_id,stamp['provider_username'],stamp['connection_started_at'],scope.account_id,timestamp)
    latest=connection.execute("""select id,state,summary_complete from integration.lastfm_history_generations_v1
        where account_id=%s and provider_username=%s and connection_started_at=%s
        and account_scope @> %s::numeric and coverage_seconds @> %s::bigint
        order by coalesce(completed_at,created_at) desc,id desc limit 1""",params).fetchone()
    if latest is None or latest['state']!='complete' or latest.get('summary_complete') is not True:return True
    completed=connection.execute("""select id,summary_complete from integration.lastfm_history_generations_v1
        where account_id=%s and provider_username=%s and connection_started_at=%s
        and account_scope @> %s::numeric and coverage_seconds @> %s::bigint and state='complete'
        order by completed_at desc,id desc limit 2""",params).fetchall()
    if not completed or any(row.get('summary_complete') is not True for row in completed):return True
    if not _counts_equal(connection,completed[0]['id'],timestamp,account=scope.account_id,stamp=stamp):return True
    return len(completed)>1 and not _counts_equal(connection,completed[0]['id'],timestamp,
        other_generation=completed[1]['id'])


def _native_candidates(connection, snapshot_id, scope, stamp, timestamp):
    # One server cursor derives duplicate physical evidence once per bucket.
    # C collation matches Python's exact Unicode scalar ordering for parsed UTF8.
    from uuid import uuid4
    with connection.cursor(name='lastfm_home_native_'+uuid4().hex) as cursor:
        cursor.execute("""with candidates as (
            select h.id,h.account_id,h.library_id,h.source_family,h.measurement_version,
                h.played_at,h.metadata->'source_payload' as payload,h.device_id::text as device_id,
                h.session_id::text as session_id,h.source_entry_id,e.row_key,
                count(*) over(partition by h.source_entry_id) as physical_copies
            from app.activity_snapshot_events e join integration.listen_history h on h.id=e.event_id
            where e.snapshot_id=%s and h.account_id=%s and h.library_id=%s
                and h.source_family='rendered_local_listen_session' and h.measurement_version='rendered-pcm-v1'
                and h.played_at>=to_timestamp(%s) and h.played_at<to_timestamp(%s))
            select * from candidates where physical_copies=1
            order by (payload#>>'{scrobble_submission_identity,reply,artist}') collate "C",
                (payload#>>'{scrobble_submission_identity,reply,track}') collate "C",
                (payload#>>'{scrobble_submission_identity,reply,album}') collate "C",id""",
            (snapshot_id,scope.account_id,scope.library_id,timestamp,timestamp+1))
        while True:
            rows=cursor.fetchmany(ROW_CHUNK)
            if not rows:return
            for row in rows:
                key=accepted_tuple(row,account_id=scope.account_id,library_id=scope.library_id,
                    provider_username=stamp['provider_username'],connection_started_at=stamp['connection_started_at'])
                if key is not None:yield key,row


def _remote_rows(connection, scope, stamp, timestamp):
    from uuid import uuid4
    with connection.cursor(name='lastfm_home_remote_'+uuid4().hex) as cursor:
        cursor.execute("""select * from integration.lastfm_history_occurrences_v1
            where account_id=%s and provider_username=%s and connection_started_at=%s and played_at=%s
            order by artist collate "C",track collate "C",album collate "C",ordinal""",
            (scope.account_id,stamp['provider_username'],stamp['connection_started_at'],timestamp))
        while True:
            rows=cursor.fetchmany(ROW_CHUNK)
            if not rows:return
            yield from rows


def _remote_row(row, secret, *, uncertain):
    identity=json.dumps([row['account_id'],row['provider_username'],row['connection_started_at'],
        row['played_at'],row['tuple_digest'],row['ordinal']],ensure_ascii=False,separators=(',',':'))
    key='listen:lastfm:'+hashlib.sha256(identity.encode()).hexdigest()
    return key, {'id':'activity_'+hmac.new(secret,key.encode(),hashlib.sha256).hexdigest(),
        'kind':'listen','title':_display(row['track']),'artist':_display(row['artist']),
        'album_title':_display(row['album']),'listen_count':1,
        'last_listened_at':datetime.fromtimestamp(row['played_at'],timezone.utc).isoformat(),
        'duration_seconds':None,'source_label':'Last.fm history','source_readable':True,
        'availability':'unresolved','artwork_url':None,'rating':None,'detail_ref':None,
        'allowed_actions':{'can_view_details':False},
        'lastfm_observation':{'source':'remote_only','correlation':'unmatched','uncertain':uncertain}}


def append_observations(connection, *, snapshot_id, scope, window, secret, stamp):
    coverage={'enabled':True,'connected':stamp['connected'],'imported_rows':0,'matched_rows':0,
        'uncertain_rows':0,'account_wide_remote':True,'provider_snapshot_guaranteed':False,
        'complete_history':False,'observation_state':'not_imported',
        'requested_start':window.start.isoformat() if window.start else None,
        'requested_end':window.end.isoformat(),'completed_ranges':0,'unfinished_ranges':0,
        'label':'Selected-library in-app history plus this account\'s observed Last.fm history. '
            'Remote metadata does not grant local playback; provider history may change.'}
    if not stamp['connected']:
        coverage['observation_state']='binding_unavailable' if stamp.get('binding_unavailable') else 'disconnected'
        return 0,coverage
    from .lastfm_uncertain_assessment import append_uncertain_assessments
    append_uncertain_assessments(connection,snapshot_id=snapshot_id,scope=scope,stamp=stamp,
        bucket_uncertain=_bucket_uncertain)
    start=window.start or datetime.fromtimestamp(0,timezone.utc)
    # Provider seconds are distinct from native precision. Filter with actual
    # exclusive time bounds using ceil seconds, not floor-rounded windows that would add out-of-range data.
    params=(scope.account_id,stamp['provider_username'],stamp['connection_started_at'],
        math.ceil(start.timestamp()),math.ceil(window.end.timestamp()))
    generations=connection.execute('''select count(*) filter(where state='complete') as completed,
        count(*) filter(where state<>'complete') as unfinished
        from integration.lastfm_history_generations_v1 where account_id=%s and provider_username=%s
        and connection_started_at=%s and range_end>=%s and range_start<%s''',params).fetchone()
    coverage['completed_ranges']=int(generations['completed'])
    coverage['unfinished_ranges']=int(generations['unfinished'])
    coverage['observation_state']=('partial' if coverage['unfinished_ranges'] else
        'observed_ranges' if coverage['completed_ranges'] else 'not_imported')
    # Counts do not establish contiguous range coverage or immutable provider state.
    # In particular an empty successful range differs from never having imported.
    after=-1
    added=0
    while True:
        buckets=connection.execute("""select distinct played_at from integration.lastfm_history_occurrences_v1
            where account_id=%s and provider_username=%s and connection_started_at=%s
            and played_at>=%s and played_at<%s and played_at>%s
            order by played_at limit 256""",(*params,after)).fetchall()
        if not buckets:break
        for bucket in buckets:
            timestamp=bucket['played_at']
            uncertain=_bucket_uncertain(connection,scope,stamp,timestamp)
            candidates=iter(()) if uncertain else _native_candidates(connection,snapshot_id,scope,stamp,timestamp)
            own=next(candidates,None)
            remote_rows=_remote_rows(connection,scope,stamp,timestamp)
            try:
                for row in remote_rows:
                    key=(timestamp,row['artist'],row['track'],row['album'])
                    while own is not None and own[0]<key:own=next(candidates,None)
                    if own is not None and own[0]==key:
                        connection.execute("""update app.activity_snapshot_rows set
                            payload=jsonb_set(payload,'{lastfm_observation}',%s::jsonb),
                            source_labels=array(select distinct unnest(source_labels||array['Last.fm history']))
                            where snapshot_id=%s and row_key=%s""",
                            (json.dumps({'source':'in_app','correlation':'exact_observed_tuple','uncertain':False}),
                             snapshot_id,own[1]['row_key']))
                        coverage['matched_rows']+=1
                        own=next(candidates,None)
                        continue
                    row_key,payload=_remote_row(row,secret,uncertain=uncertain)
                    connection.execute("""insert into app.activity_snapshot_rows
                        (snapshot_id,row_key,latest_at,latest_event_id,listen_count,source_labels,payload)
                        values(%s,%s,to_timestamp(%s),0,1,array['Last.fm history'],%s::jsonb)""",
                        (snapshot_id,row_key,timestamp,json.dumps(payload)))
                    # Remote tie sentinel only; no native snapshot event is forged.
                    added+=1;coverage['imported_rows']+=1
                    if uncertain:coverage['uncertain_rows']+=1
            finally:
                # Remote may end before native; close its named cursor explicitly.
                remote_rows.close()
                if hasattr(candidates,'close'):candidates.close()
        after=buckets[-1]['played_at']
    if coverage['uncertain_rows']:
        coverage['observation_state']='uncertain'
    return added,coverage
