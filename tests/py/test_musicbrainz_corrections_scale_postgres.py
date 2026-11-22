"""Data-correction refresh, reads and decisions on real PostgreSQL at 10 and 15,000 albums (D2 S4).

The rows PostgreSQL itself reads are counted per interaction, so a plan that scans the library
fails here even when its SQL names only the changed albums.
"""
from __future__ import annotations

import contextlib

import pytest

from music_app.services.musicbrainz_corrections_postgres import MusicBrainzCorrectionsPostgresRepository
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_artist_migration_postgres import leave_setup_database_migrated
from tests.py.test_musicbrainz_release_identity_postgres import GROUP, NOW, _seed

pytestmark = pytest.mark.usefixtures("leave_setup_database_migrated")

SMALL, PRODUCTION = 10, 15000
# A few albums' rows, their indexes' neighbours and a page; never a table of the library.
READ_BUDGET = 1500
_READS_SQL = """
    select coalesce(sum(coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0)), 0)::bigint as rows
    from pg_stat_xact_user_tables
    where relname in ('local_albums', 'local_tracks', 'local_album_musicbrainz_releases',
      'local_album_musicbrainz_corrections', 'local_album_musicbrainz_correction_rows',
      'local_album_musicbrainz_correction_decisions', 'local_album_musicbrainz_correction_groups',
      'musicbrainz_correction_refresh_marks', 'musicbrainz_correction_group_counts', 'musicbrainz_releases');
"""


def _add_albums(setup_url, first, last):
    """Albums ``first``..``last``, each with a track and its own release: albums 1-3 differ by an
    edition suffix (waiting), every other by case (applied automatically)."""
    with isolatedPostgres._connect(setup_url) as connection:
        params = {"first": first, "last": last, "group": GROUP, "now": NOW}
        connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title, release_year, metadata)"
            " select artists.library_id, artists.id, 'scale::' || n, 'album ' || n, 1990, '{}'::jsonb"
            " from generate_series(%(first)s::int, %(last)s::int) n"
            " cross join (select id, library_id from library.local_artists where artist_key = 'rel-angra') artists",
            params)
        connection.execute(
            "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, disc_number,"
            " track_number, metadata)"
            " select albums.library_id, albums.id, albums.artist_id, albums.album_key, 'Song', 1, 1, '{}'::jsonb"
            " from generate_series(%(first)s::int, %(last)s::int) n"
            " join library.local_albums albums on albums.album_key = 'scale::' || n", params)
        connection.execute(
            "insert into integration.musicbrainz_releases (mbid, release_group_mbid, title, artist_credit, refreshed_at)"
            " select md5('scale' || n)::uuid, %(group)s,"
            "        case when n <= 3 then 'album ' || n || ' (Deluxe)' else 'Album ' || n end,"
            "        '[{\"name\": \"Angra\", \"join_phrase\": \"\"}]'::jsonb, %(now)s"
            " from generate_series(%(first)s::int, %(last)s::int) n", params)
        connection.execute(
            "insert into library.local_album_musicbrainz_releases (library_id, album_key, state, release_group_mbid,"
            " release_mbid, matcher_version, observed_at, match_quality)"
            " select albums.library_id, albums.album_key, 'release', %(group)s, md5('scale' || n)::uuid, 4, %(now)s,"
            "        'order_exact'"
            " from generate_series(%(first)s::int, %(last)s::int) n"
            " join library.local_albums albums on albums.album_key = 'scale::' || n", params)
    MusicBrainzCorrectionsPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url),
    ).refresh(observed_at=NOW)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("analyze")


def _rows_read(setup_url, interaction) -> int:
    """The rows the interaction reads, in one transaction that is then rolled back."""
    with isolatedPostgres._connect(setup_url) as connection:
        read = []
        with contextlib.suppress(_Rollback):
            with connection.transaction():
                before = connection.execute(_READS_SQL).fetchone()["rows"]
                repository = MusicBrainzCorrectionsPostgresRepository(
                    {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
                    connect=lambda _url: contextlib.nullcontext(connection), on_change=lambda _keys: None)
                interaction(connection, repository)
                read.append(int(connection.execute(_READS_SQL).fetchone()["rows"] - before))
                raise _Rollback
    return read[0]


class _Rollback(Exception):
    pass


def _refresh_after_one_edit(connection, repository):
    connection.execute("update library.local_tracks set title = 'Sung'"
                       " where album_id = (select id from library.local_albums where album_key = 'scale::7'"
                       " and library_id = (select library_id from library.local_artists where artist_key = 'rel-angra'))")
    assert repository.refresh(observed_at=NOW) == 1


def _totals(_connection, repository):
    assert {row["kind"] for row in repository.kinds(section="applied")} == {"case"}


def _first_page(_connection, repository):
    assert repository.kind_page(section="applied", kind="case", after=None, limit=5)


def _deep_page(_connection, repository):
    assert repository.kind_page(section="applied", kind="case", after=("album 8", "scale::8"), limit=5)


def _approve_album(_connection, repository):
    assert repository.decide(decision="approved", from_state="pending", album_key="scale::1", kind=None,
                             actor_account_id=None, observed_at=NOW) == 1


def _approve_kind(_connection, repository):
    assert repository.decide(decision="approved", from_state="pending", album_key=None, kind="edition_suffix",
                             actor_account_id=None, observed_at=NOW) == 3


INTERACTIONS = (_refresh_after_one_edit, _totals, _first_page, _deep_page, _approve_album, _approve_kind)


def test_corrections_read_only_changed_albums_and_one_page_at_production_album_count(monkeypatch):
    setup_url, _repository, _ids, _albums = _seed(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("insert into integration.musicbrainz_release_groups (mbid, title, refreshed_at)"
                           " values (%s, 'Scale', %s)", (GROUP, NOW))

    _add_albums(setup_url, 1, SMALL)
    small = {step.__name__: _rows_read(setup_url, step) for step in INTERACTIONS}
    _add_albums(setup_url, SMALL + 1, PRODUCTION)
    production = {step.__name__: _rows_read(setup_url, step) for step in INTERACTIONS}

    assert all(count <= READ_BUDGET for count in production.values()), (small, production)


def test_totals_follow_every_decision_tag_change_and_album_deletion(monkeypatch):
    setup_url, _repository, _ids, _albums = _seed(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("insert into integration.musicbrainz_release_groups (mbid, title, refreshed_at)"
                           " values (%s, 'Scale', %s)", (GROUP, NOW))
    _add_albums(setup_url, 1, SMALL)
    repository = MusicBrainzCorrectionsPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))

    def totals():
        return {(section, row["kind"]): (row["albums"], row["rows"])
                for section in ("applied", "review") for row in repository.kinds(section=section)}

    assert totals() == {("applied", "case"): (7, 7), ("review", "edition_suffix"): (3, 3)}

    repository.decide(decision="approved", from_state="pending", album_key="scale::1", kind=None,
                      actor_account_id=None, observed_at=NOW)
    repository.decide(decision="skipped", from_state="pending", album_key="scale::2", kind=None,
                      actor_account_id=None, observed_at=NOW)
    assert totals() == {("applied", "case"): (7, 7), ("applied", "edition_suffix"): (1, 1),
                        ("review", "edition_suffix"): (1, 1)}

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_albums set title = 'Album 5' where album_key = 'scale::5'")
        connection.execute("delete from library.local_tracks where album_id ="
                           " (select id from library.local_albums where album_key = 'scale::6')")
        connection.execute("delete from library.local_albums where album_key = 'scale::6'")
    assert totals()[("applied", "case")] == (6, 6), "a deleted album leaves the totals at once"
    repository.refresh(observed_at=NOW)
    assert totals()[("applied", "case")] == (5, 5), "a corrected tag leaves them on the next refresh"

    listed, after = [], None
    while page := repository.kind_page(section="applied", kind="case", after=after, limit=2):
        listed += [row["album_key"] for row in page]
        after = (page[-1]["sort_title"], page[-1]["album_key"])
    assert listed == ["scale::10", "scale::4", "scale::7", "scale::8", "scale::9"], "title order, each album once"
