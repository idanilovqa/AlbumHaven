from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping

from music_app.services.client_surfaces import resolve_client_surface_class
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.track_preferences_postgres import PostgresTrackPreferencesStore
from music_app.services.track_preferences_postgres import TrackPreferenceScopeError
from music_app.services.current_actor import CurrentActor
from music_app.services.track_stats import normalize_track_ref
from music_app.services.utils import safe_int
from config import PERSISTENCE_BACKEND_POSTGRES

_VALID_LOVE_TIERS = {"off", "loved", "obsessed"}
_FAVORITE_SONG_LOVE_TIERS = {"loved", "obsessed"}
_TRACK_PREFERENCES_STORE_VERSION = 1


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
    if isinstance(value, str):
        normalized = value.strip().casefold()
        if normalized in _VALID_LOVE_TIERS:
            return normalized
    raise ValueError("Track preference love_tier must be off, loved, or obsessed.")


def _normalize_rating_for_write(value: object) -> int | None:
    if value is None:
        return None
    if type(value) is not int or not 1 <= value <= 5:
        raise ValueError("Track preference rating must be null or an integer between 1 and 5.")
    return value


def normalize_track_preference_patch(value: object) -> dict[str, object]:
    """Validate live values without turning omitted fields into explicit intent."""
    if not isinstance(value, dict):
        raise ValueError("Track preference payload must include a track_preference object.")
    patch = {}
    if "rating" in value:
        patch["rating"] = _normalize_rating_for_write(value["rating"])
    if "love_tier" in value:
        patch["love_tier"] = _normalize_love_tier_for_write(value["love_tier"])
    return patch


def track_preference_scope(actor: CurrentActor) -> tuple[int, int]:
    """Require explicit current membership, including for the bootstrap owner."""
    if (
        not isinstance(actor, CurrentActor) or not actor.is_authenticated
        or type(actor.account_id) is not int or actor.account_id <= 0
        or type(actor.current_library_id) is not int or actor.current_library_id <= 0
        or not any(
            relationship.library_id == actor.current_library_id
            for relationship in actor.library_relationships
        )
    ):
        raise TrackPreferenceScopeError("Track preference scope is unavailable.")
    return actor.account_id, actor.current_library_id


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
    account_id: int,
    library_id: int,
    track_refs: Iterable[object],
    client_surface_class: object = None,
    preference_action_resolver: Callable[[int], bool] | None = None,
    expected_track_ids: Mapping[str, object] | None = None,
    require_active_paths: bool = False,
) -> dict[str, dict[str, object]]:
    _require_postgres_track_preferences_selection(config)
    selections = PostgresTrackPreferencesStore(config).load_track_preferences(
        track_refs, account_id=account_id, library_id=library_id,
    )
    overlays = {}
    for track_ref, selected in selections.items():
        if require_active_paths and not selected["is_active_path"]:
            continue
        if expected_track_ids is not None and track_ref in expected_track_ids:
            expected = expected_track_ids[track_ref]
            if type(expected) is not int or expected != selected["track_id"]:
                continue
        editable = bool(
            preference_action_resolver is not None
            and preference_action_resolver(selected["track_id"])
        )
        overlays[track_ref] = normalize_track_preference_overlay(
            {
                "rating": selected["rating"], "love_tier": selected["love_tier"],
                "allowed_actions": {
                    "client_surface_class": client_surface_class,
                    "can_rate": editable, "can_set_love_tier": editable,
                },
            },
            client_surface_class=client_surface_class,
        )
    return overlays


def save_track_preference(
    config: dict[str, object],
    track_ref: object,
    track_preference: object,
    *,
    account_id: int,
    library_id: int,
    expected_track_id: int,
    client_surface_class: object = None,
) -> dict[str, object]:
    normalized_track_ref = normalize_track_ref(track_ref)
    if not normalized_track_ref:
        raise ValueError("Track preference payload must include a track_ref.")
    patch = normalize_track_preference_patch(track_preference)
    _require_postgres_track_preferences_selection(config)
    selected = PostgresTrackPreferencesStore(config).patch_preference(
        normalized_track_ref, patch, account_id=account_id,
        library_id=library_id, expected_track_id=expected_track_id,
    )
    return {
        "actor_id": str(account_id),
        "library_id": library_id,
        "track_ref": normalized_track_ref,
        "track_preference": normalize_track_preference_overlay(
            {
                "rating": selected["rating"], "love_tier": selected["love_tier"],
                "allowed_actions": {
                    "client_surface_class": client_surface_class,
                    "can_rate": True, "can_set_love_tier": True,
                },
            },
            client_surface_class=client_surface_class,
        ),
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
