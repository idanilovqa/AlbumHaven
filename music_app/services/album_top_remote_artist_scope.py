"""Exact current-library Artist evidence for new retained remote Top members.

The mutation owner carries this immutable witness in its own transaction. This
module does not acquire sources, resolve names, publish identity, or grant Browse.
"""
from dataclasses import dataclass, replace

from music_app.services.musicbrainz_tags import canonical_mbid
from music_app.services.owned_album_tops import AlbumTopError, MAX_TOP_ITEMS
from music_app.services.album_top_remote_sources import evidence_from_row


@dataclass(frozen=True)
class RemoteScopeWitness:
    local: object
    top_ref: str
    owner_account_id: int
    selectors: tuple
    identities: tuple
    facts: tuple = ()


def source_key(source):
    return (source['kind'], source.get('acquisition_ref', source.get('admission_ref')),
            source['evidence_version'])


def new_selectors(connection, live, command, top):
    if 'selections' in command.data:
        return tuple(source_key(row) for row in command.data['selections']
                     if row['kind'] in {'remote_acquisition', 'remote_retained'})
    rows = command.data.get('item_selections', ())
    if not any(row['source']['kind'] in {'remote_acquisition', 'remote_retained'} for row in rows):
        return ()
    current = connection.execute('''select ref,catalog_ref from app.album_list_items
        where top_ref=%s and library_id=%s''', (top['ref'], live.library_id)).fetchall()
    pairs = {(str(row['ref']), str(row['catalog_ref'])) for row in current}
    # Only an exact existing working member is exempt. The Save owner still
    # proves that its selected source resolves to this very catalog identity.
    return tuple(source_key(row['source']) for row in rows
        if row['source']['kind'] in {'remote_acquisition', 'remote_retained'}
        and not (row['kind'] == 'existing'
                 and (row.get('item_ref'), row.get('album_ref')) in pairs))


def _identities(connection, live, members, *, lock=False):
    ids = [identity for identity, _basis in members]
    if not ids or len(ids) > MAX_TOP_ITEMS:
        raise AlbumTopError('artist_scope_unavailable', 409)
    rows = connection.execute('''select id,artist_key,name,mbid,mbid_assertion_state,evidence_source
        from library.local_artists where library_id=%s and id=any(%s::bigint[])
        order by id''' + (' for share nowait' if lock else ''), (live.library_id, ids)).fetchall()
    if [row['id'] for row in rows] != ids:
        raise AlbumTopError('artist_scope_changed' if lock else 'artist_scope_unavailable', 409)
    return tuple((row['id'], row['artist_key'], row['name'],
        str(row['mbid']) if row['mbid'] is not None else None,
        row['mbid_assertion_state'], row['evidence_source']) for row in rows)


def capture(connection, live, top, local, selectors):
    return RemoteScopeWitness(local, str(top['ref']), top['owner_account_id'], selectors,
                              _identities(connection, live, local.members))


def known_artist_ids(identities):
    return tuple(canonical_mbid(mbid) if state == 'asserted' and source else None
                 for _identity, _key, _name, mbid, state, source in identities)


def matches_credits(identities, evidence):
    return evidence.credited_artist_ids is not None and bool(
        set(evidence.credited_artist_ids).intersection(
            identity for identity in known_artist_ids(identities) if identity is not None))


@dataclass(frozen=True)
class SearchScopeWitness:
    local: object
    identities: tuple


def capture_search(connection, live, scope, constraints):
    from music_app.services import album_top_artist_scope_postgres as local_scope
    if scope is None:
        return None
    local = local_scope.capture(connection, live, scope, (), constraints)
    identities = _identities(connection, live, local.members)
    if not any(known_artist_ids(identities)):
        raise AlbumTopError('artist_scope_unavailable', 409)
    return SearchScopeWitness(local, identities)


def finish_search(connection, live, witness, constraints):
    from music_app.services import album_top_artist_scope_postgres as local_scope
    try:
        identities = _identities(connection, live, witness.local.members, lock=True)
        if identities != witness.identities:
            raise AlbumTopError('artist_scope_changed', 409)
        local_scope.finish(connection, live, witness.local, constraints)
    except Exception as error:
        if isinstance(error, AlbumTopError) or getattr(error, 'sqlstate', None) == '55P03':
            raise AlbumTopError('artist_scope_changed', 409) from None
        raise


def validate(witness, candidates):
    if not isinstance(witness, RemoteScopeWitness):
        return witness
    known = known_artist_ids(witness.identities)
    required = set(witness.selectors)
    facts = []
    for key, evidence in candidates:
        if key not in required:
            continue
        credits = evidence.credited_artist_ids
        if credits is None:
            raise AlbumTopError('artist_scope_unavailable', 409)
        if not matches_credits(witness.identities, evidence):
            raise AlbumTopError('artist_scope_unavailable' if None in known
                                else 'album_outside_artist_scope', 409)
        facts.append((key, evidence))
    if {key for key, _ in facts} != required or len(facts) != len(required):
        raise AlbumTopError('artist_scope_changed', 409)
    return replace(witness, facts=tuple(facts))


def _final_fact(connection, live, witness, key):
    kind, ref, version = key
    # Pending acquisitions have already been consumed/deleted. The existing
    # consumed attempt and exact retained bridge are the final lineage owner.
    lineage = '''join app.album_top_remote_attempts t
        on t.consumed_admission_ref=a.ref and t.consumed_top_ref=a.top_ref
          and t.consumed_catalog_ref=a.catalog_ref and t.consumed_item_ref=r.item_ref
        where t.acquisition_ref=%s and t.evidence_version=%s and t.state='consumed'
          and t.actor_account_id=%s''' if kind == 'remote_acquisition' else '''
        where a.ref=%s and a.evidence_version=%s'''
    params = [ref, version]
    if kind == 'remote_acquisition':
        params.append(live.actor.account_id)
    rows = connection.execute('''select a.* from app.album_top_remote_admissions a
        join app.album_list_item_remote_sources r on r.admission_ref=a.ref
          and r.top_ref=a.top_ref and r.library_id=a.library_id
          and r.owner_account_id=a.owner_account_id and r.catalog_ref=a.catalog_ref
        join app.album_list_items i on i.ref=r.item_ref and i.top_ref=r.top_ref
          and i.library_id=r.library_id and i.catalog_ref=r.catalog_ref
        ''' + lineage + ''' and a.top_ref=%s and a.library_id=%s
          and a.owner_account_id=%s and a.retired_at is null''',
        (*params, witness.top_ref, live.library_id, witness.owner_account_id)).fetchall()
    if len(rows) != 1:
        raise AlbumTopError('artist_scope_changed', 409)
    return evidence_from_row(rows[0])


def finish(connection, live, witness, constraints):
    from music_app.services import album_top_artist_scope_postgres as local_scope
    try:
        identities = _identities(connection, live, witness.local.members, lock=True)
    except Exception as error:
        if getattr(error, 'sqlstate', None) == '55P03':
            # Escape the whole transaction; PostgreSQL has already aborted it.
            raise AlbumTopError('artist_scope_changed', 409) from None
        raise
    if identities != witness.identities:
        raise AlbumTopError('artist_scope_changed', 409)
    try:
        local_scope.finish(connection, live, witness.local, constraints)
        if {key for key, _facts in witness.facts} != set(witness.selectors):
            raise AlbumTopError('artist_scope_changed', 409)
        for key, facts in witness.facts:
            if _final_fact(connection, live, witness, key) != facts:
                raise AlbumTopError('artist_scope_changed', 409)
    except AlbumTopError:
        raise AlbumTopError('artist_scope_changed', 409) from None
