from __future__ import annotations

import json
import re
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from copy import deepcopy

_MIN_REQUEST_INTERVAL_SECONDS = 1.05
_MAX_ATTEMPTS = 3
_SUCCESS_CACHE_TTL_SECONDS = 60 * 60 * 6
_MISS_CACHE_TTL_SECONDS = 60 * 15
_BLOCK_COOLDOWN_SECONDS = 60 * 15
STRICT_EVIDENCE_POLICY = "musicbrainz-release-group-v1"
_STRICT_SUCCESS_MAX_BYTES = 256 * 1024
_STRICT_ERROR_MAX_BYTES = 16 * 1024
_STRICT_RELEASE_GROUP_URL = re.compile(
    r"https://musicbrainz\.org/ws/2/release-group/"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"\?inc=artist-credits&fmt=json"
)

_REQUEST_LOCK = threading.Lock()
_STATE_LOCK = threading.Lock()
_CACHE_LOCK = threading.Lock()
_NEXT_ALLOWED_AT_MONOTONIC = 0.0
_BLOCKED_UNTIL = 0.0
_BLOCK_REASON = ""
_CACHE_MISS = object()
_URL_CACHE: dict[str, dict[str, object]] = {}
# Strict entries can only be produced by this bounded, non-redirecting path.
# Legacy cache successes and misses never qualify as acquisition evidence.
_STRICT_EVIDENCE_URL_CACHE: dict[str, dict[str, object]] = {}


class _StrictEvidenceError(ValueError):
    pass


class _StrictEvidenceHTTPErrorProcessor(urllib.request.HTTPErrorProcessor):
    """Reject every 3xx before urllib dispatches any redirect handler.

    Redirect handlers can drain an unbounded response before opening the next
    URL. Intercepting the response here rejects same-host redirects as well as
    cross-origin redirects without following or draining either response.
    """

    def http_response(self, request, response):
        if 300 <= response.code < 400:
            response.close()
            raise _StrictEvidenceError("redirect_rejected")
        return super().http_response(request, response)

    https_response = http_response


def _strict_success_bytes(response) -> bytes:
    # One sentinel byte distinguishes an exact-limit response from an overrun.
    body = response.read(_STRICT_SUCCESS_MAX_BYTES + 1)
    if len(body) > _STRICT_SUCCESS_MAX_BYTES:
        raise _StrictEvidenceError("response_too_large")
    return body


def _success_meta(status: str, *, strict_evidence: bool, attempt: int | None = None) -> dict[str, object]:
    meta: dict[str, object] = {"status": status, "cache_hit": status == "cache"}
    if attempt is not None:
        meta["attempt"] = attempt
    if strict_evidence:
        meta["evidence_policy"] = STRICT_EVIDENCE_POLICY
    return meta


def _cache_key(url: str, accept: str) -> str:
    return f"{accept}::{str(url or '').strip()}"


def _get_cached_value(url: str, accept: str, *, strict_evidence: bool = False) -> object | None:
    cache_key = _cache_key(url, accept)
    cache = _STRICT_EVIDENCE_URL_CACHE if strict_evidence else _URL_CACHE
    now = time.time()
    with _CACHE_LOCK:
        entry = cache.get(cache_key)
        if not isinstance(entry, dict):
            return None
        if strict_evidence and entry.get("evidence_policy") != STRICT_EVIDENCE_POLICY:
            cache.pop(cache_key, None)
            return None
        updated_at = float(entry.get("updated_at") or 0.0)
        ok = bool(entry.get("ok"))
        ttl = _SUCCESS_CACHE_TTL_SECONDS if ok else _MISS_CACHE_TTL_SECONDS
        if not updated_at or now - updated_at > ttl:
            cache.pop(cache_key, None)
            return None
        payload = entry.get("payload")
        if ok and isinstance(payload, dict):
            return deepcopy(payload) if strict_evidence else dict(payload)
        return _CACHE_MISS


def _set_cached_value(url: str, accept: str, payload: dict | None, *, strict_evidence: bool = False) -> None:
    cache_key = _cache_key(url, accept)
    cache = _STRICT_EVIDENCE_URL_CACHE if strict_evidence else _URL_CACHE
    with _CACHE_LOCK:
        cache[cache_key] = {
            "updated_at": time.time(),
            "ok": isinstance(payload, dict),
            "payload": (deepcopy(payload) if strict_evidence else dict(payload)) if isinstance(payload, dict) else None,
        }
        if strict_evidence:
            cache[cache_key]["evidence_policy"] = STRICT_EVIDENCE_POLICY


def _set_block(reason: str, *, cooldown_seconds: float = _BLOCK_COOLDOWN_SECONDS) -> None:
    global _BLOCKED_UNTIL, _BLOCK_REASON
    with _STATE_LOCK:
        _BLOCKED_UNTIL = max(_BLOCKED_UNTIL, time.time() + max(30.0, float(cooldown_seconds or 0.0)))
        _BLOCK_REASON = str(reason or "").strip() or "blocked"


def _blocked_state() -> tuple[bool, float, str]:
    with _STATE_LOCK:
        blocked_until = float(_BLOCKED_UNTIL or 0.0)
        reason = str(_BLOCK_REASON or "").strip()
    remaining = blocked_until - time.time()
    if remaining > 0:
        return True, remaining, reason
    return False, 0.0, ""


def _mark_request_complete() -> None:
    global _NEXT_ALLOWED_AT_MONOTONIC
    with _STATE_LOCK:
        _NEXT_ALLOWED_AT_MONOTONIC = time.monotonic() + _MIN_REQUEST_INTERVAL_SECONDS


def _wait_for_slot() -> None:
    while True:
        with _STATE_LOCK:
            delay = max(0.0, _NEXT_ALLOWED_AT_MONOTONIC - time.monotonic())
        if delay <= 0:
            return
        time.sleep(delay)


def _block_reason_from_http_error(status_code: int, body: bytes) -> str:
    if int(status_code or 0) in {403, 429}:
        return f"http_{int(status_code)}"
    text = body.decode("utf-8", errors="ignore").casefold() if body else ""
    if any(token in text for token in ("rate limit", "too many requests", "forbidden", "access denied", "temporarily blocked")):
        return "http_blocked"
    return ""


def _block_reason_from_exception(error: object) -> str:
    text = str(error or "").casefold()
    if any(token in text for token in (
        "unexpected eof while reading",
        "eof occurred in violation of protocol",
        "failed to receive handshake",
        "ssl/tls connection failed",
        "tlsv1 alert",
        "handshake failure",
    )):
        return "tls_handshake_blocked"
    return ""


def _is_retryable_http_status(status_code: int) -> bool:
    return int(status_code or 0) == 503


def _backoff_delay(attempt: int) -> float:
    return min(8.0, 0.75 * (2 ** max(0, attempt - 1)))


def get_json(
    url: str,
    user_agent: str,
    *,
    accept: str = "application/json",
    extra_headers: dict[str, str] | None = None,
    timeout: float = 15.0,
    context: str = "",
    should_cancel: Callable[[], bool] | None = None,
    strict_evidence: bool = False,
) -> tuple[dict | None, dict[str, object]]:
    """Use the shared pacing/retry owner; strict evidence is explicitly opt-in.

    Strict mode admits only the adapter's fixed official release-group endpoint,
    default JSON accept and no additional headers. It does not install a global
    opener or change the default transport/cache behavior of existing callers.
    """
    del context
    if callable(should_cancel) and should_cancel():
        return None, {"status": "canceled", "cache_hit": False, "attempt": 0}
    if strict_evidence and (
        type(url) is not str or _STRICT_RELEASE_GROUP_URL.fullmatch(url) is None
        or accept != "application/json" or extra_headers
    ):
        return None, {"status": "invalid_evidence_request", "cache_hit": False, "attempt": 0}
    cached = _get_cached_value(url, accept, strict_evidence=strict_evidence)
    if cached is _CACHE_MISS:
        return None, {"status": "cached_miss", "cache_hit": True}
    if isinstance(cached, dict):
        return cached, _success_meta("cache", strict_evidence=strict_evidence)

    with _REQUEST_LOCK:
        if callable(should_cancel) and should_cancel():
            return None, {"status": "canceled", "cache_hit": False, "attempt": 0}
        cached = _get_cached_value(url, accept, strict_evidence=strict_evidence)
        if cached is _CACHE_MISS:
            return None, {"status": "cached_miss", "cache_hit": True}
        if isinstance(cached, dict):
            return cached, _success_meta("cache", strict_evidence=strict_evidence)

        blocked, retry_after_seconds, blocked_reason = _blocked_state()
        if blocked:
            _set_cached_value(url, accept, None, strict_evidence=strict_evidence)
            return None, {
                "status": "blocked",
                "cache_hit": False,
                "retry_after_seconds": round(retry_after_seconds, 2),
                "blocked_reason": blocked_reason,
            }

        headers = {
            "User-Agent": user_agent,
            "Accept": accept,
        }
        for header_key, header_value in (extra_headers or {}).items():
            if str(header_key or "").strip() and str(header_value or "").strip():
                headers[str(header_key)] = str(header_value)

        for attempt in range(1, _MAX_ATTEMPTS + 1):
            if callable(should_cancel) and should_cancel():
                return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
            _wait_for_slot()
            if callable(should_cancel) and should_cancel():
                return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
            request = urllib.request.Request(url, headers=headers)
            try:
                if strict_evidence:
                    # This is urllib within the existing request lock, not an
                    # alternate network owner or a process-wide opener change.
                    opener = urllib.request.build_opener(_StrictEvidenceHTTPErrorProcessor())
                    response_context = opener.open(request, timeout=float(timeout or 15.0))
                else:
                    response_context = urllib.request.urlopen(request, timeout=float(timeout or 15.0))
                with response_context as response:
                    body = _strict_success_bytes(response) if strict_evidence else response.read()
                    payload = json.loads(body.decode("utf-8"))
                _mark_request_complete()
                if callable(should_cancel) and should_cancel():
                    return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
                if isinstance(payload, dict):
                    _set_cached_value(url, accept, payload, strict_evidence=strict_evidence)
                    return payload, _success_meta("network", strict_evidence=strict_evidence, attempt=attempt)
                _set_cached_value(url, accept, None, strict_evidence=strict_evidence)
                return None, {"status": "invalid_payload", "cache_hit": False, "attempt": attempt}
            except _StrictEvidenceError as exc:
                _mark_request_complete()
                if callable(should_cancel) and should_cancel():
                    return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
                _set_cached_value(url, accept, None, strict_evidence=strict_evidence)
                # A redirect or body overrun is terminal; no retry can silently
                # convert a rejected acquisition into usable provider evidence.
                return None, {"status": str(exc), "cache_hit": False, "attempt": attempt}
            except urllib.error.HTTPError as exc:
                body = b""
                try:
                    body = exc.read(_STRICT_ERROR_MAX_BYTES) if strict_evidence else exc.read()
                except Exception:
                    body = b""
                finally:
                    if strict_evidence:
                        exc.close()
                _mark_request_complete()
                if callable(should_cancel) and should_cancel():
                    return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
                block_reason = _block_reason_from_http_error(int(getattr(exc, "code", 0) or 0), body)
                if block_reason:
                    _set_block(block_reason)
                    _set_cached_value(url, accept, None, strict_evidence=strict_evidence)
                    return None, {"status": "blocked", "cache_hit": False, "attempt": attempt, "blocked_reason": block_reason}
                if _is_retryable_http_status(int(getattr(exc, "code", 0) or 0)) and attempt < _MAX_ATTEMPTS:
                    time.sleep(_backoff_delay(attempt))
                    continue
                _set_cached_value(url, accept, None, strict_evidence=strict_evidence)
                return None, {"status": f"http_{int(getattr(exc, 'code', 0) or 0)}", "cache_hit": False, "attempt": attempt}
            except (urllib.error.URLError, ssl.SSLError, TimeoutError, socket.timeout) as exc:
                _mark_request_complete()
                if callable(should_cancel) and should_cancel():
                    return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
                block_reason = _block_reason_from_exception(getattr(exc, "reason", exc))
                if block_reason:
                    _set_block(block_reason)
                    _set_cached_value(url, accept, None, strict_evidence=strict_evidence)
                    return None, {"status": "blocked", "cache_hit": False, "attempt": attempt, "blocked_reason": block_reason}
                if attempt < _MAX_ATTEMPTS:
                    time.sleep(_backoff_delay(attempt))
                    continue
                _set_cached_value(url, accept, None, strict_evidence=strict_evidence)
                return None, {"status": "connection_error", "cache_hit": False, "attempt": attempt}
            except Exception as exc:
                _mark_request_complete()
                if callable(should_cancel) and should_cancel():
                    return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
                block_reason = _block_reason_from_exception(exc)
                if block_reason:
                    _set_block(block_reason)
                    _set_cached_value(url, accept, None, strict_evidence=strict_evidence)
                    return None, {"status": "blocked", "cache_hit": False, "attempt": attempt, "blocked_reason": block_reason}
                if attempt < _MAX_ATTEMPTS:
                    time.sleep(_backoff_delay(attempt))
                    continue
                _set_cached_value(url, accept, None, strict_evidence=strict_evidence)
                return None, {"status": type(exc).__name__, "cache_hit": False, "attempt": attempt}

    _set_cached_value(url, accept, None, strict_evidence=strict_evidence)
    return None, {"status": "exhausted", "cache_hit": False}


def default_user_agent(app_name: str, app_version: str, contact_email: str) -> str:
    product_name = "".join(ch for ch in str(app_name or "AlbumHaven") if ch.isalnum() or ch in {"-", "_"})
    product_name = product_name or "AlbumHaven"
    comment_name = str(app_name or "Album Haven").strip() or "Album Haven"
    email = str(contact_email or "").strip() or "albumhaven@example.com"
    return f"{product_name}/{str(app_version or '').strip() or '0.0.0'} ({comment_name}; {email})"
