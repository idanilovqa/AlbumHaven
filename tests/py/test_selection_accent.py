"""Focused contracts for the account-owned navigation selection preference."""
import asyncio
import importlib
import json

import pytest
from fastapi import FastAPI

from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.current_actor import ActorState, CurrentActor

PREFERENCE = {"enabled": True, "color": "#34ca78"}


def service_module():
    try:
        return importlib.import_module("music_app.services.selection_accent")
    except ModuleNotFoundError:
        pytest.fail("Selection accent service is not implemented")


def test_normalizes_full_spectrum_color_without_mutating_payload():
    payload = {"enabled": False, "color": "#Ab09FE"}
    assert service_module().normalize_selection_accent(payload) == {"enabled": False, "color": "#ab09fe"}
    assert payload["color"] == "#Ab09FE"


@pytest.mark.parametrize("payload", [
    None, [], {}, {"enabled": True}, {"color": "#34ca78"},
    {"enabled": 1, "color": "#34ca78"}, {"enabled": "false", "color": "#34ca78"},
    {"enabled": True, "color": "#fff"}, {"enabled": True, "color": "red"},
    {"enabled": True, "color": "#000000ff"}, {"enabled": True, "color": "#34ca78;display:none"},
    {"enabled": True, "color": "#34ca78", "account_id": 99},
])
def test_rejects_malformed_or_cross_account_payload(payload):
    with pytest.raises(ValueError):
        service_module().normalize_selection_accent(payload)


class Connection:
    def __init__(self, value=None):
        self.value = value
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        self.operations.append((str(sql), params))
        return self

    def fetchone(self):
        return {"selection_accent": self.value, "account_id": 41}

    def commit(self):
        pass


def test_store_load_projects_selection_accent_from_the_aggregate_appearance_row():
    connection = Connection()
    store = service_module().PostgresSelectionAccentStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused/test"},
        connect=lambda *args, **kwargs: connection,
    )
    assert store.load(41) is None
    query, params = connection.operations[-1]
    assert 41 in params
    assert "%s" in query
    assert "account_id" in query.lower()
    assert "app.user_appearance_preferences" in query.lower()
    assert "appearance_selection_accent_v1" not in query


def test_store_save_projects_through_revisioned_appearance_without_updating_account_metadata():
    connection = Connection(PREFERENCE)
    store = service_module().PostgresSelectionAccentStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused/test"},
        connect=lambda *args, **kwargs: connection,
    )
    assert store.save(41, PREFERENCE) == PREFERENCE
    updates = [(sql, params) for sql, params in connection.operations if "update " in " ".join(sql.lower().split())]
    assert len(updates) == 1
    sql, params = updates[0]
    assert 41 in params
    assert "app.user_appearance_preferences" in sql.lower()
    assert "selection_accent" in sql
    assert "revision" in sql.lower()
    assert "revision + 1" in sql.lower() or "revision+1" in sql.lower()
    assert "update app.accounts" not in sql.lower()
    assert "set metadata" not in sql.lower()
    assert "appearance_selection_accent_v1" not in sql


class MemoryStore:
    def __init__(self):
        self.records = {}
        self.calls = []
        self.fail = False

    def load(self, account_id):
        self.calls.append(("load", account_id))
        return self.records.get(account_id)

    def save(self, account_id, payload):
        self.calls.append(("save", account_id))
        if self.fail:
            raise RuntimeError("database unavailable")
        value = service_module().normalize_selection_accent(payload)
        self.records[account_id] = value
        return value


def app_for(store, *, state=ActorState.ACTIVE, account_id=41):
    try:
        router = importlib.import_module("music_app.routes.selection_accent_asgi").router
    except ModuleNotFoundError:
        pytest.fail("Selection accent API is not implemented")
    app = FastAPI()
    app.state.selection_accent_store = store
    app.state.auth_policy_config = {
        "hmac": {"secret": "s" * 48, "key_version": 1},
        "trusted_origins": ["https://music.test"],
    }

    @app.middleware("http")
    async def actor(request, call_next):
        request.state.current_actor = CurrentActor(state=state, account_id=account_id, session_id=11)
        return await call_next(request)

    app.include_router(router)
    return app


def request(app, method="GET", payload=None, *, origin="https://music.test", csrf=True):
    session = issue_opaque_token(random_bytes=lambda count: bytes(range(count))).raw
    token = issue_session_csrf(session, app.state.auth_policy_config)
    headers = [(b"host", b"music.test"), (b"cookie", f"__Host-album_haven_session={session}; __Host-album_haven_csrf={token}".encode())]
    body = json.dumps(payload).encode() if payload is not None else b""
    if method == "PUT":
        headers += [(b"content-type", b"application/json"), (b"origin", origin.encode())]
        if csrf:
            headers.append((b"x-album-haven-csrf", token.encode()))
    messages = []

    async def invoke():
        sent = False

        async def receive():
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(message):
            messages.append(message)

        path = "/api/account/appearance/selection-accent"
        await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                   "method": method, "scheme": "https", "path": path, "raw_path": path.encode(),
                   "query_string": b"", "headers": headers, "client": ("127.0.0.1", 50000),
                   "server": ("music.test", 443)}, receive, send)

    asyncio.run(invoke())
    start = next(message for message in messages if message["type"] == "http.response.start")
    result_headers = {key.decode(): value.decode() for key, value in start["headers"]}
    result_body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start["status"], result_headers, json.loads(result_body) if result_body else None


def test_account_preference_round_trips_and_is_isolated_between_accounts():
    store = MemoryStore()
    app = app_for(store)
    status, headers, body = request(app)
    assert status == 200
    assert "no-store" in headers["cache-control"]
    assert body == {"selection_accent": None}
    status, headers, body = request(app, "PUT", PREFERENCE)
    assert status == 200
    assert "no-store" in headers["cache-control"]
    assert body == {"selection_accent": PREFERENCE}
    assert request(app_for(store))[2] == body
    assert request(app_for(store, account_id=42))[2] == {"selection_accent": None}
    assert ("save", 41) in store.calls


@pytest.mark.parametrize("state", [ActorState.ANONYMOUS, ActorState.INACTIVE])
@pytest.mark.parametrize("method", ["GET", "PUT"])
def test_nonactive_actor_cannot_read_or_change_preference(state, method):
    store = MemoryStore()
    status, _, _ = request(app_for(store, state=state), method, PREFERENCE)
    assert status in (401, 403)
    assert store.calls == []


@pytest.mark.parametrize("options", [{"csrf": False}, {"origin": "https://evil.test"}])
def test_write_requires_same_origin_and_session_csrf(options):
    store = MemoryStore()
    status, _, _ = request(app_for(store), "PUT", PREFERENCE, **options)
    assert status == 403
    assert store.calls == []


def test_endpoint_rejects_target_account_field_and_reports_save_failure():
    store = MemoryStore()
    app = app_for(store)
    assert request(app, "PUT", dict(PREFERENCE, account_id=42))[0] == 400
    assert store.records == {}
    store.fail = True
    status, headers, _ = request(app, "PUT", PREFERENCE)
    assert status == 503
    assert "no-store" in headers["cache-control"]


def test_endpoint_rejects_oversized_json_without_a_declared_content_length():
    store = MemoryStore()

    status, headers, body = request(
        app_for(store),
        "PUT",
        {"enabled": True, "color": "#34ca78", "padding": "x" * 16_384},
    )

    assert status == 413
    assert body == {"detail": "Selection accent payload is too large."}
    assert "no-store" in headers["cache-control"]
    assert store.calls == []



def test_server_navigation_item_escapes_content_and_preserves_artist_selection_and_zero_count():
    from music_app.services.navigation_tree import render_navigation_tree_item

    html = str(render_navigation_tree_item(
        label="<Artist & guests>", href="/?artist=a&group=b", key="artist-one",
        selected=True, count=0,
    ))
    assert "&lt;Artist &amp; guests&gt;" in html
    assert 'href="/?artist=a&amp;group=b"' in html
    assert 'aria-current="true"' in html
    assert ">0<" in html
    assert 'role="treeitem"' not in html


def test_shared_admin_navigation_keeps_post_logout_and_settings_links():
    from jinja2 import Environment, FileSystemLoader
    from pathlib import Path
    from music_app.services.allowed_actions import AllowedActions

    templates = Path(__file__).resolve().parents[2] / "music_app" / "templates"
    environment = Environment(loader=FileSystemLoader(str(templates)), autoescape=True)
    html = environment.get_template("partials/admin-settings-nav.html").render(
        csrf_token="example-csrf", settings_section="account",
        account_allowed_actions=AllowedActions(keys=()),
    )
    assert 'action="/logout"' in html
    assert 'method="post"' in html
    assert 'href="/account"' in html
    assert 'href="/admin/members"' not in html


def test_compatibility_accent_stores_uppercase_json_without_changing_lowercase_wire_shape():
    connection = Connection()
    store = service_module().PostgresSelectionAccentStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused/test"},
        connect=lambda *_args: connection,
    )
    assert store.save(41, {"enabled": False, "color": "#aB09Fe"}) == {"enabled": False, "color": "#ab09fe"}
    parameters = connection.operations[-1][1]
    stored = next(value.obj if hasattr(value, "obj") else value for value in parameters if isinstance(value, dict) or hasattr(value, "obj"))
    assert stored == {"enabled": False, "color": "#AB09FE"}
