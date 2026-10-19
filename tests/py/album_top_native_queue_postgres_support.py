"""Unique synthetic rows plus the real native owner, files and runtime role.

The media-path adapter supplies this fixture's configured roots to the existing
resolver. It never supplies SQL, policy, availability, or native target results.
"""
from contextlib import contextmanager
from dataclasses import replace
from types import SimpleNamespace
from uuid import uuid4

import pytest

from music_app.services.album_top_native_queue import AlbumTopNativeQueue
from music_app.services.current_actor import CapabilityGrant
from music_app.services.library_roots import resolve_configured_media_path
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.test_owned_album_tops_postgres import db, urls


CONTEXT = 'a' * 64
MEDIA = 'library.media.read'


def seed_track(database, root, root_id, album_id, *, number=1, disc=1, key=None):
    key = key or 'top-queue-' + uuid4().hex
    path = root / (uuid4().hex + '.flac')
    path.write_bytes(b'synthetic-top-native-target-file')
    with database.connect() as connection:
        row = connection.execute('''insert into library.local_tracks
            (library_id,artist_id,album_id,track_key,title,disc_number,track_number,duration_seconds)
            select library_id,artist_id,id,%s,%s,%s,%s,181 from library.local_albums
            where id=%s and library_id=%s returning id''',
            (key, 'Synthetic queue track ' + key, disc, number, album_id, database.library)).fetchone()
        identity = row['id']
        connection.execute('''insert into library.local_track_files
            (track_id,library_root_id,private_path,content_signature)
            values(%s,%s,%s,'synthetic-top-queue')''', (identity, root_id, str(path)))
    return {'id': identity, 'album_id': album_id, 'key': key, 'path': path,
            'title': 'Synthetic queue track ' + key, 'disc': disc, 'number': number}


def emitted_source(case, track=None, receipt=None):
    track = track or case.tracks[0]
    receipt = receipt or case.receipt
    catalog = case.db.album_refs[case.db.album_ids.index(track['album_id'])]
    item = next(row for row in case.db.read(receipt)['items'] if row['catalog_ref'] == catalog)
    return {'revision': receipt['revision'], 'item_ref': item['ref'], 'catalog_ref': catalog,
        'inventory_album_ref': f"inventory-album:{case.db.library}:{track['album_id']}",
        'inventory_track_ref': f"inventory-track:{case.db.library}:{track['id']}",
        'canonical_track_ref': track['key']}


def capture(case, *, actor=None, receipt=None, **options):
    receipt = receipt or case.receipt
    return case.service.capture(case.db.context(actor), top_ref=receipt['top_ref'],
        payload={'revision': receipt['revision']}, context_ref=CONTEXT, **options)


def resolve(case, *, source=None, actor=None, receipt=None, **options):
    receipt = receipt or case.receipt
    return case.service.resolve(case.db.context(actor), top_ref=receipt['top_ref'],
        payload=source or emitted_source(case, receipt=receipt), context_ref=CONTEXT, **options)


@contextmanager
def record_runtime(database):
    """Observe complete real driver operations without substituting authority."""
    original = database.service._connect
    statements, opened = [], []

    class Observed:
        def __init__(self, real):
            self.real = real
            self.verified = False

        def execute(self, sql, params=None, *args, **kwargs):
            cursor = self.real.execute(sql, params, *args, **kwargs)
            normalized = ' '.join(str(sql).lower().split())
            statements.append((normalized, params, cursor.rowcount))
            # The transaction owner must establish isolation before any SELECT,
            # including the read-only role proof performed by this observer.
            if not self.verified:
                assert normalized == 'set transaction isolation level read committed'
                assert_runtime_role(self.real, database)
                self.verified = True
            return cursor

        def __getattr__(self, name):
            return getattr(self.real, name)

    @contextmanager
    def connect(url):
        assert url == database.app_url
        with original(url) as connection:
            opened.append(connection)
            yield Observed(connection)

    database.service._connect = connect
    try:
        yield statements, opened
    finally:
        database.service._connect = original


@pytest.fixture
def native_queue(db, tmp_path):
    root = tmp_path / 'top-native-library'
    root.mkdir()
    with db.connect() as connection:
        root_id = connection.execute('''insert into library.library_roots(library_id,root_path,metadata)
            values(%s,%s,'{"root_id":"synthetic-top-native-root"}'::jsonb) returning id''',
            (db.library, str(root))).fetchone()['id']
        connection.execute('''insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
            values(%s,%s,'library',%s)''', (db.owner.account_id, MEDIA, db.library))
    db.owner = replace(db.owner, capability_grants=(*db.owner.capability_grants,
        CapabilityGrant(MEDIA, 'library', db.library)))
    specs = [(0, 2, 1), (0, 1, 2), (0, 1, 1), (0, 1, 1), (0, None, None), (1, 1, 1)]
    tracks = [seed_track(db, root, root_id, db.album_ids[album], disc=disc, number=number)
              for album, disc, number in specs]
    probes = []

    def media(config, path, **options):
        probes.append(path)
        return resolve_configured_media_path(config, path,
            **{'configured_root_paths': (root,), **options})

    receipt, _ = db.create(refs=list(reversed(db.album_refs[:2])))
    return SimpleNamespace(db=db, root=root, root_id=root_id, tracks=tracks, receipt=receipt,
        service=AlbumTopNativeQueue(db.service, media_resolver=media), probes=probes)
