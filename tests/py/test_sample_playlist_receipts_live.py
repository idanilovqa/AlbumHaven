"""R3 receipt tests, authored before implementation; normal migrated PostgreSQL.

Every case owns its MixDatabase rows. No fixture/authority bypass and no runtime
configuration changes. Forwarding spies observe the actual owners only.
"""
from copy import deepcopy
from dataclasses import asdict, replace
from datetime import timedelta
from uuid import UUID, uuid4
import json

from psycopg.types.json import Jsonb
import pytest

from library_mix_postgres_support import mix_db, mix_urls
from music_app.services import sample_playlist as evaluator
from music_app.services import sample_playlist_sources as snapshots
from music_app.services import sample_playlist_receipts as receipts
from music_app.services import playlist_complete_sources as complete
from music_app.services import playlist_creation_sources_postgres as sources
from music_app.services import lastfm_track_popularity as provider
from music_app.services.owned_playlists import PlaylistError, CREATE, evidence_digest
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from test_sample_playlist_sources_live import manual_source

PROTOCOL = "sample_playlist_selection_v1"
METHODS = ("most_listened", "random")
TOP_KEYS = {"version", "request", "request_digest", "membership_digest", "facts",
            "facts_digest", "ranking", "ranking_digest", "result", "result_digest", "source_diagnostics"}
FACT_KEYS = {"track_id", "canonical_recording_id", "recording_evidence", "album_ref",
             "primary_artist_ref", "source_position", "disc_number", "track_number",
             "duration_seconds", "styles", "countries", "inventory_digest", "identity_evidence"}
RESULT_KEYS = {"track_ids", "entry_order", "random_order", "diagnostics", "group_counts"}


def options(method="most_listened", **changes):
    return evaluator.SampleOptions(**({"selection_basis": "per_album", "songs_per_group": 1,
        "unknown_facets": "include", "selection_method": method} | changes))


def capture(db, parent, *, key=None, method="most_listened", opts=None, order=None, context=None, constraints=None):
    return receipts.capture(db.service, context or db.context(), playlist_ref=parent["playlist_id"],
        revision=parent["revision"], options=opts or options(method), request_key=key or str(uuid4()),
        random_order=order, constraints=constraints)["data"]


def read(db, source, **kwargs):
    return receipts.read(db.service, kwargs.pop("context", db.context()),
        source_ref=source["source"]["ref"], source_revision=source["source"]["revision"], **kwargs)["data"]


def recovery(db, key, **kwargs):
    return receipts.read_capture(db.service, kwargs.pop("context", db.context()),
        request_key=key, **kwargs)["data"]


def retained(db, key):
    with db.connect() as con:
        row = con.execute("select * from app.playlist_creation_sources where ref=%s", (key,)).fetchone()
        entries = con.execute("select * from app.playlist_creation_entries where source_ref=%s order by ref", (key,)).fetchall()
    return (dict(row) if row else None), [dict(entry) for entry in entries]


def destinations(db):
    return {table: db.total(table) for table in ("playlists", "playlist_items", "playlist_operations", "playlist_library_mixes")}


def forbidden(*args, **kwargs):
    pytest.fail("Read/replay crossed a forbidden evaluation/provider/write boundary")


@pytest.fixture(autouse=True)
def no_provider(monkeypatch):
    monkeypatch.setattr(provider, "fetch_track_popularity", forbidden)
    monkeypatch.setattr(provider, "get_lastfm_track_info", forbidden)


@pytest.mark.parametrize("method", METHODS)
def test_capture_exact_order_descriptor_scope_and_non_selectable_projection(mix_db, method):
    db = mix_db
    parent = manual_source(db, (4, 1, 3, 0, 2, 5))
    key = str(uuid4())
    before = destinations(db)
    order = tuple(db.tracks[i] for i in (5, 2, 0, 3, 1, 4)) if method == "random" else None
    source = capture(db, parent, key=key, method=method, order=order)
    row, entries = retained(db, key)
    assert source["source_protocol"] == row["protocol"] == PROTOCOL
    assert source["source"] == {"kind": "playlist", "ref": key, "revision": str(row["revision"])}
    assert UUID(str(row["revision"])) != UUID(key)
    assert row["actor_account_id"] == db.owner.account_id and row["session_id"] == db.owner.session_id
    assert row["library_id"] == db.library
    assert row["expires_at"] == db.clock_time + sources.SOURCE_LIFETIME
    assert source["allowed_actions"] == {"can_read": True, "can_use_for_playlist": False, "can_play": False}
    assert source["entries_complete"] is True
    assert all(item["allowed_actions"]["can_select"] is False for item in source["entries"])
    expected = [db.tracks[i] for i in ((5, 2) if method == "random" else (0, 3))]
    assert [entry["inventory_track_ref"] for entry in source["entries"]] == [f"inventory-track:{db.library}:{i}" for i in expected]
    descriptor = row["origin_descriptor"]
    assert set(descriptor) == TOP_KEYS and type(descriptor["version"]) is int and descriptor["version"] == 1
    assert set(descriptor["request"]) == {"playlist_ref", "revision", "options", "random_order"}
    assert descriptor["request"]["playlist_ref"] == parent["playlist_id"]
    assert descriptor["request"]["revision"] == parent["revision"]
    assert descriptor["request"]["options"] == asdict(options(method))
    assert descriptor["request"]["random_order"] == (list(order) if order is not None else None)
    assert set(descriptor["result"]) == RESULT_KEYS
    assert descriptor["result"]["track_ids"] == expected
    assert descriptor["result"]["entry_order"] == [entry["entry_ref"] for entry in source["entries"]]
    assert set(descriptor["result"]["entry_order"]) == {str(entry["ref"]) for entry in entries}
    assert all(set(fact) == FACT_KEYS for fact in descriptor["facts"])
    assert all(set(fact["identity_evidence"]) == {"mapping", "asserted_recording", "asserted_track_artist"} for fact in descriptor["facts"])
    assert len(descriptor["facts"]) == 6
    assert (descriptor["ranking"] is None) == (method == "random")
    assert (descriptor["ranking_digest"] is None) == (method == "random")
    if method == "most_listened":
        assert len(descriptor["ranking"]) == 6
        assert all(set(item) == {"track_id", "mapping", "popularity"} for item in descriptor["ranking"])
    assert source["options"] == descriptor["request"]["options"]
    assert source["diagnostics"] == descriptor["result"]["diagnostics"]
    assert source["source_diagnostics"] == descriptor["source_diagnostics"]
    assert source["group_counts"] == descriptor["result"]["group_counts"]
    encoded = json.dumps(source)
    assert str(db.root_path) not in encoded
    for private in ("inventory_evidence", "inventory_digest", "identity_evidence", "private_path", "root_path", "content_signature"):
        assert private not in encoded
    assert destinations(db) == before


@pytest.mark.parametrize("method", METHODS)
@pytest.mark.parametrize("operation", ["read", "recovery", "replay"])
def test_exact_retained_result_without_evaluation_or_new_header(mix_db, monkeypatch, method, operation):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    key = str(uuid4())
    order = tuple(db.tracks[i] for i in (3, 1, 0)) if method == "random" else None
    source = capture(db, parent, key=key, method=method, order=order)
    before = retained(db, key), destinations(db)
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    monkeypatch.setattr(complete, "_header", forbidden)
    monkeypatch.setattr(snapshots.inventory, "normalize_cached_inventory_row", forbidden)
    original = snapshots.inventory.read_inventory
    calls = []
    def inventory(*args, **kwargs):
        assert kwargs["include_popularity"] is False and kwargs["lock"] is True
        calls.append(kwargs)
        return original(*args, **kwargs)
    monkeypatch.setattr(snapshots.inventory, "read_inventory", inventory)
    actual = read(db, source) if operation == "read" else recovery(db, key) if operation == "recovery" else capture(db, parent, key=key, method=method, order=order)
    assert actual == source and calls
    assert (retained(db, key), destinations(db)) == before


@pytest.mark.parametrize("change", ["quota", "basis", "unknown", "length", "order", "parent_revision", "parent"])
def test_live_same_key_changed_normalized_input_conflicts(mix_db, change):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    other = manual_source(db, (0, 1, 3)) if change == "parent" else parent
    key = str(uuid4())
    order = tuple(db.tracks[i] for i in (0, 1, 3))
    capture(db, parent, key=key, method="random", order=order)
    before = retained(db, key)
    changed = options("random", **({"songs_per_group": 2} if change == "quota" else
        {"selection_basis": "per_artist"} if change == "basis" else
        {"unknown_facets": "exclude"} if change == "unknown" else
        {"length": "up_to_3"} if change == "length" else {}))
    if change == "parent_revision":
        other = parent | {"revision": str(int(parent["revision"]) + 1)}
    with pytest.raises(PlaylistError, match="request_key_conflict"):
        capture(db, other, key=key, opts=changed, order=tuple(reversed(order)) if change == "order" else order)
    assert retained(db, key) == before


@pytest.mark.parametrize("operation", ["read", "recovery", "same_capture", "different_capture"])
def test_expired_receipt_never_renews_even_with_new_input(mix_db, operation):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    source = capture(db, parent, key=key)
    before = retained(db, key)
    db.clock_time += sources.SOURCE_LIFETIME
    with pytest.raises(PlaylistError, match="source_expired"):
        if operation == "read":
            read(db, source)
        elif operation == "recovery":
            recovery(db, key)
        else:
            capture(db, parent, key=key, opts=options(songs_per_group=2 if operation == "different_capture" else 1))
    assert retained(db, key) == before


@pytest.mark.parametrize("removed", [False, True])
@pytest.mark.parametrize("operation", ["read", "recovery"])
def test_missing_lookup_never_captures_including_after_cleanup(mix_db, monkeypatch, removed, operation):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    source = capture(db, parent, key=key) if removed else {"source": {"ref": key, "revision": str(uuid4())}}
    if removed:
        with db.connect() as con:
            con.execute("delete from app.playlist_creation_sources where ref=%s", (key,))
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    monkeypatch.setattr(complete, "_header", forbidden)
    with pytest.raises(PlaylistError, match="source_unavailable"):
        read(db, source) if operation == "read" else recovery(db, key)
    assert retained(db, key) == (None, [])


def test_explicit_capture_after_cleanup_is_new_bounded_receipt(mix_db):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    old = capture(db, parent, key=key)
    with db.connect() as con:
        con.execute("delete from app.playlist_creation_sources where ref=%s", (key,))
    new = capture(db, parent, key=key)
    assert new["source"]["ref"] == old["source"]["ref"]
    assert new["source"]["revision"] != old["source"]["revision"]


@pytest.mark.parametrize("change", ["count", "missing", "ambiguous"])
def test_historical_ranking_is_not_a_current_observation_dependency(mix_db, monkeypatch, change):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent)
    before = retained(db, source["source"]["ref"])
    with db.connect() as con:
        if change == "missing":
            con.execute("update catalog.popularity_source_slots set current_revision=null where source_entity_id=any(%s)", (list(db.source_ids.values()),))
        else:
            db.observe(con, db.tracks[1], 999999 if change == "count" else 7,
                       state="resolved" if change == "count" else "ambiguous")
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    monkeypatch.setattr(snapshots.inventory, "normalize_cached_inventory_row", forbidden)
    assert read(db, source) == source
    assert retained(db, source["source"]["ref"]) == before


@pytest.mark.parametrize("change", ["mapping_revision", "unselected_title", "unselected_duration"])
def test_current_valid_same_used_identity_allows_irrelevant_metadata_churn(mix_db, change):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent)
    with db.connect() as con:
        if change == "unselected_title":
            con.execute("update library.local_tracks set title=title || ' revised' where id=%s", (db.tracks[1],))
        elif change == "unselected_duration":
            con.execute("update library.local_tracks set duration_seconds=181 where id=%s", (db.tracks[1],))
        db.rebind_mappings(con, [db.tracks[1]])
    assert read(db, source) == source


@pytest.mark.parametrize("change", ["membership", "parent_revision", "mapping_removed", "canonical", "group", "order", "selected_title", "selected_file", "candidate_local", "restricted_duration"])
def test_dependency_change_rejects_without_reranking(mix_db, monkeypatch, change):
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    source = capture(db, parent, opts=options(length="up_to_3" if change == "restricted_duration" else None))
    with db.connect() as con:
        if change == "membership":
            con.execute("update app.playlist_items set position=99 where playlist_ref=%s and local_track_id=%s", (parent["playlist_id"], db.tracks[1]))
        elif change == "parent_revision":
            con.execute("update app.playlists set revision=revision+1 where ref=%s", (parent["playlist_id"],))
        elif change == "mapping_removed":
            con.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (db.tracks[1],))
        elif change == "canonical":
            con.execute("update library.track_popularity_mapping_versions set recording_mbid=%s where track_id=%s", (str(uuid4()), db.tracks[1]))
        elif change == "group":
            con.execute("update library.local_tracks set album_id=%s where id=%s", (db.albums[1], db.tracks[1]))
            db.rebind_mappings(con, [db.tracks[1]])
        elif change == "order":
            con.execute("update library.local_tracks set track_number=99 where id=%s", (db.tracks[1],))
            db.rebind_mappings(con, [db.tracks[1]])
        elif change == "selected_title":
            con.execute("update library.local_tracks set title=title || ' changed' where id=%s", (db.tracks[0],))
            db.rebind_mappings(con, [db.tracks[0]])
        elif change == "selected_file":
            con.execute("update library.local_track_files set content_signature='replaced' where track_id=%s", (db.tracks[0],))
            db.rebind_mappings(con, [db.tracks[0]])
        elif change == "candidate_local":
            con.execute("update library.local_track_files set scan_cache_stale=true where track_id=%s", (db.tracks[1],))
        else:
            con.execute("update library.local_tracks set duration_seconds=181 where id=%s", (db.tracks[1],))
            db.rebind_mappings(con, [db.tracks[1]])
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    with pytest.raises(PlaylistError):
        read(db, source)


@pytest.mark.parametrize("change", ["create", "track", "album", "session", "actor", "membership"])
@pytest.mark.parametrize("operation", ["read", "recovery", "replay"])
def test_current_authority_required_on_every_retained_access(mix_db, change, operation):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    source = capture(db, parent, key=key)
    constraint = None
    if change in ("track", "album"):
        constraint = lambda context: PolicyEvaluationConstraints(deployment_allowed=not (
            context.resource and context.resource.resource_kind == change))
    else:
        with db.connect() as con:
            if change == "create":
                con.execute("delete from app.capabilities where account_id=%s and capability_key=%s", (db.owner.account_id, CREATE))
            elif change == "actor":
                con.execute("update app.accounts set is_active=false where id=%s", (db.owner.account_id,))
            elif change == "membership":
                con.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (db.owner.account_id, db.library))
            else:
                db.clock_time += timedelta(days=2)
    with pytest.raises(PlaylistError):
        if operation == "read":
            read(db, source, constraints=constraint)
        elif operation == "recovery":
            recovery(db, key, constraints=constraint)
        else:
            capture(db, parent, key=key, constraints=constraint)


@pytest.mark.parametrize("scope", ["actor", "session"])
@pytest.mark.parametrize("operation", ["read", "recovery", "capture"])
def test_foreign_scope_never_discloses_receipt_or_input_conflict(mix_db, scope, operation):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    source = capture(db, parent, key=key)
    with db.connect() as con:
        actor = db.member(con)
        if scope == "session":
            con.execute("update app.account_sessions set account_id=%s where id=%s", (db.owner.account_id, actor.session_id))
            actor = replace(db.owner, session_id=actor.session_id)
    with pytest.raises(PlaylistError, match="source_unavailable"):
        if operation == "read":
            read(db, source, context=db.context(actor))
        elif operation == "recovery":
            recovery(db, key, context=db.context(actor))
        else:
            capture(db, parent, key=key, context=db.context(actor), opts=options(songs_per_group=2))


@pytest.mark.parametrize("field", ["styles", "countries"])
@pytest.mark.parametrize("value", [frozenset(), frozenset({"Rock"})])
def test_restricted_facets_are_not_silently_enabled(mix_db, field, value):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    with pytest.raises((PlaylistError, ValueError)):
        capture(db, parent, key=key, opts=options(**{field: value}))
    assert retained(db, key) == (None, [])


@pytest.mark.parametrize("method", METHODS)
def test_nonempty_parent_zero_admission_retains_empty_receipt_without_inventory_fallback(mix_db, monkeypatch, method):
    db = mix_db
    parent = manual_source(db)
    constraint = lambda context: PolicyEvaluationConstraints(deployment_allowed=not (
        context.resource and context.resource.resource_kind == "track"))
    inventory_read = snapshots.inventory.read_inventory
    monkeypatch.setattr(snapshots.inventory, "read_inventory", forbidden)
    source = capture(db, parent, method=method, order=() if method == "random" else None, constraints=constraint)
    assert source["entries"] == source["group_counts"] == source["diagnostics"] == []
    assert read(db, source, constraints=constraint) == source
    monkeypatch.setattr(snapshots.inventory, "read_inventory", inventory_read)
    with pytest.raises(PlaylistError):
        read(db, source)  # Broader candidate universe is a dependency change, not permission to refill.


@pytest.mark.parametrize("stage", ["header", "observations", "projection", "final_members", "final_clock"])
def test_failed_partial_capture_rolls_back_every_source_write(mix_db, monkeypatch, stage):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    before = destinations(db)
    if stage in ("header", "observations", "projection"):
        module, name = (complete, "_header") if stage == "header" else (sources, "_observe_page") if stage == "observations" else (sources, "project_entry")
        original = getattr(module, name)
        def after(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError("injected after actual " + stage)
        monkeypatch.setattr(module, name, after)
    else:
        original = sources._observe_page
        def after(connection, *args, **kwargs):
            value = original(connection, *args, **kwargs)
            if stage == "final_members":
                connection.execute("update app.playlist_items set position=position+99 where playlist_ref=%s", (parent["playlist_id"],))
            else:
                db.clock_time += timedelta(days=2)
            return value
        monkeypatch.setattr(sources, "_observe_page", after)
    with pytest.raises((RuntimeError, PlaylistError)):
        capture(db, parent, key=key)
    assert retained(db, key) == (None, []) and destinations(db) == before


@pytest.mark.parametrize("clock_change", ["receipt", "session"])
@pytest.mark.parametrize("operation", ["read", "recovery", "replay"])
def test_fresh_clock_after_projection_never_returns_stale_authority(mix_db, monkeypatch, clock_change, operation):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    source = capture(db, parent, key=key)
    original = sources.project_entry
    advanced = False
    def project(*args, **kwargs):
        nonlocal advanced
        value = original(*args, **kwargs)
        if not advanced:
            advanced = True
            db.clock_time += sources.SOURCE_LIFETIME if clock_change == "receipt" else timedelta(days=2)
        return value
    monkeypatch.setattr(sources, "project_entry", project)
    with pytest.raises(PlaylistError):
        read(db, source) if operation == "read" else recovery(db, key) if operation == "recovery" else capture(db, parent, key=key)
    assert advanced


def test_capture_shares_one_actual_authorized_connection_with_source_and_persistence(mix_db, monkeypatch):
    from contextlib import contextmanager
    db = mix_db
    parent = manual_source(db)
    connections, calls = [], []
    original = db.service._authorized
    @contextmanager
    def authorized(*args, **kwargs):
        with original(*args, **kwargs) as value:
            connections.append(value[0])
            yield value
    monkeypatch.setattr(db.service, "_authorized", authorized)
    for module, name in ((complete, "_header"), (sources, "_observe_page"),
                         (sources, "selected_entries"), (snapshots.inventory, "read_inventory")):
        original_function = getattr(module, name)
        def forward(connection, *args, _real=original_function, _name=name, **kwargs):
            calls.append((_name, connection))
            return _real(connection, *args, **kwargs)
        monkeypatch.setattr(module, name, forward)
    capture(db, parent)
    assert len(connections) == 1
    assert {name for name, _ in calls} == {"_header", "_observe_page", "selected_entries", "read_inventory"}
    assert all(connection is connections[0] for _, connection in calls)


def test_commit_boundary_failure_returns_no_acknowledged_or_partial_receipt(mix_db, monkeypatch):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    connect = db.service._connect
    class RollbackAtCommit:
        def __init__(self, url): self.connection = connect(url)
        def __enter__(self): return self.connection.__enter__()
        def __exit__(self, kind, value, traceback):
            if kind is not None:
                return self.connection.__exit__(kind, value, traceback)
            error = RuntimeError("injected commit-boundary failure")
            self.connection.__exit__(RuntimeError, error, None)
            raise error
    monkeypatch.setattr(db.service, "_connect", RollbackAtCommit)
    with pytest.raises(RuntimeError, match="commit-boundary failure"):
        capture(db, parent, key=key)
    assert retained(db, key) == (None, [])


def test_random_capture_never_reads_observation_fields_or_invokes_popularity_normalizer(mix_db, monkeypatch):
    from test_sample_playlist_source_facts import OBSERVATION_KEYS
    db = mix_db
    parent = manual_source(db, (0, 1, 3))
    original = snapshots.inventory.read_inventory
    seen = []
    def inventory(*args, **kwargs):
        assert kwargs["include_popularity"] is False
        rows = original(*args, **kwargs)
        assert all(OBSERVATION_KEYS.isdisjoint(row) for row in rows)
        seen.extend(rows)
        return rows
    monkeypatch.setattr(snapshots.inventory, "read_inventory", inventory)
    monkeypatch.setattr(snapshots.inventory, "normalize_cached_inventory_row", forbidden)
    source = capture(db, parent, method="random", order=tuple(db.tracks[i] for i in (3, 1, 0)))
    descriptor = retained(db, source["source"]["ref"])[0]["origin_descriptor"]
    assert seen and descriptor["ranking"] is descriptor["ranking_digest"] is None


def test_most_listened_validation_does_not_gain_random_asserted_artist_fallback(mix_db):
    db = mix_db
    track = db.tracks[0]
    with db.connect() as con:
        con.execute("update library.local_albums set metadata=metadata || '{\"is_compilation\":true}'::jsonb where id=%s", (db.albums[0],))
        db.rebind_mappings(con, [track])
    source = capture(db, manual_source(db, (0,)), opts=options(selection_basis="per_artist"))
    with db.connect() as con:
        con.execute("update library.local_artists set mbid=%s,mbid_assertion_state='asserted',evidence_source='owner-verified' where id=(select artist_id from library.local_tracks where id=%s)", (db.artist_mbids[0], track))
        db.rebind_mappings(con, [track])
        con.execute("update library.track_popularity_mapping_versions set artist_mbid=null where track_id=%s", (track,))
    with pytest.raises(PlaylistError):
        read(db, source)
