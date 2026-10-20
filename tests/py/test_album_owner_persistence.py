from __future__ import annotations

import pytest

from music_app.services.library import build_albums_from_file_cache
from music_app.services import scan_cache_persistence


def _file_cache(
    *,
    album: str,
    album_artist: str,
    track_artists: tuple[str, ...],
    is_compilation: bool | None = None,
) -> dict[str, dict[str, object]]:
    file_cache = {}
    for index, track_artist in enumerate(track_artists, start=1):
        path = f"C:/Music/{album}/{index:02d}.flac"
        file_cache[path] = {
            "path": path,
            "mtime": 1.0,
            "size": 123,
            "album": album,
            "album_artist": album_artist,
            "artist": track_artist,
            "title": f"Track {index}",
            "track_number": index,
            "disc_number": 1,
            "disc_number_raw": "1",
            "year": 2020,
            "duration_seconds": 100,
        }
        if is_compilation is not None:
            file_cache[path]["is_compilation"] = is_compilation
    return file_cache


def _published_rows(
    monkeypatch,
    *,
    album: str,
    album_artist: str,
    track_artists: tuple[str, ...],
    is_compilation: bool | None = None,
    persisted_album_artists: tuple[str | None, ...] | None = None,
):
    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    file_cache = _file_cache(
        album=album,
        album_artist=album_artist,
        track_artists=track_artists,
        is_compilation=is_compilation,
    )
    albums = build_albums_from_file_cache(file_cache)
    assert len(albums) == 1
    if persisted_album_artists is not None:
        assert len(persisted_album_artists) == len(file_cache)
        for entry, persisted_album_artist in zip(
            file_cache.values(),
            persisted_album_artists,
            strict=True,
        ):
            if persisted_album_artist is None:
                entry["album_artist"] = None
            else:
                entry["album_artist"] = persisted_album_artist
    return albums[0], scan_cache_persistence._inventory_rows_from_albums(
        file_cache,
        albums,
    )


def test_unanimous_album_artist_owns_release_while_track_artists_stay_featured(
    monkeypatch,
):
    album, rows = _published_rows(
        monkeypatch,
        album="Excalibur II: L'Anneau Des Celtes",
        album_artist="Alan Simon",
        track_artists=("Jon Anderson", "Jon Anderson", "Moya Brennan"),
        is_compilation=False,
    )
    artist_rows, album_rows, featured_rows, track_rows, _track_file_rows = rows

    assert album.album_artist == "Alan Simon"
    assert album_rows[0]["artist_key"] == "alan simon"
    assert album_rows[0]["metadata"]["album_artist"] == "Alan Simon"
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "owner"
    } == {"alan simon"}
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "featured_track_artist"
    } == {"jon anderson", "moya brennan"}
    assert not [
        row
        for row in featured_rows
        if row["featured_kind"] == "featured_member"
    ]
    assert {row["artist_key"] for row in track_rows} == {
        "jon anderson",
        "moya brennan",
    }
    assert {row["artist_key"] for row in artist_rows} == {
        "alan simon",
        "jon anderson",
        "moya brennan",
    }


def test_composite_one_off_credit_keeps_the_classified_owner_at_persistence(
    monkeypatch,
):
    album, rows = _published_rows(
        monkeypatch,
        album="The Hobbit: Desolation Of Smaug",
        album_artist="Howard Shore / Billy Boyd",
        track_artists=("Howard Shore", "Howard Shore", "Howard Shore", "Billy Boyd"),
    )
    artist_rows, album_rows, featured_rows, track_rows, _track_file_rows = rows

    assert album.album_artist == "Howard Shore"
    assert album_rows[0]["artist_key"] == "howard shore"
    assert album_rows[0]["metadata"]["album_artist"] == "Howard Shore"
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "owner"
    } == {"howard shore"}
    assert not [
        row
        for row in featured_rows
        if row["featured_kind"] == "featured_member"
    ]
    assert {row["artist_key"] for row in track_rows} == {
        "howard shore",
        "billy boyd",
    }
    assert {row["artist_key"] for row in artist_rows} == {
        "howard shore",
        "billy boyd",
    }


def test_unanimous_dominant_owner_keeps_one_off_guest_album_non_compilation(
    monkeypatch,
):
    album, rows = _published_rows(
        monkeypatch,
        album="Owner-Led Guest Album",
        album_artist="Album Owner",
        track_artists=("Album Owner", "Album Owner", "Guest Artist"),
    )
    artist_rows, album_rows, featured_rows, track_rows, _track_file_rows = rows

    assert album.album_artist == "Album Owner"
    assert album.is_compilation is False
    assert album_rows[0]["artist_key"] == "album owner"
    assert album_rows[0]["metadata"]["is_compilation"] is False
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "owner"
    } == {"album owner"}
    assert not [
        row
        for row in featured_rows
        if row["featured_kind"] == "featured_member"
    ]
    assert {row["artist_key"] for row in track_rows} == {
        "album owner",
        "guest artist",
    }
    assert {row["artist_key"] for row in artist_rows} == {
        "album owner",
        "guest artist",
    }


@pytest.mark.parametrize(
    "track_artist",
    [
        pytest.param("BEYONCÉ", id="case"),
        pytest.param("Beyoncé.", id="punctuation"),
        pytest.param("Beyonce\u0301", id="unicode-composition"),
        pytest.param("Beyonce", id="diacritic"),
    ],
)
def test_owner_equivalent_track_credit_is_not_persisted_as_featured(
    monkeypatch,
    track_artist,
):
    _album, rows = _published_rows(
        monkeypatch,
        album="Owner Credit Variants",
        album_artist="Beyoncé",
        track_artists=(track_artist,),
    )

    _artist_rows, _album_rows, featured_rows, _track_rows, _track_file_rows = rows

    assert [
        (row["artist_key"], row["featured_kind"])
        for row in featured_rows
    ] == [("beyoncé", "owner")]


def test_owner_equivalent_album_member_does_not_create_duplicate_artist(
    monkeypatch,
):
    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    file_cache = _file_cache(
        album="Owner Member Variant",
        album_artist="Beyoncé",
        track_artists=("Beyoncé",),
    )
    albums = build_albums_from_file_cache(file_cache)
    assert len(albums) == 1
    albums[0].artists = ["Beyoncé", "Beyonce"]

    artist_rows, _album_rows, featured_rows, _track_rows, _track_file_rows = (
        scan_cache_persistence._inventory_rows_from_albums(file_cache, albums)
    )

    assert [row["artist_key"] for row in artist_rows] == ["beyoncé"]
    assert [
        (row["artist_key"], row["featured_kind"])
        for row in featured_rows
    ] == [("beyoncé", "owner")]


def test_owner_variant_with_guest_keeps_only_guest_featured(monkeypatch):
    _album, rows = _published_rows(
        monkeypatch,
        album="Owner Variant With Guest",
        album_artist="Beyoncé",
        track_artists=("BEYONCE. feat. Guest Artist",),
    )

    _artist_rows, _album_rows, featured_rows, _track_rows, _track_file_rows = rows

    assert {
        (row["artist_key"], row["featured_kind"])
        for row in featured_rows
    } == {
        ("beyoncé", "owner"),
        ("guest artist", "featured_track_artist"),
    }


@pytest.mark.parametrize(
    ("album_artist", "track_artist"),
    [
        pytest.param("Kino", "Кино", id="different-script"),
        pytest.param("M", "MØ", id="non-ascii-letter"),
        pytest.param("क", "क़", id="script-letter-mark"),
        pytest.param("M", "M+", id="meaningful-symbol"),
    ],
)
def test_distinct_artist_credit_remains_featured(
    monkeypatch,
    album_artist,
    track_artist,
):
    _album, rows = _published_rows(
        monkeypatch,
        album="Distinct Artist Credits",
        album_artist=album_artist,
        track_artists=(track_artist,),
    )

    _artist_rows, _album_rows, featured_rows, _track_rows, _track_file_rows = rows

    assert {
        (row["artist_key"], row["featured_kind"])
        for row in featured_rows
    } == {
        (album_artist.casefold(), "owner"),
        (track_artist.casefold(), "featured_track_artist"),
    }


@pytest.mark.parametrize(
    "persisted_album_artists",
    [
        pytest.param((None, None), id="missing"),
        pytest.param(("Conflicting Owner One", "Conflicting Owner Two"), id="conflicting"),
    ],
)
def test_missing_or_conflicting_raw_owners_fall_back_to_classified_owner(
    monkeypatch,
    persisted_album_artists,
):
    album, rows = _published_rows(
        monkeypatch,
        album="Fallback Owner Album",
        album_artist="Classified Owner",
        track_artists=("Featured One", "Featured Two"),
        persisted_album_artists=persisted_album_artists,
    )
    artist_rows, album_rows, featured_rows, track_rows, _track_file_rows = rows

    assert album.album_artist == "Classified Owner"
    assert album_rows[0]["artist_key"] == "classified owner"
    assert album_rows[0]["metadata"]["album_artist"] == "Classified Owner"
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "owner"
    } == {"classified owner"}
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "featured_track_artist"
    } == {"featured one", "featured two"}
    assert not [
        row
        for row in featured_rows
        if row["featured_kind"] == "featured_member"
    ]
    assert {row["artist_key"] for row in track_rows} == {
        "featured one",
        "featured two",
    }
    assert {row["artist_key"] for row in artist_rows} == {
        "classified owner",
        "featured one",
        "featured two",
    }


def test_various_artists_owner_does_not_create_composite_display_artist(
    monkeypatch,
):
    album, rows = _published_rows(
        monkeypatch,
        album="Songs From The Northern Wasteland",
        album_artist="Various Artists",
        track_artists=("Jordsjø", "Breidablik"),
    )
    artist_rows, album_rows, featured_rows, track_rows, _track_file_rows = rows

    assert album.album_artist == "Jordsjø / Breidablik"
    assert album_rows[0]["artist_key"] == "various artists"
    assert album_rows[0]["metadata"]["album_artist"] == "Jordsjø / Breidablik"
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "owner"
    } == {"various artists"}
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "featured_track_artist"
    } == {"jordsjø", "breidablik"}
    assert not [
        row
        for row in featured_rows
        if row["featured_kind"] == "featured_member"
    ]
    assert {row["artist_key"] for row in track_rows} == {"jordsjø", "breidablik"}
    assert {row["artist_key"] for row in artist_rows} == {
        "various artists",
        "jordsjø",
        "breidablik",
    }
