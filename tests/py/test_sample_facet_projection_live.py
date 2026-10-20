"""Authoritative facets through the new public read-only service, with real SQL."""
from copy import deepcopy
import pytest
from psycopg.types.json import Jsonb
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from sample_facet_support import (
    ABSENT, KEY, TRIM, manual_source, discover, grant_refresh, target,
    set_genre, set_country, envelope, add_copy, generic_evidence, forbid_provider, sql_probe,
)


@pytest.fixture(autouse=True)
def no_acquisition(monkeypatch):
    forbid_provider(monkeypatch)


def assert_facet(value, *, choices=(), count=1, known=0, unknown=0, unresolved=0, targets=()):
    assert value == {"status": "ready",
        "choices": [{"identity": identity, "label": label} for identity, label in choices],
        "coverage": {"candidate_count": count, "known": known, "unknown": unknown, "unresolved": unresolved},
        "error": None, "enrichment_targets": list(targets)}


@pytest.mark.parametrize("genre", [ABSENT, None, "", TRIM])
def test_valid_scalar_omission_is_unknown_not_unresolved(mix_db, genre):
    db = mix_db; parent = manual_source(db, (0,)); set_genre(db, genre)
    value = discover(db, parent, ("styles",))
    assert value["allowed_actions"] == {"enrich_country": False}
    assert_facet(value["facets"]["styles"], unknown=1)


@pytest.mark.parametrize("genre", [False, 1, [], {}, ["Rock"]])
def test_nonstring_genre_makes_whole_candidate_unresolved_even_with_known_copy(mix_db, genre):
    db = mix_db; parent = manual_source(db, (0,)); set_genre(db, "Rock")
    add_copy(db, genre=genre)
    assert_facet(discover(db, parent, ("styles",))["facets"]["styles"], unresolved=1)


@pytest.mark.parametrize("cache", [None, [], "bad", {"file_entry": None}, {"file_entry": []}])
def test_malformed_enclosing_scan_cache_is_unresolved_not_omission(mix_db, cache):
    db = mix_db; parent = manual_source(db, (0,))
    with db.connect() as con:
        con.execute("update library.local_track_files set metadata=%s where track_id=%s",
            (Jsonb({"scan_cache": cache}), db.tracks[0]))
    assert_facet(discover(db, parent, ("styles",), method="random")["facets"]["styles"], unresolved=1)


def test_exact_multicopy_union_preserves_case_punctuation_unicode_and_scalar_order(mix_db):
    db = mix_db; parent = manual_source(db, (0,))
    labels = ["Rock; Jazz/Metal, Prog", "rock", "\ue000", "\U00010000", "Été:Live", "\ufeffRock"]
    set_genre(db, TRIM + labels[0] + TRIM)
    for label in labels[1:] + [labels[0]]:
        add_copy(db, genre=label)
    result = discover(db, parent, ("styles",))["facets"]["styles"]
    assert_facet(result, choices=[("genre-tag:" + x, x) for x in sorted(labels)], known=1)


def test_stale_and_inactive_copies_never_supply_style_values(mix_db):
    db = mix_db; parent = manual_source(db, (0,)); set_genre(db, "Rock")
    add_copy(db, genre="Never stale", stale=True)
    with db.connect() as con:
        root = con.execute("""insert into library.library_roots(library_id,root_path,is_active,metadata)
            values(%s,%s,false,'{}') returning id""", (db.library, str(db.root_path / "inactive"))).fetchone()["id"]
    add_copy(db, genre="Never inactive", root=root)
    assert_facet(discover(db, parent, ("styles",))["facets"]["styles"],
        choices=[("genre-tag:Rock", "Rock")], known=1)


def test_genre_only_change_never_invalidates_generic_inventory_or_popularity_mapping(mix_db):
    db = mix_db; parent = manual_source(db, (0,)); before = generic_evidence(db)
    set_genre(db, "Rock")
    assert generic_evidence(db) == before
    discover(db, parent, ("styles",))
    set_genre(db, "Jazz")
    assert generic_evidence(db) == before


@pytest.mark.parametrize("value", [ABSENT, None, "", TRIM, " GB ", "xY", "US/CA", "\ufeffGB\ufeff"])
def test_country_uses_structured_envelope_value_without_remapping(mix_db, value):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    stored = envelope(db, value); set_country(db, stored)
    result = discover(db, parent, ("countries",))
    token = stored["country_token"]
    assert result["allowed_actions"] == {"enrich_country": True}
    assert_facet(result["facets"]["countries"],
        choices=[("musicbrainz-country:" + token, token)] if token else [],
        known=int(bool(token)), unknown=int(not token), targets=[target(db)])


def test_absent_key_is_unresolved_and_eligible_but_json_null_is_unresolved_and_not_offered(mix_db):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    assert_facet(discover(db, parent, ("countries",))["facets"]["countries"],
        unresolved=1, targets=[target(db)])
    set_country(db, None)
    assert_facet(discover(db, parent, ("countries",))["facets"]["countries"], unresolved=1)


@pytest.mark.parametrize("field,value", [
    ("version", True), ("version", 2), ("provider", "other"), ("entity_kind", "release"),
    ("library_id", "01"), ("local_artist_id", 1), ("local_artist_id", "9223372036854775808"),
    ("canonical_artist_mbid", "00000000-0000-4000-8000-000000000000"),
    ("envelope_revision", "ABCDEF00-0000-4000-8000-000000000000"),
    ("identity_basis_digest", "0" * 64), ("evidence_digest", "f" * 64),
    ("state", "known"), ("country_token", "GB"), ("unknown_reason", None),
    ("captured_at", "2026-02-30T00:00:00.000001Z"), ("captured_at", "2026-10-01T00:00:00Z"),
    ("captured_at", "2026-10-01T00:00:00.000001+00:00"), ("evidence_policy", "release-group-v1"),
    ("country_field", {"presence": "absent", "value": "GB"}), ("extra", "no"),
])
def test_malformed_closed_country_envelope_is_not_known_or_refresh_eligible(mix_db, field, value):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    stored = envelope(db); stored[field] = value; set_country(db, stored)
    assert_facet(discover(db, parent, ("countries",))["facets"]["countries"], unresolved=1)


@pytest.mark.parametrize("missing", ["version", "envelope_revision", "provider", "entity_kind",
    "library_id", "local_artist_id", "canonical_artist_mbid", "identity_basis_digest", "state",
    "country_token", "unknown_reason", "country_field", "captured_at", "evidence_policy", "evidence_digest"])
def test_no_envelope_field_is_defaulted_when_missing(mix_db, missing):
    db = mix_db; parent = manual_source(db, (0,)); grant_refresh(db)
    stored = envelope(db, "GB"); del stored[missing]; set_country(db, stored)
    assert_facet(discover(db, parent, ("countries",))["facets"]["countries"], unresolved=1)


def test_country_admission_happens_before_metadata_read_and_denied_identity_is_not_exposed(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0,)); set_country(db, envelope(db, "secret"))
    def deny(ctx):
        return PolicyEvaluationConstraints(deployment_allowed=not (
            ctx.resource and ctx.resource.resource_kind == "artist"))
    with sql_probe(monkeypatch, db) as statements:
        result = discover(db, parent, ("countries",), constraints=deny)
    assert_facet(result["facets"]["countries"], unresolved=1)
    assert "secret" not in str(result)
    assert not any(KEY in event["sql"] for event in statements), "Denied row Country JSON was read before admission"


def test_complete_source_coverage_and_lowest_numeric_track_representative_per_local_row(mix_db):
    db = mix_db; parent = manual_source(db, (4, 1, 3, 0, 2, 5)); grant_refresh(db)
    set_genre(db, "Rock", indexes=(0, 3)); set_country(db, envelope(db, "GB"))
    set_country(db, envelope(db, None, index=3), index=3)
    value = discover(db, parent)
    assert_facet(value["facets"]["styles"], choices=[("genre-tag:Rock", "Rock")],
        count=6, known=2, unknown=4)
    assert_facet(value["facets"]["countries"], choices=[("musicbrainz-country:GB", "GB")],
        count=6, known=3, unknown=3, targets=[target(db, 0), target(db, 3)])


def test_denied_enrichment_hint_does_not_hide_existing_browse_authorized_choices(mix_db):
    db = mix_db; parent = manual_source(db, (0,)); set_country(db, envelope(db, "GB"))
    result = discover(db, parent, ("countries",))
    assert result["allowed_actions"] == {"enrich_country": False}
    assert_facet(result["facets"]["countries"], choices=[("musicbrainz-country:GB", "GB")], known=1)


@pytest.mark.parametrize("kind,expected", [("ordinary", "GB"), ("compilation", "DE"), ("no_album", "DE")])
def test_country_binds_actual_primary_fk_not_featured_track_or_same_name_artist(mix_db, kind, expected):
    from sample_facet_support import primary_row
    db = mix_db; parent = manual_source(db, (0,))
    set_country(db, envelope(db, "GB")); set_country(db, envelope(db, "DE", index=3), index=3)
    second = primary_row(db, 3)["id"]
    with db.connect() as con:
        # Existing canonical assertion provenance is explicit setup evidence;
        # display equality has no bearing on the selected truthful local row.
        con.execute("update library.local_artists set name='Same display name' where library_id=%s", (db.library,))
        con.execute("""update library.local_tracks set artist_id=%s,mbid=%s,
            mbid_assertion_state='asserted',evidence_source='fixture:exact' where library_id=%s and id=%s""",
            (second, db.recordings[db.tracks[0]], db.library, db.tracks[0]))
        con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
            '{scan_cache,file_entry,musicbrainz_artist_ids}',%s) where track_id=%s""",
            (Jsonb([db.artist_mbids[1]]), db.tracks[0]))
        if kind == "compilation":
            con.execute("""update library.local_albums set metadata=metadata||'{"is_compilation":true}'::jsonb
                where library_id=%s and id=%s""", (db.library, db.albums[0]))
        elif kind == "no_album":
            con.execute("update library.local_tracks set album_id=null where library_id=%s and id=%s",
                (db.library, db.tracks[0]))
        con.execute("""update library.local_artists set mbid=%s,mbid_assertion_state='asserted',
            evidence_source='fixture:exact' where library_id=%s and id=%s""",
            (db.artist_mbids[1], db.library, second))
    # The explicit assertion update changes the second row's identity basis.
    # Rebuild only its fixture envelope against that new truthful basis.
    set_country(db, envelope(db, "DE", index=3), index=3)
    assert_facet(discover(db, parent, ("countries",), method="random")["facets"]["countries"],
        choices=[("musicbrainz-country:" + expected, expected)], known=1)


def test_discovery_reads_no_popularity_observation_and_allocates_no_receipt_or_request_key(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0, 1, 3))
    with db.connect() as con:
        before = con.execute("select count(*) as n from app.playlist_creation_sources where library_id=%s",
            (db.library,)).fetchone()["n"]
    with sql_probe(monkeypatch, db) as log:
        discover(db, parent)
    assert not any("catalog.popularity_source_observations" in row["sql"] for row in log)
    assert not any(row["sql"].startswith(("insert ", "update ", "delete ")) for row in log)
    with db.connect() as con:
        assert con.execute("select count(*) as n from app.playlist_creation_sources where library_id=%s",
            (db.library,)).fetchone()["n"] == before


# R4 / B3: a truthful shared FK is not another candidate's canonical identity.
@pytest.mark.parametrize("previous", [False, True])
def test_shared_artist_fk_keeps_first_unbound_candidate_unresolved_and_ineligible(mix_db, monkeypatch, previous):
    from music_app.services import sample_playlist_facets as facets
    from sample_facet_support import acquisition, enrich, primary_row, strict_result
    db = mix_db; parent = manual_source(db, (0, 1)); grant_refresh(db)
    artist = primary_row(db)["id"]
    assert primary_row(db)["mbid"] is None
    with db.connect() as con:
        con.execute("""update library.local_albums set metadata=metadata||'{"is_compilation":true}'::jsonb
            where library_id=%s and id=%s""", (db.library, db.albums[0]))
        # Track 0 is deliberately first numerically. Its truthful artist FK stays
        # present, but neither mapping nor asserted row/tag identity supplies MBID.
        con.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s",
            (db.tracks[0],))
        con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
            '{scan_cache,file_entry,musicbrainz_artist_ids}','[]'::jsonb) where track_id=%s""", (db.tracks[0],))
        db.rebind_mappings(con, [db.tracks[1]])
    if previous:
        set_country(db, envelope(db, "DE"))
    valid_target = target(db, 1)
    initial = discover(db, parent, ("countries",))["facets"]["countries"]
    assert_facet(initial, choices=[("musicbrainz-country:DE", "DE")] if previous else [],
        count=2, known=int(previous), unresolved=2 - int(previous), targets=[valid_target])
    real = facets.association_digest; proofs = []
    def association(snapshot, state, source, method):
        assert {row["original_local_track_id"] for row in state["rows"]} == set(db.tracks[:2])
        assert state["bindings"][db.tracks[0]] == {
            "local_artist_id": artist, "primary_artist_ref": None, "basis": "track"}
        assert state["bindings"][db.tracks[1]]["primary_artist_ref"] == valid_target["primary_artist_ref"]
        proofs.append(deepcopy(state["bindings"]))
        return real(snapshot, state, source, method)
    monkeypatch.setattr(facets, "association_digest", association)
    calls = acquisition(monkeypatch, lambda mbid, *_: strict_result(mbid, "GB"))
    assert enrich(db, parent, [valid_target]) == [{**valid_target, "status": "stored_known"}]
    assert len(calls) == 1 and calls[0][0] == db.artist_mbids[0] and len(proofs) >= 3
    assert_facet(discover(db, parent, ("countries",))["facets"]["countries"],
        choices=[("musicbrainz-country:GB", "GB")], count=2, known=1, unresolved=1, targets=[valid_target])


# R4 / B4: wait-time denial must precede every new facet/identity projection.
@pytest.mark.parametrize("fields", [("styles",), ("countries",), ("styles", "countries")])
@pytest.mark.parametrize("kind", ["track", "album"])
def test_active_facets_exclude_post_inventory_wait_denial_before_projection(mix_db, monkeypatch, fields, kind):
    from music_app.services import sample_playlist_sources as samples, sample_playlist_facets as facets
    from sample_facet_support import acquisition, enrich, primary_row, strict_result
    db = mix_db; denied_index = 1 if kind == "track" else 3
    parent = manual_source(db, (0, denied_index)); grant_refresh(db)
    allowed, denied = db.tracks[0], db.tracks[denied_index]
    denied_artist = primary_row(db, denied_index)["id"]
    set_genre(db, "Visible", indexes=(0,)); set_genre(db, "Hidden", indexes=(denied_index,))
    set_country(db, envelope(db, "GB"))
    if kind == "album":
        set_country(db, envelope(db, "Hidden", index=3), index=3)
    else:
        with db.connect() as con:
            # This excluded same-album row would poison primary reconciliation
            # if the new facet path reintroduced the pre-wait inventory rows.
            con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
                '{scan_cache,file_entry,musicbrainz_album_artist_ids}',%s) where track_id=%s""",
                (Jsonb([db.artist_mbids[1]]), denied))
            db.rebind_mappings(con, [denied])
    waited = False; normalized, reads, projected, associations = [], [], [], []
    read = samples.inventory.read_inventory
    def reading(*args, **kwargs):
        nonlocal waited
        rows = read(*args, **kwargs); reads.append(tuple(kwargs["track_ids"])); waited = True
        return rows
    monkeypatch.setattr(samples.inventory, "read_inventory", reading)
    def wrap(real):
        def normalize(row):
            identity = row["original_local_track_id"]
            normalized.append(identity); assert identity == allowed
            return real(row)
        return normalize
    for name in ("local_identity", "normalize_cached_track_identity", "normalize_cached_inventory_row"):
        monkeypatch.setattr(samples.inventory, name, wrap(getattr(samples.inventory, name)))
    binding = samples.inventory.primary_artist_bindings
    def bindings(rows, *, track_artist_ids):
        rows = tuple(rows)
        assert {row["original_local_track_id"] for row in rows} == {allowed}
        assert denied not in track_artist_ids
        return binding(rows, track_artist_ids=track_artist_ids)
    monkeypatch.setattr(samples.inventory, "primary_artist_bindings", bindings)
    project = facets.project
    def projection(owner, connection, live, rows, candidates, diagnostics, mask, constraints, state, **kwargs):
        assert {row["original_local_track_id"] for row in rows} == {allowed}
        assert [c.track_id for c in candidates] == [allowed]
        assert candidates[0].primary_artist_ref == target(db)["primary_artist_ref"]
        result = project(owner, connection, live, rows, candidates, diagnostics, mask, constraints, state, **kwargs)
        assert {row["original_local_track_id"] for row in state["rows"]} == {allowed}
        assert set(state["bindings"]) == {allowed}
        projected.append(tuple(mask)); return result
    monkeypatch.setattr(facets, "project", projection)
    association = facets.association_digest
    def proof(snapshot, state, source, method):
        assert {row["original_local_track_id"] for row in state["rows"]} == {allowed}
        assert set(state["bindings"]) == {allowed}
        associations.append(True); return association(snapshot, state, source, method)
    monkeypatch.setattr(facets, "association_digest", proof)
    def constraints(context):
        resource = context.resource
        blocked = waited and resource and resource.resource_kind == kind and resource.resource_ref == str(
            denied if kind == "track" else db.albums[1])
        return PolicyEvaluationConstraints(deployment_allowed=not blocked)
    with sql_probe(monkeypatch, db) as events:
        result = discover(db, parent, fields, constraints=constraints)
        assert set(result["facets"]) == set(fields)
        if "styles" in fields:
            assert_facet(result["facets"]["styles"], choices=[("genre-tag:Visible", "Visible")], known=1)
        if "countries" in fields:
            assert_facet(result["facets"]["countries"], choices=[("musicbrainz-country:GB", "GB")],
                known=1, targets=[target(db)])
        assert "Hidden" not in str(result) and "denied" not in str(result)
        waited = False
        calls = acquisition(monkeypatch, lambda mbid, *_: strict_result(mbid, "DE"))
        assert enrich(db, parent, constraints=constraints) == [{**target(db), "status": "stored_known"}]
    assert reads and set(reads[0]) == {allowed, denied}, "The actual first inventory wait must include the later-denied row"
    assert all(allowed in ids and set(ids) <= {allowed, denied} for ids in reads)
    assert normalized and set(normalized) == {allowed} and projected and associations
    assert len(calls) == 1
    for event in events:
        if "{scan_cache,file_entry,genre}" in event["sql"]:
            assert denied not in event["params"][1]
        if kind == "album" and KEY in event["sql"] and "select" in event["sql"]:
            assert denied_artist not in event["params"][1], "Denied-only artist reserved Country key was read"
