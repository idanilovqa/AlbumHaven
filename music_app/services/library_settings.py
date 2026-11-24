from __future__ import annotations

from collections.abc import Callable
import logging

from music_app.services.library_roots import library_root_cache_identity, save_library_root_settings


JsonDict = dict[str, object]
StatusPayloadBuilder = Callable[[], JsonDict]
RefreshStarter = Callable[..., bool | None]
RootSettingsSaver = Callable[[dict[str, object], object], JsonDict]
RootIdentityLoader = Callable[[dict[str, object]], str]
RootChangeQueuer = Callable[[str], bool]
WatchRootsReplacer = Callable[[list[dict[str, object]]], object]

_WATCHED_ROOT_SETTING_KEYS = (
    "main_library_roots",
    "hoarding_library_roots",
    "new_arrivals_roots",
)


def save_library_settings_and_start_refresh(
    config: dict[str, object],
    raw_payload: object,
    *,
    library_state: dict[str, object],
    library_id=None, media_host_library_id=None,
    start_background_refresh: RefreshStarter,
    build_status_payload: StatusPayloadBuilder,
    save_root_settings: RootSettingsSaver = save_library_root_settings,
    replace_watch_roots: WatchRootsReplacer | None = None,
    load_root_identity: RootIdentityLoader = library_root_cache_identity,
    queue_root_change_scan: RootChangeQueuer | None = None,
) -> JsonDict:
    """A save always saves. During a scan it queues one more scan, and only when the roots changed."""
    scan_was_running = bool(library_state.get("scan_in_progress"))
    previous_identity = load_root_identity(config) if scan_was_running else None
    scope = {"library_id": library_id, "media_host_library_id": media_host_library_id} if library_id is not None or media_host_library_id is not None else {}
    normalized = save_root_settings(config, raw_payload, **scope)
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
    queued = False
    start = not scan_was_running
    if scan_was_running:
        identity = load_root_identity(config)
        if identity != previous_identity:
            queued = queue_root_change_scan is not None and queue_root_change_scan(identity)
            start = not queued  # the running scan ended during the save
    started = False
    if start:
        # Only for a scan of its own. Its covers: the lookup for the albums that scan adds (case 65).
        library_state["last_error"] = None
        started = start_background_refresh(force=True, scan_mode="library_settings_update") is not False
        if not started and queue_root_change_scan is not None:
            queued = queue_root_change_scan(load_root_identity(config))  # a scan began during the save
    return {
        "settings": normalized,
        "status": build_status_payload(),
        "refresh_started": started,
        "refresh_queued": queued,
        **({"watcher_warning": watcher_warning} if watcher_warning else {}),
    }
