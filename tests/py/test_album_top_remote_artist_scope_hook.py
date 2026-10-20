"""The internal resolver cannot silently omit a constrained admission owner."""
from uuid import uuid4

import pytest

from music_app.services.album_top_remote_membership import resolve_sources
from music_app.services.owned_album_tops import AlbumTopError


class NoSourceWork:
    def execute(self, *args, **kwargs):
        raise AssertionError('Missing admission hook must reject before source SQL')


@pytest.mark.parametrize('kind,field', [
    ('remote_acquisition', 'acquisition_ref'), ('remote_retained', 'admission_ref')])
@pytest.mark.parametrize('identity_only', [False, True])
def test_scoped_remote_resolution_requires_internal_hook_before_source_work(kind, field, identity_only):
    selector = {'kind': kind, field: str(uuid4()), 'evidence_version': 'a' * 64}
    top = {'listen_through_artist_id': 17, 'listen_through_scope_mode': 'family'}
    with pytest.raises(AlbumTopError) as caught:
        resolve_sources(NoSourceWork(), None, top, [selector], None, 'a' * 64, [],
                        identity_only=identity_only)
    assert caught.value.code == 'artist_scope_unavailable'
    assert caught.value.status_code == 409


def test_ordinary_top_without_hook_keeps_existing_missing_evidence_error():
    selector = {'kind': 'remote_acquisition', 'acquisition_ref': str(uuid4()),
                'evidence_version': 'a' * 64}
    with pytest.raises(AlbumTopError) as caught:
        resolve_sources(NoSourceWork(), None, {'listen_through_artist_id': None},
                        [selector], None, 'a' * 64, [])
    assert caught.value.code == 'remote_evidence_unavailable'
    assert caught.value.status_code == 409
