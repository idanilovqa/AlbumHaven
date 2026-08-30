from __future__ import annotations

import json
import logging
import re
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

try:
    import certifi
except ImportError:
    certifi = None

_HTTP_TRACE_LOCAL = threading.local()
_DEFAULT_LOGGER = logging.getLogger(__name__)
_NO_WINDOW_CREATION_FLAGS = (
    getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if sys.platform.startswith("win")
    else 0
)


def _noop_app_event_logger(config, logger, action: str, **fields) -> None:
    return None


def _noop_apple_trace(*, context: str, status: str, elapsed_ms: float) -> None:
    return None


def _noop_rate_limit_marker() -> None:
    return None


def _log_verbose(logger, *args) -> None:
    verbose = getattr(logger, "verbose", None)
    if callable(verbose):
        verbose(*args)
        return
    logger.debug(*args)


def _http_ssl_context() -> ssl.SSLContext:
    if certifi is not None:
        try:
            return ssl.create_default_context(cafile=certifi.where())
        except Exception:
            pass
    return ssl.create_default_context()


def _truncate_log_payload(value: bytes | str, limit: int = 400) -> str:
    if isinstance(value, bytes):
        text = value.decode("utf-8", errors="ignore")
    else:
        text = value
    compact = re.sub(r"\s+", " ", text).strip()
    return compact[:limit]


def _sanitize_url_for_log(url: str) -> str:
    split = urllib.parse.urlsplit(str(url or "").strip())
    if not split.netloc:
        return str(url or "").strip()
    filtered_query = urllib.parse.urlencode([
        (key, value)
        for key, value in urllib.parse.parse_qsl(split.query, keep_blank_values=True)
        if str(key or "").strip().casefold() not in {"key", "secret", "token", "oauth_token"}
    ])
    return urllib.parse.urlunsplit((split.scheme, split.netloc, split.path, filtered_query, ""))


def _http_request_headers(
    url: str,
    user_agent: str,
    accept: str = "*/*",
    *,
    extra_headers: dict[str, str] | None = None,
) -> dict[str, str]:
    split_url = urllib.parse.urlsplit(url)
    headers = {
        "User-Agent": user_agent,
        "Accept": accept,
    }
    for header_key, header_value in (extra_headers or {}).items():
        if str(header_key or "").strip() and str(header_value or "").strip():
            headers[str(header_key)] = str(header_value)
    if "progarchives.com" in (split_url.netloc or "").casefold():
        headers["Referer"] = "https://www.progarchives.com/"
    return headers


def _http_get_bytes(
    url: str,
    user_agent: str,
    accept: str = "*/*",
    *,
    service: str = "remote",
    context: str = "",
    extra_headers: dict[str, str] | None = None,
    logger=None,
    app_event_logger: Callable[..., None] | None = None,
    append_apple_request_trace: Callable[..., None] | None = None,
    mark_discogs_rate_limited: Callable[[], None] | None = None,
) -> bytes | None:
    active_logger = logger or _DEFAULT_LOGGER
    emit_app_event = app_event_logger or _noop_app_event_logger
    append_trace = append_apple_request_trace or _noop_apple_trace
    mark_rate_limited = mark_discogs_rate_limited or _noop_rate_limit_marker
    started_at = time.perf_counter()
    _HTTP_TRACE_LOCAL.last_url = url
    headers = _http_request_headers(
        url,
        user_agent,
        accept,
        extra_headers=extra_headers,
    )
    request = urllib.request.Request(
        url,
        headers=headers,
    )
    ssl_context = _http_ssl_context()
    try:
        with urllib.request.urlopen(request, timeout=15, context=ssl_context) as response:
            _HTTP_TRACE_LOCAL.last_url = str(getattr(response, "url", url) or url)
            payload = response.read()
            elapsed_ms = (time.perf_counter() - started_at) * 1000
            if service == "apple":
                append_trace(
                    context=context,
                    status=f"success:{getattr(response, 'status', 'unknown')}",
                    elapsed_ms=elapsed_ms,
                )
            _log_verbose(
                active_logger,
                "Cover HTTP success service=%s context=%s status=%s url=%s bytes=%s",
                service,
                context,
                getattr(response, "status", None),
                _sanitize_url_for_log(url),
                len(payload),
            )
            return payload
    except urllib.error.HTTPError as exc:
        body = b""
        try:
            body = exc.read()
        except Exception:
            body = b""
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        if service == "apple":
            append_trace(
                context=context,
                status=f"http_error:{getattr(exc, 'code', 'unknown')}",
                elapsed_ms=elapsed_ms,
            )
        _log_verbose(
            active_logger,
            "Cover HTTP error service=%s context=%s status=%s url=%s body=%r",
            service,
            context,
            getattr(exc, "code", None),
            _sanitize_url_for_log(url),
            _truncate_log_payload(body),
        )
        if service == "discogs":
            if int(getattr(exc, "code", 0) or 0) == 429:
                mark_rate_limited()
            rate_limit_remaining = ""
            rate_limit_total = ""
            try:
                rate_limit_remaining = str(exc.headers.get("X-Discogs-Ratelimit-Remaining") or "")
                rate_limit_total = str(exc.headers.get("X-Discogs-Ratelimit") or "")
            except Exception:
                rate_limit_remaining = ""
                rate_limit_total = ""
            emit_app_event(
                {},
                active_logger,
                "Discogs HTTP error",
                level="info",
                context=context,
                status=getattr(exc, "code", None),
                url=_sanitize_url_for_log(url),
                body=_truncate_log_payload(body),
                rate_limit_remaining=rate_limit_remaining,
                rate_limit_total=rate_limit_total,
            )
        return None
    except urllib.error.URLError as exc:
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        reason = getattr(exc, "reason", exc)
        is_timeout = isinstance(reason, socket.timeout) or isinstance(reason, TimeoutError) or "timed out" in str(reason).lower()
        if service == "apple":
            append_trace(
                context=context,
                status="timeout" if is_timeout else "url_error",
                elapsed_ms=elapsed_ms,
            )
        _log_verbose(
            active_logger,
            "Cover HTTP url error service=%s context=%s url=%s reason=%r",
            service,
            context,
            _sanitize_url_for_log(url),
            reason,
        )
        if service == "discogs":
            emit_app_event(
                {},
                active_logger,
                "Discogs URL error",
                level="info",
                context=context,
                url=_sanitize_url_for_log(url),
                reason=str(reason),
                timeout=bool(is_timeout),
            )
        return None
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        if service == "apple":
            append_trace(
                context=context,
                status=type(exc).__name__,
                elapsed_ms=elapsed_ms,
            )
        _log_verbose(
            active_logger,
            "Cover HTTP unexpected error service=%s context=%s url=%s error=%r",
            service,
            context,
            _sanitize_url_for_log(url),
            exc,
        )
        if service == "discogs":
            emit_app_event(
                {},
                active_logger,
                "Discogs unexpected HTTP error",
                level="info",
                context=context,
                url=_sanitize_url_for_log(url),
                error_type=type(exc).__name__,
                error=str(exc),
            )
        return None


def _http_get_json(
    url: str,
    user_agent: str,
    *,
    service: str = "remote",
    context: str = "",
    extra_headers: dict[str, str] | None = None,
    logger=None,
    app_event_logger: Callable[..., None] | None = None,
    musicbrainz_json_getter: Callable[..., tuple[object, dict[str, object]]] | None = None,
    http_get_bytes: Callable[..., bytes | None] | None = None,
    append_apple_request_trace: Callable[..., None] | None = None,
    mark_discogs_rate_limited: Callable[[], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict | None:
    active_logger = logger or _DEFAULT_LOGGER
    emit_app_event = app_event_logger or _noop_app_event_logger
    if http_get_bytes is None:
        def get_bytes(url_arg: str, **kwargs) -> bytes | None:
            return _http_get_bytes(
                url_arg,
                **kwargs,
                logger=active_logger,
                app_event_logger=emit_app_event,
                append_apple_request_trace=append_apple_request_trace,
                mark_discogs_rate_limited=mark_discogs_rate_limited,
            )
    else:
        get_bytes = http_get_bytes
    if service == "musicbrainz":
        if musicbrainz_json_getter is None:
            raise RuntimeError("musicbrainz_json_getter is required for MusicBrainz HTTP JSON requests")
        musicbrainz_kwargs = {
            "context": context,
            "extra_headers": extra_headers,
            "timeout": 15.0,
        }
        if callable(should_cancel):
            musicbrainz_kwargs["should_cancel"] = should_cancel
        payload, meta = musicbrainz_json_getter(url, user_agent, **musicbrainz_kwargs)
        if isinstance(payload, dict):
            if int(meta.get("attempt") or 1) > 1:
                emit_app_event(
                    {},
                    active_logger,
                    "MusicBrainz JSON retry succeeded",
                    level="info",
                    context=context,
                    attempt=int(meta.get("attempt") or 1),
                    url=url,
                )
            return payload
        emit_app_event(
            {},
            active_logger,
            "MusicBrainz JSON request returned no payload",
            level="info",
            context=context,
            attempt=int(meta.get("attempt") or 1),
            url=url,
            status=str(meta.get("status") or ""),
            cache_hit=bool(meta.get("cache_hit")),
            blocked_reason=str(meta.get("blocked_reason") or ""),
            retry_after_seconds=float(meta.get("retry_after_seconds") or 0.0),
        )
        return None

    attempts = 2 if service == "discogs" else 1
    for attempt in range(1, attempts + 1):
        payload = get_bytes(
            url,
            user_agent=user_agent,
            accept="application/json",
            service=service,
            context=context,
            extra_headers=extra_headers,
        )
        if payload:
            try:
                decoded = json.loads(payload.decode("utf-8"))
                if service == "deezer":
                    data_items = decoded.get("data") if isinstance(decoded, dict) else None
                    emit_app_event(
                        {},
                        active_logger,
                        "Deezer JSON response received",
                        level="info",
                        context=context,
                        attempt=attempt,
                        url=url,
                        payload_type=type(decoded).__name__,
                        item_count=len(data_items) if isinstance(data_items, list) else 0,
                        has_data_list=isinstance(data_items, list),
                        has_total=isinstance(decoded, dict) and "total" in decoded,
                        has_error=isinstance(decoded, dict) and bool(decoded.get("error")),
                        error=decoded.get("error") if isinstance(decoded, dict) else None,
                    )
                return decoded if isinstance(decoded, dict) else None
            except Exception as exc:
                _log_verbose(
                    active_logger,
                    "Cover JSON decode failed service=%s context=%s url=%s error=%r payload=%r",
                    service,
                    context,
                    url,
                    exc,
                    _truncate_log_payload(payload),
                )
                if service == "deezer":
                    emit_app_event(
                        {},
                        active_logger,
                        "Deezer JSON decode failed",
                        level="info",
                        context=context,
                        attempt=attempt,
                        url=url,
                        error_type=type(exc).__name__,
                        error=str(exc),
                    )
                return None
        if service == "deezer":
            emit_app_event(
                {},
                active_logger,
                "Deezer JSON request returned no payload",
                level="info",
                context=context,
                attempt=attempt,
                url=url,
            )
        elif service == "discogs":
            emit_app_event(
                {},
                active_logger,
                "Discogs JSON request returned no payload",
                level="info",
                context=context,
                attempt=attempt,
                url=_sanitize_url_for_log(url),
            )
    return None


def _http_get_json_via_curl(
    url: str,
    *,
    user_agent: str,
    context: str = "",
    logger=None,
    app_event_logger: Callable[..., None] | None = None,
) -> dict | None:
    active_logger = logger or _DEFAULT_LOGGER
    emit_app_event = app_event_logger or _noop_app_event_logger
    curl_path = shutil.which("curl")
    if not curl_path:
        emit_app_event(
            {},
            active_logger,
            "MusicBrainz curl fallback unavailable",
            level="info",
            context=context,
            reason="curl_not_found",
            url=url,
        )
        return None
    try:
        completed = subprocess.run(
            [
                curl_path,
                "--silent",
                "--show-error",
                "--location",
                "--max-time",
                "20",
                "--header",
                f"User-Agent: {user_agent}",
                "--header",
                "Accept: application/json",
                url,
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=25,
            creationflags=_NO_WINDOW_CREATION_FLAGS,
        )
    except Exception as exc:
        emit_app_event(
            {},
            active_logger,
            "MusicBrainz curl fallback failed",
            level="info",
            context=context,
            reason=type(exc).__name__,
            url=url,
        )
        return None
    if completed.returncode != 0:
        emit_app_event(
            {},
            active_logger,
            "MusicBrainz curl fallback failed",
            level="info",
            context=context,
            reason=f"exit_{completed.returncode}",
            stderr=_truncate_log_payload(completed.stderr or ""),
            url=url,
        )
        return None
    try:
        payload = json.loads(completed.stdout or "")
        emit_app_event(
            {},
            active_logger,
            "MusicBrainz curl fallback succeeded",
            level="info",
            context=context,
            url=url,
        )
        return payload if isinstance(payload, dict) else None
    except Exception:
        emit_app_event(
            {},
            active_logger,
            "MusicBrainz curl fallback failed",
            level="info",
            context=context,
            reason="json_decode_failed",
            stdout=_truncate_log_payload(completed.stdout or ""),
            url=url,
        )
        return None


def _http_get_json_via_subprocess(
    url: str,
    *,
    user_agent: str,
    context: str = "",
    service: str = "remote",
    logger=None,
    app_event_logger: Callable[..., None] | None = None,
) -> dict | None:
    active_logger = logger or _DEFAULT_LOGGER
    emit_app_event = app_event_logger or _noop_app_event_logger
    helper_code = r"""
import json, ssl, sys, urllib.request
try:
    import certifi
except ImportError:
    certifi = None

url = sys.argv[1]
user_agent = sys.argv[2]
req = urllib.request.Request(url, headers={"User-Agent": user_agent, "Accept": "application/json"})
if certifi is not None:
    context = ssl.create_default_context(cafile=certifi.where())
else:
    context = ssl.create_default_context()
with urllib.request.urlopen(req, timeout=20, context=context) as resp:
    payload = json.load(resp)
print(json.dumps(payload))
"""
    try:
        completed = subprocess.run(
            [sys.executable, "-c", helper_code, str(url or ""), str(user_agent or "")],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
            creationflags=_NO_WINDOW_CREATION_FLAGS,
        )
    except Exception as exc:
        emit_app_event(
            {},
            active_logger,
            f"{service.title()} subprocess fallback failed",
            level="info",
            context=context,
            reason=type(exc).__name__,
            url=url,
        )
        return None
    if completed.returncode != 0:
        emit_app_event(
            {},
            active_logger,
            f"{service.title()} subprocess fallback failed",
            level="info",
            context=context,
            reason=f"exit_{completed.returncode}",
            stderr=_truncate_log_payload(completed.stderr or ""),
            url=url,
        )
        return None
    try:
        payload = json.loads(completed.stdout or "")
    except Exception:
        emit_app_event(
            {},
            active_logger,
            f"{service.title()} subprocess fallback failed",
            level="info",
            context=context,
            reason="json_decode_failed",
            stdout=_truncate_log_payload(completed.stdout or ""),
            url=url,
        )
        return None
    if isinstance(payload, dict):
        emit_app_event(
            {},
            active_logger,
            f"{service.title()} subprocess fallback succeeded",
            level="info",
            context=context,
            url=url,
        )
        return payload
    return None


def _http_get_text(
    url: str,
    user_agent: str,
    *,
    service: str = "remote",
    context: str = "",
    logger=None,
    http_get_bytes: Callable[..., bytes | None] | None = None,
    app_event_logger: Callable[..., None] | None = None,
    append_apple_request_trace: Callable[..., None] | None = None,
    mark_discogs_rate_limited: Callable[[], None] | None = None,
) -> str | None:
    if http_get_bytes is None:
        payload = _http_get_bytes(
            url,
            user_agent=user_agent,
            accept="text/html,application/xhtml+xml",
            service=service,
            context=context,
            logger=logger,
            app_event_logger=app_event_logger,
            append_apple_request_trace=append_apple_request_trace,
            mark_discogs_rate_limited=mark_discogs_rate_limited,
        )
    else:
        payload = http_get_bytes(
            url,
            user_agent=user_agent,
            accept="text/html,application/xhtml+xml",
            service=service,
            context=context,
        )
    if not payload:
        return None
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        return payload.decode("utf-8", errors="ignore")


def _http_get_text_with_url(
    url: str,
    user_agent: str,
    *,
    service: str = "remote",
    context: str = "",
    logger=None,
    http_get_bytes: Callable[..., bytes | None] | None = None,
    app_event_logger: Callable[..., None] | None = None,
    append_apple_request_trace: Callable[..., None] | None = None,
    mark_discogs_rate_limited: Callable[[], None] | None = None,
) -> tuple[str | None, str]:
    if http_get_bytes is None:
        payload = _http_get_bytes(
            url,
            user_agent=user_agent,
            accept="text/html,application/xhtml+xml",
            service=service,
            context=context,
            logger=logger,
            app_event_logger=app_event_logger,
            append_apple_request_trace=append_apple_request_trace,
            mark_discogs_rate_limited=mark_discogs_rate_limited,
        )
    else:
        payload = http_get_bytes(
            url,
            user_agent=user_agent,
            accept="text/html,application/xhtml+xml",
            service=service,
            context=context,
        )
    if not payload:
        return None, url
    final_url = str(getattr(_HTTP_TRACE_LOCAL, "last_url", url) or url)
    try:
        return payload.decode("utf-8"), final_url
    except UnicodeDecodeError:
        return payload.decode("utf-8", errors="ignore"), final_url
