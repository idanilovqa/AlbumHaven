from __future__ import annotations

import pytest

from music_app.services.edition_title_normalization import (
    match_official_edition_title,
    parse_edition_title,
    reviewable_edition_title,
)


@pytest.mark.parametrize(
    ("title", "canonical_title", "edition"),
    [
        ("300 (The Collector's Edition)", "300", "The Collector's Edition"),
        ("Album [Deluxe Edition]", "Album", "Deluxe Edition"),
        ("Album (40th Anniversary Edition)", "Album", "40th Anniversary Edition"),
        ("Album (Expanded & Remastered)", "Album", "Expanded & Remastered"),
        ("Album [Limited Tour Edition]", "Album", "Limited Tour Edition"),
    ],
)
def test_parse_edition_title_extracts_only_terminal_high_confidence_editions(
    title,
    canonical_title,
    edition,
):
    assert parse_edition_title(title) == {
        "title": canonical_title,
        "edition": edition,
    }


@pytest.mark.parametrize(
    "title",
    [
        "Album (2024)",
        "Album (Part II)",
        "Album [Volume 2]",
        "Album (Act I)",
        "Album (Disc 2)",
        "Album (Season 3)",
        "Lost: Season 5 (Original Television Soundtrack)",
        "Album (Deluxe Soundtrack Edition)",
        "The Journey Continues (Live)",
        "Track (Remastered)",
        "(Deluxe Edition)",
        "Album (Deluxe Edition]",
        "Album [Deluxe Edition)",
        "Album (Deluxe Edition) extra",
    ],
)
def test_parse_edition_title_rejects_identity_and_release_type_false_positives(title):
    assert parse_edition_title(title) is None


def test_official_release_title_must_exactly_confirm_the_shorter_title():
    assert match_official_edition_title(
        "Album (Deluxe Edition)",
        official_title="Album",
        source_id="musicbrainz-release-id",
    ) == {
        "title": "Album",
        "edition": "Deluxe Edition",
        "source_id": "musicbrainz-release-id",
    }
    assert match_official_edition_title(
        "Album (Deluxe Edition)",
        official_title="Album (Deluxe Edition)",
        source_id="musicbrainz-release-id",
    ) is None
    assert match_official_edition_title(
        "Album (Deluxe Edition)",
        official_title="Different Album",
        source_id="musicbrainz-release-id",
    ) is None
    assert match_official_edition_title(
        "Album (Deluxe Edition)",
        official_title="Album",
        source_id="",
    ) is None


def test_reviewable_edition_title_requires_no_conflicting_existing_edition():
    assert reviewable_edition_title(
        "Album (Deluxe Edition)", ""
    ) == {"title": "Album", "edition": "Deluxe Edition"}
    assert reviewable_edition_title(
        "Album (Deluxe Edition)", "Deluxe Edition"
    ) == {"title": "Album", "edition": "Deluxe Edition"}
    assert reviewable_edition_title(
        "Album (Deluxe Edition)", "Standard Edition"
    ) is None
