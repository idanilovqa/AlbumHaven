"""Exact registered routes through the existing authenticated ASGI harness."""
from copy import deepcopy
from dataclasses import replace
import json
import pytest
from test_library_mix_route_boundary import boundary, assert_error
from tests.py.owned_playlist_testing import PLAYLIST, LIBRARY
from music_app.routes import owned_playlists_asgi as routes
from music_app.services.current_actor import CapabilityGrant
from music_app.services.private_route_boundary import private_action_for_route, csrf_mode_for_route
from music_app.services.owned_playlists import CREATE
from library_mix_postgres_support import mix_db, mix_urls
from sample_facet_support import REFRESH, grant_refresh, manual_source, set_country, target

FACETS = "/playlists/creation-source/sample/facets"
COUNTRY = "/playlists/creation-source/sample/country-metadata"
ARTIST = "00000000-0000-4000-8000-000000000001"


def body(path=FACETS):
    return {"playlist_ref": PLAYLIST, "revision": "1", "selection_method": "random",
        **({"facets": ["styles", "countries"]} if path == FACETS else
            {"targets": [{"track_ref": f"inventory-track:{LIBRARY}:1",
                "primary_artist_ref": "musicbrainz-artist:" + ARTIST}]})}


def instrument(monkeypatch, boundary, path):
    calls = []
    if path == COUNTRY:
        actor = boundary.resolver.actor
        boundary.resolver.actor = replace(actor, capability_grants=(*actor.capability_grants,
            CapabilityGrant(REFRESH, "library", LIBRARY)))
    def observe(context, selector, selection_method, values=None, constraints=None,
            should_cancel=None, **kwargs):
        field = "facets" if path == FACETS else "targets"
        values = kwargs.pop(field, values)
        assert kwargs == {}
        if path == COUNTRY:
            assert callable(should_cancel) and should_cancel() is False
        calls.append((context, deepcopy(selector), selection_method, deepcopy(values), constraints, should_cancel))
        data = {"selection_method": selection_method}
        if path == FACETS:
            data.update({"facets": {facet: {"status": "ready", "choices": [],
                "coverage": {"candidate_count": 0, "known": 0, "unknown": 0, "unresolved": 0},
                "error": None, "enrichment_targets": []} for facet in values},
                "allowed_actions": {"enrich_country": False}})
        else:
            data["results"] = [{**value, "status": "stored_known"} for value in values]
        return {"status": "ready", "data": data}
    name = "read_sample_facets" if path == FACETS else "enrich_sample_country_metadata"
    monkeypatch.setattr(boundary.owner, name, observe, raising=False)
    return calls


@pytest.mark.parametrize("path,action", [(FACETS, CREATE), (COUNTRY, REFRESH)])
def test_explicit_route_registration_not_prefix_fallback(path, action):
    matches = [r for r in routes.router.routes if r.path == path and "POST" in r.methods]
    assert len(matches) == 1
    assert private_action_for_route("POST", path) == action
    assert csrf_mode_for_route("POST", path) == "session_header"
    assert [r.path for r in routes.router.routes].index(path) < [r.path for r in routes.router.routes].index("/playlists/{playlist_ref}")


@pytest.mark.parametrize("path", [FACETS, COUNTRY])
@pytest.mark.parametrize("origin", [None, {"kind": "album_top", "top_ref": PLAYLIST, "revision": "1"},
    {"kind": "album_set", "selections": [{"kind": "local", "inventory_album_ref": f"inventory-album:{LIBRARY}:1"}]},
    {"kind": "album_details", "track_refs": [f"inventory-track:{LIBRARY}:1"]}])
def test_exact_request_selector_and_method_dispatch_without_capture_keys(boundary, monkeypatch, path, origin):
    calls = instrument(monkeypatch, boundary, path); payload = body(path)
    if origin:
        del payload["playlist_ref"]; del payload["revision"]; payload["origin"] = origin
    status, headers, result = boundary.request("POST", path, payload=payload)
    assert status == 200 and headers["cache-control"] == "private, no-store"
    assert set(result) == {"status", "data", "context_ref"} and result["context_ref"] == boundary.context_ref()
    assert len(calls) == 1 and calls[0][2] == "random" and calls[0][4] is boundary.constraints
    assert calls[0][1] == ({"origin": origin} if origin else {"playlist_ref": PLAYLIST, "revision": "1"})
    assert calls[0][3] == payload["facets" if path == FACETS else "targets"]
    if path == COUNTRY:
        assert callable(calls[0][5]) and calls[0][5]() is True


@pytest.mark.parametrize("path", [FACETS, COUNTRY])
@pytest.mark.parametrize("mutation", ["extra", "options", "quota", "missing_method", "invalid_method",
    "both_selectors", "missing_revision", "query", "foreign", "numeric_revision"])
def test_closed_request_rejects_before_service(boundary, monkeypatch, path, mutation):
    calls = instrument(monkeypatch, boundary, path); payload = body(path); query = None
    if mutation in ("extra", "options", "quota"): payload[mutation] = {}
    elif mutation == "missing_method": del payload["selection_method"]
    elif mutation == "invalid_method": payload["selection_method"] = "default"
    elif mutation == "both_selectors": payload["origin"] = {"kind": "album_details", "track_refs": []}
    elif mutation == "missing_revision": del payload["revision"]
    elif mutation == "query": query = {"cursor": "next"}
    elif mutation == "numeric_revision": payload["revision"] = 1
    else:
        payload = {"origin": {"kind": "album_details", "track_refs": [f"inventory-track:{LIBRARY + 1}:1"]},
            **{key: value for key, value in payload.items() if key not in ("playlist_ref", "revision")}}
    expected = 409 if mutation == "foreign" else 400
    assert boundary.request("POST", path, payload=payload, query=query)[0] == expected
    assert calls == []


@pytest.mark.parametrize("facets", [[], ["countries", "styles"], ["styles", "styles"], ["unknown"],
    ["styles", "countries", "extra"], None, "styles"])
def test_only_three_ordered_facet_masks_are_accepted(boundary, monkeypatch, facets):
    calls = instrument(monkeypatch, boundary, FACETS)
    assert_error(boundary.request("POST", FACETS, payload={**body(), "facets": facets}), "invalid_command", 400)
    assert calls == []


@pytest.mark.parametrize("facets", [["styles"], ["countries"], ["styles", "countries"]])
def test_exact_facet_masks_are_accepted(boundary, monkeypatch, facets):
    calls = instrument(monkeypatch, boundary, FACETS)
    assert boundary.request("POST", FACETS, payload={**body(), "facets": facets})[0] == 200
    assert calls[0][3] == facets


@pytest.mark.parametrize("targets", [[], None, "all",
    [{"track_ref": f"inventory-track:{LIBRARY}:1", "primary_artist_ref": "name:Artist"}],
    [{"track_ref": f"inventory-track:{LIBRARY}:01", "primary_artist_ref": "musicbrainz-artist:" + ARTIST}],
    [{"track_ref": 1, "primary_artist_ref": "musicbrainz-artist:" + ARTIST}],
    [{"track_ref": f"inventory-track:{LIBRARY}:1", "primary_artist_ref": "musicbrainz-artist:" + ARTIST, "country": "GB"}],
    [{"track_ref": f"inventory-track:{LIBRARY}:1", "primary_artist_ref": "musicbrainz-artist:" + ARTIST}] * 2])
def test_country_targets_are_closed_canonical_and_duplicate_free(boundary, monkeypatch, targets):
    calls = instrument(monkeypatch, boundary, COUNTRY)
    assert_error(boundary.request("POST", COUNTRY, payload={**body(COUNTRY), "targets": targets}), "invalid_command", 400)
    assert calls == []


@pytest.mark.parametrize("count,accepted", [(25, True), (26, False)])
def test_country_target_request_has_one_finite_25_slot_limit(boundary, monkeypatch, count, accepted):
    calls = instrument(monkeypatch, boundary, COUNTRY)
    targets = [{"track_ref": f"inventory-track:{LIBRARY}:{i}", "primary_artist_ref": "musicbrainz-artist:" + ARTIST}
        for i in range(1, count + 1)]
    response = boundary.request("POST", COUNTRY, payload={**body(COUNTRY), "targets": targets})
    assert response[0] == (200 if accepted else 400)
    assert len(calls) == int(accepted)


@pytest.mark.parametrize("path", [FACETS, COUNTRY])
@pytest.mark.parametrize("size,accepted", [(32768, True), (32769, False)])
def test_request_byte_cap_counts_streamed_utf8_bytes_before_dispatch(boundary, monkeypatch, path, size, accepted):
    calls = instrument(monkeypatch, boundary, path)
    raw = json.dumps(body(path), separators=(",", ":")).encode()
    raw += b" " * (size - len(raw))
    response = boundary.request("POST", path, chunks=[raw[:127], raw[127:]])
    assert response[0] == (200 if accepted else 413)
    assert len(calls) == int(accepted)


@pytest.mark.parametrize("path", [FACETS, COUNTRY])
@pytest.mark.parametrize("kind", ["csrf", "origin", "context"])
def test_existing_request_perimeter_is_not_relaxed(boundary, monkeypatch, path, kind):
    calls = instrument(monkeypatch, boundary, path)
    kwargs = {"omit": ("x-album-haven-csrf",)} if kind == "csrf" else {
        "headers": {"origin": "https://foreign.test"} if kind == "origin" else {"x-albumhaven-context": "b" * 64}}
    response = boundary.request("POST", path, payload=body(path), **kwargs)
    assert response[0] == (409 if kind == "context" else 403)
    assert calls == []


@pytest.mark.parametrize("bad", [None, {}, {"oversized": "x" * 8193}])
def test_initial_bad_envelope_http_error_has_no_target_result_or_identifying_detail(boundary, mix_db, monkeypatch, bad):
    from sample_facet_support import acquisition
    db = mix_db; parent = manual_source(db, (0, 3)); grant_refresh(db); set_country(db, bad, index=3)
    boundary.app.state.owned_playlists_service = db.service; boundary.resolver.actor = db.owner
    calls = acquisition(monkeypatch)
    payload = {"playlist_ref": parent["playlist_id"], "revision": parent["revision"],
        "selection_method": "most_listened", "targets": [target(db), target(db, 3)]}
    assert_error(boundary.request("POST", COUNTRY, payload=payload), "source_unavailable", 404)
    assert calls == []


# R4 / B2: independently count the complete wire object, including context_ref.
def _facet_wire_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
        separators=(",", ":")).encode("utf-8")


def _bounded_discovery_at_wire_size(context_ref, size):
    prefixes = {"styles": "genre-tag:", "countries": "musicbrainz-country:"}
    data = {"selection_method": "random", "facets": {},
        "allowed_actions": {"enrich_country": False}}
    for field, prefix in prefixes.items():
        # Distinct sorted scalars include both multibyte UTF-8 and JSON escapes.
        labels = [f'{i:04d}é\\"' for i in range(1024)]
        data["facets"][field] = {"status": "ready",
            "choices": [{"identity": prefix + label, "label": label} for label in labels],
            "coverage": {"candidate_count": 1025, "known": 99 if field == "styles" else 1024,
                "unknown": 926 if field == "styles" else 1, "unresolved": 0},
            "error": None, "enrichment_targets": []}
    result = {"status": "ready", "data": data}
    complete = {**result, "context_ref": context_ref}
    gap = size - len(_facet_wire_bytes(complete))
    if gap % 2:
        # Keep a consistent coverage sum while increasing its encoded size by one.
        data["facets"]["styles"]["coverage"].update(known=100, unknown=925)
        gap -= 1
    assert gap >= 0 and gap % 2 == 0
    for field, prefix in prefixes.items():
        choices = data["facets"][field]["choices"]
        used = sum(len(c["identity"].encode()) + len(c["label"].encode()) for c in choices)
        for choice in choices:
            count = min(gap // 2, 1024 - len(choice["label"].encode()), (262144 - used) // 2)
            choice["label"] += "x" * count; choice["identity"] = prefix + choice["label"]
            used += count * 2; gap -= count * 2
        assert len(choices) == 1024 and used <= 262144
        assert [c["identity"] for c in choices] == sorted(c["identity"] for c in choices)
    assert gap == 0 and len(_facet_wire_bytes(complete)) == size
    assert len(_facet_wire_bytes(result)) < 524288, "Service-only payload must still fit"
    return result


@pytest.mark.parametrize("size,status", [(524288, 200), (524289, 413)])
def test_complete_facet_response_boundary_includes_context_utf8_and_escaping(boundary, monkeypatch, size, status):
    reference = boundary.context_ref()
    payload = _bounded_discovery_at_wire_size(reference, size)
    calls = []
    def owner(*args, **kwargs):
        calls.append((args, kwargs)); return deepcopy(payload)
    monkeypatch.setattr(boundary.owner, "read_sample_facets", owner, raising=False)
    response = boundary.request("POST", FACETS, payload=body())
    assert len(calls) == 1
    if status == 413:
        assert_error(response, "source_too_large", 413)
    else:
        actual_status, headers, result = response
        assert actual_status == 200 and headers["cache-control"] == "private, no-store"
        assert result == {**payload, "context_ref": reference}
        assert len(_facet_wire_bytes(result)) == int(headers["content-length"]) == 524288


@pytest.mark.parametrize("path", [FACETS, COUNTRY])
def test_each_new_route_resolves_one_final_context_after_its_service_result(boundary, monkeypatch, path):
    calls = instrument(monkeypatch, boundary, path)
    real = routes._context_ref; resolutions = []
    def context(request):
        result = real(request); resolutions.append((len(calls), result)); return result
    monkeypatch.setattr(routes, "_context_ref", context)
    status, headers, result = boundary.request("POST", path, payload=body(path))
    assert status == 200 and headers["cache-control"] == "private, no-store"
    assert [reference for completed, reference in resolutions if completed] == [result["context_ref"]]
    assert set(result) == {"status", "data", "context_ref"}


# R4 / B6: durable losses commit externally during provider I/O; Create uses
# the existing action-specific policy seam because Browse also grants Create.
# Loss occurs outside the authority locks. The real ASGI/service/error owners
# must hide all results even though the first target was truthfully committed.
@pytest.mark.parametrize("loss", ["browse", "create", "refresh", "membership", "session"])
@pytest.mark.parametrize("failure", ["failed", "malformed", "mismatched"])
def test_failed_last_provider_response_after_live_authority_loss_is_exact_403(boundary, mix_db, monkeypatch, loss, failure):
    from music_app.services.owned_playlists import BROWSE
    from sample_facet_support import (KEY, acquisition, country, envelope, primary_row,
        sql_probe, strict_result, transaction_spy)
    from test_sample_country_acquisition_live import _failed_artist_response
    db = mix_db; parent = manual_source(db, (0, 3)); grant_refresh(db)
    old = envelope(db, "DE", index=3); set_country(db, old, index=3)
    boundary.app.state.owned_playlists_service = db.service; boundary.resolver.actor = db.owner
    denied_actions = set(); policy_checks = []
    if loss == "create":
        def constraints(context):
            current = boundary.constraints(context)
            policy_checks.append((context.action, bool(denied_actions)))
            return replace(current, deployment_allowed=current.deployment_allowed and context.action not in denied_actions)
        boundary.app.state.policy_constraint_resolver = constraints
    committed = []
    with transaction_spy(monkeypatch, db) as (active, transactions):
        def network(mbid, count, cancel):
            assert active == [], "External revocation cannot be simulated inside already-held locks"
            if count == 1:
                return strict_result(mbid, "GB")
            assert count == 2
            committed.append(country(db)); assert committed[0]["country_token"] == "GB"
            if loss == "create":
                denied_actions.add(CREATE)
            else:
                with db.connect() as con:
                    if loss in ("browse", "refresh"):
                        con.execute("delete from app.capabilities where account_id=%s and capability_key=%s",
                            (db.owner.account_id, {"browse": BROWSE, "refresh": REFRESH}[loss]))
                    elif loss == "membership":
                        con.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                            (db.owner.account_id, db.library))
                    else:
                        con.execute("update app.account_sessions set revoked_at=%s where id=%s",
                            (db.clock_time, db.owner.session_id))
            return _failed_artist_response(failure, mbid)
        calls = acquisition(monkeypatch, network)
        with sql_probe(monkeypatch, db) as events:
            response = boundary.request("POST", COUNTRY, payload={
                "playlist_ref": parent["playlist_id"], "revision": parent["revision"],
                "selection_method": "most_listened", "targets": [target(db), target(db, 3)]})
    assert_error(response, "forbidden", 403)
    if loss == "create":
        assert (CREATE, False) in policy_checks and (CREATE, True) in policy_checks
    assert response[2] == {"ok": False, "error": "forbidden"}, "No result list, target identity or partial-success detail"
    assert [call[0] for call in calls] == db.artist_mbids
    assert country(db) == committed[0] and country(db, 3) == old
    assert len([event for event in events if event["sql"].startswith("update library.local_artists")]) == 1
