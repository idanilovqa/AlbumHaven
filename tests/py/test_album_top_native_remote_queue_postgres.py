"""Retained remote membership never becomes native authority through coincidence."""
import pytest

from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.private_native_targets import PrivateNativeTargets
from tests.py.album_top_native_queue_postgres_support import native_queue, capture, resolve, db, urls
from tests.py.remote_top_postgres_support import remote
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed


def test_remote_member_with_real_coincident_local_tracks_is_reported_and_never_resolved(native_queue, mixed, monkeypatch):
    case = native_queue
    assert mixed.db is case.db
    receipt, _ = mixed.create(local=False)
    item = mixed.read(receipt)['items'][0]
    assert item['source_kind'] == 'remote_summary'
    track = case.tracks[0]
    with case.db.connect() as connection:
        connection.execute('update library.catalog_album_links set catalog_ref=%s where local_album_id=%s',
                           (item['catalog_ref'], track['album_id']))
    before = mixed.snapshot()
    provider_calls = len(mixed.remote.calls)
    result = capture(case, receipt=receipt)
    assert result == {'top_ref': receipt['top_ref'], 'revision': receipt['revision'], 'albums': [],
                      'unavailable_items': [{'item_ref': item['ref'], 'reason': 'remote_summary'}]}
    source = {'revision': receipt['revision'], 'item_ref': item['ref'], 'catalog_ref': item['catalog_ref'],
        'inventory_album_ref': f"inventory-album:{case.db.library}:{track['album_id']}",
        'inventory_track_ref': f"inventory-track:{case.db.library}:{track['id']}",
        'canonical_track_ref': track['key']}

    def unexpected_native(*args, **kwargs):
        raise AssertionError('Retained remote membership cannot enter native playback resolution')

    monkeypatch.setattr(PrivateNativeTargets, 'resolve', unexpected_native)
    with pytest.raises(AlbumTopError) as caught:
        resolve(case, source=source, receipt=receipt)
    assert (caught.value.code, caught.value.status_code) == ('item_unavailable', 404)
    assert track['title'] not in str(caught.value) and str(track['path']) not in str(caught.value)
    assert case.probes == [] and len(mixed.remote.calls) == provider_calls
    assert mixed.snapshot() == before
