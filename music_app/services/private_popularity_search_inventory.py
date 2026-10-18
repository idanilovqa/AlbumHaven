"""Identity-admitted, complete-frame, single-statement cached Search capture.

The caller owns the current-library transaction and settings-first native setup.
No source/job locks, refresh work, provider I/O, or ranking algorithm lives here.
"""
from dataclasses import dataclass
import json

from music_app.services import library_mix_inventory_postgres as mix
from music_app.services import playlist_creation_sources_postgres as sources
from music_app.services.library_browse_postgres import (
    _eligible_album_tracks_cte_sql, _visible_album_clause,
)
from music_app.services.library_mix_postgres import read_popularity_refresh_status
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import (
    require_private_action, PrivateLibraryAuthorityError,
)
from music_app.services.private_search_contract import PrivateSearchError
from music_app.services.view_search import (
    artist_alias_matches_query, normalize_search_text, search_terms_match_fields,
)


class CaptureChanged(Exception):
    """The caller must release this attempt's locks, never publish its facts."""


@dataclass(frozen=True)
class CapturedPopularity:
    universe: dict
    decision_map: dict
    facet_frame: dict
    matched_rows: dict
    tracks: tuple
    snapshots: dict
    diagnostics: tuple
    refresh_status: str
    missing_genre_local_rows: int
    facet_frame_text: str


_COORDINATES = """
 select t.id, t.library_id, t.album_id, t.artist_id, a.artist_id as album_artist_id,
        a.id is not null as album_exists, ar.id is not null as artist_exists,
        aa.id is not null as album_artist_exists
 from library.local_tracks t
 left join library.local_albums a on a.id=t.album_id and a.library_id=t.library_id
 left join library.local_artists ar on ar.id=t.artist_id and ar.library_id=t.library_id
 left join library.local_artists aa on aa.id=a.artist_id and aa.library_id=t.library_id
 where t.library_id=%(library_id)s
"""
_UNIVERSE_CTES = """
 current_coordinates as materialized (""" + _COORDINATES + """),
 current_artists as materialized (
   select id from library.local_artists where library_id=%(library_id)s
 )
"""

_ALIAS_PRIVATE_CTES = """
 alias_readiness as materialized (
   select library.relation_alias_endpoints_ready(%(library_id)s::bigint) is true as ready
 ),
 alias_header as materialized (
   select p.* from library.relation_alias_endpoint_publications p
   cross join alias_readiness r where r.ready and p.library_id=%(library_id)s
 ),
 alias_bindings as materialized (
   select e.publication_id,e.edge_id,v.side,v.side_order,v.endpoint_key,
          a.id as artist_id,a.artist_key as current_artist_key
   from alias_header h
   join library.relation_alias_endpoints e
     on e.library_id=h.library_id and e.publication_id=h.publication_id
   cross join lateral (values ('alias',0,e.alias_key),('canonical',1,e.canonical_key))
     v(side,side_order,endpoint_key)
   left join library.local_artists a
     on a.library_id=h.library_id and a.artist_key=v.endpoint_key
 ),
 alias_binding_frame as materialized (
   select count(*) as binding_count,
     coalesce(jsonb_agg(jsonb_build_array(publication_id,edge_id,side,endpoint_key,
           artist_id,current_artist_key) order by edge_id,side_order,artist_id),'[]'::jsonb) as private_frame,
     coalesce(jsonb_agg(jsonb_build_object('publication_id',publication_id,'edge_id',edge_id,
           'side',side,'artist_id',artist_id) order by edge_id,side_order,artist_id),'[]'::jsonb) as coordinates
   from alias_bindings
 ),
 alias_protocol as materialized (
   select (r.ready and b.binding_count<=1000000
           and octet_length(convert_to(b.private_frame::text,'UTF8'))<=67108864
           and octet_length(convert_to(b.coordinates::text,'UTF8'))<=67108864
           and not exists (select 1 from alias_bindings x where x.artist_id is not null
              and not exists(select 1 from current_artists u where u.id=x.artist_id))) as ready,
     b.coordinates,
     pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_array('alias-source-v1',%(library_id)s::bigint,
       h.source_snapshot,h.relation_metadata,h.relations_last_built)::text,'UTF8')),'hex') as source_proof,
     pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_array('alias-publication-v1',%(library_id)s::bigint,
       to_jsonb(h))::text,'UTF8')),'hex') as publication_proof,
     pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_array('alias-binding-v1',%(library_id)s::bigint,
       b.private_frame)::text,'UTF8')),'hex') as binding_proof
   from alias_readiness r cross join alias_binding_frame b left join alias_header h on true
 )
"""
_ALIAS_GATE_CTES = """,
 admission_gate as materialized (
   select u.ok and p.ready
      and p.coordinates=%(alias_coordinates)s::jsonb
      and p.source_proof=%(alias_source_proof)s::text
      and p.publication_proof=%(alias_publication_proof)s::text
      and p.binding_proof=%(alias_binding_proof)s::text as ok
   from universe_gate u cross join alias_protocol p
 )
"""

_UNIVERSE_SQL = "with " + _UNIVERSE_CTES + "," + _ALIAS_PRIVATE_CTES + """
 select jsonb_build_object(
   'tracks', coalesce((select jsonb_agg(to_jsonb(c) order by c.id)
                       from current_coordinates c), '[]'::jsonb),
   'artists', coalesce((select jsonb_agg(to_jsonb(a) order by a.id)
                        from current_artists a), '[]'::jsonb)) as universe,
   p.ready as alias_ready, case when p.ready then p.coordinates end as alias_coordinates,
   case when p.ready then p.source_proof end as alias_source_proof,
   case when p.ready then p.publication_proof end as alias_publication_proof,
   case when p.ready then p.binding_proof end as alias_binding_proof
 from alias_protocol p
"""
_GATE_CTES = _UNIVERSE_CTES + "," + _ALIAS_PRIVATE_CTES + """,
 expected_coordinates as materialized (
   select * from jsonb_to_recordset(%(universe)s::jsonb->'tracks') as expected(
     id bigint, library_id bigint, album_id bigint, artist_id bigint,
     album_artist_id bigint, album_exists boolean, artist_exists boolean,
     album_artist_exists boolean)
 ),
 expected_artists as materialized (
   select * from jsonb_to_recordset(%(universe)s::jsonb->'artists') as expected(id bigint)
 ),
 universe_gate as materialized (
   select not exists (
     (select * from current_coordinates except select * from expected_coordinates)
     union all
     (select * from expected_coordinates except select * from current_coordinates)
   ) and not exists (
     (select * from current_artists except select * from expected_artists)
     union all
     (select * from expected_artists except select * from current_artists)
   ) as ok
 )
""" + _ALIAS_GATE_CTES + """,
 admitted as materialized (
   select c.* from current_coordinates c cross join admission_gate g
   where g.ok and c.id=any(%(admitted_ids)s::bigint[])
 ),
 bootstrap_context as materialized (
   select %(library_id)s::bigint as library_id from admission_gate where ok
 )
"""


def _json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':'))


def _decisions(live, universe, constraints):
    resources = {('artist', a['id']) for a in universe['artists']}
    for row in universe['tracks']:
        resources.add(('track', row['id']))
        if row['album_exists']:
            resources.add(('album', row['album_id']))
    decisions = {}
    for kind, identifier in sorted(resources):
        try:
            require_private_action(live, 'library.browse.read',
                resource=ResourceScope(kind, str(identifier)), constraints=constraints)
            decisions[kind, identifier] = True
        except PrivateLibraryAuthorityError:
            decisions[kind, identifier] = False
    return decisions


def recheck_admission(live, universe, decision_map, *, constraints=None):
    """Recompute even denied resources: a newly allowed row changes the query."""
    if _decisions(live, universe, constraints) != decision_map:
        raise CaptureChanged()


def _admitted(universe, decisions):
    return [row for row in universe['tracks']
            if row['album_exists'] and row['artist_exists'] and row['album_artist_exists']
            and all(decisions.get(key) is True for key in (
                ('track', row['id']), ('album', row['album_id']),
                ('artist', row['artist_id']), ('artist', row['album_artist_id'])))]


def _lock_admitted(connection, library_id, rows):
    """Exact inventory lock prefix, returning identity coordinates only."""
    ids = sorted(row['id'] for row in rows)
    locked = connection.execute("""select id,library_id,album_id,artist_id
        from library.local_tracks where library_id=%s and id=any(%s::bigint[])
        order by id for update""", (library_id, ids)).fetchall()
    expected = [{key: row[key] for key in ('id', 'library_id', 'album_id', 'artist_id')}
                for row in rows]
    if [dict(row) for row in locked] != sorted(expected, key=lambda row: row['id']):
        raise CaptureChanged()
    albums = sorted({row['album_id'] for row in rows})
    locked = connection.execute("""select id,library_id,artist_id
        from library.local_albums where library_id=%s and id=any(%s::bigint[])
        order by id for share""", (library_id, albums)).fetchall()
    expected_albums = {row['album_id']: {'id': row['album_id'], 'library_id': library_id,
                       'artist_id': row['album_artist_id']} for row in rows}
    if [dict(row) for row in locked] != [expected_albums[key] for key in albums]:
        raise CaptureChanged()
    track_artists = sorted({row['artist_id'] for row in rows})
    locked = connection.execute("""select id from library.local_artists
        where library_id=%s and id=any(%s::bigint[]) order by id for share""",
        (library_id, track_artists)).fetchall()
    if [row['id'] for row in locked] != track_artists:
        raise CaptureChanged()
    connection.execute("""select id from library.local_track_files
        where track_id=any(%s::bigint[]) order by id for share""", (ids,)).fetchall()
    connection.execute("""select id from library.library_roots where library_id=%s
        and id in (select library_root_id from library.local_track_files
                   where track_id=any(%s::bigint[])) order by id for share""",
        (library_id, ids)).fetchall()
    album_artists = sorted({row['album_artist_id'] for row in rows})
    locked = connection.execute("""select id from library.local_artists
        where library_id=%s and id=any(%s::bigint[]) order by id for share""",
        (library_id, album_artists)).fetchall()
    if [row['id'] for row in locked] != album_artists:
        raise CaptureChanged()


def _identity_facts_sql():
    """Reuse all identity expressions verbatim, excluding every cache relation."""
    projection, joins = mix._FACTS.split(' from inventory\n', 1)
    projection = projection.split(',\n   s.current_revision', 1)[0]
    joins = joins.split(' left join library.track_popularity_mapping_slots', 1)[0]
    return projection + ' from facet_inventory as inventory\n' + joins


def _facet_ctes():
    """Shared generator for F and the final snapshot's exact equality gate."""
    eligibility = _eligible_album_tracks_cte_sql(
        include_filter_facts=True, require_active_roots=True)
    # This guarded prefix changes only the eligible owner input domain. Its
    # effective path/default exception semantics and active-root rules survive.
    eligibility = eligibility.replace('from library.local_tracks\n',
        'from library.local_tracks\n          join admitted '
        'on admitted.id=library.local_tracks.id\n', 1)
    eligibility = eligibility.replace(
        'where library.exception_overrides.track_id is not null',
        'where library.exception_overrides.track_id in (select id from admitted)', 1)
    inventory = sources._INVENTORY + """ where t.library_id=%(library_id)s
        and t.id in (select id from admitted)"""
    return _GATE_CTES + ',\n' + eligibility + ",\n" + """
 facet_inventory as materialized (""" + inventory + """),
 facet_identity as materialized (""" + _identity_facts_sql() + """),
 allowed_artists as materialized (
   select a.id,a.name from library.local_artists a cross join admission_gate g
   where g.ok and a.library_id=%(library_id)s and a.id=any(%(artist_ids)s::bigint[])
 ),
 safe_alias_edges as materialized (
   select e.*,
     array(select b.artist_id from alias_bindings b where b.edge_id=e.edge_id
           and b.side='alias' and b.artist_id is not null order by b.artist_id) as alias_artist_ids,
     array(select b.artist_id from alias_bindings b where b.edge_id=e.edge_id
           and b.side='canonical' and b.artist_id is not null order by b.artist_id) as canonical_artist_ids
   from library.relation_alias_endpoints e cross join admission_gate g
   join alias_header h on true
   where g.ok and e.library_id=h.library_id and e.publication_id=h.publication_id
     and not exists(select 1 from alias_bindings b where b.edge_id=e.edge_id
       and b.artist_id is not null and not (b.artist_id=any(%(artist_ids)s::bigint[])))
 ),
 scoped_aliases as materialized (
   select a.id, coalesce(jsonb_agg(distinct label.name order by label.name)
     filter (where label.name is not null), '[]'::jsonb) as names,
     coalesce(jsonb_agg(distinct to_jsonb(e) order by to_jsonb(e))
       filter (where e.edge_id is not null), '[]'::jsonb) as edges
   from allowed_artists a
   join admitted admitted_artist on admitted_artist.artist_id=a.id
   left join safe_alias_edges direct on a.id=any(direct.alias_artist_ids)
                                    or a.id=any(direct.canonical_artist_ids)
   left join safe_alias_edges e on e.canonical_key=direct.canonical_key
   left join lateral (select e.raw_alias as name union select e.raw_canonical) label on true
   group by a.id
 ),
 alias_frame as materialized (
   select jsonb_build_object('source_proof',p.source_proof,
     'publication_proof',p.publication_proof,'binding_proof',p.binding_proof,
     'coordinates',p.coordinates,
     'scoped',coalesce((select jsonb_agg(to_jsonb(s) order by s.id)
                        from scoped_aliases s),'[]'::jsonb)) as value
   from alias_protocol p cross join admission_gate g where g.ok
 ),
 facet_rows as materialized (
   select i.original_local_track_id as id,
     jsonb_build_object(
       'identity', to_jsonb(i), 'coordinates', to_jsonb(c),
       'visible', (""" + _visible_album_clause('a') + """),
       'album_metadata', a.metadata,
       'album_artist_name', aa.name,
       'aliases', coalesce(sa.names,'[]'::jsonb),
       'watch_health', coalesce(l.metadata->'library_watch_health','{}'::jsonb),
       'files', coalesce((select jsonb_agg(jsonb_build_object(
           'id', f.id, 'root_id', f.library_root_id, 'path', f.private_path,
           'stale', f.scan_cache_stale, 'metadata', f.metadata,
           'root_library_id', r.library_id, 'active', r.is_active,
           'root_metadata', r.metadata) order by f.id)
         from library.local_track_files f
         left join library.library_roots r on r.id=f.library_root_id
         where f.track_id=c.id),'[]'::jsonb),
       'overrides', coalesce((select jsonb_agg(to_jsonb(o) order by o.id)
         from library.exception_overrides o where o.library_id=c.library_id
           and (o.track_id=c.id or o.track_key in (
             select f.private_path from library.local_track_files f where f.track_id=c.id))),
         '[]'::jsonb),
       'genres', coalesce((select jsonb_agg(jsonb_build_object(
          'file_id', eligible.file_id,
          'value', nullif(btrim(f.metadata#>>'{scan_cache,file_entry,genre}'),''))
          order by eligible.file_id)
         from eligible_album_tracks eligible
         join library.local_track_files f on f.id=eligible.file_id
         join library.library_roots r on r.id=f.library_root_id
         where eligible.track_id=c.id and not coalesce((
           coalesce(l.metadata->'library_watch_health','{}'::jsonb) ?
           coalesce(nullif(r.metadata->>'root_id',''),f.metadata->>'library_root_id')),false)),
         '[]'::jsonb)) as value
   from facet_identity i join admitted c on c.id=i.original_local_track_id
   join library.local_albums a on a.id=c.album_id and a.library_id=c.library_id
   join library.local_artists aa on aa.id=c.album_artist_id and aa.library_id=c.library_id
   join library.libraries l on l.id=c.library_id
   left join scoped_aliases sa on sa.id=c.artist_id
 ),
 facet_frame as materialized (
   select jsonb_build_object(
     'rows', coalesce((select jsonb_agg(value order by id) from facet_rows),'[]'::jsonb),
     'aliases', (select value from alias_frame)) as value
 )
"""


def _facet_sql():
    return 'with ' + _facet_ctes() + """
 select g.ok as capture_ok, p.ready as alias_ready, case when g.ok then f.value end as facet_frame,
        case when g.ok then f.value::text end as facet_frame_text
 from admission_gate g cross join alias_protocol p cross join facet_frame f
"""


def _capture_sql():
    # The inventory relation is empty unless BOTH complete comparisons pass.
    # _FACTS receives only that relation, so no rejected/nonmatching row enters
    # mapping or source-observation joins. The whole query uses one snapshot.
    inventory = sources._INVENTORY + """ where t.library_id=%(library_id)s
      and t.id in (select a.id from admitted a cross join capture_gate g
                   where g.ok and a.id=any(%(matched_ids)s::bigint[]))"""
    return 'with ' + _facet_ctes() + """,
 capture_gate as materialized (
   select u.ok and f.value=%(facet_frame)s::jsonb as ok
   from admission_gate u cross join facet_frame f
 ),
 inventory as materialized (""" + inventory + """),
 cache_facts as materialized (""" + mix._FACTS + """ )
 select g.ok as capture_ok, p.ready as alias_ready, facts.* from capture_gate g
 cross join alias_protocol p
 left join cache_facts facts on true order by facts.original_local_track_id
"""


def _matches(row, criteria):
    if (row['visible'] is not True or row['identity']['availability'] != 'local'
            or not row['genres']):
        return False
    genres = [normalize_search_text(value['value']) for value in row['genres'] if value['value']]
    artist = row['identity']['artist']
    def artist_match(terms):
        return artist_alias_matches_query(artist, row['aliases'], terms)
    def genre_match(terms):
        return search_terms_match_fields(terms, genres)
    for include, exclude, match in (
        (criteria.artist_include_terms, criteria.artist_exclude_terms, artist_match),
        (criteria.genre_include_terms, criteria.genre_exclude_terms, genre_match),
    ):
        if include and not any(match(terms) for terms in include):
            return False
        if any(match(terms) for terms in exclude):
            return False
    return True


def capture(connection, live, request, *, constraints=None):
    library_id = live.library_id
    if type(library_id) is not int or library_id < 1 or connection.autocommit:
        raise ValueError('Popularity capture requires a current-library transaction')
    params = {'library_id': library_id}
    first = connection.execute(_UNIVERSE_SQL, params).fetchone()
    if first['alias_ready'] is not True:
        raise PrivateSearchError('private_search_unavailable', 503)
    universe = first['universe']
    params.update(alias_coordinates=_json(first['alias_coordinates']),
        alias_source_proof=first['alias_source_proof'],
        alias_publication_proof=first['alias_publication_proof'],
        alias_binding_proof=first['alias_binding_proof'])
    decisions = _decisions(live, universe, constraints)
    admitted = _admitted(universe, decisions)
    _lock_admitted(connection, library_id, admitted)
    params.update(universe=_json(universe), admitted_ids=[row['id'] for row in admitted],
        artist_ids=sorted(identifier for (kind, identifier), allowed in decisions.items()
                          if kind == 'artist' and allowed),
        visible_categories=list(request.categories), category_count=len(request.categories))
    initial = connection.execute(_facet_sql(), params).fetchone()
    if initial['alias_ready'] is not True:
        raise PrivateSearchError('private_search_unavailable', 503)
    if initial['capture_ok'] is not True:
        raise CaptureChanged()
    frame = initial['facet_frame']
    matching = [row for row in frame['rows'] if _matches(row, request.criteria)]
    # Bind the original JSONB text: Python float decoding must never round
    # precision-bearing metadata before the SQL equality comparison.
    params.update(facet_frame=initial['facet_frame_text'],
                  matched_ids=[row['identity']['original_local_track_id'] for row in matching])
    captured = connection.execute(_capture_sql(), params).fetchall()
    if any(row['alias_ready'] is not True for row in captured):
        raise PrivateSearchError('private_search_unavailable', 503)
    if not captured or any(row['capture_ok'] is not True for row in captured):
        raise CaptureChanged()
    rows = {row['original_local_track_id']: {key: value for key, value in row.items()
            if key not in ('capture_ok', 'alias_ready')} for row in captured if row['original_local_track_id'] is not None}
    if set(rows) != set(params['matched_ids']):
        raise CaptureChanged()
    tracks, snapshots, diagnostics = [], {}, []
    for identifier, row in rows.items():
        track, snapshot, reason = mix.normalize_cached_inventory_row(row)
        if reason:
            diagnostics.append((identifier, reason))
        if track is not None:
            tracks.append(track)
        if snapshot is not None:
            snapshots[identifier] = snapshot
    return CapturedPopularity(universe, decisions, frame, rows, tuple(tracks), snapshots,
        tuple(diagnostics), read_popularity_refresh_status(connection, library_id),
        sum(not any(value['value'] for value in row['genres']) for row in matching),
        initial['facet_frame_text'])
