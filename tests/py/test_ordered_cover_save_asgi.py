"""Actual ASGI routing and authorization, with isolated persistence transports."""
import asyncio
import json
from pathlib import Path
import threading
import time
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
        def get_for_album_context(self, *, album_id):
            return {"search_generation": "e2f769fb-83d5-4f29-8a1a-fb319023e3cd", "candidates": candidates}
    # The lookup's online candidates; Spotify covers stay links, others are downloaded on Save.
    candidates = [{"id": "candidate", "source": "spotify", "source_label": "Spotify", "art_kind": "cover",
                   "url": "https://images.example/private.jpg"}]
    monkeypatch.setattr(routes, "AlbumCoverCandidateSnapshotRepository", Repository)
    prior = {"selected_covers": [], "selected_covers_revision": 3}
    monkeypatch.setattr(routes, "load_cover_selections_for_config", lambda config, ids: {72: prior})
    fetched = []
    def fetch(url, *, config):
        fetched.append(url)
        return downloaded_image["bytes"], "image/jpeg"
    downloaded_image = {"bytes": None}
    monkeypatch.setattr(routes, "fetch_remote_cover_bytes", fetch)
    # Recording a downloaded cover's provider is a database write; tests that care replace it.
    monkeypatch.setattr(routes, "record_local_cover_provenance", lambda _config, **_kwargs: None)
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
    return SimpleNamespace(app=app, resolver=resolver, context=context, calls=calls, request=request, persist=persist,
                           candidates=candidates, prior=prior, fetched=fetched, downloaded_image=downloaded_image,
                           album_root=tmp_path / "album")


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
                    "selected_covers_revision": 4, "changed": True, "replayed": False, "lookup_task": None}
    save = next(payload for name, payload in api.calls if name == "save")
    assert save["expected_album_id"] == 72
    assert set(save["track_paths"]) == set(api.context["track_paths"])
    assert save["references"] == BODY["references"]
    assert api.resolver.calls


def test_local_source_named_by_the_cover_reference_boundary_reaches_the_repository_as_a_path(api):
    # The page sends `candidate_cover_ref`; the boundary resolves it to `candidate_cover_path`.
    source = str(Path(api.context["track_paths"][0]).parent / "front.jpg")
    payload = {**BODY, "references": [{"kind": "local", "candidate_cover_path": source}]}
    status, _ = api.request(payload)
    assert status == 200
    save = next(payload for name, payload in api.calls if name == "save")
    assert save["references"] == [{"kind": "local", "path": source}]


@pytest.mark.parametrize("reference", [
    {"kind": "local", "candidate_cover_path": None},
    {"kind": "local", "candidate_cover_path": "/x.jpg", "path": "/x.jpg"},
])
def test_unresolved_or_mixed_local_source_never_reaches_repository(api, reference):
    status, _ = api.request({**BODY, "references": [reference]})
    assert status == 422
    assert not any(name == "save" for name, _ in api.calls)


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


REMOTE_GENERATION = "e2f769fb-83d5-4f29-8a1a-fb319023e3cd"
REMOTE_SAVED = {"selection_id": "online", "kind": "remote", "url": "https://images.example/private.jpg",
                "thumbnail_url": "https://images.example/private-thumb.jpg", "source": "spotify",
                "source_label": "Spotify", "candidate_id": "candidate", "candidate_generation": REMOTE_GENERATION}


def save_returning(api, monkeypatch, selected_covers):
    def persist(config, **kwargs):
        api.calls.append(("save", kwargs))
        result = {"selected_covers": selected_covers, "selected_covers_revision": 4, "changed": True,
                  "replayed": False, "inventory_mutation_revision": 9}
        kwargs["commit_guard"](lambda: result)
        return result
    monkeypatch.setattr(routes, "persist_ordered_cover_selection_for_config", persist, raising=False)


def test_online_cover_names_its_lookup_and_provider_but_never_its_url(api, monkeypatch):
    api.resolver.user = actor("library.covers.write", "library.covers.remote.read")
    save_returning(api, monkeypatch, [REMOTE_SAVED])
    payload = {**BODY, "references": [{"kind": "remote", "candidate_id": "candidate", "candidate_generation": REMOTE_GENERATION}]}
    status, body = api.request(payload)
    assert status == 200
    assert body["selected_covers"] == [{
        "selection_id": "online", "kind": "remote", "candidate_id": "candidate",
        "lookup_task_id": "e2f769fb83d54f298a1afb319023e3cd", "source": "spotify", "source_label": "Spotify",
    }]
    assert "images.example" not in json.dumps(body)


def test_retained_online_cover_hides_its_provenance_without_remote_read(api, monkeypatch):
    save_returning(api, monkeypatch, [REMOTE_SAVED])
    status, body = api.request({**BODY, "references": [{"selection_id": "online"}]})
    assert status == 200
    assert body["selected_covers"] == [{"selection_id": "online", "kind": "remote"}]


def test_save_from_a_lookup_answers_that_lookup_with_the_chosen_candidate(api, monkeypatch):
    api.resolver.user = actor("library.covers.write", "library.covers.remote.read")
    save_returning(api, monkeypatch, [REMOTE_SAVED])
    task_id = "e2f769fb83d54f298a1afb319023e3cd"
    marked = []
    monkeypatch.setattr(routes, "cover_lookup_result", lambda value: {
        "id": task_id, "status": "completed", "album_payload": {"album_id": 72},
    } if value == task_id else {})
    monkeypatch.setattr(routes, "mark_cover_lookup_task_notification_action_taken", lambda value, **kwargs: (
        marked.append((value, kwargs["selected_candidate_id"])) or {"id": value, "notification_action_taken": True}))
    payload = {**BODY, "lookup_task_id": task_id,
               "references": [{"kind": "remote", "candidate_id": "candidate", "candidate_generation": REMOTE_GENERATION}]}
    status, body = api.request(payload)
    assert status == 200
    assert marked == [(task_id, "candidate")]
    assert body["lookup_task"] == {"id": task_id, "notification_action_taken": True}
    assert "lookup_task_id" not in next(args for name, args in api.calls if name == "save")


def test_lookup_of_another_album_is_never_answered(api, monkeypatch):
    marked = []
    monkeypatch.setattr(routes, "cover_lookup_result", lambda value: {
        "id": value, "status": "completed", "album_payload": {"album_id": 5}, "track_paths": ["/other/a.flac"],
    })
    monkeypatch.setattr(routes, "mark_cover_lookup_task_notification_action_taken",
                        lambda value, **kwargs: marked.append(value))
    status, body = api.request({**BODY, "lookup_task_id": "lookup-of-album-5"})
    assert status == 200
    assert body["lookup_task"] is None
    assert marked == []


@pytest.mark.parametrize("lookup_task_id", [7, None, ["lookup"]])
def test_malformed_lookup_task_id_never_reaches_repository(api, lookup_task_id):
    status, _ = api.request({**BODY, "lookup_task_id": lookup_task_id})
    assert status == 422
    assert not any(name == "save" for name, _ in api.calls)


def jpeg(color):
    from io import BytesIO
    from PIL import Image
    buffer = BytesIO()
    Image.new("RGB", (40, 40), color).save(buffer, format="JPEG")
    return buffer.getvalue()


def online(candidate_id):
    return {"kind": "remote", "candidate_id": candidate_id, "candidate_generation": REMOTE_GENERATION}


def save_choosing_downloads(api, monkeypatch, outcome=None):
    """Persist double that saves each downloaded choice as the local file it became."""
    def persist(config, **kwargs):
        api.calls.append(("save", kwargs))
        if outcome is not None:
            raise outcome
        downloads = kwargs["downloads"]
        selected = [
            {"selection_id": f"slot-{index}", "kind": "local",
             "path": downloads[(reference["candidate_id"], REMOTE_GENERATION)]}
            if (reference.get("candidate_id"), REMOTE_GENERATION) in downloads
            else {"selection_id": f"slot-{index}", "kind": "local", "path": reference.get("path", "")}
            for index, reference in enumerate(kwargs["references"])
        ]
        result = {"selected_covers": selected, "selected_covers_revision": 4, "changed": True,
                  "replayed": False, "inventory_mutation_revision": 9}
        kwargs["commit_guard"](lambda: result)
        return result
    monkeypatch.setattr(routes, "persist_ordered_cover_selection_for_config", persist, raising=False)


def provider(candidate_id, source, label):
    return {"id": candidate_id, "source": source, "source_label": label, "art_kind": "cover",
            "url": f"https://images.example/{candidate_id}.jpg"}


def test_online_cover_is_downloaded_as_cover_jpg_keeping_the_previous_cover(api, monkeypatch):
    # Owner 2026-11-17: every online cover except Spotify is downloaded into the album folder.
    api.resolver.user = actor("library.covers.write", "library.covers.remote.read")
    api.candidates[:] = [provider("apple-1", "apple", "Apple Music")]
    previous = jpeg((200, 0, 0))
    (api.album_root / "cover.jpg").write_bytes(previous)
    api.downloaded_image["bytes"] = jpeg((0, 0, 200))
    save_choosing_downloads(api, monkeypatch)
    recorded = []
    monkeypatch.setattr(routes, "record_local_cover_provenance", lambda _config, **kwargs: recorded.append(kwargs))
    status, body = api.request({**BODY, "references": [online("apple-1")]})
    assert status == 200
    assert api.fetched == ["https://images.example/apple-1.jpg"]
    # Owner 2026-11-17: the downloaded file keeps its provider, for the album page's local cover badge.
    assert [(item["provenance"].keys() and list(item["provenance"]), item["provenance"][str(api.album_root / "cover.jpg")]["source"])
            for item in recorded] == [([str(api.album_root / "cover.jpg")], "apple")]
    save = next(args for name, args in api.calls if name == "save")
    cover = api.album_root / "cover.jpg"
    assert save["downloads"] == {("apple-1", REMOTE_GENERATION): str(cover)}
    assert cover.read_bytes() != previous
    kept = [path for path in api.album_root.iterdir() if path.name.startswith("cover-existing")]
    assert len(kept) == 1 and kept[0].read_bytes() == previous, "the previous cover.jpg is kept"
    assert body["selected_covers"] == [{
        "selection_id": "slot-0", "kind": "local", "candidate_id": "apple-1",
        "lookup_task_id": "e2f769fb83d54f298a1afb319023e3cd", "source": "apple", "source_label": "Apple Music",
    }]
    assert "images.example" not in json.dumps(body)


def test_later_online_covers_get_new_names_and_spotify_stays_a_link(api, monkeypatch):
    api.resolver.user = actor("library.covers.write", "library.covers.remote.read")
    api.candidates[:] = [provider("spotify-1", "spotify", "Spotify"), provider("deezer-1", "deezer", "Deezer")]
    (api.album_root / "cover-2.jpg").write_bytes(jpeg((9, 9, 9)))
    api.downloaded_image["bytes"] = jpeg((0, 120, 0))
    save_choosing_downloads(api, monkeypatch)
    status, _ = api.request({**BODY, "references": [online("spotify-1"), online("deezer-1")]})
    assert status == 200
    assert api.fetched == ["https://images.example/deezer-1.jpg"], "Spotify covers are linked, not downloaded"
    save = next(args for name, args in api.calls if name == "save")
    assert save["downloads"] == {("deezer-1", REMOTE_GENERATION): str(api.album_root / "cover-2-2.jpg")}
    assert not (api.album_root / "cover.jpg").exists(), "a linked first cover writes no cover.jpg"


def test_a_download_never_replaces_a_cover_jpg_the_same_save_selects(api, monkeypatch):
    api.resolver.user = actor("library.covers.write", "library.covers.remote.read")
    api.candidates[:] = [provider("apple-1", "apple", "Apple Music")]
    current = api.album_root / "cover.jpg"
    current.write_bytes(jpeg((1, 2, 3)))
    api.downloaded_image["bytes"] = jpeg((0, 0, 200))
    save_choosing_downloads(api, monkeypatch)
    status, _ = api.request({**BODY, "references": [online("apple-1"), {"kind": "local", "path": str(current)}]})
    assert status == 200
    save = next(args for name, args in api.calls if name == "save")
    assert save["downloads"] == {("apple-1", REMOTE_GENERATION): str(api.album_root / "cover-1.jpg")}
    assert current.read_bytes() == jpeg((1, 2, 3))


def test_unavailable_online_cover_reports_it_and_changes_nothing(api, monkeypatch):
    api.resolver.user = actor("library.covers.write", "library.covers.remote.read")
    api.candidates[:] = [provider("apple-1", "apple", "Apple Music"), provider("deezer-1", "deezer", "Deezer")]
    previous = jpeg((200, 0, 0))
    (api.album_root / "cover.jpg").write_bytes(previous)
    images = iter([jpeg((0, 0, 200)), None])
    monkeypatch.setattr(routes, "fetch_remote_cover_bytes", lambda url, *, config: (next(images), "image/jpeg"))
    save_choosing_downloads(api, monkeypatch)
    status, body = api.request({**BODY, "references": [online("apple-1"), online("deezer-1")]})
    assert status == 502
    assert body == {"ok": False, "error": "This online cover could not be downloaded. Your current cover is unchanged."}
    assert not any(name == "save" for name, _ in api.calls)
    assert sorted(path.name for path in api.album_root.iterdir()) == ["cover.jpg", "track.flac"]
    assert (api.album_root / "cover.jpg").read_bytes() == previous


def test_a_rejected_save_removes_what_it_downloaded(api, monkeypatch):
    api.resolver.user = actor("library.covers.write", "library.covers.remote.read")
    api.candidates[:] = [provider("apple-1", "apple", "Apple Music")]
    previous = jpeg((200, 0, 0))
    (api.album_root / "cover.jpg").write_bytes(previous)
    api.downloaded_image["bytes"] = jpeg((0, 0, 200))
    save_choosing_downloads(api, monkeypatch, outcome=OrderedCoverSelectionConflict("changed"))
    status, _ = api.request({**BODY, "references": [online("apple-1")]})
    assert status == 409
    assert sorted(path.name for path in api.album_root.iterdir()) == ["cover.jpg", "track.flac"]
    assert (api.album_root / "cover.jpg").read_bytes() == previous


def test_a_retried_save_replays_without_downloading_again(api, monkeypatch):
    api.resolver.user = actor("library.covers.write", "library.covers.remote.read")
    api.candidates[:] = [provider("apple-1", "apple", "Apple Music")]
    api.prior["selected_covers_last_request"] = {"mutation_id": BODY["mutation_id"], "request_hash": "0" * 64}
    save_choosing_downloads(api, monkeypatch)
    status, _ = api.request({**BODY, "references": [online("apple-1")]})
    assert status == 200
    assert api.fetched == []


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


@pytest.mark.parametrize("references", [[{"selection_id": "x"}] * 4,
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
    assert entry["cover_path"] == str(Path("/private/never-disclose.jpg"))
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


def test_save_never_waits_forever_for_a_runtime_lock_held_elsewhere(api, monkeypatch):
    # Owner 2026-11-18: "Saving" never ended. The save holds the album's database and folder
    # locks while it waits for the runtime lock, so that wait must end in a readable failure,
    # commit nothing, and leave no downloaded cover standing in for the saved one.
    api.resolver.user = actor("library.covers.write", "library.covers.remote.read")
    api.candidates[:] = [provider("apple-1", "apple", "Apple Music")]
    previous = jpeg((200, 0, 0))
    (api.album_root / "cover.jpg").write_bytes(previous)
    api.downloaded_image["bytes"] = jpeg((0, 0, 200))
    committed = []
    def persist(config, **kwargs):
        api.calls.append(("save", kwargs))
        kwargs["commit_guard"](lambda: committed.append(True))
    monkeypatch.setattr(routes, "persist_ordered_cover_selection_for_config", persist)
    monkeypatch.setattr(routes.state_service, "COVER_COMMIT_RUNTIME_LOCK_WAIT_SECONDS", 0.2)
    started = time.monotonic()
    with routes.state_service._CACHE_LOCK:  # e.g. a snapshot hydration that never finishes
        status, body = api.request({**BODY, "references": [online("apple-1")]})
    assert time.monotonic() - started < 5
    assert status == 503
    assert body == {"ok": False, "error": "Cover selection is temporarily unavailable. Retry the same request."}
    assert committed == []
    assert sorted(path.name for path in api.album_root.iterdir()) == ["cover.jpg", "track.flac"]
    assert (api.album_root / "cover.jpg").read_bytes() == previous
    assert next(iter(api.app.state.library_state["file_cache"].values()))["cover_path"] is None


def test_save_never_waits_forever_to_reconfirm_permission_while_holding_album_locks(api, monkeypatch):
    blocked = threading.Event()
    released = threading.Event()
    resolve = api.resolver.resolve
    def stalled_refresh(token):
        if any(name == "save" for name, _ in api.calls):
            blocked.set()
            released.wait(10)  # a thread pool or event loop that cannot answer
        return resolve(token)
    monkeypatch.setattr(api.resolver, "resolve", stalled_refresh)
    monkeypatch.setattr(routes, "_COVER_SAVE_AUTHORIZATION_WAIT_SECONDS", 0.2)
    started = time.monotonic()
    try:
        status, body = api.request()
    finally:
        released.set()
    assert blocked.is_set()
    assert time.monotonic() - started < 5
    assert status == 503 and body["ok"] is False
    assert not any(name in {"commit", "invalidate"} for name, _ in api.calls)


def test_post_commit_refresh_waits_for_the_runtime_lock_only_within_its_bound(api):
    status, _ = api.request()
    assert status == 200
    invalidation = next(args for name, args in api.calls if name == "invalidate")
    assert invalidation["lock_timeout_seconds"] == routes.state_service.COVER_COMMIT_RUNTIME_LOCK_WAIT_SECONDS


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
    local = saved["selected_covers"][0]
    # The path leaves as the field the cover reference boundary publishes as a reference.
    assert body["selected_covers"][0] == {"selection_id": "missing-local", "kind": "local",
                                          "candidate_cover_path": local["path"]}
    assert body["selected_covers"][1] == {"selection_id": "remote", "kind": "remote"}
    assert "selected_covers_last_request" not in body
    assert not any(name in {"save", "commit", "invalidate"} for name, _ in api.calls)


def test_get_remote_descriptor_requires_existing_remote_read_grant(reader):
    api, saved = reader
    api.resolver.user = actor("library.covers.lookup", "library.covers.remote.read")
    status, body = api.request(method="GET")
    assert status == 200
    local, remote = saved["selected_covers"]
    assert body["selected_covers"] == [
        {"selection_id": "missing-local", "kind": "local", "candidate_cover_path": local["path"]}, remote]


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
