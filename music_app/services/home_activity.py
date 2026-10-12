"""Scoped Home read models over the existing meaningful-listen ledger."""
from __future__ import annotations

from calendar import monthrange
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import math
import re
import secrets
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from music_app.services.allowed_actions import AllowedActions
from music_app.services.auth_tokens import hash_opaque_token
from music_app.services.listen_history import normalize_listen_history_rows

KINDS = ("tracks", "albums", "artists", "listens")
PERIOD_LABELS = {"week": "Last week", "month": "Last month", "six": "Last 6 months",
                 "year": "Last year", "all": "All time"}
PAGE_SIZE = 100
_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}", re.ASCII)
_CURSOR = re.compile(r"[A-Za-z0-9_-]{43}\.[1-9][0-9]{0,17}\.[a-f0-9]{64}", re.ASCII)


class HomeActivityError(ValueError):
    def __init__(self, message="Invalid activity query.", status_code=422, code="invalid_activity_query"):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


@dataclass(frozen=True)
class ActivityScope:
    account_id: int
    session_id: int
    library_id: int
    subject_account_id: int | None = None
    audience: str = "own"

    def __post_init__(self):
        if any(type(value) is not int or value <= 0 for value in (
            self.account_id, self.session_id, self.library_id,
        )):
            raise HomeActivityError("Authenticated activity scope is required.", 403, "activity_denied")
        if (not isinstance(self.audience, str) or self.audience not in {"own", "friend", "comparison"}
                or self.audience == "own" and self.subject_account_id is not None
                or self.audience != "own" and (type(self.subject_account_id) is not int
                    or self.subject_account_id <= 0 or self.subject_account_id == self.account_id)):
            raise HomeActivityError("Authenticated activity scope is required.", 403, "activity_denied")

    @property
    def source_account_id(self):
        return self.account_id if self.audience == "own" else self.subject_account_id

    @property
    def read_action(self):
        return "library.browse.read" if self.audience == "own" else "library.social.history.read"



@dataclass(frozen=True)
class ActivityQuery:
    kind: str = "albums"
    period: str = "week"
    snapshot_ref: str | None = None
    cursor: str | None = None
    page: int | None = None
    page_size: int = PAGE_SIZE

    @property
    def numbered(self):
        return self.period not in {"week", "month"}

    def __post_init__(self):
        if (not isinstance(self.kind, str) or not isinstance(self.period, str)
                or self.kind not in KINDS or self.period not in PERIOD_LABELS
                or type(self.page_size) is not int or self.page_size != PAGE_SIZE):
            raise HomeActivityError()
        if self.snapshot_ref is not None and (not isinstance(self.snapshot_ref, str) or not _TOKEN.fullmatch(self.snapshot_ref)):
            raise HomeActivityError()
        if self.snapshot_ref is not None:
            try:
                hash_opaque_token(self.snapshot_ref)
            except ValueError:
                raise HomeActivityError() from None
        if self.cursor is not None and (not isinstance(self.cursor, str) or not _CURSOR.fullmatch(self.cursor)):
            raise HomeActivityError()
        if self.page is not None and (type(self.page) is not int or not 1 <= self.page <= 10**18):
            raise HomeActivityError()
        if (self.cursor is not None and (self.numbered or self.page is not None)
                or self.page is not None and not self.numbered
                or (self.cursor is not None or self.page is not None) and self.snapshot_ref is None):
            raise HomeActivityError()


@dataclass(frozen=True)
class ComparisonQuery(ActivityQuery):
    @property
    def numbered(self):
        return False

    def __post_init__(self):
        super().__post_init__()
        if self.kind == "listens":
            raise HomeActivityError()


def parse_activity_query(params, *, comparison=False) -> ActivityQuery:
    pairs = list(params.multi_items()) if hasattr(params, "multi_items") else list(params.items())
    allowed = {"kind", "period", "snapshot_ref", "cursor", "page", "page_size"}
    if len({key for key, _ in pairs}) != len(pairs) or any(key not in allowed for key, _ in pairs):
        raise HomeActivityError()
    values = dict(pairs)
    for key in ("page", "page_size"):
        if key in values:
            if not isinstance(values[key], str) or not re.fullmatch(r"[1-9][0-9]{0,17}", values[key]):
                raise HomeActivityError()
            values[key] = int(values[key])
    return (ComparisonQuery if comparison else ActivityQuery)(**values)


@dataclass(frozen=True)
class ActivityWindow:
    start: datetime | None
    end: datetime
    timezone: str
    period_label: str
    range_label: str


def _civil_instant(civil: datetime, zone) -> datetime:
    """Resolve ambiguous civil times earlier and nonexistent times forward."""
    candidates = []
    for fold in (0, 1):
        instant = civil.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc)
        wall = instant.astimezone(zone).replace(tzinfo=None)
        candidates.append((wall, instant))
    exact = [instant for wall, instant in candidates if wall == civil]
    if exact:
        return min(exact)
    later = [(wall, instant) for wall, instant in candidates if wall > civil]
    if later:
        return min(later)[1]
    raise HomeActivityError("The activity period could not be resolved.")


def resolve_activity_window(period, *, now, timezone_name=None) -> ActivityWindow:
    if not isinstance(period, str) or period not in PERIOD_LABELS or not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise HomeActivityError()
    end = now.astimezone(timezone.utc)
    zone = None
    if timezone_name:
        try:
            zone = ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError, TypeError):
            pass
    label = zone.key if zone is not None else "server-local"
    local = end.astimezone(zone).replace(tzinfo=None)
    start = None
    if period == "week":
        start = _civil_instant(local - timedelta(days=7), zone)
    elif period != "all":
        months = {"month": 1, "six": 6, "year": 12}[period]
        absolute = local.year * 12 + local.month - 1 - months
        year, month = divmod(absolute, 12)
        month += 1
        if year < 1:
            raise HomeActivityError()
        civil = local.replace(year=year, month=month, day=min(local.day, monthrange(year, month)[1]))
        start = _civil_instant(civil, zone)
    lower = start.astimezone(zone).strftime("%Y-%m-%d %H:%M") if start else "Available stored history"
    upper = end.astimezone(zone).strftime("%Y-%m-%d %H:%M")
    return ActivityWindow(start, end, label, PERIOD_LABELS[period], f"{lower} to {upper} ({label})")


def _display(value):
    if not isinstance(value, str):
        return ""
    value = " ".join(value.split()).strip()
    # Display fields must not become an alternate transport for private media.
    if value.casefold().startswith(("/", "\\", "file:", "http:", "https:")) or re.match(r"^[A-Za-z]:[/\\]", value):
        return ""
    return value[:500]


def _number(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        return None
    return float(value)


def _positive(value):
    return value if type(value) is int and value > 0 else None


@dataclass
class ActivityProjection:
    rows: list[dict]
    total_listens: int
    coverage: dict
    fingerprint: str
    # Internal read-receipt construction facts, never serialized to the client.
    events: list[dict] = field(default_factory=list, repr=False)
    groups: dict[str, dict] = field(default_factory=dict, repr=False)
    resources: set[tuple[str, int]] = field(default_factory=set, repr=False)


def build_activity_projection(raw_rows, *, scope, kind, window, allowed_actions_for_resource,
                              row_key_secret=None, source_account_id=None) -> ActivityProjection:
    if not isinstance(scope, ActivityScope) or kind not in KINDS or not isinstance(window, ActivityWindow):
        raise HomeActivityError()
    if not callable(allowed_actions_for_resource):
        raise HomeActivityError("Activity policy is unavailable.", 503, "activity_unavailable")
    owner = scope.source_account_id if source_account_id is None else source_account_id
    if (type(owner) is not int or owner != scope.source_account_id
            and not (scope.audience == "comparison" and owner == scope.account_id)):
        raise HomeActivityError()
    secret = row_key_secret if isinstance(row_key_secret, bytes) else secrets.token_bytes(32)
    raw = {row["id"]: row for row in raw_rows if isinstance(row, dict) and type(row.get("id")) is int}
    entries = normalize_listen_history_rows(
        list(raw.values()), account_id=owner, library_id=scope.library_id,
        window_start=window.start or datetime.min.replace(tzinfo=timezone.utc),
        window_end=window.end, end_inclusive=False,
    )
    decisions = {}
    def readable(resource_kind, resource_id):
        resource = (resource_kind, resource_id)
        if resource not in decisions:
            grant = allowed_actions_for_resource(*resource)
            if not isinstance(grant, AllowedActions):
                raise HomeActivityError("Activity policy is unavailable.", 503, "activity_unavailable")
            decisions[resource] = grant.allows(scope.read_action)
        return decisions[resource]

    groups, events, semantic = {}, [], []
    for entry in entries:
        source = raw[entry["row_id"]]
        if source.get("identity_conflict") is True or not readable("listen_history", entry["row_id"]):
            continue
        track_id = _positive(source.get("resolved_track_id"))
        album_id = _positive(source.get("resolved_album_id")) if track_id else None
        artist_id = _positive(source.get("resolved_track_artist_id")) if track_id else None
        album_artist_id = _positive(source.get("resolved_album_artist_id")) if album_id else None
        # A supplied measured identity may not be repaired through stale aliases.
        if entry["measurement_version"] is not None and (entry["track_id"] is None or track_id != entry["track_id"]):
            track_id = album_id = artist_id = album_artist_id = None
        resources = [("listen_history", entry["row_id"])]
        for resource_kind, resource_id in (("track", track_id), ("album", album_id), ("artist", artist_id), ("artist", album_artist_id)):
            if resource_id and (resource_kind, resource_id) not in resources:
                resources.append((resource_kind, resource_id))
        if not all(readable(*resource) for resource in resources):
            continue
        payload = source.get("metadata", {}).get("source_payload", {}) if isinstance(source.get("metadata"), dict) else {}
        payload = payload if isinstance(payload, dict) else {}
        title = _display(source.get("resolved_track_title")) if track_id else _display(payload.get("title"))
        artist = _display(source.get("resolved_track_artist_name")) if track_id else _display(payload.get("artist"))
        album = _display(source.get("resolved_album_title")) if album_id else _display(payload.get("album"))
        singular = {"tracks": "track", "albums": "album", "artists": "artist", "listens": "listen"}[kind]
        identity = {"tracks": track_id, "albums": album_id, "artists": artist_id or album_artist_id, "listens": None}[kind]
        key = f"{singular}:{identity}" if identity else f"{singular}:event:{entry['row_id']}"
        if kind == "albums":
            title, artist = album, (_display(source.get("resolved_album_artist_name")) if album_id else _display(payload.get("album_artist") or payload.get("artist")))
        elif kind == "artists":
            title = artist or (_display(source.get("resolved_album_artist_name")) if album_artist_id else "")
            artist = ""
        source_label = "Album Haven" if entry["measurement_version"] == "rendered-pcm-v1" else "Stored legacy history"
        row = {
            "id": "activity_" + hmac.new(secret, key.encode(), hashlib.sha256).hexdigest(),
            "kind": singular, "title": title, "artist": artist, "album_title": album,
            "listen_count": 1, "last_listened_at": entry["played_at"].isoformat(),
            "duration_seconds": _number(source.get("resolved_duration_seconds")) if kind in {"tracks", "listens"} and track_id else None,
            "source_label": source_label, "source_readable": True,
            "availability": "local" if (track_id if kind == "listens" else identity) and source.get("active_file") is True else "unresolved",
            "artwork_url": None, "rating": None, "detail_ref": None,
            "allowed_actions": {"can_view_details": False},
        }
        existing = groups.get(key)
        if existing:
            count = existing["row"]["listen_count"] + 1
            labels = existing["sources"] | {source_label}
            if (entry["played_at"], entry["row_id"]) > (existing["latest"], existing["latest_id"]):
                existing.update(row=row, latest=entry["played_at"], latest_id=entry["row_id"])
            existing["row"]["listen_count"] = count
            existing["sources"] = labels
            existing["row"]["source_label"] = " / ".join(sorted(labels))
        else:
            groups[key] = {"row": row, "latest": entry["played_at"], "latest_id": entry["row_id"], "sources": {source_label}}
        events.append({"event_id": entry["row_id"], "group_key": key, "resources": resources})
        semantic.append({key: entry.get(key) for key in ("row_id", "track_id", "track_key", "played_at", "measurement_version", "listened_seconds", "source_family")})
    rows = [value["row"] for key, value in sorted(groups.items(), key=lambda pair: (pair[1]["latest"], pair[1]["latest_id"], pair[0]), reverse=True)]
    accepted_ids = {event["event_id"] for event in events}
    times = [entry["played_at"] for entry in entries if entry["row_id"] in accepted_ids]
    coverage = {
        "requested_start": window.start.isoformat() if window.start else None,
        "requested_end": window.end.isoformat(), "timezone": window.timezone,
        "observed_start": min(times).isoformat() if times else None,
        "observed_end": max(times).isoformat() if times else None,
        "source_families": sorted({entry["source_family"] for entry in entries if entry["row_id"] in accepted_ids}),
        "complete_for_available_snapshot": True, "complete_for_requested_period": False,
        "label": "Available stored meaningful listens; complete historical coverage is not known.",
    }
    fingerprint = hashlib.sha256(json.dumps({"events": semantic, "policy": sorted((kind, ref, allowed) for (kind, ref), allowed in decisions.items()),
        "display": [{k: v for k, v in row.items() if k != "id"} for row in rows]}, sort_keys=True, default=str).encode()).hexdigest()
    return ActivityProjection(rows, len(events), coverage, fingerprint, events, groups, set(decisions))


def read_home_activity(config, *, actor, query, allowed_actions_for_resource, now=None, repository=None,
                       subject_account_id=None, comparison=False):
    if not actor.is_authenticated:
        raise HomeActivityError("Authentication required.", 401, "activity_denied")
    if type(comparison) is not bool or comparison and subject_account_id is None:
        raise HomeActivityError()
    scope = ActivityScope(actor.account_id, actor.session_id, actor.current_library_id,
        subject_account_id, "comparison" if comparison else "own" if subject_account_id is None else "friend")
    if not any(item.library_id == scope.library_id for item in actor.library_relationships):
        raise HomeActivityError("Action not permitted.", 403, "activity_denied")
    if not isinstance(query, ActivityQuery) or isinstance(query, ComparisonQuery) != comparison:
        raise HomeActivityError()
    reference = now if now is not None else datetime.now(timezone.utc)
    if repository is None:
        from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
        repository = HomeActivityPostgresRepository(config)
    def project(raw_rows, window, row_key_secret=None, source_account_id=None):
        return build_activity_projection(raw_rows, scope=scope, kind=query.kind, window=window,
            allowed_actions_for_resource=allowed_actions_for_resource, row_key_secret=row_key_secret,
            source_account_id=source_account_id)
    project.policy = allowed_actions_for_resource
    project.read_action = scope.read_action
    project.scope_wide_policy = getattr(allowed_actions_for_resource, "scope_wide", False) is True
    return repository.read(scope=scope, query=query, now=reference, build_projection=project)
