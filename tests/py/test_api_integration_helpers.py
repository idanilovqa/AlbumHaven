from __future__ import annotations

from pathlib import Path


FOOBAR_REFERENCE_ASSET_KEYS = (
    "how-to-modal-copy",
    "text-tools-standard-preset",
    "text-tools-enhanced-preset",
    "foobar-internal-setup-summary-2026-05-28",
    "backup-foobar-db-script",
    "export-text-tools-stats-script",
    "register-foobar-db-task-script",
)


def test_integration_helpers_own_foobar_assets_without_flask_imports():
    from music_app.routes import api_integration_helpers

    helper_source = Path(api_integration_helpers.__file__).read_text(encoding="utf-8")
    asset_url = api_integration_helpers.build_foobar_asset_url("how-to-modal-copy", download=False)
    download_url = api_integration_helpers.build_foobar_asset_url("how-to-modal-copy", download=True)
    asset_definition, asset_path = api_integration_helpers.resolve_foobar_asset("how-to-modal-copy")

    assert "from flask" not in helper_source
    assert "current_app" not in helper_source
    assert "request" not in helper_source
    assert asset_url == "/utilities/integrations/foobar/assets/how-to-modal-copy"
    assert download_url == "/utilities/integrations/foobar/assets/how-to-modal-copy?download=1"
    assert asset_definition["asset_key"] == "how-to-modal-copy"
    assert asset_definition["filename"] == "how-to-modal-copy.md"
    assert asset_definition["mime_type"] in {"text/markdown", "text/plain"}
    assert asset_path.name == "how-to-modal-copy.md"
    assert isinstance(asset_path, Path)


def test_public_foobar_assets_are_complete_and_free_of_private_machine_identity():
    from music_app.routes import api_integration_helpers

    resolved_paths = [
        api_integration_helpers.resolve_foobar_asset(asset_key)[1]
        for asset_key in FOOBAR_REFERENCE_ASSET_KEYS
    ]

    assert len(resolved_paths) == 7
    assert len({path.name for path in resolved_paths}) == 7
    assert all(path.is_file() for path in resolved_paths)
    combined_text = "\n".join(path.read_text(encoding="utf-8") for path in resolved_paths)
    assert "# Foobar2000 Setup Help" in combined_text
    for forbidden in (
        "C:\\Users\\",
        "C:\\Distrib\\",
        "N:\\Music",
        "Rendref",
        "/C:/Repositories/MusicApp",
    ):
        assert forbidden not in combined_text


def test_public_foobar_task_helper_does_not_replace_tasks_or_bypass_policy_by_default():
    from music_app.routes import api_integration_helpers

    _definition, helper_path = api_integration_helpers.resolve_foobar_asset(
        "register-foobar-db-task-script"
    )
    helper_source = helper_path.read_text(encoding="utf-8")

    assert "[switch]$ReplaceExisting" in helper_source
    assert "if ($existingTask -and -not $ReplaceExisting)" in helper_source
    assert "if ($ReplaceExisting) { $registerArguments.Force = $true }" in helper_source
    assert "ExecutionPolicy" not in helper_source
