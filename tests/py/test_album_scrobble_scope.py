"""Independent regressions for response-owned, actor-scoped Album scrobbles."""
from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import pytest

from tests.py.track_taste_testing import taste, taste_app, taste_database


REF = "/synthetic/album/one.flac"
OTHER = "/synthetic/album/duplicate.flac"


def _cached_album(poison=777):
    def track(ref, identity):
        return {"path": ref, "track_ref": ref, "track_id": identity, "title": "Synthetic Track",
                "track_number": 1, "disc_number": 1, "duration_seconds": 60,
                "track_scrobble_count": poison, "scrobble_count": poison,
                "track_stats": {"scrobble_count": poison}}
    main, duplicate = track(REF, 21), track(OTHER, 22)
    return {"key": "synthetic-album", "name": "Synthetic Album", "album_artist": "Synthetic Artist",
            "album_rating": 0, "year": 2020, "total_duration_seconds": 60,
            "tracks": [main], "track_rows": [deepcopy(main)],
            "gallery_list_block": {"track_rows": [deepcopy(main)]},
            "duplicate_sources": [{"key": "synthetic-duplicate", "name": "Duplicate",
                "album_artist": "Synthetic Artist", "tracks": [deepcopy(main), duplicate],
                "track_rows": [deepcopy(main), deepcopy(duplicate)],
                "gallery_list_block": {"track_rows": [deepcopy(main), deepcopy(duplicate)]}}]}


def _assert_counts(payload, expected):
    observed = {"raw": 0, "rows": 0, "gallery": 0}
    def inspect(container):
        for track in container.get("tracks", []):
            wanted = expected[track["path"]]
            assert track.get("track_scrobble_count") == wanted
            assert (track.get("track_stats") or {}).get("scrobble_count") == wanted
            if "scrobble_count" in track:
                assert track["scrobble_count"] == wanted
            observed["raw"] += 1
        for name, rows in (("rows", container.get("track_rows", [])),
                           ("gallery", container.get("gallery_list_block", {}).get("track_rows", []))):
            for row in rows:
                wanted = expected[row.get("track_ref") or row["path"]]
                assert (row.get("track_stats") or {}).get("scrobble_count") == wanted
                if "track_scrobble_count" in row:
                    assert row["track_scrobble_count"] == wanted
                if "scrobble_count" in row:
                    assert row["scrobble_count"] == wanted
                observed[name] += 1
        for child in container.get("duplicate_sources", []):
            inspect(child)
    inspect(payload)
    assert observed == {"raw": 3, "rows": 3, "gallery": 3}


@pytest.mark.parametrize("builder", ["runtime", "sql"])
@pytest.mark.parametrize("order", [(11, 12), (12, 11)])
@pytest.mark.parametrize("poison", [777, "malformed cached count"])
def test_album_scrobble_response_is_actor_owned_in_both_builders(monkeypatch, builder, order, poison):
    from music_app.services import album_details, library_browse_postgres
    source = _cached_album(poison)
    before = deepcopy(source)
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "fixture-placeholder"}
    calls = []
    def lookup(received, refs, **scope):
        assert received is config
        assert set(refs) == {REF, OTHER}
        assert scope == {"account_id": scope["account_id"], "library_id": 201,
                         "expected_track_ids": {REF: 21, OTHER: 22}, "require_active_paths": True}
        calls.append(scope["account_id"])
        return {REF: 4 if scope["account_id"] == 11 else 9, OTHER: 0}
    monkeypatch.setattr(album_details, "build_scrobbled_play_count_lookup", lookup)
    monkeypatch.setattr(album_details, "build_track_preference_overlay_lookup", lambda *_a, **_k: {})
    monkeypatch.setattr(album_details, "album_to_dict", lambda *_a, **_k: source)
    repository = library_browse_postgres.PostgresLibraryBrowseRepository(config)
    monkeypatch.setattr(repository, "_load_missing_album_rows", lambda **_k: [])
    monkeypatch.setattr(repository, "_load_album_detail_rows", lambda *_a: [{"album_id": 31, "library_id": 201, "album_metadata": {}}])
    monkeypatch.setattr(repository, "_apply_private_album_rating_overlays", lambda *_a, **_k: None)
    monkeypatch.setattr(library_browse_postgres, "_selected_artist_album_payloads", lambda *_a: [source])
    monkeypatch.setattr(library_browse_postgres, "_annotate_album_payload_problematic_tracks", lambda *_a: None)
    results = []
    for account in order:
        if builder == "sql":
            payload = repository.build_album_detail_payload("synthetic-album", account_id=account, library_id=201)
        else:
            payload = album_details.build_album_detail_payload("synthetic-album", config=config,
                account_id=account, library_id=201, inventory_library_id=201,
                library_state={"albums": [SimpleNamespace(key="synthetic-album")], "file_cache": {}})
        _assert_counts(payload, {REF: 4 if account == 11 else 9, OTHER: 0})
        results.append((payload, deepcopy(payload)))
    assert calls == list(order)
    assert source == before
    assert all(payload == frozen for payload, frozen in results)


@pytest.mark.parametrize("case", ["no-account", "no-library", "no-provenance", "foreign-provenance", "bool-account", "public", "no-config"])
def test_album_unavailable_scope_drops_every_cached_personal_count(monkeypatch, case):
    from music_app.services import album_details
    source = _cached_album("not an integer")
    before = deepcopy(source)
    calls = []
    def forbidden(*_a, **_k):
        calls.append((_a, _k))
        raise AssertionError("Unsafe Album scope attempted a personal scrobble query")
    monkeypatch.setattr(album_details, "build_scrobbled_play_count_lookup", forbidden)
    monkeypatch.setattr(album_details, "build_track_preference_overlay_lookup", lambda *_a, **_k: {})
    kwargs = {"config": {}, "account_id": 11, "library_id": 201, "inventory_library_id": 201}
    if case == "no-account": kwargs.pop("account_id")
    elif case == "no-library": kwargs.pop("library_id")
    elif case == "no-provenance": kwargs.pop("inventory_library_id")
    elif case == "foreign-provenance": kwargs["inventory_library_id"] = 202
    elif case == "bool-account": kwargs["account_id"] = True
    elif case == "public": kwargs["public_safe"] = True
    else: kwargs["config"] = None
    payload = album_details._attach_album_detail_track_rows(source, **kwargs)
    assert calls == []
    _assert_counts(payload, {REF: None, OTHER: None})
    assert source == before


def test_album_scrobble_read_failure_is_unknown_without_cache_fallback(monkeypatch):
    from music_app.services import album_details
    source = _cached_album()
    before = deepcopy(source)
    config = {}
    calls = []
    def failed(received_config, refs, **scope):
        calls.append((received_config, list(refs), scope))
        raise RuntimeError("synthetic unavailable database")
    monkeypatch.setattr(album_details, "build_scrobbled_play_count_lookup", failed)
    monkeypatch.setattr(album_details, "build_track_preference_overlay_lookup", lambda *_a, **_k: {})
    payload = album_details._attach_album_detail_track_rows(source, config=config, account_id=11,
        library_id=201, inventory_library_id=201)
    assert len(calls) == 1
    assert calls[0][0] is config
    assert set(calls[0][1]) == {REF, OTHER}
    assert calls[0][2] == {"account_id": 11, "library_id": 201,
                          "expected_track_ids": {REF: 21, OTHER: 22}, "require_active_paths": True}
    _assert_counts(payload, {REF: None, OTHER: None})
    assert source == before


@pytest.mark.parametrize("resolved", [None, 0, 4])
def test_shared_row_builder_preserves_explicit_unknown_and_known_zero(resolved):
    from music_app.services.track_rows import build_track_row_payload
    row = build_track_row_payload({"path": REF, "title": "Track", "track_scrobble_count": 777},
                                  scrobble_count_resolver=lambda _track: resolved)
    assert row["track_stats"]["scrobble_count"] is None if resolved is None else row["track_stats"]["scrobble_count"] == resolved


@pytest.mark.parametrize("scope", [
    {"account_id": None, "library_id": None},
    {"account_id": 11}, {"library_id": 201}, {"account_id": True, "library_id": 201},
    {"account_id": "11", "library_id": 201}, {"account_id": 11, "library_id": 201.0},
    {"account_id": -1, "library_id": 201}, {"expected_track_ids": {REF: 21}},
    {"require_active_paths": True},
])
def test_strict_scrobble_adapter_rejects_incomplete_invalid_scope_before_connect(scope):
    from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
    def forbidden(_url): raise AssertionError("Invalid explicit scope opened a database")
    adapter = PostgresListenHistoryAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": "fixture-placeholder"}, connect=forbidden)
    try:
        result = adapter.load_scrobbled_play_count_lookup([REF], **scope)
    except ValueError:
        return
    assert result == {}


@pytest.mark.parametrize("scope", [{"account_id": None, "library_id": None}, {"account_id": None}, {"library_id": None}])
def test_explicit_null_scope_never_becomes_legacy_wrapper_call(monkeypatch, scope):
    from music_app.services import track_stats
    def forbidden(*_a, **_k):
        raise AssertionError("Explicit null scope entered adapter or legacy fallback")
    monkeypatch.setattr(track_stats, "PostgresListenHistoryAdapter", forbidden)
    monkeypatch.setattr(track_stats, "load_listen_history", forbidden)
    with pytest.raises(ValueError):
        track_stats.build_scrobbled_play_count_lookup({}, [REF], **scope)


@pytest.mark.parametrize("available", [False, True])
def test_scoped_wrapper_never_uses_legacy_or_bootstrap_fallback(monkeypatch, available):
    from music_app.services import track_stats
    calls = []
    class Adapter:
        def __init__(self, _config): pass
        def load_scrobbled_play_count_lookup(self, refs, **scope):
            calls.append((list(refs), scope))
            return {REF: 0}
    monkeypatch.setattr(track_stats, "PostgresListenHistoryAdapter", Adapter)
    monkeypatch.setattr(track_stats, "is_listen_history_postgres_available", lambda _config: available)
    def forbidden(*_a, **_k): raise AssertionError("Scoped Album read used legacy history")
    monkeypatch.setattr(track_stats, "load_listen_history", forbidden)
    scope = {"account_id": 11, "library_id": 201, "expected_track_ids": {REF: 21}, "require_active_paths": True}
    result = track_stats.build_scrobbled_play_count_lookup({}, [REF], **scope)
    assert result == ({REF: 0} if available else {})
    assert calls == [([REF], scope)] if available else calls == []


@pytest.fixture
def scrobble_event(taste):
    """Owned real history events; cleanup remains inside the existing DB lock."""
    identifiers = []
    def seed(track, *, account=None, library=None, family="runtime_listen_history_adapter",
             status="scrobbled", key=None, source_entry_id=None, identity="track"):
        measured = family == "rendered_local_listen_session"
        with taste.connect() as connection:
            row = connection.execute("""
                insert into integration.listen_history
                  (account_id, library_id, track_id, track_key, played_at, source_family,
                   source_entry_id, scrobble_status, measurement_version, device_id, session_id,
                   measured_listened_seconds, max_measured_contiguous_seconds, last_sequence, finalized)
                values (%s,%s,%s,%s,now(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id
            """, (taste.b if account is None else account,
                  track["library_id"] if library is None else library,
                  track["id"] if identity == "track" else identity,
                  track["key"] if key is None else key, family,
                  source_entry_id or f"{taste.prefix}:{uuid4()}", status,
                  "rendered-pcm-v1" if measured else None,
                  uuid4() if measured else None, uuid4() if measured else None,
                  60 if measured else None, 60 if measured else None,
                  1 if measured else None, True if measured else None)).fetchone()
            identifiers.append(row["id"])
            return row["id"]
    try:
        yield seed
    finally:
        if not taste.database.cleanup_blocked:
            with taste.connect() as connection:
                connection.execute("delete from integration.listen_history where id=any(%s)", (identifiers,))


def _scoped_read(taste, refs, *, account=None, library=None, expected=None, active=True):
    from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
    return PostgresListenHistoryAdapter(taste.config).load_scrobbled_play_count_lookup(
        refs, account_id=taste.b if account is None else account,
        library_id=taste.l1 if library is None else library,
        expected_track_ids=expected, require_active_paths=active,
    )


@pytest.mark.parametrize("order", ["A-B", "B-A"])
def test_live_scrobble_counts_follow_actor_in_either_response_order(taste, scrobble_event, order):
    track = taste.add_track("actor-owned")
    scrobble_event(track, account=taste.a)
    for _ in range(3): scrobble_event(track, account=taste.b)
    actors = (taste.a, taste.b) if order == "A-B" else (taste.b, taste.a)
    first = None
    for account in actors:
        lookup = _scoped_read(taste, track["paths"], account=account)
        assert lookup == {track["paths"][0]: 1 if account == taste.a else 3}
        if first is None: first = (lookup, deepcopy(lookup))
    assert first[0] == first[1]


def test_live_same_logical_ref_isolated_between_libraries(taste, scrobble_event):
    key = taste.prefix + ":same-logical-ref"
    own = taste.add_track("library-one", key=key)
    other = taste.add_track("library-two", key=key, library_id=taste.l2)
    scrobble_event(own)
    for _ in range(4): scrobble_event(other)
    assert _scoped_read(taste, [key], library=taste.l1, active=False) == {key: 1}
    assert _scoped_read(taste, [key], library=taste.l2, active=False) == {key: 4}


def test_live_accepted_families_and_aliases_count_rows_without_join_multiplication(taste, scrobble_event):
    paths = [f"/fixture/{taste.prefix}/one.flac", f"/fixture/{taste.prefix}/alias.flac"]
    track = taste.add_track("aliases", paths=paths)
    common_entry = taste.prefix + ":same-id-different-family"
    scrobble_event(track, family="runtime_listen_history_adapter", key=paths[0], source_entry_id=common_entry, identity=None)
    scrobble_event(track, family="phase_6_json_file_backfill", key=paths[1], source_entry_id=common_entry, identity=None)
    scrobble_event(track, family="rendered_local_listen_session")
    scrobble_event(track, status="pending")
    scrobble_event(track, family="unsupported-provider")
    scrobble_event(track, account=taste.a)
    assert _scoped_read(taste, paths) == {path: 3 for path in paths}


@pytest.mark.parametrize("case", ["missing", "stale", "wrong-id", "ambiguous", "foreign-path-is-local-key"])
def test_live_unresolved_track_identity_is_unknown_not_zero(taste, scrobble_event, case):
    track = taste.add_track("identity")
    scrobble_event(track)
    ref = track["paths"][0]
    expected = {ref: track["id"]}
    if case == "missing":
        ref += ".missing"
        expected = {ref: track["id"]}
    elif case == "stale":
        with taste.connect() as connection:
            connection.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where track_id=%s", (track["id"],))
    elif case == "wrong-id":
        expected[ref] = taste.add_track("different-id")["id"]
    elif case == "ambiguous":
        taste.add_track("alias-collision", key=ref)
    else:
        foreign = taste.add_track("foreign", library_id=taste.l2, paths=[track["key"]])
        ref = foreign["paths"][0]
        expected = None
    assert _scoped_read(taste, [ref], expected=expected) == {}


def test_live_resolved_track_without_accepted_events_has_known_zero(taste, scrobble_event):
    track = taste.add_track("known-zero")
    scrobble_event(track, status="pending")
    ref = track["paths"][0]
    assert _scoped_read(taste, [ref, ref + ".unknown"], expected={ref: track["id"]}) == {ref: 0}


@pytest.mark.parametrize("case", ["membership-revoked", "account-inactive", "account-disabled"])
def test_live_revoked_or_inactive_actor_cannot_read_history(taste, scrobble_event, case):
    track = taste.add_track("revoked")
    scrobble_event(track)
    with taste.connect() as connection:
        if case == "membership-revoked":
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (taste.b, taste.l1))
        elif case == "account-inactive":
            connection.execute("update app.accounts set is_active=false where id=%s", (taste.b,))
        else:
            connection.execute("update app.accounts set disabled_at=now() where id=%s", (taste.b,))
    assert _scoped_read(taste, track["paths"]) == {}


def test_live_null_id_legacy_event_follows_stale_alias_to_active_requested_path(taste, scrobble_event):
    old = f"/fixture/{taste.prefix}/old.flac"
    current = f"/fixture/{taste.prefix}/current.flac"
    track = taste.add_track("historical-alias", paths=[old, current])
    scrobble_event(track, key=old, identity=None)
    with taste.connect() as connection:
        connection.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where private_path=%s", (old,))
    assert _scoped_read(taste, [current, old]) == {current: 1}


def test_live_deleted_measured_id_does_not_reattach_to_reused_key(taste, scrobble_event):
    track = taste.add_track("deleted-id")
    measured_id = scrobble_event(track, family="rendered_local_listen_session")
    scrobble_event(track, family="runtime_listen_history_adapter", key=track["paths"][0])
    with taste.connect() as connection:
        connection.execute("delete from library.local_tracks where id=%s", (track["id"],))
        assert connection.execute("select track_id from integration.listen_history where id=%s", (measured_id,)).fetchone()["track_id"] is None
    replacement = taste.add_track("replacement", key=track["key"], paths=track["paths"])
    ref = replacement["paths"][0]
    assert replacement["id"] != track["id"]
    assert _scoped_read(taste, [ref], expected={ref: replacement["id"]}) == {ref: 1}
    assert _scoped_read(taste, [ref], expected={ref: track["id"]}) == {}


def test_live_nonnull_legacy_id_wins_over_contradictory_alias(taste, scrobble_event):
    first, second = taste.add_track("alias-owner"), taste.add_track("id-owner")
    scrobble_event(second, key=first["paths"][0])
    refs = [first["paths"][0], second["paths"][0]]
    assert _scoped_read(taste, refs) == {refs[0]: 0, refs[1]: 1}


def test_live_foreign_legacy_id_never_falls_back_to_local_alias(taste, scrobble_event):
    local = taste.add_track("local-alias")
    foreign = taste.add_track("foreign-id", library_id=taste.l2)
    scrobble_event(foreign, library=taste.l1, key=local["paths"][0])
    assert _scoped_read(taste, local["paths"]) == {local["paths"][0]: 0}


@pytest.mark.parametrize("actor", ["A", "B"])
def test_live_album_route_personal_statistics_are_not_cacheable(taste, taste_app, scrobble_event, actor):
    track = taste.add_track("route-count")
    scrobble_event(track, account=taste.a)
    for _ in range(2): scrobble_event(track, account=taste.b)
    account = taste.a if actor == "A" else taste.b
    status, headers, payload = taste_app.request("GET", "/album-details", query={"album_key": taste.album_key}, account=account)
    assert status == 200
    assert headers["cache-control"] == "private, no-store"
    assert payload["album"]["track_rows"][0]["track_stats"]["scrobble_count"] == (1 if actor == "A" else 2)
