"""Searching the name a release credits, on real isolated PostgreSQL (0275)."""
from __future__ import annotations

import json

from tests.e2e.support import isolatedPostgres
from tests.py.test_track_transliteration_postgres import JAPANESE, _search, _seed


def _credit(setup_url, albums, *names):
    """The album's tag and its matched release's credit: (credited name, main name) per artist."""
    credit = [{"name": name, "artist_mbid": None, "artist_name": main, "join_phrase": ""} for name, main in names]
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("insert into library.local_track_files (track_id, private_path, metadata)"
                           " select id, 'C:/Media/' || track_key || '.flac', '{}'::jsonb from library.local_tracks"
                           " where album_id = %s on conflict do nothing", (albums["byousoku"],))
        connection.execute("update integration.musicbrainz_releases set artist_credit = %s::jsonb where mbid = %s",
                           (json.dumps(credit), JAPANESE))


def test_an_album_is_found_by_the_name_its_release_credits(monkeypatch):
    setup_url, _repository, albums = _seed(monkeypatch)
    _credit(setup_url, albums, ("Quillmere Duo", "Brackenfold Choir"))

    assert _search(setup_url, "Quillmere Duo") == {"byousoku"}
    assert _search(setup_url, "quillmere") == {"byousoku"}
    assert _search(setup_url, "Quillmere Trio") == set()


def test_a_joint_credit_and_the_main_name_itself_add_no_match(monkeypatch):
    setup_url, _repository, albums = _seed(monkeypatch)
    for names in ((("Brackenfold Choir", "Brackenfold Choir"),), (("Quillmere Duo", "Brackenfold Choir"), ("Guest", "Guest"))):
        _credit(setup_url, albums, *names)
        assert _search(setup_url, "Quillmere Duo") == set()
        assert _search(setup_url, "Brackenfold Choir") == set()


def test_an_album_without_a_certain_release_is_not_found_by_that_releases_credit(monkeypatch):
    setup_url, _repository, albums = _seed(monkeypatch)
    _credit(setup_url, albums, ("Quillmere Duo", "Brackenfold Choir"))
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_album_musicbrainz_releases set state = 'release_group',"
                           " release_mbid = null, match_quality = null where album_key = 'byousoku'")

    assert _search(setup_url, "Quillmere Duo") == set()


def test_the_credited_name_search_can_use_its_index(monkeypatch):
    setup_url, _repository, _albums = _seed(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("set local enable_seqscan = off")
        plan = connection.execute(
            "explain select mbid from integration.musicbrainz_releases releases"
            " where lower(btrim(coalesce(releases.artist_credit -> 0 ->> 'name', ''))) like %s"
            " and jsonb_array_length(releases.artist_credit) = 1"
            " and releases.artist_credit -> 0 ->> 'name' is distinct from releases.artist_credit -> 0 ->> 'artist_name'",
            ("%quillmere%",)).fetchall()
    assert any("musicbrainz_releases_credited_name_trgm_idx" in str(next(iter(row.values()))) for row in plan)
