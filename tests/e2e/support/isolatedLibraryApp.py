from __future__ import annotations

import argparse
from html import escape
import hashlib
import json
import math
import os
import random
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = ROOT / "tests" / "e2e" / "fixtures" / "idleMemoryBudget.json"
APPROVED_COVER_METADATA_PATH = ROOT / "tests" / "e2e" / "fixtures" / "approvedCoverFixtures.json"
TRACK_DESCRIPTION = " ".join(
    (
        "Progressive", "album", "detail", "payload", "kept", "large", "on", "purpose",
        "to", "exercise", "idle", "memory", "compaction",
    )
)
_TEMP_PREFIX = "album-haven-e2e-"
_PUBLIC_COVER_FIXTURE_HOST = "cover-fixture.example"
_NO_WINDOW_CREATION_FLAGS = (
    getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if os.name == "nt"
    else 0
)
JOSEPH_ARTIST = "Neal Morse"
JOSEPH_ALBUM = "Joseph: Part One - The Dreamer"
JOSEPH_YEAR = 2023
COVER_PERSISTENCE_ARTIST = "Synthetic Cover Artist"
COVER_PERSISTENCE_ALBUM = "Canonical Cover Fixture"
PROBLEMATIC_TRACK_ARTIST = "Neal Morse"
PROBLEMATIC_TRACK_ALBUM = "Neal Morse Plays Pink Floyd"
PROBLEMATIC_TRACK_TITLE = "Comfortably Numb"
PROBLEMATIC_TRACK_NUMBER = 18
PROBLEMATIC_TRACK_HEALTHY_TITLE = "Breathe"
PROBLEMATIC_TRACK_SIDEBAR_FIXTURE_COUNT = 8
PROBLEMATIC_METADATA_ARTIST = "Generated Problem Fixture"
PROBLEMATIC_ENCODING_ALBUM = "Encoding And Missing Metadata"
PROBLEMATIC_MISSING_METADATA_ALBUM = "Partial \ufffd Metadata And Cover"
PROBLEMATIC_LEGACY_IGNORED_ALBUM = "?"
PROBLEMATIC_LEGACY_IGNORED_YEAR = 2005
PROBLEMATIC_LEGACY_IGNORED_TRACK_COUNT = 18
PROBLEMATIC_PARTIAL_LEGACY_IGNORED_ALBUM = PROBLEMATIC_MISSING_METADATA_ALBUM
PROBLEMATIC_PARTIAL_LEGACY_IGNORED_TRACK_COUNT = 17
PROBLEMATIC_ENCODING_TRACK_TITLE = (
    "\u4200\u7200\u6f00\u6b00\u6500\u6e00\u2000\u4500\u6e00\u6300"
    "\u6f00\u6400\u6900\u6e00\u6700\u2000\u5300\u6900\u6700\u6e00"
    "\u6100\u6c00"
)
PROBLEMATIC_ENCODING_TRACK_ARTIST = (
    "\u5400\u7200\u6100\u6300\u6b00\u2000\u4100\u7200\u7400\u6900"
    "\u7300\u7400\u2000\u5300\u6900\u6700\u6e00\u6100\u6c00"
)
JOSEPH_COVER_FILENAME = "synthetic-player-artwork.png"
JOSEPH_COVER_SHA256 = "982c12c0697ed661a18f230290dc81a5a72a950cce2efb5ea8ee184f1693f491"
TRACK_CREDIT_ALBUM_ARTIST = "Various Artists"
TRACK_CREDIT_ALBUM = "Featured Signal Collection"
TRACK_CREDIT_TRACK_FIXTURES = (
    ("Clean Signal (feat. Featured Voice)", "Solo Voice"),
    ("Bright Signal featured Guest Two", "Ensemble Two"),
    ("Deep Signal featuring Guest Three", "Ensemble Three"),
    ("Open Signal feature Guest Four", "Ensemble Four"),
    ("Man and Machine", "U.D.O."),
)
BONUS_DURATION_FALSE_POSITIVE_ALBUM = "Rarity Outtakes Archive"
BONUS_DURATION_CONTROL_ALBUM = "Explicit Disc Label Control"
BONUS_DURATION_NUMERIC_MULTIDISC_ALBUM = "Ordinary Numeric Disc Control"
ORDINARY_TRACK_CREDIT_ARTIST = "Ария"
ORDINARY_TRACK_CREDIT_ALBUM = "Штиль Feature Credit"
ORDINARY_TRACK_CREDIT_TITLE = "Штиль (feat. U.D.O.)"
ORDINARY_ARTIST_MARKER_TRACK_TITLE = "Штиль"
ORDINARY_ARTIST_MARKER_TRACK_ARTIST = "Ария, U.D.O."
RATING_FIXTURE_ARTIST = "Album Rating Contract"
RATING_FIXTURE_YEAR = 2026
RATING_FIXTURES = (
    ("absent", "Rating Absent", None),
    ("malformed", "Rating Malformed", "not-a-rating"),
    ("zero", "Rating Zero", 0),
    ("out_of_range", "Rating Out Of Range", 11),
    ("numeric_authority", "Rating Numeric Authority", 3),
    ("cleared_authority", "Rating Cleared Authority", 6),
    ("import_candidate", "Rating Import Candidate", 7),
)
RATING_SCAN_DISCOVERY_ALBUM = "Rating Scan Discovery"
RATING_SCAN_DISCOVERY_TRACK = "New Tagged Rating"
RATING_SCAN_DISCOVERY_VALUE = 9
RARITY_FIXTURE_ARTIST = "E2E Rarity Artist"
RARITY_FIXTURE_ALBUM = "Two Track Rarity Fixture"
RARITY_FIXTURE_YEAR = 2026
RARITY_FIXTURE_TRACKS = (
    {
        "filename": "01 - Apply Rarity Here.mp3",
        "title": "Apply Rarity Here",
        "frequency_hz": 440,
    },
    {
        "filename": "02 - Remain Editable.mp3",
        "title": "Remain Editable",
        "frequency_hz": 660,
        "track_number": 3,
    },
)
TAG_RENAME_FIXTURE_ARTIST = RARITY_FIXTURE_ARTIST
TAG_RENAME_FIXTURE_ALBUM = "Queued Album Rename Fixture"
TAG_RENAME_FIXTURE_YEAR = 2026
TAG_RENAME_FIXTURE_TRACKS = tuple(
    {
        "filename": f"{track_number:02d} - Rename Track {track_number}.mp3",
        "title": f"Rename Track {track_number}",
        "frequency_hz": 300 + (track_number * 30),
    }
    for track_number in range(1, 19)
)

TAG_AUTO_NUMBER_FIXTURE_ALBUM = "Auto Number Selected Fixture"
TAG_AUTO_NUMBER_FIXTURE_YEAR = 2026
TAG_AUTO_NUMBER_FIXTURE_TRACKS = tuple(
    {
        "filename": f"{track_number:02d} - Auto Number Track {track_number}.mp3",
        "title": f"Auto Number Track {track_number}",
        "frequency_hz": 520 + (track_number * 10),
    }
    for track_number in range(1, 19)
)


def fixture_album_rating(
    rating_fixture: tuple[str, str, object] | None,
    artist_index: int,
    album_index: int,
) -> object:
    if rating_fixture is not None:
        return rating_fixture[2]
    generated_rating = (artist_index + album_index) % 11
    return generated_rating or None


TAG_BACKDROP_FIXTURE_ALBUM = "Backdrop Tag Editor Fixture"
TAG_BACKDROP_FIXTURE_YEAR = 2026
# This replaces the former 34-track balance slot, preserving the 7,200-track fixture total.
TAG_BACKDROP_FIXTURE_TRACKS = tuple(
    {
        "filename": f"{track_number:02d} - Backdrop Track {track_number}.mp3",
        "title": f"Backdrop Track {track_number}",
        "frequency_hz": 840 + (track_number * 10),
    }
    for track_number in range(1, 35)
)
TAG_SPLIT_FIXTURE_ALBUM = "Selected Track Split Fixture"
TAG_SPLIT_FIXTURE_TRACKS = tuple(
    {
        "filename": f"{track_number:02d} - Split Track {track_number}.mp3",
        "title": f"Split Track {track_number}",
        "frequency_hz": 360 + (track_number * 20),
    }
    for track_number in range(1, 19)
)
DDT_STUDIO_RECORDS_FIXTURE_ARTIST = "ДДТ"
DDT_STUDIO_RECORDS_PERSISTED_ALBUM_ARTIST = "Юрий Шевчук / ДДТ"
DDT_STUDIO_RECORDS_FIXTURE_ALBUM = "Студийные записи"
DDT_STUDIO_RECORDS_FIXTURE_YEAR = 1999
DDT_STUDIO_RECORDS_TOUCHED_TRACK_YEAR = 1990
DDT_STUDIO_RECORDS_TOUCHED_TRACK_NUMBERS = frozenset(range(1, 5))
DDT_STUDIO_RECORDS_YEARLESS_TRACK_NUMBERS = frozenset({9, 10, 11, 16})
PRELOADED_FIXTURE_PROFILES = frozenset(
    {"functional-core", "synthetic-large-library", "utility-problematic-files"}
)
GENERATED_FIXTURE_PROFILES = frozenset({"playback-media", "scan-library"})


def classify_fixture_profile_mode(fixture_profile: str) -> str:
    normalized_profile = str(fixture_profile).strip()
    if normalized_profile in PRELOADED_FIXTURE_PROFILES:
        return "preloaded-release"
    if not normalized_profile or normalized_profile in GENERATED_FIXTURE_PROFILES:
        return "generated-isolated"
    raise RuntimeError(f"Unsupported isolated E2E fixture profile: {normalized_profile!r}.")


DDT_STUDIO_RECORDS_FIXTURE_TRACKS = tuple(
    {
        "filename": f"{track_number:02d}. Студийная запись {track_number}.mp3",
        "title": f"Студийная запись {track_number}",
    }
    for track_number in range(1, 17)
)
DDT_REMIXES_FIXTURE_ALBUM = "Ремиксы"
DDT_REMIXES_FIXTURE_YEAR = 2000
DDT_REMIXES_FIXTURE_TRACKS = (
    {"filename": "01. Фонограммщик.mp3", "title": "Фонограммщик"},
    {"filename": "02. Террорист.mp3", "title": "Террорист"},
    {"filename": "03. Конвейер.mp3", "title": "Конвейер"},
    {"filename": "04. Храм.mp3", "title": "Храм"},
    {"filename": "05. Российское танго.mp3", "title": "Российское Танго"},
    {"filename": "06. В последнюю осень.mp3", "title": "В последнюю осень"},
    {
        "filename": "07. Милиционер в рок-клубе.mp3",
        "title": "Mилиционер в рок-клубе",
    },
    {"filename": "08. Революция.mp3", "title": "Революция"},
    {"filename": "09. Мальчик слепой.mp3", "title": "Мальчик слепой"},
    {"filename": "10. Это все.mp3", "title": "Это всё"},
)
DDT_GALLERY_ALBUMS = (
    (1982, "Свинья на радуге"),
    (1983, "Компромисс"),
    (1984, "Периферия"),
    (1985, "Время"),
    (1988, "Я получил эту роль"),
    (1990, "Оттепель"),
    (DDT_STUDIO_RECORDS_FIXTURE_YEAR, DDT_STUDIO_RECORDS_FIXTURE_ALBUM),
    (2000, "Метель Августа"),
    (DDT_REMIXES_FIXTURE_YEAR, DDT_REMIXES_FIXTURE_ALBUM),
    (2001, "Не вошедшее в альбомы"),
    (2002, "Вовочка"),
    (2002, "Единочество I"),
    (2003, "Единочество II. Живой"),
    (2003, "Песни"),
    (2005, "Пропавший без вести"),
    (2011, "Иначе"),
    (2014, "Прозрачный"),
    (2018, "Галя ходи"),
    (2021, "Творчество в пустоте"),
    (2022, "Творчество в пустоте 2"),
    (2023, "Сольник"),
)
_DDT_ORIGINAL_STUDIO_RECORDS_ENTRY = (
    DDT_STUDIO_RECORDS_FIXTURE_YEAR,
    DDT_STUDIO_RECORDS_FIXTURE_ALBUM,
)
_DDT_PRE_STUDIO_RECORDS_NEIGHBOURS = (
    (1991, "Пластун"),
    (1992, "Актриса Весна"),
    (1993, "Чёрный Пёс Петербург"),
    (1994, "Это всё"),
    (1996, "Любовь"),
    (1997, "Рождённый в СССР"),
    (1998, "Мир номер ноль (сингл)"),
    (1999, "Мир Номер Ноль"),
    (1999, "Просвистела"),
    (1999, "Публикация"),
)
_DDT_GALLERY_WITH_REAL_NEIGHBOURS = (
    *DDT_GALLERY_ALBUMS[:6],
    *_DDT_PRE_STUDIO_RECORDS_NEIGHBOURS,
    _DDT_ORIGINAL_STUDIO_RECORDS_ENTRY,
    *DDT_GALLERY_ALBUMS[7:],
)
DDT_GALLERY_TARGET_ALBUM_COUNT = 60
DDT_GALLERY_ALBUMS = (
    *_DDT_GALLERY_WITH_REAL_NEIGHBOURS,
    *(
        (2024 + (index // 2), f"DDT Archive Fixture {index + 1:02d}")
        for index in range(
            DDT_GALLERY_TARGET_ALBUM_COUNT - len(_DDT_GALLERY_WITH_REAL_NEIGHBOURS)
        )
    ),
)
DDT_STUDIO_RECORDS_FIXTURE_ALBUM_INDEX = DDT_GALLERY_ALBUMS.index(
    _DDT_ORIGINAL_STUDIO_RECORDS_ENTRY
)
DDT_REMIXES_FIXTURE_ALBUM_INDEX = DDT_GALLERY_ALBUMS.index(
    (DDT_REMIXES_FIXTURE_YEAR, DDT_REMIXES_FIXTURE_ALBUM)
)
TAG_SPARSE_ALBUM_FIXTURE_ALBUM = "Sparse Album Edit Fixture"
TAG_SPARSE_ALBUM_FIXTURE_DISPLAY_YEAR = 2000
TAG_SPARSE_ALBUM_FIXTURE_FILE_YEAR = 2001
TAG_SPARSE_TITLE_FIXTURE_ALBUM = "Sparse Title Edit Fixture"
TAG_SPARSE_TITLE_FIXTURE_YEAR = 2002
TAG_SPARSE_GENRE_FIXTURE_ALBUM = "Sparse Genre Edit Fixture"
TAG_SPARSE_GENRE_FIXTURE_YEAR = 2003
TAG_SPARSE_YEAR_FIXTURE_ALBUM = "Sparse Year Edit Fixture"
TAG_SPARSE_YEAR_FIXTURE_YEAR = 2004
TAG_SPARSE_FIXTURE_GENRE = "Fixture Progressive"


def _tag_sparse_fixture_tracks(label: str, frequency_base: int) -> tuple[dict[str, object], ...]:
    return tuple(
        {
            "filename": f"{track_number:02d} - {label} Track {track_number}.mp3",
            "title": f"{label} Track {track_number}",
            "frequency_hz": frequency_base + (track_number * 10),
        }
        for track_number in range(1, 19)
    )


TAG_SPARSE_ALBUM_FIXTURE_TRACKS = _tag_sparse_fixture_tracks("Sparse Album", 420)
TAG_SPARSE_TITLE_FIXTURE_TRACKS = _tag_sparse_fixture_tracks("Sparse Title", 440)
TAG_SPARSE_GENRE_FIXTURE_TRACKS = _tag_sparse_fixture_tracks("Sparse Genre", 460)
TAG_SPARSE_YEAR_FIXTURE_TRACKS = _tag_sparse_fixture_tracks("Sparse Year", 480)
TAG_SPARSE_FIXTURES = (
    (
        TAG_SPARSE_ALBUM_FIXTURE_ALBUM,
        TAG_SPARSE_ALBUM_FIXTURE_TRACKS,
        TAG_SPARSE_ALBUM_FIXTURE_FILE_YEAR,
    ),
    (
        TAG_SPARSE_TITLE_FIXTURE_ALBUM,
        TAG_SPARSE_TITLE_FIXTURE_TRACKS,
        TAG_SPARSE_TITLE_FIXTURE_YEAR,
    ),
    (
        TAG_SPARSE_GENRE_FIXTURE_ALBUM,
        TAG_SPARSE_GENRE_FIXTURE_TRACKS,
        TAG_SPARSE_GENRE_FIXTURE_YEAR,
    ),
    (
        TAG_SPARSE_YEAR_FIXTURE_ALBUM,
        TAG_SPARSE_YEAR_FIXTURE_TRACKS,
        TAG_SPARSE_YEAR_FIXTURE_YEAR,
    ),
)
TRACK_ORDER_FIXTURE_ALBUM = "Natural Filename Order Fixture"
TRACK_ORDER_FIXTURE_YEAR = 2026
TRACK_ORDER_FIXTURE_TRACKS = (
    {"filename": "02 - Numeric Two.mp3", "title": "Numeric Two"},
    {"filename": "03 - Numeric Three.mp3", "title": "Numeric Three"},
    {"filename": "10 - Numeric Ten.mp3", "title": "Numeric Ten"},
    {"filename": "Alpha.mp3", "title": "Alpha"},
    {"filename": "Beta.mp3", "title": "Beta"},
)
TRACK_ORDER_FIXTURE_TRACK_COUNT = len(TRACK_ORDER_FIXTURE_TRACKS)
TRACK_ORDER_FIXTURE_ALBUM_INDEX = 4 + len(TAG_SPARSE_FIXTURES)
TRACK_ORDER_FIXTURE_BALANCE_ALBUM_INDEX = TRACK_ORDER_FIXTURE_ALBUM_INDEX + 1
TAG_AUTO_NUMBER_FIXTURE_ALBUM_INDEX = TRACK_ORDER_FIXTURE_BALANCE_ALBUM_INDEX + 1
PLAYBACK_START_ARTIST = "Playback Start Signals"
PLAYBACK_START_ALBUM = "Length And Repetition"
PLAYBACK_START_YEAR = 2026
PLAYBACK_START_BITRATE_KBPS = 128
COVER_MATCHING_ARTIST = "Metallica"
COVER_MATCHING_ALBUM = "Kill 'Em All"
COVER_MATCHING_YEAR = 1983
COMPILATION_FAMILY_SOURCE_ARTIST = "Compilation Signal Lead"
COMPILATION_FAMILY_ALBUM = "Compilation Cross-Credits"
COMPILATION_FAMILY_MEMBERS = (
    "Compilation Signal Lead",
    "Compilation Signal Guest",
)
CONTROL_FAMILY_SOURCE_ARTIST = "Control Signal Lead"
CONTROL_FAMILY_ALBUM = "Non-Compilation Cross-Credits"
CONTROL_FAMILY_MEMBERS = (
    "Control Signal Lead",
    "Control Signal Partner",
)
SOUNDTRACK_FAMILY_SOURCE_ARTIST = "Sia"
SOUNDTRACK_FAMILY_ALBUM = "Structured Soundtrack Cross-Credits"
SOUNDTRACK_FAMILY_MEMBERS = (
    "Sia",
    "Soundtrack Signal Guest",
)
ARTIST_FAMILY_SOLO_ALBUMS = {
    "Compilation Signal Lead": "Compilation Lead Solo",
    "Compilation Signal Guest": "Compilation Guest Solo",
    "Control Signal Lead": "Control Lead Solo",
    "Control Signal Partner": "Control Partner Solo",
    "Sia": "Sia Soundtrack Solo",
    "Soundtrack Signal Guest": "Soundtrack Guest Solo",
}
ARTIST_FAMILY_FIXTURE_YEAR = 2026


def _playback_start_track_fixture(
    track_number: int,
    title: str,
    duration_seconds: int,
    frequency_hz: int,
    role: str,
) -> dict[str, object]:
    return {
        "filename": f"{track_number:02d} - {title}.mp3",
        "title": title,
        "duration_seconds": duration_seconds,
        "frequency_hz": frequency_hz,
        "role": role,
    }


PLAYBACK_START_TRACK_FIXTURES = (
    _playback_start_track_fixture(1, "Long Cold Signal", 300, 220, "measured-long"),
    _playback_start_track_fixture(2, "Eager Neighbour 01", 60, 330, "eager-neighbour"),
    _playback_start_track_fixture(3, "Short Cold Signal", 15, 440, "measured-short"),
    _playback_start_track_fixture(4, "Eager Neighbour 02", 60, 330, "eager-neighbour"),
    _playback_start_track_fixture(5, "Medium Cold Signal 01", 60, 330, "measured-medium"),
    _playback_start_track_fixture(6, "Eager Neighbour 03", 60, 330, "eager-neighbour"),
    _playback_start_track_fixture(7, "Medium Cold Signal 02", 60, 330, "measured-medium"),
    _playback_start_track_fixture(8, "Eager Neighbour 04", 60, 330, "eager-neighbour"),
    _playback_start_track_fixture(9, "Medium Cold Signal 03", 60, 330, "measured-medium"),
    _playback_start_track_fixture(10, "Eager Neighbour 05", 60, 330, "eager-neighbour"),
    _playback_start_track_fixture(11, "Medium Cold Signal 04", 60, 330, "measured-medium"),
    _playback_start_track_fixture(12, "Eager Neighbour 06", 60, 330, "eager-neighbour"),
    _playback_start_track_fixture(13, "Medium Cold Signal 05", 60, 330, "measured-medium"),
    _playback_start_track_fixture(14, "Eager Neighbour 07", 60, 330, "eager-neighbour"),
    _playback_start_track_fixture(15, "Medium Cold Signal 06", 60, 330, "measured-medium"),
    _playback_start_track_fixture(16, "Eager Neighbour 08", 60, 330, "eager-neighbour"),
    _playback_start_track_fixture(17, "Medium Cold Signal 07", 60, 330, "measured-medium"),
    _playback_start_track_fixture(18, "Eager Neighbour 09", 60, 330, "eager-neighbour"),
)
GAPLESS_PLAYBACK_ARTIST = "Gapless Playback Signals"
GAPLESS_PLAYBACK_ALBUM = "Deterministic Boundaries"
GAPLESS_BOUNDARY_WINDOW_FRAMES = 64
GAPLESS_PLAYBACK_TRACK_FIXTURES = (
    {"filename": "01 - Positive Boundary.flac", "title": "Positive Boundary", "duration_seconds": 2.0, "kind": "boundary-outgoing", "sample": 0.25},
    {"filename": "02 - Negative Boundary.flac", "title": "Negative Boundary", "duration_seconds": 2.0, "kind": "boundary-incoming", "sample": -0.25},
    {"filename": "03 - Very Short Signal.flac", "title": "Very Short Signal", "duration_seconds": 0.08, "kind": "very-short", "sample": 0.125},
    {"filename": "04 - VBR Encoded Signal.mp3", "title": "VBR Encoded Signal", "duration_seconds": 4.0, "kind": "vbr", "frequency_hz": 523},
    {"filename": "05 - Long Lossless Signal.flac", "title": "Long Lossless Signal", "duration_seconds": 360.0, "kind": "long", "sample": 0.0625},
    {"filename": "06 - Near End Seek Signal.flac", "title": "Near End Seek Signal", "duration_seconds": 4.0, "kind": "near-end-seek", "before_seek_sample": 0.125, "after_seek_sample": -0.125, "seek_transition_seconds": 3.0},
    {"filename": "07 - Near End Successor.flac", "title": "Near End Successor", "duration_seconds": 4.0, "kind": "near-end-successor", "sample": 0.1875},
    {"filename": "08 - Encoded Chain A.mp3", "title": "Encoded Chain A", "duration_seconds": 6.0, "kind": "encoded-chain-a", "sample": 0.09375},
    {"filename": "09 - Encoded Chain B.mp3", "title": "Encoded Chain B", "duration_seconds": 6.0, "kind": "encoded-chain-b", "sample": -0.15625},
    {"filename": "10 - Encoded Chain C.mp3", "title": "Encoded Chain C", "duration_seconds": 6.0, "kind": "encoded-chain-c", "sample": 0.21875},
)
LASTFM_FAKE_API_KEY = "album-haven-e2e-api-key"
LASTFM_FAKE_API_SECRET = "album-haven-e2e-api-secret"
LASTFM_FAKE_USERNAME = "fixture_listener"
LASTFM_FAKE_PASSWORD = "fixture-password"
LASTFM_FAKE_SESSION_KEY = "album-haven-e2e-session-key"
LASTFM_SCROBBLE_ARTIST = "Album Haven Last.fm Fixture"
LASTFM_SCROBBLE_ALBUM = "Signed Scrobble Journey"
LASTFM_SCROBBLE_TRACK = "Fake Loop Source"
LASTFM_SCROBBLE_YEAR = 2026
NEAL_MORSE_FAMILY_ARTISTS = (
    JOSEPH_ARTIST,
    "The Neal Morse Band",
    "Neal Morse & The Resonance",
)
COVER_LOOKUP_CONJUNCTION_ARTIST = "Neal Morse & The Resonance"
COVER_LOOKUP_CONJUNCTION_ALBUM = "Cover Lookup Conjunction"
COVER_LOOKUP_CONJUNCTION_YEAR = 2006
FLOWER_KINGS_FAMILY_ARTISTS = (
    "The Flower Kings",
    "Agents Of Mercy",
    "Roine Stolt",
)
SEARCH_FAMILY_ARTISTS = (
    *NEAL_MORSE_FAMILY_ARTISTS,
    *FLOWER_KINGS_FAMILY_ARTISTS,
)
MORSE_ALIAS_FIXTURES = {
    "Morse Portnoy George": ("Cover to Cover", 2006),
    "Morse, Portnoy & George": ("Cover 2 Cover", 2012),
}
EMPTY_KEY_ARTIST_FIXTURES = {
    "東京事変": ("Tokyo Signal", 2007),
    "Борис": ("Boris Signal", 2008),
    "!!!": ("Three Bangs", 2009),
    "***": ("Three Stars", 2010),
}
WHITESPACE_FAMILY_FIXTURES = {
    "Signal  Family Lead": ("Double Space Signal", 2011),
    "Signal Family Relative": ("Relative Signal", 2012),
}
SNOW_WHITE_RAW_ARTIST = (
    "Frank Churchill / Leigh Harline / Larry Morey / Frank Churchill / Larry Morey"
)
SNOW_WHITE_DISPLAY_ARTIST = "Frank Churchill / Leigh Harline / Larry Morey"
SNOW_WHITE_TRACK_ARTISTS = (
    SNOW_WHITE_DISPLAY_ARTIST,
    "Frank Churchill / Larry Morey",
)
SNOW_WHITE_ALBUM = "Snow White And The Seven Dwarfs"
SNOW_WHITE_YEAR = 1937
ALIAS_PARITY_ARTIST_FIXTURES = {
    **MORSE_ALIAS_FIXTURES,
    **EMPTY_KEY_ARTIST_FIXTURES,
    **WHITESPACE_FAMILY_FIXTURES,
    SNOW_WHITE_RAW_ARTIST: (SNOW_WHITE_ALBUM, SNOW_WHITE_YEAR),
}
_NAME_RNG = random.Random(os.urandom(16))
_ARTIST_PREFIXES = (
    "Amber", "Atlas", "Cinder", "Copper", "Echo", "Glass", "Harbor", "Ivory",
    "Juniper", "Lumen", "Marble", "Neon",
)
_ARTIST_SUFFIXES = (
    "Arcade", "Bloom", "Carousel", "Comet", "District", "Embers", "Harbor", "Heights",
    "Meadow", "Parade", "Signal", "Velvet",
)
_ALBUM_PREFIXES = (
    "Afterglow", "Blue Room", "City Static", "Drift Signal", "Golden Current",
    "Midnight Diagram", "Parallel Echo", "Quiet Satellites", "Silver Transit",
    "Soft Voltage", "Tidal Memory", "Velvet Weather",
)
_ALBUM_SUFFIXES = (
    "Edition", "Fragments", "Mirrors", "Motion", "Notebook", "Outline", "Patterns",
    "Season", "Sessions", "Shapes", "Stories", "Transfer",
)
_REQUIRED_POSTGRES_SEAMS = (
    "library_browse",
    "scan_cache",
    "library_roots",
    "saved_loops",
    "cover_lookup_tasks",
    "listen_history",
)
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION  # noqa: E402
from tests.e2e.support.isolatedPostgres import (  # noqa: E402
    IsolatedDatabaseOwnershipLock,
    prepare_isolated_database,
    reset_application_tables,
    resolve_isolated_database_urls,
)
from tests.e2e.support.privateFixtureData import (  # noqa: E402
    resolve_approved_cover_by_sha256,
)


def load_fixture_config() -> dict[str, int]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def load_real_cover_manifest() -> dict[str, Any]:
    return json.loads(APPROVED_COVER_METADATA_PATH.read_text(encoding="utf-8"))


def resolve_manifest_cover_path(cover: dict[str, Any]) -> Path:
    expected_hash = str(cover.get("sha256") or "").strip()
    if not expected_hash:
        raise RuntimeError("Approved cover metadata requires sha256.")
    return resolve_approved_cover_by_sha256(expected_hash)


def _format_duration(seconds: int) -> str:
    minutes, remaining = divmod(seconds, 60)
    return f"{minutes}:{remaining:02d}"


def _artist_name(artist_index: int) -> str:
    return (
        f"{_ARTIST_PREFIXES[artist_index % len(_ARTIST_PREFIXES)]} "
        f"{_NAME_RNG.choice(_ARTIST_SUFFIXES)} {artist_index + 1:03d}"
    )


def _album_name(album_index: int) -> str:
    return (
        f"{_NAME_RNG.choice(_ALBUM_PREFIXES)} "
        f"{_ALBUM_SUFFIXES[album_index % len(_ALBUM_SUFFIXES)]} {album_index + 1:02d}"
    )


def _resolve_ffmpeg_executable() -> str | None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg
    except ImportError:
        return None
    try:
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def ensure_playable_loop_source(path: Path) -> None:
    if path.is_file():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = _resolve_ffmpeg_executable()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to generate the isolated E2E loop source.")
    result = subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
            "anoisesrc=color=white:amplitude=0.08:duration=14:sample_rate=44100:seed=41",
            "-f", "lavfi", "-i",
            "anoisesrc=color=white:amplitude=0.08:duration=14:sample_rate=44100:seed=97",
            "-filter_complex", "[0:a][1:a]amerge=inputs=2[stereo]",
            "-map", "[stereo]", "-ac", "2",
            "-codec:a", "libmp3lame", "-q:a", "4", str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
        creationflags=_NO_WINDOW_CREATION_FLAGS,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffmpeg failed to generate E2E audio.")


def _contained_fixture_destination(library_root: Path, destination: Path) -> Path:
    resolved_root = library_root.resolve(strict=False)
    resolved_destination = destination.resolve(strict=False)
    try:
        resolved_destination.relative_to(resolved_root)
    except ValueError as exc:
        raise RuntimeError(
            f"Generated media destination escaped isolated library root: {resolved_destination}"
        ) from exc
    return resolved_destination


def generate_rarity_fixture_audio(
    library_root: Path,
    destination: Path,
    *,
    frequency_hz: int,
) -> Path:
    resolved_destination = _contained_fixture_destination(library_root, destination)
    resolved_destination.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = _resolve_ffmpeg_executable()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to generate the isolated rarity fixture.")
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={int(frequency_hz)}:duration=4:sample_rate=44100",
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "4",
            str(resolved_destination),
        ],
        capture_output=True,
        text=True,
        check=False,
        creationflags=_NO_WINDOW_CREATION_FLAGS,
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip() or "ffmpeg failed to generate isolated rarity audio."
        )
    if not resolved_destination.is_file():
        raise RuntimeError(
            f"ffmpeg did not create the isolated rarity track: {resolved_destination}"
        )
    return resolved_destination


def _write_tag_edit_fixture_id3_tags(
    library_root: Path,
    destination: Path,
    *,
    artist: str,
    album: str,
    year: int | None,
    title: str,
    track_number: int,
    track_total: int,
    genre: str = "",
) -> Path:
    from mutagen.id3 import (
        ID3,
        ID3NoHeaderError,
        TALB,
        TCON,
        TDRC,
        TIT2,
        TPE1,
        TPE2,
        TPOS,
        TRCK,
    )

    resolved_destination = _contained_fixture_destination(library_root, destination)
    try:
        tags = ID3(resolved_destination)
    except ID3NoHeaderError:
        tags = ID3()
    for frame_id in ("TALB", "TCON", "TDRC", "TIT2", "TPE1", "TPE2", "TPOS", "TRCK", "TXXX"):
        tags.delall(frame_id)
    tags.add(TPE1(encoding=3, text=[artist]))
    tags.add(TPE2(encoding=3, text=[artist]))
    tags.add(TALB(encoding=3, text=[album]))
    tags.add(TIT2(encoding=3, text=[str(title)]))
    tags.add(TRCK(encoding=3, text=[f"{int(track_number)}/{int(track_total)}"]))
    tags.add(TPOS(encoding=3, text=["1/1"]))
    if year is not None:
        tags.add(TDRC(encoding=3, text=[str(year)]))
    if genre:
        tags.add(TCON(encoding=3, text=[genre]))
    tags.save(resolved_destination)
    return resolved_destination


def write_rarity_fixture_id3_tags(
    library_root: Path,
    destination: Path,
    *,
    title: str,
    track_number: int,
) -> Path:
    return _write_tag_edit_fixture_id3_tags(
        library_root,
        destination,
        artist=RARITY_FIXTURE_ARTIST,
        album=RARITY_FIXTURE_ALBUM,
        year=RARITY_FIXTURE_YEAR,
        title=title,
        track_number=track_number,
        track_total=len(RARITY_FIXTURE_TRACKS),
    )


def materialize_rarity_fixture_tracks(
    library_root: Path,
    file_cache: dict[str, dict[str, object]],
) -> None:
    album_dir = library_root / RARITY_FIXTURE_ARTIST / RARITY_FIXTURE_ALBUM
    for track_number, track in enumerate(RARITY_FIXTURE_TRACKS, start=1):
        destination = _contained_fixture_destination(
            library_root,
            album_dir / str(track["filename"]),
        )
        metadata = file_cache.get(str(destination))
        if metadata is None:
            raise RuntimeError(
                f"The isolated rarity track is missing from the pre-start inventory: {destination}"
            )
        generate_rarity_fixture_audio(
            library_root,
            destination,
            frequency_hz=int(track["frequency_hz"]),
        )
        write_rarity_fixture_id3_tags(
            library_root,
            destination,
            title=str(track["title"]),
            track_number=int(track.get("track_number") or track_number),
        )

    for fixture_album, fixture_tracks, fixture_year in (
        (TAG_RENAME_FIXTURE_ALBUM, TAG_RENAME_FIXTURE_TRACKS, TAG_RENAME_FIXTURE_YEAR),
        (
            TAG_AUTO_NUMBER_FIXTURE_ALBUM,
            TAG_AUTO_NUMBER_FIXTURE_TRACKS,
            TAG_AUTO_NUMBER_FIXTURE_YEAR,
        ),
        (TAG_BACKDROP_FIXTURE_ALBUM, TAG_BACKDROP_FIXTURE_TRACKS, TAG_BACKDROP_FIXTURE_YEAR),
        (TAG_SPLIT_FIXTURE_ALBUM, TAG_SPLIT_FIXTURE_TRACKS, TAG_RENAME_FIXTURE_YEAR),
        *TAG_SPARSE_FIXTURES,
    ):
        fixture_album_dir = library_root / TAG_RENAME_FIXTURE_ARTIST / fixture_album
        generated_source: Path | None = None
        for track_number, track in enumerate(fixture_tracks, start=1):
            destination = _contained_fixture_destination(
                library_root,
                fixture_album_dir / str(track["filename"]),
            )
            metadata = file_cache.get(str(destination))
            if metadata is None:
                raise RuntimeError(
                    "The isolated album-tag fixture track is missing from the pre-start "
                    f"inventory: {destination}"
                )
            if generated_source is None:
                generated_source = generate_rarity_fixture_audio(
                    library_root,
                    destination,
                    frequency_hz=int(track["frequency_hz"]),
                )
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(generated_source, destination)
            _write_tag_edit_fixture_id3_tags(
                library_root,
                destination,
                artist=TAG_RENAME_FIXTURE_ARTIST,
                album=fixture_album,
                year=fixture_year,
                title=str(track["title"]),
                track_number=track_number,
                track_total=len(fixture_tracks),
                genre=TAG_SPARSE_FIXTURE_GENRE if fixture_album.startswith("Sparse ") else "",
            )

    for fixture_album, fixture_tracks, fixture_year, frequency_hz in (
        (
            DDT_STUDIO_RECORDS_FIXTURE_ALBUM,
            DDT_STUDIO_RECORDS_FIXTURE_TRACKS,
            DDT_STUDIO_RECORDS_FIXTURE_YEAR,
            520,
        ),
        (
            DDT_REMIXES_FIXTURE_ALBUM,
            DDT_REMIXES_FIXTURE_TRACKS,
            DDT_REMIXES_FIXTURE_YEAR,
            540,
        ),
    ):
        fixture_album_dir = (
            library_root / DDT_STUDIO_RECORDS_FIXTURE_ARTIST / fixture_album
        )
        generated_source: Path | None = None
        for track_number, track in enumerate(fixture_tracks, start=1):
            destination = _contained_fixture_destination(
                library_root,
                fixture_album_dir / str(track["filename"]),
            )
            metadata = file_cache.get(str(destination))
            if metadata is None:
                raise RuntimeError(
                    "The isolated DDT renderer track is missing from the pre-start "
                    f"inventory: {destination}"
                )
            if generated_source is None:
                generated_source = generate_rarity_fixture_audio(
                    library_root,
                    destination,
                    frequency_hz=frequency_hz,
                )
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(generated_source, destination)
            _write_tag_edit_fixture_id3_tags(
                library_root,
                destination,
                artist=DDT_STUDIO_RECORDS_FIXTURE_ARTIST,
                album=fixture_album,
                year=(
                    DDT_STUDIO_RECORDS_TOUCHED_TRACK_YEAR
                    if (
                        fixture_album == DDT_STUDIO_RECORDS_FIXTURE_ALBUM
                        and track_number in DDT_STUDIO_RECORDS_TOUCHED_TRACK_NUMBERS
                    )
                    else None
                    if (
                        fixture_album == DDT_STUDIO_RECORDS_FIXTURE_ALBUM
                        and track_number in DDT_STUDIO_RECORDS_YEARLESS_TRACK_NUMBERS
                    )
                    else fixture_year
                ),
                title=str(track["title"]),
                track_number=track_number,
                track_total=len(fixture_tracks),
            )


def generate_playback_start_fixture_audio(
    library_root: Path,
    destination: Path,
    *,
    duration_seconds: int,
    frequency_hz: int,
) -> Path:
    resolved_destination = _contained_fixture_destination(library_root, destination)
    resolved_destination.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = _resolve_ffmpeg_executable()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to generate the isolated playback-start fixture.")
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            (
                f"sine=frequency={int(frequency_hz)}:duration={int(duration_seconds)}:"
                "sample_rate=44100"
            ),
            "-ac",
            "2",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            f"{PLAYBACK_START_BITRATE_KBPS}k",
            "-write_xing",
            "0",
            str(resolved_destination),
        ],
        capture_output=True,
        text=True,
        check=False,
        creationflags=_NO_WINDOW_CREATION_FLAGS,
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip()
            or "ffmpeg failed to generate the isolated playback-start fixture."
        )
    if not resolved_destination.is_file():
        raise RuntimeError(
            f"ffmpeg did not create the isolated playback-start track: {resolved_destination}"
        )
    return resolved_destination


def generate_gapless_playback_fixture_audio(media_root: Path) -> dict[str, object]:
    """Generate deterministic real-media inputs and their external test oracle."""
    ffmpeg = _resolve_ffmpeg_executable()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to generate the isolated gapless fixture.")
    album_dir = media_root / GAPLESS_PLAYBACK_ARTIST / GAPLESS_PLAYBACK_ALBUM
    album_dir.mkdir(parents=True, exist_ok=True)
    tracks: list[dict[str, object]] = []
    for fixture in GAPLESS_PLAYBACK_TRACK_FIXTURES:
        destination = _contained_fixture_destination(
            media_root,
            album_dir / str(fixture["filename"]),
        )
        duration_seconds = float(fixture["duration_seconds"])
        if fixture["kind"] == "vbr":
            source = (
                f"sine=frequency={int(fixture['frequency_hz'])}:"
                f"duration={duration_seconds}:sample_rate=48000"
            )
            codec_args = ["-codec:a", "libmp3lame", "-q:a", "4"]
        elif str(fixture["kind"]).startswith("encoded-chain-"):
            sample = float(fixture["sample"])
            source = f"aevalsrc={sample}|{sample}:d={duration_seconds}:s=48000"
            codec_args = ["-codec:a", "libmp3lame", "-q:a", "4"]
        elif fixture["kind"] == "near-end-seek":
            before_seek_sample = float(fixture["before_seek_sample"])
            after_seek_sample = float(fixture["after_seek_sample"])
            transition_seconds = float(fixture["seek_transition_seconds"])
            expression = (
                f"if(lt(t\\,{transition_seconds})\\,{before_seek_sample}\\,{after_seek_sample})"
            )
            source = f"aevalsrc={expression}|{expression}:d={duration_seconds}:s=48000"
            codec_args = ["-codec:a", "flac"]
        else:
            sample = float(fixture["sample"])
            source = (
                f"aevalsrc={sample}|{sample}:d={duration_seconds}:s=48000"
            )
            codec_args = ["-codec:a", "flac"]
        result = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                source,
                "-ac",
                "2",
                *codec_args,
                str(destination),
            ],
            capture_output=True,
            text=True,
            check=False,
            creationflags=_NO_WINDOW_CREATION_FLAGS,
        )
        if result.returncode != 0 or not destination.is_file():
            raise RuntimeError(
                result.stderr.strip()
                or f"ffmpeg failed to generate isolated gapless track: {destination}"
            )
        track_metadata: dict[str, object] = {
            "kind": str(fixture["kind"]),
            "title": str(fixture["title"]),
            "path": str(destination.resolve(strict=False)),
            "durationSeconds": duration_seconds,
            "sampleRate": 48_000,
        }
        if "sample" in fixture:
            track_metadata["expectedSampleSign"] = 1 if float(fixture["sample"]) > 0 else -1
        if fixture["kind"] in {"boundary-outgoing", "boundary-incoming"}:
            decoded = subprocess.run(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(destination),
                    "-f",
                    "f32le",
                    "-acodec",
                    "pcm_f32le",
                    "-ac",
                    "2",
                    "-ar",
                    "48000",
                    "pipe:1",
                ],
                capture_output=True,
                check=False,
                creationflags=_NO_WINDOW_CREATION_FLAGS,
            )
            if decoded.returncode != 0 or len(decoded.stdout) < GAPLESS_BOUNDARY_WINDOW_FRAMES * 8:
                raise RuntimeError(
                    decoded.stderr.decode("utf-8", errors="replace").strip()
                    or f"ffmpeg did not decode the gapless reference window: {destination}"
                )
            frames = list(struct.iter_unpack("<ff", decoded.stdout))
            window = (
                frames[-GAPLESS_BOUNDARY_WINDOW_FRAMES:]
                if fixture["kind"] == "boundary-outgoing"
                else frames[:GAPLESS_BOUNDARY_WINDOW_FRAMES]
            )
            track_metadata["expectedBoundarySamples"] = {
                "left": [float(left) for left, _right in window],
                "right": [float(right) for _left, right in window],
            }
        if fixture["kind"] == "near-end-seek":
            track_metadata["expectedSeekCapture"] = {
                "outgoing": float(fixture["before_seek_sample"]),
                "incoming": float(fixture["after_seek_sample"]),
                "tolerance": 1 / 32768,
            }
        tracks.append(track_metadata)
    return {
        "artist": GAPLESS_PLAYBACK_ARTIST,
        "album": GAPLESS_PLAYBACK_ALBUM,
        "boundaryWindowFrames": GAPLESS_BOUNDARY_WINDOW_FRAMES,
        "tracks": tracks,
    }


def register_gapless_playback_fixture(
    file_cache: dict[str, dict[str, object]],
    fixture: dict[str, object],
) -> None:
    template = dict(
        next(
            iter(file_cache.values()),
            {
                "path": "",
                "mtime": 0.0,
                "size": 0,
                "album": "",
                "album_artist": "",
                "artist": "",
                "title": "",
                "track_number": None,
                "disc_number": None,
                "disc_number_raw": None,
                "duration_seconds": 0,
                "duration_display": _format_duration(0),
                "cover_path": None,
                "cover_revision": None,
                "local_cover_width": None,
                "local_cover_height": None,
                "cover_selection_origin": None,
                "remote_cover_url": None,
                "remote_cover_thumbnail_url": None,
                "remote_cover_source": None,
                "remote_cover_source_label": None,
                "remote_cover_album_url": None,
                "remote_cover_width": None,
                "remote_cover_height": None,
                "year": None,
                "release_date": None,
                "genre": None,
                "edition": None,
                "album_rating": None,
                "library_root_id": "isolated-e2e-root",
                "library_root_category": "main_library",
                "exception_type": None,
                "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
                "comment": "",
            },
        )
    )
    for track_number, track in enumerate(list(fixture["tracks"]), start=1):
        track_path = _absolute_fixture_path(Path(str(track["path"])))
        track_stat = track_path.stat()
        duration_seconds = float(track["durationSeconds"])
        persisted_duration_seconds = int(duration_seconds)
        metadata = dict(template)
        metadata.update(
            {
                "path": str(track_path),
                "mtime": track_stat.st_mtime,
                "size": track_stat.st_size,
                "album": GAPLESS_PLAYBACK_ALBUM,
                "album_artist": GAPLESS_PLAYBACK_ARTIST,
                "artist": GAPLESS_PLAYBACK_ARTIST,
                "title": str(track["title"]),
                "track_number": track_number,
                "disc_number": 1,
                "disc_number_raw": "1",
                "duration_seconds": persisted_duration_seconds,
                "duration_display": _format_duration(persisted_duration_seconds),
                "cover_path": None,
                "cover_revision": None,
                "comment": f"gapless-fixture kind={track['kind']}",
                "gapless_fixture": {
                    "kind": track["kind"],
                    "expected_boundary_samples": track.get("expectedBoundarySamples"),
                    "sample_rate": track["sampleRate"],
                },
            }
        )
        file_cache[str(track_path)] = metadata


def materialize_playback_start_fixture_tracks(
    library_root: Path,
    file_cache: dict[str, dict[str, object]],
) -> None:
    album_dir = library_root / PLAYBACK_START_ARTIST / PLAYBACK_START_ALBUM
    medium_source: Path | None = None
    for track in PLAYBACK_START_TRACK_FIXTURES:
        destination = _contained_fixture_destination(
            library_root,
            album_dir / str(track["filename"]),
        )
        metadata = file_cache.get(str(destination))
        if metadata is None:
            raise RuntimeError(
                "The isolated playback-start track is missing from the pre-start inventory: "
                f"{destination}"
            )
        duration_seconds = int(track["duration_seconds"])
        if duration_seconds == 60 and medium_source is not None:
            shutil.copy2(medium_source, destination)
            generated_path = destination
        else:
            generated_path = generate_playback_start_fixture_audio(
                library_root,
                destination,
                duration_seconds=duration_seconds,
                frequency_hz=int(track["frequency_hz"]),
            )
            if duration_seconds == 60:
                medium_source = generated_path
        generated_stat = generated_path.stat()
        metadata["mtime"] = generated_stat.st_mtime
        metadata["size"] = generated_stat.st_size


def stage_real_cover_pool(
    config: dict[str, int],
    library_root: Path,
    *,
    reuse_existing: bool = False,
) -> list[dict[str, Any]]:
    manifest_covers = list(load_real_cover_manifest().get("covers") or [])
    if not manifest_covers:
        raise RuntimeError(f"No staged covers are listed in {APPROVED_COVER_METADATA_PATH}.")
    requested_count = int(config.get("approvedCoverPoolSize") or len(manifest_covers))
    staged_dir = library_root / "_e2e_cover_pool"
    staged_dir.mkdir(parents=True, exist_ok=True)
    staged_specs: list[dict[str, Any]] = []
    for cover in manifest_covers[: min(requested_count, len(manifest_covers))]:
        if reuse_existing:
            destination_path = staged_dir / (
                f"{str(cover.get('assetId') or '').strip()}"
                f"{str(cover.get('extension') or '').strip()}"
            )
            if not destination_path.is_file():
                raise RuntimeError(
                    f"Restart reuse requires the staged cover file: {destination_path}"
                )
        else:
            source_path = resolve_manifest_cover_path(cover)
            destination_path = staged_dir / (
                f"{str(cover.get('assetId') or '').strip()}"
                f"{str(cover.get('extension') or source_path.suffix).strip().lower()}"
            )
            shutil.copy2(source_path, destination_path)
        staged_specs.append(
            {
                **cover,
                "cover_id": destination_path.stem,
                "artist": str(cover.get("artist") or "").strip(),
                "album": str(cover.get("album") or "").strip(),
                "year": int(cover.get("year") or 0) or None,
                "staged_path": str(destination_path),
            }
        )
    non_square_specs = [
        spec
        for spec in staged_specs
        if abs(int(spec.get("width") or 0) - int(spec.get("height") or 0))
        / max(int(spec.get("width") or 0), int(spec.get("height") or 0), 1)
        > 0.18
    ]
    if not non_square_specs:
        raise RuntimeError("The isolated E2E cover pool requires non-square other art.")
    for index, spec in enumerate(staged_specs):
        other_art_offset = index % len(non_square_specs)
        ordered_other_art = (
            non_square_specs[other_art_offset:] + non_square_specs[:other_art_offset]
        )
        other_art = next(
            (
                candidate
                for candidate in ordered_other_art
                if candidate["cover_id"] != spec["cover_id"]
            ),
            None,
        )
        if other_art is None:
            raise RuntimeError("The isolated E2E cover pool requires distinct other art.")
        spec["other_art_cover_id"] = other_art["cover_id"]
        spec["other_art_staged_path"] = other_art["staged_path"]
        spec["other_art_width"] = other_art.get("width")
        spec["other_art_height"] = other_art.get("height")
    return staged_specs


def _materialize_album_image(source_path: Path, destination_path: Path) -> Path:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    if destination_path.exists():
        return destination_path.resolve(strict=False)
    try:
        os.link(source_path, destination_path)
    except OSError:
        shutil.copy2(source_path, destination_path)
    return destination_path.resolve(strict=False)


def _materialize_independent_album_image(source_path: Path, destination_path: Path) -> Path:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    if destination_path.exists():
        return destination_path.resolve(strict=False)
    shutil.copy2(source_path, destination_path)
    return destination_path.resolve(strict=False)


def materialize_album_art(album_dir: Path, cover: dict[str, Any]) -> tuple[Path, Path]:
    active_cover = _materialize_independent_album_image(
        Path(str(cover["staged_path"])),
        album_dir / "cover.jpg",
    )
    other_art_source = Path(str(cover.get("other_art_staged_path") or ""))
    if not other_art_source.is_file() or other_art_source == Path(str(cover["staged_path"])):
        raise RuntimeError("Each isolated E2E album requires distinct staged other art.")
    other_art = _materialize_independent_album_image(
        other_art_source,
        album_dir / "booklet-other-art.jpg",
    )
    return active_cover, other_art


def materialize_cover_lookup_album_art(
    album_dir: Path,
    cover_specs: list[dict[str, Any]],
) -> Path:
    if len(cover_specs) < 2:
        raise RuntimeError("The cover-lookup fixture requires two distinct square cover sources.")
    front_source = Path(str(cover_specs[0].get("staged_path") or ""))
    disc_source = Path(str(cover_specs[1].get("staged_path") or ""))
    back_source = Path(str(cover_specs[0].get("other_art_staged_path") or ""))
    sources = (front_source, disc_source, back_source)
    if any(not source.is_file() for source in sources):
        raise RuntimeError("The cover-lookup fixture requires staged front, disc, and back art.")
    source_hashes = {hashlib.sha256(source.read_bytes()).hexdigest() for source in sources}
    if len(source_hashes) != len(sources):
        raise RuntimeError("The cover-lookup fixture art must have distinct bytes.")

    active_cover = _materialize_independent_album_image(
        front_source,
        album_dir / "cover.jpg",
    )
    _materialize_independent_album_image(
        disc_source,
        album_dir / "Art" / "Back.jpg",
    )
    from PIL import Image, ImageOps

    try:
        with Image.open(back_source) as source_image:
            selected_image = ImageOps.fit(
                source_image.convert("RGB"),
                (1200, 1200),
                method=Image.Resampling.LANCZOS,
            )
            selected_path = album_dir / "Art" / "Front.jpg"
            selected_path.parent.mkdir(parents=True, exist_ok=True)
            selected_image.save(selected_path, format="JPEG", quality=18)

            larger_image = ImageOps.fit(
                source_image.convert("RGB"),
                (1800, 1800),
                method=Image.Resampling.LANCZOS,
            )
            larger_image.save(
                album_dir / "Art" / "Front-Larger.jpg",
                format="JPEG",
                quality=95,
            )
    except OSError:
        _materialize_independent_album_image(
            back_source,
            album_dir / "Art" / "Front.jpg",
        )
        _materialize_independent_album_image(
            back_source,
            album_dir / "Art" / "Front-Larger.jpg",
        )
    _materialize_independent_album_image(
        front_source,
        album_dir / "Art" / "CD.JPG",
    )
    return active_cover


def materialize_user_owned_cover(album_dir: Path, source_path: Path) -> Path:
    from PIL import Image, ImageOps

    destination_path = album_dir / "cover.jpg"
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(source_path) as source_image:
            resized_image = ImageOps.fit(
                source_image.convert("RGB"),
                (640, 640),
                method=Image.Resampling.LANCZOS,
            )
            try:
                resized_image.save(destination_path, format="JPEG", quality=88)
            finally:
                resized_image.close()
    except OSError:
        _materialize_independent_album_image(source_path, destination_path)
    return destination_path.resolve(strict=False)


def restore_reused_fixture09_user_owned_cover(
    library_root: Path,
    cover_specs: list[dict[str, Any]],
) -> Path:
    if len(cover_specs) < 2:
        raise RuntimeError(
            "Restart reuse requires a second staged cover spec for Fixture 09."
        )
    persisted_cover_path = (
        library_root
        / "Mastodon"
        / "Crack The Skye Fixture 09"
        / "cover.jpg"
    )
    if not persisted_cover_path.is_file():
        raise RuntimeError(
            "Restart reuse requires the persisted Fixture 09 active cover: "
            f"{persisted_cover_path}"
        )
    resolved_cover_path = persisted_cover_path.resolve(strict=True)
    cover_specs[1]["user_owned_cover_path"] = str(resolved_cover_path)
    return resolved_cover_path


def stage_joseph_cover(library_root: Path) -> dict[str, Any]:
    """Stage pinned test-owned art whose bytes identify the Joseph fixture."""
    source_path = resolve_approved_cover_by_sha256(JOSEPH_COVER_SHA256)
    source_bytes = source_path.read_bytes()
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    if source_hash != JOSEPH_COVER_SHA256:
        raise RuntimeError(
            "The configured private player-artwork fixture does not match its pinned SHA-256."
        )
    destination = library_root / "_e2e_cover_pool" / JOSEPH_COVER_FILENAME
    _materialize_album_image(source_path, destination)
    return {
        "cover_id": "synthetic-player-artwork",
        "artist": JOSEPH_ARTIST,
        "album": JOSEPH_ALBUM,
        "year": JOSEPH_YEAR,
        "width": 1200,
        "height": 1200,
        "staged_path": str(destination.resolve(strict=False)),
    }


def _absolute_fixture_path(path: Path) -> Path:
    return path if path.is_absolute() else path.resolve(strict=False)


def _cached_cover_revision(
    source_path: Path,
    revisions_by_source: dict[Path, str],
) -> str:
    source = _absolute_fixture_path(source_path)
    revision = revisions_by_source.get(source)
    if revision is None:
        revision = hashlib.sha256(source.read_bytes()).hexdigest()
        revisions_by_source[source] = revision
    return revision


def build_file_cache(
    config: dict[str, int],
    library_root: Path,
    cover_specs: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, object]], Path, int, int]:
    if not cover_specs:
        raise RuntimeError("The isolated E2E inventory requires at least one staged cover.")
    file_cache: dict[str, dict[str, object]] = {}
    cover_revisions_by_source: dict[Path, str] = {}
    album_count = 0
    artist_count = int(config["artistCount"])
    albums_per_artist = int(config["albumsPerArtist"])
    tracks_per_album = int(config["tracksPerAlbum"])
    playback_track_count = len(PLAYBACK_START_TRACK_FIXTURES)
    if tracks_per_album != playback_track_count:
        raise RuntimeError(
            "The playback-start fixture requires tracksPerAlbum="
            f"{playback_track_count}, received {tracks_per_album}."
        )
    if tracks_per_album != len(TAG_RENAME_FIXTURE_TRACKS):
        raise RuntimeError(
            "The album-rename fixture requires tracksPerAlbum="
            f"{len(TAG_RENAME_FIXTURE_TRACKS)}, received {tracks_per_album}."
        )
    if tracks_per_album != len(TAG_SPLIT_FIXTURE_TRACKS):
        raise RuntimeError(
            "The selected-track split fixture requires tracksPerAlbum="
            f"{len(TAG_SPLIT_FIXTURE_TRACKS)}, received {tracks_per_album}."
        )
    if tracks_per_album != len(TAG_AUTO_NUMBER_FIXTURE_TRACKS):
        raise RuntimeError(
            "The auto-number fixture requires tracksPerAlbum="
            f"{len(TAG_AUTO_NUMBER_FIXTURE_TRACKS)}, received {tracks_per_album}."
        )
    if tracks_per_album < len(DDT_STUDIO_RECORDS_FIXTURE_TRACKS):
        raise RuntimeError(
            "The DDT Studio Records fixture requires at least "
            f"{len(DDT_STUDIO_RECORDS_FIXTURE_TRACKS)} tracks per album, received "
            f"{tracks_per_album}."
        )
    if tracks_per_album < len(DDT_REMIXES_FIXTURE_TRACKS):
        raise RuntimeError(
            "The DDT Remixes fixture requires at least "
            f"{len(DDT_REMIXES_FIXTURE_TRACKS)} tracks per album, received "
            f"{tracks_per_album}."
        )
    for fixture_album, fixture_tracks, _fixture_year in TAG_SPARSE_FIXTURES:
        if tracks_per_album != len(fixture_tracks):
            raise RuntimeError(
                f"The {fixture_album} fixture requires tracksPerAlbum="
                f"{len(fixture_tracks)}, received {tracks_per_album}."
            )
    track_order_fixture_deficit = tracks_per_album - TRACK_ORDER_FIXTURE_TRACK_COUNT
    ddt_renderer_fixture_deficit = (
        tracks_per_album
        - len(DDT_STUDIO_RECORDS_FIXTURE_TRACKS)
        + tracks_per_album
        - len(DDT_REMIXES_FIXTURE_TRACKS)
    )
    joseph_cover = stage_joseph_cover(library_root)
    loop_source = library_root / "loop-source-not-created.mp3"
    first_display_artist_index = min(
        range(artist_count),
        key=lambda index: (
            str(cover_specs[index % len(cover_specs)].get("artist") or "").casefold(),
            index,
        ),
    )
    search_family_slot_count = max(
        len(cover_specs),
        len(SEARCH_FAMILY_ARTISTS),
    )
    if artist_count < search_family_slot_count:
        raise RuntimeError(
            "The isolated E2E inventory needs one artist slot for every search-family fixture."
        )
    family_start_index = artist_count - search_family_slot_count
    search_family_artist_by_index = {
        family_start_index + offset: artist
        for offset, artist in enumerate(SEARCH_FAMILY_ARTISTS)
    }
    alias_fixture_start_index = max(0, family_start_index - len(ALIAS_PARITY_ARTIST_FIXTURES) - 1)
    alias_artist_by_index = {
        alias_fixture_start_index + offset: artist
        for offset, artist in enumerate(ALIAS_PARITY_ARTIST_FIXTURES)
    }
    alias_fixture_indices = set(alias_artist_by_index)
    problematic_artist_index = max(0, family_start_index - 1)
    if problematic_artist_index == first_display_artist_index:
        problematic_artist_index = max(0, problematic_artist_index - 1)
    reserved_indices = {
        first_display_artist_index,
        problematic_artist_index,
        *alias_artist_by_index,
        *search_family_artist_by_index,
    }
    primary_manifest_cover = cover_specs[0]
    primary_manifest_cover_identity = (
        str(primary_manifest_cover.get("artist") or "").strip(),
        str(primary_manifest_cover.get("album") or "").strip(),
        int(primary_manifest_cover.get("year") or 0),
    )
    primary_manifest_cover_lookup_artist_index = next(
        (
            index
            for index in range(artist_count)
            if index not in reserved_indices
            and (
                str(cover_specs[index % len(cover_specs)].get("artist") or "").strip(),
                str(cover_specs[index % len(cover_specs)].get("album") or "").strip(),
                int(cover_specs[index % len(cover_specs)].get("year") or 0),
            )
            == primary_manifest_cover_identity
        ),
        None,
    )
    if primary_manifest_cover_lookup_artist_index is None:
        raise RuntimeError("The isolated E2E inventory needs one artist for manifest cover lookup.")
    reserved_indices.add(primary_manifest_cover_lookup_artist_index)
    track_credit_artist_index = next(
        (index for index in range(artist_count) if index not in reserved_indices),
        None,
    )
    if track_credit_artist_index is None:
        raise RuntimeError("The isolated E2E inventory needs one artist for track-credit coverage.")
    reserved_indices.add(track_credit_artist_index)
    ordinary_track_credit_artist_index = next(
        (index for index in range(artist_count) if index not in reserved_indices),
        None,
    )
    if ordinary_track_credit_artist_index is None:
        raise RuntimeError("The isolated E2E inventory needs one ordinary artist for track-credit coverage.")
    reserved_indices.add(ordinary_track_credit_artist_index)
    rating_fixture_artist_index = next(
        (index for index in range(artist_count) if index not in reserved_indices),
        None,
    )
    if rating_fixture_artist_index is None:
        raise RuntimeError("The isolated E2E inventory needs one artist for album-rating coverage.")
    reserved_indices.add(rating_fixture_artist_index)
    rarity_fixture_artist_index = next(
        (index for index in range(artist_count) if index not in reserved_indices),
        None,
    )
    if rarity_fixture_artist_index is None:
        raise RuntimeError("The isolated E2E inventory needs one artist for rarity-edit coverage.")
    reserved_indices.add(rarity_fixture_artist_index)
    ddt_studio_records_fixture_artist_index = next(
        (index for index in range(artist_count) if index not in reserved_indices),
        None,
    )
    if ddt_studio_records_fixture_artist_index is None:
        raise RuntimeError(
            "The isolated E2E inventory needs one artist for DDT Studio Records coverage."
        )
    reserved_indices.add(ddt_studio_records_fixture_artist_index)
    playback_start_fixture_artist_index = next(
        (index for index in range(artist_count) if index not in reserved_indices),
        None,
    )
    if playback_start_fixture_artist_index is None:
        raise RuntimeError("The isolated E2E inventory needs one artist for playback-start coverage.")
    reserved_indices.add(playback_start_fixture_artist_index)
    cover_matching_fixture_artist_index = next(
        (index for index in range(artist_count) if index not in reserved_indices),
        None,
    )
    if cover_matching_fixture_artist_index is None:
        raise RuntimeError("The isolated E2E inventory needs one artist for cover-matching coverage.")
    reserved_indices.add(cover_matching_fixture_artist_index)
    artist_family_fixture_indices: dict[int, tuple[str, str]] = {}
    for fixture_role, member_artists in (
        ("compilation", COMPILATION_FAMILY_MEMBERS),
        ("control", CONTROL_FAMILY_MEMBERS),
        ("soundtrack", SOUNDTRACK_FAMILY_MEMBERS),
    ):
        for member_artist in member_artists:
            fixture_artist_index = next(
                (index for index in range(artist_count) if index not in reserved_indices),
                None,
            )
            if fixture_artist_index is None:
                raise RuntimeError(
                    "The isolated E2E inventory needs four artists for compilation-family coverage."
                )
            reserved_indices.add(fixture_artist_index)
            artist_family_fixture_indices[fixture_artist_index] = (
                fixture_role,
                member_artist,
            )
    alias_overflow_artist_index = next(
        (index for index in range(artist_count) if index not in reserved_indices),
        None,
    )
    if alias_overflow_artist_index is None:
        raise RuntimeError("The isolated E2E inventory needs one generic artist for fixture balancing.")
    reserved_indices.add(alias_overflow_artist_index)
    problematic_sidebar_artist_indices = [
        index
        for index in range(artist_count)
        if index not in reserved_indices
    ][:PROBLEMATIC_TRACK_SIDEBAR_FIXTURE_COUNT]
    if len(problematic_sidebar_artist_indices) != PROBLEMATIC_TRACK_SIDEBAR_FIXTURE_COUNT:
        raise RuntimeError("The isolated E2E inventory needs artists for Problematic Files sidebar scrolling.")
    problematic_sidebar_fixture_number_by_artist_index = {
        artist_index: fixture_number
        for fixture_number, artist_index in enumerate(problematic_sidebar_artist_indices, start=1)
    }
    redistributed_album_count = len(alias_fixture_indices) * max(0, albums_per_artist - 1)
    ddt_gallery_extra_album_count = len(DDT_GALLERY_ALBUMS) - albums_per_artist
    if redistributed_album_count < ddt_gallery_extra_album_count:
        raise RuntimeError(
            "The isolated E2E inventory cannot rebalance enough albums into the "
            "DDT renderer fixture."
        )
    seen_artists: set[str] = set()
    for artist_index in range(artist_count):
        seeded_artist = cover_specs[artist_index % len(cover_specs)]
        base_artist = (
            PROBLEMATIC_METADATA_ARTIST
            if artist_index == problematic_artist_index
            else LASTFM_SCROBBLE_ARTIST
            if artist_index == first_display_artist_index
            else TRACK_CREDIT_ALBUM_ARTIST
            if artist_index == track_credit_artist_index
            else ORDINARY_TRACK_CREDIT_ARTIST
            if artist_index == ordinary_track_credit_artist_index
            else RATING_FIXTURE_ARTIST
            if artist_index == rating_fixture_artist_index
            else RARITY_FIXTURE_ARTIST
            if artist_index == rarity_fixture_artist_index
            else DDT_STUDIO_RECORDS_FIXTURE_ARTIST
            if artist_index == ddt_studio_records_fixture_artist_index
            else PLAYBACK_START_ARTIST
            if artist_index == playback_start_fixture_artist_index
            else COVER_MATCHING_ARTIST
            if artist_index == cover_matching_fixture_artist_index
            else artist_family_fixture_indices[artist_index][1]
            if artist_index in artist_family_fixture_indices
            else alias_artist_by_index.get(
                artist_index,
                search_family_artist_by_index.get(
                    artist_index,
                    str(seeded_artist.get("artist") or "").strip() or _artist_name(artist_index),
                ),
            )
        )
        artist = base_artist
        if artist.casefold() in seen_artists:
            artist = f"{base_artist} Fixture {artist_index + 1:03d}"
        seen_artists.add(artist.casefold())
        seen_albums: set[str] = set()
        artist_album_count = (
            1
            if artist_index in alias_fixture_indices
            else len(DDT_GALLERY_ALBUMS)
            if artist_index == ddt_studio_records_fixture_artist_index
            else albums_per_artist + 1
            if artist_index == rarity_fixture_artist_index
            else (
                albums_per_artist
                + redistributed_album_count
                - ddt_gallery_extra_album_count
                - 1
            )
            if artist_index == alias_overflow_artist_index
            else albums_per_artist
        )
        for album_index in range(artist_album_count):
            is_lastfm_scrobble_fixture = (
                artist_index == first_display_artist_index and album_index == 0
            )
            is_joseph_fixture = artist == JOSEPH_ARTIST and album_index == 0
            is_problematic_track_navigation_fixture = (
                artist == PROBLEMATIC_TRACK_ARTIST and album_index == 1
            )
            problematic_sidebar_fixture_number = (
                problematic_sidebar_fixture_number_by_artist_index.get(artist_index)
                if album_index == 0
                else None
            )
            is_problematic_sidebar_scroll_fixture = problematic_sidebar_fixture_number is not None
            is_track_credit_fixture = (
                artist_index == track_credit_artist_index and album_index == 0
            )
            is_bonus_duration_false_positive_fixture = (
                artist_index == track_credit_artist_index and album_index == 1
            )
            is_bonus_duration_control_fixture = (
                artist_index == track_credit_artist_index and album_index == 2
            )
            is_bonus_duration_numeric_multidisc_fixture = (
                artist_index == track_credit_artist_index and album_index == 3
            )
            is_ordinary_track_credit_fixture = (
                artist_index == ordinary_track_credit_artist_index and album_index == 0
            )
            rating_fixture = (
                RATING_FIXTURES[album_index]
                if artist_index == rating_fixture_artist_index and album_index < len(RATING_FIXTURES)
                else None
            )
            is_rarity_fixture = (
                artist_index == rarity_fixture_artist_index and album_index == 0
            )
            is_tag_backdrop_fixture = (
                artist_index == rarity_fixture_artist_index and album_index == 1
            )
            is_tag_rename_fixture = (
                artist_index == rarity_fixture_artist_index and album_index == 2
            )
            is_tag_split_fixture = (
                artist_index == rarity_fixture_artist_index and album_index == 3
            )
            is_ddt_studio_records_fixture = (
                artist_index == ddt_studio_records_fixture_artist_index
                and album_index == DDT_STUDIO_RECORDS_FIXTURE_ALBUM_INDEX
            )
            is_coverless_ddt_studio_records_fixture = is_ddt_studio_records_fixture
            is_ddt_remixes_fixture = (
                artist_index == ddt_studio_records_fixture_artist_index
                and album_index == DDT_REMIXES_FIXTURE_ALBUM_INDEX
            )
            sparse_tag_fixture = (
                TAG_SPARSE_FIXTURES[album_index - 4]
                if (
                    artist_index == rarity_fixture_artist_index
                    and 4 <= album_index < 4 + len(TAG_SPARSE_FIXTURES)
                )
                else None
            )
            is_track_order_fixture = (
                artist_index == rarity_fixture_artist_index
                and album_index == TRACK_ORDER_FIXTURE_ALBUM_INDEX
            )
            is_track_order_balance_album = (
                artist_index == rarity_fixture_artist_index
                and album_index == TRACK_ORDER_FIXTURE_BALANCE_ALBUM_INDEX
            )
            is_tag_auto_number_fixture = (
                artist_index == rarity_fixture_artist_index
                and album_index == TAG_AUTO_NUMBER_FIXTURE_ALBUM_INDEX
            )
            is_playback_start_fixture = (
                artist_index == playback_start_fixture_artist_index and album_index == 0
            )
            is_cover_matching_fixture = (
                artist_index == cover_matching_fixture_artist_index and album_index == 0
            )
            artist_family_fixture = artist_family_fixture_indices.get(artist_index)
            is_compilation_family_fixture = (
                artist_family_fixture == ("compilation", COMPILATION_FAMILY_MEMBERS[0])
                and album_index == 0
            )
            is_control_family_fixture = (
                artist_family_fixture == ("control", CONTROL_FAMILY_MEMBERS[0])
                and album_index == 0
            )
            is_soundtrack_family_fixture = (
                artist_family_fixture == ("soundtrack", SOUNDTRACK_FAMILY_MEMBERS[0])
                and album_index == 0
            )
            is_artist_family_solo_fixture = bool(
                artist_family_fixture
                and album_index
                == (
                    1
                    if artist_family_fixture[1]
                    in {
                        COMPILATION_FAMILY_MEMBERS[0],
                        CONTROL_FAMILY_MEMBERS[0],
                        SOUNDTRACK_FAMILY_MEMBERS[0],
                    }
                    else 0
                )
            )
            is_progressive_candidate_fixture = (
                artist_index == primary_manifest_cover_lookup_artist_index
                and album_index == 6
            )
            is_automatic_candidate_fixture = (
                artist_index == primary_manifest_cover_lookup_artist_index
                and album_index == 7
            )
            is_user_owned_improvement_fixture = (
                artist_index == primary_manifest_cover_lookup_artist_index
                and album_index == 8
            )
            cover = joseph_cover if is_joseph_fixture else seeded_artist
            user_owned_cover_source = (
                cover_specs[1] if is_user_owned_improvement_fixture else None
            )
            alias_album = (
                (COVER_LOOKUP_CONJUNCTION_ALBUM, COVER_LOOKUP_CONJUNCTION_YEAR)
                if album_index == 0 and artist == COVER_LOOKUP_CONJUNCTION_ARTIST
                else ALIAS_PARITY_ARTIST_FIXTURES.get(artist)
                if album_index == 0
                else None
            )
            base_album = (
                PROBLEMATIC_ENCODING_ALBUM
                if artist_index == problematic_artist_index and album_index == 0
                else PROBLEMATIC_MISSING_METADATA_ALBUM
                if artist_index == problematic_artist_index and album_index == 1
                else PROBLEMATIC_LEGACY_IGNORED_ALBUM
                if artist_index == problematic_artist_index and album_index == 2
                else LASTFM_SCROBBLE_ALBUM
                if is_lastfm_scrobble_fixture
                else JOSEPH_ALBUM
                if is_joseph_fixture
                else PROBLEMATIC_TRACK_ALBUM
                if is_problematic_track_navigation_fixture
                else f"Comfortably Numb Sidebar Fixture {problematic_sidebar_fixture_number:02d}"
                if is_problematic_sidebar_scroll_fixture
                else TRACK_CREDIT_ALBUM
                if is_track_credit_fixture
                else BONUS_DURATION_FALSE_POSITIVE_ALBUM
                if is_bonus_duration_false_positive_fixture
                else BONUS_DURATION_CONTROL_ALBUM
                if is_bonus_duration_control_fixture
                else BONUS_DURATION_NUMERIC_MULTIDISC_ALBUM
                if is_bonus_duration_numeric_multidisc_fixture
                else ORDINARY_TRACK_CREDIT_ALBUM
                if is_ordinary_track_credit_fixture
                else rating_fixture[1]
                if rating_fixture
                else RARITY_FIXTURE_ALBUM
                if is_rarity_fixture
                else TAG_BACKDROP_FIXTURE_ALBUM
                if is_tag_backdrop_fixture
                else TAG_RENAME_FIXTURE_ALBUM
                if is_tag_rename_fixture
                else TAG_SPLIT_FIXTURE_ALBUM
                if is_tag_split_fixture
                else DDT_GALLERY_ALBUMS[album_index][1]
                if (
                    artist_index == ddt_studio_records_fixture_artist_index
                    and album_index < len(DDT_GALLERY_ALBUMS)
                )
                else sparse_tag_fixture[0]
                if sparse_tag_fixture
                else TRACK_ORDER_FIXTURE_ALBUM
                if is_track_order_fixture
                else TAG_AUTO_NUMBER_FIXTURE_ALBUM
                if is_tag_auto_number_fixture
                else PLAYBACK_START_ALBUM
                if is_playback_start_fixture
                else COVER_MATCHING_ALBUM
                if is_cover_matching_fixture
                else COMPILATION_FAMILY_ALBUM
                if is_compilation_family_fixture
                else CONTROL_FAMILY_ALBUM
                if is_control_family_fixture
                else SOUNDTRACK_FAMILY_ALBUM
                if is_soundtrack_family_fixture
                else ARTIST_FAMILY_SOLO_ALBUMS[artist]
                if is_artist_family_solo_fixture
                else alias_album[0]
                if alias_album
                else str(cover.get("album") or "").strip() or _album_name(album_index)
            )
            album = base_album
            if album.casefold() in seen_albums:
                album = f"{base_album} Fixture {album_index + 1:02d}"
            seen_albums.add(album.casefold())
            year = (
                LASTFM_SCROBBLE_YEAR
                if is_lastfm_scrobble_fixture
                else JOSEPH_YEAR
                if is_joseph_fixture
                else 2023
                if is_problematic_track_navigation_fixture
                else PROBLEMATIC_LEGACY_IGNORED_YEAR
                if (
                    artist_index == problematic_artist_index
                    and album_index == 2
                )
                else RATING_FIXTURE_YEAR
                if rating_fixture
                else RARITY_FIXTURE_YEAR
                if is_rarity_fixture
                else TAG_BACKDROP_FIXTURE_YEAR
                if is_tag_backdrop_fixture
                else TAG_RENAME_FIXTURE_YEAR
                if is_tag_rename_fixture or is_tag_split_fixture
                else DDT_GALLERY_ALBUMS[album_index][0]
                if (
                    artist_index == ddt_studio_records_fixture_artist_index
                    and album_index < len(DDT_GALLERY_ALBUMS)
                )
                else sparse_tag_fixture[2]
                if sparse_tag_fixture
                else TRACK_ORDER_FIXTURE_YEAR
                if is_track_order_fixture
                else TAG_AUTO_NUMBER_FIXTURE_YEAR
                if is_tag_auto_number_fixture
                else PLAYBACK_START_YEAR
                if is_playback_start_fixture
                else COVER_MATCHING_YEAR
                if is_cover_matching_fixture
                else ARTIST_FAMILY_FIXTURE_YEAR
                if (
                    is_compilation_family_fixture
                    or is_control_family_fixture
                    or is_soundtrack_family_fixture
                    or is_artist_family_solo_fixture
                )
                else alias_album[1]
                if alias_album
                else int(cover.get("year") or 0) or (1995 + (album_index % 25))
            )
            is_problematic_fixture_album = (
                artist_index == problematic_artist_index and album_index in {0, 1}
            )
            album_directory_name = (
                "Questions"
                if (
                    artist_index == problematic_artist_index
                    and album_index == 2
                )
                else album.replace(":", " -")
            )
            artist_directory_name = (
                "Three Stars Artist"
                if artist == "***"
                else "Snow White Composite Credit"
                if artist == SNOW_WHITE_RAW_ARTIST
                else artist
            )
            if artist in MORSE_ALIAS_FIXTURES or artist in NEAL_MORSE_FAMILY_ARTISTS:
                album_dir = (
                    library_root
                    / "Progressive Projects"
                    / "Morse Family"
                    / artist_directory_name
                    / album_directory_name
                )
            elif artist in FLOWER_KINGS_FAMILY_ARTISTS:
                album_dir = (
                    library_root
                    / "Progressive Projects"
                    / "Flower Kings Family"
                    / artist_directory_name
                    / album_directory_name
                )
            elif artist in WHITESPACE_FAMILY_FIXTURES:
                album_dir = (
                    library_root
                    / "Progressive Projects"
                    / "Whitespace Family"
                    / artist_directory_name
                    / album_directory_name
                )
            elif (
                is_artist_family_solo_fixture
                and artist_family_fixture
                and artist_family_fixture[0] == "soundtrack"
            ):
                album_dir = (
                    library_root
                    / "OST"
                    / "!!Movies"
                    / artist_directory_name
                    / album_directory_name
                )
            elif is_soundtrack_family_fixture:
                album_dir = (
                    library_root
                    / "Soundtracks"
                    / "Shared Film"
                    / artist_directory_name
                    / album_directory_name
                )
            else:
                album_dir = library_root / artist_directory_name / album_directory_name
            is_first_display_album = (
                artist_index == first_display_artist_index and album_index == 0
            )
            is_primary_manifest_cover_lookup_album = (
                album_index == 0
                and artist == str(cover_specs[0].get("artist") or "").strip()
                and album == str(cover_specs[0].get("album") or "").strip()
                and year == int(cover_specs[0].get("year") or 0)
            )
            is_partial_cover_lookup_mutation_fixture = (
                artist_index == primary_manifest_cover_lookup_artist_index
                and album_index == 1
            )
            if is_joseph_fixture:
                active_cover_path = _materialize_album_image(
                    Path(str(cover["staged_path"])),
                    album_dir / JOSEPH_COVER_FILENAME,
                )
            elif (
                is_coverless_ddt_studio_records_fixture
                or is_problematic_track_navigation_fixture
                or is_progressive_candidate_fixture
                or is_automatic_candidate_fixture
            ):
                active_cover_path = None
            elif is_primary_manifest_cover_lookup_album:
                active_cover_path = materialize_cover_lookup_album_art(
                    album_dir,
                    cover_specs,
                )
            elif is_first_display_album:
                active_cover_path, _other_art_path = materialize_album_art(album_dir, cover)
            elif is_partial_cover_lookup_mutation_fixture:
                active_cover_path = _materialize_independent_album_image(
                    Path(str(cover["staged_path"])),
                    album_dir / "cover.jpg",
                )
            elif is_user_owned_improvement_fixture:
                active_cover_path = materialize_user_owned_cover(
                    album_dir,
                    Path(str(user_owned_cover_source["staged_path"])),
                )
                user_owned_cover_source["user_owned_cover_path"] = str(
                    active_cover_path.resolve()
                )
            else:
                active_cover_path = _materialize_album_image(
                    Path(str(cover["staged_path"])),
                    album_dir / "cover.jpg",
                )
            active_cover_revision = (
                None
                if (
                    is_coverless_ddt_studio_records_fixture
                    or is_problematic_track_navigation_fixture
                    or is_progressive_candidate_fixture
                    or is_automatic_candidate_fixture
                )
                else _cached_cover_revision(
                    active_cover_path
                    if is_user_owned_improvement_fixture
                    else
                    Path(str(cover["staged_path"])),
                    cover_revisions_by_source,
                )
            )
            album_count += 1
            album_track_count = (
                TRACK_ORDER_FIXTURE_TRACK_COUNT
                if is_track_order_fixture
                else tracks_per_album + track_order_fixture_deficit + ddt_renderer_fixture_deficit
                if is_track_order_balance_album
                else len(DDT_STUDIO_RECORDS_FIXTURE_TRACKS)
                if is_ddt_studio_records_fixture
                else len(DDT_REMIXES_FIXTURE_TRACKS)
                if is_ddt_remixes_fixture
                else len(RARITY_FIXTURE_TRACKS)
                if is_rarity_fixture
                else len(TAG_BACKDROP_FIXTURE_TRACKS)
                if is_tag_backdrop_fixture
                else tracks_per_album
            )
            for track_index in range(album_track_count):
                track_number = track_index + 1
                stored_track_number = (
                    track_index - 2
                    if is_bonus_duration_numeric_multidisc_fixture and track_index >= 3
                    else track_number
                )
                title = f"{album} Track {track_number}"
                track_artist = artist
                track_path = album_dir / f"{track_number:02d} - Track {track_number}.mp3"
                if is_rarity_fixture:
                    rarity_track = RARITY_FIXTURE_TRACKS[track_index]
                    title = str(rarity_track["title"])
                    track_path = album_dir / str(rarity_track["filename"])
                    stored_track_number = int(rarity_track.get("track_number") or track_number)
                if is_tag_backdrop_fixture:
                    backdrop_track = TAG_BACKDROP_FIXTURE_TRACKS[track_index]
                    title = str(backdrop_track["title"])
                    track_path = album_dir / str(backdrop_track["filename"])
                if is_tag_rename_fixture:
                    rename_track = TAG_RENAME_FIXTURE_TRACKS[track_index]
                    title = str(rename_track["title"])
                    track_path = album_dir / str(rename_track["filename"])
                if is_tag_split_fixture:
                    split_track = TAG_SPLIT_FIXTURE_TRACKS[track_index]
                    title = str(split_track["title"])
                    track_path = album_dir / str(split_track["filename"])
                if is_tag_auto_number_fixture:
                    auto_number_track = TAG_AUTO_NUMBER_FIXTURE_TRACKS[track_index]
                    title = str(auto_number_track["title"])
                    track_path = album_dir / str(auto_number_track["filename"])
                if is_ddt_studio_records_fixture:
                    ddt_track = DDT_STUDIO_RECORDS_FIXTURE_TRACKS[track_index]
                    title = str(ddt_track["title"])
                    track_path = album_dir / str(ddt_track["filename"])
                if is_ddt_remixes_fixture:
                    ddt_track = DDT_REMIXES_FIXTURE_TRACKS[track_index]
                    title = str(ddt_track["title"])
                    track_path = album_dir / str(ddt_track["filename"])
                if sparse_tag_fixture:
                    sparse_track = sparse_tag_fixture[1][track_index]
                    title = str(sparse_track["title"])
                    track_path = album_dir / str(sparse_track["filename"])
                if is_track_order_fixture:
                    track_order_track = TRACK_ORDER_FIXTURE_TRACKS[track_index]
                    title = str(track_order_track["title"])
                    track_path = album_dir / str(track_order_track["filename"])
                if is_playback_start_fixture:
                    playback_track = PLAYBACK_START_TRACK_FIXTURES[track_index]
                    title = str(playback_track["title"])
                    track_path = album_dir / str(playback_track["filename"])
                if is_lastfm_scrobble_fixture and track_index == 0:
                    title = LASTFM_SCROBBLE_TRACK
                    track_path = album_dir / f"01 - {LASTFM_SCROBBLE_TRACK}.mp3"
                    loop_source = track_path
                if is_track_credit_fixture:
                    fixture_title, fixture_artist = TRACK_CREDIT_TRACK_FIXTURES[
                        track_index % len(TRACK_CREDIT_TRACK_FIXTURES)
                    ]
                    track_artist = fixture_artist
                    if track_index < len(TRACK_CREDIT_TRACK_FIXTURES):
                        title = fixture_title
                        track_path = album_dir / f"{track_number:02d} - Credit Signal {track_number}.mp3"
                if is_compilation_family_fixture:
                    track_artist = COMPILATION_FAMILY_MEMBERS[
                        track_index % len(COMPILATION_FAMILY_MEMBERS)
                    ]
                    title = f"Compilation Signal {track_number:02d}"
                if is_control_family_fixture:
                    track_artist = CONTROL_FAMILY_MEMBERS[
                        track_index % len(CONTROL_FAMILY_MEMBERS)
                    ]
                    title = f"Control Signal {track_number:02d}"
                    track_path = (
                        album_dir
                        / f"Disc {(track_index % len(CONTROL_FAMILY_MEMBERS)) + 1}"
                        / f"{track_number:02d} - Track {track_number}.mp3"
                    )
                if is_soundtrack_family_fixture:
                    track_artist = SOUNDTRACK_FAMILY_MEMBERS[
                        track_index % len(SOUNDTRACK_FAMILY_MEMBERS)
                    ]
                    title = f"Soundtrack Signal {track_number:02d}"
                if is_ordinary_track_credit_fixture and track_index == 0:
                    title = ORDINARY_TRACK_CREDIT_TITLE
                    track_path = album_dir / "01 - Ordinary Feature Signal.mp3"
                elif is_ordinary_track_credit_fixture and track_index == 1:
                    title = ORDINARY_ARTIST_MARKER_TRACK_TITLE
                    track_artist = ORDINARY_ARTIST_MARKER_TRACK_ARTIST
                    track_path = album_dir / "02 - Artist Marker Signal.mp3"
                if artist == SNOW_WHITE_RAW_ARTIST and album == SNOW_WHITE_ALBUM:
                    track_artist = SNOW_WHITE_TRACK_ARTISTS[
                        track_index % len(SNOW_WHITE_TRACK_ARTISTS)
                    ]
                is_problematic_track_navigation_target = (
                    is_problematic_track_navigation_fixture
                    and track_number == PROBLEMATIC_TRACK_NUMBER
                )
                if is_problematic_track_navigation_target:
                    title = PROBLEMATIC_TRACK_TITLE
                    track_path = album_dir / f"{track_number:02d} - {PROBLEMATIC_TRACK_TITLE}.mp3"
                elif is_problematic_track_navigation_fixture and track_number == 1:
                    title = PROBLEMATIC_TRACK_HEALTHY_TITLE
                    track_path = album_dir / f"{track_number:02d} - {PROBLEMATIC_TRACK_HEALTHY_TITLE}.mp3"
                if is_problematic_sidebar_scroll_fixture and track_number == 1:
                    title = PROBLEMATIC_TRACK_TITLE
                    track_path = album_dir / f"{track_number:02d} - {PROBLEMATIC_TRACK_TITLE}.mp3"
                if is_problematic_fixture_album and album_index == 0 and track_number == 1:
                    title = PROBLEMATIC_ENCODING_TRACK_TITLE
                    track_artist = PROBLEMATIC_ENCODING_TRACK_ARTIST
                duration_seconds = (
                    60
                    if is_bonus_duration_false_positive_fixture
                    else 60
                    if is_bonus_duration_control_fixture and track_index < 3
                    else 90
                    if is_bonus_duration_control_fixture
                    else 60
                    if is_bonus_duration_numeric_multidisc_fixture
                    else 4
                    if (
                        is_rarity_fixture
                        or is_tag_backdrop_fixture
                        or is_tag_rename_fixture
                        or is_tag_split_fixture
                        or is_tag_auto_number_fixture
                        or is_ddt_studio_records_fixture
                        or is_ddt_remixes_fixture
                        or sparse_tag_fixture
                    )
                    else int(PLAYBACK_START_TRACK_FIXTURES[track_index]["duration_seconds"])
                    if is_playback_start_fixture
                    else 180 + ((artist_index + album_index + track_index) % 90)
                )
                resolved_track_path = _absolute_fixture_path(track_path)
                file_cache[str(resolved_track_path)] = {
                    "path": str(resolved_track_path),
                    "mtime": 0.0,
                    "size": 0,
                    "album": album,
                    "album_artist": (
                        SNOW_WHITE_DISPLAY_ARTIST
                        if artist == SNOW_WHITE_RAW_ARTIST and album == SNOW_WHITE_ALBUM
                        else COMPILATION_FAMILY_SOURCE_ARTIST
                        if is_compilation_family_fixture
                        else CONTROL_FAMILY_SOURCE_ARTIST
                        if is_control_family_fixture
                        else SOUNDTRACK_FAMILY_SOURCE_ARTIST
                        if is_soundtrack_family_fixture
                        else artist
                    ),
                    "title": title,
                    "track_number": (
                        None
                        if (
                            is_problematic_fixture_album
                            or (is_problematic_track_navigation_fixture and track_number >= 2)
                            or (is_problematic_sidebar_scroll_fixture and track_number == 1)
                            or is_track_order_fixture
                        )
                        else stored_track_number
                    ),
                    "disc_number": (
                        None
                        if (
                            is_track_order_fixture
                            or (
                                is_bonus_duration_numeric_multidisc_fixture
                                and track_index < 3
                            )
                        )
                        else 2
                        if (
                            (is_bonus_duration_control_fixture and track_index >= 3)
                            or (
                                is_bonus_duration_numeric_multidisc_fixture
                                and track_index >= 3
                            )
                        )
                        else 1
                    ),
                    "disc_number_raw": (
                        None
                        if (
                            is_track_order_fixture
                            or (
                                is_bonus_duration_numeric_multidisc_fixture
                                and track_index < 3
                            )
                        )
                        else "Bonus Disc"
                        if is_bonus_duration_control_fixture and track_index >= 3
                        else "2"
                        if (
                            is_bonus_duration_numeric_multidisc_fixture
                            and track_index >= 3
                        )
                        else "1"
                    ),
                    "artist": track_artist,
                    "duration_seconds": duration_seconds,
                    "duration_display": _format_duration(duration_seconds),
                    "cover_path": (
                        None
                        if (
                            is_problematic_fixture_album
                            or is_problematic_track_navigation_fixture
                            or is_coverless_ddt_studio_records_fixture
                            or is_progressive_candidate_fixture
                            or is_automatic_candidate_fixture
                        )
                        else str(active_cover_path)
                    ),
                    "cover_revision": (
                        None
                        if (
                            is_problematic_fixture_album
                            or is_problematic_track_navigation_fixture
                            or is_coverless_ddt_studio_records_fixture
                            or is_progressive_candidate_fixture
                            or is_automatic_candidate_fixture
                        )
                        else active_cover_revision
                    ),
                    "local_cover_width": (
                        None
                        if (
                            is_coverless_ddt_studio_records_fixture
                            or is_progressive_candidate_fixture
                            or is_automatic_candidate_fixture
                        )
                        else 640
                        if is_user_owned_improvement_fixture
                        else cover.get("width")
                    ),
                    "local_cover_height": (
                        None
                        if (
                            is_coverless_ddt_studio_records_fixture
                            or is_progressive_candidate_fixture
                            or is_automatic_candidate_fixture
                        )
                        else 640
                        if is_user_owned_improvement_fixture
                        else cover.get("height")
                    ),
                    "cover_selection_origin": (
                        "user" if is_user_owned_improvement_fixture else None
                    ),
                    "remote_cover_url": (
                        "https://existing-cover.example/user-owned-cover.jpg"
                        if is_user_owned_improvement_fixture
                        else None
                    ),
                    "remote_cover_thumbnail_url": (
                        "https://existing-cover.example/user-owned-thumbnail.jpg"
                        if is_user_owned_improvement_fixture
                        else None
                    ),
                    "remote_cover_source": (
                        "fixture-existing" if is_user_owned_improvement_fixture else None
                    ),
                    "remote_cover_source_label": (
                        "Fixture Existing Cover"
                        if is_user_owned_improvement_fixture
                        else None
                    ),
                    "remote_cover_album_url": (
                        "https://existing-cover.example/user-owned-album"
                        if is_user_owned_improvement_fixture
                        else None
                    ),
                    "remote_cover_width": (
                        640
                        if is_user_owned_improvement_fixture
                        else None
                    ),
                    "remote_cover_height": (
                        640
                        if is_user_owned_improvement_fixture
                        else None
                    ),
                    "year": (
                        DDT_STUDIO_RECORDS_TOUCHED_TRACK_YEAR
                        if (
                            is_ddt_studio_records_fixture
                            and track_number in DDT_STUDIO_RECORDS_TOUCHED_TRACK_NUMBERS
                        )
                        else None
                        if (
                            is_problematic_fixture_album
                            or (
                                is_problematic_track_navigation_fixture
                                and track_number in {5, 7}
                            )
                            or (
                                is_ddt_studio_records_fixture
                                and track_number in DDT_STUDIO_RECORDS_YEARLESS_TRACK_NUMBERS
                            )
                        )
                        else year
                    ),
                    "release_date": (
                        f"{DDT_STUDIO_RECORDS_TOUCHED_TRACK_YEAR}-01-01"
                        if (
                            is_ddt_studio_records_fixture
                            and track_number in DDT_STUDIO_RECORDS_TOUCHED_TRACK_NUMBERS
                        )
                        else None
                        if (
                            is_problematic_fixture_album
                            or (
                                is_ddt_studio_records_fixture
                                and track_number in DDT_STUDIO_RECORDS_YEARLESS_TRACK_NUMBERS
                            )
                        )
                        else f"{year}-01-01"
                    ),
                    "genre": TAG_SPARSE_FIXTURE_GENRE if sparse_tag_fixture else None,
                    "edition": (
                        None
                        if (
                            is_rarity_fixture
                            or (artist == SNOW_WHITE_RAW_ARTIST and album == SNOW_WHITE_ALBUM)
                            or is_cover_matching_fixture
                            or is_ddt_studio_records_fixture
                        )
                        else "Fixture Edition"
                    ),
                    "album_rating": fixture_album_rating(
                        rating_fixture,
                        artist_index,
                        album_index,
                    ),
                    "library_root_id": "isolated-e2e-root",
                    "library_root_category": "main_library",
                    "exception_type": None,
                    "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
                    "comment": (
                        f"{TRACK_DESCRIPTION} artist={artist_index} album={album_index} "
                        f"track={track_index} checksum={artist_index:03d}-{album_index:03d}-{track_index:03d}"
                    ),
                }
    ensure_playable_loop_source(loop_source)
    loop_stat = loop_source.stat()
    resolved_loop_source = _absolute_fixture_path(loop_source)
    file_cache[str(resolved_loop_source)]["mtime"] = loop_stat.st_mtime
    file_cache[str(resolved_loop_source)]["size"] = loop_stat.st_size
    return file_cache, loop_source, artist_count, album_count


def materialize_fixture_track_files(
    file_cache: dict[str, dict[str, object]],
    playable_loop_source: Path,
) -> None:
    from mutagen.id3 import ID3, ID3NoHeaderError, TALB, TDRC, TIT2, TPE1, TPE2, TPOS, TRCK, TXXX

    loop_path = _absolute_fixture_path(playable_loop_source)
    playback_album_dir = loop_path.parent
    prepared_parent_dirs: set[Path] = set()
    for cache_path, metadata in file_cache.items():
        track_path = _absolute_fixture_path(
            Path(str(metadata.get("path") or cache_path))
        )
        if track_path != loop_path:
            track_parent = track_path.parent
            if track_parent not in prepared_parent_dirs:
                track_parent.mkdir(parents=True, exist_ok=True)
                prepared_parent_dirs.add(track_parent)
            is_player_artwork_fixture_album = (
                str(metadata.get("album_artist") or "").strip() == JOSEPH_ARTIST
                and str(metadata.get("album") or "").strip() == JOSEPH_ALBUM
            )
            is_track_credit_player_fixture_album = (
                str(metadata.get("album_artist") or "").strip()
                == TRACK_CREDIT_ALBUM_ARTIST
                and str(metadata.get("album") or "").strip() == TRACK_CREDIT_ALBUM
            )
            is_cover_persistence_fixture_track = (
                str(metadata.get("album_artist") or "").strip()
                == COVER_PERSISTENCE_ARTIST
                and str(metadata.get("album") or "").strip()
                == COVER_PERSISTENCE_ALBUM
            )
            is_cover_candidate_scan_fixture_track = (
                str(metadata.get("album_artist") or "").strip() == "Mastodon"
                and str(metadata.get("album") or "").strip()
                in {"Crack The Skye Fixture 08", "Crack The Skye Fixture 09"}
            )
            is_problematic_encoding_fixture_track = (
                str(metadata.get("album_artist") or "").strip()
                == PROBLEMATIC_METADATA_ARTIST
                and str(metadata.get("album") or "").strip()
                == PROBLEMATIC_ENCODING_ALBUM
            )
            copy_playable_source = (
                track_path.parent == playback_album_dir
                or is_player_artwork_fixture_album
                or is_track_credit_player_fixture_album
                or is_cover_persistence_fixture_track
                or is_cover_candidate_scan_fixture_track
                or is_problematic_encoding_fixture_track
            )
            created_track = False
            try:
                if copy_playable_source:
                    with loop_path.open("rb") as source, track_path.open("xb") as target:
                        shutil.copyfileobj(source, target)
                else:
                    track_path.touch(exist_ok=False)
                created_track = True
            except FileExistsError:
                if not track_path.is_file():
                    raise
            if created_track and is_problematic_encoding_fixture_track:
                try:
                    tags = ID3(track_path)
                except ID3NoHeaderError:
                    tags = ID3()
                for frame_id in ("TALB", "TDRC", "TIT2", "TPE1", "TPE2", "TRCK"):
                    tags.delall(frame_id)
                album_artist = str(metadata.get("album_artist") or "").strip()
                track_artist = str(metadata.get("artist") or album_artist).strip()
                tags.add(TPE1(encoding=3, text=[track_artist]))
                tags.add(TPE2(encoding=3, text=[album_artist]))
                tags.add(TALB(encoding=3, text=[str(metadata.get("album") or "").strip()]))
                tags.add(TIT2(encoding=3, text=[str(metadata.get("title") or track_path.stem).strip()]))
                track_number = metadata.get("track_number")
                if track_number is not None:
                    tags.add(TRCK(encoding=3, text=[str(int(track_number))]))
                release_date = str(
                    metadata.get("release_date") or metadata.get("year") or ""
                ).strip()
                if release_date:
                    tags.add(TDRC(encoding=3, text=[release_date]))
                tags.save(track_path)
            if created_track and (
                is_cover_persistence_fixture_track
                or is_cover_candidate_scan_fixture_track
            ):
                try:
                    tags = ID3(track_path)
                except ID3NoHeaderError:
                    tags = ID3()
                for frame_id in (
                    "TALB",
                    "TDRC",
                    "TIT2",
                    "TPE1",
                    "TPE2",
                    "TPOS",
                    "TRCK",
                    "TXXX:Album Edition",
                ):
                    tags.delall(frame_id)
                album_artist = str(metadata.get("album_artist") or "").strip()
                track_artist = str(metadata.get("artist") or album_artist).strip()
                release_date = str(
                    metadata.get("release_date") or metadata.get("year") or ""
                ).strip()
                tags.add(TPE1(encoding=3, text=[track_artist]))
                tags.add(TPE2(encoding=3, text=[album_artist]))
                tags.add(TALB(encoding=3, text=[str(metadata.get("album") or "").strip()]))
                tags.add(TIT2(encoding=3, text=[str(metadata.get("title") or track_path.stem).strip()]))
                tags.add(TRCK(encoding=3, text=[str(int(metadata.get("track_number") or 0))]))
                tags.add(TPOS(encoding=3, text=[str(int(metadata.get("disc_number") or 0))]))
                tags.add(TDRC(encoding=3, text=[release_date]))
                edition = str(metadata.get("edition") or "").strip()
                if edition:
                    tags.add(TXXX(encoding=3, desc="Album Edition", text=[edition]))
                tags.save(track_path)
        track_stat = track_path.stat()
        metadata["mtime"] = track_stat.st_mtime
        metadata["size"] = track_stat.st_size


def configure_isolated_environment(
    temp_root: Path,
    runtime_database_url: str,
    provider_port: int,
    *,
    use_seeded_cover_misses: bool = False,
) -> Path:
    app_data_dir = temp_root / "app-data"
    library_root = temp_root / "media"
    session_dir = temp_root / "session"
    temp_dir = temp_root / "tmp"
    for path in (app_data_dir, library_root, session_dir, temp_dir):
        path.mkdir(parents=True, exist_ok=True)
    environment = {
        "MUSIC_DIR": str(library_root),
        "MUSIC_APP_DATA_DIR": str(app_data_dir),
        "MUSIC_CACHE_PATH": str(app_data_dir / "inert-library-cache.json"),
        "MUSIC_COVER_CACHE_PATH": str(app_data_dir / "inert-cover-cache.json"),
        "MUSIC_BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS": (
            "43200" if use_seeded_cover_misses else "0"
        ),
        "MUSIC_BULK_COVER_JOB_WORKERS": "4",
        "MUSIC_LIBRARY_ROOTS_PATH": str(app_data_dir / "inert-library-roots.json"),
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_database_url,
        "ALBUM_HAVEN_PERSISTENCE_DEFAULT": "postgres",
        "ALBUM_HAVEN_COVER_PROVIDER_GROUPS": "music_services,manual_urls,discogs,cover_art_archive",
        "ALBUM_HAVEN_ENABLED_MUSIC_SERVICES": "apple",
        "COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS": "24",
        "APPLE_API_BASE_URL": f"http://127.0.0.1:{provider_port}/itunes",
        "DUCKDUCKGO_SEARCH_BASE_URL": (
            f"http://127.0.0.1:{provider_port}/duckduckgo-search"
        ),
        "BING_SEARCH_BASE_URL": f"http://127.0.0.1:{provider_port}/bing-search",
        "MUSICBRAINZ_BASE_URL": f"http://127.0.0.1:{provider_port}/musicbrainz",
        "COVER_ART_ARCHIVE_BASE_URL": f"http://127.0.0.1:{provider_port}/coverartarchive",
        "DISCOGS_API_BASE_URL": f"http://127.0.0.1:{provider_port}/discogs",
        "MUSIC_CACHE_MAX_AGE_SECONDS": "0",
        "MUSICBRAINZ_ENABLED": "1",
        "DISCOGS_CONSUMER_KEY": "",
        "DISCOGS_CONSUMER_SECRET": "",
        "SPOTIFY_CLIENT_ID": "",
        "SPOTIFY_CLIENT_SECRET": "",
        "LASTFM_API_KEY": LASTFM_FAKE_API_KEY,
        "LASTFM_API_SECRET": LASTFM_FAKE_API_SECRET,
        "LASTFM_API_ROOT": f"http://127.0.0.1:{provider_port}/lastfm",
        "LASTFM_SESSION": "",
        "LASTFM_SESSION_KEY": "",
        "LASTFM_USERNAME": "",
        # Provider payloads use a public-looking hostname so production candidate
        # sanitization is exercised. The fixture-owned proxy keeps those external
        # HTTP reads on loopback without adding an application test branch.
        "HTTP_PROXY": f"http://127.0.0.1:{provider_port}",
        "http_proxy": f"http://127.0.0.1:{provider_port}",
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
        "TMP": str(temp_dir),
        "TEMP": str(temp_dir),
        "TMPDIR": str(temp_dir),
        "ALBUM_HAVEN_SESSION_DIR": str(session_dir),
    }
    for seam_id in _REQUIRED_POSTGRES_SEAMS:
        environment[f"ALBUM_HAVEN_PERSISTENCE_{seam_id.upper()}"] = "postgres"
    os.environ.update(environment)
    tempfile.tempdir = None
    return library_root


def configure_preloaded_fixture() -> Path:
    fixture_profile = str(os.environ.get("ALBUM_HAVEN_FIXTURE_PROFILE") or "").strip()
    if fixture_profile not in PRELOADED_FIXTURE_PROFILES:
        raise RuntimeError(
            "ALBUM_HAVEN_FIXTURE_PROFILE must select an approved preloaded fixture."
        )
    fixture_root_value = str(os.environ.get("ALBUM_HAVEN_FIXTURE_ROOT") or "").strip()
    media_root_value = str(os.environ.get("ALBUM_HAVEN_MEDIA_ROOT") or "").strip()
    if not fixture_root_value or not media_root_value:
        raise RuntimeError("Preloaded fixture root and media root are required.")
    fixture_root = Path(fixture_root_value).expanduser().resolve(strict=True)
    media_root = Path(media_root_value).expanduser().resolve(strict=True)
    expected_media_root = fixture_root / "media"
    if (
        not fixture_root.is_dir()
        or not media_root.is_dir()
        or media_root != expected_media_root
    ):
        raise RuntimeError(
            "Preloaded fixture media must be the exact media directory under the fixture root."
        )
    os.environ["MUSIC_DIR"] = str(media_root)
    return media_root


def seed_functional_cover_search_cache(
    setup_database_url: str,
    cache_path: Path,
    *,
    connect=None,
    updated_at: float | None = None,
    preserve_provider_scenarios: bool = True,
) -> int:
    """Seed verified provider misses so each functional invocation starts independently."""
    if connect is None:
        try:
            import psycopg
        except ImportError as exc:  # pragma: no cover - exercised by the real launcher
            raise RuntimeError("psycopg is required for the functional cover-cache seed.") from exc
        connect = psycopg.connect

    with connect(setup_database_url) as connection:
        rows = connection.execute(
            """
            select distinct
              cover_queries.artist_name,
              cover_queries.album_title,
              cover_queries.release_year,
              cover_queries.edition
            from (
              select
                library.local_artists.name as artist_name,
                library.local_albums.title as album_title,
                library.local_albums.release_year,
                coalesce(library.local_albums.metadata ->> 'edition', '') as edition
              from app.bootstrap_owners
              join library.libraries
                on library.libraries.owner_account_id = app.bootstrap_owners.account_id
               and library.libraries.name = 'Local Library'
               and library.libraries.library_kind = 'local'
              join library.local_albums
                on library.local_albums.library_id = library.libraries.id
              join library.local_artists
                on library.local_artists.id = library.local_albums.artist_id
               and library.local_artists.library_id = library.libraries.id
              where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                and nullif(btrim(library.local_albums.cover_path), '') is null

              union

              select
                library.local_artists.name as artist_name,
                library.local_albums.title as album_title,
                btrim(library.local_track_files.metadata #>> '{scan_cache,file_entry,year}')::integer
                  as release_year,
                coalesce(library.local_albums.metadata ->> 'edition', '') as edition
              from app.bootstrap_owners
              join library.libraries
                on library.libraries.owner_account_id = app.bootstrap_owners.account_id
               and library.libraries.name = 'Local Library'
               and library.libraries.library_kind = 'local'
              join library.local_albums
                on library.local_albums.library_id = library.libraries.id
              join library.local_artists
                on library.local_artists.id = library.local_albums.artist_id
               and library.local_artists.library_id = library.libraries.id
              join library.local_tracks
                on library.local_tracks.album_id = library.local_albums.id
               and library.local_tracks.library_id = library.libraries.id
              join library.local_track_files
                on library.local_track_files.track_id = library.local_tracks.id
              where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                and nullif(btrim(library.local_albums.cover_path), '') is null
                and btrim(library.local_track_files.metadata #>> '{scan_cache,file_entry,year}')
                    ~ '^[0-9]{4}$'
            ) as cover_queries
            order by
              cover_queries.artist_name,
              cover_queries.album_title,
              cover_queries.release_year,
              cover_queries.edition
            """
        ).fetchall()

    normalized_rows = [
        (str(row[0]), str(row[1]), int(row[2]) if row[2] is not None else None, str(row[3] or ""))
        for row in rows
    ]
    provider_scenario_albums = {
        ("Mastodon", "Crack The Skye Fixture 07"),
        ("Mastodon", "Crack The Skye Fixture 08"),
    }
    cache_rows = [
        row
        for row in normalized_rows
        if not preserve_provider_scenarios
        or (row[0], row[1]) not in provider_scenario_albums
    ]
    if len(cache_rows) < 12:
        raise RuntimeError(
            "functional-core must expose at least 12 naturally coverless non-provider "
            f"albums before startup; received {len(cache_rows)}."
        )

    from music_app.services.cover_provider_cache import CoverSearchCache, cover_query_key

    cache = CoverSearchCache(cache_path)
    seed_time = time.time() if updated_at is None else float(updated_at)
    seeded_keys: set[str] = set()
    for artist, album, year, edition in cache_rows:
        cache_key = cover_query_key(artist, album, edition or None, year)
        if cache_key in seeded_keys:
            raise RuntimeError(f"functional cover-cache seed key is duplicated: {cache_key}")
        seeded_keys.add(cache_key)
        cache.set(cache_key, {"updated_at": seed_time, "missing": True})
    cache.save()
    return len(seeded_keys)


def build_preloaded_synthetic_provider_cover_specs(
    media_root: Path,
) -> list[dict[str, Any]]:
    fixture_root = media_root.resolve(strict=True).parent
    contract_path = fixture_root / "loopback" / "cover-responses.json"
    if not contract_path.is_file():
        fixture_profile = str(os.environ.get("ALBUM_HAVEN_FIXTURE_PROFILE") or "").strip()
        if fixture_profile == "functional-core":
            raise RuntimeError(
                "Functional-core provider startup requires its fixture-owned cover response contract."
            )
        cover_root = media_root / "covers" / "approved"
        cover_paths = sorted(
            path.resolve(strict=True)
            for path in cover_root.iterdir()
            if path.is_file() and path.suffix.casefold() in {".jpg", ".jpeg", ".png"}
        ) if cover_root.is_dir() else []
        if len(cover_paths) < 2:
            raise RuntimeError(
                "Preloaded provider startup requires at least two fixture-owned approved covers."
            )
        return [
            {
                "cover_id": f"synthetic-approved-{index + 1}",
                "artist": "Synthetic Fixture Provider",
                "album": f"Approved Cover {index + 1}",
                "year": 2026,
                "width": 1000,
                "height": 1000,
                "staged_path": str(cover_path),
                "other_art_staged_path": str(cover_paths[(index + 1) % len(cover_paths)]),
                "other_art_width": 1000,
                "other_art_height": 1000,
            }
            for index, cover_path in enumerate(cover_paths)
        ]
    try:
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "Preloaded provider startup requires its fixture-owned cover response contract."
        ) from exc
    if contract.get("schemaVersion") != 1 or not isinstance(contract.get("covers"), list):
        raise RuntimeError("Fixture-owned cover responses must use schema version 1.")

    def resolve_fixture_file(value: object) -> Path:
        portable = PurePosixPath(str(value or "").replace("\\", "/"))
        if portable.is_absolute() or ".." in portable.parts:
            raise RuntimeError("Fixture-owned cover responses contain an unsafe path.")
        resolved = fixture_root.joinpath(*portable.parts).resolve(strict=True)
        if fixture_root != resolved and fixture_root not in resolved.parents:
            raise RuntimeError("Fixture-owned cover responses escape the fixture root.")
        if not resolved.is_file():
            raise RuntimeError("Fixture-owned cover response art must be a regular file.")
        return resolved

    specs: list[dict[str, Any]] = []
    required_keys = {
        "cover_id",
        "artist",
        "album",
        "year",
        "width",
        "height",
        "staged_path",
        "other_art_staged_path",
        "other_art_width",
        "other_art_height",
    }
    for raw_spec in contract["covers"]:
        if not isinstance(raw_spec, dict) or not required_keys.issubset(raw_spec):
            raise RuntimeError("Fixture-owned cover response entry is incomplete.")
        spec = dict(raw_spec)
        spec["staged_path"] = str(resolve_fixture_file(spec["staged_path"]))
        spec["other_art_staged_path"] = str(
            resolve_fixture_file(spec["other_art_staged_path"])
        )
        if spec["staged_path"] == spec["other_art_staged_path"]:
            raise RuntimeError("Fixture-owned cover response requires distinct other art.")
        if spec.get("user_owned_cover_path"):
            spec["user_owned_cover_path"] = str(
                resolve_fixture_file(spec["user_owned_cover_path"])
            )
        specs.append(spec)
    if len(specs) < 2:
        raise RuntimeError(
            "Preloaded provider startup requires at least two fixture-owned cover responses."
        )
    return specs


def persist_fixture_inventory(
    setup_database_url: str,
    library_root: Path,
    file_cache: dict[str, dict[str, object]],
) -> None:
    from config import PERSISTENCE_BACKEND_POSTGRES
    from music_app.services.library_roots import (
        library_root_cache_identity,
        save_library_root_settings,
    )
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    setup_config: dict[str, object] = {
        "ALBUM_HAVEN_APP_DATABASE_URL": setup_database_url,
        "MUSIC_DIR": library_root.resolve(strict=False),
        "CACHE_PATH": library_root.parent / "app-data" / "inert-library-cache.json",
        "LIBRARY_ROOTS_PATH": library_root.parent / "app-data" / "inert-library-roots.json",
        "PERSISTENCE_BACKENDS": {
            "library_roots": PERSISTENCE_BACKEND_POSTGRES,
            "scan_cache": PERSISTENCE_BACKEND_POSTGRES,
        },
    }
    save_library_root_settings(
        setup_config,
        {
            "main_library_roots": [
                {
                    "id": "isolated-e2e-root",
                    "path": str(library_root.resolve(strict=False)),
                    "layout_mode": "artist",
                }
            ]
        },
    )
    root_identity = library_root_cache_identity(setup_config)
    PostgresScanCacheAdapter(setup_config).save_snapshot(
        Path(str(setup_config["CACHE_PATH"])),
        file_cache,
        root_identity,
        time.time(),
    )
    persist_ddt_studio_records_album_year_contract(setup_database_url)
    persist_sparse_album_display_year_contract(setup_database_url)
    persist_tag_split_legacy_album_key_contract(setup_database_url)
    persist_fixture_artist_family_compilation_contract(setup_database_url)
    persist_fixture_album_rating_contract(setup_database_url)
    persist_duplicate_artist_header_contract(setup_database_url)
    persist_legacy_ignored_album_contract(setup_database_url)


def ensure_provider_storage_policy_cover_spec(
    cover_specs: list[dict[str, object]],
) -> dict[str, object] | None:
    matching_specs = [
        spec
        for spec in cover_specs
        if spec.get("cover_id") == "provider-storage-policy-cover"
    ]
    if len(matching_specs) > 1:
        raise RuntimeError("The provider storage-policy fixture requires exactly one cover spec.")
    if matching_specs:
        return matching_specs[0]
    if not cover_specs:
        return None

    source_spec = dict(cover_specs[2] if len(cover_specs) > 2 else cover_specs[0])
    source_path = Path(str(source_spec["staged_path"]))
    provider_path = source_path.with_name("provider-storage-policy-cover.jpg")
    if not provider_path.is_file():
        from PIL import Image, ImageOps

        with Image.open(source_path) as source_image:
            ImageOps.fit(source_image.convert("RGB"), (900, 900)).save(
                provider_path,
                format="JPEG",
                quality=88,
                optimize=True,
            )
    source_spec.update(
        {
            "cover_id": provider_path.stem,
            "staged_path": str(provider_path),
            "width": 900,
            "height": 900,
            "candidate_fixture_mode": "provider-storage-policy",
        }
    )
    cover_specs.append(source_spec)
    return source_spec


def persist_provider_storage_policy_candidates(
    setup_database_url: str,
    provider_port: int,
    provider_spec: dict[str, object] | None,
) -> None:
    if provider_spec is None:
        raise RuntimeError("The provider storage-policy fixture requires a cover spec.")
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required to seed provider storage-policy candidates."
        ) from exc

    from music_app.services.cover_provider_candidates import (
        CoverCandidate,
        cover_candidate_to_lookup_match,
    )

    cover_id = str(provider_spec["cover_id"])
    image_url = (
        f"http://{_PUBLIC_COVER_FIXTURE_HOST}:{provider_port}"
        f"/apple/artwork/{cover_id}/100x100bb.jpg"
    )
    provider_contracts = (
        ("apple", "Apple Music", "https://music.apple.com/us/album/fixture/10"),
        ("deezer", "Deezer", "https://www.deezer.com/album/10"),
        ("youtube_music", "YouTube Music", "https://music.youtube.com/browse/fixture-10"),
        ("spotify", "Spotify", "https://open.spotify.com/album/fixture10"),
    )
    live_candidates = [
        cover_candidate_to_lookup_match(
            CoverCandidate(
                source=source,
                url=f"{image_url}?provider={source}",
                width=900,
                height=900,
                score=0.99 - (index * 0.01),
                matched_artist="Mastodon",
                matched_album="Crack The Skye Fixture 10",
                matched_year=2009,
                debug_payload={
                    "source_label": source_label,
                    "thumbnail_url": f"{image_url}?provider={source}",
                    "album_url": album_url,
                    "variant": "isolated-provider-storage-policy",
                },
            ),
            lookup_group="services",
        )
        for index, (source, source_label, album_url) in enumerate(provider_contracts)
    ]
    persisted_candidate_fields = {
        "id",
        "source",
        "source_label",
        "lookup_group",
        "url",
        "thumbnail_url",
        "album_url",
        "width",
        "height",
        "score",
        "artist",
        "album",
        "year",
        "art_kind",
        "art_label",
        "display_only",
    }
    candidates = [
        {key: value for key, value in candidate.items() if key in persisted_candidate_fields}
        for candidate in live_candidates
    ]

    with psycopg.connect(setup_database_url) as connection:
        result = connection.execute(
            """
            insert into library.local_album_cover_candidate_snapshots (
              album_id,
              search_generation,
              search_kind,
              status,
              revision,
              candidates,
              best_candidate_id,
              started_at,
              updated_at,
              finished_at
            )
            select
              library.local_albums.id,
              '00000000-0000-0000-0000-000000000010'::uuid,
              'manual',
              'completed',
              1,
              %s::jsonb,
              %s,
              now(),
              now(),
              now()
            from library.local_albums
            join library.local_artists
              on library.local_artists.id = library.local_albums.artist_id
            where library.local_artists.name = 'Mastodon'
              and library.local_albums.title = 'Crack The Skye Fixture 10'
              and library.local_albums.release_year = 2009
            on conflict (album_id) do update
            set candidates = excluded.candidates,
                best_candidate_id = excluded.best_candidate_id,
                revision = excluded.revision,
                status = excluded.status,
                updated_at = excluded.updated_at,
                finished_at = excluded.finished_at;
            """,
            (json.dumps(candidates), candidates[0]["id"]),
        )
        if result.rowcount != 1:
            raise RuntimeError(
                "The provider storage-policy fixture must resolve exactly one local album."
            )


def persist_legacy_ignored_album_contract(setup_database_url: str) -> None:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required to seed the legacy ignored-album fixture."
        ) from exc

    with psycopg.connect(setup_database_url) as connection:
        result = connection.execute(
            """
            with bootstrap_context as (
              select library.libraries.id as library_id
              from app.bootstrap_owners
              join library.libraries
                on library.libraries.owner_account_id = app.bootstrap_owners.account_id
               and library.libraries.name = 'Local Library'
               and library.libraries.library_kind = 'local'
              where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
              limit 1
            ), fixture_files as (
              select
                bootstrap_context.library_id,
                library.local_track_files.private_path || '::album' as repair_key
              from bootstrap_context
              join library.local_albums
                on library.local_albums.library_id = bootstrap_context.library_id
               and library.local_albums.title = %s
               and library.local_albums.release_year = %s
              join library.local_tracks
                on library.local_tracks.album_id = library.local_albums.id
               and library.local_tracks.library_id = bootstrap_context.library_id
              join library.local_track_files
                on library.local_track_files.track_id = library.local_tracks.id
               and coalesce(
                 (library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean,
                 false
               ) is false
            )
            insert into library.ignored_repairs (library_id, repair_key, metadata)
            select
              fixture_files.library_id,
              fixture_files.repair_key,
              '{"source":"isolated_e2e_legacy_album_ignore"}'::jsonb
            from fixture_files
            on conflict (library_id, repair_key) do nothing;
            """,
            (
                PROBLEMATIC_LEGACY_IGNORED_ALBUM,
                PROBLEMATIC_LEGACY_IGNORED_YEAR,
            ),
        )
        if result.rowcount != PROBLEMATIC_LEGACY_IGNORED_TRACK_COUNT:
            raise RuntimeError(
                "The legacy ignored-album fixture must seed one rule per track, "
                f"seeded {result.rowcount}."
            )

        partial_result = connection.execute(
            """
            with bootstrap_context as (
              select library.libraries.id as library_id
              from app.bootstrap_owners
              join library.libraries
                on library.libraries.owner_account_id = app.bootstrap_owners.account_id
               and library.libraries.name = 'Local Library'
               and library.libraries.library_kind = 'local'
              where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
              limit 1
            ), fixture_files as (
              select
                bootstrap_context.library_id,
                library.local_track_files.private_path || '::album' as repair_key
              from bootstrap_context
              join library.local_tracks
                on library.local_tracks.library_id = bootstrap_context.library_id
              join library.local_track_files
                on library.local_track_files.track_id = library.local_tracks.id
               and library.local_track_files.private_path like %s
               and coalesce(
                 (library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean,
                 false
               ) is false
              order by library.local_track_files.private_path
              limit %s
            )
            insert into library.ignored_repairs (library_id, repair_key, metadata)
            select
              fixture_files.library_id,
              fixture_files.repair_key,
              '{"source":"isolated_e2e_partial_legacy_album_ignore"}'::jsonb
            from fixture_files
            on conflict (library_id, repair_key) do nothing;
            """,
            (
                f"%{PROBLEMATIC_PARTIAL_LEGACY_IGNORED_ALBUM}%",
                PROBLEMATIC_PARTIAL_LEGACY_IGNORED_TRACK_COUNT,
            ),
        )
        if partial_result.rowcount != PROBLEMATIC_PARTIAL_LEGACY_IGNORED_TRACK_COUNT:
            raise RuntimeError(
                "The partial legacy ignored-album fixture must omit at least one track, "
                f"seeded {partial_result.rowcount}."
            )


def persist_ddt_studio_records_album_year_contract(
    setup_database_url: str,
) -> None:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required to seed the DDT Studio Records fixture."
        ) from exc

    with psycopg.connect(setup_database_url) as connection:
        result = connection.execute(
            """
            update library.local_albums
            set
              album_key = lower(%s::text) || '::' || lower(%s::text),
              release_year = %s,
              metadata = jsonb_set(
                library.local_albums.metadata,
                '{release_date}',
                to_jsonb(%s::text),
                true
              )
            where library.local_albums.title = %s;
            """,
            (
                DDT_STUDIO_RECORDS_PERSISTED_ALBUM_ARTIST,
                DDT_STUDIO_RECORDS_FIXTURE_ALBUM,
                DDT_STUDIO_RECORDS_FIXTURE_YEAR,
                f"{DDT_STUDIO_RECORDS_FIXTURE_YEAR}-01-01",
                DDT_STUDIO_RECORDS_FIXTURE_ALBUM,
            ),
        )
        if result.rowcount != 1:
            raise RuntimeError(
                "The DDT Studio Records fixture must update exactly one persisted "
                f"album year, updated {result.rowcount}."
            )


def persist_sparse_album_display_year_contract(setup_database_url: str) -> None:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required to seed the sparse album-edit fixture."
        ) from exc

    with psycopg.connect(setup_database_url) as connection:
        result = connection.execute(
            """
            update library.local_albums
            set
              release_year = %s,
              metadata = jsonb_set(
                library.local_albums.metadata,
                '{release_date}',
                to_jsonb(%s::text),
                true
              )
            where library.local_albums.title = %s;
            """,
            (
                TAG_SPARSE_ALBUM_FIXTURE_DISPLAY_YEAR,
                f"{TAG_SPARSE_ALBUM_FIXTURE_DISPLAY_YEAR}-01-01",
                TAG_SPARSE_ALBUM_FIXTURE_ALBUM,
            ),
        )
        if result.rowcount != 1:
            raise RuntimeError(
                "The sparse album-edit fixture must update exactly one album display year, "
                f"updated {result.rowcount}."
            )


def persist_tag_split_legacy_album_key_contract(setup_database_url: str) -> None:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required to seed the legacy album-key fixture."
        ) from exc

    with psycopg.connect(setup_database_url) as connection:
        result = connection.execute(
            """
            update library.local_albums
            set album_key = lower(%s::text) || '::' || lower(%s::text)
            where library.local_albums.title = %s
              and library.local_albums.release_year = %s;
            """,
            (
                TAG_RENAME_FIXTURE_ARTIST,
                TAG_SPLIT_FIXTURE_ALBUM,
                TAG_SPLIT_FIXTURE_ALBUM,
                TAG_RENAME_FIXTURE_YEAR,
            ),
        )
        if result.rowcount != 1:
            raise RuntimeError(
                "The selected-track split fixture must seed exactly one legacy "
                f"album key, updated {result.rowcount}."
            )


def persist_fixture_artist_family_compilation_contract(setup_database_url: str) -> None:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required to seed the compilation-family fixture."
        ) from exc

    fixture_state = (
        (COMPILATION_FAMILY_ALBUM, True),
        (CONTROL_FAMILY_ALBUM, False),
        (SOUNDTRACK_FAMILY_ALBUM, False),
    )
    with psycopg.connect(setup_database_url) as connection:
        for album_title, is_compilation in fixture_state:
            result = connection.execute(
                """
                update library.local_albums
                set metadata = jsonb_set(
                  library.local_albums.metadata,
                  '{is_compilation}',
                  to_jsonb(%s::boolean),
                  true
                )
                where library.local_albums.title = %s;
                """,
                (is_compilation, album_title),
            )
            if result.rowcount != 1:
                raise RuntimeError(
                    "The isolated E2E artist-family fixture must update exactly one "
                    f"{album_title!r} album, updated {result.rowcount}."
                )

        rows = connection.execute(
            """
            select
              library.local_albums.title,
              library.local_albums.metadata ->> 'album_artist' as album_artist,
              lower(btrim(coalesce(
                library.local_albums.metadata ->> 'is_compilation',
                'false'
              ))) in ('true', 't', 'yes', 'y', 'on', '1') as is_compilation,
              coalesce(array_agg(
                distinct library.local_artists.name
                order by library.local_artists.name
              ) filter (
                where library.local_album_featured_artists.featured_kind = 'owner'
              ), array[]::text[]) as owner_artists,
              coalesce(array_agg(
                distinct library.local_artists.name
                order by library.local_artists.name
              ) filter (
                where library.local_album_featured_artists.featured_kind <> 'owner'
              ), array[]::text[]) as member_artists
            from library.local_albums
            join library.local_album_featured_artists
              on library.local_album_featured_artists.library_id =
                   library.local_albums.library_id
             and library.local_album_featured_artists.album_id =
                   library.local_albums.id
            join library.local_artists
              on library.local_artists.id =
                   library.local_album_featured_artists.artist_id
            where library.local_albums.title in (%s, %s, %s)
            group by library.local_albums.id, library.local_albums.title
            order by library.local_albums.title;
            """,
            (COMPILATION_FAMILY_ALBUM, CONTROL_FAMILY_ALBUM, SOUNDTRACK_FAMILY_ALBUM),
        ).fetchall()

        actual_contract = {
            str(title): {
                "album_artist": str(album_artist or ""),
                "is_compilation": bool(is_compilation),
                "owner_artists": tuple(str(artist) for artist in owner_artists),
                "member_artists": tuple(str(artist) for artist in member_artists),
            }
            for (
                title,
                album_artist,
                is_compilation,
                owner_artists,
                member_artists,
            ) in rows
        }
        expected_contract = {
            COMPILATION_FAMILY_ALBUM: {
                "album_artist": " / ".join(COMPILATION_FAMILY_MEMBERS),
                "is_compilation": True,
                "owner_artists": (" / ".join(COMPILATION_FAMILY_MEMBERS),),
                "member_artists": tuple(sorted(COMPILATION_FAMILY_MEMBERS)),
            },
            CONTROL_FAMILY_ALBUM: {
                "album_artist": " / ".join(CONTROL_FAMILY_MEMBERS),
                "is_compilation": False,
                "owner_artists": (" / ".join(CONTROL_FAMILY_MEMBERS),),
                "member_artists": tuple(sorted(CONTROL_FAMILY_MEMBERS)),
            },
            SOUNDTRACK_FAMILY_ALBUM: {
                "album_artist": " / ".join(SOUNDTRACK_FAMILY_MEMBERS),
                "is_compilation": False,
                "owner_artists": (" / ".join(SOUNDTRACK_FAMILY_MEMBERS),),
                "member_artists": tuple(sorted(SOUNDTRACK_FAMILY_MEMBERS)),
            },
        }
        if actual_contract != expected_contract:
            raise RuntimeError(
                "The isolated E2E artist-family rows do not match the required normal "
                f"Postgres contract: {actual_contract!r}"
            )


def persist_duplicate_artist_header_contract(setup_database_url: str) -> None:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required to seed the duplicate artist-header fixture."
        ) from exc

    with psycopg.connect(setup_database_url) as connection:
        result = connection.execute(
            """
            with target_album as (
              select id, library_id
              from library.local_albums
              where title = %(album)s
                and release_year = %(year)s
              limit 1
            ),
            raw_artist as (
              insert into library.local_artists (
                library_id, artist_key, name, sort_name, metadata
              )
              select
                target_album.library_id,
                %(raw_artist_key)s,
                %(raw_artist)s,
                %(raw_artist_sort)s,
                '{"source":"isolated_legacy_collision_fixture"}'::jsonb
              from target_album
              on conflict (library_id, artist_key) do update
                set name = excluded.name,
                    sort_name = excluded.sort_name,
                    last_seen_at = now(),
                    metadata = library.local_artists.metadata || excluded.metadata
              returning id
            )
            update library.local_albums
            set artist_id = (select id from raw_artist),
                metadata = library.local_albums.metadata || jsonb_build_object(
                  'album_artist', %(raw_artist)s::text,
                  'artists', %(track_artists)s::jsonb
                )
            where library.local_albums.id = (select id from target_album);
            """,
            {
                "album": SNOW_WHITE_ALBUM,
                "year": SNOW_WHITE_YEAR,
                "raw_artist_key": SNOW_WHITE_RAW_ARTIST.casefold(),
                "raw_artist": SNOW_WHITE_RAW_ARTIST,
                "raw_artist_sort": SNOW_WHITE_RAW_ARTIST.casefold(),
                "track_artists": json.dumps(SNOW_WHITE_TRACK_ARTISTS),
            },
        )
        if result.rowcount != 1:
            raise RuntimeError(
                "The isolated E2E duplicate artist-header fixture must update exactly "
                f"one album, updated {result.rowcount}."
            )
        connection.execute(
            """
            insert into library.local_album_featured_artists (
              library_id, album_id, artist_id, featured_kind, metadata
            )
            select
              library.local_albums.library_id,
              library.local_albums.id,
              library.local_artists.id,
              'owner',
              '{"source":"isolated_legacy_collision_fixture"}'::jsonb
            from library.local_albums
            join library.local_artists
              on library.local_artists.library_id = library.local_albums.library_id
             and library.local_artists.artist_key = %(raw_artist_key)s
            where library.local_albums.title = %(album)s
              and library.local_albums.release_year = %(year)s
            on conflict (library_id, album_id, artist_id, featured_kind) do update
              set last_seen_at = now(),
                  metadata = library.local_album_featured_artists.metadata
                             || excluded.metadata;
            """,
            {
                "raw_artist_key": SNOW_WHITE_RAW_ARTIST.casefold(),
                "album": SNOW_WHITE_ALBUM,
                "year": SNOW_WHITE_YEAR,
            },
        )


def persist_fixture_album_rating_contract(setup_database_url: str) -> None:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("psycopg is required to seed isolated E2E album ratings.") from exc

    fixture_by_role = {
        role: {"album": album, "tag_rating": tag_rating}
        for role, album, tag_rating in RATING_FIXTURES
    }
    with psycopg.connect(setup_database_url) as connection:
        for role, fixture in fixture_by_role.items():
            album = str(fixture["album"])
            if role == "absent":
                connection.execute(
                    """
                    update library.local_albums
                    set metadata = library.local_albums.metadata - 'tag_album_rating' - 'tag_album_rating_source'
                    from library.local_artists
                    where library.local_artists.id = library.local_albums.artist_id
                      and library.local_artists.name = %s
                      and library.local_albums.title = %s;
                    """,
                    (RATING_FIXTURE_ARTIST, album),
                )
                continue
            connection.execute(
                """
                update library.local_albums
                set metadata = library.local_albums.metadata || jsonb_build_object(
                  'tag_album_rating', %s::jsonb,
                  'tag_album_rating_source', 'file_tag'
                )
                from library.local_artists
                where library.local_artists.id = library.local_albums.artist_id
                  and library.local_artists.name = %s
                  and library.local_albums.title = %s;
                """,
                (json.dumps(fixture["tag_rating"]), RATING_FIXTURE_ARTIST, album),
            )

        excluded_albums = [
            str(fixture_by_role[role]["album"])
            for role in ("numeric_authority", "cleared_authority", "import_candidate")
        ]
        connection.execute(
            """
            with bootstrap_context as (
              select
                app.bootstrap_owners.account_id,
                library.libraries.id as library_id
              from app.bootstrap_owners
              join library.libraries
                on library.libraries.owner_account_id = app.bootstrap_owners.account_id
               and library.libraries.name = 'Local Library'
               and library.libraries.library_kind = 'local'
              where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
              limit 1
            ), valid_tag_ratings as (
              select
                bootstrap_context.account_id,
                bootstrap_context.library_id,
                library.local_albums.album_key,
                (library.local_albums.metadata ->> 'tag_album_rating')::smallint as rating
              from bootstrap_context
              join library.local_albums
                on library.local_albums.library_id = bootstrap_context.library_id
              where library.local_albums.title <> all(%s::text[])
                and case
                  when jsonb_typeof(library.local_albums.metadata -> 'tag_album_rating') = 'number'
                    and (library.local_albums.metadata ->> 'tag_album_rating') ~ '^[0-9]+$'
                    then (library.local_albums.metadata ->> 'tag_album_rating')::numeric between 1 and 10
                  else false
                end
            )
            insert into app.album_ratings (
              account_id, library_id, album_key, rating, provenance, metadata
            )
            select
              account_id,
              library_id,
              album_key,
              rating,
              'e2e_fixture',
              jsonb_build_object('source', 'e2e_fixture')
            from valid_tag_ratings
            on conflict (account_id, library_id, album_key) do nothing;
            """,
            (excluded_albums,),
        )
        for role, rating in (("numeric_authority", 8), ("cleared_authority", None)):
            connection.execute(
                """
                with bootstrap_context as (
                  select
                    app.bootstrap_owners.account_id,
                    library.libraries.id as library_id
                  from app.bootstrap_owners
                  join library.libraries
                    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
                   and library.libraries.name = 'Local Library'
                   and library.libraries.library_kind = 'local'
                  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                  limit 1
                )
                insert into app.album_ratings (
                  account_id, library_id, album_key, rating, provenance, metadata
                )
                select
                  bootstrap_context.account_id,
                  bootstrap_context.library_id,
                  library.local_albums.album_key,
                  %s,
                  'e2e_fixture',
                  jsonb_build_object('source', 'e2e_fixture')
                from bootstrap_context
                join library.local_albums
                  on library.local_albums.library_id = bootstrap_context.library_id
                join library.local_artists
                  on library.local_artists.id = library.local_albums.artist_id
                where library.local_artists.name = %s
                  and library.local_albums.title = %s
                on conflict (account_id, library_id, album_key) do nothing;
                """,
                (rating, RATING_FIXTURE_ARTIST, fixture_by_role[role]["album"]),
            )


def materialize_rating_scan_discovery_track(
    library_root: Path,
    playable_loop_source: Path,
) -> Path:
    try:
        from mutagen.id3 import ID3, ID3NoHeaderError, TALB, TDRC, TIT2, TPE1, TPE2, TRCK, TXXX
    except ImportError as exc:
        raise RuntimeError("Mutagen is required to build the isolated rating scan fixture.") from exc

    album_dir = library_root / RATING_FIXTURE_ARTIST / RATING_SCAN_DISCOVERY_ALBUM
    album_dir.mkdir(parents=True, exist_ok=True)
    track_path = album_dir / f"01 - {RATING_SCAN_DISCOVERY_TRACK}.mp3"
    shutil.copyfile(playable_loop_source, track_path)
    try:
        tags = ID3(track_path)
    except ID3NoHeaderError:
        tags = ID3()
    for frame_id in ("TALB", "TDRC", "TIT2", "TPE1", "TPE2", "TRCK", "TXXX:Album Rating"):
        tags.delall(frame_id)
    tags.add(TALB(encoding=3, text=[RATING_SCAN_DISCOVERY_ALBUM]))
    tags.add(TDRC(encoding=3, text=[str(RATING_FIXTURE_YEAR)]))
    tags.add(TIT2(encoding=3, text=[RATING_SCAN_DISCOVERY_TRACK]))
    tags.add(TPE1(encoding=3, text=[RATING_FIXTURE_ARTIST]))
    tags.add(TPE2(encoding=3, text=[RATING_FIXTURE_ARTIST]))
    tags.add(TRCK(encoding=3, text=["1"]))
    tags.add(TXXX(encoding=3, desc="Album Rating", text=[str(RATING_SCAN_DISCOVERY_VALUE)]))
    tags.save(track_path)
    return track_path


def _normalize_provider_query(value: object) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or "")).casefold()
    return " ".join("".join(char if char.isalnum() else " " for char in normalized).split())


def _fixture_jpeg_derivative(
    source_path: Path,
    *,
    width: int,
    height: int,
    derivative_root: Path | None = None,
) -> tuple[Path, str]:
    source_sha256 = hashlib.sha256(source_path.read_bytes()).hexdigest()
    if derivative_root is None:
        derivative_path = source_path.with_name(
            f"{source_path.stem}-{source_sha256[:16]}-{width}x{height}.jpg"
        )
    else:
        derivative_root.mkdir(parents=True, exist_ok=True)
        derivative_path = derivative_root / f"{source_sha256[:16]}-{width}x{height}.jpg"
    if derivative_path.is_file():
        return derivative_path, source_sha256

    from PIL import Image

    try:
        with Image.open(source_path) as source_image:
            if source_image.size == (width, height):
                return source_path, source_sha256
            derivative_image = source_image.convert("RGB").resize(
                (width, height),
                Image.Resampling.LANCZOS,
            )
    except OSError:
        shutil.copyfile(source_path, derivative_path)
        return derivative_path, source_sha256
    try:
        derivative_image.save(derivative_path, format="JPEG", quality=95)
    finally:
        derivative_image.close()
    return derivative_path, source_sha256


def _prepare_provider_artwork_spec(
    spec: dict[str, Any],
    *,
    derivative_root: Path | None = None,
) -> dict[str, Any]:
    source_path = Path(str(spec.get("staged_path") or "")).resolve(strict=True)
    width = int(spec.get("width") or 0)
    height = int(spec.get("height") or 0)
    if width <= 0 or height <= 0:
        raise RuntimeError("Provider artwork fixtures require positive declared dimensions.")
    prepared_path, source_sha256 = _fixture_jpeg_derivative(
        source_path,
        width=width,
        height=height,
        derivative_root=derivative_root,
    )
    prepared = {**spec, "staged_path": str(prepared_path)}
    prepared.setdefault("original_source_sha256", source_sha256)
    return prepared


def _cover_matching_derivative(
    source_path: Path,
    *,
    derivative_root: Path | None = None,
) -> tuple[Path, str]:
    return _fixture_jpeg_derivative(
        source_path,
        width=4518,
        height=4518,
        derivative_root=derivative_root,
    )


def _cover_matching_provider_specs(
    cover_specs: list[dict[str, Any]],
    *,
    derivative_root: Path | None = None,
) -> list[dict[str, Any]]:
    if len(cover_specs) < 2:
        return []
    larger_source = cover_specs[0]
    smaller_source = cover_specs[1]
    derivative_path, original_source_sha256 = _cover_matching_derivative(
        Path(str(larger_source.get("staged_path") or "")),
        derivative_root=derivative_root,
    )
    accepted_source = {
        **smaller_source,
        "staged_path": str(derivative_path),
        "original_source_sha256": original_source_sha256,
    }

    def build_spec(
        source: dict[str, Any],
        *,
        cover_id: str,
        artist: str,
        album: str,
        width: int,
        height: int,
        fixture_role: str,
    ) -> dict[str, Any]:
        return {
            **source,
            "cover_id": cover_id,
            "artist": artist,
            "album": album,
            "year": COVER_MATCHING_YEAR,
            "width": width,
            "height": height,
            "fixture_role": fixture_role,
        }

    return [
        build_spec(
            accepted_source,
            cover_id="metallica-kill-em-all-base",
            artist=COVER_MATCHING_ARTIST,
            album='Kill "Em" All',
            width=1000,
            height=1000,
            fixture_role="base",
        ),
        build_spec(
            accepted_source,
            cover_id="metallica-kill-em-all-deluxe",
            artist=COVER_MATCHING_ARTIST,
            album="Kill 'Em All (Deluxe Edition)",
            width=1400,
            height=1400,
            fixture_role="deluxe",
        ),
        build_spec(
            larger_source,
            cover_id="metallica-kill-em-all-false-single",
            artist=COVER_MATCHING_ARTIST,
            album='Kill "Em" All (feat. Discrepancies) - Single',
            width=3600,
            height=3600,
            fixture_role="false-single-feature",
        ),
        build_spec(
            larger_source,
            cover_id="metallica-kill-em-all-false-tribute",
            artist="Metallica Tribute Band",
            album="Kill 'Em All",
            width=3400,
            height=3400,
            fixture_role="false-tribute-artist",
        ),
        build_spec(
            larger_source,
            cover_id="metallica-kill-em-all-false-remix",
            artist=COVER_MATCHING_ARTIST,
            album="Kill 'Em All - Remixed",
            width=3200,
            height=3200,
            fixture_role="false-remix",
        ),
        build_spec(
            larger_source,
            cover_id="metallica-kill-em-all-false-featuring",
            artist=COVER_MATCHING_ARTIST,
            album="Kill 'Em All (Featuring Discrepancies)",
            width=3300,
            height=3300,
            fixture_role="false-album-identity-featuring",
        ),
        build_spec(
            larger_source,
            cover_id="metallica-kill-em-all-false-other-band",
            artist="Megadeth",
            album="Kill 'Em All",
            width=3000,
            height=3000,
            fixture_role="false-other-band",
        ),
        build_spec(
            larger_source,
            cover_id="metallica-kill-em-all-false-featured-artist",
            artist="Metallica feat. Discrepancies",
            album="Kill 'Em All",
            width=4200,
            height=4200,
            fixture_role="false-artist-identity-featured",
        ),
        build_spec(
            larger_source,
            cover_id="metallica-kill-em-all-false-collaboration-artist",
            artist="Metallica & Discrepancies",
            album="Kill 'Em All",
            width=4100,
            height=4100,
            fixture_role="false-artist-identity-collaboration",
        ),
        build_spec(
            larger_source,
            cover_id="metallica-kill-em-all-false-orchestra",
            artist="Metallica Orchestra",
            album="Kill 'Em All",
            width=4000,
            height=4000,
            fixture_role="false-artist-identity-orchestra",
        ),
        build_spec(
            larger_source,
            cover_id="metallica-kill-em-all-false-experience",
            artist="Metallica Experience",
            album="Kill 'Em All",
            width=3900,
            height=3900,
            fixture_role="false-artist-identity-experience",
        ),
        build_spec(
            larger_source,
            cover_id="metallica-kill-em-all-false-project",
            artist="The Metallica Project",
            album="Kill 'Em All",
            width=3800,
            height=3800,
            fixture_role="false-artist-identity-project",
        ),
    ]


class _ProviderFixtureServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        port: int,
        cover_specs: list[dict[str, Any]],
        *,
        cover_cache_path: Path | None = None,
        derivative_root: Path | None = None,
        itunes_search_delay_seconds: float = 0,
    ) -> None:
        def prepare_provider_artwork_spec(spec: dict[str, Any]) -> dict[str, Any]:
            if derivative_root is None:
                return _prepare_provider_artwork_spec(spec)
            return _prepare_provider_artwork_spec(
                spec,
                derivative_root=derivative_root,
            )

        self.cover_lookup_matching_specs = [
            prepare_provider_artwork_spec(spec)
            if str(spec.get("fixture_role") or "") in {"base", "deluxe"}
            else spec
            for spec in _cover_matching_provider_specs(
                cover_specs,
                derivative_root=derivative_root,
            )
        ]
        self.cover_lookup_automatic_candidate_spec = prepare_provider_artwork_spec({
            **dict(cover_specs[0]),
            "cover_id": "automatic-candidate-primary",
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 08",
            "year": 2009,
            "width": 1800,
            "height": 1800,
            "candidate_fixture_mode": "automatic-candidate",
        })
        neutral_user_cover_source = cover_specs[1] if len(cover_specs) > 1 else cover_specs[0]
        neutral_user_cover_source_path = Path(
            str(
                neutral_user_cover_source.get("user_owned_cover_path")
                or neutral_user_cover_source.get("staged_path")
                or ""
            )
        )
        neutral_user_cover_path, neutral_user_cover_source_sha256 = (
            _fixture_jpeg_derivative(
                neutral_user_cover_source_path,
                width=600,
                height=600,
                derivative_root=derivative_root,
            )
        )
        self.cover_lookup_neutral_user_cover_spec = prepare_provider_artwork_spec({
            **dict(neutral_user_cover_source),
            "staged_path": str(neutral_user_cover_path),
            "original_source_sha256": neutral_user_cover_source_sha256,
            "cover_id": "automatic-coverless-neutral",
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 09",
            "year": 2009,
            "width": 600,
            "height": 600,
            "candidate_fixture_mode": "automatic-coverless-neutral",
        })
        self.cover_lookup_user_improvement_spec = prepare_provider_artwork_spec({
            **dict(cover_specs[0]),
            "cover_id": "user-owned-improvement-primary",
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 09",
            "year": 2009,
            "width": 4000,
            "height": 4000,
            "candidate_fixture_mode": "user-owned-improvement",
        })
        same_art_source = dict(cover_specs[1] if len(cover_specs) > 1 else cover_specs[0])
        self.cover_lookup_same_art_improvement_spec = prepare_provider_artwork_spec({
            **same_art_source,
            "cover_id": "user-owned-same-art-improvement",
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 09",
            "year": 2009,
            "width": 3000,
            "height": 3000,
            "fixture_role": "base",
            "candidate_fixture_mode": "same-art-improvement",
        })
        alternate_source = dict(cover_specs[3] if len(cover_specs) > 3 else cover_specs[-1])
        self.cover_lookup_alternate_improvement_spec = prepare_provider_artwork_spec({
            **alternate_source,
            "cover_id": "automatic-improvement-alternate",
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 09",
            "year": 2009,
            "width": 4000,
            "height": 4000,
            "fixture_role": "base",
            "candidate_fixture_mode": "alternate-improvement",
        })
        self.cover_lookup_artist_conjunction_spec = prepare_provider_artwork_spec({
            **dict(cover_specs[0]),
            "cover_id": "morse-cover-to-cover-conjunction",
            "artist": "Neal Morse The Resonance",
            "album": COVER_LOOKUP_CONJUNCTION_ALBUM,
            "year": COVER_LOOKUP_CONJUNCTION_YEAR,
            "width": 1800,
            "height": 1800,
            "candidate_fixture_mode": "artist-conjunction",
        })
        self.cover_specs = [
            *(dict(spec) for spec in cover_specs),
            *(dict(spec) for spec in self.cover_lookup_matching_specs),
            self.cover_lookup_automatic_candidate_spec,
            self.cover_lookup_neutral_user_cover_spec,
            self.cover_lookup_user_improvement_spec,
            self.cover_lookup_same_art_improvement_spec,
            self.cover_lookup_alternate_improvement_spec,
            self.cover_lookup_artist_conjunction_spec,
        ]
        self.itunes_search_delay_lock = threading.Lock()
        self.itunes_search_delay_seconds = 0.0
        self.set_itunes_search_delay(itunes_search_delay_seconds)
        self.cover_paths = {
            str(spec["cover_id"]): Path(str(spec["staged_path"]))
            for spec in self.cover_specs
        }
        self.other_art_paths = {
            str(spec["cover_id"]): Path(str(spec["other_art_staged_path"]))
            for spec in self.cover_specs
        }
        self.apple_artwork_payloads: dict[str, bytes] = {}
        self.apple_artwork_payloads_lock = threading.Lock()
        self.lastfm_requests: list[dict[str, Any]] = []
        self.lastfm_requests_lock = threading.Lock()
        self.cover_lookup_later_provider_gate = threading.Event()
        self.cover_lookup_later_provider_gate.set()
        self.cover_lookup_candidate_image_gate = threading.Event()
        self.cover_lookup_candidate_image_gate.set()
        self.cover_lookup_mode = "no-results"
        self.cover_lookup_mode_lock = threading.Lock()
        self.cover_cache_path = cover_cache_path
        self.cover_lookup_evidence_lock = threading.Lock()
        self.cover_lookup_evidence = {
            "apple_search_requests": 0,
            "apple_search_terms": [],
            "manual_page_requests": 0,
            "manual_image_requests": 0,
            "musicbrainz_started": 0,
            "musicbrainz_queries": [],
            "musicbrainz_completed": 0,
            "cover_art_archive_requests": 0,
            "cover_art_archive_release_ids": [],
            "discogs_search_requests": 0,
            "discogs_detail_requests": 0,
            "candidate_image_requests": 0,
        }
        self.discogs_release_specs = {
            str(900_000 + index): spec
            for index, spec in enumerate(self.cover_specs, start=1)
        }
        super().__init__(("127.0.0.1", port), _ProviderFixtureHandler)

    def apple_artwork_payload(self, cover_id: str) -> bytes | None:
        with self.apple_artwork_payloads_lock:
            cached_payload = self.apple_artwork_payloads.get(cover_id)
        if cached_payload is not None:
            return cached_payload
        spec = next(
            (item for item in self.cover_specs if str(item["cover_id"]) == cover_id),
            None,
        )
        cover_path = self.cover_paths.get(cover_id)
        if spec is None or cover_path is None or not cover_path.is_file():
            return None
        payload = cover_path.read_bytes()
        if str(spec.get("fixture_role") or "") not in {"base", "deluxe"}:
            return payload
        try:
            from io import BytesIO
            from PIL import Image

            width = int(spec.get("width") or 0)
            height = int(spec.get("height") or 0)
            if width <= 0 or height <= 0:
                return payload
            with Image.open(BytesIO(payload)) as source_image:
                if source_image.size == (width, height):
                    with self.apple_artwork_payloads_lock:
                        self.apple_artwork_payloads[cover_id] = payload
                    return payload
                resized_image = source_image.convert("RGB").resize(
                    (width, height),
                    Image.Resampling.LANCZOS,
                )
            try:
                output = BytesIO()
                resized_image.save(output, format="JPEG", quality=92)
                payload = output.getvalue()
            finally:
                resized_image.close()
        except (OSError, ValueError):
            return payload
        with self.apple_artwork_payloads_lock:
            self.apple_artwork_payloads[cover_id] = payload
        return payload

    def record_lastfm_request(self, request: dict[str, Any]) -> None:
        with self.lastfm_requests_lock:
            self.lastfm_requests.append(dict(request))

    def snapshot_lastfm_requests(self) -> list[dict[str, Any]]:
        with self.lastfm_requests_lock:
            return [dict(request) for request in self.lastfm_requests]

    def hold_cover_lookup_later_provider(self) -> None:
        self.reset_cover_lookup_evidence()
        self.cover_lookup_later_provider_gate.clear()

    def reset_cover_lookup_evidence(self) -> None:
        with self.cover_lookup_evidence_lock:
            self.cover_lookup_evidence = {
                "apple_search_requests": 0,
                "apple_search_terms": [],
                "manual_page_requests": 0,
                "manual_image_requests": 0,
                "musicbrainz_started": 0,
                "musicbrainz_queries": [],
                "musicbrainz_completed": 0,
                "cover_art_archive_requests": 0,
                "cover_art_archive_release_ids": [],
                "discogs_search_requests": 0,
                "discogs_detail_requests": 0,
                "candidate_image_requests": 0,
            }

    def release_cover_lookup_later_provider(self) -> None:
        self.cover_lookup_later_provider_gate.set()

    def hold_cover_lookup_candidate_images(self) -> None:
        with self.cover_lookup_evidence_lock:
            self.cover_lookup_evidence["candidate_image_requests"] = 0
        self.cover_lookup_candidate_image_gate.clear()

    def release_cover_lookup_candidate_images(self) -> None:
        self.cover_lookup_candidate_image_gate.set()

    def wait_for_cover_lookup_candidate_image(self) -> None:
        with self.cover_lookup_evidence_lock:
            self.cover_lookup_evidence["candidate_image_requests"] += 1
        self.cover_lookup_candidate_image_gate.wait()

    def wait_for_cover_lookup_later_provider(self, query: str) -> None:
        with self.cover_lookup_evidence_lock:
            self.cover_lookup_evidence["musicbrainz_started"] += 1
            self.cover_lookup_evidence["musicbrainz_queries"].append(str(query or ""))
        self.cover_lookup_later_provider_gate.wait()

    def set_cover_lookup_mode(self, mode: str) -> None:
        normalized_mode = str(mode or "").strip()
        if normalized_mode not in {
            "normal",
            "no-results",
            "failed",
            "metallica-mismatch",
            "service-deadline",
            "artist-conjunction",
            "automatic-coverless",
            "automatic-scan",
            "same-art-improvement",
            "alternate-improvement",
        }:
            raise ValueError(f"Unsupported cover lookup fixture mode: {normalized_mode}")
        with self.cover_lookup_mode_lock:
            self.cover_lookup_mode = normalized_mode
        if self.cover_cache_path is not None:
            self.cover_cache_path.unlink(missing_ok=True)

    def get_cover_lookup_mode(self) -> str:
        with self.cover_lookup_mode_lock:
            return self.cover_lookup_mode

    def set_itunes_search_delay(self, delay_seconds: object) -> None:
        if isinstance(delay_seconds, bool):
            raise ValueError("Apple search fixture delay must be a non-negative number.")
        try:
            normalized_delay = float(delay_seconds)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                "Apple search fixture delay must be a non-negative number."
            ) from exc
        if not math.isfinite(normalized_delay) or normalized_delay < 0:
            raise ValueError("Apple search fixture delay must be a non-negative number.")
        with self.itunes_search_delay_lock:
            self.itunes_search_delay_seconds = normalized_delay

    def get_itunes_search_delay(self) -> float:
        with self.itunes_search_delay_lock:
            return self.itunes_search_delay_seconds

    def record_cover_art_archive_request(self, release_id: str) -> None:
        with self.cover_lookup_evidence_lock:
            self.cover_lookup_evidence["cover_art_archive_requests"] += 1
            self.cover_lookup_evidence["cover_art_archive_release_ids"].append(
                str(release_id or "")
            )

    def record_cover_lookup_request(self, key: str, term: str | None = None) -> None:
        with self.cover_lookup_evidence_lock:
            self.cover_lookup_evidence[key] += 1
            if term is not None and key == "apple_search_requests":
                self.cover_lookup_evidence["apple_search_terms"].append(str(term))

    def record_musicbrainz_completed(self) -> None:
        with self.cover_lookup_evidence_lock:
            self.cover_lookup_evidence["musicbrainz_completed"] += 1

    def snapshot_cover_lookup_evidence(self) -> dict[str, Any]:
        with self.cover_lookup_evidence_lock:
            evidence = dict(self.cover_lookup_evidence)
        evidence["later_provider_released"] = self.cover_lookup_later_provider_gate.is_set()
        evidence["candidate_image_released"] = self.cover_lookup_candidate_image_gate.is_set()
        evidence["mode"] = self.get_cover_lookup_mode()
        evidence["itunes_search_delay_seconds"] = self.get_itunes_search_delay()
        evidence["fixture_candidate_roles"] = (
            [
                str(spec.get("fixture_role") or "")
                for spec in self.cover_lookup_matching_specs
            ]
            if evidence["mode"] == "metallica-mismatch"
            else []
        )
        evidence["fixture_candidate_artists"] = (
            [
                str(spec.get("artist") or "")
                for spec in self.cover_lookup_matching_specs
            ]
            if evidence["mode"] == "metallica-mismatch"
            else []
        )
        evidence["fixture_original_source_sha256"] = (
            str(self.cover_lookup_matching_specs[0].get("original_source_sha256") or "")
            if evidence["mode"] == "metallica-mismatch"
            and self.cover_lookup_matching_specs
            else ""
        )
        evidence["fixture_neutral_original_source_sha256"] = (
            str(
                self.cover_lookup_neutral_user_cover_spec.get(
                    "original_source_sha256"
                )
                or ""
            )
            if evidence["mode"] == "automatic-coverless"
            else ""
        )
        return evidence


class _ProviderFixtureHandler(BaseHTTPRequestHandler):
    server: _ProviderFixtureServer

    def do_HEAD(self) -> None:
        self._serve(include_body=False)

    def do_GET(self) -> None:
        self._serve(include_body=True)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") == "/cover-lookup-fixture/control":
            self._serve_cover_lookup_control()
            return
        if parsed.path.rstrip("/") != "/lastfm":
            self.send_error(404)
            return
        self._serve_lastfm_request()

    def _serve(self, *, include_body: bool) -> None:
        parsed = urlparse(self.path)
        parts = [part for part in parsed.path.split("/") if part]
        query = parse_qs(parsed.query)
        if parts == ["lastfm", "requests"]:
            self._send_json(
                {"requests": self.server.snapshot_lastfm_requests()},
                include_body=include_body,
            )
            return
        if parts == ["cover-lookup-fixture", "evidence"]:
            self._send_json(
                self.server.snapshot_cover_lookup_evidence(),
                include_body=include_body,
            )
            return
        if parts in (["duckduckgo-search"], ["bing-search"]):
            self._send_payload(
                b"<!doctype html><html><body></body></html>",
                "text/html; charset=utf-8",
                include_body=include_body,
            )
            return
        if parts[:2] == ["itunes", "search"]:
            self._serve_itunes_search(query, include_body=include_body)
            return
        if parts[:2] == ["itunes", "lookup"]:
            self._serve_itunes_lookup(query, include_body=include_body)
            return
        if len(parts) == 3 and parts[:2] == ["apple", "album"]:
            self._serve_apple_album_page(parts[2], include_body=include_body)
            return
        if len(parts) == 3 and parts[:2] == ["apple", "artist"]:
            self._serve_apple_artist_page(parts[2], include_body=include_body)
            return
        if len(parts) == 4 and parts[:2] == ["apple", "artwork"]:
            self._serve_apple_artwork(
                parts[2],
                provider=query.get("provider", [""])[0],
                include_body=include_body,
            )
            return
        if parts[:2] == ["musicbrainz", "release"]:
            self._serve_musicbrainz_releases(query, include_body=include_body)
            return
        if len(parts) == 3 and parts[:2] == ["coverartarchive", "release"]:
            self._serve_cover_art_archive(parts[2], include_body=include_body)
            return
        if len(parts) == 3 and parts[:2] == ["coverartarchive", "image"]:
            self._serve_cover_image(parts[2], include_body=include_body)
            return
        if parts[:3] == ["discogs", "database", "search"]:
            self._serve_discogs_search(query, include_body=include_body)
            return
        if len(parts) == 3 and parts[:2] == ["discogs", "releases"]:
            self._serve_discogs_release(parts[2], include_body=include_body)
            return
        if len(parts) == 2 and parts[0] == "manual":
            self.server.record_cover_lookup_request("manual_page_requests")
            self._serve_manual_page(parts[1], include_body=include_body)
            return
        if len(parts) == 3 and parts[0] == "manual" and parts[2] in {"cover.jpg", "other-art.jpg"}:
            self.server.record_cover_lookup_request("manual_image_requests")
            self._serve_manual_image(parts[1], parts[2], include_body=include_body)
            return
        if len(parts) != 2 or parts[0] != "covers":
            self.send_error(404)
            return
        cover_id = Path(parts[1]).stem
        cover_path = self.server.cover_paths.get(cover_id)
        if cover_path is None or not cover_path.is_file():
            self.send_error(404)
            return
        payload = cover_path.read_bytes()
        self._send_payload(payload, "image/jpeg", include_body=include_body)

    def _serve_cover_lookup_control(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self.send_error(400)
            return
        action = str(payload.get("action") or "") if isinstance(payload, dict) else ""
        if action == "hold-later-provider":
            self.server.hold_cover_lookup_later_provider()
        elif action == "release-later-provider":
            self.server.release_cover_lookup_later_provider()
        elif action == "hold-candidate-images":
            self.server.hold_cover_lookup_candidate_images()
        elif action == "release-candidate-images":
            self.server.release_cover_lookup_candidate_images()
        elif action == "reset-evidence":
            self.server.reset_cover_lookup_evidence()
        elif action == "set-itunes-search-delay":
            try:
                self.server.set_itunes_search_delay(payload.get("delay_seconds"))
            except ValueError:
                self.send_error(400)
                return
        elif action == "set-mode":
            try:
                self.server.set_cover_lookup_mode(str(payload.get("mode") or ""))
            except ValueError:
                self.send_error(400)
                return
        else:
            self.send_error(400)
            return
        self._send_json(
            self.server.snapshot_cover_lookup_evidence(),
            include_body=True,
        )

    def _serve_lastfm_request(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.send_error(400)
            return
        body = self.rfile.read(content_length)
        decoded = parse_qs(body.decode("utf-8"), keep_blank_values=True)
        params = {key: values[-1] for key, values in decoded.items() if values}
        supplied_signature = str(params.get("api_sig") or "")
        signature_params = {
            key: value
            for key, value in params.items()
            if key not in {"api_sig", "format"}
        }
        signature_base = "".join(
            f"{key}{value}" for key, value in sorted(signature_params.items())
        ) + LASTFM_FAKE_API_SECRET
        expected_signature = hashlib.md5(signature_base.encode("utf-8")).hexdigest()
        signature_valid = supplied_signature == expected_signature
        method = str(params.get("method") or "")
        request_record = {
            "method": method,
            "signature_valid": signature_valid,
            "api_key_valid": params.get("api_key") == LASTFM_FAKE_API_KEY,
            "artist": str(params.get("artist") or ""),
            "track": str(params.get("track") or ""),
            "album": str(params.get("album") or ""),
            "album_artist": str(params.get("albumArtist") or ""),
            "duration": str(params.get("duration") or ""),
            "track_number": str(params.get("trackNumber") or ""),
            "timestamp": str(params.get("timestamp") or ""),
            "chosen_by_user": str(params.get("chosenByUser") or ""),
            "session_key_valid": params.get("sk") == LASTFM_FAKE_SESSION_KEY,
        }
        self.server.record_lastfm_request(request_record)

        if not signature_valid or params.get("api_key") != LASTFM_FAKE_API_KEY:
            self._send_lastfm_xml(
                '<lfm status="failed"><error code="13">Invalid method signature supplied</error></lfm>',
                status=403,
            )
            return
        if method == "auth.getMobileSession":
            if (
                params.get("username") != LASTFM_FAKE_USERNAME
                or params.get("password") != LASTFM_FAKE_PASSWORD
            ):
                self._send_lastfm_xml(
                    '<lfm status="failed"><error code="4">Invalid username or password</error></lfm>',
                    status=403,
                )
                return
            self._send_lastfm_xml(
                '<lfm status="ok"><session>'
                f'<name>{LASTFM_FAKE_USERNAME}</name>'
                f'<key>{LASTFM_FAKE_SESSION_KEY}</key>'
                '<subscriber>0</subscriber>'
                '</session></lfm>'
            )
            return
        if params.get("sk") != LASTFM_FAKE_SESSION_KEY:
            self._send_lastfm_xml(
                '<lfm status="failed"><error code="9">Invalid session key</error></lfm>',
                status=403,
            )
            return
        if method == "track.updateNowPlaying":
            self._send_lastfm_xml('<lfm status="ok"><nowplaying /></lfm>')
            return
        if method == "track.scrobble":
            self._send_lastfm_xml(
                '<lfm status="ok"><scrobbles accepted="1" ignored="0">'
                '<scrobble><ignoredmessage code="0"></ignoredmessage></scrobble>'
                '</scrobbles></lfm>'
            )
            return
        self._send_lastfm_xml(
            '<lfm status="failed"><error code="3">Invalid Method</error></lfm>',
            status=400,
        )

    def _send_lastfm_xml(self, payload: str, *, status: int = 200) -> None:
        encoded = payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _matching_specs(self, query_text: object) -> list[dict[str, Any]]:
        mode = self.server.get_cover_lookup_mode()
        if mode == "no-results":
            return []
        if mode == "metallica-mismatch":
            return [dict(spec) for spec in self.server.cover_lookup_matching_specs]
        if mode == "artist-conjunction":
            return [dict(self.server.cover_lookup_artist_conjunction_spec)]
        normalized_query = _normalize_provider_query(query_text)
        if mode == "automatic-coverless":
            if _normalize_provider_query("Mastodon Crack The Skye Fixture 08") in normalized_query:
                return [dict(self.server.cover_lookup_automatic_candidate_spec)]
            if _normalize_provider_query("Mastodon Crack The Skye Fixture 09") in normalized_query:
                return [dict(self.server.cover_lookup_neutral_user_cover_spec)]
            return []
        if _normalize_provider_query("Mastodon Crack The Skye Fixture 08") in normalized_query:
            return [dict(self.server.cover_lookup_automatic_candidate_spec)]
        if _normalize_provider_query("Mastodon Crack The Skye Fixture 09") in normalized_query:
            if mode == "same-art-improvement":
                return [dict(self.server.cover_lookup_same_art_improvement_spec)]
            if mode == "alternate-improvement":
                return [dict(self.server.cover_lookup_alternate_improvement_spec)]
            return [dict(self.server.cover_lookup_user_improvement_spec)]
        if mode in {
            "automatic-scan",
            "same-art-improvement",
            "alternate-improvement",
        }:
            return []
        matches = [
            spec
            for spec in self.server.cover_specs
            if not str(spec.get("candidate_fixture_mode") or "")
            if _normalize_provider_query(spec.get("artist")) in normalized_query
            and _normalize_provider_query(spec.get("album")) in normalized_query
        ]
        return matches or self.server.cover_specs[:1]

    def _base_url(self) -> str:
        _host, port = self.server.server_address[:2]
        return f"http://{_PUBLIC_COVER_FIXTURE_HOST}:{port}"

    def _itunes_album(self, spec: dict[str, Any]) -> dict[str, Any]:
        cover_id = str(spec["cover_id"])
        year = int(spec.get("year") or 2000)
        return {
            "wrapperType": "collection",
            "collectionType": "Album",
            "artistId": abs(hash(str(spec.get("artist") or "fixture"))) % 1_000_000 + 1,
            "collectionId": abs(hash(cover_id)) % 1_000_000 + 1,
            "artistName": str(spec.get("artist") or "Fixture Artist"),
            "collectionName": str(spec.get("album") or "Fixture Album"),
            "collectionViewUrl": f"{self._base_url()}/apple/album/{cover_id}",
            "artistViewUrl": f"{self._base_url()}/apple/artist/{cover_id}",
            "artworkUrl100": f"{self._base_url()}/apple/artwork/{cover_id}/100x100bb.jpg",
            "releaseDate": f"{year}-01-01T00:00:00Z",
        }

    def _serve_itunes_search(self, query: dict[str, list[str]], *, include_body: bool) -> None:
        term = query.get("term", [""])[0]
        self.server.record_cover_lookup_request("apple_search_requests", term)
        if self.server.get_cover_lookup_mode() == "failed":
            self._send_json([], include_body=include_body)
            return
        specs = self._matching_specs(term)
        itunes_search_delay_seconds = self.server.get_itunes_search_delay()
        if itunes_search_delay_seconds > 0 and (
            specs or self.server.get_cover_lookup_mode() == "normal"
        ):
            time.sleep(itunes_search_delay_seconds)
        if query.get("entity", [""])[0] == "musicArtist":
            results = [
                {
                    "wrapperType": "artist",
                    "artistType": "Artist",
                    "artistId": self._itunes_album(spec)["artistId"],
                    "artistName": str(spec.get("artist") or "Fixture Artist"),
                    "artistLinkUrl": f"{self._base_url()}/apple/artist/{spec['cover_id']}",
                    "artistViewUrl": f"{self._base_url()}/apple/artist/{spec['cover_id']}",
                }
                for spec in specs
            ]
        else:
            results = [self._itunes_album(spec) for spec in specs]
        self._send_json({"resultCount": len(results), "results": results}, include_body=include_body)

    def _serve_itunes_lookup(self, query: dict[str, list[str]], *, include_body: bool) -> None:
        artist_id = query.get("id", [""])[0]
        results = [
            self._itunes_album(spec)
            for spec in self.server.cover_specs
            if str(self._itunes_album(spec)["artistId"]) == artist_id
        ]
        self._send_json({"resultCount": len(results), "results": results}, include_body=include_body)

    def _spec_by_cover_id(self, cover_id: str) -> dict[str, Any] | None:
        return next(
            (spec for spec in self.server.cover_specs if str(spec["cover_id"]) == cover_id),
            None,
        )

    def _serve_apple_album_page(self, cover_id: str, *, include_body: bool) -> None:
        spec = self._spec_by_cover_id(cover_id)
        if spec is None:
            self.send_error(404)
            return
        artist = escape(str(spec.get("artist") or "Fixture Artist"), quote=True)
        album = escape(str(spec.get("album") or "Fixture Album"), quote=True)
        year = int(spec.get("year") or 2000)
        artwork_url = f"{self._base_url()}/apple/artwork/{cover_id}/100x100bb.jpg"
        payload = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{album} by {artist} on Apple Music</title>
  <meta property="og:title" content="{album}">
  <meta property="og:description" content="{album} by {artist} on Apple Music. Released {year}.">
  <meta property="og:image" content="{artwork_url}">
</head>
<body>
  <main><article aria-label="{album} by {artist}">
    <picture slot="artwork"><img alt="{album} by {artist}" src="{artwork_url}"></picture>
  </article></main>
</body>
</html>""".encode("utf-8")
        self._send_payload(payload, "text/html; charset=utf-8", include_body=include_body)

    def _serve_apple_artist_page(self, cover_id: str, *, include_body: bool) -> None:
        spec = self._spec_by_cover_id(cover_id)
        if spec is None:
            self.send_error(404)
            return
        artist = escape(str(spec.get("artist") or "Fixture Artist"), quote=True)
        album = escape(str(spec.get("album") or "Fixture Album"), quote=True)
        album_url = f"{self._base_url()}/apple/album/{cover_id}"
        payload = f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>{artist} on Apple Music</title></head>
<body><main><section aria-label="Albums">
  <a href="{album_url}" aria-label="{album} by {artist}">{album}</a>
</section></main></body>
</html>""".encode("utf-8")
        self._send_payload(payload, "text/html; charset=utf-8", include_body=include_body)

    def _serve_apple_artwork(
        self,
        cover_id: str,
        *,
        provider: str,
        include_body: bool,
    ) -> None:
        if cover_id == "provider-storage-policy-cover" and provider == "apple":
            self.server.wait_for_cover_lookup_candidate_image()
        payload = self.server.apple_artwork_payload(cover_id)
        if payload is None:
            self.send_error(404)
            return
        self._send_payload(payload, "image/jpeg", include_body=include_body)

    def _serve_musicbrainz_releases(self, query: dict[str, list[str]], *, include_body: bool) -> None:
        query_text = query.get("query", [""])[0]
        self.server.wait_for_cover_lookup_later_provider(query_text)
        specs = self._matching_specs(query_text)
        releases = [
            {
                "id": str(spec["cover_id"]),
                "title": str(spec.get("album") or "Fixture Album"),
                "date": f"{int(spec.get('year') or 2000)}-01-01",
                "artist-credit": [{"name": str(spec.get("artist") or "Fixture Artist")}],
            }
            for spec in specs
        ]
        self._send_json({"count": len(releases), "releases": releases}, include_body=include_body)
        self.server.record_musicbrainz_completed()

    def _serve_cover_art_archive(self, release_id: str, *, include_body: bool) -> None:
        self.server.record_cover_art_archive_request(release_id)
        spec = next(
            (item for item in self.server.cover_specs if str(item["cover_id"]) == release_id),
            None,
        )
        if spec is None:
            self.send_error(404)
            return
        image_url = f"{self._base_url()}/coverartarchive/image/{release_id}.jpg"
        other_art_url = (
            f"{self._base_url()}/manual/{release_id}/other-art.jpg"
            "?source=cover_art_archive"
        )
        self._send_json(
            {
                "release": release_id,
                "images": [
                    {
                        "front": True,
                        "back": False,
                        "types": ["Front"],
                        "image": image_url,
                        "thumbnails": {"large": image_url, "small": image_url},
                        "width": (
                            "invalid-width"
                            if self.server.get_cover_lookup_mode() == "failed"
                            else int(spec.get("width") or 1000)
                        ),
                        "height": int(spec.get("height") or 1000),
                    },
                    {
                        "front": False,
                        "back": False,
                        "types": ["Booklet"],
                        "image": other_art_url,
                        "thumbnails": {"large": other_art_url, "small": other_art_url},
                        "width": int(spec.get("other_art_width") or 1000),
                        "height": int(spec.get("other_art_height") or 1500),
                    },
                ],
            },
            include_body=include_body,
        )

    def _serve_cover_image(self, filename: str, *, include_body: bool) -> None:
        cover_id = Path(filename).stem
        cover_path = self.server.cover_paths.get(cover_id)
        if cover_path is None or not cover_path.is_file():
            self.send_error(404)
            return
        self._send_payload(cover_path.read_bytes(), "image/jpeg", include_body=include_body)

    def _serve_discogs_search(
        self,
        query: dict[str, list[str]],
        *,
        include_body: bool,
    ) -> None:
        self.server.record_cover_lookup_request("discogs_search_requests")
        query_text = " ".join(
            str(value)
            for key in ("artist", "release_title", "q", "year")
            for value in query.get(key, [])
        )
        matching_specs = self._matching_specs(query_text)
        release_id_by_cover_id = {
            str(spec.get("cover_id") or ""): release_id
            for release_id, spec in self.server.discogs_release_specs.items()
        }
        results = []
        for spec in matching_specs[:4]:
            release_id = release_id_by_cover_id.get(str(spec.get("cover_id") or ""))
            if not release_id:
                continue
            artist = str(spec.get("artist") or "Fixture Artist")
            album = str(spec.get("album") or "Fixture Album")
            image_url = f"{self._base_url()}/covers/{spec['cover_id']}.jpg"
            results.append({
                "id": int(release_id),
                "type": "release",
                "title": f"{artist} - {album}",
                "artist": artist,
                "year": int(spec.get("year") or 2000),
                "resource_url": f"https://api.discogs.com/releases/{release_id}",
                "uri": f"https://www.discogs.com/release/{release_id}",
                "cover_image": image_url,
                "thumb": image_url,
                "format": ["Album"],
                "country": "US",
            })
        self._send_json({"pagination": {"items": len(results)}, "results": results}, include_body=include_body)

    def _serve_discogs_release(self, release_id: str, *, include_body: bool) -> None:
        self.server.record_cover_lookup_request("discogs_detail_requests")
        spec = self.server.discogs_release_specs.get(str(release_id or ""))
        if spec is None:
            self.send_error(404)
            return
        artist = str(spec.get("artist") or "Fixture Artist")
        album = str(spec.get("album") or "Fixture Album")
        image_url = f"{self._base_url()}/covers/{spec['cover_id']}.jpg"
        other_art_url = (
            f"{self._base_url()}/manual/{spec['cover_id']}/other-art.jpg?source=discogs"
        )
        self._send_json(
            {
                "id": int(release_id),
                "title": album,
                "artists_sort": artist,
                "year": int(spec.get("year") or 2000),
                "uri": f"https://www.discogs.com/release/{release_id}",
                "images": [
                    {
                        "type": "primary",
                        "uri": image_url,
                        "uri150": image_url,
                        "width": int(spec.get("width") or 1000),
                        "height": int(spec.get("height") or 1000),
                    },
                    {
                        "type": "secondary",
                        "uri": other_art_url,
                        "uri150": other_art_url,
                        "width": int(spec.get("other_art_width") or 1000),
                        "height": int(spec.get("other_art_height") or 1500),
                    },
                ],
            },
            include_body=include_body,
        )

    def _serve_manual_page(self, cover_id: str, *, include_body: bool) -> None:
        spec = self._spec_by_cover_id(cover_id)
        if spec is None:
            self.send_error(404)
            return
        if self.server.get_cover_lookup_mode() == "service-deadline":
            time.sleep(25.0)
        artist = escape(str(spec.get("artist") or "Fixture Artist"), quote=True)
        album = escape(str(spec.get("album") or "Fixture Album"), quote=True)
        year = int(spec.get("year") or 2000)
        cover_url = f"{self._base_url()}/manual/{cover_id}/cover.jpg"
        payload = f"""<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <title>{album} by {artist}</title>
  <meta property="og:title" content="{album}">
  <meta property="og:description" content="{album} by {artist}. Released {year}.">
  <meta property="og:image" content="{cover_url}">
</head><body><img src="{cover_url}" alt="{album} by {artist}"></body></html>""".encode("utf-8")
        self._send_payload(payload, "text/html; charset=utf-8", include_body=include_body)

    def _serve_manual_image(self, cover_id: str, image_name: str, *, include_body: bool) -> None:
        image_paths = (
            self.server.other_art_paths
            if image_name == "other-art.jpg"
            else self.server.cover_paths
        )
        image_path = image_paths.get(cover_id)
        if image_path is None or not image_path.is_file():
            self.send_error(404)
            return
        self._send_payload(image_path.read_bytes(), "image/jpeg", include_body=include_body)

    def _send_json(self, payload: dict[str, Any], *, include_body: bool) -> None:
        self._send_payload(
            json.dumps(payload, ensure_ascii=True).encode("utf-8"),
            "application/json",
            include_body=include_body,
        )

    def _send_payload(self, payload: bytes, content_type: str, *, include_body: bool) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if include_body:
            self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class ProviderFixtureService:
    def __init__(
        self,
        port: int,
        cover_specs: list[dict[str, Any]],
        *,
        cover_cache_path: Path | None = None,
        derivative_root: Path | None = None,
        itunes_search_delay_seconds: float = 0,
    ) -> None:
        self._server = _ProviderFixtureServer(
            port,
            cover_specs,
            cover_cache_path=cover_cache_path,
            derivative_root=derivative_root,
            itunes_search_delay_seconds=itunes_search_delay_seconds,
        )
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="album-haven-e2e-provider-fixture",
            daemon=True,
        )

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.release_cover_lookup_later_provider()
        self._server.release_cover_lookup_candidate_images()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def manual_urls(self, cover_id: str) -> dict[str, str]:
        host, port = self._server.server_address[:2]
        base_url = f"http://{host}:{port}"
        return {
            "page": f"{base_url}/manual/{cover_id}",
            "cover": f"{base_url}/manual/{cover_id}/cover.jpg",
            "other_art": f"{base_url}/manual/{cover_id}/other-art.jpg",
        }


def _runtime_config() -> dict[str, object]:
    from config import APP_NAME, APP_VERSION, Config

    config = {key: value for key, value in vars(Config).items() if key.isupper()}
    config["APP_NAME"] = APP_NAME
    config["APP_VERSION"] = APP_VERSION
    return config


def seed_fixture_lastfm_timezone() -> None:
    from music_app.services.lastfm import load_lastfm_settings, save_lastfm_settings

    config = _runtime_config()
    settings = dict(load_lastfm_settings(config))
    mode = str(os.environ.get("ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE") or "").strip()
    if mode == "blank":
        settings.pop("user_timezone", None)
    else:
        settings["user_timezone"] = "America/Denver"
    save_lastfm_settings(config, settings)


def assert_production_runtime_configuration(
    config: dict[str, object],
    temp_root: Path,
    *,
    fixture_media_root: Path | None = None,
) -> None:
    from music_app.services.persistence_selection import select_runtime_persistence_adapter

    for seam_id in _REQUIRED_POSTGRES_SEAMS:
        selection = select_runtime_persistence_adapter(seam_id, config)
        if selection.effective_backend != "postgres":
            raise RuntimeError(
                f"Isolated E2E requires Postgres {seam_id} persistence; got {selection!r}."
            )
    for key in ("MUSIC_DIR", "DATA_DIR", "CACHE_PATH", "COVER_CACHE_PATH", "LIBRARY_ROOTS_PATH"):
        resolved = Path(str(config.get(key) or "")).expanduser().resolve(strict=False)
        if key == "MUSIC_DIR" and fixture_media_root is not None:
            if resolved != fixture_media_root.resolve(strict=True):
                raise RuntimeError(
                    f"Production runtime music path did not match the validated fixture media root: {resolved}"
                )
            continue
        try:
            resolved.relative_to(temp_root)
        except ValueError as exc:
            raise RuntimeError(f"Production runtime path escaped isolated temp root: {key}={resolved}") from exc
    expected_provider_groups = {
        "music_services",
        "manual_urls",
        "discogs",
        "cover_art_archive",
    }
    if set(config.get("COVER_PROVIDER_GROUPS") or ()) != expected_provider_groups:
        raise RuntimeError(
            "Isolated E2E production cover provider groups must resolve to the fixture-backed groups."
        )
    if set(config.get("ENABLED_MUSIC_SERVICES") or ()) != {"apple"}:
        raise RuntimeError(
            "Isolated E2E production music services must resolve to the fixture-backed Apple provider."
        )
    lastfm_root = urlparse(str(config.get("LASTFM_API_ROOT") or ""))
    if (
        config.get("LASTFM_API_KEY") != LASTFM_FAKE_API_KEY
        or config.get("LASTFM_API_SECRET") != LASTFM_FAKE_API_SECRET
        or lastfm_root.scheme != "http"
        or lastfm_root.hostname != "127.0.0.1"
        or lastfm_root.port is None
        or lastfm_root.path.rstrip("/") != "/lastfm"
    ):
        raise RuntimeError(
            "Isolated E2E Last.fm must use only the fixture-owned loopback provider credentials."
        )


def install_shutdown_handlers() -> None:
    def handle_shutdown(_signum: int, _frame: Any) -> None:
        raise SystemExit(0)

    for signal_name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        signal_value = getattr(signal, signal_name, None)
        if signal_value is not None:
            signal.signal(signal_value, handle_shutdown)


def resolve_provider_port(cli_port: int | None, environment: dict[str, str] | None = None) -> int:
    if cli_port is not None:
        return int(cli_port)
    env = environment or os.environ
    base_url = str(env.get("PLAYWRIGHT_PROVIDER_BASE_URL") or "").strip()
    if base_url:
        parsed = urlparse(base_url)
        if parsed.port is not None:
            return parsed.port
    raw_port = str(env.get("PLAYWRIGHT_PROVIDER_PORT") or "").strip()
    if raw_port:
        return int(raw_port)
    raise RuntimeError("PLAYWRIGHT_PROVIDER_BASE_URL or PLAYWRIGHT_PROVIDER_PORT is required.")


def cleanup_isolated_database() -> None:
    setup_database_url, _runtime_database_url = resolve_isolated_database_urls()
    database_lock = IsolatedDatabaseOwnershipLock()
    database_lock.acquire()
    try:
        reset_application_tables(setup_database_url)
    finally:
        database_lock.release()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--provider-port", type=int)
    parser.add_argument("--cleanup-only", action="store_true")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--seed-all-functional-cover-misses", action="store_true")
    args = parser.parse_args()

    if args.cleanup_only:
        cleanup_isolated_database()
        return

    provider_port = resolve_provider_port(args.provider_port)

    setup_database_url, runtime_database_url = resolve_isolated_database_urls()
    configured_temp_root = str(os.environ.get("ALBUM_HAVEN_E2E_TEMP_ROOT") or "").strip()
    preserve_on_shutdown = (
        str(os.environ.get("ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN") or "").strip() == "1"
    )
    reuse_state = str(os.environ.get("ALBUM_HAVEN_E2E_REUSE_STATE") or "").strip() == "1"
    fixture_profile = str(
        os.environ.get("ALBUM_HAVEN_FIXTURE_PROFILE")
        or os.environ.get("ALBUM_HAVEN_E2E_FIXTURE_PROFILE")
        or ""
    ).strip()
    fixture_profile_mode = classify_fixture_profile_mode(fixture_profile)
    is_preloaded_fixture = fixture_profile_mode == "preloaded-release"
    temp_root = (
        Path(configured_temp_root).expanduser().resolve(strict=False)
        if configured_temp_root
        else Path(tempfile.mkdtemp(prefix=_TEMP_PREFIX))
    )
    temp_root.mkdir(parents=True, exist_ok=True)
    provider_service: ProviderFixtureService | None = None
    original_failure: BaseException | None = None
    cleanup_failure: Exception | None = None
    database_preparation_started = False
    database_lock = IsolatedDatabaseOwnershipLock()
    try:
        install_shutdown_handlers()
        library_root = configure_isolated_environment(
            temp_root,
            runtime_database_url,
            provider_port,
            use_seeded_cover_misses=args.seed_all_functional_cover_misses,
        )
        fixture_config = load_fixture_config()
        if is_preloaded_fixture:
            library_root = configure_preloaded_fixture()
            cover_specs = build_preloaded_synthetic_provider_cover_specs(library_root)
            artist_count = album_count = track_count = 0
        elif reuse_state:
            cover_specs = stage_real_cover_pool(
                fixture_config,
                library_root,
                reuse_existing=True,
            )
            restore_reused_fixture09_user_owned_cover(library_root, cover_specs)
            artist_count = int(fixture_config.get("artistCount") or 0)
            album_count = artist_count * int(fixture_config.get("albumsPerArtist") or 0)
            track_count = album_count * int(fixture_config.get("tracksPerAlbum") or 0)
        else:
            cover_specs = stage_real_cover_pool(fixture_config, library_root)
            file_cache, loop_source, artist_count, album_count = build_file_cache(
                fixture_config,
                library_root,
                cover_specs,
            )
            materialize_rarity_fixture_tracks(library_root, file_cache)
            materialize_playback_start_fixture_tracks(library_root, file_cache)
            gapless_fixture = generate_gapless_playback_fixture_audio(library_root)
            register_gapless_playback_fixture(file_cache, gapless_fixture)
            gapless_manifest_path = temp_root / "app-data" / "gapless-playback-fixture.json"
            gapless_manifest_path.parent.mkdir(parents=True, exist_ok=True)
            gapless_manifest_path.write_text(
                json.dumps(gapless_fixture, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            materialize_fixture_track_files(file_cache, loop_source)
            track_count = len(file_cache)
        database_lock.acquire()
        if fixture_profile == "functional-core":
            seed_functional_cover_search_cache(
                setup_database_url,
                Path(os.environ["MUSIC_COVER_CACHE_PATH"]),
                preserve_provider_scenarios=not args.seed_all_functional_cover_misses,
            )
        if not is_preloaded_fixture and not reuse_state:
            database_preparation_started = True
            prepare_isolated_database(setup_database_url, runtime_database_url)
            persist_fixture_inventory(setup_database_url, library_root, file_cache)
            provider_storage_policy_spec = ensure_provider_storage_policy_cover_spec(cover_specs)
            persist_provider_storage_policy_candidates(
                setup_database_url,
                provider_port,
                provider_storage_policy_spec,
            )
            materialize_rating_scan_discovery_track(library_root, loop_source)
            seed_fixture_lastfm_timezone()
        elif not is_preloaded_fixture:
            ensure_provider_storage_policy_cover_spec(cover_specs)

        if args.prepare_only:
            print(
                f"Prepared Album Haven generated fixture with {artist_count} artists, "
                f"{album_count} albums, and {track_count} tracks.",
                flush=True,
            )
            return

        provider_service = ProviderFixtureService(
            provider_port,
            cover_specs,
            cover_cache_path=Path(os.environ["MUSIC_COVER_CACHE_PATH"]),
            derivative_root=temp_root / "provider-artwork",
        )
        provider_service.start()

        from music_app import create_asgi_app

        fixture_media_root = library_root if is_preloaded_fixture else None
        assert_production_runtime_configuration(
            _runtime_config(), temp_root, fixture_media_root=fixture_media_root
        )
        app = create_asgi_app()
        assert_production_runtime_configuration(
            app.state.config, temp_root, fixture_media_root=fixture_media_root
        )
        print(
            f"Album Haven production E2E app listening on http://127.0.0.1:{args.port} "
            f"with {artist_count} artists, {album_count} albums, {track_count} tracks, "
            f"and provider fixtures on http://127.0.0.1:{provider_port}",
            flush=True,
        )
        import uvicorn

        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    except BaseException as exc:
        original_failure = exc
        raise
    finally:
        if provider_service is not None:
            try:
                provider_service.stop()
            except Exception as cleanup_exc:
                cleanup_failure = cleanup_exc
                if original_failure is not None:
                    print(f"Provider fixture cleanup failed: {cleanup_exc}", file=sys.stderr)
        if database_preparation_started and not preserve_on_shutdown:
            try:
                reset_application_tables(setup_database_url)
            except Exception as cleanup_exc:
                if cleanup_failure is None:
                    cleanup_failure = cleanup_exc
                if original_failure is not None:
                    print(f"Post-run isolated database cleanup failed: {cleanup_exc}", file=sys.stderr)
        if not preserve_on_shutdown:
            shutil.rmtree(temp_root, ignore_errors=True)
        try:
            database_lock.release()
        except Exception as cleanup_exc:
            if cleanup_failure is None:
                cleanup_failure = cleanup_exc
            if original_failure is not None:
                print(f"Isolated database lock cleanup failed: {cleanup_exc}", file=sys.stderr)
        if original_failure is None and cleanup_failure is not None:
            raise cleanup_failure


if __name__ == "__main__":
    main()
