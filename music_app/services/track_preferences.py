from __future__ import annotations

from collections.abc import Iterable

from music_app.services.client_surfaces import resolve_client_surface_class
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.track_preferences_postgres import PostgresTrackPreferencesStore
from music_app.services.track_preferences_postgres import is_track_preferences_postgres_available
from music_app.services.track_stats import normalize_track_ref
from music_app.services.utils import safe_int
from config import PERSISTENCE_BACKEND_POSTGRES

_VALID_LOVE_TIERS = {"off", "loved", "obsessed"}
_FAVORITE_SONG_LOVE_TIERS = {"loved", "obsessed"}
_TRACK_PREFERENCES_STORE_VERSION = 1
_LOCAL_TRACK_PREFERENCES_ACTOR_ID = "local"


def default_track_preference_overlay(
    *,
    client_surface_class: object = None,
) -> dict[str, object]:
    resolved_client_surface_class = resolve_client_surface_class(client_surface_class)
    return {
        "rating": None,
        "love_tier": "off",
        "allowed_actions": {
            "client_surface_class": resolved_client_surface_class,
            "can_rate": False,
            "can_set_love_tier": False,
        },
    }


def _normalize_love_tier(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    if normalized in _VALID_LOVE_TIERS:
        return normalized
    return "off"


def _normalize_love_tier_for_write(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    if not normalized:
        return "off"
    if normalized in _VALID_LOVE_TIERS:
        return normalized
    raise ValueError("Track preference love_tier must be off, loved, or obsessed.")


def _normalize_rating_for_write(value: object) -> int | None:
    if value is None:
        return None
    normalized_rating = safe_int(value)
    if normalized_rating is None or not 1 <= normalized_rating <= 5:
        raise ValueError("Track preference rating must be null or an integer between 1 and 5.")
    return normalized_rating


def _normalize_stored_rating(value: object) -> int | None:
    normalized_rating = safe_int(value)
    if normalized_rating is None or not 1 <= normalized_rating <= 5:
        return None
    return normalized_rating


def _normalize_allowed_actions(
    value: object,
    *,
    client_surface_class: object = None,
) -> dict[str, object]:
    actions = value if isinstance(value, dict) else {}
    resolved_client_surface_class = resolve_client_surface_class(
        actions.get("client_surface_class"),
        default=resolve_client_surface_class(client_surface_class),
    )
    return {
        "client_surface_class": resolved_client_surface_class,
        "can_rate": bool(actions.get("can_rate")),
        "can_set_love_tier": bool(actions.get("can_set_love_tier")),
    }


def normalize_track_preference_overlay(
    overlay: object = None,
    *,
    client_surface_class: object = None,
) -> dict[str, object]:
    source = overlay if isinstance(overlay, dict) else {}
    return {
        "rating": safe_int(source.get("rating")),
        "love_tier": _normalize_love_tier(source.get("love_tier")),
        "allowed_actions": _normalize_allowed_actions(
            source.get("allowed_actions"),
            client_surface_class=client_surface_class,
        ),
    }


def track_preference_overlay_from_source(
    source: object,
    *,
    client_surface_class: object = None,
) -> dict[str, object]:
    if isinstance(source, dict):
        overlay = source.get("track_preference_overlay")
    else:
        overlay = getattr(source, "track_preference_overlay", None)
    return normalize_track_preference_overlay(
        overlay,
        client_surface_class=client_surface_class,
    )


def track_preference_can_edit(
    overlay: object,
    *,
    client_surface_class: object = None,
) -> bool:
    normalized_overlay = normalize_track_preference_overlay(
        overlay,
        client_surface_class=client_surface_class,
    )
    actions = normalized_overlay["allowed_actions"]
    return bool(actions["can_rate"] or actions["can_set_love_tier"])


def track_preference_matches_favorite_song_projection(
    overlay: object,
    *,
    love_tier: object = None,
    client_surface_class: object = None,
) -> bool:
    normalized_overlay = normalize_track_preference_overlay(
        overlay,
        client_surface_class=client_surface_class,
    )
    normalized_love_tier = normalized_overlay["love_tier"]
    if love_tier is None:
        return normalized_love_tier in _FAVORITE_SONG_LOVE_TIERS
    return normalized_love_tier == _normalize_love_tier(love_tier)


def strip_private_track_rows(
    track_rows: object,
    *,
    client_surface_class: object = None,
) -> list[dict[str, object]]:
    if not isinstance(track_rows, Iterable) or isinstance(track_rows, (str, bytes, dict)):
        return []

    sanitized_rows: list[dict[str, object]] = []
    for row in track_rows:
        if not isinstance(row, dict):
            continue
        sanitized_row = dict(row)
        sanitized_row["track_preference"] = default_track_preference_overlay(
            client_surface_class=client_surface_class,
        )
        sanitized_row["can_edit_preferences"] = False
        sanitized_rows.append(sanitized_row)
    return sanitized_rows


def load_track_preferences_store(config: dict[str, object]) -> dict[str, object]:
    _require_postgres_track_preferences_selection(config)
    return PostgresTrackPreferencesStore(config).load_store()


def save_track_preferences_store(config: dict[str, object], raw_payload: object) -> dict[str, object]:
    _require_postgres_track_preferences_selection(config)
    return PostgresTrackPreferencesStore(config).save_store(raw_payload)


def _require_postgres_track_preferences_selection(config: dict[str, object]) -> None:
    selection = select_runtime_persistence_adapter("track_preferences", config)
    if selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
        raise RuntimeError("Track preferences runtime persistence is Postgres-only.")


def normalize_track_preferences_store(raw_payload: object) -> dict[str, object]:
    payload = raw_payload if isinstance(raw_payload, dict) else {}
    actors_payload = payload.get("actors") if isinstance(payload.get("actors"), dict) else {}
    actors: dict[str, object] = {}

    for actor_id, actor_payload in actors_payload.items():
        normalized_actor_id = str(actor_id or "").strip()
        if not normalized_actor_id or not isinstance(actor_payload, dict):
            continue
        track_preferences_payload = actor_payload.get("track_preferences")
        if not isinstance(track_preferences_payload, dict):
            track_preferences_payload = {}
        actors[normalized_actor_id] = {
            "track_preferences": _normalize_actor_track_preferences(track_preferences_payload),
        }

    return {
        "version": _TRACK_PREFERENCES_STORE_VERSION,
        "actors": actors,
    }


def build_track_preference_overlay_lookup(
    config: dict[str, object],
    *,
    actor_id: str = _LOCAL_TRACK_PREFERENCES_ACTOR_ID,
    client_surface_class: object = None,
    track_refs: Iterable[object] | None = None,
) -> dict[str, dict[str, object]]:
    normalized_track_refs = [
        normalize_track_ref(track_ref)
        for track_ref in (track_refs or [])
        if normalize_track_ref(track_ref)
    ]
    track_preferences: dict[str, object]
    if (
        actor_id == _LOCAL_TRACK_PREFERENCES_ACTOR_ID
        and normalized_track_refs
        and is_track_preferences_postgres_available(config)
    ):
        track_preferences = PostgresTrackPreferencesStore(config).load_track_preferences(
            normalized_track_refs
        )
    else:
        store = load_track_preferences_store(config)
        actors = store.get("actors")
        actor_payload = actors.get(actor_id) if isinstance(actors, dict) else None
        track_preferences = (
            actor_payload.get("track_preferences")
            if isinstance(actor_payload, dict) and isinstance(actor_payload.get("track_preferences"), dict)
            else {}
        )
    return {
        track_ref: normalize_track_preference_overlay(
            {
                **overlay,
                "allowed_actions": {
                    "client_surface_class": client_surface_class,
                    "can_rate": True,
                    "can_set_love_tier": True,
                },
            },
            client_surface_class=client_surface_class,
        )
        for track_ref, overlay in track_preferences.items()
        if isinstance(overlay, dict)
    }


def save_track_preference(
    config: dict[str, object],
    track_ref: object,
    track_preference: object,
    *,
    actor_id: str = _LOCAL_TRACK_PREFERENCES_ACTOR_ID,
    client_surface_class: object = None,
) -> dict[str, object]:
    normalized_track_ref = normalize_track_ref(track_ref)
    if not normalized_track_ref:
        raise ValueError("Track preference payload must include a track_ref.")

    if not isinstance(track_preference, dict):
        raise ValueError("Track preference payload must include a track_preference object.")

    store = load_track_preferences_store(config)
    actors = store["actors"]
    if not isinstance(actors, dict):
        actors = {}
        store["actors"] = actors
    actor_payload = actors.get(actor_id)
    if not isinstance(actor_payload, dict):
        actor_payload = {"track_preferences": {}}
        actors[actor_id] = actor_payload
    actor_track_preferences = actor_payload.get("track_preferences")
    if not isinstance(actor_track_preferences, dict):
        actor_track_preferences = {}
        actor_payload["track_preferences"] = actor_track_preferences

    existing_overlay = normalize_track_preference_overlay(
        actor_track_preferences.get(normalized_track_ref),
        client_surface_class=client_surface_class,
    )
    normalized_rating = (
        _normalize_rating_for_write(track_preference.get("rating"))
        if "rating" in track_preference
        else existing_overlay["rating"]
    )
    normalized_love_tier = (
        _normalize_love_tier_for_write(track_preference.get("love_tier"))
        if "love_tier" in track_preference
        else existing_overlay["love_tier"]
    )
    normalized_overlay = normalize_track_preference_overlay(
        {
            "rating": normalized_rating,
            "love_tier": normalized_love_tier,
            "allowed_actions": {
                "client_surface_class": client_surface_class,
                "can_rate": True,
                "can_set_love_tier": True,
            },
        },
        client_surface_class=client_surface_class,
    )

    if normalized_overlay["rating"] is None and normalized_overlay["love_tier"] == "off":
        actor_track_preferences.pop(normalized_track_ref, None)
    else:
        actor_track_preferences[normalized_track_ref] = {
            "rating": normalized_overlay["rating"],
            "love_tier": normalized_overlay["love_tier"],
        }

    save_track_preferences_store(config, store)
    return {
        "actor_id": actor_id,
        "track_ref": normalized_track_ref,
        "track_preference": normalized_overlay,
    }


def _normalize_actor_track_preferences(track_preferences_payload: dict[str, object]) -> dict[str, object]:
    normalized_track_preferences: dict[str, object] = {}
    for track_ref, overlay in track_preferences_payload.items():
        normalized_track_ref = normalize_track_ref(track_ref)
        if not normalized_track_ref:
            continue
        normalized_overlay = normalize_track_preference_overlay(overlay)
        normalized_overlay["rating"] = _normalize_stored_rating(normalized_overlay["rating"])
        if normalized_overlay["rating"] is None and normalized_overlay["love_tier"] == "off":
            continue
        normalized_track_preferences[normalized_track_ref] = {
            "rating": normalized_overlay["rating"],
            "love_tier": normalized_overlay["love_tier"],
        }
    return normalized_track_preferences
