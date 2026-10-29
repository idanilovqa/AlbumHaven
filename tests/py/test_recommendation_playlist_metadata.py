"""Portable source-witness contracts; genuine PostgreSQL qualification is separate."""
import hashlib
import json
from contextlib import nullcontext
from types import SimpleNamespace
from uuid import UUID

import pytest

from music_app.services import playlist_metadata_occurrences as occurrences
from music_app.services import playlist_viewer_actions as copies
from music_app.services import recommendations_postgres as store
from music_app.services.owned_playlists import BROWSE, CREATE, PlaylistError
from music_app.services.recommendations import command, RecommendationError
from tests.py.owned_playlist_testing import context, ACCOUNT, LIBRARY, REQUEST

PLAYLIST = '50000000-0000-4000-8000-000000000019'
ITEM = '30000000-0000-4000-8000-000000000019'
ORIGIN = '40000000-0000-4000-8000-000000000019'
FRIEND = '20000000-0000-4000-8000-000000000019'
DESTINATION = '60000000-0000-4000-8000-000000000019'
SCHEMA = {'uuid_type': True, 'attnotnull': False, 'atthasdef': False, 'attgenerated': '', 'attidentity': ''}
FACTS = {'original_local_track_id': None, 'title': 'Retained song', 'artist': 'Artist',
         'album_title': 'Album', 'original_album_id': None, 'release_year': 2001,
         'disc_number': 1, 'track_number': 2, 'duration_seconds': 123}


def payload(**changes):
    return {'kind': 'track', 'resource_ref': 'playlist-item:' + ITEM,
            'source': {'playlist_ref': PLAYLIST, 'revision': '4'},
            'request_key': REQUEST, 'recipient_account_ref': FRIEND, **changes}


class Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


def test_playlist_witness_has_no_client_fact_or_origin():
    value = command(payload())
    assert value.source_playlist_ref == PLAYLIST
    assert value.source_item_ref == ITEM and value.source_revision == 4
    assert value.library_id is value.resource_id is value.catalog_ref is value.source_top_ref is None
    manual = payload(recommender={'name': 'A person'})
    del manual['recipient_account_ref']
    assert command(manual, manual=True).recommender_name == 'A person'


@pytest.mark.parametrize('field', ['title', 'artist', 'local_track_id', 'original_local_track_id',
                                 'metadata_occurrence_ref', 'source_lineage', 'playback_url'])
def test_playlist_witness_rejects_client_facts(field):
    with pytest.raises(RecommendationError):
        command(payload(**{field: 'forged'}))
    value = payload()
    value['source'][field] = 'forged'
    with pytest.raises(RecommendationError):
        command(value)


@pytest.mark.parametrize('source', [None, {}, {'playlist_ref': PLAYLIST, 'revision': 4},
    {'playlist_ref': PLAYLIST, 'revision': '0'}, {'playlist_ref': PLAYLIST, 'revision': '04'},
    {'playlist_ref': PLAYLIST, 'revision': '9223372036854775808'},
    {'playlist_ref': PLAYLIST, 'revision': '4', 'item_ref': ITEM},
    {'playlist_ref': 'invalid', 'revision': '4'}])
def test_playlist_source_is_closed_and_bounded(source):
    with pytest.raises(RecommendationError):
        command(payload(source=source))


@pytest.mark.parametrize('changes', [
    {'kind': 'album'}, {'resource_ref': 'playlist-item:invalid'},
    {'resource_ref': 'playlist-item:' + ITEM + ' '},
    {'resource_ref': 'playlist-item:AAAAAAAA-0000-4000-8000-000000000019'},
    {'resource_ref': 'catalog-track:' + ITEM},
])
def test_playlist_kind_and_resource_are_exact(changes):
    with pytest.raises(RecommendationError):
        command(payload(**changes))


def test_digest_binds_source_and_preserves_old_command_digest():
    value = command(payload())
    assert value.digest != command(payload(source={'playlist_ref': PLAYLIST, 'revision': '5'})).digest
    assert value.digest != command(payload(resource_ref='playlist-item:' + ORIGIN)).digest
    assert value.digest != command(payload(source={'playlist_ref': DESTINATION, 'revision': '4'})).digest
    inventory = payload(resource_ref=f'inventory-track:{LIBRARY}:901')
    del inventory['source']
    old = command(inventory)
    legacy = {key: val for key, val in old.__dict__.items()
              if key not in ('request_key', 'source_playlist_ref')}
    expected = hashlib.sha256(json.dumps(legacy, sort_keys=True, ensure_ascii=False,
                                        separators=(',', ':')).encode()).hexdigest()
    assert old.digest == expected


class SchemaConnection:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def execute(self, sql):
        self.calls.append(sql)
        assert 'from pg_catalog.pg_attribute' in sql
        assert "attname='metadata_occurrence_ref'" in sql
        assert 'a.atthasdef' in sql
        assert sql.lstrip().startswith('select ')
        return Result([] if self.row is None else [self.row])


@pytest.mark.parametrize('row,expected', [(None, False), (SCHEMA, True)])
def test_schema_readiness_is_read_only_and_absence_is_supported(row, expected):
    connection = SchemaConnection(row)
    assert occurrences.installed(connection) is expected
    assert len(connection.calls) == 1


@pytest.mark.parametrize('field,value', [('uuid_type', False), ('attnotnull', True),
                                       ('atthasdef', True),
                                       ('attgenerated', 's'), ('attidentity', 'a')])
def test_installed_incompatible_schema_does_not_fall_back(field, value):
    with pytest.raises(PlaylistError) as error:
        occurrences.installed(SchemaConnection({**SCHEMA, field: value}))
    assert error.value.code == 'playlist_schema_unavailable' and error.value.status_code == 503


def test_schema_errors_are_not_absence():
    class Broken:
        def execute(self, sql):
            raise RuntimeError('database observation failed')
    with pytest.raises(RuntimeError):
        occurrences.installed(Broken())


@pytest.mark.parametrize('stored,expected', [(None, ITEM), (UUID(ORIGIN), ORIGIN)])
def test_origin_is_current_row_only(stored, expected):
    assert occurrences.origin({'ref': UUID(ITEM), 'metadata_occurrence_ref': stored,
        'source_lineage': {'playlist_item_ref': 'never traverse'}}) == expected


@pytest.mark.parametrize('fault', [None, 'schema_absent', 'owner', 'revision', 'item', 'permission'])
def test_saved_source_authority_read_only_and_facts_allowlisted(monkeypatch, fault):
    calls = []
    owner = SimpleNamespace()
    def playlist(connection, live, ref):
        assert live == context() and ref == PLAYLIST
        calls.append('parent')
        return {'owner_account_id': ACCOUNT + 1 if fault == 'owner' else ACCOUNT,
                'revision': 5 if fault == 'revision' else 4}
    def require(live, actions, constraints, parent):
        assert actions == (BROWSE,) and constraints is None
        calls.append('authorize')
        if fault == 'permission':
            raise PlaylistError('forbidden', 403)
    owner._playlist, owner._require = playlist, require
    service = object.__new__(store.PostgresRecommendations)
    service.owner = owner
    monkeypatch.setattr(occurrences, 'installed', lambda connection: fault != 'schema_absent')
    class Connection:
        def execute(self, sql, params):
            calls.append('item')
            assert sql.lstrip().startswith('select ') and 'for share' in sql
            assert params == (PLAYLIST, LIBRARY, ITEM)
            return Result([] if fault == 'item' else [{**FACTS, 'ref': UUID(ITEM),
                'metadata_occurrence_ref': UUID(ORIGIN), 'local_track_id': 123,
                'source_lineage': {'private': 'never forward'}, 'recommended_by': ['private']}])
    if fault:
        with pytest.raises((RecommendationError, PlaylistError)):
            service._playlist_source(Connection(), context(), command(payload()), ACCOUNT, None)
    else:
        assert service._playlist_source(Connection(), context(), command(payload()), ACCOUNT, None) == {
            **FACTS, 'metadata_occurrence_ref': ORIGIN}
        assert calls == ['parent', 'authorize', 'item']


@pytest.mark.parametrize('track_id', [None, 901])
@pytest.mark.parametrize('existing', [False, True])
def test_metadata_item_dedup_and_insert_without_media_link(track_id, existing):
    calls = []
    source = {**FACTS, 'original_local_track_id': track_id, 'metadata_occurrence_ref': ORIGIN}
    class Connection:
        def execute(self, sql, params):
            calls.append((sql, params))
            if len(calls) == 1:
                assert params == (DESTINATION, ORIGIN if track_id is None else track_id)
                assert ('metadata_occurrence_ref=%s' if track_id is None else 'original_local_track_id=%s') in sql
                return Result([{'ref': ITEM}] if existing else [])
            if len(calls) == 2:
                assert sql.startswith('select count(*)') and params == (DESTINATION,)
                return Result([{'total': 0}])
            assert len(calls) == 3 and sql.startswith('insert into app.playlist_items')
            assert 'values(%s,%s,%s,%s,%s,null,' in sql
            assert params[1:5] == (DESTINATION, LIBRARY, 1, track_id)
            assert params[5:] == ('Retained song', 'Artist', 'Album', None, 2001, 1, 2, 123, ORIGIN)
            assert 'source_lineage' not in sql and 'source_ref' not in sql
            return Result([])
    service = object.__new__(store.PostgresRecommendations)
    result = service._item(Connection(), context(), command(payload()), {'ref': DESTINATION}, source)
    assert str(UUID(result)) == result
    assert len(calls) == (1 if existing else 3)
    if existing:
        assert result == ITEM


@pytest.mark.parametrize('installed', [False, True])
def test_normal_copy_has_explicit_schema_gate_and_preserves_occurrences(monkeypatch, installed):
    calls = []
    monkeypatch.setattr(occurrences, 'installed', lambda connection: installed)
    # No local inventory: the source consists of two independent retained rows.
    rows = [{'local_track_id': None}, {'local_track_id': None}]
    def inventory(connection, library_id, ids, **kwargs):
        assert library_id == LIBRARY and ids == [] and kwargs['lock'] is True
        return {}
    monkeypatch.setattr(copies.sources, 'inventory_rows', inventory)
    class Connection:
        def execute(self, sql, params):
            calls.append((sql, params))
            if sql.startswith('select * from app.playlist_items'):
                assert params == (PLAYLIST,)
                return Result(rows)
            assert sql.startswith('insert into app.playlists') or sql.startswith('insert into app.playlist_items')
            if sql.startswith('insert into app.playlist_items'):
                assert ('metadata_occurrence_ref' in sql) is installed
                assert ('coalesce(metadata_occurrence_ref,ref)' in sql) is installed
                assert 'distinct' not in sql.lower()
                assert "'playlist_copy_v1'" in sql
                assert params[1:] == ('4', PLAYLIST)
            return Result([])
    def require(live, actions, constraints):
        assert live == context() and actions == (BROWSE, CREATE) and constraints is None
    owner = SimpleNamespace(_require=require, _config={}, _receipt=lambda *args, **kwargs: kwargs)
    cmd = SimpleNamespace(playlist_ref=PLAYLIST, data={'revision': '4'})
    result = copies.copy_playlist(owner, Connection(), context(), cmd,
                                  {'title': 'Original', 'description': ''}, None)
    assert result['added_count'] == 2
    assert len(calls) == 3


def test_bad_installed_schema_stops_copy_before_any_destination_write(monkeypatch):
    def invalid(connection):
        raise PlaylistError('playlist_schema_unavailable', 503)
    monkeypatch.setattr(occurrences, 'installed', invalid)
    class Connection:
        def execute(self, *args):
            raise AssertionError('no query or destination write after invalid schema')
    owner = SimpleNamespace(_require=lambda *args: None)
    with pytest.raises(PlaylistError):
        copies.copy_playlist(owner, Connection(), context(), SimpleNamespace(), {}, None)


@pytest.mark.parametrize('hint_owner', [ACCOUNT, None], ids=['self-source-changed', 'source-deleted'])
@pytest.mark.parametrize('prior_kind', ['matching', 'session-conflict', 'digest-conflict', 'absent'])
def test_replay_recovers_only_historical_receipt_without_new_source_access(monkeypatch, hint_owner, prior_kind):
    """A self-attribution revision bump or retired source cannot erase a receipt."""
    request = payload(recommender={'name': 'An earlier recommendation'})
    del request['recipient_account_ref']
    value, live, calls = command(request, manual=True), context(), []
    receipt = {'status': 'recommended', 'kind': 'track', 'already_recommended': False,
               'collection_ref': PLAYLIST}
    class Lookup:
        def execute(self, sql, params):
            assert sql == 'select owner_account_id from app.playlists where ref=%s and library_id=%s'
            assert params == (PLAYLIST, LIBRARY)
            return Result([] if hint_owner is None else [{'owner_account_id': hint_owner}])
    class Connection:
        def execute(self, sql, params=()):
            if sql.startswith('select to_regclass('):
                return Result([{'installed': 'app.recommendation_attributions'}])
            assert 'from app.recommendation_operations' in sql and sql.lstrip().startswith('select ')
            assert params == (ACCOUNT, LIBRARY, REQUEST)
            if prior_kind == 'absent':
                return Result([])
            return Result([{'original_session_id': live.actor.session_id + (prior_kind == 'session-conflict'),
                            'command_digest': 'conflict' if prior_kind == 'digest-conflict' else value.digest,
                            'receipt': receipt}])
    connection = Connection()
    def authorized(ctx, constraints, *, target_account_ids):
        assert ctx == live and constraints is None
        assert target_account_ids == (() if hint_owner is None else (ACCOUNT,))
        calls.append('current-authority')
        return nullcontext((connection, live, None))
    owner = SimpleNamespace(_url='unused', _clock=None, _connect=lambda url: nullcontext(Lookup()),
        _authorized=authorized, _require=lambda *args: calls.append('browse'))
    service = object.__new__(store.PostgresRecommendations)
    service.owner = owner
    def source(*args):
        assert prior_kind == 'absent' and hint_owner is not None, 'historical replay must not read source'
        raise RecommendationError('source_changed', 409)
    service._playlist_source = source
    def session(conn, **kwargs):
        assert conn is connection and kwargs['actor_account_id'] == ACCOUNT
        assert kwargs['actor_session_id'] == live.actor.session_id
        calls.append('current-session')
    monkeypatch.setattr(store, 'lock_current_actor_session', session)
    if prior_kind == 'matching':
        assert service.execute(live, request, manual=True) == receipt
        assert calls == ['current-authority', 'browse', 'current-session']
    else:
        with pytest.raises(RecommendationError) as error:
            service.execute(live, request, manual=True)
        assert error.value.code == ('request_conflict' if prior_kind != 'absent'
                                   else 'source_changed' if hint_owner is not None else 'source_unavailable')
        assert calls == ['current-authority', 'browse']
