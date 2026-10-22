"""Bounded C1 test support; no product hooks or substitute authority.

Parent approved this fifth owner on 2026-10-18. Reuses the unchanged isolated
Mix fixture and its runtime-role checks. All test writes affect owned rows.
Connection observers delegate every real SQL statement without changing SQL.
"""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime
import json
import math
import re

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest
from starlette.datastructures import QueryParams

from library_mix_postgres_support import mix_urls, MEDIA
from popularity_search_bootstrap_support import bootstrap_popularity_db
from tests.py.listener_search_live_support import Workers as BaseWorkers, Connections, observe_blocker
from music_app.services.current_actor import CapabilityGrant
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_search_contract import normalize_private_search_request, PrivateSearchError
from music_app.services.private_popularity_search_postgres import PostgresPopularitySearch

def bounded_connection(url):
    return psycopg.connect(url, row_factory=dict_row, connect_timeout=10,
        options='-c statement_timeout=15000 -c lock_timeout=10000')


class BoundedConnections(Connections):
    @contextmanager
    def __call__(self, url):
        con = bounded_connection(url)
        with self.lock:
            self.items.append(con)
            self.events.append(('open', con.info.backend_pid))
        pid = con.info.backend_pid
        try:
            with con:
                yield con
        finally:
            self.events.append(('close', pid))
            con.close()


class Workers(BaseWorkers):
    def __init__(self):
        super().__init__()
        self.connections = BoundedConnections()


SECRET = 'popularity-source-only-test-secret-20261018'
CONTEXT = 'a' * 64
REASONS = {'missing_recording_identity', 'missing_provider_mapping', 'provider_unavailable',
           'mapping_mismatch', 'missing_global_metric', 'ambiguous_attribution', 'missing_canonical_artist'}


def set_genre(connection, track_id, value):
    connection.execute("""update library.local_track_files set metadata=jsonb_set(
        metadata,'{scan_cache,file_entry,genre}',%s::jsonb) where track_id=%s""", (Jsonb(value), track_id))


@pytest.fixture
def popular_db(monkeypatch, tmp_path):
    with bootstrap_popularity_db(monkeypatch, tmp_path) as db:
        with db.connect() as con:
            for track in db.tracks:
                set_genre(con, track, 'jazz')
            settings = {'version': 1, 'main_library_roots': [
                {'id': db.token, 'path': str(db.root_path), 'layout_mode': 'artist'}],
                'hoarding_library_roots': [], 'new_arrivals_roots': [], 'move_policy': {}}
            db.settings_id = con.execute("""insert into library.library_root_settings
                (library_id,layout_mode,root_categories,settings_payload)
                values(%s,'artist','{}'::jsonb,%s) returning id""", (db.library, Jsonb(settings))).fetchone()['id']
            from music_app.services.library_mix_inventory_postgres import read_inventory, inventory_revision
            rows = read_inventory(con, db.library)
            assert all(row['mapped_inventory_revision'] == inventory_revision(row) for row in rows)
        yield db


def request(*, query=':popular', limit=100, cursor=None, categories=(), scope=None):
    pairs = [('q', query), ('search_page_size', str(limit))]
    if cursor is not None: pairs.append(('search_cursor', cursor))
    if scope is not None: pairs.append(('gallery_scope', scope))
    pairs.extend(('category', value) for value in categories)
    return normalize_private_search_request(QueryParams(pairs))


def owner(db, *, connect=None, clock=None):
    return PostgresPopularitySearch(db.config, connect=connect or db.app_connect,
                                   clock=clock or (lambda: db.clock_time))


def read(db, *, actor=None, context_ref=CONTEXT, constraints=None, connect=None, **options):
    return owner(db, connect=connect).read(db.context(actor), request=request(**options),
        context_ref=context_ref, cursor_secret=SECRET, constraints=constraints)


def native(db, result, *, operation='bindings', refs=None, intent='metadata',
           actor=None, constraints=None, connect=None, target_kind='OMITTED'):
    service = owner(db, connect=connect)
    refs = [row['id'] for row in result['tracks']] if refs is None else refs
    args = dict(result_token=result['native']['result_token'], context_ref=result['context_ref'],
                cursor_secret=SECRET, constraints=constraints)
    if operation == 'bindings': return service.project_bindings(db.context(actor), row_refs=refs, **args)
    if operation == 'single':
        if target_kind != 'OMITTED': args['target_kind'] = target_kind
        return service.resolve_target(db.context(actor), row_ref=refs[0], intent=intent, **args)
    return service.resolve_targets(db.context(actor), row_refs=refs, intent=intent, **args)


def error(status, call, code=None):
    with pytest.raises(PrivateSearchError) as caught:
        call()
    assert caught.value.status_code == status
    if code is not None: assert caught.value.code == code
    return caught.value


def deny_resource(kind, identifier):
    def constraints(ctx):
        denied = ctx.action == 'library.browse.read' and ctx.resource is not None \
            and ctx.resource.resource_kind == kind and ctx.resource.resource_ref == str(identifier)
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    return constraints


def grant_media(db):
    with db.connect() as con:
        con.execute("""insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
            values(%s,%s,'library',%s)""", (db.owner.account_id, MEDIA, db.library))
    db.owner = replace(db.owner, capability_grants=(*db.owner.capability_grants,
                                                  CapabilityGrant(MEDIA, 'library', db.library)))


class ObservedConnection:
    """Transparent real connection observer; callbacks never replace results."""
    def __init__(self, connection, before=None, after=None):
        self.connection, self.before, self.after = connection, before, after
    def __getattr__(self, name): return getattr(self.connection, name)
    def execute(self, sql, params=None, **kwargs):
        if self.before: self.before(self.connection, str(sql), params)
        cursor = self.connection.execute(sql, params, **kwargs)
        if self.after: self.after(self.connection, str(sql), params)
        return cursor


def observed_connection(*, before=None, after=None, registry=None):
    """Observe a real lease, optionally owned by Workers' cancellation registry.

    registry(url) registers the underlying psycopg connection before yielding,
    so callbacks, barriers and every subsequent SQL statement participate in
    failure cancellation. Its context manager also owns transaction/close cleanup.
    """
    @contextmanager
    def connect(url):
        lease = registry(url) if registry is not None else bounded_connection(url)
        with lease as con:
            if registry is not None:
                with registry.lock:
                    assert any(item is con for item in registry.items) and not con.closed
            yield ObservedConnection(con, before, after)
    return connect


def _uint(value):
    assert type(value) is int and 0 <= value <= 9007199254740991


def _text(value, maximum=1024, nullable=True):
    if value is None and nullable: return
    assert type(value) is str and len(value) <= maximum and '\0' not in value
    assert not any('\ud800' <= ch <= '\udfff' for ch in value)


def _duration(value):
    if value is None: return
    assert type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 9007199254740991


def _date(value):
    parsed = datetime.fromisoformat(value)
    assert parsed.utcoffset().total_seconds() == 0 and parsed.isoformat() == value


def assert_wire(result, *, offset=0):
    assert set(result) == {'status','private_search','contract_version','context_ref','query','criteria',
                          'presentation','tracks','page','popularity','native'}
    assert result['status'] == 'ready' and result['private_search'] is True
    assert result['contract_version'] == 'popularity-search-v1' and result['presentation'] == 'tracks'
    assert re.fullmatch('[0-9a-f]{64}', result['context_ref'])
    assert set(result['criteria']) == {'predicate_domain','sort','artist','genre','per_artist'}
    assert result['criteria']['predicate_domain'] == 'tracks'
    assert result['criteria']['sort'] == {'provider':'lastfm','metric':'overall_scrobbles','direction':'desc'}
    for field in ('artist','genre'):
        assert set(result['criteria'][field]) == {'include','exclude'}
        for values in result['criteria'][field].values():
            assert type(values) is list and all(type(v) is str for v in values)
    page = result['page']
    assert set(page) == {'limit','returned_count','has_more','next_cursor','total_matches'}
    for key in ('limit','returned_count','total_matches'): _uint(page[key])
    assert 1 <= page['limit'] <= 100
    assert page['returned_count'] == len(result['tracks']) == min(page['limit'], page['total_matches'] - offset)
    assert type(page['has_more']) is bool and page['has_more'] == (offset + len(result['tracks']) < page['total_matches'])
    assert (page['next_cursor'] is not None) == page['has_more']
    assert set(result['native']) == {'result_token'}
    for token in (page['next_cursor'], result['native']['result_token']):
        if token is not None: assert type(token) is str and token.isascii() and 0 < len(token) <= 4096
    ids = []
    for row in result['tracks']:
        assert set(row) == {'id','kind','title','artist','album_title','duration_seconds','availability','popularity'}
        assert re.fullmatch('popular_[0-9a-f]{64}', row['id'])
        ids.append(row['id'])
        assert row['kind'] == 'track' and row['availability'] == 'local'
        for key in ('title','artist','album_title'): _text(row[key])
        _duration(row['duration_seconds'])
        assert set(row['popularity']) == {'provider','metric','count','observed_at'}
        assert row['popularity']['provider'] == 'lastfm' and row['popularity']['metric'] == 'overall_scrobbles'
        _uint(row['popularity']['count']); _date(row['popularity']['observed_at'])
    assert len(ids) == len(set(ids))
    coverage = result['popularity']
    assert set(coverage) == {'provider','metric','label','genre_basis','matched_local_rows','selected_recordings',
        'missing_genre_local_rows','excluded_local_rows','oldest_observed_at','newest_observed_at','refresh_status'}
    assert coverage['provider'] == 'lastfm' and coverage['metric'] == 'overall_scrobbles'
    assert coverage['label'] == 'Last.fm global scrobbles' and coverage['genre_basis'] == 'stored_local_file_tags'
    assert set(coverage['excluded_local_rows']) == REASONS
    for value in coverage['excluded_local_rows'].values(): _uint(value)
    for key in ('matched_local_rows','selected_recordings','missing_genre_local_rows'): _uint(coverage[key])
    assert coverage['selected_recordings'] == page['total_matches'] <= coverage['matched_local_rows']
    assert coverage['missing_genre_local_rows'] <= coverage['matched_local_rows']
    assert coverage['refresh_status'] in {'idle','queued','running','complete','blocked','cancelled'}
    if page['total_matches']:
        _date(coverage['oldest_observed_at']); _date(coverage['newest_observed_at'])
        assert coverage['oldest_observed_at'] <= coverage['newest_observed_at']
    else: assert coverage['oldest_observed_at'] is coverage['newest_observed_at'] is None
    for forbidden in ('private_path','inventory-track:','canonical_track_ref','source_entity_id','subject_taste','listen_count'):
        assert forbidden not in json.dumps(result)


def assert_native(result, published, operation, refs):
    assert set(result) == {'status','private_search','contract_version','context_ref','result_token','data'}
    suffix = {'bindings':'bindings-v1','single':'v1','batch':'batch-v1'}[operation]
    assert result['contract_version'] == 'popularity-search-native-' + suffix
    assert result['status'] == 'ready' and result['private_search'] is True
    assert result['context_ref'] == published['context_ref']
    assert result['result_token'] == published['native']['result_token']
    if operation == 'single': items = [result['data']]
    else:
        assert set(result['data']) == {'items'}
        items = result['data']['items']
    assert [item['row_ref'] for item in items] == refs
    for item in items:
        if operation == 'bindings':
            assert set(item) == {'row_ref','allowed_actions','album_target'}
            assert set(item['allowed_actions']) == {'can_play','can_view_metadata','can_view_details'}
            assert all(type(v) is bool for v in item['allowed_actions'].values())
            parent = item['album_target']
            assert item['allowed_actions']['can_view_details'] == (parent is not None)
            if parent is not None:
                assert set(parent) == {'kind','row_ref','identity_ref','allowed_actions'}
                assert parent['kind'] == 'album' and parent['row_ref'] == item['row_ref']
                assert re.fullmatch(r'inventory-album:[1-9][0-9]*:[1-9][0-9]*', parent['identity_ref'])
                assert parent['allowed_actions'] == {'can_view_details': True}
            continue
        assert set(item) == {'row_ref','intent','target_kind','status','native_target'}
        assert item['target_kind'] == ('album' if item['intent'] == 'details' else None)
        if item['status'] == 'unavailable':
            assert item['native_target'] is None
            continue
        assert item['status'] == 'ready'
        target = item['native_target']
        if item['intent'] == 'details':
            assert set(target) == {'album_ref','allowed_actions'}
            _text(target['album_ref'], 16384, False)
            assert set(target['allowed_actions']) == {'can_view_details','can_play_album'}
            assert target['allowed_actions']['can_view_details'] is True
            assert type(target['allowed_actions']['can_play_album']) is bool
        elif item['intent'] == 'play':
            assert set(target) == {'inventory_track_ref','track_ref','path','title','artist','album_title','duration_seconds'}
            assert target['path'] == target['track_ref']
            _text(target['path'], 16384, False)
        else:
            assert set(target) == {'inventory_track_ref','track_ref','canonical_track_ref','source_readable','title','artist',
                'album_title','duration_seconds','availability','allowed_actions','playback_state','track_preference'}
            assert target['track_ref'] == target['canonical_track_ref']
            assert target['source_readable'] is True
            assert target['availability'] in {'local','unresolved'}
            assert set(target['allowed_actions']) == {'can_read','can_play'}
            assert target['allowed_actions']['can_read'] is True and type(target['allowed_actions']['can_play']) is bool
            assert target['playback_state'] == {'can_start_here': target['allowed_actions']['can_play']}
            preference = target['track_preference']
            if preference is not None:
                assert set(preference) == {'rating','love_tier','allowed_actions'}
                assert preference['rating'] is None or type(preference['rating']) is int and 1 <= preference['rating'] <= 5
                assert preference['love_tier'] in {'off','loved','obsessed'}
                assert set(preference['allowed_actions']) == {'client_surface_class','can_rate','can_set_love_tier'}
                assert preference['allowed_actions']['client_surface_class'] in {'cloud_web','private_web','desktop','mobile','tv','node'}
                assert type(preference['allowed_actions']['can_rate']) is type(preference['allowed_actions']['can_set_love_tier']) is bool
        if item['intent'] != 'details':
            assert re.fullmatch(r'inventory-track:[1-9][0-9]*:[1-9][0-9]*', target['inventory_track_ref'])
            for key in ('title','artist','album_title'): _text(target[key])
            _duration(target['duration_seconds'])
