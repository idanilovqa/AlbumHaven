"""MusicBrainz series on real isolated PostgreSQL (Delivery 2, S6), rule by rule.

Storage happens with the album-release decision; search, album details and the Series view
read it. Each test owns a freshly migrated isolated database (schemas dropped and re-applied).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from music_app.services.musicbrainz_release_identity import MusicBrainzAlbumReleaseProcessor
from music_app.services.musicbrainz_release_identity_postgres import MusicBrainzReleaseIdentityPostgresRepository
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_artist_migration_postgres import (
    _apply_pre_delivery_migrations,
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    apply_delivery_migrations,
)

NOW = datetime(2026, 11, 15, 12, 0, tzinfo=timezone.utc)
VIEW_STATE = {"visible_library_categories": ["main_library", "hoard", "new_arrivals"]}
COLOSSUS = "520f6fcd-251d-46cd-83a9-0bc725d42333"
COLEZO = "eaf64fe2-2c12-44a6-9210-4b717d107c6e"
METAL_LIST = "d5471f85-4b54-45da-9de7-c9ad9843c4bd"
ARTIST_MBID = "00000000-0000-4000-8000-000000000193"
# Release groups: the owner's Colossus Projects albums (numbers as MusicBrainz gives them).
ILIAD, KALEVALA, INFERNO, GIALLO = (
    "bbdbb3d2-bd99-4331-ba59-5c8f818c9222", "e0bfbd52-6a69-389a-8366-c2a857d418aa",
    "bd3a8207-3769-304a-bd9c-35f7b7551fa6", "0860c0d5-7fef-4a0b-aeb9-5a5d65da7189")
PLAIN, ROCK = "00000000-0000-4000-8000-0000000001a1", "00000000-0000-4000-8000-0000000001a2"
ILIAD_RELEASE, ROCK_RELEASE = "135d8915-379c-4b36-bb84-4f6a3171eb2c", "f343e454-cd2e-307e-b252-d7d375ff174f"


def _database(monkeypatch):
    setup_url, _runtime = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    _apply_pre_delivery_migrations(setup_url)
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        apply_delivery_migrations(connection)
        library_id = connection.execute(
            "select library.libraries.id from app.bootstrap_owners join library.libraries"
            " on library.libraries.owner_account_id = app.bootstrap_owners.account_id"
            " where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'").fetchone()["id"]
    return setup_url, library_id


def _album(connection, library_id, artists, key, title, year, artist):
    if artist not in artists:
        artists[artist] = connection.execute(
            "insert into library.local_artists (library_id, artist_key, name, sort_name, metadata)"
            " values (%s, %s, %s, %s, '{}'::jsonb) returning id",
            (library_id, f"series-{len(artists)}", artist, artist)).fetchone()["id"]
    album_id = connection.execute(
        "insert into library.local_albums (library_id, artist_id, album_key, title, release_year, metadata)"
        " values (%s, %s, %s, %s, %s, jsonb_build_object('album_artist', %s::text)) returning id",
        (library_id, artists[artist], key, title, year, artist)).fetchone()["id"]
    connection.execute(
        "insert into library.local_album_featured_artists (library_id, album_id, artist_id, featured_kind)"
        " values (%s, %s, %s, 'owner')", (library_id, album_id, artists[artist]))
    track_id = connection.execute(
        "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, disc_number,"
        " track_number, duration_seconds, metadata) values (%s, %s, %s, %s, 'Overture', 1, 1, 300, '{}'::jsonb)"
        " returning id", (library_id, album_id, artists[artist], f"{key}-1")).fetchone()["id"]
    connection.execute("insert into library.local_track_files (track_id, private_path) values (%s, %s)",
                       (track_id, f"C:\\Fixture\\{key}\\01.flac"))
    return album_id


def _seed_library(monkeypatch):
    """Albums of the Colossus Projects series by two album artists, out of title and date
    order, plus albums of no series."""
    setup_url, library_id = _database(monkeypatch)
    artists, albums = {}, {}
    with isolatedPostgres._connect(setup_url) as connection:
        for key, title, year, artist in (
                ("iliad", "Iliad, A Grand Piano Extravaganza", 2010, "Colossus Project"),
                ("kalevala", "Kalevala", 2003, "Various Artists"),
                ("inferno", "Dante's Inferno", 2008, "Various Artists"),
                ("giallo", "Giallo! One Suite for the Murderer", 2008, "Various Artists"),
                ("plain", "Elsewhere", 2008, "Other"),
                ("caligula", "Colossus", 2011, "Caligula's Horse"),
                ("unresolved", "Undecided", 2009, "Various Artists"),
                ("rock", "Best Selection", 2004, "Noriko Sakai")):
            albums[key] = _album(connection, library_id, artists, key, title, year, artist)
        groups = ((ILIAD, "Iliad, A Grand Piano Extravaganza", "2010"), (KALEVALA, "Kalevala", "2003-07-28"),
                  (INFERNO, "Dante's Inferno", "2008"), (GIALLO, "Giallo!", "2008-02-07"),
                  (PLAIN, "Elsewhere", "2008"), (ROCK, "Best Selection", "2004"))
        for mbid, title, date in groups:
            connection.execute("insert into integration.musicbrainz_release_groups (mbid, title, first_release_date,"
                               " refreshed_at) values (%s, %s, %s, %s)", (mbid, title, date, NOW))
        for mbid, group, date in ((ILIAD_RELEASE, ILIAD, "2010-05-01"), (ROCK_RELEASE, ROCK, "2004")):
            connection.execute("insert into integration.musicbrainz_releases (mbid, release_group_mbid, title,"
                               " release_date, refreshed_at) values (%s, %s, 'x', %s, %s)", (mbid, group, date, NOW))
        for key, state, group, release in (
                ("iliad", "release", ILIAD, ILIAD_RELEASE), ("kalevala", "release_group", KALEVALA, None),
                ("inferno", "release_group", INFERNO, None), ("giallo", "release_group", GIALLO, None),
                ("plain", "release_group", PLAIN, None), ("rock", "release", ROCK, ROCK_RELEASE)):
            connection.execute(
                "insert into library.local_album_musicbrainz_releases (library_id, album_key, state,"
                " release_group_mbid, release_mbid, decision_source, matcher_version, observed_at)"
                " values (%s, %s, %s, %s, %s, 'automatic', 2, %s)", (library_id, key, state, group, release, NOW))
        connection.execute(
            "insert into library.local_album_musicbrainz_releases (library_id, album_key, state, diagnostic,"
            " decision_source, matcher_version, observed_at) values (%s, 'unresolved', 'unresolved', 'title_only',"
            " 'automatic', 2, %s)", (library_id, NOW))
        connection.execute(
            "insert into integration.musicbrainz_series (mbid, name, series_type, refreshed_at) values"
            " (%s, 'Colossus Projects', 'Release group series', %s), (%s, 'COLEZO! TWIN', 'Release series', %s)",
            (COLOSSUS, NOW, COLEZO, NOW))
        for group, number, key in ((ILIAD, "18", 18), (KALEVALA, "2", 2), (INFERNO, "10", 10), (GIALLO, "9", 9)):
            connection.execute("insert into integration.musicbrainz_release_group_series (release_group_mbid,"
                               " series_mbid, ordering_number, ordering_key) values (%s, %s, %s, %s)",
                               (group, COLOSSUS, number, key))
        connection.execute("insert into integration.musicbrainz_release_series (release_mbid, series_mbid)"
                           " values (%s, %s)", (ROCK_RELEASE, COLEZO))
        # A list (Featured In): MusicBrainz names 100 albums in it.
        connection.execute("insert into integration.musicbrainz_series (mbid, name, series_type, member_count,"
                           " refreshed_at) values (%s, 'Rolling Stone: The 100 Greatest Metal Albums of All Time',"
                           " 'Release group series', 100, %s)", (METAL_LIST, NOW))
        for group in (ILIAD, KALEVALA):
            connection.execute("insert into integration.musicbrainz_release_group_series (release_group_mbid,"
                               " series_mbid) values (%s, %s)", (group, METAL_LIST))
    return setup_url, albums


def _browse(setup_url):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    return PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
                                           connect=lambda _url: isolatedPostgres._connect(setup_url))


# Storage ---------------------------------------------------------------------------------

def _record_outcome(group_series, release_series):
    def outcome(context):
        [album] = context["albums"]
        return {"classification": "complete", "albums": [{
            "local_album_id": album["id"], "local_title": album["title"], "state": "release",
            "release_group_mbid": ILIAD, "release_mbid": ILIAD_RELEASE, "disc_position": None,
            "signals": ["track_count", "track_list"], "diagnostic": None}],
            "release_groups": {ILIAD: {"id": ILIAD, "title": "Iliad", "series": group_series}},
            "releases": {ILIAD_RELEASE: {"id": ILIAD_RELEASE, "title": "Iliad", "release_group_id": ILIAD,
                                         "artist_credit": [], "media": [], "series": release_series}}}
    return outcome


class SizingClient:
    """Answers the series lookups that size each newly stored series."""

    sizes = {COLOSSUS: 22, COLEZO: 3}

    def lookup_series(self, mbid):
        return {"classification": "complete", "series": {"id": mbid, "member_count": self.sizes[mbid]}}


def test_series_are_stored_with_the_release_decision_and_a_new_lookup_replaces_them(monkeypatch):
    setup_url, library_id = _database(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        _album(connection, library_id, {}, "iliad", "Iliad", 2010, "Colossus Project")
        artist_id = connection.execute("select id from library.local_artists").fetchone()["id"]
        connection.execute("insert into integration.musicbrainz_artists (mbid, canonical_name, refreshed_at)"
                           " values (%s, 'Colossus Project', %s)", (ARTIST_MBID, NOW))
        connection.execute(
            "insert into library.local_artist_musicbrainz_matches (library_id, local_artist_id, artist_mbid, state,"
            " decision_source, confidence, evidence_summary, matcher_version, first_observed_at, last_observed_at,"
            " created_at, updated_at, selected_at, last_verified_at)"
            " values (%s, %s, %s, 'matched', 'automatic', 1, 'ok', 5, %s, %s, %s, %s, %s, %s)",
            (library_id, artist_id, ARTIST_MBID, NOW, NOW, NOW, NOW, NOW, NOW))
    repository = MusicBrainzReleaseIdentityPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    from music_app.services import musicbrainz_release_identity as module

    def run(group_series, release_series):
        monkeypatch.setattr(module, "resolve_album_releases",
                            lambda context, client: _record_outcome(group_series, release_series)(context))
        processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=SizingClient(), now=lambda: NOW)
        repository.enqueue(reason="test", observed_at=NOW, local_artist_id=artist_id, force=True)
        assert processor.process_next(worker_id="w")["state"] == "succeeded"
        with isolatedPostgres._connect(setup_url) as connection:
            return [dict(row) for row in connection.execute(
                "select series_name, series_type, ordering_number from library.local_album_musicbrainz_series"
                " order by series_name").fetchall()]

    colossus = {"mbid": COLOSSUS, "name": "Colossus Projects", "type": "Release group series", "number": "18",
                "ordering_key": 18}
    colezo = {"mbid": COLEZO, "name": "COLEZO! TWIN", "type": "Release series", "number": None, "ordering_key": None}
    assert run([colossus], [colezo]) == [
        {"series_name": "COLEZO! TWIN", "series_type": "Release series", "ordering_number": None},
        {"series_name": "Colossus Projects", "series_type": "Release group series", "ordering_number": "18"}]
    # Each new series is sized once, after the decision is stored.
    with isolatedPostgres._connect(setup_url) as connection:
        assert {row["name"]: row["member_count"] for row in connection.execute(
            "select name, member_count from integration.musicbrainz_series").fetchall()} == {
            "Colossus Projects": 22, "COLEZO! TWIN": 3}
    # A series named at both levels appears once, with the release group's number.
    assert run([colossus], [{**colossus, "number": "99"}]) == [
        {"series_name": "Colossus Projects", "series_type": "Release group series", "ordering_number": "18"}]
    # MusicBrainz's answer is the whole list: a series it no longer names is gone.
    assert run([], []) == []


def test_an_unresolved_album_belongs_to_no_series(monkeypatch):
    setup_url, _albums = _seed_library(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        keys = {row["album_key"] for row in connection.execute(
            "select album_key from library.local_album_musicbrainz_series").fetchall()}
    assert keys == {"iliad", "kalevala", "inferno", "giallo", "rock"}


# Search ----------------------------------------------------------------------------------

def test_search_by_a_series_name_finds_every_album_of_the_series_whatever_its_artist(monkeypatch):
    setup_url, _albums = _seed_library(monkeypatch)
    titles = {row["album_title"] for row in _browse(setup_url)._load_search_rows("colossus", VIEW_STATE)}
    # The series' four albums, plus "Colossus" itself by its title; nothing else.
    assert titles == {"Iliad, A Grand Piano Extravaganza", "Kalevala", "Dante's Inferno",
                      "Giallo! One Suite for the Murderer", "Colossus"}


def test_search_by_a_word_in_no_series_name_finds_no_series_album(monkeypatch):
    setup_url, _albums = _seed_library(monkeypatch)
    assert {row["album_title"] for row in _browse(setup_url)._load_search_rows("projectz", VIEW_STATE)} == set()
    assert {row["album_title"] for row in _browse(setup_url)._load_search_rows("colezo", VIEW_STATE)} == {
        "Best Selection"}


# Album details ---------------------------------------------------------------------------

def test_album_details_name_the_series_and_an_album_of_none_names_nothing(monkeypatch):
    from music_app.services.library_browse_postgres import _album_musicbrainz_series

    setup_url, albums = _seed_library(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        assert _album_musicbrainz_series(connection, albums["iliad"]) == [{
            "mbid": COLOSSUS, "name": "Colossus Projects", "type": "Release group series", "kind": "series",
            "type_label": "Album series", "number": "18",
            "musicbrainz_url": f"https://musicbrainz.org/series/{COLOSSUS}"}, {
            "mbid": METAL_LIST, "name": "Rolling Stone: The 100 Greatest Metal Albums of All Time",
            "type": "Release group series", "kind": "featured_in", "type_label": "Featured In", "number": None,
            "musicbrainz_url": f"https://musicbrainz.org/series/{METAL_LIST}"}]
        assert _album_musicbrainz_series(connection, albums["plain"]) == []
        assert _album_musicbrainz_series(connection, albums["unresolved"]) == []


# Series view -----------------------------------------------------------------------------

def test_a_series_view_lists_its_albums_chronologically_with_the_number_breaking_ties(monkeypatch):
    setup_url, _albums = _seed_library(monkeypatch)
    payload = _browse(setup_url).build_series_payload(query_params={"series": COLOSSUS})
    assert payload["selected_series"] == COLOSSUS
    assert payload["series"] == {"mbid": COLOSSUS, "name": "Colossus Projects", "type": "Release group series",
                                 "kind": "series", "type_label": "Album series", "album_count": 4,
                                 "musicbrainz_url": f"https://musicbrainz.org/series/{COLOSSUS}"}
    [group] = payload["artist_groups"]
    assert group["artist"] == "Colossus Projects"
    # 2003, then 2008 twice (number 9 before 10), then 2010; album artists stay their own.
    assert [(album["name"], album["album_artist"]) for album in group["albums"]] == [
        ("Kalevala", "Various Artists"), ("Giallo! One Suite for the Murderer", "Various Artists"),
        ("Dante's Inferno", "Various Artists"), ("Iliad, A Grand Piano Extravaganza", "Colossus Project")]
    assert payload["album_count"] == 4
    assert payload["series_sidebar"] == [
        {"mbid": COLEZO, "name": "COLEZO! TWIN", "count": 1},
        {"mbid": COLOSSUS, "name": "Colossus Projects", "count": 4},
        {"mbid": METAL_LIST, "name": "Rolling Stone: The 100 Greatest Metal Albums of All Time", "count": 2}]


def test_all_series_shows_every_series_and_an_unknown_series_shows_nothing(monkeypatch):
    setup_url, _albums = _seed_library(monkeypatch)
    browse = _browse(setup_url)
    payload = browse.build_series_payload(query_params={"series": "all"})
    assert (payload["selected_series"], payload["series"]) == ("all", None)
    assert [(group["artist"], len(group["albums"])) for group in payload["artist_groups"]] == [
        ("COLEZO! TWIN", 1), ("Colossus Projects", 4),
        ("Rolling Stone: The 100 Greatest Metal Albums of All Time", 2)]
    assert payload["artist_groups"][1]["series"]["type_label"] == "Album series"
    missing = browse.build_series_payload(query_params={"series": "00000000-0000-4000-8000-000000000000"})
    assert (missing["series"], missing["artist_groups"], missing["album_count"]) == (None, [], 0)


# Series or Featured In (owner 2026-11-15) ------------------------------------------------

def _kinds(setup_url, rows):
    with isolatedPostgres._connect(setup_url) as connection:
        for index, (name, series_type, count) in enumerate(rows):
            connection.execute("insert into integration.musicbrainz_series (mbid, name, series_type, member_count,"
                               " refreshed_at) values (%s, %s, %s, %s, %s)",
                               (f"00000000-0000-4000-8000-{index:012d}", name, series_type, count, NOW))
        return {row["name"]: row["computed_kind"] for row in connection.execute(
            "select name, computed_kind from integration.musicbrainz_series").fetchall()}


def test_an_award_ceremony_event_or_tour_type_is_featured_in_and_a_series_type_is_not(monkeypatch):
    setup_url, _library = _database(monkeypatch)
    assert _kinds(setup_url, [("Grammy Award: Album of the Year nominees", "Release group award", 3),
                              ("Eurovision 2010", "Award ceremony", 3), ("Live at Wacken", "Event series", 3),
                              ("World Tour 1998", "Tour", 3), ("Colossus Projects", "Release group series", 22)]) == {
        "Grammy Award: Album of the Year nominees": "featured_in", "Eurovision 2010": "featured_in",
        "Live at Wacken": "featured_in", "World Tour 1998": "featured_in", "Colossus Projects": "series"}


def test_fifty_albums_on_musicbrainz_is_featured_in_and_forty_nine_is_a_series(monkeypatch):
    setup_url, _library = _database(monkeypatch)
    assert _kinds(setup_url, [("Die 50 besten Alben des Jahres 2025", "Release group series", 50),
                              ("Prog Collection", "Release group series", 49),
                              ("Not yet sized", "Release group series", None)]) == {
        "Die 50 besten Alben des Jahres 2025": "featured_in", "Prog Collection": "series",
        "Not yet sized": "series"}


def test_a_list_like_name_is_featured_in_and_a_plain_name_is_not(monkeypatch):
    setup_url, _library = _database(monkeypatch)
    names = ["1001 Albums You Must Hear Before You Die", "The Greatest Prog", "Best New Album", "Top 40 hits",
             "Essential Jazz", "Juno Award winners", "Rock and Roll Hall of Fame"]
    kinds = _kinds(setup_url, [(name, "Release group series", 5) for name in names]
                   + [("The Bestiary Saga", "Release group series", 5), ("Topographic Oceans", "Release series", 5)])
    assert {name: kinds[name] for name in names} == dict.fromkeys(names, "featured_in")
    assert (kinds["The Bestiary Saga"], kinds["Topographic Oceans"]) == ("series", "series")


def test_chart_and_list_names_are_featured_in_and_band_or_word_lookalikes_are_not(monkeypatch):
    setup_url, _library = _database(monkeypatch)
    lists = ["Billboard 200: 2022-02-12", "UK Albums Chart", "The Wire: 2005 Rewind", "Year-End Albums 2019",
             "Album of the Year", "Readers' Poll 2010", "Village Voice Critics", "Justin Stranzl: Best of 1999"]
    series = ["Best of Bowie", "Chartreuse Sessions", "The Rewinder Tapes", "King Crimson Collectors' Club"]
    kinds = _kinds(setup_url, [(name, "Release group series", 5) for name in lists + series])
    assert {name: kinds[name] for name in lists} == dict.fromkeys(lists, "featured_in")
    assert {name: kinds[name] for name in series} == dict.fromkeys(series, "series")


def test_the_owners_kind_always_wins_and_a_hidden_series_shows_nowhere(monkeypatch):
    from music_app.services.library_browse_postgres import _album_musicbrainz_series

    setup_url, albums = _seed_library(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update integration.musicbrainz_series set owner_kind = 'series' where mbid = %s",
                           (METAL_LIST,))
        connection.execute("update integration.musicbrainz_series set owner_kind = 'hidden' where mbid = %s",
                           (COLOSSUS,))
        assert [item["kind"] for item in _album_musicbrainz_series(connection, albums["iliad"])] == ["series"]
    browse = _browse(setup_url)
    assert [item["name"] for item in browse.build_series_payload(query_params={"series": "all"})["series_sidebar"]] == [
        "COLEZO! TWIN", "Rolling Stone: The 100 Greatest Metal Albums of All Time"]
    assert browse.build_series_payload(query_params={"series": COLOSSUS})["artist_groups"] == []
    assert "Dante's Inferno" not in {row["album_title"] for row in browse._load_search_rows("colossus", VIEW_STATE)}


def test_featured_in_is_in_the_series_tree_and_opens_its_gallery_but_a_hidden_series_is_not(monkeypatch):
    setup_url, _albums = _seed_library(monkeypatch)
    browse = _browse(setup_url)
    featured = browse.build_series_payload(query_params={"series": METAL_LIST})
    assert (featured["series"]["kind"], featured["series"]["type_label"]) == ("featured_in", "Featured In")
    assert [album["name"] for album in featured["artist_groups"][0]["albums"]] == [
        "Kalevala", "Iliad, A Grand Piano Extravaganza"]
    # Owner 2026-11-15 (3A): the Series tree lists Featured In too, selectable (provisional
    # single list until mockup batch 2).
    every = browse.build_series_payload(query_params={"series": "all"})
    assert {"mbid": METAL_LIST, "name": "Rolling Stone: The 100 Greatest Metal Albums of All Time",
            "count": 2} in every["series_sidebar"]
    # An owner's "hidden" keeps a series out of the tree and its gallery.
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update integration.musicbrainz_series set owner_kind = 'hidden' where mbid = %s",
                           (METAL_LIST,))
    hidden = browse.build_series_payload(query_params={"series": "all"})
    assert METAL_LIST not in {item["mbid"] for item in hidden["series_sidebar"]}
    assert browse.build_series_payload(query_params={"series": METAL_LIST})["artist_groups"] == []
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update integration.musicbrainz_series set owner_kind = null where mbid = %s",
                           (METAL_LIST,))
    # Search matches both kinds by name.
    assert {row["album_title"] for row in browse._load_search_rows("metal albums", VIEW_STATE)} == {
        "Kalevala", "Iliad, A Grand Piano Extravaganza"}


# Series size: counted once per 30 days, only when type and name leave it undecided ----------

def _sizing_repository(setup_url):
    return MusicBrainzReleaseIdentityPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))


def test_only_undecided_series_are_counted_and_a_count_is_reused_for_thirty_days(monkeypatch):
    setup_url, _library = _database(monkeypatch)
    _kinds(setup_url, [("Colossus Projects", "Release group series", None),
                       ("Grammy Award: Album of the Year nominees", "Release group award", None),
                       ("1001 Albums You Must Hear Before You Die", "Release group series", None),
                       ("Apple Digital Masters", "Release series", None)])
    repository = _sizing_repository(setup_url)
    real, _award, _list, apple = (f"00000000-0000-4000-8000-{index:012d}" for index in range(4))
    # The award and the list are Featured In by type and name: never counted.
    assert set(repository.unsized_series(limit=10, now=NOW)) == {real, apple}

    repository.store_series_size(mbid=real, member_count=22, observed_at=NOW)
    repository.store_series_size(mbid=apple, member_count=50, observed_at=NOW)
    # Counted: not again for 30 days; the list counted to the cutoff is Featured In for good.
    assert repository.unsized_series(limit=10, now=NOW + timedelta(days=29)) == []
    assert repository.unsized_series(limit=10, now=NOW + timedelta(days=31)) == [real]
    with isolatedPostgres._connect(setup_url) as connection:
        kinds = {row["mbid"]: (row["member_count"], row["computed_kind"]) for row in connection.execute(
            "select mbid::text, member_count, computed_kind from integration.musicbrainz_series").fetchall()}
    assert (kinds[real], kinds[apple]) == ((22, "series"), (50, "featured_in"))

    repository.store_series_size(mbid=real, member_count=23, observed_at=NOW + timedelta(days=31))
    assert repository.unsized_series(limit=10, now=NOW + timedelta(days=32)) == []


def test_a_failed_count_rests_a_day_and_an_owners_kind_is_never_counted(monkeypatch):
    setup_url, _library = _database(monkeypatch)
    _kinds(setup_url, [("Colossus Projects", "Release group series", None),
                       ("Halo", "Release group series", None)])
    repository = _sizing_repository(setup_url)
    real, halo = (f"00000000-0000-4000-8000-{index:012d}" for index in range(2))
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update integration.musicbrainz_series set owner_kind = 'series' where mbid = %s", (halo,))
    assert repository.unsized_series(limit=10, now=NOW) == [real]
    repository.store_series_size(mbid=real, member_count=None, observed_at=NOW)
    assert repository.unsized_series(limit=10, now=NOW + timedelta(hours=23)) == []
    assert repository.unsized_series(limit=10, now=NOW + timedelta(hours=25)) == [real]


def test_one_job_counts_each_new_series_once_however_many_albums_share_it(monkeypatch):
    setup_url, _library = _database(monkeypatch)
    _kinds(setup_url, [("Colossus Projects", "Release group series", None)])
    asked = []

    class Client:
        def lookup_series(self, mbid):
            asked.append(mbid)
            return {"classification": "complete", "series": {"id": mbid, "member_count": 22}}

    processor = MusicBrainzAlbumReleaseProcessor(repository=_sizing_repository(setup_url), client=Client(),
                                                 now=lambda: NOW)
    for _job in range(5):
        processor._size_new_series(NOW)
    assert asked == ["00000000-0000-4000-8000-000000000000"]
