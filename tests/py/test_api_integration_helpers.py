from __future__ import annotations

from pathlib import Path


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
