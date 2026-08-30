from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Any
from urllib.parse import urlencode
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

from music_app.services.lastfm_postgres import LastfmPostgresAdapter
from music_app.services.persistence_selection import select_runtime_persistence_adapter

_FALLBACK_IANA_TIMEZONE_PREFIXES = {
    "Africa",
    "America",
    "Antarctica",
    "Arctic",
    "Asia",
    "Atlantic",
    "Australia",
    "Brazil",
    "Canada",
    "Chile",
    "Etc",
    "Europe",
    "Indian",
    "Mexico",
    "Pacific",
    "US",
    "UTC",
}


class LastfmError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: int | None = None,
        retryable: bool = False,
        reauthentication_required: bool = False,
        error_kind: str = "provider_error",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = bool(retryable)
        self.reauthentication_required = bool(reauthentication_required)
        self.error_kind = error_kind


@dataclass(frozen=True)
class LastfmSession:
    username: str
    session_key: str
    connected_at: str


@dataclass(frozen=True)
class LastfmSubmissionOutcome:
    sent: bool
    accepted: int = 0
    ignored: int = 0
    outcome: str = "not_sent"
    ignored_code: int | None = None
    message: str = ""

    @property
    def succeeded(self) -> bool:
        return self.sent and self.accepted > 0


_RETRYABLE_ERROR_CODES = frozenset({11, 16, 29})
_REAUTHENTICATION_ERROR_CODES = frozenset({9})
_RETRYABLE_HTTP_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


def load_lastfm_settings(config: dict[str, Any]) -> dict[str, Any]:
    return _lastfm_settings_adapter(config).load_settings()


def save_lastfm_settings(config: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    return _lastfm_settings_adapter(config).save_settings(settings)


def _lastfm_settings_adapter(config: dict[str, Any]) -> LastfmPostgresAdapter:
    selection = select_runtime_persistence_adapter("lastfm_settings", config)
    if selection.effective_backend != "postgres":
        raise ValueError(
            "File runtime persistence is not supported for lastfm_settings; "
            "Album Haven runtime persistence is Postgres-only."
        )
    return LastfmPostgresAdapter(config)


def normalize_lastfm_user_timezone(value: object) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    try:
        ZoneInfo(normalized)
    except Exception as exc:
        area, _, location = normalized.partition("/")
        if area in _FALLBACK_IANA_TIMEZONE_PREFIXES and location:
            return normalized
        raise LastfmError(f"Unsupported timezone: {normalized}") from exc
    return normalized


def clear_lastfm_settings(config: dict[str, Any]) -> None:
    settings = load_lastfm_settings(config)
    timezone_name = str(settings.get("user_timezone") or "").strip()
    next_settings: dict[str, Any] = {}
    if timezone_name:
        next_settings["user_timezone"] = timezone_name
    save_lastfm_settings(config, next_settings)


def lastfm_api_enabled(config: dict[str, Any]) -> bool:
    return bool(config.get("LASTFM_API_ENABLED"))


def get_saved_lastfm_session(config: dict[str, Any]) -> LastfmSession | None:
    settings = load_lastfm_settings(config)
    username = str(settings.get("username") or "").strip()
    session_key = str(settings.get("session_key") or "").strip()
    connected_at = str(settings.get("connected_at") or "").strip()
    if not username or not session_key:
        return None
    return LastfmSession(username=username, session_key=session_key, connected_at=connected_at)


def get_lastfm_user_timezone(config: dict[str, Any]) -> str:
    settings = load_lastfm_settings(config)
    try:
        return normalize_lastfm_user_timezone(settings.get("user_timezone"))
    except LastfmError:
        return ""


def save_lastfm_user_timezone(config: dict[str, Any], timezone_name: object) -> dict[str, Any]:
    normalized_timezone = normalize_lastfm_user_timezone(timezone_name)
    settings = load_lastfm_settings(config)
    next_settings = dict(settings)
    next_settings["user_timezone"] = normalized_timezone
    save_lastfm_settings(config, next_settings)
    return build_lastfm_status(config)


def build_lastfm_status(config: dict[str, Any]) -> dict[str, Any]:
    settings = load_lastfm_settings(config)
    username = str(settings.get("username") or "").strip()
    session_key = str(settings.get("session_key") or "").strip()
    connected = bool(username and session_key)
    try:
        user_timezone = normalize_lastfm_user_timezone(settings.get("user_timezone"))
    except LastfmError:
        user_timezone = ""
    return {
        "key": "lastfm",
        "title": "Last.FM",
        "description": "Connect your LastFM account to scrobble and import your listening history",
        "api_configured": lastfm_api_enabled(config),
        "connected": connected,
        "username": username if connected else "",
        "connected_at": str(settings.get("connected_at") or "").strip(),
        "user_timezone": user_timezone,
    }


def _build_signature(params: dict[str, Any], api_secret: str) -> str:
    signature_base = "".join(
        f"{key}{value}"
        for key, value in sorted(
            ((str(key), str(value)) for key, value in params.items() if value is not None and key != "format"),
            key=lambda item: item[0],
        )
    )
    signature_base += api_secret
    return hashlib.md5(signature_base.encode("utf-8")).hexdigest()


def _lastfm_error_from_body(
    body: bytes,
    *,
    fallback: str,
    http_status: int | None = None,
) -> LastfmError:
    retryable_http_error = int(http_status or 0) in _RETRYABLE_HTTP_STATUSES
    if not body:
        return LastfmError(fallback, retryable=retryable_http_error)
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        text = body.decode("utf-8", errors="replace").strip()
        return LastfmError(
            f"Malformed XML response from Last.fm: {text or fallback}",
            retryable=retryable_http_error if http_status is not None else True,
            error_kind="malformed_response",
        )
    error = root.find("error")
    if error is None:
        return LastfmError(fallback, retryable=retryable_http_error)
    message = (error.text or fallback).strip() or fallback
    raw_code = str(error.get("code") or "").strip()
    try:
        code = int(raw_code) if raw_code else None
    except ValueError:
        code = None
    if raw_code:
        return LastfmError(
            f"{message} (Last.fm error {raw_code})",
            code=code,
            retryable=code in _RETRYABLE_ERROR_CODES,
            reauthentication_required=code in _REAUTHENTICATION_ERROR_CODES,
            error_kind="invalid_credentials" if code == 4 else "provider_error",
        )
    return LastfmError(message, retryable=retryable_http_error)


def _post_lastfm(config: dict[str, Any], method: str, params: dict[str, Any]) -> ET.Element:
    api_key = str(config.get("LASTFM_API_KEY") or "").strip()
    api_secret = str(config.get("LASTFM_API_SECRET") or "").strip()
    api_root = str(config.get("LASTFM_API_ROOT") or "").strip()
    if not api_key or not api_secret or not api_root:
        raise LastfmError("Last.fm API credentials are not configured on the server.")

    payload = {
        "method": method,
        "api_key": api_key,
        **params,
    }
    payload = {
        key: value
        for key, value in payload.items()
        if value is not None
    }
    payload["api_sig"] = _build_signature(payload, api_secret)

    request = Request(
        api_root,
        data=urlencode(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            "Accept": "application/xml",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=12.0) as response:
            body = response.read()
    except HTTPError as exc:
        raise _lastfm_error_from_body(
            exc.read(),
            fallback=f"Last.fm request failed with HTTP {exc.code}.",
            http_status=int(exc.code),
        ) from exc
    except URLError as exc:
        reason = str(exc.reason or "Network error contacting Last.fm").strip()
        raise LastfmError(
            reason or "Network error contacting Last.fm",
            retryable=True,
            error_kind="network_error",
        ) from exc
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise _lastfm_error_from_body(
            body,
            fallback="Last.fm returned malformed XML.",
        ) from exc
    if root.get("status") == "failed":
        raise _lastfm_error_from_body(body, fallback="Last.fm request failed")
    return root


def authenticate_lastfm(
    config: dict[str, Any],
    username: str,
    password: str,
    *,
    connected_at: str,
    user_timezone: str = "",
) -> dict[str, Any]:
    normalized_username = str(username or "").strip()
    normalized_password = str(password or "")
    if not normalized_username or not normalized_password:
        raise LastfmError("Last.fm username and password are required.")

    root = _post_lastfm(
        config,
        "auth.getMobileSession",
        {
            "username": normalized_username,
            "password": normalized_password,
        },
    )
    session_node = root.find("session")
    session_username = (session_node.findtext("name", default="") if session_node is not None else "").strip()
    session_key = (session_node.findtext("key", default="") if session_node is not None else "").strip()
    if not session_username or not session_key:
        raise LastfmError("Last.fm did not return a valid session.")

    settings = {
        "username": session_username,
        "session_key": session_key,
        "connected_at": connected_at,
    }
    normalized_timezone = normalize_lastfm_user_timezone(user_timezone) if str(user_timezone or "").strip() else get_lastfm_user_timezone(config)
    if normalized_timezone:
        settings["user_timezone"] = normalized_timezone
    save_lastfm_settings(config, settings)
    return build_lastfm_status(config)


def update_now_playing(config: dict[str, Any], payload: dict[str, Any]) -> LastfmSubmissionOutcome:
    session = get_saved_lastfm_session(config)
    if session is None:
        return LastfmSubmissionOutcome(sent=False, outcome="not_connected", message="Last.fm account is not connected.")
    artist = str(payload.get("artist") or "").strip()
    track = str(payload.get("track") or "").strip()
    if not artist or not track:
        return LastfmSubmissionOutcome(sent=False, outcome="invalid_payload", message="Artist and track are required.")
    _post_lastfm(
        config,
        "track.updateNowPlaying",
        {
            "sk": session.session_key,
            "artist": artist,
            "track": track,
            "album": str(payload.get("album") or "").strip(),
            "albumArtist": str(payload.get("album_artist") or "").strip(),
            "duration": int(payload.get("duration") or 0) or None,
            "trackNumber": str(payload.get("track_number") or "").strip() or None,
        },
    )
    return LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted")


def scrobble_track(config: dict[str, Any], payload: dict[str, Any]) -> LastfmSubmissionOutcome:
    session = get_saved_lastfm_session(config)
    if session is None:
        return LastfmSubmissionOutcome(sent=False, outcome="not_connected", message="Last.fm account is not connected.")
    artist = str(payload.get("artist") or "").strip()
    track = str(payload.get("track") or "").strip()
    timestamp = int(payload.get("timestamp") or 0)
    if not artist or not track or timestamp <= 0:
        return LastfmSubmissionOutcome(sent=False, outcome="invalid_payload", message="Artist, track, and timestamp are required.")
    root = _post_lastfm(
        config,
        "track.scrobble",
        {
            "sk": session.session_key,
            "artist": artist,
            "track": track,
            "timestamp": timestamp,
            "album": str(payload.get("album") or "").strip(),
            "albumArtist": str(payload.get("album_artist") or "").strip(),
            "duration": int(payload.get("duration") or 0) or None,
            "trackNumber": str(payload.get("track_number") or "").strip() or None,
            "chosenByUser": 1,
        },
    )
    scrobbles = root.find("scrobbles")
    if scrobbles is None:
        raise LastfmError(
            "Last.fm scrobble response did not include an outcome.",
            retryable=True,
            error_kind="malformed_response",
        )
    try:
        accepted = max(0, int(scrobbles.get("accepted") or 0))
        ignored = max(0, int(scrobbles.get("ignored") or 0))
    except (TypeError, ValueError) as exc:
        raise LastfmError(
            "Last.fm scrobble response contained invalid outcome counts.",
            retryable=True,
            error_kind="malformed_response",
        ) from exc
    ignored_message = scrobbles.find("./scrobble/ignoredmessage")
    if ignored_message is None:
        ignored_message = scrobbles.find("./scrobble/ignoredMessage")
    raw_ignored_code = str(ignored_message.get("code") or "").strip() if ignored_message is not None else ""
    try:
        ignored_code = int(raw_ignored_code) if raw_ignored_code else None
    except ValueError:
        ignored_code = None
    message = (ignored_message.text or "").strip() if ignored_message is not None else ""
    if accepted <= 0:
        return LastfmSubmissionOutcome(
            sent=True,
            accepted=0,
            ignored=ignored,
            outcome="ignored",
            ignored_code=ignored_code,
            message=message or "Last.fm ignored the scrobble.",
        )
    return LastfmSubmissionOutcome(
        sent=True,
        accepted=accepted,
        ignored=ignored,
        outcome="accepted",
        ignored_code=ignored_code,
        message=message,
    )
