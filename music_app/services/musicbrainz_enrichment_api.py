from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone

from music_app.services.musicbrainz_client import MusicBrainzClient, artist_url
from music_app.services.musicbrainz_enrichment import MusicBrainzEnrichmentScheduler
from music_app.services.musicbrainz_enrichment_postgres import (
    MusicBrainzEnrichmentPostgresRepository,
)


class MusicBrainzProviderUnavailable(RuntimeError):
    """The configured MusicBrainz service could not verify an artist."""


class MusicBrainzEnrichmentApiService:
    """Owner management operations behind ``/api/musicbrainz/artists``.

    The route layer owns authorization; this service owns provider
    verification, which always happens before any write transaction.
    """

    def __init__(
        self,
        repository,
        client,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._repository = repository
        self._client = client
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._scheduler = MusicBrainzEnrichmentScheduler(repository, now=self._now)

    def list_present_artist_review(self) -> list[dict[str, object]]:
        return self._repository.list_present_artist_review()

    def get_artist_problem(self, *, local_artist_id: int) -> dict[str, object] | None:
        return self._repository.get_artist_problem(local_artist_id=local_artist_id)

    def enqueue_eligible_artists(self, *, reason: str) -> dict[str, int]:
        return self._repository.enqueue_eligible_artists(reason=reason, observed_at=self._now())

    def enqueue_artist(self, *, local_artist_id: int, reason: str) -> dict[str, bool]:
        return self._scheduler.schedule(reason, local_artist_id=local_artist_id)

    def validate_manual_artist(
        self,
        *,
        local_artist_id: int,
        artist_reference: str,
    ) -> dict[str, object] | None:
        if self._repository.get_artist_problem(local_artist_id=local_artist_id) is None:
            return None
        artist = self._verified_artist(artist_reference)
        if artist is None:
            return None
        return {
            "artist_mbid": artist["mbid"],
            "canonical_name": artist.get("canonical_name"),
            "native_name": artist.get("preferred_native_name"),
            "country": artist.get("country_code"),
            "genres": [],
            "confidence": 1,
            "evidence_summary": "Verified as a MusicBrainz artist.",
            "musicbrainz_url": artist_url(artist["mbid"]),
        }

    def assign_manual_match(
        self,
        *,
        local_artist_id: int,
        actor_account_id: int,
        artist_mbid: str,
        evidence_summary: str,
        request_ref: str,
    ) -> dict[str, bool]:
        artist = self._verified_artist(artist_mbid)
        if artist is None:
            return {"assigned": False}
        assigned = self._repository.assign_manual_match(
            local_artist_id=local_artist_id,
            actor_account_id=actor_account_id,
            artist=artist,
            confidence=1,
            evidence_summary=evidence_summary,
            observed_at=self._now(),
            request_ref=request_ref,
        )
        return {"assigned": bool(assigned)}

    def _verified_artist(self, artist_reference: str) -> Mapping[str, object] | None:
        mbid = str(artist_reference or "").strip().removeprefix("https://musicbrainz.org/artist/").strip("/")
        lookup = self._client.lookup_artist(mbid)
        classification = lookup.get("classification")
        if classification == "matched":
            return lookup["artist"]
        if classification in {"not_found", "invalid_request", "invalid_response"}:
            return None
        raise MusicBrainzProviderUnavailable(str(classification))


def build_musicbrainz_enrichment_api_service(config: Mapping[str, object]) -> MusicBrainzEnrichmentApiService:
    return MusicBrainzEnrichmentApiService(
        MusicBrainzEnrichmentPostgresRepository(config),
        MusicBrainzClient(
            base_url=str(config.get("MUSICBRAINZ_BASE_URL") or ""),
            user_agent=str(config.get("MUSICBRAINZ_USER_AGENT") or "Album Haven"),
        ),
    )
