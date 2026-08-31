"""Privacy-preserving breached-password screening for local credentials."""

from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Callable
from typing import Any
from urllib.request import Request, urlopen


_RANGE_URL = "https://api.pwnedpasswords.com/range/{}"
_USER_AGENT = "Album-Haven-Password-Screen/1.0"
_MAX_RESPONSE_BYTES = 65_536
_SUFFIX_LINE = re.compile(r"^([0-9A-F]{35}):([0-9]+)$")


class BreachedPasswordCheckError(RuntimeError):
    """Password screening could not produce a trustworthy answer."""


class HibpRangePasswordChecker:
    """Check Pwned Passwords without transmitting a password or full digest."""

    def __init__(
        self,
        *,
        opener: Callable[..., Any] = urlopen,
        timeout_seconds: float = 3.0,
    ) -> None:
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not 0 < timeout_seconds <= 5
        ):
            raise ValueError("Breached-password checker configuration is invalid.")
        self._opener = opener
        self._timeout_seconds = float(timeout_seconds)

    def __call__(self, password: str) -> bool:
        if not isinstance(password, str) or not password:
            raise ValueError("A non-empty password is required for screening.")

        digest = hashlib.sha1(
            password.encode("utf-8"), usedforsecurity=False
        ).hexdigest().upper()
        prefix, candidate_suffix = digest[:5], digest[5:]
        expected_url = _RANGE_URL.format(prefix)
        request = Request(
            expected_url,
            headers={
                "Add-Padding": "true",
                "User-Agent": _USER_AGENT,
            },
            method="GET",
        )

        try:
            with self._opener(
                request, timeout=self._timeout_seconds
            ) as response:
                if response.getcode() != 200 or response.geturl() != expected_url:
                    raise BreachedPasswordCheckError(
                        "Breached-password screening unavailable."
                    )
                body = response.read(_MAX_RESPONSE_BYTES + 1)
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
