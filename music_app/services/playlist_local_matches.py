"""Bounded local-only Missing draft review, explicit choice, and fresh Save proof."""
import json
import re
import unicodedata
from uuid import uuid4

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.owned_playlists import BROWSE, CREATE, PlaylistError, evidence_digest, uuid_ref, playlist_revision
from music_app.services.policy import ResourceScope
from music_app.services import playlist_creation_sources_postgres as inventory
from music_app.services import playlist_missing_sources as missing
from music_app.services.playlist_availability import confirmed_local_evidence

CANDIDATE_POOL_LIMIT = 128
MAX_SUGGESTIONS = 8
MAX_MATCH_TEXT = 256
MATCH_BODY_BYTES = 4096
_FEATURE = re.compile(r'\s+(?:feat|ft|featuring)\s+.*$')
_EDITION = re.compile(r'\s+(?:bonus track|bonus|remaster(?:ed)?(?: \d{4})?|deluxe edition)$')


def normalize_request(payload, *, accept=False):
    fields={'source','entry_ref'} | ({'review_ref','candidate_ref'} if accept else set())
    if not isinstance(payload,dict) or set(payload)!=fields:raise PlaylistError('invalid_command')
    source=payload['source']
    if not isinstance(source,dict) or set(source)!={'kind','ref','revision'} or source['kind']!='playlist':
        raise PlaylistError('invalid_command')
    result={'source':{'kind':'playlist','ref':uuid_ref(source['ref']),'revision':playlist_revision(source['revision'])},
        'entry_ref':uuid_ref(payload['entry_ref'])}
    if accept:result.update(review_ref=uuid_ref(payload['review_ref']),candidate_ref=uuid_ref(payload['candidate_ref']))
    return result


def normalized(value):
    value=unicodedata.normalize('NFKC',value if isinstance(value,str) else '').lower()
    return ' '.join(''.join(char if char.isalnum() else ' ' for char in value).split())


def _base_title(value):
    return _EDITION.sub('',_FEATURE.sub('',normalized(value))).strip()


def _similarity(left,right):
    # Bounded inputs keep edit-distance work independent of arbitrary metadata size.
    row=list(range(len(right)+1))
    for i,char in enumerate(left,1):
        previous=row[0];row[0]=i
        for j,other in enumerate(right,1):
            old=row[j]
            row[j]=min(row[j]+1,row[j-1]+1,previous+(char!=other))
            previous=old
    return 1-row[-1]/max(len(left),len(right),1)


def rank_candidates(original,rows):
    if any(isinstance(original.get(key),str) and len(original[key])>MAX_MATCH_TEXT for key in ('title','artist')):return []
    title,artist=_base_title(original.get('title')),normalized(original.get('artist'))
    if not title or len(title)>MAX_MATCH_TEXT or len(artist)>MAX_MATCH_TEXT:return []
    ranked=[]
    for row in rows:
        if any(isinstance(row.get(key),str) and len(row[key])>MAX_MATCH_TEXT for key in ('title','artist')):continue
        other=_base_title(row.get('title'))
        if not other or len(other)>MAX_MATCH_TEXT or normalized(row.get('artist'))!=artist:continue
        score=1 if normalized(original.get('title'))==normalized(row.get('title')) else _similarity(title,other)
        if score>=.82:ranked.append((score,str(row['original_local_track_id']),row))
    return [row for _,_,row in sorted(ranked,key=lambda value:(-value[0],value[1]))]


def _candidate_pool(connection,context,original):
    # No free-text endpoint or complete-library materialization. SQL first bounds
    # a deterministic same-normalized-artist pool; Python supplies the mock rank.
    if any(isinstance(original.get(key),str) and len(original[key])>MAX_MATCH_TEXT for key in ('title','artist')):return [],False
    artist=normalized(original.get('artist'))
    if len(artist)>MAX_MATCH_TEXT or len(_base_title(original.get('title')))>MAX_MATCH_TEXT:return [],False
    rows=connection.execute("""select t.id as original_local_track_id,left(t.title,257) as title,left(ar.name,257) as artist
        from library.local_tracks t left join library.local_artists ar
          on ar.id=t.artist_id and ar.library_id=t.library_id
        where t.library_id=%s and t.id<>%s
          and btrim(regexp_replace(lower(normalize(coalesce(ar.name,''),NFKC)), '[^[:alnum:]]+', ' ', 'g'))=%s
        order by t.id limit %s""",(context.library_id,original['original_local_track_id'],artist,CANDIDATE_POOL_LIMIT+1)).fetchall()
    complete=len(rows)<=CANDIDATE_POOL_LIMIT and all(
        len(row.get(key) or '')<=MAX_MATCH_TEXT for row in rows for key in ('title','artist'))
    return rows[:CANDIDATE_POOL_LIMIT],complete


def _fresh_now(owner,connection,context,source):
    now=lock_current_actor_session(connection,actor_account_id=context.actor.account_id,
        actor_session_id=context.actor.session_id,clock=owner._clock)
    if source['expires_at']<=now:raise PlaylistError('source_expired',410)


def _proofs(owner,connection,context,rows,*,constraints):
    visible={identity:row for identity,row in rows.items() if owner._resource_allowed(
        context,BROWSE,ResourceScope('track',str(identity)),constraints)}
    files=confirmed_local_evidence(connection,context.library_id,visible,config=owner._config)
    return {identity:evidence_digest({'inventory':inventory.entry_evidence(visible[identity]),'files':proof})
        for identity,proof in files.items()}


def _envelope(owner,context,request,**data):
    return {'status':'ready','data':{'source':request['source'],'source_protocol':missing.MISSING_PROTOCOL,
        'entry_ref':request['entry_ref'],**data,'actor_scope':owner._scope(context)}}


def review(owner,context,payload,*,constraints=None):
    request=normalize_request(payload)
    with owner._authorized(context,constraints) as (connection,live,now):
        owner._require(live,(BROWSE,CREATE),constraints)
        source=missing.load_source(connection,live,request['source'],request['entry_ref'],now)
        # Source Playlist authority is checked before any candidate lookup.
        missing._playlist(owner,connection,live,request['source']['ref'],request['source']['revision'],constraints)
        original=connection.execute('select * from app.playlist_creation_entries where source_ref=%s and ref=%s',
            (source['ref'],request['entry_ref'])).fetchone()
        if original is None:raise PlaylistError('source_unavailable',404)
        pool,complete=_candidate_pool(connection,live,original)
        ranked=rank_candidates(original,pool)
        ordered,current,_=missing.validated_selection(owner,connection,live,source,[request['entry_ref']],
            constraints=constraints,extra_track_ids=[row['original_local_track_id'] for row in ranked],write_receipts=True)
        # Read/rank again after inventory waits; labels observed before a wait are hints only.
        ranked=rank_candidates(ordered[0],[current[row['original_local_track_id']] for row in ranked
            if row['original_local_track_id'] in current])
        proofs=_proofs(owner,connection,live,{row['original_local_track_id']:row for row in ranked},constraints=constraints)
        eligible=[row for row in ranked if row['original_local_track_id'] in proofs]
        review_ref=str(uuid4())
        candidates=[{'candidate_ref':str(uuid4()),'track_id':row['original_local_track_id'],
            'evidence_digest':proofs[row['original_local_track_id']]} for row in eligible[:MAX_SUGGESTIONS]]
        _fresh_now(owner,connection,live,source)
        connection.execute("""insert into app.playlist_local_match_receipts(source_ref,entry_ref,review_ref,candidates)
            values(%s,%s,%s,%s::jsonb) on conflict(source_ref,entry_ref) do update
              set review_ref=excluded.review_ref,candidates=excluded.candidates""",
            (source['ref'],request['entry_ref'],review_ref,json.dumps(candidates,allow_nan=False)))
        public=[{'candidate_ref':candidate['candidate_ref'],
            'inventory_track_ref':f"inventory-track:{live.library_id}:{candidate['track_id']}",
            **{key:current[candidate['track_id']].get(key) for key in ('title','artist','album_title','duration_seconds')}}
            for candidate in candidates]
        return _envelope(owner,live,request,review_ref=review_ref,candidates=public,
            suggestion_scope='bounded_local_inventory',
            # A narrowed policy must not reveal the hidden pool's row-count or
            # truncation boundary through a public completeness flag.
            suggestions_complete=not callable(constraints) and complete and len(eligible)<=MAX_SUGGESTIONS)


def accept(owner,context,payload,*,constraints=None):
    request=normalize_request(payload,accept=True)
    with owner._authorized(context,constraints) as (connection,live,now):
        owner._require(live,(BROWSE,CREATE),constraints)
        source=missing.load_source(connection,live,request['source'],request['entry_ref'],now)
        missing._playlist(owner,connection,live,request['source']['ref'],request['source']['revision'],constraints)
        receipt=connection.execute('''select * from app.playlist_local_match_receipts
            where source_ref=%s and entry_ref=%s for update''',(source['ref'],request['entry_ref'])).fetchone()
        if receipt is None:raise PlaylistError('match_review_changed',409)
        replay=(str(receipt['chosen_review_ref'])==request['review_ref']
                and str(receipt['chosen_candidate_ref'])==request['candidate_ref'])
        if replay:
            candidate={'track_id':receipt['chosen_track_id'],'evidence_digest':receipt['chosen_evidence_digest']}
        else:
            if (str(receipt['review_ref'])!=request['review_ref']
                    or str(receipt['chosen_review_ref'])==request['review_ref']):
                raise PlaylistError('match_review_changed',409)
            candidate=next((row for row in receipt['candidates'] if row['candidate_ref']==request['candidate_ref']),None)
            if candidate is None:raise PlaylistError('match_unavailable',409)
        ordered,current,_=missing.validated_selection(owner,connection,live,source,[request['entry_ref']],
            constraints=constraints,extra_track_ids=[candidate['track_id']],write_receipts=True)
        proofs=_proofs(owner,connection,live,{identity:row for identity,row in current.items()
            if identity==candidate['track_id']},constraints=constraints)
        if proofs.get(candidate['track_id'])!=candidate['evidence_digest']:raise PlaylistError('match_unavailable',409)
        _fresh_now(owner,connection,live,source)
        if not replay:
            connection.execute('''update app.playlist_local_match_receipts set chosen_review_ref=%s,
                chosen_candidate_ref=%s,chosen_track_id=%s,chosen_evidence_digest=%s
                where source_ref=%s and entry_ref=%s''',(request['review_ref'],request['candidate_ref'],
                candidate['track_id'],candidate['evidence_digest'],source['ref'],request['entry_ref']))
        entry=inventory.project_entry(source,ordered[0],album_readable=lambda album_id:owner._resource_allowed(
            live,BROWSE,ResourceScope('album',str(album_id)),constraints))
        if entry['parent_album']['allowed_actions']['can_read']:entry['parent_album']['completeness']='incomplete'
        entry.update(inventory_track_ref=f"inventory-track:{live.library_id}:{candidate['track_id']}",
            availability='local',match_state='accepted')
        return _envelope(owner,live,request,entry=entry)


def apply_choices(owner,connection,context,ordered,current,receipts,*,constraints):
    chosen={row['chosen_track_id'] for row in receipts.values() if row['chosen_track_id'] is not None}
    proofs=_proofs(owner,connection,context,{identity:row for identity,row in current.items() if identity in chosen},constraints=constraints)
    result=[]
    for original in ordered:
        receipt=receipts.get(str(original['ref']))
        if receipt is not None and receipt['chosen_track_id'] is not None:
            identity=receipt['chosen_track_id']
            if proofs.get(identity)!=receipt['chosen_evidence_digest']:raise PlaylistError('match_unavailable',409)
            original={**original,'validated_match_track_id':identity}
        result.append(original)
    return result
