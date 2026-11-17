"""Latin track titles on real isolated PostgreSQL (MusicBrainz Delivery 2, S7), rule by rule.

Each test owns a freshly migrated isolated database (schemas dropped and re-applied).
"""
from __future__ import annotations

from datetime import timedelta

from music_app.services.musicbrainz_release_identity_postgres import MusicBrainzReleaseIdentityPostgresRepository
from music_app.services.track_transliteration import apply_track_transliterations
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_series_postgres import NOW, _database

GROUP = "00000000-0000-4000-8000-000000000252"
JAPANESE = "b242128c-42fb-418d-afee-9f3980740fd2"
LATIN = "678e22f8-c26f-4593-bb76-97971b593d40"
PSEUDO = "e196b170-d906-4f6c-9a8b-76baccde71dd"
MEDIA = [{"position": 1, "tracks": [{"position": 1, "title": "Oukashou"}, {"position": 2, "title": "Kiss"}]}]


def _seed(monkeypatch):
    """A Japanese album and a Latin one, each certainly matched with its track order exact."""
    setup_url, library_id = _database(monkeypatch)
    albums = {}
    with isolatedPostgres._connect(setup_url) as connection:
        artist = connection.execute(
            "insert into library.local_artists (library_id, artist_key, name, sort_name, metadata)"
            " values (%s, 'tenmon', '天門', '天門', '{}'::jsonb) returning id", (library_id,)).fetchone()["id"]
        connection.execute("insert into integration.musicbrainz_release_groups (mbid, title, refreshed_at)"
                           " values (%s, 'x', %s)", (GROUP, NOW))
        for key, release, titles in (("byousoku", JAPANESE, ("桜花抄", "Kiss")), ("latin", LATIN, ("Overture", "Кино"))):
            connection.execute("insert into integration.musicbrainz_releases (mbid, release_group_mbid, title,"
                               " refreshed_at) values (%s, %s, 'x', %s)", (release, GROUP, NOW))
            albums[key] = connection.execute(
                "insert into library.local_albums (library_id, artist_id, album_key, title, metadata)"
                " values (%s, %s, %s, %s, '{}'::jsonb) returning id", (library_id, artist, key, key)).fetchone()["id"]
            for number, title in enumerate(titles, 1):
                connection.execute(
                    "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, disc_number,"
                    " track_number, duration_seconds, metadata) values (%s, %s, %s, %s, %s, 1, %s, 200, '{}'::jsonb)",
                    (library_id, albums[key], artist, f"{key}-{number}", title, number))
            connection.execute(
                "insert into library.local_album_musicbrainz_releases (library_id, album_key, state,"
                " release_group_mbid, release_mbid, match_quality, decision_source, matcher_version, observed_at)"
                " values (%s, %s, 'release', %s, %s, 'order_exact', 'automatic', 4, %s)",
                (library_id, key, GROUP, release, NOW))
    repository = MusicBrainzReleaseIdentityPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    return setup_url, repository, albums


def test_only_a_release_with_a_title_beyond_latin_and_cyrillic_is_claimed_once_and_held(monkeypatch):
    _url, repository, _albums = _seed(monkeypatch)
    due = repository.claim_transliteration(now=NOW)
    assert due == {"release_mbid": JAPANESE, "titles": ["桜花抄", "Kiss"]}
    # Held: another lane finds nothing, and the Latin and Cyrillic album is never due.
    assert repository.claim_transliteration(now=NOW) is None


def test_a_stored_answer_is_reused_for_thirty_days_and_a_failure_rests_a_day(monkeypatch):
    _url, repository, _albums = _seed(monkeypatch)
    assert repository.claim_transliteration(now=NOW)["release_mbid"] == JAPANESE
    # Nothing stored (a failed ask): due again only after a day.
    assert repository.claim_transliteration(now=NOW + timedelta(hours=23)) is None
    assert repository.claim_transliteration(now=NOW + timedelta(hours=25))["release_mbid"] == JAPANESE
    repository.store_transliteration(release_mbid=JAPANESE, transliteration_mbid=PSEUDO, media=MEDIA,
                                     observed_at=NOW + timedelta(hours=25))
    assert repository.claim_transliteration(now=NOW + timedelta(days=30)) is None
    assert repository.claim_transliteration(now=NOW + timedelta(days=32))["release_mbid"] == JAPANESE


def test_album_details_show_the_stored_latin_title_on_the_paired_track_only(monkeypatch):
    setup_url, repository, albums = _seed(monkeypatch)
    repository.claim_transliteration(now=NOW)
    repository.store_transliteration(release_mbid=JAPANESE, transliteration_mbid=PSEUDO, media=MEDIA, observed_at=NOW)
    rows = [{"disc_number": 1, "track_number": 1, "title": "桜花抄"}, {"disc_number": 1, "track_number": 2, "title": "Kiss"}]
    with isolatedPostgres._connect(setup_url) as connection:
        album = apply_track_transliterations(connection, {"name": "秒速", "track_rows": rows},
                                             album_id=albums["byousoku"])
        stored = connection.execute("select transliteration_mbid::text, checked_at, failed_at"
                                    " from integration.musicbrainz_release_transliterations").fetchone()
    assert [row.get("title_transliteration") for row in album["track_rows"]] == ["Oukashou", None]
    assert (stored["transliteration_mbid"], stored["checked_at"] is not None, stored["failed_at"]) == (PSEUDO, True, None)


def test_a_release_musicbrainz_links_none_to_stores_none_and_shows_no_musicbrainz_form(monkeypatch):
    setup_url, repository, albums = _seed(monkeypatch)
    repository.claim_transliteration(now=NOW)
    repository.store_transliteration(release_mbid=JAPANESE, transliteration_mbid=None, media=MEDIA, observed_at=NOW)
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute("select media from integration.musicbrainz_release_transliterations"
                                  ).fetchone()["media"] == []
        from music_app.services.track_transliteration import stored_transliteration

        assert stored_transliteration(connection, albums["byousoku"]) is None
