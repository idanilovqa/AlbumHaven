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


def test_semicolon_track_credits_publish_exact_members_without_composite_artists(
    monkeypatch,
):
    track_artists = (
        "Maroon 5; Megan Thee Stallion",
        "Maroon 5",
        "Maroon 5; Blackbear",
        "Maroon 5",
        "Maroon 5; Stevie Nicks",
        "Maroon 5",
        "Maroon 5; Bantu",
        "Maroon 5; H.E.R.",
        "Maroon 5",
        "Maroon 5; Juice Wrld",
        "Maroon 5",
        "Maroon 5; Nipsey Hussle; YG",
        "Maroon 5; Anuel Aa; Tainy",
        "Jason Derulo; Adam Levine",
    )
    _album, rows = _published_rows(
        monkeypatch,
        album="JORDI",
        album_artist="Maroon 5",
        track_artists=track_artists,
        is_compilation=False,
    )
    artist_rows, _album_rows, featured_rows, track_rows, _track_file_rows = rows

    assert {row["artist_key"] for row in artist_rows} == {
        "maroon 5",
        "megan thee stallion",
        "blackbear",
        "stevie nicks",
        "bantu",
        "h.e.r.",
        "juice wrld",
        "nipsey hussle",
        "yg",
        "anuel aa",
        "tainy",
        "jason derulo",
        "adam levine",
    }
    assert [row["artist_key"] for row in track_rows] == [
        *("maroon 5" for _ in range(13)),
        "jason derulo",
    ]
    assert [row["metadata"]["artist"] for row in track_rows] == list(track_artists)
    assert [row["metadata"]["artists"] for row in track_rows] == [
        ["Maroon 5", "Megan Thee Stallion"],
        ["Maroon 5"],
        ["Maroon 5", "Blackbear"],
        ["Maroon 5"],
        ["Maroon 5", "Stevie Nicks"],
        ["Maroon 5"],
        ["Maroon 5", "Bantu"],
        ["Maroon 5", "H.E.R."],
        ["Maroon 5"],
        ["Maroon 5", "Juice Wrld"],
        ["Maroon 5"],
        ["Maroon 5", "Nipsey Hussle", "YG"],
        ["Maroon 5", "Anuel Aa", "Tainy"],
        ["Jason Derulo", "Adam Levine"],
    ]
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "featured_track_artist"
    } == {
        "megan thee stallion",
        "blackbear",
        "stevie nicks",
        "bantu",
        "h.e.r.",
        "juice wrld",
        "nipsey hussle",
        "yg",
        "anuel aa",
        "tainy",
        "jason derulo",
        "adam levine",
    }


@pytest.mark.parametrize("reverse_rows", [False, True])
def test_primary_disc_owner_survives_various_artist_bonus_disc(
    monkeypatch,
    reverse_rows,
):
    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    rows = [
        (1, 1, "Release Owner", "Release Owner"),
        (1, 2, "Release Owner", "Release Owner"),
        (2, 1, "Various Artists", "Guest One"),
        (2, 2, "Various Artists", "Guest Two"),
        (2, 3, "Various Artists", "Guest Three"),
    ]
    if reverse_rows:
        rows.reverse()
    file_cache = {}
    for disc_number, track_number, album_artist, track_artist in rows:
        path = f"C:/Music/Owner Album/CD{disc_number}/{track_number:02}.flac"
        file_cache[path] = {
            "path": path,
            "mtime": 1.0,
            "size": 123,
            "album": "Owner Album",
            "album_artist": album_artist,
            "artist": track_artist,
            "title": f"Disc {disc_number} Track {track_number}",
            "track_number": track_number,
            "disc_number": disc_number,
            "disc_number_raw": str(disc_number),
            "year": 2020,
            "duration_seconds": 100,
        }

    albums = build_albums_from_file_cache(file_cache)
    assert len(albums) == 1
    album = albums[0]
    assert album.album_artist == "Release Owner"
    assert album.artists == ["Release Owner"]
    assert album.key == "release owner::owner album"

    artist_rows, album_rows, featured_rows, _track_rows, _track_file_rows = (
        scan_cache_persistence._inventory_rows_from_albums(file_cache, albums)
    )
    assert album_rows[0]["artist_key"] == "release owner"
    assert {
        (row["artist_key"], row["featured_kind"])
        for row in featured_rows
    } == {
        ("release owner", "owner"),
        ("guest one", "featured_track_artist"),
        ("guest two", "featured_track_artist"),
        ("guest three", "featured_track_artist"),
    }
    assert "various artists" not in {
        row["artist_key"]
        for row in artist_rows
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


def test_stale_compilation_flag_does_not_override_unanimous_album_owner(
    monkeypatch,
):
    album, rows = _published_rows(
        monkeypatch,
        album="Owner-Led Guest Album",
        album_artist="Album Owner",
        track_artists=("Album Owner", "Album Owner", "Guest Artist"),
        is_compilation=True,
    )

    _artist_rows, album_rows, featured_rows, track_rows, _track_file_rows = rows

    assert album.album_artist == "Album Owner"
    assert album.is_compilation is False
    assert album_rows[0]["metadata"]["is_compilation"] is False
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "owner"
    } == {"album owner"}
    assert not [
        row for row in featured_rows if row["featured_kind"] == "featured_member"
    ]
    assert {row["artist_key"] for row in track_rows} == {
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
    assert album.artists == ["Jordsjø", "Breidablik"]
    assert album_rows[0]["artist_key"] is None
    assert album_rows[0]["metadata"]["album_artist"] == "Jordsjø / Breidablik"
    assert {
        (row["artist_key"], row["featured_kind"])
        for row in featured_rows
    } == {
        ("jordsjø", "owner"),
        ("breidablik", "owner"),
        ("jordsjø", "featured_track_artist"),
        ("breidablik", "featured_track_artist"),
    }
    assert {row["artist_key"] for row in track_rows} == {"jordsjø", "breidablik"}
    assert {row["artist_key"] for row in artist_rows} == {"jordsjø", "breidablik"}


def test_targeted_various_artists_release_keeps_two_constituent_display_credit(
    monkeypatch,
):
    album, rows = _published_rows(
        monkeypatch,
        album="Songs From Northern Wasteland",
        album_artist="Various Artists",
        track_artists=("Jordsjø", "Breidablik"),
    )
    artist_rows, album_rows, featured_rows, track_rows, _track_file_rows = rows

    assert album.album_artist == "Jordsjø / Breidablik"
    assert album_rows[0]["artist_key"] is None
    assert album_rows[0]["metadata"]["album_artist"] == "Jordsjø / Breidablik"
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "owner"
    } == {"jordsjø", "breidablik"}
    assert {row["artist_key"] for row in track_rows} == {"jordsjø", "breidablik"}
    assert {row["artist_key"] for row in artist_rows} == {"jordsjø", "breidablik"}


def test_targeted_various_artists_tag_does_not_replace_structural_split_owner(
    monkeypatch,
):
    album, rows = _published_rows(
        monkeypatch,
        album="Solo Release",
        album_artist="Solo Voice",
        track_artists=("Solo Voice feat. Featured Voice",),
        persisted_album_artists=("Various Artists",),
    )
    _artist_rows, album_rows, featured_rows, _track_rows, _track_file_rows = rows

    assert album.album_artist == "Solo Voice"
    assert album_rows[0]["artist_key"] == "solo voice"
    assert album_rows[0]["metadata"]["album_artist"] == "Solo Voice"
    assert {
        (row["artist_key"], row["featured_kind"])
        for row in featured_rows
    } == {
        ("solo voice", "owner"),
        ("featured voice", "featured_track_artist"),
    }


def test_targeted_various_artists_release_keeps_every_track_artist_visible(
    monkeypatch,
):
    album, rows = _published_rows(
        monkeypatch,
        album="Rain Man",
        album_artist="Various Artists",
        track_artists=("Belle Stars", "Watcher Compilation Performer"),
        is_compilation=True,
    )
    artist_rows, album_rows, featured_rows, track_rows, _track_file_rows = rows

    assert album_rows[0]["artist_key"] is None
    assert album_rows[0]["metadata"]["album_artist"] == "Various Artists"
    assert {
        row["artist_key"]
        for row in featured_rows
        if row["featured_kind"] == "featured_track_artist"
    } == {"belle stars", "watcher compilation performer"}
    assert {row["artist_key"] for row in track_rows} == {
        "belle stars",
        "watcher compilation performer",
    }
    assert {row["artist_key"] for row in artist_rows} == {
        "belle stars",
        "watcher compilation performer",
    }


def test_structured_shared_release_does_not_persist_composite_owner(monkeypatch):
    album, rows = _published_rows(
        monkeypatch,
        album="Songs From The Northern Wasteland",
        album_artist="Jordsjø / Breidablik",
        track_artists=("Jordsjø", "Breidablik"),
    )
    artist_rows, album_rows, featured_rows, track_rows, _track_file_rows = rows

    assert album.album_artist == "Jordsjø / Breidablik"
    assert album.artists == ["Jordsjø", "Breidablik"]
    assert album_rows[0]["artist_key"] is None
    assert album_rows[0]["metadata"]["album_artist"] == "Jordsjø / Breidablik"
    assert {
        (row["artist_key"], row["featured_kind"])
        for row in featured_rows
    } == {
        ("jordsjø", "owner"),
        ("breidablik", "owner"),
        ("jordsjø", "featured_track_artist"),
        ("breidablik", "featured_track_artist"),
    }
    assert {row["artist_key"] for row in track_rows} == {"jordsjø", "breidablik"}
    assert {row["artist_key"] for row in artist_rows} == {"jordsjø", "breidablik"}


def test_full_publication_keeps_named_owner_despite_composite_family_display(monkeypatch):
    from music_app.services.library_browse_postgres import _album_artist_relationship
    monkeypatch.setattr(scan_cache_persistence, 'Jsonb', None)
    cache = _file_cache(album='Non-Compilation Cross-Credits', album_artist='Control Signal Lead',
                        track_artists=('Control Signal Lead', 'Control Signal Partner'), is_compilation=False)
    albums = build_albums_from_file_cache(cache)
    assert albums[0].album_artist == 'Control Signal Lead / Control Signal Partner'
    assert albums[0].artists == ['Control Signal Lead', 'Control Signal Partner']
    _, album_rows, featured, _, _ = scan_cache_persistence._inventory_rows_from_albums(cache, albums)
    row = album_rows[0]
    assert row['artist_key'] == 'control signal lead'
    assert row['metadata']['album_artist'] == 'Control Signal Lead'
    assert row['metadata']['is_split_album'] is False
    assert row['album_key'].startswith('control signal lead::')
    assert ('control signal partner', 'featured_member') in {(r['artist_key'], r['featured_kind']) for r in featured}
    assert _album_artist_relationship([{'album_metadata': row['metadata'], 'artist_name': 'Control Signal Partner',
                                       'featured_kind': 'featured_member'}]) == 'featured'
    assert {entry['album_artist'] for entry in cache.values()} == {'Control Signal Lead'}


@pytest.mark.parametrize('physical_compilation', ['missing', None, False, True])
@pytest.mark.parametrize('cached_compilation', [None, False, True])
def test_single_performer_various_artist_owner_agrees_between_save_and_rescan(
    monkeypatch, physical_compilation, cached_compilation,
):
    monkeypatch.setattr(scan_cache_persistence, 'Jsonb', None)
    cache = _file_cache(album='Solo Split', album_artist='Various Artists',
                        track_artists=('Solo Voice',), is_compilation=cached_compilation)
    if physical_compilation != 'missing':
        for entry in cache.values():
            entry['compilation_tag'] = physical_compilation
    original = {path: dict(entry) for path, entry in cache.items()}
    expected = ('Various Artists' if physical_compilation is True or
                (physical_compilation == 'missing' and cached_compilation is True) else 'Solo Voice')
    rescanned = build_albums_from_file_cache(cache)[0]
    saved = scan_cache_persistence._structural_destination_album_projection(
        build_albums_from_file_cache, cache, frozenset({'album'}))
    assert rescanned.album_artist == expected
    assert saved.album_artist == expected
    assert saved.key == rescanned.key
    _, rows, credits, _, _ = scan_cache_persistence._inventory_rows_from_albums(cache, [rescanned])
    assert rows[0]['metadata']['album_artist'] == expected
    if expected == 'Solo Voice':
        assert rows[0]['artist_key'] == 'solo voice'
        assert ('solo voice', 'owner') in {(r['artist_key'], r['featured_kind']) for r in credits}
    assert cache == original, 'Logical ownership must not rewrite physical album-artist credits'


@pytest.mark.parametrize('structured_artists', [[], ['', None]])
@pytest.mark.parametrize('tagged_owner,performers,expected', [
    ('Various Artists', ('Solo Voice',), 'Solo Voice'),
    ('Control Lead', ('Control Lead','Control Partner'), 'Control Lead / Control Partner'),
])
def test_empty_structured_artist_list_keeps_primary_track_credit(structured_artists,tagged_owner,performers,expected):
    cache = _file_cache(album='Empty Parsed Credits',album_artist=tagged_owner,
                        track_artists=performers,is_compilation=False)
    for entry in cache.values():
        entry.update(artists=structured_artists,compilation_tag=None)
    album = build_albums_from_file_cache(cache)[0]
    assert album.album_artist == expected
    assert album.artists == list(performers)


@pytest.mark.parametrize('physical_compilation', [None, False, True])
@pytest.mark.parametrize('cached_compilation', [False, True])
def test_two_performer_va_split_respects_physical_compilation_evidence(monkeypatch,physical_compilation,cached_compilation):
    monkeypatch.setattr(scan_cache_persistence,'Jsonb',None)
    cache = _file_cache(album='Two Main Artists',album_artist='Various Artists',
                        track_artists=('Jordsjø','Breidablik'),is_compilation=cached_compilation)
    for entry in cache.values():
        entry.update(compilation_tag=physical_compilation,artists=[])
    album = build_albums_from_file_cache(cache)[0]
    _, rows, _, _, _ = scan_cache_persistence._inventory_rows_from_albums(cache,[album])
    expected = 'Various Artists' if physical_compilation is True else 'Jordsjø / Breidablik'
    assert rows[0]['metadata']['album_artist'] == expected
    assert rows[0]['metadata']['is_split_album'] is (physical_compilation is not True)
