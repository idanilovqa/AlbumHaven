"""Real source-choice SQL, explicit nonempty preview and private HTTP composition."""
import asyncio
from contextlib import contextmanager
import json
from urllib.parse import urlencode
from uuid import uuid4

import pytest

from music_app.services import album_top_publication_evidence as evidence
from music_app.services import album_metadata_sources as inventory_sources
from music_app.services.owned_album_tops import AlbumTopError, ACCESS, MANAGE, ITEMS
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error, CURSOR_SECRET
from tests.py.test_album_top_collaboration_postgres import write, member, new_session
from tests.py.test_album_top_owner_publication_postgres import configured
from tests.py.test_owned_album_top_route_boundary import middleware_app
from tests.py.test_public_album_top_http import exchange

CONTEXT = 'c' * 64


@pytest.fixture
def choices(db):
    configured(db)
    sources = []
    with db.connect() as connection:
        root = connection.execute('''insert into library.library_roots(library_id,root_path,metadata)
            values(%s,%s,'{}') returning id''', (db.library, '/synthetic-choices/' + db.token)).fetchone()['id']
        # Three physical copies of the first album, one unrelated catalog item.
        # Equal display metadata deliberately cannot collapse source identities.
        for number, album in enumerate([db.album_ids[0]] * 3 + [db.album_ids[1]]):
            source = str(uuid4())
            container = f'/synthetic-choices/{db.token}/copy-{number}'
            artist = connection.execute('select artist_id from library.local_albums where id=%s', (album,)).fetchone()['artist_id']
            connection.execute('''insert into library.album_metadata_sources
                (ref,library_id,local_album_id,library_root_id,container_identity,path_flavor,
                 capture_builder_version,state,title,artist,year,title_origin,artist_origin)
                values(%s,%s,%s,%s,%s,'posix',1,'active','Same Album','Same Artist',2000,'tag_metadata','tag_metadata')''',
                (source, db.library, album, root, container))
            for position in (1, 2):
                track = connection.execute('''insert into library.local_tracks
                    (library_id,artist_id,album_id,track_key,title,disc_number,track_number,duration_seconds,title_origin,artist_origin)
                    values(%s,%s,%s,%s,%s,1,%s,180,'tag_metadata','tag_metadata') returning id''',
                    (db.library, artist, album, f'{db.token}:{number}:{position}',
                     f'Track {position}', position)).fetchone()['id']
                connection.execute('''insert into library.local_track_files
                    (track_id,library_root_id,private_path,content_signature,metadata_source_ref,scan_cache_stale,metadata)
                    values(%s,%s,%s,'synthetic',%s,false,'{}')''',
                    (track, root, f'{container}/{position}.flac', source))
            sources.append(source)
    top, _ = db.create(refs=db.album_refs[:2])
    items = db.read(top)['items']
    return db, top, items, sources, root


def read(fixture, *, index=0, actor=None, **options):
    db, top, items, _, _ = fixture
    return db.service.read_publication_sources(db.context(actor),
        **{'top_ref': top['top_ref'], 'item_ref': items[index]['ref'], 'revision': top['revision'],
           'context_ref': CONTEXT, 'cursor_secret': CURSOR_SECRET, **options})


def retained(db):
    with db.connect() as connection:
        values = db.snapshot()
        for relation in ['library.public_metadata_source_state', 'library.album_metadata_sources',
                         'library.local_tracks', 'app.shared_links', 'app.album_list_publications']:
            values[relation] = connection.execute(f'select * from {relation} where library_id=%s order by 1',
                                                  (db.library,)).fetchall()
        values['files'] = connection.execute('''select f.* from library.local_track_files f
            join library.local_tracks t on t.id=f.track_id where t.library_id=%s order by f.id''', (db.library,)).fetchall()
        values['presentations'] = connection.execute('''select * from catalog.album_presentation_versions
            where catalog_ref=any(%s::uuid[]) order by ref''', (db.album_refs,)).fetchall()
        return values


def test_distinct_sources_paging_positive_projection_and_real_explicit_preview(choices):
    db, top, items, sources, _ = choices
    before = retained(db)
    pages = [read(choices, limit=1)]
    while pages[-1]['next_cursor']:
        assert len(pages) < 4
        pages.append(read(choices, limit=1, cursor=pages[-1]['next_cursor']))
    selected = [page['sources'][0] for page in pages]
    assert len(selected) == 3
    assert [row['selected_source_ref'] for row in selected] == sorted(sources[:3])
    assert all(row['selected_local_album_id'] == db.album_ids[0] for row in selected)
    assert all(set(row) == {'selected_local_album_id', 'selected_source_ref', 'title', 'artist', 'year'} for row in selected)
    assert all(set(page) == {'top_ref', 'revision', 'item_ref', 'album_ref', 'sources', 'next_cursor'} for page in pages)
    assert sources[3] not in json.dumps(pages)
    for private in ['/synthetic-choices/', 'private_path', 'container_identity', 'library_root_id', 'track_key']:
        assert private not in json.dumps(pages)
    second = read(choices, index=1)['sources'][0]
    selected_items = [{'album_ref': row['catalog_ref'], 'item_ref': row['ref'],
                       'selected_local_album_id': choice['selected_local_album_id'],
                       'selected_source_ref': choice['selected_source_ref']}
                      for row, choice in zip(items, [selected[0], second])]
    preview = db.service.publication_preview(db.context(), top_ref=top['top_ref'],
        payload={'revision': top['revision'], 'items': selected_items})
    assert [row['track_count'] for row in preview['items']] == [2, 2]
    assert len(preview['evidence_revision']) == 64
    assert retained(db) == before


def test_read_has_one_authorization_connection_no_writes_capture_or_inventory_scan(choices, monkeypatch):
    db, _, _, _, _ = choices
    before = retained(db)
    def forbidden(*args, **kwargs):
        raise AssertionError('A source-choice read must not capture or reconcile inventory')
    monkeypatch.setattr(evidence, 'capture', forbidden)
    monkeypatch.setattr(inventory_sources, 'reconcile_album_metadata_sources', forbidden)
    connect = db.service._connect
    opened, statements = [], []
    class ReadConnection:
        def __init__(self, connection):
            self.connection = connection
        def execute(self, sql, params=None):
            statement = str(sql).strip().lower()
            assert statement.startswith(('select ', 'set ', 'lock table ')), statement
            statements.append(statement)
            return self.connection.execute(sql, params)
        def __getattr__(self, name):
            return getattr(self.connection, name)
    @contextmanager
    def observed(*args, **kwargs):
        opened.append(True)
        with connect(*args, **kwargs) as connection:
            yield ReadConnection(connection)
    monkeypatch.setattr(db.service, '_connect', observed)
    assert len(read(choices)['sources']) == 3
    assert len(opened) == 1
    assert any('lock_public_metadata_source' in sql for sql in statements)
    assert not any('from library.local_track_files' in sql or 'from library.local_tracks' in sql for sql in statements)
    assert retained(db) == before


@pytest.mark.parametrize('scope', ['item', 'context', 'session', 'limit', 'secret'])
def test_cursor_is_bound_to_exact_owner_session_item_context_and_page(choices, scope):
    db, _, _, _, _ = choices
    cursor = read(choices, limit=1)['next_cursor']
    options = {'limit': 1, 'cursor': cursor}
    if scope == 'item': options['index'] = 1
    if scope == 'context': options['context_ref'] = 'd' * 64
    if scope == 'session': options['actor'] = new_session(db, db.owner)
    if scope == 'limit': options['limit'] = 2
    if scope == 'secret': options['cursor_secret'] = 'different-synthetic-source-secret-32-bytes'
    assert_error(lambda: read(choices, **options), 'invalid_cursor', 422)


def test_current_top_revision_and_source_generation_invalidate_stale_pages(choices):
    db, top, _, sources, _ = choices
    cursor = read(choices, limit=1)['next_cursor']
    with db.connect() as connection:
        connection.execute('update library.album_metadata_sources set year=2001 where ref=%s', (sources[0],))
    assert_error(lambda: read(choices, limit=1, cursor=cursor), 'invalid_cursor', 422)
    updated, _ = write(db, 'save', top, title='Changed saved Top')
    assert_error(lambda: read(choices), 'revision_conflict', 409)
    assert read(choices, revision=updated['revision'])['revision'] == updated['revision']


def test_nonowner_deleted_or_foreign_item_cannot_enumerate_sources(choices):
    db, top, _, _, _ = choices
    editor = member(db)
    shared, _ = write(db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    assert_error(lambda: read(choices, actor=editor, revision=shared['revision']), 'forbidden', 403)
    other, _ = db.create(refs=db.album_refs[2:])
    foreign_item = db.read(other)['items'][0]['ref']
    assert_error(lambda: read(choices, item_ref=foreign_item, revision=shared['revision']), 'item_unavailable', 404)
    assert_error(lambda: read(choices, item_ref=str(uuid4()), revision=shared['revision']), 'item_unavailable', 404)
    deleted, _ = write(db, 'delete', shared)
    assert_error(lambda: read(choices, revision=deleted['revision']), 'top_unavailable', 404)


@pytest.mark.parametrize('kind', ['album', 'album_metadata_source', 'library_root'])
def test_current_source_browse_denials_do_not_return_private_candidates(choices, kind):
    db, _, _, sources, _ = choices
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=not (
        context.resource is not None and context.resource.resource_kind == kind))
    assert read(choices, constraints=constraints)['sources'] == []


@pytest.mark.parametrize('action', [ACCESS, MANAGE, ITEMS])
def test_owner_action_denial_cannot_be_replaced_by_source_browse(choices, action):
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != action)
    assert_error(lambda: read(choices, constraints=constraints), 'forbidden', 403)


def test_filtered_page_keeps_bounded_continuation_without_collapsing_distinct_copies(choices):
    _, _, _, sources, _ = choices
    denied = min(sources[:3])
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=not (
        context.resource is not None and context.resource.resource_kind == 'album_metadata_source'
        and context.resource.resource_ref == denied))
    first = read(choices, limit=1, constraints=constraints)
    assert first['sources'] == [] and first['next_cursor']
    second = read(choices, limit=1, cursor=first['next_cursor'], constraints=constraints)
    assert len(second['sources']) == 1 and second['sources'][0]['selected_source_ref'] != denied


@pytest.mark.parametrize('failure', ['inactive_root', 'invalid_source', 'unsafe_label', 'outside_root'])
def test_existing_source_validation_filters_unusable_candidates(choices, failure):
    db, _, _, sources, root = choices
    with db.connect() as connection:
        if failure == 'inactive_root':
            connection.execute('update library.library_roots set is_active=false where id=%s', (root,))
        elif failure == 'invalid_source':
            connection.execute("update library.album_metadata_sources set state='invalid' where ref=%s", (sources[0],))
        elif failure == 'unsafe_label':
            connection.execute('update library.album_metadata_sources set title=%s where ref=%s', ('bad\nlabel', sources[0]))
        else:
            connection.execute('update library.album_metadata_sources set container_identity=%s where ref=%s',
                               ('/outside-synthetic-root', sources[0]))
    result = read(choices)
    assert sources[0] not in {row['selected_source_ref'] for row in result['sources']}
    assert len(result['sources']) == (0 if failure == 'inactive_root' else 2)


def test_late_policy_denial_rechecks_previously_emitted_candidates(choices):
    seen = set()
    def constraints(context):
        resource = context.resource
        if resource is not None and resource.resource_kind == 'album_metadata_source':
            seen.add(resource.resource_ref)
        return PolicyEvaluationConstraints(request_origin_allowed=len(seen) < 3)
    # Third candidate denies itself; final recheck must discard earlier allows.
    assert_error(lambda: read(choices, constraints=constraints), 'forbidden', 403)


def test_actual_sql_service_through_real_http_route_returns_context_and_saved_identity(choices):
    db, top, items, _, _ = choices
    app = middleware_app(db.service, db.owner)
    path = f"/album-tops/{top['top_ref']}/items/{items[0]['ref']}/publication-sources"
    before = retained(db)
    status, body, headers = asyncio.run(exchange(app, path=path, host='music.test',
        query=urlencode({'revision': top['revision'], 'limit': '2'}).encode()))
    value = json.loads(body)
    assert status == 200 and headers[b'cache-control'] == b'private, no-store'
    assert len(value['context_ref']) == 64 and len(value['data']['sources']) == 2
    assert value['data']['item_ref'] == items[0]['ref'] and value['data']['next_cursor']
    assert retained(db) == before
