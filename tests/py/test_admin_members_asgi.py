import asyncio
from datetime import datetime, timezone
import json

from fastapi import FastAPI

from music_app.services.admin_members_postgres import (
    AdminMemberSummary,
    AdminMembersRoster,
)
from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.current_actor import (
    ActorState,
    CurrentActor,
    LibraryRelationship,
)


NOW = datetime(2026, 8, 31, 22, 0, tzinfo=timezone.utc)


class Service:
    def __init__(self):
        self.calls = []
        self.update_calls = []
        self.revoke_calls = []

    def load_roster(self, **kwargs):
        self.calls.append(kwargs)
        return AdminMembersRoster(
            library_id=9,
            library_name="Rendref's Library",
            members=(
                AdminMemberSummary(
                    7, "Rendref", "rendref@example.test", True, True, "owner",
                    (), None, 1, NOW,
                ),
                AdminMemberSummary(
                    41, "test.user+1", "test.user+1@example.test", True, False,
                    "member", ("library.browse.read", "library.playlists.create"),
                    "sent", 2, NOW,
                ),
            ),
        )

    def update_account(self, **kwargs):
        self.update_calls.append(kwargs)

    def revoke_sessions(self, **kwargs):
        self.revoke_calls.append(kwargs)


def _app():
    from music_app.routes.admin_asgi import router

    app = FastAPI()
    service = Service()
    app.state.admin_members_service = service
    app.state.admin_member_mutation_service = service
    app.state.auth_policy_config = {
        "hmac": {"secret": "s" * 48, "key_version": 1},
        "trusted_origins": ["https://music.test"],
    }

    @app.middleware("http")
    async def actor(request, call_next):
        request.state.current_actor = CurrentActor(
            state=ActorState.ACTIVE,
            account_id=7,
            session_id=11,
            username_display="Rendref",
            authenticated_at=NOW,
            is_bootstrap_owner=True,
            current_library_id=9,
            library_relationships=(LibraryRelationship(9, "owner", True),),
        )
        return await call_next(request)

    app.include_router(router)
    return app, service


async def _get_async(app, path, session):
    messages = []
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": [
                (b"host", b"music.test"),
                (b"cookie", f"__Host-album_haven_session={session}".encode("ascii")),
            ],
            "client": ("127.0.0.1", 50000),
            "server": ("music.test", 443),
        },
        receive,
        send,
    )
    start = next(item for item in messages if item["type"] == "http.response.start")
    headers = {
        key.decode("latin-1"): value.decode("latin-1")
        for key, value in start["headers"]
    }
    body = b"".join(
        item.get("body", b"") for item in messages if item["type"] == "http.response.body"
    ).decode("utf-8")
    return start["status"], headers, body


def _get(app, path):
    session = issue_opaque_token(random_bytes=lambda count: bytes(range(count))).raw
    return asyncio.run(_get_async(app, path, session))


async def _json_request_async(app, method, path, session, payload):
    body = json.dumps(payload).encode("utf-8")
    messages = []
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        messages.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "https",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": [
                (b"host", b"music.test"),
                (b"cookie", f"__Host-album_haven_session={session}".encode("ascii")),
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
            "client": ("127.0.0.1", 50000),
            "server": ("music.test", 443),
        },
        receive,
        send,
    )
    start = next(item for item in messages if item["type"] == "http.response.start")
    response = b"".join(
        item.get("body", b"") for item in messages if item["type"] == "http.response.body"
    )
    return start["status"], response


def _json_request(app, method, path, payload):
    session = issue_opaque_token(random_bytes=lambda count: bytes(range(count))).raw
    return asyncio.run(_json_request_async(app, method, path, session, payload))


def test_members_roster_renders_operational_state_without_credentials_or_paths():
    app, service = _app()

    status, headers, body = _get(app, "/admin/members")

    assert status == 200
    assert headers["cache-control"] == "no-store, max-age=0"
    assert "Users &amp; access" in body
    assert "test.user+1@example.test" in body
    assert "2 active sessions" in body
    assert "Welcome sent" in body
    assert "encoded_hash" not in body
    assert "root_path" not in body
    assert service.calls == [{"actor_account_id": 7, "library_id": 9}]


def test_members_add_and_edit_are_in_place_pages_with_back_navigation():
    app, _service = _app()

    new_status, _headers, new_body = _get(app, "/admin/accounts/new")
    edit_status, _headers, edit_body = _get(app, "/admin/accounts/41")

    assert new_status == 200
    assert "Add user" in new_body
    assert "The account can sign in as soon as you create it." in new_body
    assert "Back to users" in new_body
    assert "Plus-addressing remains intact." in new_body
    assert edit_status == 200
    assert "Edit user" in edit_body
    assert "test.user+1" in edit_body
    assert "Listener · Customized" in edit_body
    assert "Back to users" in edit_body
    assert "modal" not in edit_body.casefold()


def test_member_update_and_session_revoke_use_bounded_confirmed_contracts():
    app, service = _app()
    update_payload = {
        "is_active": False,
        "current_library_access": True,
        "capability_keys": ["library.browse.read"],
        "confirm_disable": True,
        "confirm_remove_access": False,
    }

    update_status, update_body = _json_request(
        app, "PATCH", "/admin/accounts/41", update_payload
    )
    revoke_status, revoke_body = _json_request(
        app, "POST", "/admin/accounts/41/sessions/revoke", {"confirmed": True}
    )

    assert update_status == 200
    assert update_body == b'{"updated":true}'
    assert service.update_calls[0]["actor_account_id"] == 7
    assert service.update_calls[0]["target_account_id"] == 41
    assert service.update_calls[0]["is_active"] is False
    assert revoke_status == 200
    assert revoke_body == b'{"revoked":true}'
    assert service.revoke_calls[0]["target_account_id"] == 41
    assert service.revoke_calls[0]["confirmed"] is True
