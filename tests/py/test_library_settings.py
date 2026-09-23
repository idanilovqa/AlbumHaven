from __future__ import annotations

import pytest

from music_app.services.library_settings import (
    LibrarySettingsWorkflowError,
    save_library_settings_and_start_refresh,
)


def test_save_library_settings_workflow_uses_injected_root_settings_writer():
    seen = []
    library_state: dict[str, object] = {}
    refresh_calls = []
    watcher_root_calls = []

    result = save_library_settings_and_start_refresh(
        {"MUSIC_DIR": "C:\\Music"},
        {"settings": True},
        library_state=library_state,
        start_background_refresh=lambda **kwargs: refresh_calls.append(kwargs),
        build_status_payload=lambda: {"scan_in_progress": True},
        save_root_settings=lambda config, payload: seen.append((config, payload)) or {"normalized": True},
        replace_watch_roots=lambda roots: watcher_root_calls.append(roots),
    )

    assert seen == [({"MUSIC_DIR": "C:\\Music"}, {"settings": True})]
    assert library_state["last_error"] is None
    assert library_state["pending_cover_refresh_after_scan"] is True
    assert library_state["pending_cover_refresh_force_search"] is False
    assert refresh_calls == [{"force": True, "scan_mode": "library_settings_update"}]
    assert watcher_root_calls == [[]]
    assert result == {
        "settings": {"normalized": True},
        "status": {"scan_in_progress": True},
        "refresh_started": True,
    }


def test_save_library_settings_replaces_live_watcher_roots_before_refresh():
    sequence = []
    normalized = {
        "main_library_roots": [{"id": "main", "path": "C:\\Music"}],
        "hoarding_library_roots": [{"id": "hoard", "path": "D:\\Hoard"}],
        "new_arrivals_roots": [{"id": "new", "path": "E:\\Incoming"}],
    }

    save_library_settings_and_start_refresh(
        {},
        normalized,
        library_state={},
        start_background_refresh=lambda **kwargs: sequence.append(("refresh", kwargs)),
        build_status_payload=lambda: {},
        save_root_settings=lambda _config, _payload: normalized,
        replace_watch_roots=lambda roots: sequence.append(("watch", roots)),
    )

    assert sequence == [
        (
            "watch",
            [
                {"id": "main", "path": "C:\\Music", "category": "main_library_roots"},
                {"id": "hoard", "path": "D:\\Hoard", "category": "hoarding_library_roots"},
                {"id": "new", "path": "E:\\Incoming", "category": "new_arrivals_roots"},
            ],
        ),
        ("refresh", {"force": True, "scan_mode": "library_settings_update"}),
    ]


def test_saved_settings_still_refresh_when_watcher_attachment_fails(caplog):
    sequence = []
    state = {}
    normalized = {"main_library_roots": [{"id": "new", "path": "C:/Music"}]}

    def replace(_roots):
        sequence.append("attach")
        raise OSError("private native watch path")

    result = save_library_settings_and_start_refresh(
        {}, normalized, library_state=state,
        save_root_settings=lambda *_args: sequence.append("persist") or normalized,
        replace_watch_roots=replace,
        start_background_refresh=lambda **_kwargs: sequence.append("refresh"),
        build_status_payload=lambda: {"scan_in_progress": True},
    )
    assert sequence == ["persist", "attach", "refresh"]
    assert result["settings"] == normalized
    assert result["refresh_started"] is True
    assert result["watcher_warning"] == "Automatic library updates are unavailable. Run Full Rescan after library changes."
    assert "private native" not in str(result)
    assert "private native" not in caplog.text
    assert "OSError" in caplog.text


def test_save_library_settings_workflow_rejects_running_scan_before_write():
    seen = []

    with pytest.raises(LibrarySettingsWorkflowError) as excinfo:
        save_library_settings_and_start_refresh(
            {},
            {"settings": True},
            library_state={"scan_in_progress": True},
            start_background_refresh=lambda **kwargs: None,
            build_status_payload=lambda: {},
            save_root_settings=lambda config, payload: seen.append((config, payload)) or {},
        )

    assert excinfo.value.status_code == 409
    assert "finish before saving" in str(excinfo.value)
    assert seen == []
