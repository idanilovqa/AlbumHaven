from __future__ import annotations

from datetime import datetime, timezone

import pytest

from music_app.services.musicbrainz_enrichment_api import (
    MusicBrainzEnrichmentApiService,
    MusicBrainzProviderUnavailable,
    build_musicbrainz_enrichment_api_service,
)


NOW = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)
MBID = "b0fe8ef0-d59b-4d41-afee-2d21b59112ab"


class FakeRepository:
    def __init__(self, *, problem=True):
        self.problem = problem
        self.calls = []

    def get_artist_problem(self, *, local_artist_id):
        self.calls.append(("get", local_artist_id))
        return {"local_artist_id": local_artist_id, "candidates": []} if self.problem else None

    def assign_manual_match(self, **kwargs):
        self.calls.append(("assign", kwargs))
        return True

    def enqueue_artist(self, **kwargs):
        self.calls.append(("enqueue", kwargs))
        return {"enqueued": True}

    def enqueue_eligible_artists(self, **kwargs):
        self.calls.append(("sync", kwargs))
        return {"enqueued_count": 4}


class FakeClient:
    def __init__(self, classification="matched"):
        self.classification = classification
        self.lookups = []

    def lookup_artist(self, mbid):
        self.lookups.append(mbid)
        if self.classification != "matched":
            return {"classification": self.classification, "artist": None}
        return {"classification": "matched", "artist": {
            "mbid": MBID, "canonical_name": "Angra", "preferred_native_name": None,
            "country_code": "BR", "artist_type": "Group",
        }}


def service(repository=None, client=None):
    return MusicBrainzEnrichmentApiService(
        repository or FakeRepository(), client or FakeClient(), now=lambda: NOW,
    )


def test_validation_accepts_a_url_and_returns_a_safe_verified_candidate():
    client = FakeClient()

    candidate = service(client=client).validate_manual_artist(
        local_artist_id=7, artist_reference=f"https://musicbrainz.org/artist/{MBID}",
    )

    assert client.lookups == [MBID]
    assert candidate["artist_mbid"] == MBID
    assert candidate["musicbrainz_url"] == f"https://musicbrainz.org/artist/{MBID}"
    assert candidate["country"] == "BR"


def test_validation_rejects_wrong_entities_and_unknown_artists():
    assert service(client=FakeClient("not_found")).validate_manual_artist(
        local_artist_id=7, artist_reference=MBID,
    ) is None
    assert service(repository=FakeRepository(problem=False)).validate_manual_artist(
        local_artist_id=7, artist_reference=MBID,
    ) is None


@pytest.mark.parametrize("classification", ["provider_unavailable", "rate_limited", "catch_up_pending"])
def test_provider_failures_surface_as_unavailable_instead_of_not_found(classification):
    with pytest.raises(MusicBrainzProviderUnavailable):
        service(client=FakeClient(classification)).validate_manual_artist(
            local_artist_id=7, artist_reference=MBID,
        )


def test_assignment_verifies_with_the_provider_before_the_write():
    repository = FakeRepository()
    client = FakeClient()

    result = service(repository, client).assign_manual_match(
        local_artist_id=7, actor_account_id=3, artist_mbid=MBID,
        evidence_summary="Owner selected Angra.", request_ref="req-1",
    )

    assert result == {"assigned": True}
    assert client.lookups == [MBID]
    [(kind, kwargs)] = [call for call in repository.calls if call[0] == "assign"]
    assert kwargs["artist"]["mbid"] == MBID
    assert kwargs["actor_account_id"] == 3
    assert kwargs["observed_at"] == NOW


def test_assignment_of_an_unverified_identifier_never_writes():
    repository = FakeRepository()

    result = service(repository, FakeClient("not_found")).assign_manual_match(
        local_artist_id=7, actor_account_id=3, artist_mbid=MBID,
        evidence_summary="Owner selected Angra.", request_ref="req-1",
    )

    assert result == {"assigned": False}
    assert not [call for call in repository.calls if call[0] == "assign"]


def test_retry_and_sync_schedule_idempotent_work():
    repository = FakeRepository()
    api = service(repository)

    assert api.enqueue_artist(local_artist_id=7, reason="authorized_retry") == {"enqueued": True}
    assert api.enqueue_eligible_artists(reason="library_menu_sync") == {"enqueued_count": 4}
    assert ("enqueue", {"local_artist_id": 7, "reason": "authorized_retry", "observed_at": NOW}) in repository.calls


def test_builder_uses_the_configured_mirror_and_never_negative_caches():
    api = build_musicbrainz_enrichment_api_service({
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/album_haven_test",
        "MUSICBRAINZ_BASE_URL": "http://localhost:5050/ws/2/",
    })

    assert api._client.base_url == "http://localhost:5050/ws/2"
    assert api._client.get_json.keywords == {"cache_failures": False}
