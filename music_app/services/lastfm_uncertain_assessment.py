"""Read-only uncertain-attempt assessment; never acknowledgement or send authority."""
import json
from uuid import uuid4
from .lastfm_history_model import uncertain_request_tuple, accepted_tuple, tuple_digest

CHUNK=256


def assessment(*, bound, complete=False, observations=0, competitors=0):
    if not bound:state='unbound_attempt'
    elif not complete:state='incomplete_observation'
    elif observations==0:state='not_observed'
    elif observations==1 and competitors==1:state='possible_observation'
    else:state='ambiguous_observation'
    return {'state':state,'accepted':False,'proves_not_sent':False,'can_resend':False,
        'provider_snapshot_guaranteed':False}


def _candidates(connection,snapshot_id,scope,binding,timestamp):
    """One ordered traversal of all genuine competing attempts in this second."""
    with connection.cursor(name='lastfm_uncertain_candidates_'+uuid4().hex) as cursor:
        cursor.execute("""with candidates as (
            select h.id,h.account_id,h.library_id,h.source_family,h.measurement_version,h.played_at,h.scrobble_status,
                h.metadata->'source_payload' as payload,h.device_id::text as device_id,
                h.session_id::text as session_id,h.source_entry_id,
                count(*) over(partition by h.source_entry_id) as physical_copies,
                case when h.metadata#>>'{source_payload,scrobble_submission_state}'='accepted'
                  then h.metadata#>'{source_payload,scrobble_submission_identity,reply}'
                  else h.metadata#>'{source_payload,scrobble_submission_identity,request}' end as tuple_fields
            from app.activity_snapshot_events e join integration.listen_history h on h.id=e.event_id
            where e.snapshot_id=%s and h.account_id=%s and h.library_id=%s
              and h.played_at>=to_timestamp(%s) and h.played_at<to_timestamp(%s)
              and h.source_family='rendered_local_listen_session' and h.measurement_version='rendered-pcm-v1')
            select * from candidates where physical_copies=1
            order by (tuple_fields->>'artist') collate "C",(tuple_fields->>'track') collate "C",
              (tuple_fields->>'album') collate "C",id""",
            (snapshot_id,scope.account_id,scope.library_id,timestamp,timestamp+1))
        while True:
            rows=cursor.fetchmany(CHUNK)
            if not rows:return
            for row in rows:
                key=uncertain_request_tuple(row,**binding) or accepted_tuple(row,**binding)
                if key is not None:yield key


def append_uncertain_assessments(connection,*,snapshot_id,scope,stamp,bucket_uncertain):
    """Inside actual own-account Home capture and optional account-read fence.

    One uncertain-row cursor and one competitor cursor per timestamp; each
    exact request tuple does one indexed remote multiplicity read. No repeated
    native prefix scan and no whole-bucket Python list, even for dense seconds.
    """
    binding=dict(account_id=scope.account_id,library_id=scope.library_id,
        provider_username=stamp['provider_username'],connection_started_at=stamp['connection_started_at'])
    candidates=iter(());candidate=None;timestamp=None;last_key=None;cached=None
    with connection.cursor(name='lastfm_uncertain_rows_'+uuid4().hex) as cursor:
        cursor.execute("""with native as (
            select h.id,h.account_id,h.library_id,h.source_family,h.measurement_version,h.played_at,h.scrobble_status,
                h.metadata->'source_payload' as payload,h.device_id::text as device_id,
                h.session_id::text as session_id,h.source_entry_id,e.row_key,
                count(*) over(partition by h.source_entry_id) as physical_copies
            from app.activity_snapshot_events e join integration.listen_history h on h.id=e.event_id
            where e.snapshot_id=%s and h.account_id=%s and h.library_id=%s
              and h.source_family='rendered_local_listen_session' and h.measurement_version='rendered-pcm-v1')
            select n.* from native n join app.activity_snapshot_rows r
              on r.snapshot_id=%s and r.row_key=n.row_key
            where r.payload#>>'{scrobble_delivery,state}' in ('delivery_unconfirmed','unknown')
            order by floor(extract(epoch from n.played_at)),
              (n.payload#>>'{scrobble_submission_identity,request,artist}') collate "C",
              (n.payload#>>'{scrobble_submission_identity,request,track}') collate "C",
              (n.payload#>>'{scrobble_submission_identity,request,album}') collate "C",n.id""",
            (snapshot_id,scope.account_id,scope.library_id,snapshot_id))
        try:
            while True:
                rows=cursor.fetchmany(CHUNK)
                if not rows:return
                for row in rows:
                    key=uncertain_request_tuple(row,**binding) if row['physical_copies']==1 else None
                    if key is None:result=assessment(bound=False)
                    else:
                        if key[0]!=timestamp:
                            if hasattr(candidates,'close'):candidates.close()
                            timestamp=key[0];last_key=None
                            complete=not bucket_uncertain(connection,scope,stamp,timestamp)
                            candidates=_candidates(connection,snapshot_id,scope,binding,timestamp) if complete else iter(())
                            candidate=next(candidates,None)
                        if key!=last_key:
                            if not complete:cached=assessment(bound=True)
                            else:
                                while candidate is not None and candidate<key:candidate=next(candidates,None)
                                competitors=0
                                while candidate==key:
                                    competitors=min(2,competitors+1);candidate=next(candidates,None)
                                count=connection.execute("""select count(*) as count from integration.lastfm_history_occurrences_v1
                                    where account_id=%s and provider_username=%s and connection_started_at=%s
                                      and played_at=%s and tuple_digest=%s and artist=%s and track=%s and album=%s""",
                                    (scope.account_id,stamp['provider_username'],stamp['connection_started_at'],
                                     key[0],tuple_digest(key),*key[1:])).fetchone()['count']
                                cached=assessment(bound=True,complete=True,observations=count,competitors=competitors)
                            last_key=key
                        result=cached
                    connection.execute("""update app.activity_snapshot_rows set
                        payload=jsonb_set(payload,'{lastfm_assessment}',%s::jsonb)
                        where snapshot_id=%s and row_key=%s""",(json.dumps(result),snapshot_id,row['row_key']))
        finally:
            if hasattr(candidates,'close'):candidates.close()
