"""The automatic album "MusicBrainz has no info" flag on real isolated PostgreSQL (D2, S5).

Raised when a release lookup ends unresolved with no_title_match, cleared when the album
later resolves; the owner's own flags and decisions are never touched. Recorded outcomes
only: nothing calls MusicBrainz.
"""
from __future__ import annotations

from datetime import timedelta

from music_app.services.musicbrainz_enrichment_postgres import MusicBrainzEnrichmentPostgresRepository
from music_app.services.musicbrainz_release_identity import MusicBrainzAlbumReleaseProcessor
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_release_identity_postgres import (
    GROUP,
    NOW,
    RELEASE,
    FakeResolverClient,
    _outcome,
    _seed,
)


def _flags(setup_url):
    with isolatedPostgres._connect(setup_url) as connection:
        return sorted((row["album_key"], row["source"], row["reason"]) for row in connection.execute(
            "select album_key, source, reason from library.musicbrainz_contribution_flags"
            " where target_kind = 'album'").fetchall())


def _run(monkeypatch, repository, ids, outcome, at=NOW):
    from music_app.services import musicbrainz_release_identity as module
    monkeypatch.setattr(module, "resolve_album_releases", lambda context, client: outcome(context))
    processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=FakeResolverClient(), now=lambda: at)
    for artist in ("angra", "other"):
        repository.enqueue(reason="test", observed_at=at, local_artist_id=ids[artist], force=True)
    while processor.process_next(worker_id="w").get("processed"):
        pass


def _resolved(context):
    """Elsewhere is found on a later lookup."""
    result = _outcome(context)
    for album in result["albums"]:
        if album["local_title"] == "Elsewhere":
            album.update(state="release", release_group_mbid=GROUP, release_mbid=RELEASE, diagnostic=None,
                         signals=["track_list"])
    return result


def test_only_a_no_title_match_raises_the_flag_and_the_owner_sees_that_album(monkeypatch):
    setup_url, repository, ids, _albums = _seed(monkeypatch)

    _run(monkeypatch, repository, ids, _outcome)

    # Angels Cry resolved and Holy Land's tracks differ: neither is "missing from MusicBrainz".
    assert _flags(setup_url) == [("rel-else", "automatic", "missing_from_musicbrainz")]
    enrichment = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    (row,) = enrichment.list_album_attention()
    assert (row["album_key"], row["album_title"], row["artist_name"]) == ("rel-else", "Elsewhere", "Other")
    assert enrichment.list_album_attention(album_key="rel-cry") == []


def test_the_flag_clears_when_the_album_resolves_and_owner_flags_stay(monkeypatch):
    setup_url, repository, ids, _albums = _seed(monkeypatch)
    _run(monkeypatch, repository, ids, _outcome)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "insert into library.musicbrainz_contribution_flags (library_id, target_kind, album_key, source, reason)"
            " select library_id, 'album', album_key, 'manual', 'owner_marked' from library.local_albums"
            " where album_key = 'rel-else'")

    _run(monkeypatch, repository, ids, _resolved, at=NOW + timedelta(days=1))

    assert _flags(setup_url) == [("rel-else", "manual", "owner_marked")]


def test_an_owner_decided_album_never_gets_the_automatic_flag(monkeypatch):
    setup_url, repository, ids, _albums = _seed(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "insert into library.local_album_musicbrainz_releases (library_id, album_key, state, diagnostic,"
            " decision_source, matcher_version, observed_at, created_at, updated_at)"
            " select library_id, album_key, 'unresolved', 'title_only', 'manual', 1, %s, %s, %s"
            " from library.local_albums"
            " where album_key = 'rel-else'", (NOW, NOW, NOW))

    _run(monkeypatch, repository, ids, _outcome)

    assert _flags(setup_url) == []
