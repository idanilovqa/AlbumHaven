"""Sandbox APK builds for the Android build picker: the index of what each sandbox serves, and the
owner's one-tap rebuild of a sandbox's build under a newer version code.

The deployment synchronizer writes the index (``ALBUM_HAVEN_ANDROID_SANDBOX_INDEX``): metadata only,
one entry per sandbox, with no APK name, URL or hash, so it grants nothing by itself. A rebuild
dispatches the application repository's ``android-promote.yml`` for the commit, branch and label the
index records for that sandbox (never values from the request) with a token limited to Actions on
that repository (``ALBUM_HAVEN_ANDROID_REBUILD_TOKEN``). Production configures neither, so it serves
no index and starts no rebuild.
"""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import threading
import time
from urllib import error, request

INDEX_ENV = "ALBUM_HAVEN_ANDROID_SANDBOX_INDEX"
TOKEN_ENV = "ALBUM_HAVEN_ANDROID_REBUILD_TOKEN"
REPOSITORY_ENV = "ALBUM_HAVEN_ANDROID_REBUILD_REPOSITORY"
WORKFLOW = "android-promote.yml"
MAX_INDEX_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
REBUILDS_PER_HOUR = 6
SANDBOX = re.compile(r"[1-9]\d?")
COMMIT = re.compile(r"[0-9a-f]{40}")
BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}")
REPOSITORY = re.compile(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+")
TOKEN = re.compile(r"[A-Za-z0-9_]{20,255}")
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
API_ROOT = "https://api.github.com"
USER_AGENT = "AlbumHaven-SandboxRebuild/1.0"


class RebuildError(Exception):
    """A refused or failed rebuild; ``code`` is path- and secret-free."""

    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def index_path(environ=os.environ) -> Path | None:
    """The configured index file, or None when this server offers no sandbox builds."""
    value = str(environ.get(INDEX_ENV) or "").strip()
    if not value:
        return None
    path = Path(value)
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_INDEX_BYTES:
            return None
    except OSError:
        return None
    return path


def index_entry(path: Path, sandbox: int) -> dict | None:
    """The index entry for ``sandbox`` whose rebuild inputs are well formed, or None."""
    try:
        index = json.loads(path.read_bytes()[: MAX_INDEX_BYTES + 1])
    except (OSError, ValueError):
        return None
    entries = index.get("sandboxes") if isinstance(index, dict) and index.get("channel") == "sandbox" else None
    for entry in entries if isinstance(entries, list) else ():
        if not isinstance(entry, dict) or entry.get("sandbox") != sandbox or type(entry.get("sandbox")) is not int:
            continue
        commit, branch, label = entry.get("sourceCommit"), entry.get("sourceBranch"), entry.get("label")
        if (
            isinstance(commit, str) and COMMIT.fullmatch(commit)
            and (branch is None or (isinstance(branch, str) and BRANCH.fullmatch(branch) and ".." not in branch))
            and (label is None or (isinstance(label, str) and 0 < len(label) <= 60 and not CONTROL.search(label)))
        ):
            return {"sourceCommit": commit, "sourceBranch": branch, "label": label}
        return None
    return None


def urllib_transport(method: str, url: str, headers: dict, body: bytes | None) -> tuple[int, bytes]:
    req = request.Request(url, data=body, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=20) as response:
            return response.status, response.read(MAX_RESPONSE_BYTES + 1)
    except error.HTTPError as exc:
        return exc.code, b""
    except (OSError, TimeoutError):
        return 0, b""


class SandboxRebuilds:
    """Dispatches rebuilds; one per server process, with an hourly cap shared by every sandbox."""

    def __init__(self, environ=os.environ, *, transport=urllib_transport, clock=time.time):
        self._environ = environ
        self._transport = transport
        self._clock = clock
        self._lock = threading.Lock()
        self._recent: deque[float] = deque()

    def rebuild(self, sandbox: int) -> dict:
        token = str(self._environ.get(TOKEN_ENV) or "").strip()
        repository = str(self._environ.get(REPOSITORY_ENV) or "").strip()
        path = index_path(self._environ)
        if path is None or not TOKEN.fullmatch(token) or not REPOSITORY.fullmatch(repository):
            raise RebuildError(503, "rebuild_unavailable")
        entry = index_entry(path, sandbox)
        if entry is None:
            raise RebuildError(404, "no_build")
        now = self._clock()
        with self._lock:
            while self._recent and now - self._recent[0] >= 3600:
                self._recent.popleft()
            if len(self._recent) >= REBUILDS_PER_HOUR:
                raise RebuildError(429, "too_many_rebuilds")
            if self._running(repository, token, sandbox):
                raise RebuildError(409, "rebuild_running")
            inputs = {"commit": entry["sourceCommit"], "channel": "sandbox", "sandbox": str(sandbox)}
            if entry["sourceBranch"]:
                inputs["branch"] = entry["sourceBranch"]
            if entry["label"]:
                inputs["label"] = entry["label"]
            status, _ = self._call(
                "POST", f"/repos/{repository}/actions/workflows/{WORKFLOW}/dispatches", token,
                {"ref": "main", "inputs": inputs},
            )
            if status != 204:
                raise RebuildError(502, "dispatch_failed")
            self._recent.append(now)
        requested = datetime.fromtimestamp(now, timezone.utc).replace(microsecond=0)
        return {"sandbox": sandbox, "sourceCommit": entry["sourceCommit"],
                "requestedAt": requested.isoformat().replace("+00:00", "Z")}

    def _running(self, repository: str, token: str, sandbox: int) -> bool:
        """Whether a promotion for this sandbox is queued or running (its run name ends in it)."""
        status, body = self._call("GET", f"/repos/{repository}/actions/workflows/{WORKFLOW}/runs?per_page=50", token)
        try:
            runs = json.loads(body).get("workflow_runs") if status == 200 else None
        except ValueError:
            runs = None
        if not isinstance(runs, list):
            raise RebuildError(502, "dispatch_failed")
        suffix = f" for sandbox{sandbox}"
        return any(
            isinstance(run, dict) and run.get("status") != "completed"
            and str(run.get("display_title") or "").endswith(suffix)
            for run in runs
        )

    def _call(self, method: str, path: str, token: str, payload: dict | None = None) -> tuple[int, bytes]:
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        }
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        return self._transport(method, API_ROOT + path, headers, body)
