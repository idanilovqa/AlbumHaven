"""Explicit Country action, finite acquisition, real authority and fenced CAS.

These tests are authored only. Network is replaced at get_artist_json; SQL,
source admission, identity, policy and commit owners remain production code.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from datetime import timedelta
from threading import Event
import pytest
from psycopg.types.json import Jsonb
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services.owned_playlists import BROWSE, CREATE, PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from sample_facet_support import (
    ABSENT, KEY, REFRESH, TRIM, acquisition, country, digest, discover, encoded,
    enrich, envelope, grant_refresh, identity_document, manual_source, primary_row,
    selector, set_country, strict_result, target, transaction_spy, sql_probe,
)


@pytest.mark.parametrize("raw", [ABSENT, None, "", TRIM, " GB ", "us", "US/CA", "\ue000", "\U00010000"])
def test_explicit_exact_artist_acquisition_writes_only_independent_structured_evidence(mix_db, monkeypatch, raw):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    row = primary_row(db)
    with db.connect() as con:
        con.execute("update library.local_artists set metadata=metadata||%s where library_id=%s and id=%s",
            (Jsonb({"unrelated": {"must": ["survive"]}}), db.library, row["id"]))
    calls = acquisition(monkeypatch, lambda mbid, n, cancel: strict_result(mbid, raw))
    with transaction_spy(monkeypatch, db) as (active, transactions):
        original = calls
        def network(mbid, n, cancel):
            assert active == [], "No authority/inventory/advisory lock may span provider I/O"
            assert callable(cancel)
            return strict_result(mbid, raw)
        calls = acquisition(monkeypatch, network)
        result = enrich(db, parent)
    actual = country(db); expected = envelope(db, raw)
    from uuid import UUID
    assert str(UUID(actual["envelope_revision"])) == actual["envelope_revision"]
    assert actual["captured_at"] == db.clock_time.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    for field in ("envelope_revision", "captured_at"):
        expected[field] = actual[field]
    assert actual == expected
    assert len(encoded(actual)) <= 8192
    assert result == [{**target(db), "status": "stored_known" if expected["state"] == "known" else "stored_unknown"}]
    assert len(calls) == 1 and calls[0][0] == db.artist_mbids[0] and len(transactions) >= 3
    assert primary_row(db)["metadata"]["unrelated"] == {"must": ["survive"]}


@pytest.mark.parametrize("missing", [REFRESH, BROWSE, CREATE])
def test_each_of_three_live_permissions_is_required_before_any_acquisition(mix_db, monkeypatch, missing):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    constraints = None
    if missing == CREATE:
        # Browse also grants personal Create; isolate the effective action.
        constraints = lambda ctx: PolicyEvaluationConstraints(deployment_allowed=ctx.action != CREATE)
    else:
        with db.connect() as con:
            con.execute("delete from app.capabilities where account_id=%s and capability_key=%s",
                (db.owner.account_id, missing))
    calls = acquisition(monkeypatch)
    with pytest.raises(PlaylistError, match="forbidden"):
        enrich(db, parent, constraints=constraints)
    assert calls == [] and KEY not in primary_row(db)["metadata"]


@pytest.mark.parametrize("bad", [None, {}, {"version": True}, {"oversized": "x" * 8193}])
def test_initial_mixed_validity_batch_rejects_all_targets_before_any_network_or_write(mix_db, monkeypatch, bad):
    db = mix_db; parent = manual_source(db, (0, 3)); grant_refresh(db)
    valid = envelope(db, "GB"); set_country(db, valid); set_country(db, bad, index=3)
    calls = acquisition(monkeypatch)
    with pytest.raises(PlaylistError, match="source_unavailable") as error:
        enrich(db, parent, [target(db), target(db, 3)])
    assert error.value.status_code == 404
    assert calls == [] and country(db) == valid and country(db, 3) == bad


@pytest.mark.parametrize("phase", ["before_lookup", "after_lookup"])
@pytest.mark.parametrize("bad", [None, {}, {"oversized": "x" * 8193}])
def test_later_invalid_envelope_is_per_target_unresolved_and_preserves_earlier_commit(mix_db, monkeypatch, phase, bad):
    db = mix_db; parent = manual_source(db, (0, 3)); grant_refresh(db)
    def network(mbid, count, cancel):
        if (phase == "before_lookup" and count == 1) or (phase == "after_lookup" and count == 2):
            set_country(db, bad, index=3)
        return strict_result(mbid, "GB")
    calls = acquisition(monkeypatch, network)
    results = enrich(db, parent, [target(db), target(db, 3)])
    assert [r["status"] for r in results] == ["stored_known", "unresolved"]
    assert len(calls) == (1 if phase == "before_lookup" else 2)
    assert country(db)["state"] == "known" and country(db, 3) == bad


@pytest.mark.parametrize("result", [
    (None, {"status": "blocked"}), (None, {"status": "cached_miss"}),
    ({"id": "00000000-0000-4000-8000-000000000000", "country": "GB"},
        {"status": "network", "evidence_policy": "musicbrainz-artist-v1"}),
    ({"country": "GB"}, {"status": "network", "evidence_policy": "musicbrainz-artist-v1"}),
])
def test_failed_or_mismatched_acquisition_cannot_replace_valid_envelope_with_unknown(mix_db, monkeypatch, result):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    old = envelope(db, "DE"); set_country(db, old)
    calls = acquisition(monkeypatch, lambda *a: deepcopy(result))
    assert enrich(db, parent)[0]["status"] == "unresolved"
    assert country(db) == old and len(calls) == 1


@pytest.mark.parametrize("value", [False, 4, [], {}, ["GB"], "\ud800", "x" * 1025, "é" * 513, "\x01" * 1024])
def test_malformed_provider_country_is_unresolved_not_provider_omission(mix_db, monkeypatch, value):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    acquisition(monkeypatch, lambda mbid, *_: strict_result(mbid, value))
    assert enrich(db, parent)[0]["status"] == "unresolved"
    assert KEY not in primary_row(db)["metadata"]


def test_area_disambiguation_release_and_featured_fields_are_never_country_fallback(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    def network(mbid, *_):
        payload, meta = strict_result(mbid)
        payload.update({"area": {"iso-3166-1-codes": ["US"]}, "disambiguation": "British artist",
            "release-country": "DE", "artist-credit": [{"artist": {"country": "FR"}}]})
        return payload, meta
    acquisition(monkeypatch, network)
    assert enrich(db, parent)[0]["status"] == "stored_unknown"
    assert country(db)["country_field"] == {"presence": "absent", "value": None}


@pytest.mark.parametrize("new_raw,returned_raw,expected", [
    ("DE", "GB", "concurrent_change"), (" GB ", "GB", "concurrent_change"),
    ("GB", "GB", "unchanged")])
def test_newer_whole_envelope_cas_wins_even_when_identity_or_country_token_matches(mix_db, monkeypatch, new_raw, returned_raw, expected):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    original = envelope(db, "FR"); set_country(db, original); newer = envelope(db, new_raw)
    def network(mbid, *_):
        set_country(db, newer)
        return strict_result(mbid, returned_raw)
    acquisition(monkeypatch, network)
    assert enrich(db, parent)[0]["status"] == expected
    assert country(db) == newer


@pytest.mark.parametrize("fence", ["membership", "artist", "refresh", "create", "browse", "session", "cancel", "none"])
@pytest.mark.parametrize("branch", ["write", "identical_noop"])
def test_write_and_identical_evidence_pending_noop_complete_every_final_fence(mix_db, monkeypatch, fence, branch):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    newer = envelope(db, "GB"); reached = {"upgrade": False}; writes = []
    def network(mbid, *_):
        if branch == "identical_noop":
            set_country(db, newer)
        return strict_result(mbid, "GB")
    acquisition(monkeypatch, network)
    def after(con, event):
        sql = event["sql"]
        if "update library.local_artists" in sql:
            writes.append(event)
        if "library.local_artists" in sql and "for update nowait" in sql:
            reached["upgrade"] = True
            if fence == "membership":
                con.execute("update app.playlists set revision=revision+1 where ref=%s", (parent["playlist_id"],))
            elif fence == "session":
                db.clock_time += timedelta(days=2)
    denied_actions = {"refresh": REFRESH, "create": CREATE, "browse": BROWSE}
    checks_after_upgrade = []
    def constraints(ctx):
        if reached["upgrade"]:
            checks_after_upgrade.append((ctx.action, ctx.resource))
        denied = reached["upgrade"] and (ctx.action == denied_actions.get(fence) or
            fence == "artist" and ctx.resource and ctx.resource.resource_kind == "artist")
        return PolicyEvaluationConstraints(deployment_allowed=not denied)
    with sql_probe(monkeypatch, db, after=after) as statements:
        if fence in ("none", "cancel"):
            result = enrich(db, parent, constraints=constraints,
                should_cancel=lambda: reached["upgrade"] and fence == "cancel")
            assert result[0]["status"] == ("cancelled" if fence == "cancel" else
                "unchanged" if branch == "identical_noop" else "stored_known")
        else:
            with pytest.raises(PlaylistError) as error:
                enrich(db, parent, constraints=constraints)
            assert error.value.code in {"source_changed", "source_unavailable", "forbidden", "revision_conflict"}
    assert reached["upgrade"]
    if branch == "identical_noop":
        assert writes == [] and country(db) == newer
    elif fence == "none":
        assert len(writes) == 1 and country(db)["country_token"] == "GB"
    else:
        assert writes == [] and KEY not in primary_row(db)["metadata"]
    if fence == "none":
        assert {REFRESH, CREATE, BROWSE} <= {a for a, _ in checks_after_upgrade}
        assert any(r and r.resource_kind == "artist" for _, r in checks_after_upgrade)
        upgraded = next(i for i, event in enumerate(statements) if "for update nowait" in event["sql"])
        connection = statements[upgraded]["connection"]
        assert any(event["connection"] is connection and "app.account_sessions" in event["sql"]
            for event in statements[upgraded + 1:]), "Successful target skipped final same-connection session fence"


@pytest.mark.parametrize("when", ["before_start", "after_response", "second_response"])
def test_cancel_has_finite_ordered_statuses_and_never_undoes_committed_target(mix_db, monkeypatch, when):
    db = mix_db; parent = manual_source(db, (0, 3)); grant_refresh(db)
    cancelled = when == "before_start"
    def network(mbid, count, cancel):
        nonlocal cancelled
        if when == "after_response" or when == "second_response" and count == 2:
            cancelled = True
        return strict_result(mbid, "GB")
    calls = acquisition(monkeypatch, network)
    result = enrich(db, parent, [target(db), target(db, 3)], should_cancel=lambda: cancelled)
    expected = ["stored_known", "cancelled"] if when == "second_response" else ["cancelled", "not_attempted"]
    assert [r["status"] for r in result] == expected
    assert len(calls) == {"before_start": 0, "after_response": 1, "second_response": 2}[when]
    assert (KEY in primary_row(db)["metadata"]) is (when == "second_response")
    assert KEY not in primary_row(db, 3)["metadata"]


def test_source_identity_change_during_network_discards_result(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    old_artist = primary_row(db)["id"]
    def network(mbid, *_):
        with db.connect() as con:
            con.execute("update library.local_albums set artist_id=%s where library_id=%s and id=%s",
                (primary_row(db, 3)["id"], db.library, db.albums[0]))
        return strict_result(mbid, "GB")
    acquisition(monkeypatch, network)
    assert enrich(db, parent)[0]["status"] == "source_changed"
    assert KEY not in primary_row(db)["metadata"]
    with db.connect() as con:
        assert KEY not in con.execute("select metadata from library.local_artists where library_id=%s and id=%s",
            (db.library, old_artist)).fetchone()["metadata"]


def test_mid_batch_refresh_revocation_stops_without_disclosing_remaining_targets(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0, 3)); grant_refresh(db)
    def network(mbid, count, _):
        if count == 2:
            with db.connect() as con:
                con.execute("delete from app.capabilities where account_id=%s and capability_key=%s",
                    (db.owner.account_id, REFRESH))
        return strict_result(mbid, "GB")
    calls = acquisition(monkeypatch, network)
    with pytest.raises(PlaylistError, match="forbidden"):
        enrich(db, parent, [target(db), target(db, 3)])
    assert len(calls) == 2 and country(db)["state"] == "known"
    assert KEY not in primary_row(db, 3)["metadata"]


def test_post_write_session_expiry_rolls_back_target_not_reported_stored(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db); acquisition(monkeypatch)
    written = []
    def after(con, event):
        if event["sql"].startswith("update library.local_artists"):
            written.append(con)
            db.clock_time += timedelta(days=2)
    with sql_probe(monkeypatch, db, after=after) as log:
        with pytest.raises(PlaylistError, match="forbidden"):
            enrich(db, parent)
    assert len(written) == 1 and KEY not in primary_row(db)["metadata"]
    write_index = next(i for i, row in enumerate(log) if row["sql"].startswith("update library.local_artists"))
    assert any(row["connection"] is written[0] and "app.account_sessions" in row["sql"]
        for row in log[write_index + 1:])


@pytest.mark.parametrize("change", ["row_mbid", "assertion_state", "evidence_source", "display_only"])
def test_identity_or_generic_source_change_during_network_preserves_old_envelope(mix_db, monkeypatch, change):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    artist = primary_row(db)["id"]; old = envelope(db, "FR"); set_country(db, old)
    def network(mbid, *_):
        statements = {
            "row_mbid": ("mbid=%s", db.artist_mbids[1]),
            "assertion_state": ("mbid_assertion_state=%s", "conflicting"),
            "evidence_source": ("evidence_source=%s", "fixture:changed"),
            "display_only": ("name=%s", "Renamed display only"),
        }
        assignment, value = statements[change]
        with db.connect() as con:
            con.execute(f"update library.local_artists set {assignment} where library_id=%s and id=%s",
                (value, db.library, artist))
        return strict_result(mbid, "GB")
    acquisition(monkeypatch, network)
    result = enrich(db, parent)
    # Display text is not local identity, but remains in the unchanged generic
    # inventory revision and therefore in the full association proof.
    assert result[0]["status"] == "source_changed"
    assert country(db) == old


def test_local_identity_document_and_digest_exclude_display_text(mix_db):
    db = mix_db; before = identity_document(db)
    with db.connect() as con:
        con.execute("update library.local_artists set name=%s where library_id=%s and id=%s",
            ("Renamed display only", db.library, primary_row(db)["id"]))
    assert identity_document(db) == before
    assert digest(identity_document(db)) == digest(before)


def test_cancellation_after_first_real_commit_stops_before_second_acquisition(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0, 3)); grant_refresh(db)
    calls = acquisition(monkeypatch); original = db.service._authorized
    cancelled = False; committed = []
    @contextmanager
    def observed(*args, **kwargs):
        nonlocal cancelled
        # This callback occurs after the real transaction context has exited,
        # not after UPDATE and not inside target two's provider callback.
        with original(*args, **kwargs) as value:
            yield value
        if len(calls) == 1 and not committed:
            current = country(db)
            if isinstance(current, dict) and current.get("country_token") == "GB":
                committed.append(current)
                cancelled = True
    monkeypatch.setattr(db.service, "_authorized", observed)
    results = enrich(db, parent, [target(db), target(db, 3)], should_cancel=lambda: cancelled)
    assert [row["status"] for row in results] == ["stored_known", "cancelled"]
    assert len(calls) == 1 and len(committed) == 1
    assert country(db) == committed[0]
    assert KEY not in primary_row(db, 3)["metadata"]


def test_metadata_changed_by_another_owner_during_network_is_preserved_by_key_only_merge(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db); artist = primary_row(db)["id"]
    def network(mbid, *_):
        with db.connect() as con:
            con.execute("update library.local_artists set metadata=metadata||%s where library_id=%s and id=%s",
                (Jsonb({"other_owner": {"generation": 2, "items": [1, 2]}}), db.library, artist))
        return strict_result(mbid, "GB")
    acquisition(monkeypatch, network)
    assert enrich(db, parent)[0]["status"] == "stored_known"
    assert primary_row(db)["metadata"]["other_owner"] == {"generation": 2, "items": [1, 2]}


# R4 / B5: build the producer boundary with PostgreSQL's representation, not
# an imitation of its spacing. The independent envelope has identical widths
# for UUID/digest/timestamp fields regardless of their eventual fresh values.
@pytest.mark.parametrize("server_size", [8192, 8193, None], ids=["jsonb-8192", "jsonb-8193", "nul"])
def test_producer_cannot_store_an_envelope_its_reader_rejects(mix_db, monkeypatch, server_size):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    old = envelope(db, "DE"); set_country(db, old)
    with db.connect() as con:
        con.execute("update library.local_artists set metadata=metadata||%s where library_id=%s and id=%s",
            (Jsonb({"unrelated": {"keep": [1, "exact"]}}), db.library, primary_row(db)["id"]))
        if server_size is None:
            raw = "GB\x00"
        else:
            base = "\x01" * 600
            size = con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(envelope(db, base)),)).fetchone()["n"]
            gap = server_size - size
            assert 0 <= gap < 800
            # ASCII padding appears in raw and token; trailing trim-space appears
            # in raw only, permitting either exact odd/even server boundary.
            raw = base + "x" * (gap // 2) + (" " if gap % 2 else "")
            proposed = envelope(db, raw)
            assert con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(proposed),)).fetchone()["n"] == server_size
            assert len(raw.encode("utf-8")) <= 1024 and len(encoded(proposed)) <= 8192
    before = deepcopy(primary_row(db)["metadata"])
    with transaction_spy(monkeypatch, db) as (active, transactions):
        def network(mbid, *_):
            assert active == []
            return strict_result(mbid, raw)
        calls = acquisition(monkeypatch, network)
        with sql_probe(monkeypatch, db) as events:
            result = enrich(db, parent)
    updates = [event for event in events if event["sql"].startswith("update library.local_artists")]
    assert len(calls) == 1 and len(transactions) >= 3
    if server_size == 8192:
        assert result == [{**target(db), "status": "stored_known"}] and len(updates) == 1
        actual = country(db)
        assert actual["country_field"]["value"] == raw and actual["country_token"] == raw.strip(TRIM)
        with db.connect() as con:
            stored_size = con.execute("select octet_length((metadata->%s)::text) as n from library.local_artists where library_id=%s and id=%s",
                (KEY, db.library, primary_row(db)["id"])).fetchone()["n"]
        assert stored_size == 8192
        read = discover(db, parent, ("countries",))["facets"]["countries"]
        assert read["status"] == "ready" and read["error"] is None
        assert read["choices"] == [{"identity": "musicbrainz-country:" + raw.strip(TRIM), "label": raw.strip(TRIM)}]
        assert read["coverage"] == {"candidate_count": 1, "known": 1, "unknown": 0, "unresolved": 0}
        assert primary_row(db)["metadata"]["unrelated"] == before["unrelated"]
    else:
        assert result == [{**target(db), "status": "unresolved"}] and updates == []
        assert primary_row(db)["metadata"] == before and country(db) == old


def _failed_artist_response(kind, mbid):
    if kind == "failed":
        return None, {"status": "blocked"}
    if kind == "malformed":
        return strict_result(mbid, {"not": "a scalar"})
    assert kind == "mismatched"
    payload, meta = strict_result(mbid, "GB")
    payload["id"] = "00000000-0000-4000-8000-000000000000"
    assert payload["id"] != mbid
    return payload, meta


@pytest.mark.parametrize("failure", ["failed", "malformed", "mismatched"])
def test_failed_final_response_with_current_authority_still_enters_fresh_transaction(mix_db, monkeypatch, failure):
    db = mix_db; parent = manual_source(db, (0, 3)); grant_refresh(db)
    old = envelope(db, "DE", index=3); set_country(db, old, index=3)
    post_network = []; committed = []
    with transaction_spy(monkeypatch, db) as (active, transactions):
        def network(mbid, count, cancel):
            assert active == []
            if count == 1:
                return strict_result(mbid, "GB")
            committed.append(country(db)); assert committed[0]["country_token"] == "GB"
            post_network.append(len(transactions))
            return _failed_artist_response(failure, mbid)
        calls = acquisition(monkeypatch, network)
        with sql_probe(monkeypatch, db) as events:
            result = enrich(db, parent, [target(db), target(db, 3)])
        assert len(transactions) > post_network[0], "Failed result bypassed the fresh global-authority owner"
    assert result == [{**target(db), "status": "stored_known"}, {**target(db, 3), "status": "unresolved"}]
    assert [call[0] for call in calls] == db.artist_mbids
    assert country(db) == committed[0] and country(db, 3) == old
    assert len([event for event in events if event["sql"].startswith("update library.local_artists")]) == 1


@pytest.mark.parametrize("failure", ["failed", "malformed", "mismatched"])
@pytest.mark.parametrize("cancel_at", [1, 2])
def test_cancelled_failed_response_preserves_prior_commit_and_never_acquires_next(mix_db, monkeypatch, failure, cancel_at):
    db = mix_db; parent = manual_source(db, (0, 3)); grant_refresh(db)
    cancelled = False; committed = []
    with transaction_spy(monkeypatch, db) as (active, transactions):
        def network(mbid, count, cancel):
            nonlocal cancelled
            assert active == [] and count <= cancel_at
            if count < cancel_at:
                return strict_result(mbid, "GB")
            if count == 2:
                committed.append(country(db)); assert committed[0]["country_token"] == "GB"
            cancelled = True
            return _failed_artist_response(failure, mbid)
        calls = acquisition(monkeypatch, network)
        with sql_probe(monkeypatch, db) as events:
            result = enrich(db, parent, [target(db), target(db, 3)], should_cancel=lambda: cancelled)
    expected = ["cancelled", "not_attempted"] if cancel_at == 1 else ["stored_known", "cancelled"]
    assert result == [{**target(db), "status": expected[0]}, {**target(db, 3), "status": expected[1]}]
    assert len(calls) == cancel_at
    assert len([event for event in events if event["sql"].startswith("update library.local_artists")]) == cancel_at - 1
    if cancel_at == 2:
        assert country(db) == committed[0]
    else:
        assert KEY not in primary_row(db)["metadata"]
    assert KEY not in primary_row(db, 3)["metadata"]
