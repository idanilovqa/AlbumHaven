from __future__ import annotations

from collections.abc import Callable
import logging

from music_app.services.library_roots import save_library_root_settings


JsonDict = dict[str, object]
StatusPayloadBuilder = Callable[[], JsonDict]
RefreshStarter = Callable[..., None]
RootSettingsSaver = Callable[[dict[str, object], object], JsonDict]
WatchRootsReplacer = Callable[[list[dict[str, object]]], object]

_WATCHED_ROOT_SETTING_KEYS = (
    "main_library_roots",
    "hoarding_library_roots",
    "new_arrivals_roots",
)


class LibrarySettingsWorkflowError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def save_library_settings_and_start_refresh(
    config: dict[str, object],
    raw_payload: object,
    *,
    library_state: dict[str, object],
    start_background_refresh: RefreshStarter,
    build_status_payload: StatusPayloadBuilder,
    save_root_settings: RootSettingsSaver = save_library_root_settings,
    replace_watch_roots: WatchRootsReplacer | None = None,
) -> JsonDict:
    if library_state.get("scan_in_progress"):
        raise LibrarySettingsWorkflowError(
            "Wait for the current library scan to finish before saving library settings.",
            status_code=409,
        )

    normalized = save_root_settings(config, raw_payload)
    watched_roots = [
        {**root, "category": category}
        for category in _WATCHED_ROOT_SETTING_KEYS
        for root in list(normalized.get(category) or [])
        if isinstance(root, dict)
    ]
    watcher_warning = None
    if replace_watch_roots is not None:
        try:
            replace_watch_roots(watched_roots)
        except Exception as exc:
            # Settings already committed. Continue their inventory refresh; the
            # runtime replacement boundary records health for affected roots.
            logging.getLogger(__name__).warning("Unable to attach updated library watchers (%s).", type(exc).__name__)
            watcher_warning = "Automatic library updates are unavailable. Run Full Rescan after library changes."
    library_state["last_error"] = None
    library_state["pending_cover_refresh_after_scan"] = True
    library_state["pending_cover_refresh_force_search"] = False
    start_background_refresh(force=True, scan_mode="library_settings_update")
    return {
        "settings": normalized,
        "status": build_status_payload(),
        "refresh_started": True,
        **({"watcher_warning": watcher_warning} if watcher_warning else {}),
    }
