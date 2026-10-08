"""Persisted account/library/alias and transaction contracts for track taste."""
from __future__ import annotations

import pytest

from tests.py.track_taste_testing import (
    ObservedConnection, OwnedWorkers, observe_lock_wait,
    taste, taste_database,
)


def store_for(taste, connect=None):
    from music_app.services.track_preferences_postgres import PostgresTrackPreferencesStore
    return PostgresTrackPreferencesStore(taste.config, connect=connect or (lambda _url: taste.connect(runtime=True)))


def patch(taste, track, values, *, account=None, ref=None, store=None, library_id=None):
    return (store or store_for(taste)).patch_preference(
        ref or track["paths"][0], values,
        account_id=taste.b if account is None else account,
        library_id=track["library_id"] if library_id is None else library_id,
        expected_track_id=track["id"],
    )


def load(taste, track, *, account=None, refs=None, library_id=None):
    return store_for(taste).load_track_preferences(
        refs or [track["key"], *track["paths"]],
        account_id=taste.b if account is None else account,
        library_id=track["library_id"] if library_id is None else library_id,
    )


def test_two_users_and_two_libraries_keep_independent_rows(taste):
    first = taste.add_track("first")
    foreign = taste.add_track("foreign", library_id=taste.l2, key=first["key"])
    a_id = taste.seed_preference(taste.a, first, rating=1)
    b_id = taste.seed_preference(taste.b, first, rating=2)
    foreign_id = taste.seed_preference(taste.b, foreign, rating=3)
    legacy = taste.add_track("legacy")
    legacy_id = taste.seed_preference(taste.b, legacy, library_id=None, rating=5)
    protected = [taste.row(a_id), taste.row(foreign_id), taste.row(legacy_id)]

    result = patch(taste, first, {"rating": 4, "love_tier": "obsessed"})

    assert (result["rating"], result["love_tier"]) == (4, "obsessed")
    assert result["preference_id"] == b_id
    assert [taste.row(a_id), taste.row(foreign_id), taste.row(legacy_id)] == protected
    assert load(taste, first, account=taste.a)[first["paths"][0]]["rating"] == 1
    assert load(taste, foreign)[foreign["key"]]["rating"] == 3
    assert load(taste, legacy)[legacy["paths"][0]]["rating"] is None


@pytest.mark.parametrize("existing_key", ["logical", "path", "none"])
@pytest.mark.parametrize("requested_alias", ["logical", "path1", "path2"])
def test_aliases_reuse_single_history_and_create_only_logical_key(taste, existing_key, requested_alias):
    track = taste.add_track("alias", paths=[f"/fixture/{taste.prefix}/à.flac", f"C:\\Fixture\\{taste.prefix}\\song.flac"])
    key = track["key"] if existing_key == "logical" else track["paths"][0]
    preference_id = None if existing_key == "none" else taste.seed_preference(taste.b, track, key=key)
    aliases = {"logical": track["key"], "path1": track["paths"][0], "path2": track["paths"][1]}

    result = patch(taste, track, {"rating": 5}, ref=" " + aliases[requested_alias] + " ")

    assert result["track_ref"] == aliases[requested_alias]
    assert result["track_id"] == track["id"]
    rows = taste.rows()
    assert len(rows) == 1
    assert rows[0]["track_key"] == (track["key"] if existing_key == "none" else key)
    assert rows[0]["track_id"] is None
    if preference_id is not None:
        assert rows[0]["id"] == preference_id
    lookup = load(taste, track)
    assert set(lookup) == {track["key"], *track["paths"]}
    assert {row["preference_id"] for row in lookup.values()} == {rows[0]["id"]}
    assert {row["rating"] for row in lookup.values()} == {5}


@pytest.mark.parametrize("conflict", ["alias_history", "wrong_track_id", "key_path_collision", "other_alias_collision"])
@pytest.mark.parametrize("values", [{"rating": 5}, {}])
def test_ambiguous_identity_is_neutral_and_preserves_all_history(taste, conflict, values):
    from music_app.services.track_preferences_postgres import TrackPreferenceConflictError
    track = taste.add_track("target")
    sibling = taste.add_track("sibling")
    if conflict == "alias_history":
        taste.seed_preference(taste.b, track)
        taste.seed_preference(taste.b, track, key=track["paths"][0], rating=4)
    elif conflict == "wrong_track_id":
        taste.seed_preference(taste.b, track, track_id=sibling["id"])
    else:
        # Globally unique private paths remain unique. Only logical key/path
        # alias strings collide, which the real schema allows.
        with taste.connect() as connection:
            connection.execute("update library.local_tracks set track_key=%s where id=%s",
                               (track["paths"][0], sibling["id"]))
    before = taste.rows()
    requested = track["key"] if conflict == "other_alias_collision" else track["paths"][0]

    with pytest.raises(TrackPreferenceConflictError):
        patch(taste, track, values, ref=requested)

    assert load(taste, track) == {}
    assert taste.rows() == before


@pytest.mark.parametrize("case", ["missing", "foreign", "stale", "no_file"])
@pytest.mark.parametrize("values", [{"rating": 4}, {}])
def test_missing_foreign_or_inactive_identity_never_writes(taste, case, values):
    from music_app.services.track_preferences_postgres import TrackPreferenceNotFoundError
    track = taste.add_track(case, library_id=taste.l2 if case == "foreign" else taste.l1)
    requested = track["paths"][0]
    with taste.connect() as connection:
        if case == "stale":
            connection.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where track_id=%s", (track["id"],))
        elif case == "no_file":
            connection.execute("delete from library.local_track_files where track_id=%s", (track["id"],))
        elif case == "missing":
            requested = f"/fixture/{taste.prefix}/missing.flac"
    before = taste.rows()
    with pytest.raises(TrackPreferenceNotFoundError):
        patch(taste, track, values, ref=requested, library_id=taste.l1)
    assert taste.rows() == before


def test_logical_key_and_file_path_matching_same_track_is_not_ambiguous(taste):
    path = f"/fixture/{taste.prefix}/same.flac"
    track = taste.add_track("same", key=path, paths=[path])
    assert patch(taste, track, {"rating": 3})["rating"] == 3
    assert len(taste.rows()) == 1


def test_partial_clear_preserves_omitted_fields_metadata_and_row_identity(taste):
    track = taste.add_track("partial")
    preference_id = taste.seed_preference(taste.b, track, rating=4, love_tier="obsessed")
    original = taste.row(preference_id)
    patch(taste, track, {"rating": None})
    first = taste.row(preference_id)
    assert (first["rating"], first["love_tier"]) == (None, "obsessed")
    assert first["metadata"] == {**original["metadata"], "rating_explicit": True}
    patch(taste, track, {"love_tier": "off"})
    cleared = taste.row(preference_id)
    assert (cleared["rating"], cleared["love_tier"]) == (None, "off")
    assert cleared["metadata"] == {**original["metadata"], "rating_explicit": True, "love_tier_explicit": True}
    assert (cleared["id"], cleared["track_key"], cleared["track_id"]) == (
        original["id"], original["track_key"], original["track_id"])
    # Nonempty repeats are state-idempotent; updated_at need not be identical.
    patch(taste, track, {"rating": None, "love_tier": "off"})
    repeated = taste.row(preference_id)
    assert {k: v for k, v in repeated.items() if k != "updated_at"} == {
        k: v for k, v in cleared.items() if k != "updated_at"}


@pytest.mark.parametrize("existing", [False, True])
def test_empty_patch_is_byte_equivalent_and_does_not_create_intent(taste, existing):
    track = taste.add_track("empty")
    if existing:
        taste.seed_preference(taste.b, track)
    before = taste.rows()
    result = patch(taste, track, {})
    assert result["rating"] == (2 if existing else None)
    assert result["love_tier"] == ("loved" if existing else "off")
    assert taste.rows() == before


@pytest.mark.parametrize("field,bad", [("account_id", True), ("account_id", 0), ("account_id", "1"),
                                        ("library_id", True), ("library_id", -1), ("library_id", "1")])
def test_scope_requires_positive_exact_integer_ids(taste, field, bad):
    track = taste.add_track("scope")
    scope = {"account_id": taste.b, "library_id": taste.l1}
    scope[field] = bad
    before = taste.rows()
    with pytest.raises((ValueError, PermissionError)):
        store_for(taste).patch_preference(track["key"], {"rating": 5}, expected_track_id=track["id"], **scope)
    assert taste.rows() == before


def test_expected_authorized_numeric_identity_cannot_be_substituted(taste):
    from music_app.services.track_preferences_postgres import TrackPreferenceNotFoundError
    track, other = taste.add_track("authorized"), taste.add_track("other")
    with pytest.raises(TrackPreferenceNotFoundError):
        store_for(taste).patch_preference(track["paths"][0], {"rating": 5},
            account_id=taste.b, library_id=taste.l1, expected_track_id=other["id"])
    assert taste.rows() == []


def test_distinct_track_writes_overlap_without_touching_third_row(taste):
    first, second, third = [taste.add_track(name) for name in ("first", "second", "third")]
    first_id = taste.seed_preference(taste.b, first)
    third_id = taste.seed_preference(taste.b, third)
    protected = taste.row(third_id)
    with OwnedWorkers(taste.database) as work:
        with taste.connect() as blocker:
            blocker.execute("select id from app.track_preferences where id=%s for update", (first_id,))
            one = work.start(lambda: patch(taste, first, {"rating": 5},
                store=store_for(taste, work.runtime_connection)))
            assert work.connected.wait(2)
            observe_lock_wait(taste, work.pids)
            two = work.start(lambda: patch(taste, second, {"love_tier": "obsessed"},
                store=store_for(taste, work.runtime_connection)))
            work.finish(two)
            assert not two.errors, two.errors
            assert not one.done.is_set()
        # The inner blocker exits before the shared owner drains every worker.
    assert not one.errors, one.errors
    assert load(taste, first)[first["key"]]["rating"] == 5
    assert load(taste, second)[second["key"]]["love_tier"] == "obsessed"
    assert taste.row(third_id) == protected


@pytest.mark.parametrize("history", ["absent", "logical", "path"])
@pytest.mark.parametrize("rating_patch,love_patch", [
    ({"rating": 5}, {"love_tier": "obsessed"}),
    ({"rating": None}, {"love_tier": "obsessed"}),
    ({"rating": 5}, {"love_tier": "off"}),
])
def test_concurrent_aliases_merge_disjoint_fields_after_real_conflict_wait(taste, history, rating_patch, love_patch):
    track = taste.add_track("parallel", paths=[f"/fixture/{taste.prefix}/one.flac", f"/fixture/{taste.prefix}/two.flac"])
    if history != "absent":
        preference_id = taste.seed_preference(taste.b, track, key=track["key"] if history == "logical" else track["paths"][0])
    with OwnedWorkers(taste.database) as work:
        phase = work.barrier()
        def first_connection(_url):
            return ObservedConnection(work.runtime_connection(), after_dml=phase.pause)
        one = work.start(lambda: patch(taste, track, rating_patch, ref=track["paths"][0],
            store=store_for(taste, first_connection)))
        assert phase.reached.wait(2)
        two = work.start(lambda: patch(taste, track, love_patch, ref=track["paths"][1],
            store=store_for(taste, work.runtime_connection)))
        observe_lock_wait(taste, work.pids)
        phase.release.set()
    assert not one.errors and not two.errors, (one.errors, two.errors)
    rows = taste.rows()
    assert len(rows) == 1
    row = rows[0]
    assert (row["rating"], row["love_tier"]) == (rating_patch["rating"], love_patch["love_tier"])
    assert row["metadata"]["rating_explicit"] is True
    assert row["metadata"]["love_tier_explicit"] is True
    assert row["track_key"] == (track["paths"][0] if history == "path" else track["key"])
    if history != "absent":
        assert row["id"] == preference_id


def change_scope(taste, track, change, *, connect):
    with connect() as connection:
        if change == "membership":
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (taste.b, taste.l1))
        elif change == "disabled":
            connection.execute("update app.accounts set is_active=false, disabled_at=now() where id=%s", (taste.b,))
        elif change == "stale":
            connection.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where private_path=%s", (track["paths"][0],))
        elif change == "relink":
            other = next(t for t in taste.tracks if t["id"] != track["id"])
            connection.execute("update library.local_track_files set track_id=%s where private_path=%s", (other["id"], track["paths"][0]))
        elif change == "collision":
            other = next(t for t in taste.tracks if t["id"] != track["id"])
            connection.execute("update library.local_tracks set track_key=%s where id=%s", (track["paths"][0], other["id"]))
        elif change == "history-selection":
            connection.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','false') where private_path=%s", (track["paths"][1],))


@pytest.mark.parametrize("change", ["membership", "disabled", "stale", "relink", "collision"])
@pytest.mark.parametrize("existing", [False, True])
def test_change_after_dml_before_M_rolls_back_new_and_existing_preference(taste, change, existing):
    track = taste.add_track("observed")
    taste.add_track("other")
    if existing:
        taste.seed_preference(taste.b, track)
    before = taste.rows()
    with OwnedWorkers(taste.database) as work:
        phase = work.barrier()
        repository = store_for(taste, lambda _url: ObservedConnection(
            work.runtime_connection(), after_dml=phase.pause))
        writer = work.start(lambda: patch(taste, track, {"rating": 5, "love_tier": "obsessed"}, store=repository))
        assert phase.reached.wait(2)
        mutation = work.start(lambda: change_scope(taste, track, change, connect=work.setup_connection))
        work.finish(mutation)
        assert not mutation.errors, mutation.errors
        assert not writer.done.is_set(), "writer escaped the pre-M barrier before the competing commit"
        phase.release.set()
    assert len(writer.errors) == 1 and isinstance(writer.errors[0], (PermissionError, LookupError, ValueError)), writer.errors
    assert taste.rows() == before


@pytest.mark.parametrize("change", ["membership", "disabled", "stale", "relink"])
@pytest.mark.parametrize("values", [{"rating": 5}, {}])
def test_scope_change_between_authorization_and_repository_entry_denies(taste, change, values):
    track = taste.add_track("entry")
    taste.add_track("other")
    taste.seed_preference(taste.b, track)
    before = taste.rows()
    with OwnedWorkers(taste.database) as work:
        repository = store_for(taste, work.runtime_connection)
        selection = work.start(lambda: repository.resolve_track(track["paths"][0], account_id=taste.b, library_id=taste.l1))
        work.finish(selection)
        assert not selection.errors, selection.errors
        assert selection.result[0]["track_id"] == track["id"]
        mutation = work.start(lambda: change_scope(taste, track, change, connect=work.setup_connection))
        work.finish(mutation)
        assert not mutation.errors, mutation.errors
        writer = work.start(lambda: patch(taste, track, values, store=repository))
        work.finish(writer)
    assert len(writer.errors) == 1 and isinstance(writer.errors[0], (PermissionError, LookupError, ValueError)), writer.errors
    assert taste.rows() == before


def test_change_after_M_does_not_retroactively_cancel_committed_patch(taste):
    track = taste.add_track("after-M")
    taste.seed_preference(taste.b, track)
    with OwnedWorkers(taste.database) as work:
        phase = work.barrier()
        repository = store_for(taste, lambda _url: ObservedConnection(
            work.runtime_connection(), before_commit=phase.pause))
        writer = work.start(lambda: patch(taste, track, {"rating": 5}, store=repository))
        assert phase.reached.wait(2)
        mutation = work.start(lambda: change_scope(taste, track, "membership", connect=work.setup_connection))
        work.finish(mutation)
        assert not mutation.errors, mutation.errors
        assert not writer.done.is_set(), "writer escaped the post-M barrier before the competing commit"
        phase.release.set()
    assert not writer.errors, writer.errors
    assert writer.result[0]["rating"] == 5
    assert taste.rows()[0]["rating"] == 5
    with pytest.raises(PermissionError):
        patch(taste, track, {})


def test_actual_runtime_role_can_select_insert_and_conflict_update(taste):
    from tests.e2e.support import isolatedPostgres
    track = taste.add_track("privileges")
    with taste.connect(runtime=True) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.RUNTIME_ROLE)
    first = patch(taste, track, {"rating": 2})
    second = patch(taste, track, {"love_tier": "obsessed"})
    assert second["preference_id"] == first["preference_id"]
    assert load(taste, track)[track["key"]]["love_tier"] == "obsessed"


@pytest.mark.parametrize("failure_at", ["body", "before-commit"])
def test_observed_connection_exits_real_transaction_once_on_failure(taste, failure_at):
    track = taste.add_track("proxy-rollback")
    before = taste.rows()
    connection = taste.connect(runtime=True)
    exits, hooks = [], []
    expected = RuntimeError("test-owned transaction failure")
    class RecordedConnection:
        def __getattr__(self, name):
            return getattr(connection, name)
        def __enter__(self):
            connection.__enter__()
            return self
        def __exit__(self, kind, value, traceback):
            exits.append((kind, value))
            return connection.__exit__(kind, value, traceback)
    def before_commit():
        hooks.append(True)
        raise expected
    try:
        with pytest.raises(RuntimeError) as caught:
            with ObservedConnection(RecordedConnection(), before_commit=before_commit) as observed:
                observed.execute("""insert into app.track_preferences(account_id,library_id,track_key,rating,love_tier)
                    values (%s,%s,%s,4,'loved')""", (taste.b, taste.l1, track["key"]))
                if failure_at == "body":
                    raise expected
        assert caught.value is expected
        assert exits == [(RuntimeError, expected)]
        assert hooks == ([True] if failure_at == "before-commit" else [])
        assert connection.closed
    finally:
        connection.close()
    assert taste.rows() == before
