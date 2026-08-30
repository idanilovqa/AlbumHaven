from __future__ import annotations

import pytest

from music_app.services import music_identity_matching as identity


@pytest.mark.parametrize(
    ("target_artist", "candidate_artist"),
    [
        ("Morse, Portnoy & George", "Morse Portnoy George"),
        ("AC/DC", "ACDC"),
        ("The Meters", "TheMeters"),
        ("Beyonce", "Beyonc\u00e9"),
    ],
)
def test_same_artist_identity_accepts_equivalent_external_credits(
    target_artist,
    candidate_artist,
):
    assert identity.same_artist_identity(target_artist, candidate_artist) is True


@pytest.mark.parametrize(
    ("target_artist", "candidate_artist"),
    [
        ("AC/DC", "AC/DC Tribute"),
        ("Metallica", "Metallica & Discrepancies"),
    ],
)
def test_same_artist_identity_rejects_distinct_external_credits(
    target_artist,
    candidate_artist,
):
    assert identity.same_artist_identity(target_artist, candidate_artist) is False


def test_normalize_search_text_expands_meaningful_symbols():
    assert (
        identity.normalize_search_text("AC/DC & R+D? + 100%")
        == "ac dc and r plus d question mark plus 100 percent"
    )


def test_artist_identity_transliterates_cyrillic_consistently():
    assert identity.normalize_search_text("\u041a\u0438\u043d\u043e \u0401\u043b\u043a\u0430") == "kino yolka"
    assert identity.same_artist_identity("\u041a\u0438\u043d\u043e", "Kino") is True
    assert identity.artist_identity_similarity("\u041a\u0438\u043d\u043e", "Kino") == pytest.approx(1.0)


def test_empty_artist_identities_never_match():
    assert identity.same_artist_identity("", "") is False
    assert identity.same_artist_identity("Artist", "") is False
    assert identity.artist_identity_similarity("", "Artist") == 0.0


@pytest.mark.parametrize(
    ("target_artist", "candidate_artist"),
    [
        ("Morse, Portnoy & George", "Morse Portnoy George"),
        ("Flaming Rows", "Flaming Row"),
        ("Morse Portnoy George", "Morse Portnoy Georg"),
        ("The Beatles", "Beatles"),
    ],
)
def test_automatic_artist_identity_match_allows_equivalent_and_same_shape_fuzzy_names(
    target_artist,
    candidate_artist,
):
    assert (
        identity.automatic_artist_identity_match_allowed(
            target_artist,
            candidate_artist,
        )
        is True
    )


@pytest.mark.parametrize(
    ("target_artist", "candidate_artist"),
    [
        ("Jimi Hendrix", "The Jimi Hendrix Experience"),
        ("Electric Light", "Electric Light Orchestra"),
        ("Alan Parsons", "The Alan Parsons Project"),
        ("Metallica", "Metallica Tribute"),
        ("Metallica", "Metallica Cover Band"),
        ("Metallica", "Metallica & Discrepancies"),
        ("Robert Plant", "Robert Plant and Alison Krauss"),
        ("Alan Parsons", "Alan Project"),
        ("Example Ensemble", "Example Project"),
        ("The Signals", "The Signal"),
    ],
)
def test_automatic_artist_identity_match_rejects_added_or_removed_identity_members(
    target_artist,
    candidate_artist,
):
    assert (
        identity.automatic_artist_identity_match_allowed(
            target_artist,
            candidate_artist,
        )
        is False
    )


@pytest.mark.parametrize(
    ("target_artist", "candidate_artist"),
    [
        ("Muse", "Rush"),
        ("Blur", "Korn"),
    ],
)
def test_automatic_artist_identity_match_rejects_unrelated_same_shape_names(
    target_artist,
    candidate_artist,
):
    """Equal token counts alone must not authorize an automatic provider match."""
    assert (
        identity.automatic_artist_identity_match_allowed(
            target_artist,
            candidate_artist,
        )
        is False
    )
