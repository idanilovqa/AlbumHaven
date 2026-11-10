"""Actual ASGI routing and authorization, with isolated persistence transports."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
import pytest

from music_app.routes import api_wave_d_asgi_routes as routes
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict
from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401


BODY = {"expected_revision": 3, "mutation_id": "9a7263b5-d83b-4892-8684-9b475f7ded41",
        "references": [{"selection_id": "front"}]}


def actor(*grants, library_id=23):
    return CurrentActor(state=ActorState.ACTIVE, account_id=7, session_id=11,
        username_display="editor", current_library_id=library_id,
        library_relationships=(LibraryRelationship(library_id, "member", False),),
        capability_grants=tuple(CapabilityGrant(grant, "library", library_id) for grant in grants))


class Resolver:
    def __init__(self, user):
        self.user = user
        self.calls = []
    def resolve(self, token):
        self.calls.append(token)
        return self.user


async def request_async(app, payload, *, path="/albums/72/selected-covers", headers=(), method="PUT"):
    sent = False
    messages = []
    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": json.dumps(payload).encode(), "more_body": False}
    async def send(message):
        messages.append(message)
    await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": "https", "path": path, "raw_path": path.encode(),
        "query_string": b"", "headers": [(b"host", b"music.test"), (b"content-type", b"application/json"),
        (b"cookie", b"__Host-album_haven_session=synthetic"), *headers],
        "client": ("203.0.113.8", 50000), "server": ("music.test", 443)}, receive, send)
    status = next(item["status"] for item in messages if item["type"] == "http.response.start")
    body = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    return status, json.loads(body)


@pytest.fixture
def api(monkeypatch, tmp_path):
    app = FastAPI()
    app.include_router(routes.router)
    resolver = Resolver(actor("library.covers.write"))
    app.state.current_actor_resolver = resolver
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted",
                        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/api_test",
                        "_library_root_paths_snapshot": (tmp_path,)}
    app.state.auth_policy_config = {"hmac": {"secret": "0123456789abcdef0123456789abcdef", "key_version": 1}}
    calls = []
    (tmp_path / "album").mkdir()
    (tmp_path / "album" / "track.flac").write_bytes(b"synthetic track")
    from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
    monkeypatch.setattr(PostgresLibraryRootSettingsStore, "load_settings", lambda self, **kwargs: {"main_library_roots": [{"path": str(tmp_path)}]})
    app.state.library_state = {"file_cache": {str(tmp_path / "album" / "track.flac"): {"album_id": 72, "cover_path": None}}}
    context = {"album_id": 72, "album_key": "concrete-version", "library_id": 23,
               "track_paths": [str(tmp_path / "album" / "track.flac")]}
    class Repository:
        def __init__(self, config):
            pass
        def resolve_album_track_context(self, **kwargs):
            calls.append(("resolve", kwargs))
            return context.copy()
    monkeypatch.setattr(routes, "AlbumCoverCandidateSnapshotRepository", Repository)
    def persist(config, **kwargs):
        calls.append(("save", kwargs))
        result = {"selected_covers": [{"selection_id": "front", "kind": "local", "path": "/private/never-disclose.jpg"}],
                "selected_covers_revision": 4, "changed": True, "replayed": False,
                "inventory_mutation_revision": 9}
        def commit():
            calls.append(("commit", {}))
            return result
        kwargs["commit_guard"](commit)
        return result
    monkeypatch.setattr(routes, "persist_ordered_cover_selection_for_config", persist, raising=False)
    monkeypatch.setattr(routes.state_service, "invalidate_targeted_library_projections", lambda *args, **kwargs: calls.append(("invalidate", kwargs)))
    def request(payload=None, **kwargs):
        return asyncio.run(request_async(app, BODY if payload is None else payload, **kwargs))
    return SimpleNamespace(app=app, resolver=resolver, context=context, calls=calls, request=request, persist=persist)


@pytest.mark.parametrize("user,status", [(CurrentActor.anonymous(), 401), (actor(), 403)])
def test_http_policy_blocks_anonymous_and_missing_cover_write_before_mutation(api, user, status):
    api.resolver.user = user
    result, _ = api.request()
    assert result == status
    assert not any(name == "save" for name, _ in api.calls)


def test_authorized_save_uses_server_album_paths_and_never_exposes_private_sources(api):
    status, body = api.request()
    assert status == 200
    assert body == {"ok": True, "album_ref": "72", "selected_covers": [{"selection_id": "front", "kind": "local"}],
                    "selected_covers_revision": 4, "changed": True, "replayed": False}
    save = next(payload for name, payload in api.calls if name == "save")
    assert save["expected_album_id"] == 72
    assert set(save["track_paths"]) == set(api.context["track_paths"])
    assert save["references"] == BODY["references"]
    assert api.resolver.calls


def test_new_remote_reference_requires_separate_remote_read_authority(api):
    payload = {**BODY, "references": [{"kind": "remote", "candidate_id": "candidate", "candidate_generation": "e2f769fb-83d5-4f29-8a1a-fb319023e3cd"}]}
    status, _ = api.request(payload)
    assert status == 403
    assert not any(name == "save" for name, _ in api.calls)


def test_remote_editor_can_save_server_candidate_selector(api):
    api.resolver.user = actor("library.covers.write", "library.covers.remote.read")
    payload = {**BODY, "references": [{"kind": "remote", "candidate_id": "candidate", "candidate_generation": "e2f769fb-83d5-4f29-8a1a-fb319023e3cd"}]}
    status, _ = api.request(payload)
    assert status == 200
    assert next(args for name, args in api.calls if name == "save")["references"] == payload["references"]


def test_retaining_saved_selection_does_not_invent_remote_read_requirement(api):
    status, _ = api.request()
    assert status == 200


def test_other_library_album_is_not_disclosed_or_mutated(api):
    api.context["library_id"] = 99
    status, body = api.request()
    assert status == 404
    assert "private" not in json.dumps(body)
    assert not any(name == "save" for name, _ in api.calls)


@pytest.mark.parametrize("extra", [{"library_id": 99}, {"actor": {"owner": True}}, {"track_paths": ["/foreign/a.flac"]}])
def test_body_cannot_supply_authority_or_track_inventory(api, extra):
    status, _ = api.request({**BODY, **extra})
    assert status == 422
    assert not any(name == "save" for name, _ in api.calls)


@pytest.mark.parametrize("failure,status", [(OrderedCoverSelectionConflict("/private/stale.jpg"), 409),
    (ValueError("/private/foreign.jpg"), 404), (RuntimeError("postgres secret internal details"), 503)])
def test_failures_are_nondisclosing_and_never_publish_success(api, monkeypatch, failure, status):
    def fail(*args, **kwargs):
        raise failure
    monkeypatch.setattr(routes, "persist_ordered_cover_selection_for_config", fail, raising=False)
    actual, body = api.request()
    assert actual == status
    assert "/private/" not in json.dumps(body) and "secret" not in json.dumps(body)
    assert not any(name == "invalidate" for name, _ in api.calls)


def test_tv_client_is_denied_even_with_write_grant(api):
    status, _ = api.request(headers=[(b"x-album-haven-client-surface", b"tv")])
    assert status == 403
    assert not any(name == "save" for name, _ in api.calls)


@pytest.mark.parametrize("references", [[], [{"selection_id": "x"}] * 4,
    [{"kind": "remote", "url": "https://arbitrary.example.test/image.jpg"}],
    [{"kind": "local", "path": "/foreign.jpg", "selection_id": "forged"}]])
def test_malformed_or_overlimit_selectors_never_reach_repository(api, references):
    status, _ = api.request({**BODY, "references": references})
    assert status == 422
    assert not any(name == "save" for name, _ in api.calls)


def test_http_refreshes_actor_rather_than_trusting_cached_write_grant(api):
    @api.app.middleware("http")
    async def stale_actor(request, call_next):
        request.state.current_actor = actor("library.covers.write")
        return await call_next(request)
    api.resolver.user = actor()
    status, _ = api.request()
    assert status == 403
    assert api.resolver.calls
    assert not any(name == "save" for name, _ in api.calls)


def test_permission_revoked_while_waiting_is_rechecked_before_commit(api, monkeypatch):
    def waiting_save(config, **kwargs):
        api.resolver.user = actor()
        return api.persist(config, **kwargs)
    monkeypatch.setattr(routes, "persist_ordered_cover_selection_for_config", waiting_save)
    status, _ = api.request()
    assert status == 403
    assert not any(name in {"commit", "invalidate"} for name, _ in api.calls)
    assert next(iter(api.app.state.library_state["file_cache"].values()))["cover_path"] is None


def test_committed_primary_is_published_then_targeted_invalidation_uses_exact_revision(api):
    status, _ = api.request()
    assert status == 200
    entry = next(iter(api.app.state.library_state["file_cache"].values()))
    assert entry["cover_path"] == "/private/never-disclose.jpg"
    assert api.app.state.library_state["scan_generation"] == 1
    events = [name for name, _ in api.calls]
    assert events.index("commit") < events.index("invalidate")
    invalidation = next(args for name, args in api.calls if name == "invalidate")
    assert invalidation["revision"] == 9
    assert invalidation["affected_album_keys"] == ("concrete-version",)


@pytest.mark.parametrize("kind,persisted", [("uncertain", None), ("finalization", True)])
def test_commit_outcomes_expose_only_safe_recovery_status(api, monkeypatch, kind, persisted):
    from music_app.services.cover_mutation import CoverMutationEffect, CoverMutationCommitUncertainError, CoverMutationFinalizationError
    def fail(*args, **kwargs):
        error = CoverMutationCommitUncertainError if kind == "uncertain" else CoverMutationFinalizationError
        raise error(CoverMutationEffect(value={"path": "/private/source.jpg"}))
    monkeypatch.setattr(routes, "persist_ordered_cover_selection_for_config", fail)
    status, body = api.request()
    assert status == 503 and body["persisted"] is persisted
    assert "/private/" not in json.dumps(body)
    assert not any(name == "invalidate" for name, _ in api.calls)


@pytest.fixture
def reader(api, monkeypatch):
    api.resolver.user = actor("library.covers.lookup")
    saved = {"selected_covers_revision": 6, "selected_covers": [
        {"selection_id": "missing-local", "kind": "local", "path": str(Path(api.context["track_paths"][0]).parent / "missing.jpg")},
        {"selection_id": "remote", "kind": "remote", "url": "https://images.example.test/source.jpg"}],
        "selected_covers_last_request": {"mutation_id": BODY["mutation_id"], "request_hash": "a" * 64}}
    def load(config, album_ids):
        api.calls.append(("read", album_ids))
        return {72: saved}
    monkeypatch.setattr(routes, "load_cover_selections_for_config", load, raising=False)
    return api, saved


def test_get_reads_current_revision_and_retains_missing_local_slot_without_remote_disclosure(reader):
    api, saved = reader
    status, body = api.request(method="GET")
    assert status == 200
    assert body["selected_covers_revision"] == 6
    assert body["selected_covers"][0] == saved["selected_covers"][0]
    assert body["selected_covers"][1] == {"selection_id": "remote", "kind": "remote"}
    assert "selected_covers_last_request" not in body
    assert not any(name in {"save", "commit", "invalidate"} for name, _ in api.calls)


def test_get_remote_descriptor_requires_existing_remote_read_grant(reader):
    api, saved = reader
    api.resolver.user = actor("library.covers.lookup", "library.covers.remote.read")
    status, body = api.request(method="GET")
    assert status == 200
    assert body["selected_covers"] == saved["selected_covers"]


def test_get_does_not_infer_an_ordered_selection_from_legacy_primary(reader):
    api, saved = reader
    saved.clear()
    saved.update(selected_cover_path="/private/legacy.jpg", cover_selection_origin="user")
    status, body = api.request(method="GET")
    assert status == 200
    from music_app.services.ordered_cover_selection import current_cover_token
    token = current_cover_token(album_id=72, library_id=23,
                               cover_path=saved["selected_cover_path"], metadata=saved)
    assert body == {"ok": True, "album_ref": "72", "selected_covers_revision": 0,
                    "selected_covers": [], "current_cover_token": token}
    assert saved == {"selected_cover_path": "/private/legacy.jpg", "cover_selection_origin": "user"}
    assert not any(name in {"save", "commit", "invalidate"} for name, _ in api.calls)


def test_get_redacts_source_outside_current_album_without_dropping_slot(reader):
    api, saved = reader
    saved["selected_covers"][0]["path"] = "/foreign-library/private.jpg"
    status, body = api.request(method="GET")
    assert status == 200
    assert body["selected_covers"][0] == {"selection_id": "missing-local", "kind": "local", "unavailable": True}
    assert "foreign-library" not in json.dumps(body)


@pytest.mark.parametrize("user,status", [(CurrentActor.anonymous(), 401), (actor(), 403)])
def test_get_requires_current_lookup_authority(reader, user, status):
    api, _ = reader
    api.resolver.user = user
    actual, _ = api.request(method="GET")
    assert actual == status
    assert not any(name == "read" for name, _ in api.calls)


def test_get_cross_library_album_denies_before_reference_read(reader):
    api, _ = reader
    api.context["library_id"] = 99
    status, _ = api.request(method="GET")
    assert status == 404
    assert not any(name == "read" for name, _ in api.calls)


def test_change_covers_capability_preserves_existing_write_and_remote_read_mapping(api):
    api.resolver.user = actor("capability.change_covers")
    status, _ = api.request({**BODY, "references": [{"kind": "remote", "candidate_id": "candidate", "candidate_generation": "e2f769fb-83d5-4f29-8a1a-fb319023e3cd"}]})
    assert status == 200


def test_get_redacts_other_album_source_even_inside_same_library_root(reader):
    api, saved = reader
    album_root = Path(api.context["track_paths"][0]).parent
    saved["selected_covers"][0]["path"] = str(album_root.parent / "other-album" / "front.jpg")
    status, body = api.request(method="GET")
    assert status == 200
    assert body["selected_covers"][0] == {"selection_id": "missing-local", "kind": "local", "unavailable": True}
    assert "other-album" not in json.dumps(body)


def test_get_redacts_symlink_rebound_outside_album(reader, tmp_path):
    api, saved = reader
    target = tmp_path / "outside.jpg"
    target.write_bytes(b"synthetic image")
    alias = Path(api.context["track_paths"][0]).parent / "alias.jpg"
    alias.symlink_to(target)
    saved["selected_covers"][0]["path"] = str(alias)
    status, body = api.request(method="GET")
    assert status == 200
    assert body["selected_covers"][0] == {"selection_id": "missing-local", "kind": "local", "unavailable": True}
