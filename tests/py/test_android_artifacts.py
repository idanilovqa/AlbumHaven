"""Android update artifacts: signed-in, attested installs only, against an isolated Postgres."""

import asyncio
import base64
import hashlib
import json
import logging
from datetime import timedelta
from types import SimpleNamespace
from urllib.parse import quote
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI

from music_app.routes.android_artifacts_asgi import ARTIFACTS_DIR_ENV, router
from music_app.services.android_artifact_access import (
    ALLOW_SOFTWARE_ENV,
    SIGNING_CERTIFICATES_ENV,
    AndroidArtifactAccess,
    request_message,
)
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.current_actor import ActorState, CurrentActor
from music_app.services.private_route_boundary import _is_public, install_private_route_boundary
from tests.e2e.support import isolatedPostgres
from tests.py.android_attestation_testing import NOW, SIGNER, AttestationPki
from tests.py.test_isolated_postgres_live import _dedicated_database_urls_or_skip, _drop_application_schemas

AUTH = {"hmac": {"secret": "0123456789abcdef0123456789abcdef", "key_version": 7}}
APK = b"PK\x03\x04apk-bytes"
SESSION_A, SESSION_A2, SESSION_B = "s" * 43, "w" * 43, "g" * 43  # canonical opaque tokens


@pytest.fixture
def artifacts(tmp_path, monkeypatch):
    root = tmp_path / "android-artifacts"
    for channel in ("stable", "sandbox"):
        (root / channel).mkdir(parents=True)
    (root / "sandbox" / "manifest.json").write_text('{"schemaVersion":1}', encoding="utf-8")
    (root / "sandbox" / "album-haven-2.apk").write_bytes(APK)
    (root / "sandbox" / "album-haven-3.apk").write_bytes(b"other")
    (root / "stable" / "manifest.json").write_text('{"schemaVersion":1,"channel":"stable"}', encoding="utf-8")
    (root / "private.txt").write_text("not an artifact", encoding="utf-8")
    monkeypatch.setenv(ARTIFACTS_DIR_ENV, str(root))
    return root


class _Resolver:
    def __init__(self, actors):
        self.actors = actors

    def resolve(self, token):
        return self.actors.get(token) or CurrentActor.anonymous()


def _actor(account_id, session_id):
    return CurrentActor(state=ActorState.ACTIVE, account_id=account_id, session_id=session_id,
                        username_display=f"account {account_id}")


def _app(actors=None, access=None):
    app = FastAPI()
    app.state.current_actor_resolver = _Resolver(actors or {})
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = AUTH
    if access is not None:
        app.state.android_artifact_access = access
    install_private_route_boundary(app)
    app.include_router(router)
    return app


def _request(app, method, path, *, session=None, headers=None, body=b"", receive=None):
    request_headers = [(b"host", b"albumhaven.test")]
    if session:
        csrf = issue_session_csrf(session, AUTH)
        request_headers += [
            (b"cookie", f"__Host-album_haven_session={session}; __Host-album_haven_csrf={csrf}".encode()),
            (b"origin", b"https://albumhaven.test"),
            (b"x-album-haven-csrf", csrf.encode()),
        ]
    for key, value in (headers or {}).items():
        request_headers.append((key.lower().encode(), value.encode()))
    if body:
        request_headers += [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    messages, sent = [], False

    async def receive_body():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        messages.append(message)

    asyncio.run(app(
        {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
            "scheme": "https", "path": path, "raw_path": quote(path).encode("ascii"), "query_string": b"",
            "headers": request_headers, "client": ("127.0.0.1", 50000), "server": ("albumhaven.test", 443),
        },
        receive or receive_body,
        send,
    ))
    start = next(item for item in messages if item["type"] == "http.response.start")
    data = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    response_headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in start["headers"]}
    return start["status"], response_headers, data


# --- Without a database ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/artifacts/android/challenge"),
        ("POST", "/artifacts/android/attest"),
        ("GET", "/artifacts/android/sandbox/manifest.json"),
        ("GET", "/artifacts/android/stable/manifest.json"),
        ("HEAD", "/artifacts/android/sandbox/manifest.json"),
        ("POST", "/artifacts/android/sandbox/album-haven-2.apk"),
        ("GET", "/artifacts/android/sandbox/album-haven-2.apk"),
        ("HEAD", "/artifacts/android/sandbox/album-haven-2.apk"),
    ],
)
def test_a_browser_or_curl_without_a_session_gets_the_sign_in_refusal(artifacts, method, path):
    status, headers, body = _request(_app(), method, path)
    assert status == 401
    assert APK not in body and b"schemaVersion" not in body
    assert str(artifacts).encode() not in body


def test_a_signed_in_session_without_a_device_signature_gets_no_manifest(artifacts):
    def no_database(_url):
        raise AssertionError("an unsigned request is refused before any database work")

    app = _app({SESSION_A: _actor(1, 1)}, access=AndroidArtifactAccess({}, AUTH, connect=no_database))
    status, _, body = _request(app, "GET", "/artifacts/android/sandbox/manifest.json", session=SESSION_A)
    assert status == 403
    assert json.loads(body)["code"] == "attestation_required"
    assert b"schemaVersion" not in body


@pytest.mark.parametrize(
    "path",
    [
        "/artifacts/android/download/",
        "/artifacts/android/download/not-a-token",
        "/artifacts/android/download/" + "A" * 40 + "." + "B" * 43,
        "/artifacts/android/download/..%2Fprivate.txt",
        "/artifacts/android/download/manifest.json",
        "/artifacts/android/download/album-haven-2.apk",
    ],
)
def test_a_malformed_or_forged_download_link_is_refused_without_a_session(artifacts, path):
    status, headers, body = _request(_app(), "GET", path)
    assert status in {403, 404}
    assert status == 404 or headers["cache-control"] == "no-store"
    assert str(artifacts).encode() not in body and APK not in body


@pytest.mark.parametrize(
    ("method", "path", "public"),
    [
        ("GET", "/artifacts/android/download/token", True),
        ("HEAD", "/artifacts/android/download/token", True),
        ("POST", "/artifacts/android/download/token", False),
        ("GET", "/artifacts/android/sandbox/manifest.json", False),
        ("HEAD", "/artifacts/android/stable/album-haven-2.apk", False),
        ("GET", "/artifacts/android/sandbox/album-haven-2.apk", False),
        ("POST", "/artifacts/android/challenge", False),
        ("GET", "/artifacts/android/download", False),
        ("GET", "/artifacts", False),
    ],
)
def test_only_the_download_link_prefix_is_public(method, path, public):
    assert _is_public(method, path) is public


def test_access_logs_never_record_a_download_token():
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:5", "GET", "/artifacts/android/download/secret.token", "1.1", 200), None)
    for item in logging.getLogger("uvicorn.access").filters:
        assert item.filter(record)
    assert "secret" not in record.getMessage()
    assert "/artifacts/android/download/[redacted]" in record.getMessage()


@pytest.mark.parametrize("declared", [True, False], ids=["content-length", "chunked"])
def test_an_oversized_apk_exchange_body_is_refused_without_buffering_it(artifacts, declared):
    def no_database(_url):
        raise AssertionError("an oversized exchange is refused before any database work")

    app = _app({SESSION_A: _actor(1, 1)}, access=AndroidArtifactAccess({}, AUTH, connect=no_database))
    chunks = []

    async def endless_body():
        chunks.append(1)
        return {"type": "http.request", "body": b"x" * 600, "more_body": True}

    headers = {"content-length": str(10 ** 12)} if declared else None
    status, _, body = _request(app, "POST", "/artifacts/android/sandbox/album-haven-2.apk", session=SESSION_A,
                               headers=headers, receive=endless_body)
    assert (status, json.loads(body)["code"]) == (400, "invalid_request")
    assert len(chunks) == (0 if declared else 2)


# --- Against an isolated Postgres --------------------------------------------------------------


@pytest.fixture
def database(monkeypatch):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            owner = connection.execute("select account_id from app.bootstrap_owners").fetchone()["account_id"]
            name = "artifact-member-" + uuid4().hex
            member = connection.execute(
                "insert into app.accounts (display_name, account_kind, username_display, username_normalized, "
                "contact_email, contact_email_normalized) values (%s, 'managed_user', %s, %s, %s, %s) returning id",
                (name, name, name, name + "@example.test", name + "@example.test"),
            ).fetchone()["id"]
        yield SimpleNamespace(setup_url=setup_url, runtime_url=runtime_url, owner=owner, member=member)
    finally:
        isolatedPostgres.reset_application_tables(setup_url)


class _Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now


@pytest.fixture
def world(database, artifacts):
    pki, clock = AttestationPki(), _Clock()
    environ = {SIGNING_CERTIFICATES_ENV["sandbox"]: SIGNER, SIGNING_CERTIFICATES_ENV["stable"]: SIGNER}
    access = AndroidArtifactAccess({"ALBUM_HAVEN_APP_DATABASE_URL": database.runtime_url}, AUTH, clock=clock,
                                   connect=isolatedPostgres._connect, roots=pki.roots, environ=environ)
    actors = {SESSION_A: _actor(database.owner, 1), SESSION_A2: _actor(database.owner, 2),
              SESSION_B: _actor(database.member, 3)}
    return SimpleNamespace(app=_app(actors, access), access=access, pki=pki, clock=clock, environ=environ,
                           db=database, artifacts=artifacts)


def _post(world, path, payload, session=SESSION_A, headers=None):
    status, _, body = _request(world.app, "POST", path, session=session, headers=headers,
                               body=json.dumps(payload).encode())
    return status, json.loads(body) if body else None


def _challenge(world, purpose, channel="sandbox", session=SESSION_A):
    status, body = _post(world, "/artifacts/android/challenge", {"protocol": 1, "channel": channel, "purpose": purpose},
                         session=session)
    assert status == 200, body
    return body["challenge"]


def _raw(challenge):
    return base64.urlsafe_b64decode(challenge + "=" * (-len(challenge) % 4))


def _chain_payload(chain):
    return [base64.b64encode(item).decode() for item in chain]


def _attest(world, channel="sandbox", session=SESSION_A, **chain_options):
    challenge = _challenge(world, "attest", channel, session)
    chain, key = world.pki.chain(_raw(challenge), **chain_options)
    status, body = _post(world, "/artifacts/android/attest",
                         {"protocol": 1, "channel": channel, "challenge": challenge, "chain": _chain_payload(chain)},
                         session=session)
    return status, body, key


def _signed_headers(world, device_key, key, method, path, *, channel="sandbox", session=SESSION_A, body=b""):
    challenge = _challenge(world, "request", channel, session)
    signature = key.sign(request_message(method, path, challenge, body), ec.ECDSA(hashes.SHA256()))
    return {"x-album-haven-device-key": device_key, "x-album-haven-challenge": challenge,
            "x-album-haven-signature": base64.b64encode(signature).decode()}


def _device(world, session=SESSION_A, channel="sandbox"):
    status, body, key = _attest(world, channel, session)
    assert status == 200, body
    return body["deviceKey"], key


def _exchange(world, device_key, key, name="album-haven-2.apk", session=SESSION_A):
    path = f"/artifacts/android/sandbox/{name}"
    status, _, body = _request(world.app, "POST", path, session=session,
                               headers=_signed_headers(world, device_key, key, "POST", path, session=session))
    return status, json.loads(body) if body.startswith(b"{") else body


def test_an_attested_install_reads_the_manifest_and_downloads_through_a_cookie_less_link(world, caplog):
    caplog.set_level(logging.DEBUG)
    device_key, key = _device(world)
    path = "/artifacts/android/sandbox/manifest.json"
    status, headers, body = _request(world.app, "GET", path, session=SESSION_A,
                                     headers=_signed_headers(world, device_key, key, "GET", path))
    assert status == 200
    assert body == b'{"schemaVersion":1}'
    assert headers["content-type"] == "application/json"
    assert headers["cache-control"] == "no-store"

    status, grant = _exchange(world, device_key, key)
    assert status == 200
    assert grant["path"].startswith("/artifacts/android/download/")
    assert grant["expiresAt"] == (NOW + timedelta(minutes=5)).isoformat()
    status, headers, body = _request(world.app, "GET", grant["path"])
    assert status == 200
    assert hashlib.sha256(body).digest() == hashlib.sha256(APK).digest()
    assert headers["content-type"] == "application/vnd.android.package-archive"
    assert headers["cache-control"] == "private, no-store"
    status, headers, body = _request(world.app, "HEAD", grant["path"])
    assert (status, headers["content-length"], body) == (200, str(len(APK)), b"")

    token = grant["path"].rsplit("/", 1)[1]
    assert token not in caplog.text
    assert str(world.artifacts) not in caplog.text


def test_any_signed_in_account_may_attest_its_own_device(world):
    device_key, key = _device(world, session=SESSION_B)
    assert _exchange(world, device_key, key, session=SESSION_B)[0] == 200


def test_a_challenge_is_single_use(world):
    challenge = _challenge(world, "attest")
    chain, _ = world.pki.chain(_raw(challenge))
    payload = {"protocol": 1, "channel": "sandbox", "challenge": challenge, "chain": _chain_payload(chain)}
    assert _post(world, "/artifacts/android/attest", payload)[0] == 200
    assert _post(world, "/artifacts/android/attest", payload) == (
        403, {"detail": "Challenge expired or already used.", "code": "challenge_invalid"})


def test_a_challenge_expires_after_two_minutes(world):
    challenge = _challenge(world, "attest")
    chain, _ = world.pki.chain(_raw(challenge))
    world.clock.now += timedelta(seconds=121)
    status, body = _post(world, "/artifacts/android/attest",
                         {"protocol": 1, "channel": "sandbox", "challenge": challenge, "chain": _chain_payload(chain)})
    assert (status, body["code"]) == (403, "challenge_invalid")


@pytest.mark.parametrize("session", [SESSION_A2, SESSION_B], ids=["other-session", "other-account"])
def test_a_challenge_is_bound_to_its_session_and_is_spent_by_any_attempt(world, session):
    challenge = _challenge(world, "attest")
    chain, _ = world.pki.chain(_raw(challenge))
    payload = {"protocol": 1, "channel": "sandbox", "challenge": challenge, "chain": _chain_payload(chain)}
    assert _post(world, "/artifacts/android/attest", payload, session=session)[1]["code"] == "challenge_invalid"
    assert _post(world, "/artifacts/android/attest", payload)[1]["code"] == "challenge_invalid"


def test_a_challenge_is_bound_to_its_purpose_and_channel(world):
    for purpose, channel in (("request", "sandbox"), ("attest", "stable")):
        challenge = _challenge(world, purpose, channel)
        chain, _ = world.pki.chain(_raw(challenge))
        status, body = _post(world, "/artifacts/android/attest", {
            "protocol": 1, "channel": "sandbox", "challenge": challenge, "chain": _chain_payload(chain)})
        assert (status, body["code"]) == (403, "challenge_invalid")


def test_open_challenges_are_capped_per_account(world):
    for _ in range(16):
        _challenge(world, "request")
    status, body = _post(world, "/artifacts/android/challenge", {"protocol": 1, "channel": "sandbox", "purpose": "request"})
    assert (status, body["code"]) == (429, "too_many_challenges")
    world.clock.now += timedelta(seconds=121)
    _challenge(world, "request")


@pytest.mark.parametrize(
    "options",
    [
        {"packages": ("org.albumhaven.app",)},
        {"digests": ("cd" * 32,)},
        {"level": 0},
    ],
    ids=["wrong-package", "wrong-certificate", "software"],
)
def test_attestation_is_refused_for_the_wrong_app_or_software_keys(world, options):
    status, body, _ = _attest(world, **options)
    assert (status, body) == (403, {"detail": "Device attestation was refused.", "code": "attestation_refused"})


def test_a_tampered_chain_is_refused(world):
    challenge = _challenge(world, "attest")
    chain, _ = world.pki.chain(_raw(challenge))
    tampered = bytearray(chain[0])
    tampered[-10] ^= 0x01
    status, body = _post(world, "/artifacts/android/attest", {
        "protocol": 1, "channel": "sandbox", "challenge": challenge, "chain": _chain_payload([bytes(tampered), *chain[1:]])})
    assert (status, body["code"]) == (403, "attestation_refused")


def test_software_attestation_needs_the_sandbox_test_flag_and_never_works_for_stable(world):
    world.environ[ALLOW_SOFTWARE_ENV] = "1"
    status, body, _ = _attest(world, level=0, packages=("org.albumhaven.app.sandbox",))
    assert (status, body["securityLevel"]) == (200, "software")
    status, body, _ = _attest(world, "stable", level=0, packages=("org.albumhaven.app",))
    assert (status, body["code"]) == (403, "attestation_refused")


def test_a_server_without_a_channel_certificate_refuses_that_channel(world):
    del world.environ[SIGNING_CERTIFICATES_ENV["stable"]]
    status, body, _ = _attest(world, "stable", packages=("org.albumhaven.app",))
    assert (status, body["code"]) == (403, "attestation_refused")


def test_a_replayed_request_nonce_is_refused(world):
    device_key, key = _device(world)
    path = "/artifacts/android/sandbox/manifest.json"
    headers = _signed_headers(world, device_key, key, "GET", path)
    assert _request(world.app, "GET", path, session=SESSION_A, headers=headers)[0] == 200
    status, _, body = _request(world.app, "GET", path, session=SESSION_A, headers=headers)
    assert (status, json.loads(body)["code"]) == (403, "challenge_invalid")


@pytest.mark.parametrize("case", ["other-key", "other-path", "unknown-key", "other-account", "other-channel"])
def test_a_request_not_signed_by_this_accounts_device_key_is_refused(world, case):
    device_key, key = _device(world)
    path, session, channel = "/artifacts/android/sandbox/manifest.json", SESSION_A, "sandbox"
    signer, signed_path = key, path
    if case == "other-key":
        signer = ec.generate_private_key(ec.SECP256R1())
    elif case == "other-path":
        signed_path = "/artifacts/android/stable/manifest.json"
    elif case == "unknown-key":
        device_key = str(uuid4())
    elif case == "other-account":
        session = SESSION_B
    elif case == "other-channel":
        path, channel = "/artifacts/android/stable/manifest.json", "stable"
    challenge = _challenge(world, "request", channel, session)
    signature = signer.sign(request_message("GET", signed_path, challenge, b""), ec.ECDSA(hashes.SHA256()))
    status, _, body = _request(world.app, "GET", path, session=session, headers={
        "x-album-haven-device-key": device_key, "x-album-haven-challenge": challenge,
        "x-album-haven-signature": base64.b64encode(signature).decode()})
    expected = "signature_invalid" if case in {"other-key", "other-path"} else "attestation_required"
    assert (status, json.loads(body)["code"]) == (403, expected)
    assert b"schemaVersion" not in body


def test_a_missing_apk_has_no_download_link(world):
    device_key, key = _device(world)
    assert _exchange(world, device_key, key, name="missing.apk") == (404, b"Not found.")


def test_a_download_link_expires_after_five_minutes(world):
    device_key, key = _device(world)
    grant = _exchange(world, device_key, key)[1]
    world.clock.now += timedelta(minutes=5)
    status, headers, body = _request(world.app, "GET", grant["path"])
    assert (status, body) == (403, b"Download link is not valid.")
    assert headers["cache-control"] == "no-store"


def test_a_download_link_names_exactly_one_file(world):
    device_key, key = _device(world)
    token = _exchange(world, device_key, key)[1]["path"].rsplit("/", 1)[1]
    payload, signature = token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    claims["f"] = "album-haven-3.apk"
    forged = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    status, _, body = _request(world.app, "GET", f"/artifacts/android/download/{forged}.{signature}")
    assert status == 403 and b"other" not in body


def test_a_download_link_is_bound_to_its_account_and_device(world):
    device_key, key = _device(world)
    # Correctly signed, but naming the member's account with the owner's device key.
    forged = world.access.issue_download_token(_actor(world.db.member, 3), device_key, "sandbox", "album-haven-2.apk")
    assert _request(world.app, "GET", forged["path"])[0] == 403

    grant = _exchange(world, device_key, key)[1]
    with isolatedPostgres._connect(world.db.setup_url) as connection:
        connection.execute("update app.accounts set is_active = false where id = %s", (world.db.owner,))
    assert _request(world.app, "GET", grant["path"])[0] == 403
    with isolatedPostgres._connect(world.db.setup_url) as connection:
        connection.execute("update app.accounts set is_active = true where id = %s", (world.db.owner,))
        connection.execute("delete from app.android_device_keys")
    assert _request(world.app, "GET", grant["path"])[0] == 403


def test_refusals_never_echo_tokens_challenges_or_paths(world, caplog):
    caplog.set_level(logging.DEBUG)
    challenge = _challenge(world, "attest")
    status, body = _post(world, "/artifacts/android/attest",
                         {"protocol": 1, "channel": "sandbox", "challenge": challenge, "chain": ["AAAA", "AAAA"]})
    assert status == 403 and challenge not in json.dumps(body)
    assert challenge not in caplog.text and str(world.artifacts) not in caplog.text


def _manifest_status(world, device_key, key):
    path = "/artifacts/android/sandbox/manifest.json"
    status, _, body = _request(world.app, "GET", path, session=SESSION_A,
                               headers=_signed_headers(world, device_key, key, "GET", path))
    return status, json.loads(body)["code"] if status != 200 else None


@pytest.mark.parametrize("level", [1, 2], ids=["tee", "strongbox"])
@pytest.mark.parametrize("boot", [(False, 0), (True, 2), None], ids=["unlocked", "unverified", "no-root-of-trust"])
def test_an_unlocked_or_unverified_device_cannot_attest(world, level, boot):
    status, body, _ = _attest(world, level=level, boot=boot)
    assert (status, body["code"]) == (403, "attestation_refused")
    with isolatedPostgres._connect(world.db.setup_url) as connection:
        assert connection.execute("select count(*) as keys from app.android_device_keys").fetchone()["keys"] == 0


def test_software_keys_stop_working_once_the_test_flag_is_off(world):
    world.environ[ALLOW_SOFTWARE_ENV] = "1"
    status, body, key = _attest(world, level=0, boot=None)
    assert (status, body["securityLevel"]) == (200, "software")
    device_key = body["deviceKey"]
    grant = _exchange(world, device_key, key)[1]

    del world.environ[ALLOW_SOFTWARE_ENV]
    assert _manifest_status(world, device_key, key) == (403, "attestation_required")
    assert _exchange(world, device_key, key)[0] == 403
    assert _request(world.app, "GET", grant["path"])[0] == 403


def test_removing_a_signing_certificate_revokes_the_keys_it_admitted(world):
    device_key, key = _device(world)
    grant = _exchange(world, device_key, key)[1]

    world.environ[SIGNING_CERTIFICATES_ENV["sandbox"]] = "cd" * 32
    assert _manifest_status(world, device_key, key) == (403, "attestation_required")
    assert _request(world.app, "GET", grant["path"])[0] == 403

    # A rotation that keeps the old certificate allowed keeps its keys.
    world.environ[SIGNING_CERTIFICATES_ENV["sandbox"]] = f"{'cd' * 32},{SIGNER}"
    assert _manifest_status(world, device_key, key) == (200, None)
    assert _request(world.app, "GET", grant["path"])[0] == 200


def test_the_stored_key_records_the_signer_its_attestation_matched(world):
    device_key, _ = _device(world)
    with isolatedPostgres._connect(world.db.setup_url) as connection:
        row = connection.execute("select signing_certificate_sha256 from app.android_device_keys where id = %s",
                                 (device_key,)).fetchone()
    assert bytes(row["signing_certificate_sha256"]).hex() == SIGNER


def test_a_key_stored_without_its_signer_must_attest_again(world):
    device_key, key = _device(world)
    grant = _exchange(world, device_key, key)[1]
    with isolatedPostgres._connect(world.db.setup_url) as connection:
        connection.execute("update app.android_device_keys set signing_certificate_sha256 = null")
    assert _manifest_status(world, device_key, key) == (403, "attestation_required")
    assert _request(world.app, "GET", grant["path"])[0] == 403


def test_a_failed_signature_does_not_refresh_the_device_key(world):
    device_key, key = _device(world)

    def last_used():
        with isolatedPostgres._connect(world.db.setup_url) as connection:
            return connection.execute("select last_used_at from app.android_device_keys where id = %s",
                                      (device_key,)).fetchone()["last_used_at"]

    attested = last_used()
    world.clock.now += timedelta(minutes=1)
    assert _manifest_status(world, device_key, ec.generate_private_key(ec.SECP256R1())) == (403, "signature_invalid")
    assert last_used() == attested
    assert _manifest_status(world, device_key, key) == (200, None)
    assert last_used() == world.clock.now
