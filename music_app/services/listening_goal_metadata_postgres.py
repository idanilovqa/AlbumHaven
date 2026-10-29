"""Derived Goals metadata on caller-owned transactions; no enrichment or writes.

Local tags are evidence, not externally verified taxonomy. Cached track counts
are an album ranking proxy, never an album play count. Unknown stays unknown.
"""
from dataclasses import replace
from datetime import timedelta
import hashlib
import json
from statistics import median

from music_app.services.current_actor import CapabilityGrant, LibraryRelationship
from music_app.services.policy import ResourceScope
from music_app.services.private_native_targets import allows
from music_app.services.private_library_authority import require_private_action
from music_app.services.listening_goals_commands import GoalsError
from music_app.services.listening_goal_metadata_rules import broad_parents, popularity_proxy, usual_genres, RULES_VERSION, POPULARITY_VERSION, TASTE_VERSION
from music_app.services.sample_playlist_facets import _styles
from music_app.services.owned_playlists import PlaylistError
from music_app.services.library_mix_inventory_postgres import read_inventory, normalize_cached_inventory_row
from music_app.services.album_preferences_postgres import load_album_preferences_on_connection
from music_app.services.lastfm_listen_sync import playback_scrobble_threshold_seconds

MAX_ALBUMS = 5000
MAX_TRACKS = 20000
MAX_HISTORY = 10000
TASTE_DAYS = 90
BROWSE = 'library.browse.read'


def pin_context(connection, context, constraints):
    """Optional current-library evidence, with membership/grants locked afresh.

    Account Goals does not require a selected library. Missing library evidence
    returns unknown; an admitted scope that later loses policy fails closed.
    """
    actor = context.actor
    if (not actor.is_authenticated or context.target_account_id not in (None, actor.account_id)):
        raise GoalsError('forbidden', 403)
    library = actor.current_library_id
    if type(library) is not int or library <= 0:
        return None
    membership = connection.execute('''select m.membership_role,l.owner_account_id=%s as is_primary_owner
        from library.library_memberships m join library.libraries l on l.id=m.library_id
        where m.account_id=%s and m.library_id=%s for share of m,l''',
        (actor.account_id, actor.account_id, library)).fetchone()
    if membership is None:
        return None
    grants = connection.execute('''select capability_key,scope_kind,scope_id from app.capabilities
        where account_id=%s and revoked_at is null order by id for share''', (actor.account_id,)).fetchall()
    bootstrap = connection.execute("select account_id from app.bootstrap_owners where account_id=%s and owner_key='local-bootstrap-owner' for share",
        (actor.account_id,)).fetchone()
    # Refresh persisted bootstrap authority; never trust or erase a stale flag.
    live = replace(context, library_id=library, target_account_id=None,
        actor=replace(actor, is_bootstrap_owner=bootstrap is not None,
            library_relationships=(LibraryRelationship(library, membership['membership_role'], membership['is_primary_owner']),),
            capability_grants=tuple(CapabilityGrant(r['capability_key'], r['scope_kind'], r['scope_id']) for r in grants)))
    if not allows(live, BROWSE, None, constraints):
        return None
    return live


def _allowed(live, kind, identity, constraints):
    return allows(live, BROWSE, ResourceScope(kind, str(identity)), constraints)


def _bounded(rows, maximum):
    if len(rows) > maximum:
        raise GoalsError('weekly_metadata_pool_too_large', 409)
    return rows


def load_evidence(connection, context, constraints, *, now, profile=True, popularity=True):
    live = pin_context(connection, context, constraints)
    if live is None:
        return {}, frozenset(), {'version': RULES_VERSION, 'known_genre_albums': 0,
            'known_popularity_albums': 0, 'taste_state': 'unknown'}
    library = live.library_id
    rows = _bounded(connection.execute('''select a.id,l.catalog_ref from library.local_albums a
        left join library.catalog_album_links l on l.library_id=a.library_id and l.local_album_id=a.id
        where a.library_id=%s order by a.id limit 5001 for share of a''', (library,)).fetchall(), MAX_ALBUMS)
    albums = {r['id']: r for r in rows if _allowed(live, 'album', r['id'], constraints)}
    # Runtime has SELECT/INSERT, not UPDATE, on canonical links. Do not row-lock
    # that append-only relation: local album/track locks prevent parent deletion
    # or reparenting, and the exact link snapshot is rechecked before consumption.
    links = connection.execute('''select local_album_id,catalog_ref from library.catalog_album_links
        where library_id=%s and local_album_id=any(%s::bigint[]) order by local_album_id''',
        (library, sorted(albums))).fetchall() if albums else []
    linked = {r['local_album_id']:r['catalog_ref'] for r in links}
    albums = {i:{**row, 'catalog_ref':linked.get(i)} for i,row in albums.items()}
    tracks = _bounded(connection.execute('''select id,album_id,duration_seconds from library.local_tracks
        where library_id=%s and album_id=any(%s::bigint[]) order by id limit 20001 for share''',
        (library, sorted(albums))).fetchall(), MAX_TRACKS) if albums else []
    tracks = {r['id']: r for r in tracks if _allowed(live, 'track', r['id'], constraints)}
    try:
        tags = _styles(connection, library, sorted(tracks)) if tracks else {}
    except PlaylistError as error:
        raise GoalsError('weekly_metadata_pool_too_large', 409) from error
    parents, observations, album_tracks = {i:set() for i in albums}, {i:[] for i in albums}, {i:[] for i in albums}
    for identity, track in tracks.items():
        album = track['album_id']; album_tracks[album].append(str(identity))
        values, state = tags.get(identity, (None, 'unknown'))
        if state == 'known':
            parents[album].update(broad_parents(v.removeprefix('genre-tag:') for v in values))
    if popularity:
        for offset in range(0, len(tracks), 500):
            ids = sorted(tracks)[offset:offset+500]
            for row in read_inventory(connection, library, track_ids=ids):
                identity = row['original_local_track_id']
                if identity not in tracks or row['original_album_id'] != tracks[identity]['album_id']:
                    raise GoalsError('weekly_metadata_changed', 409)
                try:
                    _, cached, _ = normalize_cached_inventory_row(row)
                except (ValueError, TypeError):
                    cached = None
                if cached and cached.observation.attribution_state == 'resolved':
                    o = cached.observation
                    observations[tracks[identity]['album_id']].append({'track_ref':str(identity),
                        'provider':o.provider, 'entity_ref':o.source_entity_id, 'count':o.count})
    seeds = set()
    if profile and albums:
        history = _bounded(connection.execute('''select h.track_id,h.measured_listened_seconds
            from integration.listen_history h join library.local_tracks t
                on t.id=h.track_id and t.library_id=h.library_id
            where h.account_id=%s and h.library_id=%s and h.played_at>=%s and h.played_at<=%s
                and h.source_family='rendered_local_listen_session' and h.measurement_version='rendered-pcm-v1'
                and h.finalized is true and h.measured_listened_seconds>0
            order by h.played_at desc,h.id desc limit 10001''',
            (live.actor.account_id, library, now-timedelta(days=TASTE_DAYS), now)).fetchall(), MAX_HISTORY)
        for event in history:
            track = tracks.get(event['track_id'])
            if track:
                threshold = playback_scrobble_threshold_seconds(track['duration_seconds'])
                if threshold > 0 and event['measured_listened_seconds'] >= threshold:
                    seeds.add(track['album_id'])
        ids = sorted(albums)
        for offset in range(0, len(ids), 500):
            prefs = load_album_preferences_on_connection(connection, account_id=live.actor.account_id,
                library_id=library, album_ids=ids[offset:offset+500])
            seeds.update(i for i,p in prefs.items() if p.get('favorite') is True or
                (type(p.get('rating')) in (int,float) and p['rating'] >= 7))
    current_links = connection.execute('''select local_album_id,catalog_ref from library.catalog_album_links
        where library_id=%s and local_album_id=any(%s::bigint[]) order by local_album_id''',
        (library, sorted(albums))).fetchall() if albums else []
    if {r['local_album_id']:r['catalog_ref'] for r in current_links} != linked:
        raise GoalsError('weekly_metadata_changed', 409)
    # All consumption is fenced after metadata/rating SQL. No stale partial
    # profile is returned when a dynamic resource constraint changes.
    require_private_action(live, BROWSE, constraints=constraints)
    for kind, identities in (('album', albums), ('track', tracks)):
        for identity in identities:
            if not _allowed(live, kind, identity, constraints):
                raise GoalsError('source_context_unavailable', 403)
    facts = {}
    for identity, row in albums.items():
        facts[identity] = {'genres':tuple(sorted(parents[identity])),
            'popularity':popularity_proxy(album_tracks[identity], observations[identity]) if popularity else None,
            'catalog_ref':str(row['catalog_ref']) if row['catalog_ref'] else None}
    usual = usual_genres({str(i):parents[i] for i in seeds}) if profile else None
    digest = hashlib.sha256(json.dumps({str(i):[sorted(tags[i][0] or ()),tags[i][1]] for i in sorted(tags)},
        sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return facts, usual or frozenset(), {'version':RULES_VERSION, 'genre_source':'current_library_file_tags',
        'genre_digest':digest, 'known_genre_albums':sum(bool(f['genres']) for f in facts.values()),
        'known_popularity_albums':sum(f['popularity'] is not None for f in facts.values()),
        'popularity_source':'median_cached_track_scrobbles_proxy', 'popularity_version':POPULARITY_VERSION,
        'taste_version':TASTE_VERSION,
        'taste_state':'inferred' if usual else 'unknown', 'taste_window_days':TASTE_DAYS}


def enrich_sources(connection, live, constraints, sources, *, now, profile=True, popularity=True):
    facts, usual, evidence = load_evidence(connection, live, constraints, now=now,
        profile=profile, popularity=popularity)
    canonical = {}
    for fact in facts.values():
        if fact['catalog_ref']:
            canonical.setdefault(fact['catalog_ref'], []).append(fact)
    def enrich(album):
        values = [facts[album.inventory_album_id]] if album.inventory_album_id in facts else canonical.get(album.catalog_ref, [])
        genres = tuple(sorted({g for f in values for g in f['genres']}))
        counts = [f['popularity'] for f in values if f['popularity'] is not None]
        return replace(album, genres=genres, popularity=median(counts) if counts else None)
    enriched = tuple(replace(s, albums=tuple(enrich(a) for a in s.albums)) for s in sources)
    candidates = {a.candidate_ref:a for s in enriched for a in s.albums}
    evidence = {**evidence, 'known_genre_albums':sum(bool(a.genres) for a in candidates.values()),
        'known_popularity_albums':sum(a.popularity is not None for a in candidates.values())}
    return enriched, usual, evidence
