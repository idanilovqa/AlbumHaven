"""Current-subject Search over canonical, authorized PostgreSQL witnesses.

No browse cache, file-backed fallback, source persistence, or media projection.
Every continuation resolves its safe identity under current inventory/policy.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hmac
import json

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from music_app.services.library_browse_postgres import (
    _eligible_album_tracks_cte_sql, _visible_album_clause,
    _canonical_artist_name, _root_browse_alias_to_canonical, _coerce_duration_seconds,
    load_current_library_relation_alias_maps,
)
from music_app.services.policy import ResourceScope
from music_app.services.library_inventory_postgres import local_inventory_identity_key
from music_app.services.postgres_connections import pooled_connection
from music_app.services.private_library_authority import (
    current_library_transaction, require_private_action, PrivateLibraryAuthorityError,
)
from music_app.services.track_preferences_postgres import canonical_candidate_selection_ctes
from music_app.services.view_search import PrivateSearchError
from music_app.services.social_cursors import (
    encode_search_cursor, decode_search_cursor, search_order_digest, SearchCursorScopeError,
)

BROWSE = 'library.browse.read'
MAX_WITNESSES = 100
SIDEBAR_LIMIT = 50
_EMPTY_POSITION = {'anchor': None, 'pending': None}
_ORDER = {
    'sidebar': ('artist_name', 'artist_id'),
    'albums': ('artist_name', 'album_release_year', 'album_title', 'album_key', 'album_id'),
    'tracks': ('artist_name', 'album_release_year', 'album_title', 'album_key', 'album_id', 'track_id'),
    'detail': ('disc_number', 'track_number', 'title', 'track_id'),
    'witness': ('track_id',),
}
_NULLABLE = {'album_release_year', 'disc_number', 'track_number'}
_ID = {'sidebar': 'artist_id', 'albums': 'album_id', 'tracks': 'track_id', 'detail': 'track_id', 'witness': 'track_id'}


def _order_sql(kind):
    return ', '.join(name + (' nulls last' if name in _NULLABLE else '') for name in _ORDER[kind])


def _after_sql(kind, row, params, *, prefix='after'):
    """Native PostgreSQL lexicographic comparison, including NULLS LAST."""
    if row is None:
        return 'true'
    equal, alternatives = [], []
    for index, name in enumerate(_ORDER[kind]):
        key = f'{prefix}_{index}'
        params[key] = row[name]
        if row[name] is not None:
            greater = f'{name} > %({key})s'
            if name in _NULLABLE:
                greater = f'({greater} or {name} is null)'
            alternatives.append('(' + ' and '.join([*equal, greater]) + ')')
        equal.append(f'{name} is not distinct from %({key})s')
    return '(' + ' or '.join(alternatives) + ')' if alternatives else 'false'


def _inventory_ctes(*, detail=False, detail_window="true", detail_order="track_id", inventory_filter="true"):
    # The eligibility owner uses this historical CTE name, but its value here
    # is exclusively the live authorized library, never a bootstrap lookup.
    seed = '' if detail else """and (%(include_off)s or exists (
        select 1 from app.track_preferences seed
        where seed.account_id=%(account_id)s and seed.library_id=t.library_id
          and seed.love_tier=any(%(tiers)s::text[])
          and (seed.track_key=t.track_key or exists (
            select 1 from library.local_track_files sf where sf.track_id=t.id
              and sf.scan_cache_stale is false and sf.private_path=seed.track_key))))"""
    detail_filter = 'and a.id=%(detail_album_id)s' if detail else ''
    inventory_name = 'detail_inventory' if detail else 'search_candidates'
    detail_page = (f', search_inventory as (select * from detail_inventory where {detail_window} '
                   f'order by {detail_order} limit %(candidate_limit)s)' if detail else
                   f', search_inventory as (select * from search_candidates where {inventory_filter})')
    return f"""with bootstrap_context as (select %(library_id)s::bigint as library_id),
        {_eligible_album_tracks_cte_sql(materialized=False, require_active_roots=True)},
        artist_projection as (
          select ar.id as source_artist_id, ar.name as source_artist_name, ar.sort_name,
            coalesce(%(primary_artist_aliases)s::jsonb->>ar.name, ar.name) as artist_name,
            case when %(primary_artist_groups)s::jsonb ? ar.name
              then 'canonical:' || (%(primary_artist_groups)s::jsonb->>ar.name)
              else 'inventory:' || ar.id::text end as artist_identity
          from library.local_artists ar where ar.library_id=%(library_id)s
        ),
        artist_membership as (
          select *, min(source_artist_id) over (partition by artist_identity) as artist_id
          from artist_projection
        ),
        {inventory_name} as (
          select distinct t.id as track_id, t.track_key, t.title, t.duration_seconds,
            t.disc_number, t.track_number, a.id as album_id, a.album_key,
            a.title as album_title, a.release_year as album_release_year,
            coalesce(a.metadata->>'edition','') as edition,
            coalesce(ar.artist_id, owner_artist.artist_id) as artist_id,
            coalesce(ar.artist_name, owner_artist.artist_name) as artist_name,
            coalesce(ar.source_artist_id, owner_artist.source_artist_id) as source_artist_id
          from eligible_album_tracks e
          join library.local_tracks t on t.id=e.track_id and t.library_id=%(library_id)s
          join library.local_albums a on a.id=t.album_id and a.library_id=t.library_id
          left join artist_membership ar on ar.source_artist_id=a.artist_id
          left join lateral (
            select credited.* from library.local_album_featured_artists f
            join artist_membership credited on credited.source_artist_id=f.artist_id
            where f.library_id=a.library_id and f.album_id=a.id and f.featured_kind='owner'
            order by credited.sort_name, credited.source_artist_name, credited.source_artist_id limit 1
          ) owner_artist on ar.source_artist_id is null
          where ({_visible_album_clause('a')})
            and coalesce(ar.artist_id,owner_artist.artist_id) is not null
            and exists (select 1 from library.local_track_files f
              join library.library_roots r on r.id=f.library_root_id and r.library_id=t.library_id
              where f.track_id=t.id and f.scan_cache_stale is false and r.is_active is true)
            {seed} {detail_filter}
        ){detail_page},
        {canonical_candidate_selection_ctes('search_inventory').strip().removeprefix('with ')},
        search_facts as (
          select i.*, coalesce(s.selection_status, 'missing') as selection_status, s.love_tier
          from search_inventory i left join selection s on s.track_ref=i.track_key and s.track_id=i.track_id
        ),
        witnesses as (
          select * from search_facts where selection_status='ok' and love_tier=any(%(tiers)s::text[])
        )
    """


class _Read:
    """One guarded request: one shared witness budget and no hidden refill."""
    def __init__(self, connection, live, request, constraints, secret):
        self.connection, self.live, self.request = connection, live, request
        self.constraints, self.secret = constraints, secret
        relations = load_current_library_relation_alias_maps(connection, live.library_id)
        aliases = relations['alias_to_canonical']
        canonical_aliases = relations['canonical_to_aliases']
        # A missing projection with no aliases uses real native inventory names.
        # Never trust a populated stale alias map or rebuild an entire library
        # inside this bounded private read.
        if relations['projection_stale_reason'] and (aliases or canonical_aliases):
            raise PrivateSearchError('private_search_unavailable', 503)
        # Preserve the native RAW alias evidence. The existing expanded-name
        # list deduplicates normalized spellings for key-based callers; feeding
        # that display list to exact-name SQL would lose case/whitespace members.
        self.primary_aliases = _root_browse_alias_to_canonical(aliases)
        for canonical in canonical_aliases:
            self.primary_aliases.setdefault(canonical, canonical)
        merged_canonicals = {canonical for raw, canonical in self.primary_aliases.items()
                             if raw != canonical}
        for canonical in merged_canonicals:
            self.primary_aliases.setdefault(canonical, canonical)
        # Self-mappings still normalize requests/display, but do not turn equal
        # labels alone into evidence that distinct physical IDs are one Artist.
        primary_groups = {raw: canonical for raw, canonical in self.primary_aliases.items()
                          if canonical in merged_canonicals}
        self.merged_artist_names = set(primary_groups.values())
        self.params = {'account_id': live.actor.account_id, 'library_id': live.library_id,
            'tiers': list(request.criteria.tiers()), 'include_off': 'off' in request.criteria.tiers(),
            'visible_categories': list(request.categories), 'category_count': len(request.categories),
            'primary_artist_aliases': json.dumps(self.primary_aliases),
            'primary_artist_groups': json.dumps(primary_groups)}
        self.ctes = _inventory_ctes(detail=request.presentation == 'album_detail')
        self.decisions, self.qualified_albums, self.qualified_artists = {}, {}, {}
        self.examined = set()
        self.hydrated_tracks = 0
        self.track_cache = {}
        self.outer_hydrated = {'sidebar': 0, 'albums': 0}

    def allows(self, kind, identifier):
        key = (kind, identifier)
        if key not in self.decisions:
            try:
                require_private_action(self.live, BROWSE,
                    resource=ResourceScope(kind, str(identifier)), constraints=self.constraints)
                self.decisions[key] = True
            except PrivateLibraryAuthorityError:
                self.decisions[key] = False
        return self.decisions[key]

    def readable(self, row, *, consume=True):
        identifier = row['track_id']
        if consume and identifier not in self.examined:
            if len(self.examined) >= MAX_WITNESSES:
                return None
            self.examined.add(identifier)
        # A track cannot reveal its parent album or artist through projection.
        allowed = (self.allows('track', identifier) and self.allows('album', row['album_id'])
                   and self.allows('artist', row['source_artist_id']))
        if allowed and row.get('selection_status') == 'ok' and row.get('love_tier') in self.params['tiers']:
            self.qualified_albums[row['album_id']] = row
            self.qualified_artists[row['artist_id']] = row
        return allowed

    def identity(self, row, kind, *, readable=True):
        order_kind = "tracks" if kind == "witness" else kind
        return {'id': row[_ID[kind]], 'readable': readable, 'digest': search_order_digest(
            [kind, *[row[key] for key in _ORDER[order_kind]]], secret=self.secret)}

    def scope(self, kind):
        r, actor = self.request, self.live.actor
        return ['own-love-v1', actor.account_id, actor.session_id, self.live.library_id,
            r.criteria.as_payload(), r.presentation, r.all_artists, r.visibility_scope(), r.detail_album_ref]

    def decode(self, token, kind):
        try:
            cursor = decode_search_cursor(token, secret=self.secret)
        except SearchCursorScopeError:
            raise PrivateSearchError('search_cursor_restart_required', 409) from None
        except ValueError:
            raise PrivateSearchError() from None
        if cursor is None:
            return None
        current, previous = self.scope(kind), cursor['scope']
        if previous != current:
            # Only a recognized actor/session/library partition establishes
            # failed context continuity. Query/kind/visibility/selection and
            # unknown cursor dialects require restart without retiring context.
            if len(previous) >= 4 and previous[0] == current[0] and previous[1:4] != current[1:4]:
                raise PrivateSearchError('stale_context', 409)
            raise PrivateSearchError('search_cursor_restart_required', 409)
        if cursor['kind'] != kind:
            raise PrivateSearchError('search_cursor_restart_required', 409)
        return cursor

    def cursor(self, position, kind, selection):
        return encode_search_cursor(position, secret=self.secret, scope=self.scope(kind), kind=kind, selection=selection)

    def rows(self, kind, *, after=None, identifier=None, artist=None, album=None, limit=101, omit_examined=False):
        params = dict(self.params)
        track_kind = kind in {'tracks', 'detail', 'witness'}
        if track_kind and identifier in self.track_cache and after is None:
            cached = self.track_cache[identifier]
            if cached is None:
                return []
            if (artist is None or cached['artist_id'] == artist) and (album is None or cached['album_id'] == album):
                return [cached]
            return []
        if track_kind:
            limit = min(limit, MAX_WITNESSES + 1 - self.hydrated_tracks)
            if limit < 1:
                raise RuntimeError('Private Search candidate budget exhausted before a reserved identity read.')
        relation = 'search_facts' if kind == 'detail' else 'witnesses'
        fields = {'sidebar': 'distinct artist_id, artist_name',
                  'albums': 'distinct artist_id, artist_name, album_id, album_title, album_release_year, album_key, edition'}
        conditions = []
        if identifier is not None:
            params['identity'] = identifier
            conditions.append(f'{_ID[kind]}=%(identity)s')
        if artist is not None:
            params['selected_artist_id'] = artist
            conditions.append('artist_id=%(selected_artist_id)s')
        if album is not None:
            params['selected_album_id'] = album
            conditions.append('album_id=%(selected_album_id)s')
        if omit_examined and self.examined:
            # Requalification need not fetch a denied hint a second time.
            # Every excluded identity was already examined in this transaction;
            # a readable one has already qualified its containing outer rows.
            params['examined_track_ids'] = list(self.examined)
            conditions.append('not (track_id=any(%(examined_track_ids)s::bigint[]))')
        conditions.append(_after_sql(kind, after, params))
        params['candidate_limit'] = limit
        ctes = _inventory_ctes(detail=kind == 'detail', detail_window=' and '.join(conditions),
            detail_order=_order_sql(kind), inventory_filter=' and '.join(conditions))
        sql = ctes + f"select {fields.get(kind, '*')} from {relation} where " + ' and '.join(conditions)
        sql += f' order by {_order_sql(kind)} limit %(candidate_limit)s'
        rows = self.connection.execute(sql, params).fetchall()
        if track_kind:
            self.hydrated_tracks += len(rows)
            self.track_cache.update((row['track_id'], row) for row in rows)
            if identifier is not None and not rows and artist is None and album is None:
                self.track_cache[identifier] = None
        elif kind in self.outer_hydrated:
            self.outer_hydrated[kind] += len(rows)
        return rows

    def prime_cursor_tracks(self, cursors):
        """Reserve identity re-resolution before sidebar can consume the budget.

        Reused rows stay inside this guarded transaction; their digest, scope,
        and current resource decision are still checked at their actual use.
        """
        for cursor in cursors:
            if cursor is None:
                continue
            position = cursor['position']
            identities = []
            if position.get('anchor_witness'):
                identities.append(position['anchor_witness'])
            if cursor['kind'] in {'tracks', 'detail'} and position['anchor']:
                identities.append(position['anchor'])
            if position['pending'] and position['pending']['witness']:
                identities.append(position['pending']['witness'])
            selection = cursor['selection']
            if selection['witness']:
                identities.append(selection['witness'])
            if selection['pending'] and selection['pending']['pending']:
                witness = selection['pending']['pending']['witness']
                if witness:
                    identities.append(witness)
            for identity in identities:
                self.rows('detail' if cursor['kind'] == 'detail' else 'witness',
                          identifier=identity['id'], limit=1)

    def resolve(self, identity, kind, *, artist=None, album=None, readable=True):
        if identity is None:
            return None
        rows = self.rows(kind, identifier=identity['id'], artist=artist, album=album, limit=1)
        if not rows or not hmac.compare_digest(self.identity(rows[0], kind)['digest'], identity['digest']):
            raise PrivateSearchError('search_cursor_restart_required', 409)
        row = rows[0]
        if not identity['readable']:
            readable = False
        if kind in {'tracks', 'detail', 'witness'}:
            permitted = self.readable(row) if readable else True
        else:
            permitted = self.allows('artist' if kind == 'sidebar' else 'album', row[_ID[kind]]) if readable else True
        if not permitted:
            raise PrivateSearchError('search_cursor_restart_required', 409)
        return row

    def qualify(self, row, kind, witness=None):
        """Prove one outer member while charging every actual hydrated row.

        Read one witness at a time: early success cannot prefetch and discard a
        large window for every Artist/Album. The final shared extra row is a
        lookahead only and never receives a resource decision.
        """
        identifier = row[_ID[kind]]
        known = self.qualified_artists if kind == 'sidebar' else self.qualified_albums
        if identifier in known:
            return True, None
        if kind == 'albums' and not self.allows('album', identifier):
            return False, None
        if (kind == 'sidebar' and row['artist_name'] not in self.merged_artist_names
                and not self.allows('artist', identifier)):
            # Without native merge evidence this identity is exactly one raw
            # Artist. Its denial is conclusive. A merged representative's
            # denial alone cannot stand in for every actual alias member.
            return False, None
        artist, album = (identifier, None) if kind == 'sidebar' else (None, identifier)
        after = self.resolve(witness, 'witness', artist=artist, album=album, readable=False)
        examined_anchor = witness
        while self.hydrated_tracks < MAX_WITNESSES + 1:
            rows = self.rows('witness', after=after, artist=artist, album=album, limit=1, omit_examined=True)
            if not rows:
                return False, None
            candidate = rows[0]
            # Charge hydrated duplicates too, so both libpq buffering and Python
            # fetches remain bounded across sidebar/results/anchor resolution.
            if self.hydrated_tracks > MAX_WITNESSES or len(self.examined) >= MAX_WITNESSES:
                return None, examined_anchor
            allowed = self.readable(candidate)
            if allowed is None:
                return None, examined_anchor
            examined_anchor = self.identity(candidate, 'witness')
            after = candidate
            if allowed:
                return True, None
        return None, examined_anchor

    def qualify_hint(self, row, kind, identity):
        """A prior witness is a lookup hint, never a cached permission grant."""
        if identity is None:
            return False
        artist, album = (row['artist_id'], None) if kind == 'sidebar' else (None, row['album_id'])
        found = self.rows('witness', identifier=identity['id'], artist=artist, album=album, limit=1)
        if not found or not hmac.compare_digest(self.identity(found[0], 'witness')['digest'], identity['digest']):
            return False
        return self.readable(found[0])

    def outer_position(self, kind, anchor, pending=None):
        position = {'anchor': anchor, 'pending': pending}
        known = self.qualified_artists if kind == 'sidebar' else self.qualified_albums
        if anchor is not None and anchor['readable'] and anchor['id'] in known:
            position['anchor_witness'] = self.identity(known[anchor['id']], 'witness')
        return position

    def candidate_page(self, kind, *, position=None, artist=None, limit=50):
        position = position or _EMPTY_POSITION
        # Resolve the full native outer order before using any witness hint.
        anchor = self.resolve(position['anchor'], kind, artist=artist, readable=False)
        pending = position['pending']
        revalidating = bool(anchor is not None and pending is not None
            and pending['candidate']['id'] == position['anchor']['id'])
        if anchor is not None and position['anchor']['readable']:
            self.qualify_hint(anchor, kind, position.get('anchor_witness'))
            witness = pending['witness'] if revalidating else None
            qualifies, witness = self.qualify(anchor, kind, witness)
            if qualifies is False:
                raise PrivateSearchError('search_cursor_restart_required', 409)
            if qualifies is None:
                # The failed/denied old hint is deliberately dropped. Persist
                # only conclusively examined fallback progress, not authority.
                return [], self.outer_position(kind, position['anchor'], {
                    'candidate': position['anchor'], 'witness': witness})
        if revalidating:
            pending = None
        # Selected-scope recovery may already have resolved one Artist row.
        # That real outer row is part of this request, not a hidden allowance.
        ceiling = (SIDEBAR_LIMIT if kind == 'sidebar' else self.request.limit) + 2
        window = min(limit, ceiling - self.outer_hydrated[kind] - 1)
        if window < 1:
            return [], self.outer_position(kind, position['anchor'], pending)
        rows = self.rows(kind, after=anchor, artist=artist, limit=window + 1)
        if pending:
            identity = pending['candidate']
            if (not rows or rows[0][_ID[kind]] != identity['id']
                    or not hmac.compare_digest(self.identity(rows[0], kind)['digest'], identity['digest'])):
                raise PrivateSearchError('search_cursor_restart_required', 409)
        visible, next_position = [], None
        current_anchor = position['anchor']
        for index, row in enumerate(rows[:window]):
            witness = pending['witness'] if index == 0 and pending else None
            qualifies, witness = self.qualify(row, kind, witness)
            if qualifies is None:
                next_position = self.outer_position(kind, current_anchor,
                    {'candidate': self.identity(row, kind), 'witness': witness})
                break
            current_anchor = self.identity(row, kind, readable=qualifies)
            if qualifies:
                visible.append(row)
        else:
            if len(rows) > window:
                next_position = self.outer_position(kind, current_anchor)
        return visible, next_position

    def track_page(self, kind, *, position=None, artist=None, album=None, limit=50):
        position = position or _EMPTY_POSITION
        if position['pending'] is not None:
            raise PrivateSearchError()
        anchor = self.resolve(position['anchor'], kind, artist=artist, album=album)
        remaining = min(MAX_WITNESSES - self.hydrated_tracks, MAX_WITNESSES - len(self.examined))
        if remaining <= 0:
            return [], dict(position)
        window = min(limit, remaining)
        rows = self.rows(kind, after=anchor, artist=artist, album=album, limit=window + 1)
        visible, current_anchor = [], position['anchor']
        for row in rows[:window]:
            allowed = self.readable(row)
            if allowed is None:
                return visible, {'anchor': current_anchor, 'pending': None}
            current_anchor = self.identity(row, kind, readable=allowed)
            if allowed:
                visible.append(row)
        return visible, ({'anchor': current_anchor, 'pending': None} if len(rows) > window else None)

    def canonical_requested_artist(self, artist):
        return _canonical_artist_name(artist, self.primary_aliases)

    def matching_artist_rows(self, artist):
        canonical = self.canonical_requested_artist(artist)
        params = {**self.params, 'artist_name': canonical}
        rows = self.connection.execute(self.ctes + '''select distinct artist_id, artist_name from witnesses
            where artist_name=%(artist_name)s or lower(artist_name)=lower(%(artist_name)s)
            order by artist_name, artist_id limit 2''', params).fetchall()
        self.outer_hydrated['sidebar'] += len(rows)
        return rows

    def explicit_artist(self, artist):
        rows = self.matching_artist_rows(artist)
        if len(rows) != 1:
            raise PrivateSearchError('search_selection_unavailable', 409)
        qualifies, witness = self.qualify(rows[0], 'sidebar')
        if qualifies is False:
            raise PrivateSearchError('search_selection_unavailable', 409)
        return rows[0], qualifies, witness

    def selected_from_cursor(self, selection):
        if selection['state'] != 'selected':
            if selection['artist'] is not None and self.request.artist is not None:
                pending = self.resolve(selection['artist'], 'sidebar', readable=False)
                if local_inventory_identity_key(self.canonical_requested_artist(self.request.artist)) != local_inventory_identity_key(pending['artist_name']):
                    raise PrivateSearchError('search_cursor_restart_required', 409)
            return None, selection
        # A sealed witness can disappear without making its entire Artist
        # unavailable. Retain the Artist; re-prove its scope within the budget.
        identity = selection['artist']
        witnesses = self.rows('witness', identifier=selection['witness']['id'], artist=identity['id'], limit=1)
        artists = witnesses or self.rows('sidebar', identifier=identity['id'], limit=1)
        if not artists:
            raise PrivateSearchError('search_selection_unavailable', 409)
        row = artists[0]
        same_identity = hmac.compare_digest(self.identity(row, 'sidebar')['digest'], identity['digest'])
        if self.request.artist is not None and local_inventory_identity_key(self.canonical_requested_artist(self.request.artist)) != local_inventory_identity_key(row['artist_name']):
            # A changed request is a cursor restart. If the sealed native
            # identity itself changed and its explicit old name no longer
            # resolves, the selected scope is unavailable instead.
            if not same_identity and not self.matching_artist_rows(self.request.artist):
                raise PrivateSearchError('search_selection_unavailable', 409)
            raise PrivateSearchError('search_cursor_restart_required', 409)
        if not same_identity:
            raise PrivateSearchError('search_cursor_restart_required', 409)
        self.qualify_hint(row, 'sidebar', selection['witness'])
        pending = selection['pending']
        after = pending['pending']['witness'] if pending else None
        qualifies, after = self.qualify(row, 'sidebar', after)
        if qualifies is False:
            raise PrivateSearchError('search_selection_unavailable', 409)
        if qualifies is None:
            return row, {**selection, 'pending': {'anchor': None, 'pending': {
                'candidate': identity, 'witness': after}}}
        return row, {**selection, 'pending': None,
            'witness': self.identity(self.qualified_artists[row['artist_id']], 'witness')}

    def album_dto(self, row):
        return {'album_ref': f"inventory-album:{self.live.library_id}:{row['album_id']}",
            'name': row['album_title'], 'year': _nullable_int(row['album_release_year']),
            'edition': row['edition'], 'allowed_actions': {'can_read': True, 'can_view_details': True},
            'matches_search': True}

    def track_dto(self, row, *, detail=False):
        value = {'inventory_track_ref': f"inventory-track:{self.live.library_id}:{row['track_id']}",
            'canonical_track_ref': None, 'title': row['title'], 'artist': row['artist_name'],
            'album': row['album_title'], 'duration_seconds': (None if row['duration_seconds'] is None
                else _coerce_duration_seconds(row['duration_seconds'])),
            'disc_number': _nullable_int(row['disc_number']), 'track_number': _nullable_int(row['track_number']),
            'parent_album': {'album_ref': f"inventory-album:{self.live.library_id}:{row['album_id']}",
                'name': row['album_title'], 'year': _nullable_int(row['album_release_year']),
                'allowed_actions': {'can_read': True, 'can_view_details': True}},
            'allowed_actions': {'can_read': True, 'can_select': True}}
        if detail:
            known = row['selection_status'] == 'ok'
            value.update(matches_search=known and row['love_tier'] in self.params['tiers'],
                         match_state='known' if known else 'unavailable')
        return value


def _nullable_int(value):
    return value if type(value) is int else None


def _page(limit, rows, cursor):
    return {'limit': limit, 'returned_count': len(rows), 'has_more': cursor is not None, 'next_cursor': cursor}


class PostgresPrivateSearchService:
    def __init__(self, config, *, connect=None, clock=None):
        self._url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    @contextmanager
    def _authorized(self, context, constraints):
        try:
            if not self._url:
                raise PrivateSearchError('private_search_unavailable', 503)
            with current_library_transaction(self._url, context, constraints=constraints,
                    connect=self._connect, clock=self._clock, read_only=True) as transaction:
                yield transaction
                connection, live, _ = transaction
                lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                    actor_session_id=live.actor.session_id, clock=self._clock)
                require_private_action(live, BROWSE, constraints=constraints)
        except (PrivateLibraryAuthorityError, RecentAuthenticationRequired):
            raise PrivateSearchError('private_search_forbidden', 403) from None

    @staticmethod
    def _envelope(request, context_ref):
        return {'status': 'ready', 'private_search': True, 'contract_version': 'own-love-v1',
            'context_ref': context_ref, 'query': request.query, 'criteria': request.criteria.as_payload(),
            'presentation': request.presentation}

    @staticmethod
    def _same_selection_scope(left, right):
        if left['state'] == right['state'] == 'selected':
            return left['artist'] == right['artist']
        return left == right

    def _pending_selection(self, read, request, context_ref, selected, selection,
                           *, result_cursor=None, sidebar_cursor=None):
        """Indeterminate current proof is explicit progress, not a ready view."""
        payload = {**self._envelope(request, context_ref), 'status': 'pending', 'selection_pending': True,
            'selected_artist': selected['artist_name'], 'selection_state': 'selected'}
        sidebar_position = sidebar_cursor['position'] if sidebar_cursor else dict(_EMPTY_POSITION)
        sidebar_next = read.cursor(sidebar_position, 'sidebar', selection)
        payload['sidebar'] = None if request.omit_sidebar else {
            'artists': [], 'returned_count': 0, 'has_more': True, 'next_cursor': sidebar_next}
        if request.sidebar_only:
            return {**payload, 'sidebar_only': True}
        result_position = result_cursor['position'] if result_cursor else dict(_EMPTY_POSITION)
        result_next = read.cursor(result_position, request.presentation, selection)
        return {**payload, 'artist_groups': [], 'tracks': [], 'page': _page(request.limit, [], result_next)}

    def read(self, context, *, request, context_ref, cursor_secret, constraints=None):
        if request.sidebar_only:
            return self.read_sidebar_page(context, request=request, context_ref=context_ref,
                cursor_secret=cursor_secret, constraints=constraints)
        if request.detail_album_ref:
            return self.read_album_detail_page(context, request=request, context_ref=context_ref,
                cursor_secret=cursor_secret, constraints=constraints)
        with self._authorized(context, constraints) as (connection, live, _):
            read = _Read(connection, live, request, constraints, cursor_secret)
            kind = request.presentation
            result_cursor = read.decode(request.cursor, kind)
            sidebar_cursor = read.decode(request.sidebar_cursor, 'sidebar')
            read.prime_cursor_tracks((result_cursor, sidebar_cursor))
            cursor = sidebar_cursor or result_cursor
            if result_cursor and sidebar_cursor and not self._same_selection_scope(result_cursor['selection'], sidebar_cursor['selection']):
                raise PrivateSearchError('search_cursor_restart_required', 409)
            selection = cursor['selection'] if cursor else {'state': 'all_artists' if request.all_artists else 'pending_page', 'artist': None, 'witness': None, 'pending': None}
            if cursor and (selection['state'] == 'all_artists') != request.all_artists:
                raise PrivateSearchError('search_cursor_restart_required', 409)
            selected, selection = read.selected_from_cursor(selection)
            if selection['state'] == 'selected' and selection['pending'] is not None:
                return self._pending_selection(read, request, context_ref, selected, selection,
                    result_cursor=result_cursor, sidebar_cursor=sidebar_cursor)
            explicit_pending = None
            if selected is None and request.artist is not None and not (cursor and selection['artist'] is not None):
                if cursor:
                    raise PrivateSearchError('search_cursor_restart_required', 409)
                selected, qualified, witness = read.explicit_artist(request.artist)
                if qualified is None:
                    explicit_pending = {'anchor': None, 'pending': {
                        'candidate': read.identity(selected, 'sidebar'), 'witness': witness}}
                    selection = {'state': 'pending_page', 'artist': read.identity(selected, 'sidebar'), 'witness': None, 'pending': None}
                    selected = None
                else:
                    selection = {'state': 'selected', 'artist': read.identity(selected, 'sidebar'),
                                 'witness': read.identity(read.qualified_artists[selected['artist_id']], 'witness'), 'pending': None}
            def result_page(selected_artist):
                artist_id = selected_artist['artist_id'] if selected_artist else None
                reader = read.candidate_page if kind == 'albums' else read.track_page
                return reader(kind, artist=artist_id,
                    position=result_cursor['position'] if result_cursor else None, limit=request.limit)

            # An explicit sidebar continuation gets first claim on the shared
            # budget; otherwise a followed result cursor does. Replaying a
            # fresh sidebar must not starve result progress, and replaying a
            # current result page must not starve the requested sidebar page.
            # Initial/pending autoselection still belongs to the sidebar owner.
            results_first = (result_cursor is not None and sidebar_cursor is None
                             and selection['state'] in {'selected', 'all_artists'})
            rows, next_position = result_page(selected) if results_first else ([], None)
            sidebar_rows, sidebar_next = [], None
            # Autoselection uses the same bounded sidebar owner even when its
            # projection was omitted; it is never an ordinary best-artist read.
            if explicit_pending:
                sidebar_next = explicit_pending
            elif not request.omit_sidebar or selection['state'] == 'pending_page':
                sidebar_rows, sidebar_next = read.candidate_page('sidebar',
                    position=sidebar_cursor['position'] if sidebar_cursor else selection.get('pending'), limit=SIDEBAR_LIMIT,
                    artist=selection['artist']['id'] if selection['state'] == 'pending_page' and selection['artist'] else None)
            if selection['state'] == 'pending_page':
                if sidebar_rows:
                    selected = sidebar_rows[0]
                    selection = {'state': 'selected', 'artist': read.identity(selected, 'sidebar'),
                                 'witness': read.identity(read.qualified_artists[selected['artist_id']], 'witness'), 'pending': None}
                elif sidebar_next is None:
                    if selection['artist'] is not None:
                        raise PrivateSearchError('search_selection_unavailable', 409)
                    selection = {'state': 'empty', 'artist': None, 'witness': None, 'pending': None}
            if selection['state'] == 'pending_page':
                selection = {**selection, 'pending': sidebar_next}
            if not results_first and selection['state'] in {'selected', 'all_artists'}:
                rows, next_position = result_page(selected)
            if request.omit_sidebar and selection['state'] == 'pending_page' and sidebar_next is not None:
                next_position = dict(_EMPTY_POSITION)
            encoded_result = read.cursor(next_position, kind, selection) if next_position is not None else None
            encoded_sidebar = read.cursor(sidebar_next, 'sidebar', selection) if sidebar_next is not None else None
            groups, tracks = [], []
            if kind == 'albums':
                for row in rows:
                    if not groups or groups[-1]['artist'] != row['artist_name']:
                        groups.append({'artist': row['artist_name'], 'artist_display': row['artist_name'], 'albums': []})
                    groups[-1]['albums'].append(read.album_dto(row))
            else:
                tracks = [read.track_dto(row) for row in rows]
            return {**self._envelope(request, context_ref), 'selected_artist': selected['artist_name'] if selected else None,
                'selection_state': selection['state'], 'artist_groups': groups, 'tracks': tracks,
                'page': _page(request.limit, rows, encoded_result),
                'sidebar': None if request.omit_sidebar else {
                    'artists': [{'artist': row['artist_name'], 'artist_display': row['artist_name']} for row in sidebar_rows],
                    'returned_count': len(sidebar_rows), 'has_more': encoded_sidebar is not None, 'next_cursor': encoded_sidebar}}

    def read_sidebar_page(self, context, *, request, context_ref, cursor_secret, constraints=None):
        """A bounded child read; no main result or detail selector is invoked."""
        with self._authorized(context, constraints) as (connection, live, _):
            read = _Read(connection, live, request, constraints, cursor_secret)
            cursor = read.decode(request.sidebar_cursor, 'sidebar')
            if cursor is None or cursor['selection']['state'] not in {'selected', 'all_artists'}:
                raise PrivateSearchError()
            selection = cursor['selection']
            if (selection['state'] == 'all_artists') != request.all_artists:
                raise PrivateSearchError('search_cursor_restart_required', 409)
            read.prime_cursor_tracks((cursor,))
            selected, selection = read.selected_from_cursor(selection)
            if selection['pending'] is not None:
                return self._pending_selection(read, request, context_ref, selected, selection, sidebar_cursor=cursor)
            rows, next_position = read.candidate_page('sidebar', position=cursor['position'], limit=SIDEBAR_LIMIT)
            next_cursor = read.cursor(next_position, 'sidebar', selection) if next_position is not None else None
            return {**self._envelope(request, context_ref), 'sidebar_only': True,
                'selected_artist': selected['artist_name'] if selected else None,
                'selection_state': selection['state'], 'sidebar': {
                    'artists': [{'artist': row['artist_name'], 'artist_display': row['artist_name']} for row in rows],
                    'returned_count': len(rows), 'has_more': next_cursor is not None, 'next_cursor': next_cursor}}

    def read_album_detail_page(self, context, *, request, context_ref, cursor_secret, constraints=None):
        with self._authorized(context, constraints) as (connection, live, _):
            _, library_id, album_id = request.detail_album_ref.split(':')
            if int(library_id) != live.library_id or int(album_id) > 9223372036854775807:
                raise PrivateSearchError('private_search_forbidden', 403)
            read = _Read(connection, live, request, constraints, cursor_secret)
            read.params['detail_album_id'] = int(album_id)
            # Authorize before any metadata or cursor position is resolved.
            if not read.allows('album', int(album_id)):
                raise PrivateSearchError('private_search_forbidden', 403)
            album = connection.execute('select id from library.local_albums where library_id=%s and id=%s limit 1',
                                       (live.library_id, int(album_id))).fetchone()
            if album is None:
                raise PrivateSearchError('private_search_forbidden', 403)
            cursor = read.decode(request.cursor, 'detail')
            rows, next_position = read.track_page('detail', album=int(album_id), limit=request.limit,
                position=cursor['position'] if cursor else None)
            selection = {'state': 'all_artists', 'artist': None, 'witness': None, 'pending': None}
            next_cursor = read.cursor(next_position, 'detail', selection) if next_position is not None else None
            return {**self._envelope(request, context_ref), 'album_ref': request.detail_album_ref,
                'tracks': [read.track_dto(row, detail=True) for row in rows],
                'page': _page(request.limit, rows, next_cursor)}
