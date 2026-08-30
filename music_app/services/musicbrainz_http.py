from __future__ import annotations

import json
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable

_MIN_REQUEST_INTERVAL_SECONDS = 1.05
_MAX_ATTEMPTS = 3
_SUCCESS_CACHE_TTL_SECONDS = 60 * 60 * 6
_MISS_CACHE_TTL_SECONDS = 60 * 15
_BLOCK_COOLDOWN_SECONDS = 60 * 15

_REQUEST_LOCK = threading.Lock()
_STATE_LOCK = threading.Lock()
_CACHE_LOCK = threading.Lock()
_NEXT_ALLOWED_AT_MONOTONIC = 0.0
_BLOCKED_UNTIL = 0.0
_BLOCK_REASON = ""
_CACHE_MISS = object()
_URL_CACHE: dict[str, dict[str, object]] = {}


def _cache_key(url: str, accept: str) -> str:
    return f"{accept}::{str(url or '').strip()}"


def _get_cached_value(url: str, accept: str) -> object | None:
    cache_key = _cache_key(url, accept)
    now = time.time()
    with _CACHE_LOCK:
        entry = _URL_CACHE.get(cache_key)
        if not isinstance(entry, dict):
            return None
        updated_at = float(entry.get("updated_at") or 0.0)
        ok = bool(entry.get("ok"))
        ttl = _SUCCESS_CACHE_TTL_SECONDS if ok else _MISS_CACHE_TTL_SECONDS
        if not updated_at or now - updated_at > ttl:
            _URL_CACHE.pop(cache_key, None)
            return None
        payload = entry.get("payload")
        if ok and isinstance(payload, dict):
            return dict(payload)
        return _CACHE_MISS


def _set_cached_value(url: str, accept: str, payload: dict | None) -> None:
    cache_key = _cache_key(url, accept)
    with _CACHE_LOCK:
        _URL_CACHE[cache_key] = {
            "updated_at": time.time(),
            "ok": isinstance(payload, dict),
            "payload": dict(payload) if isinstance(payload, dict) else None,
        }


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
) -> tuple[dict | None, dict[str, object]]:
    del context
    if callable(should_cancel) and should_cancel():
        return None, {"status": "canceled", "cache_hit": False, "attempt": 0}
    cached = _get_cached_value(url, accept)
    if cached is _CACHE_MISS:
        return None, {"status": "cached_miss", "cache_hit": True}
    if isinstance(cached, dict):
        return cached, {"status": "cache", "cache_hit": True}

    with _REQUEST_LOCK:
        if callable(should_cancel) and should_cancel():
            return None, {"status": "canceled", "cache_hit": False, "attempt": 0}
        cached = _get_cached_value(url, accept)
        if cached is _CACHE_MISS:
            return None, {"status": "cached_miss", "cache_hit": True}
        if isinstance(cached, dict):
            return cached, {"status": "cache", "cache_hit": True}

        blocked, retry_after_seconds, blocked_reason = _blocked_state()
        if blocked:
            _set_cached_value(url, accept, None)
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
                with urllib.request.urlopen(request, timeout=float(timeout or 15.0)) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                _mark_request_complete()
                if callable(should_cancel) and should_cancel():
                    return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
                if isinstance(payload, dict):
                    _set_cached_value(url, accept, payload)
                    return payload, {"status": "network", "cache_hit": False, "attempt": attempt}
                _set_cached_value(url, accept, None)
                return None, {"status": "invalid_payload", "cache_hit": False, "attempt": attempt}
            except urllib.error.HTTPError as exc:
                body = b""
                try:
                    body = exc.read()
                except Exception:
                    body = b""
                _mark_request_complete()
                if callable(should_cancel) and should_cancel():
                    return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
                block_reason = _block_reason_from_http_error(int(getattr(exc, "code", 0) or 0), body)
                if block_reason:
                    _set_block(block_reason)
                    _set_cached_value(url, accept, None)
                    return None, {"status": "blocked", "cache_hit": False, "attempt": attempt, "blocked_reason": block_reason}
                if _is_retryable_http_status(int(getattr(exc, "code", 0) or 0)) and attempt < _MAX_ATTEMPTS:
                    time.sleep(_backoff_delay(attempt))
                    continue
                _set_cached_value(url, accept, None)
                return None, {"status": f"http_{int(getattr(exc, 'code', 0) or 0)}", "cache_hit": False, "attempt": attempt}
            except (urllib.error.URLError, ssl.SSLError, TimeoutError, socket.timeout) as exc:
                _mark_request_complete()
                if callable(should_cancel) and should_cancel():
                    return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
                block_reason = _block_reason_from_exception(getattr(exc, "reason", exc))
                if block_reason:
                    _set_block(block_reason)
                    _set_cached_value(url, accept, None)
                    return None, {"status": "blocked", "cache_hit": False, "attempt": attempt, "blocked_reason": block_reason}
                if attempt < _MAX_ATTEMPTS:
                    time.sleep(_backoff_delay(attempt))
                    continue
                _set_cached_value(url, accept, None)
                return None, {"status": "connection_error", "cache_hit": False, "attempt": attempt}
            except Exception as exc:
                _mark_request_complete()
                if callable(should_cancel) and should_cancel():
                    return None, {"status": "canceled", "cache_hit": False, "attempt": attempt}
                block_reason = _block_reason_from_exception(exc)
                if block_reason:
                    _set_block(block_reason)
                    _set_cached_value(url, accept, None)
                    return None, {"status": "blocked", "cache_hit": False, "attempt": attempt, "blocked_reason": block_reason}
                if attempt < _MAX_ATTEMPTS:
                    time.sleep(_backoff_delay(attempt))
                    continue
                _set_cached_value(url, accept, None)
                return None, {"status": type(exc).__name__, "cache_hit": False, "attempt": attempt}

    _set_cached_value(url, accept, None)
    return None, {"status": "exhausted", "cache_hit": False}


def default_user_agent(app_name: str, app_version: str, contact_email: str) -> str:
    product_name = "".join(ch for ch in str(app_name or "AlbumHaven") if ch.isalnum() or ch in {"-", "_"})
    product_name = product_name or "AlbumHaven"
    comment_name = str(app_name or "Album Haven").strip() or "Album Haven"
    email = str(contact_email or "").strip() or "albumhaven@example.com"
    return f"{product_name}/{str(app_version or '').strip() or '0.0.0'} ({comment_name}; {email})"
