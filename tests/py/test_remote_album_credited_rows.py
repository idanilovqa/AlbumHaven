"""Independent stored-credit adapter contracts; display remains scalar-only."""
from uuid import UUID
import pytest
from music_app.services.album_top_remote_sources import evidence_from_row, project_remote_summary
from music_app.services.owned_album_tops import AlbumTopError
from tests.py.test_remote_album_credited_evidence import legacy, provider_payload, GROUP, ARTIST
from music_app.services.remote_album_evidence import project_release_group_evidence


def row(facts):
    return dict(provider='musicbrainz', entity_kind='release-group', external_id=facts.release_group_id,
        title=facts.title, artist_display=facts.artist_display, first_release_date=facts.first_release_date,
        primary_type=facts.primary_type, evidence_version=facts.digest)


@pytest.mark.parametrize('present', [False, True])
def test_legacy_row_without_credits_or_with_null_keeps_v1(present):
    facts = legacy()
    stored = row(facts)
    if present:
        stored['credited_artist_ids'] = None
    assert evidence_from_row(stored) == facts
    assert evidence_from_row(stored).credited_artist_ids is None


def test_database_uuid_array_detaches_as_immutable_canonical_tuple():
    facts = project_release_group_evidence(provider_payload(), requested_id=GROUP)
    stored = row(facts)
    stored['credited_artist_ids'] = [UUID(ARTIST)]
    result = evidence_from_row(stored)
    assert result == facts and result.credited_artist_ids == (ARTIST,)
    stored['credited_artist_ids'].clear()
    assert result.credited_artist_ids == (ARTIST,)
    assert set(project_remote_summary(result)) == {
        'source_kind', 'provider', 'entity_kind', 'release_group_id', 'title',
        'artist_display', 'first_release_date', 'primary_type', 'metadata_coverage',
        'track_metadata_status', 'track_count'}


@pytest.mark.parametrize('credits', [None, [], [None], [UUID(GROUP)], [UUID(ARTIST)] * 101])
def test_mismatched_or_malformed_stored_credits_fail_closed(credits):
    facts = project_release_group_evidence(provider_payload(), requested_id=GROUP)
    stored = row(facts)
    stored['credited_artist_ids'] = credits
    with pytest.raises(AlbumTopError) as caught:
        evidence_from_row(stored)
    assert caught.value.code == 'remote_evidence_unavailable'
