"""Privacy-preserving breached-password screening for local credentials."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


_RANGE_URL = "https://api.pwnedpasswords.com/range/{}"
_USER_AGENT = "Album-Haven-Password-Screen/1.0"
# Padded HIBP range responses can exceed 64 KiB for dense SHA-1 prefixes.
# Keep a bounded read while allowing ample headroom over observed valid payloads.
_MAX_RESPONSE_BYTES = 262_144
_SUFFIX_LINE = re.compile(r"^([0-9A-F]{35}):([0-9]+)$")


class BreachedPasswordCheckError(RuntimeError):
    """Password screening could not produce a trustworthy answer."""


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BreachedPasswordCheckError("Breached-password screening unavailable.")


class HibpRangePasswordChecker:
    """Check Pwned Passwords without transmitting a password or full digest."""

    def __init__(
        self,
        *,
        opener: Callable[..., Any] | None = None,
        timeout_seconds: float = 3.0,
        range_url_template: str | None = None,
    ) -> None:
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not 0 < timeout_seconds <= 5
        ):
            raise ValueError("Breached-password checker configuration is invalid.")
        # An injected opener is a trusted synchronous test/embedding seam. The
        # production transport runs in a disposable process so DNS and slow
        # header/body streams cannot retain shared password-verification slots.
        self._opener = opener
        self._timeout_seconds = float(timeout_seconds)
        self._range_url_template = _validate_range_url_template(
            range_url_template
            if range_url_template is not None
            else os.environ.get("ALBUM_HAVEN_HIBP_RANGE_URL_TEMPLATE", _RANGE_URL)
        )

    def __call__(self, password: str) -> bool:
        if not isinstance(password, str) or not password:
            raise ValueError("A non-empty password is required for screening.")

        digest = hashlib.sha1(
            password.encode("utf-8"), usedforsecurity=False
        ).hexdigest().upper()
        prefix, candidate_suffix = digest[:5], digest[5:]
        expected_url = self._range_url_template.format(prefix)
        try:
            if self._opener is None:
                body = _read_range_in_subprocess(
                    self._range_url_template, prefix, self._timeout_seconds
                )
            else:
                body = _read_range(expected_url, self._opener, self._timeout_seconds)
            suffixes = _parse_range_response(body)
        except BreachedPasswordCheckError:
            raise
        except Exception:
            raise BreachedPasswordCheckError(
                "Breached-password screening unavailable."
            ) from None

        matched_count = 0
        for suffix, count in suffixes:
            if hmac.compare_digest(suffix, candidate_suffix):
                matched_count = count
        return matched_count > 0


def _read_range(expected_url: str, opener: Callable[..., Any], timeout: float) -> bytes:
    request = Request(
        expected_url,
        headers={"Add-Padding": "true", "User-Agent": _USER_AGENT},
        method="GET",
    )
    with opener(request, timeout=timeout) as response:
        if response.getcode() != 200 or response.geturl() != expected_url:
            raise BreachedPasswordCheckError("Breached-password screening unavailable.")
        return response.read(_MAX_RESPONSE_BYTES + 1)


def _read_range_in_subprocess(template: str, prefix: str, timeout: float) -> bytes:
    deadline = time.monotonic() + timeout
    # Execute this stdlib-only file directly, without importing the application
    # package or site hooks. Only the five-character prefix crosses the boundary.
    with subprocess.Popen(
        [sys.executable, "-I", "-S", os.path.abspath(__file__),
         "--fetch-range", template, prefix, str(timeout)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    ) as child:
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(child.args, timeout)
            body, _ = child.communicate(timeout=remaining)
            if child.returncode != 0:
                raise BreachedPasswordCheckError("Breached-password screening unavailable.")
            return body
        except BaseException:
            # Reap before releasing the caller's verification capacity. The
            # worker starts no descendants; killing it also closes the pipe and
            # releases Windows communicate reader threads.
            if child.poll() is None:
                child.kill()
            child.communicate()
            raise


def _validate_range_url_template(value: object) -> str:
    template = str(value or "").strip()
    if template.count("{}") != 1:
        raise ValueError("Breached-password range URL template is invalid.")
    try:
        parsed = urlsplit(template.format("ABCDE"))
        port = parsed.port
    except (ValueError, TypeError) as exc:
        raise ValueError("Breached-password range URL template is invalid.") from exc
    if (
        not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.scheme not in {"http", "https"}
    ):
        raise ValueError("Breached-password range URL template is invalid.")
    if parsed.scheme == "http" and parsed.hostname.casefold() not in {
        "127.0.0.1",
        "::1",
        "localhost",
    }:
        raise ValueError("Breached-password range URL must use HTTPS outside loopback.")
    is_loopback = parsed.hostname.casefold() in {"127.0.0.1", "::1", "localhost"}
    if not is_loopback and template != _RANGE_URL:
        raise ValueError(
            "Breached-password range URL must use the official service or loopback."
        )
    if port is not None and not 1 <= port <= 65_535:
        raise ValueError("Breached-password range URL template is invalid.")
    return template


def _parse_range_response(body: object) -> tuple[tuple[str, int], ...]:
    if not isinstance(body, bytes) or not body or len(body) > _MAX_RESPONSE_BYTES:
        raise BreachedPasswordCheckError(
            "Breached-password screening unavailable."
        )
    try:
        text = body.decode("ascii")
    except UnicodeDecodeError:
        raise BreachedPasswordCheckError(
            "Breached-password screening unavailable."
        ) from None

    parsed: list[tuple[str, int]] = []
    seen: set[str] = set()
    for raw_line in text.splitlines():
        match = _SUFFIX_LINE.fullmatch(raw_line)
        if match is None or match.group(1) in seen:
            raise BreachedPasswordCheckError(
                "Breached-password screening unavailable."
            )
        suffix = match.group(1)
        seen.add(suffix)
        parsed.append((suffix, int(match.group(2))))
    if not parsed:
        raise BreachedPasswordCheckError(
            "Breached-password screening unavailable."
        )
    return tuple(parsed)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 5 or sys.argv[1] != "--fetch-range":
            raise ValueError("Invalid transport invocation.")
        template = _validate_range_url_template(sys.argv[2])
        prefix = sys.argv[3]
        timeout = float(sys.argv[4])
        if not re.fullmatch(r"[0-9A-F]{5}", prefix) or not 0 < timeout <= 5:
            raise ValueError("Invalid transport invocation.")
        body = _read_range(template.format(prefix), build_opener(_RejectRedirects()).open, timeout)
        sys.stdout.buffer.write(body)
    except Exception:
        # Do not expose URL, environment, network exception, or response data.
        sys.exit(1)
