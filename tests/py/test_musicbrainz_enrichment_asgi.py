from __future__ import annotations

import json
from importlib import import_module

import pytest

from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.private_route_boundary import private_action_for_route
from tests.py.asgi_testing import (
    collect_route_paths,
    decode_json,
    run_asgi_request,
)


ARTIST_MBID = "7456103f-3c42-42d2-a2bb-5618b5db6f1b"
OTHER_MBID = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d"
SAFE_ARTIST = {
    "local_artist_id": 41,
    "local_artist_name": "Änglagård",
    "match_state": "ambiguous",
    "artist_mbid": None,
    "canonical_name": None,
    "native_name": None,
    "country": None,
    "genres": [],
    "confidence": 0.91,
    "evidence_summary": "Two candidates share the local identity evidence.",
    "unresolved_reason": "MBID: Multiple matches",
    "musicbrainz_url": None,
    "disambiguation": None,
    "artist_kind": "Group",
    "problem_occurrence_id": 19,
    "problem_reason_code": "musicbrainz_artist_ambiguous",
    "local_album_count": 3,
    "last_checked_at": "2026-11-04T12:00:00+00:00",
    "last_attempt_at": None,
    "next_attempt_at": None,
    "gallery_artist": "Änglagård",
}
SAFE_CANDIDATE = {
    "artist_mbid": ARTIST_MBID,
    "canonical_name": "Änglagård",
    "native_name": "Änglagård",
    "disambiguation": "Swedish progressive rock band",
    "artist_kind": "Group",
    "country": "Sweden",
    "genres": ["Progressive Rock"],
    "confidence": 0.91,
    "evidence_summary": "Canonical name and local album evidence agree.",
    "musicbrainz_url": f"https://musicbrainz.org/artist/{ARTIST_MBID}",
}


def route_api():
    try:
        return import_module("music_app.routes.musicbrainz_enrichment_asgi")
    except ModuleNotFoundError:
        pytest.fail("MusicBrainz enrichment API routes are not implemented yet", pytrace=False)


class Resolver:
    def __init__(self, actor):
        self.actor = actor

    def resolve(self, _session_token):
        return self.actor


class Service:
    def __init__(self):
        self.calls = []
        self.detail = {
            **SAFE_ARTIST,
            "candidates": [dict(SAFE_CANDIDATE)],
        }

    def list_present_artist_review(self):
        self.calls.append(("review", {}))
        return [dict(SAFE_ARTIST)]

    def get_artist_problem(self, *, local_artist_id):
        self.calls.append(("detail", {"local_artist_id": local_artist_id}))
        return dict(self.detail) if local_artist_id == 41 else None

    def enqueue_eligible_artists(self, *, reason):
        self.calls.append(("sync", {"reason": reason}))
        return {"enqueued_count": 1}

    def enqueue_artist(self, *, local_artist_id, reason):
        self.calls.append(
            ("retry", {"local_artist_id": local_artist_id, "reason": reason})
        )
        return {"enqueued": local_artist_id == 41}

    def validate_manual_artist(self, *, local_artist_id, artist_reference):
        self.calls.append(
            (
                "validate",
                {
                    "local_artist_id": local_artist_id,
                    "artist_reference": artist_reference,
                },
            )
        )
        return dict(SAFE_CANDIDATE) if local_artist_id == 41 else None

    def assign_manual_match(
        self,
        *,
        local_artist_id,
        actor_account_id,
        artist_mbid,
        evidence_summary,
        request_ref,
    ):
        self.calls.append(
            (
                "assign",
                {
                    "local_artist_id": local_artist_id,
                    "actor_account_id": actor_account_id,
                    "artist_mbid": artist_mbid,
                    "evidence_summary": evidence_summary,
                    "request_ref": request_ref,
                },
            )
        )
        return {"assigned": local_artist_id == 41}


def actor_with(*actions, library_id=23, owner=True, membership_role=None):
    relationship_role = membership_role or ("owner" if owner else "member")
    return CurrentActor(
        state=ActorState.ACTIVE,
        account_id=7,
        session_id=11,
        current_library_id=library_id,
        library_relationships=(
            LibraryRelationship(library_id, relationship_role, owner),
        ),
        capability_grants=tuple(
            CapabilityGrant(action, "library", library_id) for action in actions
        ),
    )


def app_for(actor, service):
    from music_app import create_asgi_app

    app = create_asgi_app()
    app.state.current_actor_resolver = Resolver(actor)
    app.state.musicbrainz_enrichment_api_service = service
    return app


def request(app, method, path, *, json_body=None):
    status, _headers, body = run_asgi_request(
        app,
        method,
        path,
        json_body=json_body,
    )
    return status, decode_json(body)


def test_routes_are_registered_with_exact_capability_actions():
    route_api()
    app = app_for(actor_with("library.problems.read"), Service())
    paths = collect_route_paths(app)

    expected = {
        "/api/musicbrainz/artists/review": ("GET", "library.problems.read"),
        "/api/musicbrainz/artists/status": ("GET", "library.problems.read"),
        "/api/musicbrainz/artists/{local_artist_id}": (
            "GET",
            "library.problems.read",
        ),
        "/api/musicbrainz/artists/sync": (
            "POST",
            "catalogue.enrichment.request",
        ),
        "/api/musicbrainz/artists/{local_artist_id}/retry": (
            "POST",
            "catalogue.enrichment.request",
        ),
        "/api/musicbrainz/artists/{local_artist_id}/validate": (
            "POST",
            "library.metadata_matches.review",
        ),
        "/api/musicbrainz/artists/{local_artist_id}/match": (
            "PUT",
            "library.metadata_matches.review",
        ),
    }
    for path, (method, action) in expected.items():
        assert path in paths
        assert private_action_for_route(method, path) == action

    assert "/api/musicbrainz/artists/{local_artist_id}/clear" not in paths
    assert private_action_for_route("GET", "/view-data") == "library.browse.read"
    assert private_action_for_route("GET", "/album-details") == "library.browse.read"


def test_review_report_and_problem_detail_return_only_safe_current_library_fields():
    service = Service()
    service.detail.update(
        {
            "private_path": "C:/private/music/artist.flac",
            "provider_payload": {"token": "secret"},
            "library_id": 99,
            "database_url": "postgresql://secret",
        }
    )
    service.detail["candidates"][0]["raw_response"] = {"credential": "secret"}
    app = app_for(actor_with("library.problems.read"), service)

    review_status, review = request(app, "GET", "/api/musicbrainz/artists/review")
    detail_status, detail = request(app, "GET", "/api/musicbrainz/artists/41")

    assert review_status == detail_status == 200
    assert review == {"artists": [SAFE_ARTIST]}
    assert detail == {"artist": {**SAFE_ARTIST, "candidates": [SAFE_CANDIDATE]}}
    serialized = json.dumps({"review": review, "detail": detail})
    for forbidden in (
        "private_path",
        "provider_payload",
        "secret",
        "library_id",
        "database_url",
        "credential",
    ):
        assert forbidden not in serialized


def test_sync_and_retry_derive_scope_server_side_and_reject_client_library_scope():
    service = Service()
    app = app_for(actor_with("catalogue.enrichment.request"), service)

    sync_status, sync = request(app, "POST", "/api/musicbrainz/artists/sync")
    retry_status, retry = request(
        app,
        "POST",
        "/api/musicbrainz/artists/41/retry",
    )
    invalid_status, _invalid = request(
        app,
        "POST",
        "/api/musicbrainz/artists/41/retry",
        json_body={"library_id": 99, "account_id": 88},
    )

    assert sync_status == retry_status == 202
    assert sync == {"enqueued_count": 1}
    assert retry == {"enqueued": True}
    assert invalid_status == 400
    assert service.calls == [
        ("sync", {"reason": "library_menu_sync"}),
        ("retry", {"local_artist_id": 41, "reason": "authorized_retry"}),
    ]


def test_manual_validation_and_assignment_use_server_actor_and_no_client_scope():
    service = Service()
    app = app_for(actor_with("library.metadata_matches.review"), service)

    validate_status, validated = request(
        app,
        "POST",
        "/api/musicbrainz/artists/41/validate",
        json_body={"artist_reference": f"https://musicbrainz.org/artist/{ARTIST_MBID}"},
    )
    assign_status, assigned = request(
        app,
        "PUT",
        "/api/musicbrainz/artists/41/match",
        json_body={
            "artist_mbid": ARTIST_MBID,
            "evidence_summary": "Owner selected the validated candidate.",
        },
    )

    assert validate_status == 200
    assert validated == {"candidate": SAFE_CANDIDATE}
    assert assign_status == 200
    assert assigned == {"assigned": True}
    assert service.calls[0] == (
        "validate",
        {
            "local_artist_id": 41,
            "artist_reference": f"https://musicbrainz.org/artist/{ARTIST_MBID}",
        },
    )
    method, kwargs = service.calls[1]
    assert method == "assign"
    assert kwargs["local_artist_id"] == 41
    assert kwargs["actor_account_id"] == 7
    assert kwargs["artist_mbid"] == ARTIST_MBID
    assert isinstance(kwargs["request_ref"], str) and kwargs["request_ref"]
    assert "library_id" not in kwargs


def test_manual_assignment_rejects_client_supplied_actor_or_library_scope():
    service = Service()
    app = app_for(actor_with("library.metadata_matches.review"), service)

    status, payload = request(
        app,
        "PUT",
        "/api/musicbrainz/artists/41/match",
        json_body={
            "artist_mbid": ARTIST_MBID,
            "evidence_summary": "Attempted client-selected scope.",
            "actor_account_id": 88,
            "library_id": 99,
        },
    )

    assert status == 400
    assert payload == {"detail": "Invalid MusicBrainz match request."}
    assert service.calls == []


@pytest.mark.parametrize(
    "artist_reference",
    [
        "not-an-mbid",
        f"https://musicbrainz.org/release/{ARTIST_MBID}",
        f"https://example.test/artist/{ARTIST_MBID}",
    ],
)
def test_manual_validation_rejects_invalid_or_wrong_entity_references(
    artist_reference,
):
    service = Service()
    app = app_for(actor_with("library.metadata_matches.review"), service)

    status, payload = request(
        app,
        "POST",
        "/api/musicbrainz/artists/41/validate",
        json_body={"artist_reference": artist_reference},
    )

    assert status == 400
    assert payload == {"detail": "Enter a valid MusicBrainz artist URL or MBID."}
    assert service.calls == []


@pytest.mark.parametrize(
    ("path", "method", "capability"),
    [
        ("/api/musicbrainz/artists/review", "GET", "library.problems.read"),
        ("/api/musicbrainz/artists/41", "GET", "library.problems.read"),
        (
            "/api/musicbrainz/artists/sync",
            "POST",
            "catalogue.enrichment.request",
        ),
        (
            "/api/musicbrainz/artists/41/retry",
            "POST",
            "catalogue.enrichment.request",
        ),
        (
            "/api/musicbrainz/artists/41/validate",
            "POST",
            "library.metadata_matches.review",
        ),
        (
            "/api/musicbrainz/artists/41/match",
            "PUT",
            "library.metadata_matches.review",
        ),
    ],
)
def test_each_endpoint_denies_an_actor_missing_its_exact_capability(
    path,
    method,
    capability,
):
    service = Service()
    app = app_for(actor_with(), service)

    status, payload = request(
        app,
        method,
        path,
        json_body={} if method != "GET" else None,
    )

    assert status == 403, capability
    assert payload == {"detail": "Action not permitted."}
    assert service.calls == []


@pytest.mark.parametrize(
    ("path", "method", "capability"),
    [
        ("/api/musicbrainz/artists/review", "GET", "library.problems.read"),
        ("/api/musicbrainz/artists/41", "GET", "library.problems.read"),
        (
            "/api/musicbrainz/artists/sync",
            "POST",
            "catalogue.enrichment.request",
        ),
        (
            "/api/musicbrainz/artists/41/retry",
            "POST",
            "catalogue.enrichment.request",
        ),
        (
            "/api/musicbrainz/artists/41/validate",
            "POST",
            "library.metadata_matches.review",
        ),
        (
            "/api/musicbrainz/artists/41/match",
            "PUT",
            "library.metadata_matches.review",
        ),
    ],
)
def test_administrator_is_denied_owner_only_management_even_with_direct_capability(
    path,
    method,
    capability,
):
    service = Service()
    admin = actor_with(
        capability,
        owner=False,
        membership_role="administrator",
    )
    app = app_for(admin, service)

    status, payload = request(
        app,
        method,
        path,
        json_body={} if method != "GET" else None,
    )

    assert status == 403
    assert payload == {"detail": "Action not permitted."}
    assert service.calls == []


@pytest.mark.parametrize(
    ("path", "method", "capability"),
    [
        (
            "/api/musicbrainz/artists/review",
            "GET",
            "library.problems.read",
        ),
        (
            "/api/musicbrainz/artists/41",
            "GET",
            "library.problems.read",
        ),
        (
            "/api/musicbrainz/artists/41/retry",
            "POST",
            "catalogue.enrichment.request",
        ),
        (
            "/api/musicbrainz/artists/41/match",
            "PUT",
            "library.metadata_matches.review",
        ),
    ],
)
def test_generic_repair_permission_does_not_authorize_musicbrainz_management(
    path,
    method,
    capability,
):
    service = Service()
    app = app_for(actor_with("library.files.repair", owner=False), service)

    status, payload = request(
        app,
        method,
        path,
        json_body={} if method != "GET" else None,
    )

    assert status == 403, capability
    assert payload == {"detail": "Action not permitted."}
    assert service.calls == []


@pytest.mark.parametrize(
    ("path", "method", "capability"),
    [
        ("/api/musicbrainz/artists/99", "GET", "library.problems.read"),
        (
            "/api/musicbrainz/artists/99/retry",
            "POST",
            "catalogue.enrichment.request",
        ),
        (
            "/api/musicbrainz/artists/99/validate",
            "POST",
            "library.metadata_matches.review",
        ),
        (
            "/api/musicbrainz/artists/99/match",
            "PUT",
            "library.metadata_matches.review",
        ),
    ],
)
def test_cross_library_or_unknown_artist_is_non_disclosing_not_found(
    path,
    method,
    capability,
):
    service = Service()
    app = app_for(actor_with(capability), service)
    body = None
    if path.endswith("/validate"):
        body = {"artist_reference": ARTIST_MBID}
    elif path.endswith("/match"):
        body = {
            "artist_mbid": OTHER_MBID,
            "evidence_summary": "Validated candidate.",
        }

    status, payload = request(app, method, path, json_body=body)

    assert status == 404
    assert payload == {"detail": "Artist was not found."}
    assert "library" not in json.dumps(payload).lower()


def test_service_failure_returns_safe_error_and_does_not_log_private_exception_text():
    class FailingService(Service):
        def enqueue_artist(self, **_kwargs):
            raise RuntimeError(
                "postgresql://user:password@private-host path=C:/private/music"
            )

    class Logger:
        def __init__(self):
            self.messages = []

        def warning(self, message, *args, **kwargs):
            self.messages.append((message, args, kwargs))

    service = FailingService()
    app = app_for(actor_with("catalogue.enrichment.request"), service)
    logger = Logger()
    app.state.logger = logger

    status, payload = request(
        app,
        "POST",
        "/api/musicbrainz/artists/41/retry",
    )

    assert status == 503
    assert payload == {"detail": "MusicBrainz enrichment is unavailable."}
    serialized = json.dumps(payload) + repr(logger.messages)
    for forbidden in ("password", "private-host", "C:/private", "postgresql://"):
        assert forbidden not in serialized


def test_gallery_status_says_metadata_pending_while_problematic_files_keeps_the_mbid_prefix():
    class AttentionService(Service):
        def list_artist_attention(self):
            return [
                {"local_artist_id": 41, "local_artist_name": "Pending Artist", "match_state": None, "problem_occurrence_id": 7,
                 "problem_reason_code": reason, "unresolved_reason": "MBID: Metadata pending"}
                for reason in ("musicbrainz_matched_entity_unavailable", "musicbrainz_mirror_replication_pending")
            ] + [
                {"local_artist_id": 42, "local_artist_name": "Unknown Artist", "match_state": None, "problem_occurrence_id": 8,
                 "problem_reason_code": "musicbrainz_artist_not_found", "unresolved_reason": "MBID: Not found"},
            ]

    app = app_for(actor_with("library.problems.read"), AttentionService())
    status, payload = request(app, "GET", "/api/musicbrainz/artists/status")

    assert status == 200
    assert [artist["unresolved_reason"] for artist in payload["artists"]] == ["Metadata pending", "Metadata pending", "MBID: Not found"]
    assert all("problem_reason_code" not in artist for artist in payload["artists"])


@pytest.mark.parametrize("owner", [True, False])
def test_owner_shell_status_and_artist_status_together_enable_gallery_warnings(owner):
    """The Gallery shows artist warnings only when /status grants the action and the artist status lists the problem."""

    class AttentionService(Service):
        def list_artist_attention(self):
            return [{"local_artist_id": 158170, "local_artist_name": "3 Crows", "gallery_artist": "3 Crows", "match_state": None,
                     "problem_occurrence_id": 424, "problem_reason_code": "musicbrainz_artist_not_found",
                     "unresolved_reason": "MBID: Not found"}]

    actor = (actor_with("app.status.read", "library.problems.read", "catalogue.enrichment.request", owner=True) if owner
             else actor_with("app.status.read", "capability.view", owner=False))
    app = app_for(actor, AttentionService())

    shell_status, shell = request(app, "GET", "/status")
    artist_status, artists = request(app, "GET", "/api/musicbrainz/artists/status")

    assert shell_status == 200
    assert (shell["allowed_actions"].get("catalogue.enrichment.request") is True) is owner
    if owner:
        assert artist_status == 200
        assert artists["artists"] == [{"local_artist_id": 158170, "local_artist_name": "3 Crows", "gallery_artist": "3 Crows",
                                       "match_state": None, "problem_occurrence_id": 424, "unresolved_reason": "MBID: Not found"}]
    else:
        assert artist_status == 403
