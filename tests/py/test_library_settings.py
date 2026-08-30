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

    result = save_library_settings_and_start_refresh(
        {"MUSIC_DIR": "C:\\Music"},
        {"settings": True},
        library_state=library_state,
        start_background_refresh=lambda **kwargs: refresh_calls.append(kwargs),
        build_status_payload=lambda: {"scan_in_progress": True},
        save_root_settings=lambda config, payload: seen.append((config, payload)) or {"normalized": True},
    )

    assert seen == [({"MUSIC_DIR": "C:\\Music"}, {"settings": True})]
    assert library_state["last_error"] is None
    assert library_state["pending_cover_refresh_after_scan"] is True
    assert library_state["pending_cover_refresh_force_search"] is False
    assert refresh_calls == [{"force": True, "scan_mode": "library_settings_update"}]
    assert result == {
        "settings": {"normalized": True},
        "status": {"scan_in_progress": True},
        "refresh_started": True,
    }


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
