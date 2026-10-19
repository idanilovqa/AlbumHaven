"""A retained remote Top member never inherits a coincident local native target."""
from uuid import uuid4

import pytest

from music_app.services.album_top_native_targets import AlbumTopNativeTargets
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.private_native_targets import PrivateNativeTargets
from tests.py.remote_top_postgres_support import CONTEXT, db, urls, remote
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed


def test_remote_member_with_exact_local_catalog_mapping_is_still_not_a_native_details_source(mixed, monkeypatch):
    receipt, _ = mixed.create(local=False)
    item = mixed.read(receipt)['items'][0]
    assert item['source_kind'] == 'remote_summary'
    key = uuid4().hex
    with mixed.db.connect() as connection:
        album = connection.execute("""insert into library.local_albums(library_id,album_key,title)
            values(%s,%s,'Synthetic coincident local edition') returning id""",
            (mixed.db.library, key)).fetchone()['id']
        connection.execute('insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) '
            'values(%s,%s,%s)', (mixed.db.library, album, item['catalog_ref']))
    before = mixed.snapshot()
    provider_calls = len(mixed.remote.calls)

    def unexpected_native(*args, **kwargs):
        raise AssertionError('Remote membership must be rejected before native resolution')

    monkeypatch.setattr(PrivateNativeTargets, 'resolve_album', unexpected_native)
    with pytest.raises(AlbumTopError) as caught:
        AlbumTopNativeTargets(mixed.db.service).resolve(mixed.db.context(),
            top_ref=receipt['top_ref'], item_ref=item['ref'], revision=receipt['revision'],
            inventory_album_ref=f'inventory-album:{mixed.db.library}:{album}', context_ref=CONTEXT)
    assert (caught.value.code, caught.value.status_code) == ('item_unavailable', 404)
    assert key not in str(caught.value)
    assert len(mixed.remote.calls) == provider_calls
    assert mixed.snapshot() == before
