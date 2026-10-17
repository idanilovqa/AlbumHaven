"""Current strict missing captures from sealed own/Friend Activity receipts."""
from psycopg.types.json import Jsonb

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.owned_playlists import BROWSE, CREATE, MISSING_ACTIVITY_PROTOCOL, MAX_PLAYLIST_ITEMS_PER_COMMAND, PlaylistError, evidence_digest, uuid_ref
from music_app.services import playlist_activity_sources as activity
from music_app.services import playlist_missing_sources as missing
from music_app.services import playlist_creation_sources_postgres as sources
from music_app.services.playlist_complete_sources import _header


def missing_rows(connection,context,exported,*,config,constraints,current=None):
    rows=activity._rows(connection,context,exported,config=config,
        constraints=constraints,preserve_occurrences=True,current=current)
    # This protocol's evidence is occurrence-bound. Ordinary inventory receipts
    # keep their original identity/evidence uniqueness rule unchanged.
    return [{**row,'evidence_digest':evidence_digest({'inventory':row['evidence_digest'],
        'source_row_ref':row['source_row_ref']})} for row in rows if row['availability']=='missing']


def export_source(owner,connection,context,source,*,constraints):
    origin=source.get('origin_descriptor') or {}
    descriptor=activity.normalize_activity_origin(origin.get('activity'))
    row_refs=origin.get('row_order')
    if not isinstance(row_refs,list) or not row_refs:raise PlaylistError('source_changed',409)
    return activity._export(connection,context,descriptor,row_refs,config=owner._config,
        constraints=constraints,source_order=True)


def inspect(owner,context,origin,row_refs=None,*,constraints=None,probe=False):
    origin=activity.normalize_activity_origin(origin)
    target=activity.lock_target(owner,context,origin=origin,constraints=constraints)
    with owner._authorized(context,constraints,target_account_id=target) as (connection,live,now):
        owner._require(live,(BROWSE,CREATE),constraints)
        exported=activity._export(connection,live,origin,row_refs,config=owner._config,
            constraints=constraints,source_order=True)
        rows=missing_rows(connection,live,exported,config=owner._config,constraints=constraints)
        # Inventory locks/probes may wait past the Activity receipt expiry.
        # Recheck the same sealed source; never refresh or replace membership.
        activity._export(connection,live,origin,row_refs,config=owner._config,
            constraints=constraints,source_order=True)
        now=lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
            actor_session_id=live.actor.session_id,clock=owner._clock)
        if probe:
            return {'status':'ready','data':{'can_inspect_missing':bool(rows),
                'missing_count':len(rows),'actor_scope':owner._scope(live)}}
        if not rows:raise PlaylistError('no_confirmed_missing_tracks',409)
        descriptor={'activity':origin,'row_order':[row['source_row_ref'] for row in rows]}
        source=_header(connection,live,now,protocol=MISSING_ACTIVITY_PROTOCOL,kind='activity',origin=descriptor)
        values=missing.store_rows(connection,source,rows)
        source['origin_descriptor']={**descriptor,'entry_order':[row['ref'] for row in values]}
        connection.execute('update app.playlist_creation_sources set origin_descriptor=%s where ref=%s',
            (Jsonb(source['origin_descriptor']),source['ref']))
        return missing._envelope(owner,live,source,values,{'title':'Recent activity'},constraints)


def read_capture(owner,context,source_ref,revision,*,constraints=None):
    source_ref,revision=uuid_ref(source_ref),uuid_ref(revision)
    target=activity.lock_target(owner,context,source_ref=source_ref,constraints=constraints)
    with owner._authorized(context,constraints,target_account_id=target) as (connection,live,now):
        owner._require(live,(BROWSE,CREATE),constraints)
        source=sources.load_source(connection,live,source_ref,revision,now,protocol=MISSING_ACTIVITY_PROTOCOL,kind='activity')
        refs=(source.get('origin_descriptor') or {}).get('entry_order')
        if not isinstance(refs,list) or not refs or len(refs)>MAX_PLAYLIST_ITEMS_PER_COMMAND or len(set(refs))!=len(refs):
            raise PlaylistError('source_changed',409)
        refs=[uuid_ref(ref) for ref in refs]
        rows=missing.selected(owner,connection,live,source,refs,constraints=constraints)
        now=lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
            actor_session_id=live.actor.session_id,clock=owner._clock)
        if source['expires_at']<=now:raise PlaylistError('source_expired',410)
        return missing._envelope(owner,live,source,rows,{'title':'Recent activity'},constraints)
