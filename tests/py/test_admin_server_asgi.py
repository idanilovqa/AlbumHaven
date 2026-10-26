from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import FastAPI


def _state(**overrides):
    state = {
        "mode": "album_folders",
        "active_root": None,
        "requested_mode": None,
        "requested_root": None,
        "operation_id": None,
        "operation_state": "idle",
        "revision": 4,
        "total_count": 12,
        "completed_count": 0,
        "failed_count": 0,
        "total_bytes": 2048,
        "completed_bytes": 0,
        "cancel_requested": False,
        "failure_summary": [],
    }
    state.update(overrides)
    return state


class Repository:
    def __init__(self, state=None):
        self.state = state or _state()
        self.calls = []

    def load(self):
        self.calls.append(("load",))
        return dict(self.state)

    def request_location(self, **kwargs):
        self.calls.append(("request_location", kwargs))
        self.state.update(
            requested_mode=kwargs["mode"],
            requested_root=kwargs["root"],
            revision=kwargs["expected_revision"] + 1,
        )
        return dict(self.state)

    def begin_operation(self, *, operation_id):
        self.calls.append(("begin_operation", operation_id))
        self.state.update(operation_id=operation_id, operation_state="queued")
        return dict(self.state)

    def cancel(self, operation_id):
        self.calls.append(("cancel", operation_id))
        self.state.update(operation_state="cancel_requested", cancel_requested=True)
        return dict(self.state)

    def retry_failed(self, operation_id):
        self.calls.append(("retry_failed", operation_id))
        self.state.update(operation_state="queued", failed_count=0)
        return dict(self.state)


class Worker:
    def __init__(self):
        self.wakes = 0

    def wake(self):
        self.wakes += 1


def _app(tmp_path: Path, state=None):
    from music_app.routes.admin_asgi import router

    app = FastAPI()
    repository = Repository(state)
    worker = Worker()
    app.state.generated_preview_storage_repository = repository
    app.state.generated_preview_relocation = worker
    app.state.config = {
        "_library_root_paths_snapshot": (tmp_path / "Music",),
    }
    app.include_router(router)
    return app, repository, worker


async def _request_async(app, method, path, payload=None):
    body = json.dumps(payload).encode() if payload is not None else b""
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

    headers = [(b"host", b"music.test")]
    if payload is not None:
        headers.extend([
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ])
    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 50000),
            "server": ("music.test", 443),
        },
        receive,
        send,
    )
    start = next(item for item in messages if item["type"] == "http.response.start")
    response_body = b"".join(
        item.get("body", b"") for item in messages if item["type"] == "http.response.body"
    )
    return start["status"], json.loads(response_body) if response_body else None


def _request(*args, **kwargs):
    return asyncio.run(_request_async(*args, **kwargs))


def test_preview_storage_get_returns_owner_state_and_server_suggestion(tmp_path):
    app, repository, _worker = _app(tmp_path)

    status, payload = _request(app, "GET", "/admin/server/preview-storage")

    assert status == 200
    assert payload["mode"] == "album_folders"
    assert payload["total_count"] == 12
    assert payload["suggested_path"].endswith("Documents\\Album Haven\\Generated Previews")
    assert repository.calls == [("load",)]


def test_preview_storage_put_requires_confirmation_and_uses_revision(tmp_path):
    app, repository, worker = _app(tmp_path)
    destination = tmp_path / "Previews"

    status, payload = _request(app, "PUT", "/admin/server/preview-storage", {
        "mode": "custom",
        "path": str(destination),
        "expected_revision": 4,
        "confirmed": False,
    })

    assert status == 409
    assert "confirmation" in payload["detail"].casefold()
    assert repository.calls == [("load",)]
    assert worker.wakes == 0
    assert not destination.exists()

    status, payload = _request(app, "PUT", "/admin/server/preview-storage", {
        "mode": "custom",
        "path": str(destination),
        "expected_revision": 4,
        "confirmed": True,
    })

    assert status == 202
    assert payload["requested_mode"] == "custom"
    assert payload["operation_state"] == "queued"
    assert repository.calls[2] == (
        "request_location",
        {"mode": "custom", "root": str(destination.resolve()), "expected_revision": 4},
    )
    assert repository.calls[3][0] == "begin_operation"
    assert worker.wakes == 1
    assert app.state.generated_preview_storage_policy.snapshot.requested_root == str(destination.resolve())


def test_preview_storage_put_is_noop_when_location_is_unchanged(tmp_path):
    app, repository, worker = _app(tmp_path)

    status, payload = _request(app, "PUT", "/admin/server/preview-storage", {
        "mode": "album_folders",
        "path": "",
        "expected_revision": 4,
        "confirmed": False,
    })

    assert status == 200
    assert payload["unchanged"] is True
    assert repository.calls == [("load",)]
    assert worker.wakes == 0


def test_preview_storage_put_rejects_active_operation_and_music_root(tmp_path):
    app, _repository, _worker = _app(
        tmp_path,
        _state(operation_id="10e2fc89-439a-4f74-a508-97596cf20771", operation_state="running"),
    )
    status, _payload = _request(app, "PUT", "/admin/server/preview-storage", {
        "mode": "custom",
        "path": str(tmp_path / "Elsewhere"),
        "expected_revision": 4,
        "confirmed": True,
    })
    assert status == 409

    app, repository, _worker = _app(tmp_path)
    status, payload = _request(app, "PUT", "/admin/server/preview-storage", {
        "mode": "custom",
        "path": str(tmp_path / "Music" / "Previews"),
        "expected_revision": 4,
        "confirmed": True,
    })
    assert status == 400
    assert "music root" in payload["detail"].casefold()
    assert repository.calls == [("load",)]

    app, repository, worker = _app(
        tmp_path,
        _state(
            requested_mode="custom",
            requested_root=str(tmp_path / "Pending"),
            operation_id="10e2fc89-439a-4f74-a508-97596cf20771",
            operation_state="canceled",
        ),
    )
    status, payload = _request(app, "PUT", "/admin/server/preview-storage", {
        "mode": "custom",
        "path": str(tmp_path / "Replacement"),
        "expected_revision": 4,
        "confirmed": True,
    })
    assert status == 409
    assert "resume" in payload["detail"].casefold()
    assert repository.calls == [("load",)]
    assert worker.wakes == 0


def test_preview_storage_put_wakes_recovery_if_operation_start_is_interrupted(tmp_path):
    app, repository, worker = _app(tmp_path)
    destination = tmp_path / "Previews"

    def fail_to_begin(*, operation_id):
        repository.calls.append(("begin_operation", operation_id))
        raise RuntimeError("interrupted")

    repository.begin_operation = fail_to_begin
    status, payload = _request(app, "PUT", "/admin/server/preview-storage", {
        "mode": "custom",
        "path": str(destination),
        "expected_revision": 4,
        "confirmed": True,
    })

    assert status == 503
    assert "could not be started" in payload["detail"]
    assert repository.state["requested_mode"] == "custom"
    assert worker.wakes == 1


def test_preview_storage_put_rejects_stale_revision_before_touching_path(tmp_path):
    app, repository, worker = _app(tmp_path)
    destination = tmp_path / "Stale destination"

    status, payload = _request(app, "PUT", "/admin/server/preview-storage", {
        "mode": "custom",
        "path": str(destination),
        "expected_revision": 3,
        "confirmed": True,
    })

    assert status == 409
    assert "revision" in payload["detail"].casefold()
    assert not destination.exists()
    assert repository.calls == [("load",)]
    assert worker.wakes == 0


def test_preview_storage_cancel_and_retry_wake_worker(tmp_path):
    operation_id = "10e2fc89-439a-4f74-a508-97596cf20771"
    app, repository, worker = _app(
        tmp_path,
        _state(operation_id=operation_id, operation_state="running", failed_count=2),
    )

    cancel_status, cancel_payload = _request(
        app, "POST", "/admin/server/preview-storage/cancel", {}
    )
    retry_status, retry_payload = _request(
        app, "POST", "/admin/server/preview-storage/retry", {}
    )

    assert cancel_status == 202
    assert cancel_payload["operation_state"] == "cancel_requested"
    assert retry_status == 202
    assert retry_payload["operation_state"] == "queued"
    assert ("cancel", operation_id) in repository.calls
    assert ("retry_failed", operation_id) in repository.calls
    assert worker.wakes == 2
