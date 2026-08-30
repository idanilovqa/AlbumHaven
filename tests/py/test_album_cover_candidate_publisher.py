from __future__ import annotations

from copy import deepcopy

from music_app.services.album_cover_candidate_publisher import (
    AlbumCoverCandidatePublisher,
)


ALBUM_ID = 41
GENERATION = "1d17c70f-dfa1-41e5-a335-c7c835b0d0ad"


class FakeSnapshotRepository:
    """Stateful repository double with the production repository's public shapes."""

    def __init__(self, snapshot=None, *, accept_publications=True):
        self.snapshot = deepcopy(snapshot)
        self.accept_publications = accept_publications
        self.publish_attempts = 0
        self.finish_attempts = 0

    def get_for_album_context(self, *, album_id):
        if self.snapshot is None or self.snapshot["album_id"] != album_id:
            return None
        return deepcopy(self.snapshot)

    def publish_generation(
        self,
        *,
        album_id,
        search_generation,
        search_kind,
        search_started_at,
        candidates,
        best_candidate_id,
        automatic_improvement,
    ):
        self.publish_attempts += 1
        if not self.accept_publications:
            return False
        current_revision = int((self.snapshot or {}).get("revision") or 0)
        automatic_revision = int(
            (self.snapshot or {}).get("automatic_improvement_revision") or 0
        )
        seen_revision = int(
            (self.snapshot or {}).get("seen_automatic_improvement_revision") or 0
        )
        self.snapshot = {
            "album_id": album_id,
            "search_generation": search_generation,
            "search_kind": search_kind,
            "status": "running",
            "revision": current_revision + 1,
            "candidates": deepcopy(candidates),
            "best_candidate_id": best_candidate_id,
            "automatic_improvement_revision": automatic_revision
            + int(bool(automatic_improvement)),
            "seen_automatic_improvement_revision": seen_revision,
            "automatic_improvement_candidate_id": (self.snapshot or {}).get(
                "automatic_improvement_candidate_id"
            ),
            "started_at": search_started_at,
            "updated_at": "2026-08-03T12:00:01+00:00",
            "finished_at": None,
        }
        return True

    def finish_generation(self, *, album_id, search_generation, status):
        self.finish_attempts += 1
        if (
            self.snapshot is None
            or self.snapshot["album_id"] != album_id
            or self.snapshot["search_generation"] != search_generation
        ):
            return False
        self.snapshot["status"] = status
        self.snapshot["updated_at"] = "2026-08-03T12:00:02+00:00"
        self.snapshot["finished_at"] = "2026-08-03T12:00:02+00:00"
        return True

    def mark_automatic_improvement(
        self,
        *,
        album_id,
        search_generation,
        candidate_id,
    ):
        if (
            self.snapshot is None
            or self.snapshot["album_id"] != album_id
            or self.snapshot["search_generation"] != search_generation
            or not any(
                candidate["id"] == candidate_id
                for candidate in self.snapshot["candidates"]
            )
        ):
            return False
        if self.snapshot.get("automatic_improvement_candidate_id") == candidate_id:
            return False
        self.snapshot["automatic_improvement_candidate_id"] = candidate_id
        self.snapshot["automatic_improvement_revision"] += 1
        self.snapshot["updated_at"] = "2026-08-03T12:00:01.500000+00:00"
        return True


def existing_snapshot():
    return {
        "album_id": ALBUM_ID,
        "search_generation": "7d4af778-4e52-449f-8c34-246537f85087",
        "search_kind": "manual",
        "status": "completed",
        "revision": 7,
        "candidates": [
            {
                "id": "existing",
                "source": "cover_art_archive",
                "source_label": "Cover Art Archive",
                "url": "https://old.example/cover.jpg",
                "thumbnail_url": "https://old.example/thumb.jpg",
                "width": 600,
                "height": 600,
                "score": 0.7,
            }
        ],
        "best_candidate_id": "existing",
        "automatic_improvement_revision": 2,
        "seen_automatic_improvement_revision": 1,
        "started_at": "2026-08-02T12:00:00+00:00",
        "updated_at": "2026-08-02T12:00:01+00:00",
        "finished_at": "2026-08-02T12:00:02+00:00",
    }


def publisher_for(repository, *, search_kind="manual"):
    publisher = AlbumCoverCandidatePublisher(
        repository,
        album_id=ALBUM_ID,
        search_generation=GENERATION,
        search_kind=search_kind,
    )
    publisher.begin_candidate_generation()
    return publisher


def raw_candidate(url="https://images.example/cover.jpg", **overrides):
    payload = {
        "source": "cover_art_archive",
        "source_label": "Cover Art Archive",
        "lookup_group": "cover_art_archive",
        "url": url,
        "thumbnail_url": "https://images.example/thumb.jpg",
        "width": 1200,
        "height": 1000,
        "score": 0.95,
        "artist": "Test Artist",
        "album": "Test Album",
        "year": 2001,
        "art_kind": "cover",
        "art_label": "Front cover",
        "album_url": "https://music.example/album/test-album",
        "display_only": False,
    }
    payload.update(overrides)
    return payload


def test_publish_allowlists_candidate_fields_and_removes_private_payloads():
    repository = FakeSnapshotRepository(existing_snapshot())
    publisher = publisher_for(repository)

    assert publisher.publish_candidates(
        [
            raw_candidate(
                raw_bytes=b"private image bytes",
                local_path=r"D:\\Music\\Album\\cover.jpg",
                credentials={"token": "secret"},
                request_body={"password": "secret"},
                debug={"raw_response": "private"},
                unknown_provider_payload={"anything": True},
            )
        ]
    ) is True

    stored = repository.snapshot["candidates"][0]
    assert set(stored) == {
        "id",
        "source",
        "source_label",
        "lookup_group",
        "url",
        "thumbnail_url",
        "width",
        "height",
        "score",
        "artist",
        "album",
        "year",
        "art_kind",
        "art_label",
        "album_url",
        "display_only",
    }
    assert "private image bytes" not in repr(repository.snapshot)
    assert "secret" not in repr(repository.snapshot)
    assert r"D:\\Music" not in repr(repository.snapshot)


def test_publish_preserves_public_resource_links_and_linked_only_policy():
    repository = FakeSnapshotRepository()

    assert publisher_for(repository).publish_candidates(
        [
            raw_candidate(
                source="spotify",
                source_label="Spotify",
                album_url="https://open.spotify.com/album/fixture",
                display_only=True,
            )
        ]
    )

    stored = repository.snapshot["candidates"][0]
    assert stored["source_label"] == "Spotify"
    assert stored["album_url"] == "https://open.spotify.com/album/fixture"
    assert stored["display_only"] is True


def test_publish_normalizes_http_urls_removes_fragments_and_assigns_stable_ids():
    first_repository = FakeSnapshotRepository()
    second_repository = FakeSnapshotRepository()

    assert publisher_for(first_repository).publish_candidates(
        [raw_candidate("HTTPS://Images.Example:443/covers/front.jpg#large")]
    )
    assert publisher_for(second_repository).publish_candidates(
        [raw_candidate("https://images.example/covers/front.jpg")]
    )

    first = first_repository.snapshot["candidates"][0]
    second = second_repository.snapshot["candidates"][0]
    assert first["url"] == "https://images.example/covers/front.jpg"
    assert first["id"] == second["id"]


def test_publish_preserves_existing_live_candidate_identity():
    repository = FakeSnapshotRepository()

    assert publisher_for(repository).publish_candidates(
        [raw_candidate(id="live-candidate-41")]
    )

    assert repository.snapshot["candidates"][0]["id"] == "live-candidate-41"
    assert repository.snapshot["best_candidate_id"] == "live-candidate-41"


def test_publish_rejects_non_public_or_secret_bearing_candidate_urls():
    repository = FakeSnapshotRepository(existing_snapshot())
    before = deepcopy(repository.snapshot)
    publisher = publisher_for(repository)

    assert publisher.publish_candidates(
        [
            raw_candidate("file:///D:/Music/Album/cover.jpg"),
            raw_candidate("http://127.0.0.1/private.jpg"),
            raw_candidate("http://192.168.1.20/private.jpg"),
            raw_candidate("https://user:password@images.example/cover.jpg"),
            raw_candidate("https://images.example/cover.jpg?access_token=secret"),
            raw_candidate("ftp://images.example/cover.jpg"),
        ]
    ) is False

    assert repository.snapshot == before
    assert repository.publish_attempts == 0


def test_publish_deduplicates_normalized_urls_and_ranks_best_candidate_first():
    repository = FakeSnapshotRepository()
    publisher = publisher_for(repository)

    assert publisher.publish_candidates(
        [
            raw_candidate(
                "https://images.example/same.jpg#small",
                source="deezer",
                score=0.4,
                width=300,
                height=300,
            ),
            raw_candidate(
                "HTTPS://IMAGES.EXAMPLE:443/same.jpg",
                source="spotify",
                score=0.9,
                width=1000,
                height=1000,
            ),
            raw_candidate(
                "https://images.example/best.jpg",
                source="cover_art_archive",
                score=0.99,
                width=1200,
                height=1200,
            ),
        ]
    )

    stored = repository.snapshot["candidates"]
    assert [item["url"] for item in stored] == [
        "https://images.example/best.jpg",
        "https://images.example/same.jpg",
    ]
    assert stored[1]["source"] == "spotify"
    assert repository.snapshot["best_candidate_id"] == stored[0]["id"]


def test_publish_caps_the_ranked_snapshot_at_24_candidates():
    repository = FakeSnapshotRepository()
    publisher = publisher_for(repository)
    candidates = [
        raw_candidate(
            f"https://images.example/{index}.jpg",
            score=index / 100,
            width=500 + index,
            height=500 + index,
        )
        for index in range(30)
    ]

    assert publisher.publish_candidates(candidates)

    stored = repository.snapshot["candidates"]
    assert len(stored) == 24
    assert [item["score"] for item in stored] == sorted(
        (item["score"] for item in stored), reverse=True
    )
    assert stored[0]["url"] == "https://images.example/29.jpg"
    assert stored[-1]["url"] == "https://images.example/6.jpg"


def test_first_valid_candidate_starts_replacement_but_invalid_stage_preserves_old_snapshot():
    repository = FakeSnapshotRepository(existing_snapshot())
    publisher = publisher_for(repository)
    before = deepcopy(repository.snapshot)

    assert publisher.publish_candidates([]) is False
    assert publisher.publish_candidates([raw_candidate("file:///private/cover.jpg")]) is False
    assert repository.snapshot == before

    assert publisher.publish_candidates([raw_candidate()]) is True
    assert repository.snapshot["search_generation"] == GENERATION
    assert repository.snapshot["candidates"][0]["url"] == "https://images.example/cover.jpg"


def test_zero_result_completion_preserves_the_previous_snapshot():
    repository = FakeSnapshotRepository(existing_snapshot())
    publisher = publisher_for(repository)
    before = deepcopy(repository.snapshot)

    assert publisher.publish_candidates([]) is False
    assert publisher.complete() is False

    assert repository.snapshot == before
    assert repository.publish_attempts == 0
    assert repository.finish_attempts == 0


def test_failure_after_candidates_retains_partial_snapshot_and_marks_it_failed():
    repository = FakeSnapshotRepository(existing_snapshot())
    publisher = publisher_for(repository)

    assert publisher.publish_candidates([raw_candidate()]) is True
    partial_candidates = deepcopy(repository.snapshot["candidates"])
    assert publisher.fail() is True

    assert repository.snapshot["status"] == "failed"
    assert repository.snapshot["candidates"] == partial_candidates
    assert repository.snapshot["finished_at"] is not None


def test_repository_rejection_owns_generation_precedence():
    repository = FakeSnapshotRepository(existing_snapshot(), accept_publications=False)
    publisher = publisher_for(repository, search_kind="automatic")
    before = deepcopy(repository.snapshot)

    assert publisher.publish_candidates([raw_candidate()]) is False
    assert publisher.complete() is False

    assert repository.publish_attempts == 1
    assert repository.finish_attempts == 0
    assert repository.snapshot == before


def test_repository_rejection_retains_candidates_for_a_later_accepted_stage():
    repository = FakeSnapshotRepository(accept_publications=False)
    publisher = publisher_for(repository)
    candidate_a_url = "https://images.example/candidate-a.jpg"
    candidate_b_url = "https://images.example/candidate-b.jpg"

    assert publisher.publish_candidates(
        [
            raw_candidate(
                f"{candidate_a_url}#preview",
                source="deezer",
                score=0.4,
                width=300,
                height=300,
            ),
            raw_candidate(
                candidate_a_url,
                source="cover_art_archive",
                score=0.8,
                width=1000,
                height=1000,
            ),
        ]
    ) is False

    repository.accept_publications = True
    assert publisher.publish_candidates(
        [raw_candidate(candidate_b_url, score=0.95, width=1200, height=1200)]
    ) is True

    assert [candidate["url"] for candidate in repository.snapshot["candidates"]] == [
        candidate_b_url,
        candidate_a_url,
    ]
    assert repository.snapshot["candidates"][1]["source"] == "cover_art_archive"


def test_automatic_improvement_can_advance_after_candidate_payload_was_published():
    repository = FakeSnapshotRepository()
    publisher = publisher_for(repository, search_kind="automatic")

    assert publisher.publish_candidates([raw_candidate()]) is True
    candidates_before_improvement = deepcopy(repository.snapshot["candidates"])
    candidate_id = repository.snapshot["best_candidate_id"]
    revision_before_improvement = repository.snapshot[
        "automatic_improvement_revision"
    ]
    seen_before_improvement = repository.snapshot[
        "seen_automatic_improvement_revision"
    ]

    assert publisher.mark_automatic_improvement(candidate_id) is True

    assert repository.snapshot["candidates"] == candidates_before_improvement
    assert repository.snapshot["best_candidate_id"] == candidate_id
    assert repository.snapshot["automatic_improvement_revision"] == (
        revision_before_improvement + 1
    )
    assert (
        repository.snapshot["seen_automatic_improvement_revision"]
        == seen_before_improvement
    )


def test_automatic_improvement_marks_the_exact_qualifying_candidate():
    repository = FakeSnapshotRepository()
    publisher = publisher_for(repository, search_kind="automatic")
    higher_ranked = raw_candidate(
        "https://images.example/higher-ranked.jpg",
        score=0.99,
        width=300,
        height=300,
    )
    qualifying = raw_candidate(
        "https://images.example/qualifying.jpg",
        score=0.80,
        width=1800,
        height=1800,
    )

    assert publisher.publish_candidates([higher_ranked]) is True
    assert publisher.publish_candidates([qualifying]) is True
    qualifying_id = publisher.candidate_id_for(qualifying)

    assert qualifying_id is not None
    assert qualifying_id != publisher.best_candidate_id
    assert publisher.mark_automatic_improvement(qualifying_id) is True
    assert repository.snapshot["automatic_improvement_candidate_id"] == qualifying_id


def test_identical_automatic_improvement_does_not_alert_in_a_later_generation():
    repository = FakeSnapshotRepository()
    first = publisher_for(repository, search_kind="automatic")
    candidate = raw_candidate()
    assert first.publish_candidates([candidate]) is True
    candidate_id = first.candidate_id_for(candidate)
    assert first.mark_automatic_improvement(candidate_id) is True
    first_revision = repository.snapshot["automatic_improvement_revision"]

    second = AlbumCoverCandidatePublisher(
        repository,
        album_id=ALBUM_ID,
        search_generation="74986bfb-3a45-49fa-9edf-28879e301fea",
        search_kind="automatic",
    )
    assert second.publish_candidates([candidate]) is True
    assert second.mark_automatic_improvement(second.candidate_id_for(candidate)) is False
    assert repository.snapshot["automatic_improvement_revision"] == first_revision
