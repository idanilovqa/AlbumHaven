"""Compatibility import surface for library filesystem watching."""

from __future__ import annotations

from music_app.services.library_watch import (
    LibraryEvent,
    LibraryEventKind,
    LibraryEventSource,
    LibraryWatchService,
    WatchdogLibraryEventSource,
    normalize_library_event,
    publish_watchdog_event,
    watchdog_event_kind,
)

__all__ = (
    "LibraryEvent",
    "LibraryEventKind",
    "LibraryEventSource",
    "LibraryWatchService",
    "WatchdogLibraryEventSource",
    "normalize_library_event",
    "publish_watchdog_event",
    "watchdog_event_kind",
)
