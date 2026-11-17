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
    repository.store_transliteration(release_mbid=JAPANESE, transliteration_mbid=PSEUDO, media=MEDIA, language="jpn",
                                     observed_at=NOW + timedelta(hours=25))
    assert repository.claim_transliteration(now=NOW + timedelta(days=30)) is None
    assert repository.claim_transliteration(now=NOW + timedelta(days=32))["release_mbid"] == JAPANESE


def test_album_details_show_the_stored_latin_title_on_the_paired_track_only(monkeypatch):
    setup_url, repository, albums = _seed(monkeypatch)
    repository.claim_transliteration(now=NOW)
    repository.store_transliteration(release_mbid=JAPANESE, transliteration_mbid=PSEUDO, media=MEDIA, language="jpn",
                                     observed_at=NOW)
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
    repository.store_transliteration(release_mbid=JAPANESE, transliteration_mbid=None, media=MEDIA, language="jpn",
                                     observed_at=NOW)
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute("select media from integration.musicbrainz_release_transliterations"
                                  ).fetchone()["media"] == []
        from music_app.services.track_transliteration import stored_transliteration

        # No MusicBrainz form to pair, but the release's language decides the fallback.
        stored = stored_transliteration(connection, albums["byousoku"])
        assert (stored["media"], stored["language"]) == ([], "jpn")


# Owner 2026-11-17: "Use MB language" and "exact pronunciation, but plain queries find them" -------

def test_a_release_answered_before_its_language_was_stored_is_asked_once_more(monkeypatch):
    setup_url, repository, _albums = _seed(monkeypatch)
    repository.claim_transliteration(now=NOW)
    repository.store_transliteration(release_mbid=JAPANESE, transliteration_mbid=None, media=[], language="",
                                     observed_at=NOW)
    assert repository.claim_transliteration(now=NOW + timedelta(days=2)) is None, "'' is an answer: no language"
    with isolatedPostgres._connect(setup_url) as connection:  # A row stored before 0255.
        connection.execute("update integration.musicbrainz_release_transliterations set language = null")
    assert repository.claim_transliteration(now=NOW + timedelta(days=2))["release_mbid"] == JAPANESE


def _pinyin_only(monkeypatch):
    """pypinyin answering as 0.55.0 does; no cutlet, so nothing is read as Japanese."""
    import sys
    import types

    from music_app.services import track_transliteration

    readings = {"天门": ["tiān", "mén"], "天門": ["tiān", "mén"]}
    monkeypatch.setitem(sys.modules, "cutlet", None)
    monkeypatch.setitem(sys.modules, "pypinyin", types.SimpleNamespace(
        Style=types.SimpleNamespace(TONE="tone"), lazy_pinyin=lambda text, style: readings.get(text, list(text))))
    track_transliteration._cutlet.cache_clear()


def _chinese_album(setup_url, title="天门"):
    """An album with no MusicBrainz release, one Chinese track and its file on disk."""
    with isolatedPostgres._connect(setup_url) as connection:
        library_id, artist = (connection.execute("select library_id, id from library.local_artists limit 1")
                              .fetchone().values())
        album = connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title, metadata)"
            " values (%s, %s, 'cn-gate', 'Gate Album', '{}'::jsonb) returning id", (library_id, artist)).fetchone()["id"]
        track = connection.execute(
            "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, disc_number,"
            " track_number, duration_seconds, metadata) values (%s, %s, %s, 'cn-gate-1', %s, 1, 1, 200, '{}'::jsonb)"
            " returning id", (library_id, album, artist, title)).fetchone()["id"]
        connection.execute("insert into library.local_track_files (track_id, private_path, metadata)"
                           " values (%s, 'C:/Music/cn-gate-1.flac', '{}'::jsonb)", (track,))
    return track


def _search(setup_url, query):
    from music_app.services.library_browse_postgres import _search_preview_sql
    from music_app.services.track_transliteration import latin_search_key

    key = latin_search_key(query)
    params = {"query_like": f"%{query}%", "query_latin_like": f"%{key}%" if key else None, "category_count": 0,
              "visible_categories": [], "include_missing": True, "search_artist_keys": []}
    with isolatedPostgres._connect(setup_url) as connection:
        return {row["album_key"] for row in connection.execute(_search_preview_sql(), params).fetchall()}


def _latin_rows(setup_url):
    with isolatedPostgres._connect(setup_url) as connection:
        return [(row["source_title"], row["latin"], row["search_key"]) for row in connection.execute(
            "select source_title, latin, search_key from library.local_track_latin_titles order by track_id")]


def test_plain_folded_and_spaceless_queries_find_a_tone_marked_track(monkeypatch):
    setup_url, repository, _albums = _seed(monkeypatch)
    _pinyin_only(monkeypatch)
    _chinese_album(setup_url)
    changed = []
    from music_app.services import musicbrainz_corrections_postgres

    monkeypatch.setitem(musicbrainz_corrections_postgres._ON_CHANGE, setup_url, changed.append)
    assert repository.refresh_latin_titles() >= 1
    assert ("天门", "Tiān mén", "tianmen") in _latin_rows(setup_url)
    assert any("cn-gate" in keys for keys in changed), "the album's cached searches are dropped"
    for query in ("tian men", "tianmen", "Tian Men", "Tiān mén", "TIANMEN"):
        assert "cn-gate" in _search(setup_url, query), query
    # Negative: another pronunciation, and a query with nothing Latin to fold, find nothing by it.
    assert "cn-gate" not in _search(setup_url, "tian ma")
    assert "cn-gate" not in _search(setup_url, "사랑")


def test_a_changed_title_is_redone_and_a_title_turned_latin_drops_its_row(monkeypatch):
    setup_url, repository, _albums = _seed(monkeypatch)
    _pinyin_only(monkeypatch)
    track = _chinese_album(setup_url)
    repository.refresh_latin_titles()
    assert repository.refresh_latin_titles() == 0, "nothing is due twice"
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_tracks set title = '天門' where id = %s", (track,))
    assert repository.refresh_latin_titles() == 1
    assert ("天門", "Tiān mén", "tianmen") in _latin_rows(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_tracks set title = 'Heaven Gate' where id = %s", (track,))
    assert repository.refresh_latin_titles() == 1
    assert all(row[0] != "Heaven Gate" for row in _latin_rows(setup_url)), "a Latin title needs no row"
    assert "cn-gate" not in _search(setup_url, "tianmen")


def test_a_title_with_no_known_latin_form_keeps_a_null_row_and_is_not_redone(monkeypatch):
    setup_url, repository, _albums = _seed(monkeypatch)
    _pinyin_only(monkeypatch)
    _chinese_album(setup_url, title="사랑")  # Korean: only MusicBrainz could give its Latin form.
    repository.refresh_latin_titles()
    assert ("사랑", None, None) in _latin_rows(setup_url)
    assert repository.refresh_latin_titles() == 0


# Latin album titles (0256, approved b3-1d3): stored like the tracks', searchable, on the cards --

def _both_fallbacks(monkeypatch):
    """cutlet and pypinyin answering as 0.5.2 and 0.55.0 do for these titles."""
    import sys
    import types

    from music_app.services import track_transliteration

    romaji = {"天門": "Tenmon", "センチメートル": "Senchimeetoru"}
    readings = {"天门": ["tiān", "mén"], "天門": ["tiān", "mén"]}
    monkeypatch.setitem(sys.modules, "cutlet", types.SimpleNamespace(
        Cutlet=lambda: types.SimpleNamespace(romaji=lambda text: romaji.get(text, ""))))
    monkeypatch.setitem(sys.modules, "pypinyin", types.SimpleNamespace(
        Style=types.SimpleNamespace(TONE="tone"), lazy_pinyin=lambda text, style: readings.get(text, list(text))))
    track_transliteration._cutlet.cache_clear()


def _album_latin_rows(setup_url):
    with isolatedPostgres._connect(setup_url) as connection:
        return [(row["source_title"], row["latin"], row["search_key"]) for row in connection.execute(
            "select source_title, latin, search_key from library.local_album_latin_titles order by album_id")]


def _retitle(setup_url, album_id, title):
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_albums set title = %s where id = %s", (title, album_id))


def _chinese_titled_album(setup_url, title="天门"):
    """An album with no MusicBrainz release, a Chinese title, one Latin track and its file."""
    _chinese_album(setup_url, title="Gate")
    with isolatedPostgres._connect(setup_url) as connection:
        return connection.execute("update library.local_albums set title = %s where album_key = 'cn-gate'"
                                  " returning id", (title,)).fetchone()["id"]


def test_plain_queries_find_an_album_by_its_tone_marked_latin_title(monkeypatch):
    setup_url, repository, _albums = _seed(monkeypatch)
    _pinyin_only(monkeypatch)
    _chinese_titled_album(setup_url)
    changed = []
    from music_app.services import musicbrainz_corrections_postgres

    monkeypatch.setitem(musicbrainz_corrections_postgres._ON_CHANGE, setup_url, changed.append)
    assert repository.refresh_latin_titles() >= 1
    assert ("天门", "Tiān mén", "tianmen") in _album_latin_rows(setup_url)
    assert any("cn-gate" in keys for keys in changed), "the album's cached searches are dropped"
    for query in ("tian men", "tianmen", "Tian Men", "Tiān mén"):
        assert "cn-gate" in _search(setup_url, query), query
    assert "cn-gate" not in _search(setup_url, "tian ma")
    assert "cn-gate" not in _search(setup_url, "사랑")


def test_a_changed_album_title_is_redone_and_one_turned_latin_drops_its_row(monkeypatch):
    setup_url, repository, _albums = _seed(monkeypatch)
    _pinyin_only(monkeypatch)
    album = _chinese_titled_album(setup_url)
    repository.refresh_latin_titles()
    assert repository.refresh_latin_titles() == 0, "nothing is due twice"
    _retitle(setup_url, album, "天門")
    assert repository.refresh_latin_titles() == 1
    assert _album_latin_rows(setup_url) == [("天門", "Tiān mén", "tianmen")]
    _retitle(setup_url, album, "Heaven Gate")
    assert repository.refresh_latin_titles() == 1
    assert _album_latin_rows(setup_url) == [], "a Latin title needs no row"
    assert "cn-gate" not in _search(setup_url, "tianmen")


def test_an_album_title_with_no_known_latin_form_keeps_a_null_row_and_is_not_redone(monkeypatch):
    setup_url, repository, _albums = _seed(monkeypatch)
    _pinyin_only(monkeypatch)
    _chinese_titled_album(setup_url, title="사랑")
    repository.refresh_latin_titles()
    assert _album_latin_rows(setup_url) == [("사랑", None, None)]
    assert repository.refresh_latin_titles() == 0


def _plan_nodes(node):
    yield node
    for child in node.get("Plans") or []:
        yield from _plan_nodes(child)


def test_an_idle_pass_reads_only_the_indexed_titles_never_the_whole_library(monkeypatch):
    """Orchestrator 2026-11-17 (the 6.5 freeze-guard pattern): with nothing due, the due checks
    read only the partial indexes over titles beyond Latin and Cyrillic and the stored rows,
    with default planner settings, on tables large enough for a scan to be the costlier path."""
    from music_app.services.track_transliteration import _DUE_LATIN_ALBUM_TITLES_SQL, _DUE_LATIN_ALBUMS_SQL

    setup_url, repository, albums = _seed(monkeypatch)
    _pinyin_only(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        library_id, artist = connection.execute(
            "select library_id, artist_id from library.local_albums where id = %s", (albums["latin"],)).fetchone().values()
        connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title, metadata)"
            " select %s, %s, 'bulk-' || n, 'Bulk Album ' || n, '{}'::jsonb from generate_series(1, 2000) n",
            (library_id, artist))
        connection.execute(
            "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, disc_number,"
            " track_number, duration_seconds, metadata)"
            " select %s, albums.id, %s, albums.album_key || '-' || n, 'Plain Song ' || n, 1, n, 200, '{}'::jsonb"
            " from library.local_albums albums cross join generate_series(1, 10) n"
            " where albums.album_key like 'bulk-%%'", (library_id, artist))
    assert repository.refresh_latin_titles() >= 1
    assert repository.refresh_latin_titles() == 0, "an idle pass finds nothing"
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("analyze library.local_tracks, library.local_albums,"
                           " library.local_track_latin_titles, library.local_album_latin_titles")
        for sql, table, index in ((_DUE_LATIN_ALBUMS_SQL, "local_tracks", "local_tracks_beyond_latin_title_idx"),
                                  (_DUE_LATIN_ALBUM_TITLES_SQL, "local_albums", "local_albums_beyond_latin_title_idx")):
            plan = connection.execute("explain (format json) " + sql,
                                      {"library_ids": [library_id], "limit": 25}).fetchone()
            nodes = list(_plan_nodes(next(iter(plan.values()))[0]["Plan"]))
            assert any(node.get("Index Name") == index for node in nodes), index
            assert not any(node.get("Node Type") == "Seq Scan" and node.get("Relation Name") == table
                           for node in nodes), f"an idle pass scans every row of {table}"


def test_symbol_titles_that_need_no_form_keep_null_rows_and_are_never_due_again(monkeypatch):
    """"★" and "♪" pass the refreshes' coarse test but need no Latin form. Their null rows keep
    them from being due on every pass, ahead of real albums, dropping cached searches each time."""
    setup_url, repository, _albums = _seed(monkeypatch)
    _pinyin_only(monkeypatch)
    album = _chinese_titled_album(setup_url, title="Best ★ Hits")
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_tracks set title = 'Intro ♪' where album_id = %s", (album,))
    assert repository.refresh_latin_titles() == 1
    assert _album_latin_rows(setup_url) == [("Best ★ Hits", None, None)]
    assert ("Intro ♪", None, None) in _latin_rows(setup_url)
    assert repository.refresh_latin_titles() == 0, "nothing is due twice"


def test_a_release_whose_album_title_alone_needs_a_latin_form_is_claimed_for_its_language(monkeypatch):
    setup_url, repository, albums = _seed(monkeypatch)
    repository.claim_transliteration(now=NOW)  # The Japanese tracklist release first.
    _retitle(setup_url, albums["latin"], "天門")
    due = repository.claim_transliteration(now=NOW)
    assert due == {"release_mbid": LATIN, "titles": ["Overture", "Кино"], "album_titles": ["天門"]}


def test_the_release_language_answer_redoes_the_album_title_in_romaji(monkeypatch):
    setup_url, repository, albums = _seed(monkeypatch)
    _both_fallbacks(monkeypatch)
    _retitle(setup_url, albums["byousoku"], "天門")
    repository.refresh_latin_titles()
    assert ("天門", "Tiān mén", "tianmen") in _album_latin_rows(setup_url), "no language yet: pinyin"
    repository.claim_transliteration(now=NOW)
    repository.store_transliteration(release_mbid=JAPANESE, transliteration_mbid=None, media=[], language="jpn",
                                     observed_at=NOW + timedelta(days=36500))  # After the decision row.
    assert repository.refresh_latin_titles() >= 1, "the stored answer changed: the row is redone"
    assert ("天門", "Tenmon", "tenmon") in _album_latin_rows(setup_url)
    assert repository.refresh_latin_titles() == 0


def test_gallery_cards_carry_the_stored_latin_title_of_their_tag_title_only(monkeypatch):
    from music_app.services.musicbrainz_correction_display import project_correction_display

    setup_url, repository, _albums = _seed(monkeypatch)
    _pinyin_only(monkeypatch)
    album = _chinese_titled_album(setup_url)
    repository.refresh_latin_titles()
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}
    connect = lambda _url: isolatedPostgres._connect(setup_url)  # noqa: E731
    payload = {"albums": [{"key": "cn-gate", "name": "天门", "album_artist": "天門"},
                          {"key": "latin", "name": "latin", "album_artist": "天門"}]}
    project_correction_display(config, payload, connect=connect)
    assert payload["albums"][0]["title_latin"] == "Tiān mén"
    assert "title_latin" not in payload["albums"][1]
    # A stale row (the title changed, not yet redone) is never shown.
    _retitle(setup_url, album, "天門")
    payload = {"albums": [{"key": "cn-gate", "name": "天門", "album_artist": "天門"}]}
    project_correction_display(config, payload, connect=connect)
    assert "title_latin" not in payload["albums"][0]
