"""Sandbox build index and the owner's one-tap rebuild, without a database: device signatures are
verified by a stub, so these cover the routes' own rules and the dispatch to GitHub."""

import json
from uuid import uuid4

import pytest

from music_app.services.android_artifact_access import ArtifactAccessError
from music_app.services.android_sandbox_builds import (
    INDEX_ENV,
    REBUILDS_PER_HOUR,
    REPOSITORY_ENV,
    TOKEN_ENV,
    RebuildError,
    SandboxRebuilds,
    index_entry,
    index_path,
)
from music_app.services.current_actor import ActorState, CurrentActor
from tests.py.test_android_artifacts import SESSION_A, SESSION_B, _app, _request

COMMIT = "1a2b3c4" + "d" * 33
TOKEN = "github_pat_" + "x" * 40


def _index(*entries):
    return {"schemaVersion": 1, "channel": "sandbox", "applicationId": "org.albumhaven.app.sandbox",
            "sandboxes": list(entries)}


def _entry(sandbox, **overrides):
    return {"sandbox": sandbox, "origin": f"https://sandbox{sandbox}.albumhaven.org", "versionCode": 20 + sandbox,
            "versionName": f"0.11.8-sandbox.{COMMIT[:7]}", "sourceCommit": COMMIT, "sourceBranch": "feature/gapless",
            "label": "8 - Gapless Fix", "apkSize": 100, "minAndroidApi": 29, "bridgeProtocolMin": 1,
            "bridgeProtocolMax": 1, "publishedAt": "2026-11-15T10:00:00Z", **overrides}


@pytest.fixture
def index(tmp_path, monkeypatch):
    path = tmp_path / "android-sandbox-index.json"
    path.write_text(json.dumps(_index(_entry(2), _entry(3, sourceBranch=None, label=None))), encoding="utf-8")
    monkeypatch.setenv(INDEX_ENV, str(path))
    return path


class _GitHub:
    """Answers the runs listing and records dispatches, as GitHub's REST API would."""

    def __init__(self, runs=(), dispatch_status=204, runs_status=200):
        self.runs = list(runs)
        self.dispatch_status = dispatch_status
        self.runs_status = runs_status
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, json.loads(body) if body else None))
        if method == "GET":
            return self.runs_status, json.dumps({"workflow_runs": self.runs}).encode()
        return self.dispatch_status, b""

    @property
    def dispatches(self):
        return [payload for method, _url, _headers, payload in self.calls if method == "POST"]


def _rebuilds(index, github, *, token=TOKEN, repository="owner/AlbumHaven", clock=lambda: 1_800_000_000.0):
    environ = {INDEX_ENV: str(index), TOKEN_ENV: token, REPOSITORY_ENV: repository}
    return SandboxRebuilds(environ, transport=github, clock=clock)


def test_the_index_is_offered_only_when_configured_as_a_regular_file(tmp_path, index):
    assert index_path({INDEX_ENV: str(index)}) == index
    assert index_path({}) is None
    assert index_path({INDEX_ENV: str(tmp_path / "missing.json")}) is None
    assert index_path({INDEX_ENV: str(tmp_path)}) is None


def test_a_rebuild_uses_only_what_the_index_records_for_that_sandbox(index):
    assert index_entry(index, 2) == {"sourceCommit": COMMIT, "sourceBranch": "feature/gapless", "label": "8 - Gapless Fix"}
    assert index_entry(index, 3) == {"sourceCommit": COMMIT, "sourceBranch": None, "label": None}
    assert index_entry(index, 4) is None
    index.write_text(json.dumps(_index(_entry(2, sourceCommit="not-a-commit"))), encoding="utf-8")
    assert index_entry(index, 2) is None
    index.write_text(json.dumps(_index(_entry(2, sourceBranch="a..b"))), encoding="utf-8")
    assert index_entry(index, 2) is None
    index.write_text("{broken", encoding="utf-8")
    assert index_entry(index, 2) is None


def test_a_rebuild_dispatches_main_s_promotion_for_the_sandbox_s_own_commit(index):
    github = _GitHub()

    result = _rebuilds(index, github).rebuild(2)

    assert result == {"sandbox": 2, "sourceCommit": COMMIT, "requestedAt": "2027-01-15T08:00:00Z"}
    method, url, headers, payload = github.calls[-1]
    assert (method, url) == ("POST", "https://api.github.com/repos/owner/AlbumHaven/actions/workflows/android-promote.yml/dispatches")
    assert payload == {"ref": "main", "inputs": {
        "commit": COMMIT, "channel": "sandbox", "sandbox": "2", "branch": "feature/gapless", "label": "8 - Gapless Fix",
    }}
    assert headers["Authorization"] == f"Bearer {TOKEN}"


def test_a_build_published_without_branch_or_label_is_rebuilt_without_them(index):
    github = _GitHub()
    _rebuilds(index, github).rebuild(3)
    assert github.dispatches == [{"ref": "main", "inputs": {"commit": COMMIT, "channel": "sandbox", "sandbox": "3"}}]


@pytest.mark.parametrize(
    "overrides",
    [{"token": ""}, {"token": "short"}, {"repository": ""}, {"repository": "not a repository"}],
)
def test_without_a_token_and_repository_rebuilds_are_unavailable(index, overrides):
    github = _GitHub()
    with pytest.raises(RebuildError) as raised:
        _rebuilds(index, github, **overrides).rebuild(2)
    assert (raised.value.status, raised.value.code) == (503, "rebuild_unavailable")
    assert github.calls == []


def test_a_sandbox_without_a_build_cannot_be_rebuilt(index):
    with pytest.raises(RebuildError) as raised:
        _rebuilds(index, _GitHub()).rebuild(7)
    assert (raised.value.status, raised.value.code) == (404, "no_build")


def test_a_queued_or_running_promotion_for_that_sandbox_blocks_another(index):
    running = [{"status": "in_progress", "display_title": f"Android sandbox promotion of {COMMIT} for sandbox2"},
               {"status": "completed", "display_title": f"Android sandbox promotion of {COMMIT} for sandbox3"},
               {"status": "queued", "display_title": f"Android sandbox promotion of {COMMIT} for sandbox22"}]
    github = _GitHub(running)
    with pytest.raises(RebuildError) as raised:
        _rebuilds(index, github).rebuild(2)
    assert (raised.value.status, raised.value.code) == (409, "rebuild_running")
    _rebuilds(index, github).rebuild(3)
    assert [payload["inputs"]["sandbox"] for payload in github.dispatches] == ["3"]


def test_rebuilds_are_capped_per_hour(index):
    now = [1_800_000_000.0]
    rebuilds = _rebuilds(index, _GitHub(), clock=lambda: now[0])
    for _ in range(REBUILDS_PER_HOUR):
        rebuilds.rebuild(2)
    with pytest.raises(RebuildError) as raised:
        rebuilds.rebuild(2)
    assert (raised.value.status, raised.value.code) == (429, "too_many_rebuilds")
    now[0] += 3600
    rebuilds.rebuild(2)


@pytest.mark.parametrize("github", [_GitHub(dispatch_status=422), _GitHub(runs_status=500), _GitHub(dispatch_status=0)])
def test_a_github_failure_is_reported_and_not_counted(index, github):
    with pytest.raises(RebuildError) as raised:
        _rebuilds(index, github).rebuild(2)
    assert (raised.value.status, raised.value.code) == (502, "dispatch_failed")


# --- Routes ------------------------------------------------------------------------------------


class _Access:
    """Stands in for the attested-device signature check."""

    def __init__(self, refusal=None):
        self.refusal = refusal
        self.calls = []

    def verify_signed_request(self, actor, channel, method, path, headers):
        self.calls.append((actor.account_id, channel, method, path))
        if self.refusal:
            raise ArtifactAccessError(403, self.refusal)
        return uuid4()


class _Rebuilds:
    def __init__(self, error=None):
        self.error = error
        self.requested = []

    def rebuild(self, sandbox):
        self.requested.append(sandbox)
        if self.error:
            raise self.error
        return {"sandbox": sandbox, "sourceCommit": COMMIT, "requestedAt": "2026-11-15T10:00:00Z"}


def _owner(account_id=1, session_id=1):
    return CurrentActor(state=ActorState.ACTIVE, account_id=account_id, session_id=session_id,
                        username_display="owner", is_bootstrap_owner=True)


def _member(account_id=2, session_id=2):
    return CurrentActor(state=ActorState.ACTIVE, account_id=account_id, session_id=session_id,
                        username_display="member")


def _routes(access=None, rebuilds=None):
    app = _app({SESSION_A: _owner(), SESSION_B: _member()}, access=access or _Access())
    if rebuilds is not None:
        app.state.android_sandbox_rebuilds = rebuilds
    return app


def test_the_index_needs_a_session_and_a_device_signature(index):
    status, _, body = _request(_routes(), "GET", "/artifacts/android/sandbox/index.json")
    assert status == 401 and b"sandboxes" not in body
    status, _, body = _request(_routes(_Access("attestation_required")), "GET", "/artifacts/android/sandbox/index.json",
                               session=SESSION_B)
    assert (status, json.loads(body)["code"]) == (403, "attestation_required")


def test_any_signed_in_attested_account_reads_the_index(index):
    access = _Access()
    status, headers, body = _request(_routes(access), "GET", "/artifacts/android/sandbox/index.json", session=SESSION_B)
    assert status == 200
    assert json.loads(body)["sandboxes"][0]["sandbox"] == 2
    assert headers["cache-control"] == "no-store"
    assert access.calls == [(2, "sandbox", "GET", "/artifacts/android/sandbox/index.json")]


def test_a_server_without_an_index_has_none(monkeypatch):
    monkeypatch.delenv(INDEX_ENV, raising=False)
    status, _, _ = _request(_routes(), "GET", "/artifacts/android/sandbox/index.json", session=SESSION_A)
    assert status == 404


def test_the_owner_starts_a_rebuild(index):
    access, rebuilds = _Access(), _Rebuilds()
    status, headers, body = _request(_routes(access, rebuilds), "POST", "/artifacts/android/sandbox/rebuild/2",
                                     session=SESSION_A)
    assert status == 202
    assert json.loads(body) == {"sandbox": 2, "sourceCommit": COMMIT, "requestedAt": "2026-11-15T10:00:00Z"}
    assert headers["cache-control"] == "no-store"
    assert rebuilds.requested == [2]
    assert access.calls == [(1, "sandbox", "POST", "/artifacts/android/sandbox/rebuild/2")]


def test_only_the_owner_may_rebuild(index):
    access, rebuilds = _Access(), _Rebuilds()
    status, _, _ = _request(_routes(access, rebuilds), "POST", "/artifacts/android/sandbox/rebuild/2", session=SESSION_B)
    assert status == 403
    assert rebuilds.requested == [] and access.calls == [], "refused before any signature or dispatch"
    status, _, _ = _request(_routes(access, rebuilds), "POST", "/artifacts/android/sandbox/rebuild/2")
    assert status == 401


@pytest.mark.parametrize("sandbox", ["0", "100", "02", "x", "2a"])
def test_a_rebuild_names_a_sandbox_from_1_to_99(index, sandbox):
    rebuilds = _Rebuilds()
    status, _, _ = _request(_routes(rebuilds=rebuilds), "POST", f"/artifacts/android/sandbox/rebuild/{sandbox}",
                            session=SESSION_A)
    assert status == 404
    assert rebuilds.requested == []


def test_a_rebuild_request_has_no_body_and_a_valid_signature(index):
    rebuilds = _Rebuilds()
    status, _, body = _request(_routes(rebuilds=rebuilds), "POST", "/artifacts/android/sandbox/rebuild/2",
                               session=SESSION_A, body=b'{"commit":"x"}')
    assert (status, json.loads(body)["code"]) == (400, "invalid_request")
    status, _, body = _request(_routes(_Access("signature_invalid"), rebuilds), "POST",
                               "/artifacts/android/sandbox/rebuild/2", session=SESSION_A)
    assert (status, json.loads(body)["code"]) == (403, "signature_invalid")
    assert rebuilds.requested == []


@pytest.mark.parametrize(
    ("error", "status"),
    [(RebuildError(503, "rebuild_unavailable"), 503), (RebuildError(409, "rebuild_running"), 409),
     (RebuildError(429, "too_many_rebuilds"), 429), (RebuildError(404, "no_build"), 404),
     (RebuildError(502, "dispatch_failed"), 502)],
)
def test_a_refused_rebuild_reports_its_code(index, error, status):
    response_status, _, body = _request(_routes(rebuilds=_Rebuilds(error)), "POST",
                                        "/artifacts/android/sandbox/rebuild/2", session=SESSION_A)
    assert (response_status, json.loads(body)["code"]) == (status, error.code)
    assert TOKEN.encode() not in body
