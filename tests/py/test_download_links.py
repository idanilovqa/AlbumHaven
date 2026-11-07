"""Cookie-less download links: allowlisted paths, authorized when issued and when served."""

import asyncio
import json
import logging
from datetime import timedelta
from types import SimpleNamespace
from urllib.parse import quote
from uuid import uuid4

import pytest
from fastapi import FastAPI

from music_app.routes.download_links_asgi import router
from music_app.services.android_download_links import DownloadLinks
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship
from music_app.services.current_actor_postgres import PostgresCurrentActorResolver
from music_app.services.foobar_integrations import resolve_foobar_reference_asset
from music_app.services.private_route_boundary import _is_public, install_private_route_boundary
from tests.e2e.support import isolatedPostgres
from tests.py.android_attestation_testing import NOW
from tests.py.test_isolated_postgres_live import _dedicated_database_urls_or_skip, _drop_application_schemas

AUTH = {"hmac": {"secret": "0123456789abcdef0123456789abcdef", "key_version": 7}}
SESSION = "s" * 43
ASSET_KEY = "text-tools-standard-preset"
ASSET_PATH = f"/utilities/integrations/foobar/assets/{ASSET_KEY}?download=1"
ASSET_BYTES = resolve_foobar_reference_asset(ASSET_KEY)[1].read_bytes()


def _owner(account_id=7):
    return CurrentActor(state=ActorState.ACTIVE, account_id=account_id, session_id=11, username_display="owner",
                        is_bootstrap_owner=True)


def _listener(account_id=7):
    # A library listener has no integration.foobar.read.
    return CurrentActor(state=ActorState.ACTIVE, account_id=account_id, session_id=11, username_display="listener",
                        current_library_id=41, library_relationships=(LibraryRelationship(41, "listener", False),))


class _Resolver:
    def __init__(self, session_actor, account_actor=None):
        self.session_actor = session_actor
        self.account_actor = account_actor or session_actor
        self.accounts = []

    def resolve(self, token):
        return self.session_actor if token == SESSION else CurrentActor.anonymous()

    def resolve_account(self, account_id):
        self.accounts.append(account_id)
        return self.account_actor if account_id == self.account_actor.account_id else CurrentActor.anonymous()


class _Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now


def _app(resolver, clock=None):
    app = FastAPI()
    app.state.current_actor_resolver = resolver
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = AUTH
    app.state.download_links = DownloadLinks(AUTH, clock=clock or _Clock())
    install_private_route_boundary(app)
    app.include_router(router)
    return app


def _request(app, method, path, *, session=None, body=None, csrf=True):
    headers = [(b"host", b"albumhaven.test")]
    if session:
        token = issue_session_csrf(session, AUTH)
        headers.append((b"cookie", f"__Host-album_haven_session={session}; __Host-album_haven_csrf={token}".encode()))
        if csrf:
            headers += [(b"origin", b"https://albumhaven.test"), (b"x-album-haven-csrf", token.encode())]
    raw = json.dumps(body).encode() if body is not None else b""
    if raw:
        headers += [(b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode())]
    messages, sent = [], False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": raw, "more_body": False}

    async def send(message):
        messages.append(message)

    asyncio.run(app(
        {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "https",
         "path": path, "raw_path": quote(path).encode("ascii"), "query_string": b"", "headers": headers,
         "client": ("127.0.0.1", 50000), "server": ("albumhaven.test", 443)},
        receive, send,
    ))
    start = next(item for item in messages if item["type"] == "http.response.start")
    data = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    return start["status"], {k.decode().lower(): v.decode() for k, v in start["headers"]}, data


def _issue(app, path=ASSET_PATH, **options):
    status, headers, body = _request(app, "POST", "/downloads/links", session=SESSION, body={"path": path}, **options)
    return status, headers, json.loads(body)


def test_a_signed_in_account_downloads_an_asset_through_a_cookie_less_link(caplog):
    caplog.set_level(logging.DEBUG)
    resolver = _Resolver(_owner())
    app = _app(resolver)
    status, headers, link = _issue(app)
    assert status == 200
    assert headers["cache-control"] == "no-store"
    assert link["url"].startswith("/downloads/")
    assert link["expiresAt"] == (NOW + timedelta(minutes=5)).isoformat()

    status, headers, body = _request(app, "GET", link["url"])
    assert (status, body) == (200, ASSET_BYTES)
    assert headers["cache-control"] == "no-store"
    assert headers["content-disposition"].startswith("attachment;")
    assert resolver.accounts == [7]
    assert _request(app, "HEAD", link["url"])[0] == 200

    # The link names nothing but itself; the file's location never appears in a response or log.
    assert sorted(link) == ["expiresAt", "url"]
    assert link["url"].rsplit("/", 1)[1] not in caplog.text
    assert str(resolve_foobar_reference_asset(ASSET_KEY)[1].parent) not in caplog.text + json.dumps(link) + str(headers)


@pytest.mark.parametrize(
    "path",
    [
        f"/utilities/integrations/foobar/assets/{ASSET_KEY}",
        f"/utilities/integrations/foobar/assets/{ASSET_KEY}?download=1&x=1",
        f"/utilities/integrations/foobar/assets/{ASSET_KEY}?download=true",
        f"https://albumhaven.test/utilities/integrations/foobar/assets/{ASSET_KEY}?download=1",
        "/utilities/integrations/foobar/assets/..%2F..%2Fconfig.py?download=1",
        "/utilities/integrations/foobar/assets/../../config.py?download=1",
        "/utilities/integrations/foobar/assets/unknown-asset?download=1",
        "/utilities/integrations/foobar/help",
        "/track?path=C:/Music/a.flac",
        "/artifacts/android/sandbox/manifest.json",
        "/downloads/links",
        "",
        None,
        7,
        ["/utilities/integrations/foobar/assets/text-tools-standard-preset?download=1"],
    ],
)
def test_only_allowlisted_download_paths_get_a_link(path):
    status, headers, body = _issue(_app(_Resolver(_owner())), path)
    assert (status, body) == (403, {"detail": "Download unavailable.", "code": "download_unavailable"})
    assert headers["cache-control"] == "no-store"


@pytest.mark.parametrize("body", [None, [], {"url": ASSET_PATH}, "x" * 4096])
def test_a_malformed_link_request_is_refused(body):
    status, _, response = _request(_app(_Resolver(_owner())), "POST", "/downloads/links", session=SESSION, body=body)
    assert (status, json.loads(response)["code"]) == (403, "download_unavailable")


def test_issuing_a_link_needs_a_session_and_its_csrf_token():
    app = _app(_Resolver(_owner()))
    assert _request(app, "POST", "/downloads/links", body={"path": ASSET_PATH})[0] == 401
    status, _, body = _request(app, "POST", "/downloads/links", session=SESSION, body={"path": ASSET_PATH}, csrf=False)
    assert (status, json.loads(body)) == (403, {"detail": "CSRF validation failed."})


def test_the_target_routes_authorization_runs_when_a_link_is_issued():
    status, _, body = _issue(_app(_Resolver(_listener())))
    assert (status, body["code"]) == (403, "download_unavailable")


def test_the_target_routes_authorization_runs_again_when_a_link_is_served():
    resolver = _Resolver(_owner())
    app = _app(resolver)
    url = _issue(app)[2]["url"]
    resolver.account_actor = _listener()
    status, headers, body = _request(app, "GET", url)
    assert (status, body) == (403, b"Download link is not valid.")
    assert headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "standing",
    [CurrentActor(state=ActorState.INACTIVE, account_id=7, username_display="owner"), CurrentActor.anonymous()],
    ids=["disabled", "deleted"],
)
def test_a_link_is_refused_once_its_account_is_disabled_or_gone(standing):
    resolver = _Resolver(_owner())
    app = _app(resolver)
    url = _issue(app)[2]["url"]
    resolver.account_actor = standing
    assert _request(app, "GET", url)[:3:2] == (403, b"Download link is not valid.")


def test_a_link_expires_after_five_minutes():
    clock = _Clock()
    app = _app(_Resolver(_owner()), clock)
    url = _issue(app)[2]["url"]
    clock.now += timedelta(minutes=5) - timedelta(seconds=1)
    assert _request(app, "GET", url)[0] == 200
    clock.now += timedelta(seconds=1)
    assert _request(app, "GET", url)[:3:2] == (403, b"Download link is not valid.")


def test_a_link_names_one_path_and_one_account_under_its_own_key():
    from music_app.services.signed_links import LinkSigner

    resolver = _Resolver(_owner())
    app = _app(resolver)
    token = _issue(app)[2]["url"].rsplit("/", 1)[1]
    payload, signature = token.split(".")
    # An APK download token's key cannot sign a download link, nor can a link be re-pointed.
    artifact_signer = LinkSigner(AUTH, b"album-haven-android-artifact-download-v1\0")
    claims = {"v": 1, "a": 7, "p": "/utilities/integrations/foobar/assets/backup-foobar-db-script?download=1",
              "e": int((NOW + timedelta(minutes=5)).timestamp())}
    for forged in (artifact_signer.sign(claims), f"{artifact_signer.sign(claims).split('.')[0]}.{signature}",
                   f"{payload}.{signature[:-1]}A" if signature[-1] != "A" else f"{payload}.{signature[:-1]}B"):
        assert _request(app, "GET", f"/downloads/{forged}")[0] == 403
    assert resolver.accounts == []


@pytest.mark.parametrize("path", ["/downloads/", "/downloads/not-a-token", "/downloads/links", "/downloads/a.b"])
def test_a_malformed_link_is_refused_without_a_session(path):
    status, headers, body = _request(_app(_Resolver(_owner())), "GET", path)
    assert status in {403, 404, 405}
    assert ASSET_BYTES not in body


@pytest.mark.parametrize(
    ("method", "path", "public"),
    [("GET", "/downloads/token", True), ("HEAD", "/downloads/token", True), ("POST", "/downloads/links", False),
     ("POST", "/downloads/token", False), ("GET", "/downloads", False)],
)
def test_only_reading_a_link_is_public(method, path, public):
    assert _is_public(method, path) is public


def test_access_logs_never_record_a_link_token():
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:5", "GET", "/downloads/secret.token", "1.1", 200), None)
    for item in logging.getLogger("uvicorn.access").filters:
        assert item.filter(record)
    assert "secret" not in record.getMessage()
    assert "/downloads/[redacted]" in record.getMessage()


def test_a_server_without_a_policy_secret_issues_and_honours_no_links():
    links = DownloadLinks({})
    assert links.available is False
    assert links.resolve(DownloadLinks(AUTH).issue(7, ASSET_PATH)["url"].rsplit("/", 1)[1]) is None


# --- Against an isolated Postgres --------------------------------------------------------------


@pytest.fixture
def database(monkeypatch):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            owner = connection.execute("select account_id from app.bootstrap_owners").fetchone()["account_id"]
        yield SimpleNamespace(setup_url=setup_url, runtime_url=runtime_url, owner=owner)
    finally:
        isolatedPostgres.reset_application_tables(setup_url)


class _SessionlessResolver(PostgresCurrentActorResolver):
    """The real account resolution; the browser session is faked as signed in to [owner]."""

    def __init__(self, database):
        super().__init__({"ALBUM_HAVEN_APP_DATABASE_URL": database.runtime_url}, session_service=object(),
                         connect=isolatedPostgres._connect)
        self.owner = database.owner

    def resolve(self, token):
        return _owner(self.owner) if token == SESSION else CurrentActor.anonymous()


@pytest.mark.parametrize(
    "disable",
    ["update app.accounts set is_active = false where id = %s",
     "update app.accounts set disabled_at = now() where id = %s"],
    ids=["inactive", "disabled_at"],
)
def test_a_link_is_refused_once_its_account_is_disabled_in_postgres(database, disable):
    app = _app(_SessionlessResolver(database))
    url = _issue(app)[2]["url"]
    assert _request(app, "GET", url)[:3:2] == (200, ASSET_BYTES)
    with isolatedPostgres._connect(database.setup_url) as connection:
        connection.execute(disable, (database.owner,))
    assert _request(app, "GET", url)[:3:2] == (403, b"Download link is not valid.")


def test_an_unknown_account_resolves_to_no_one(database):
    resolver = _SessionlessResolver(database)
    assert resolver.resolve_account(10 ** 9 + int(uuid4().int % 1000)).state is ActorState.ANONYMOUS
    assert resolver.resolve_account(database.owner).state is ActorState.ACTIVE
