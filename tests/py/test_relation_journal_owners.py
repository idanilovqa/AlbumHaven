"""Every committed write to a table the relation journal triggers watch (migrations 0108 and 0110) has an owner
that drains library.local_relation_dirty_albums, with no browse request (6.5, option (a)).

The owner of a write outside a scan, the watcher, a tag save or startup is the keyed incremental drain,
queued after the commit and off the response path: queue_journaled_relation_drain, which queues the
module-private generic scheduler with incremental_membership=True. Each writer below gets the same check: after its commit the owner is queued
exactly once, and a write that changed nothing queues nothing."""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

_CONFIG = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://relation-journal-owner"}


@pytest.fixture
def owners(monkeypatch):
    """The owner calls, in order with the writes' commits (``events``)."""
    from music_app.services import gallery_projection_postgres as gallery, state

    events = []

    def owner(config, **options):
        events.append(("owner", config, options))

    monkeypatch.setattr(gallery, "_schedule_gallery_projection_refresh", owner)
    monkeypatch.setattr(state, "schedule_full_gallery_projection_refresh", owner)
    return events


def _assert_owner_after_commit(events, config=_CONFIG):
    assert [event for event in events if event[0] == "owner"] == [("owner", config, {"incremental_membership": True})], (
        f"one keyed incremental drain is queued for the committed write: {events}"
    )
    assert events[-1][0] == "owner" and events.index(events[-1]) > events.index(("commit",)), (
        f"the owner is queued after the commit: {events}"
    )


class _Connection:
    """Records each statement and its commit; ``rowcount`` and ``row`` are what each statement reports."""

    def __init__(self, events, *, rowcount=1, row=None):
        self._events, self.rowcount, self.row = events, rowcount, row

    def __enter__(self):
        return self

    def __exit__(self, exc_type, *_exc):
        if exc_type is None:
            self._events.append(("commit",))
        return False

    def execute(self, *_args, **_kwargs):
        self._events.append(("statement",))
        return SimpleNamespace(rowcount=self.rowcount, fetchone=lambda: self.row, fetchall=lambda: [])

    def transaction(self):
        return nullcontext()

    def commit(self):
        pass


def test_saving_the_exception_override_list_hands_its_albums_to_the_owner(monkeypatch, owners):
    from music_app.services import exception_overrides, library_browse_postgres

    class Adapter:
        def __init__(self, _config):
            pass

        def save_exception_overrides(self, _overrides):
            owners.append(("commit",))

    monkeypatch.setattr(exception_overrides, "select_runtime_persistence_adapter", lambda *_args: None)
    monkeypatch.setattr(exception_overrides, "RuleStatePostgresAdapter", Adapter)
    monkeypatch.setattr(library_browse_postgres, "invalidate_postgres_utility_projection_cache", lambda **_kwargs: None)

    exception_overrides.save_exception_overrides(_CONFIG, {"/music/a.flac": "Non-album rarity"})

    _assert_owner_after_commit(owners)


@pytest.mark.parametrize("updates", [{"/music/a.flac": "Non-album rarity"}, {}])
def test_a_rarity_or_exception_override_hands_its_albums_to_the_owner(monkeypatch, owners, updates):
    from music_app.services import exception_overrides, library_browse_postgres

    class Adapter:
        def __init__(self, _config):
            pass

        def upsert_exception_overrides(self, _overrides):
            owners.append(("commit",))

    monkeypatch.setattr(exception_overrides, "select_runtime_persistence_adapter", lambda *_args: None)
    monkeypatch.setattr(exception_overrides, "RuleStatePostgresAdapter", Adapter)
    monkeypatch.setattr(library_browse_postgres, "invalidate_postgres_utility_projection_cache", lambda **_kwargs: None)

    exception_overrides.set_track_exception_overrides(_CONFIG, updates)

    if not updates:
        assert owners == [], "nothing written, nothing queued"
        return
    _assert_owner_after_commit(owners)


@pytest.mark.parametrize("exception_updates", [{"/music/a.flac": "Non-album rarity"}, {}])
def test_a_tag_edit_intent_completed_on_its_own_hands_its_overrides_to_the_owner(monkeypatch, owners, exception_updates):
    """The scoped completion (api_wave_a: complete_scoped_persistence) commits its exception overrides in a
    transaction of its own, outside the tag save that owns the in-transaction completion."""
    from music_app.services.tag_edit_intents_postgres import PostgresTagEditIntentRepository

    repository = PostgresTagEditIntentRepository(_CONFIG, connect=lambda _url: _Connection(owners))
    monkeypatch.setattr(repository, "complete_in_transaction", lambda *_args, **_kwargs: None)

    repository.complete("intent-1", exception_updates=exception_updates)

    if not exception_updates:
        assert [event for event in owners if event[0] == "owner"] == [], "no override written, nothing queued"
        return
    _assert_owner_after_commit(owners)


@pytest.mark.parametrize("found", [True, False])
def test_keep_as_missing_hands_its_album_to_the_owner(owners, found):
    from music_app.services.missing_album_removal_postgres import (
        MissingAlbumNotFound,
        PostgresMissingAlbumRemovalService,
    )

    service = PostgresMissingAlbumRemovalService(
        _CONFIG, connect=lambda _url: _Connection(owners, row={"id": 7} if found else None))

    if not found:
        with pytest.raises(MissingAlbumNotFound):
            service.keep_missing("artist|album")
        assert [event for event in owners if event[0] == "owner"] == []
        return
    service.keep_missing("artist|album")
    _assert_owner_after_commit(owners)


@pytest.mark.parametrize("rowcount", [1, 0])
def test_a_recorded_missing_reason_hands_its_album_to_the_owner(owners, rowcount):
    from music_app.services.missing_album_rescan import MissingAlbumRescan

    rescan = MissingAlbumRescan(_CONFIG, reconcile=lambda _request: None, roots=[],
                                connect=lambda _url: _Connection(owners, rowcount=rowcount))

    rescan._record_reason("artist|album", "unreachable")

    if not rowcount:
        assert [event for event in owners if event[0] == "owner"] == [], "an unchanged reason queues nothing"
        return
    _assert_owner_after_commit(owners)


def test_repointed_tracks_hand_their_album_to_the_owner(owners, tmp_path):
    from music_app.services.missing_album_rescan import MissingAlbumRescan

    album_dir, destination = tmp_path / "old" / "Album", tmp_path / "new" / "Album"
    destination.mkdir(parents=True)
    (destination / "01.flac").write_bytes(b"")
    rescan = MissingAlbumRescan(_CONFIG, reconcile=lambda _request: None,
                                roots=[{"id": "new", "path": str(tmp_path / "new")}],
                                connect=lambda _url: _Connection(owners))

    rescan._repoint_tracks(album_dir, destination, "new", [album_dir / "01.flac"])

    _assert_owner_after_commit(owners)


@pytest.mark.parametrize("outcome", ["changed", "aborted", "unchanged", "failed"])
def test_an_automatic_cover_run_hands_its_albums_to_the_owner(monkeypatch, owners, outcome):
    """Automatic, scan and selected-album cover runs commit through persist_cover_selection_in_shared_transaction;
    one owner per run that processed a job, after its shared connection is released. A run aborted by a newer
    scan or cover generation reports changed=False after committing albums, and a failed run may have committed
    some, so both are owned too; a run with no job queues nothing."""
    from music_app.services import cover_refresh_execution

    @contextmanager
    def shared(_config):
        yield
        owners.append(("commit",))

    def run(**_kwargs):
        if outcome == "failed":
            raise RuntimeError("provider failed")
        return {"changed": outcome == "changed", "processed": 0 if outcome == "unchanged" else 2}

    monkeypatch.setattr(cover_refresh_execution, "shared_scan_cache_connection", shared)
    monkeypatch.setattr(cover_refresh_execution, "_run_cover_jobs", run)
    arguments = dict(get_state=dict, config=_CONFIG, logger=None, cache_lock=None, jobs=[], file_cache={},
                     separate_release_keys=set(), image_extensions=set(), user_agent="", cover_cache=None)

    if outcome == "failed":
        with pytest.raises(RuntimeError):
            cover_refresh_execution.run_cover_jobs(**arguments)
    else:
        cover_refresh_execution.run_cover_jobs(**arguments)

    if outcome == "unchanged":
        assert [event for event in owners if event[0] == "owner"] == [], "a run with no job queues nothing"
        return
    assert [event for event in owners if event[0] == "owner"] == [("owner", _CONFIG, {"incremental_membership": True})]


@pytest.mark.parametrize("artists", [2, 0])
def test_the_post_scan_mbid_follow_up_hands_renamed_artists_to_the_owner(monkeypatch, owners, artists):
    """Its upsert sets local_artists.name, which the journal watches."""
    from music_app.services import state

    def follow_up(**_kwargs):
        owners.append(("commit",))
        return {"artist_count": artists, "asserted_count": 0, "assertion_row_count": 0}

    monkeypatch.setattr(state, "run_post_scan_artist_mbid_assertion_follow_up", follow_up)

    state._run_mbid_assertion_follow_up(None, {"artist_names": ["A"] * artists}, _CONFIG)

    if not artists:
        assert [event for event in owners if event[0] == "owner"] == []
        return
    _assert_owner_after_commit(owners)
