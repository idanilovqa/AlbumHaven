"""Shared navigation CSS must track the same runtime revision as the shell."""

import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from jinja2 import Environment, FileSystemLoader


@pytest.mark.parametrize("direct_context", [True, False])
def test_navigation_stylesheet_uses_current_runtime_revision_on_every_shell(direct_context):
    templates = Path(__file__).resolve().parents[2] / "music_app" / "templates"
    environment = Environment(loader=FileSystemLoader(templates))
    context = {"request": SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(runtime_asset_version="revision-123")))}
    if direct_context:
        context["runtime_asset_version"] = "revision-123"
    html = environment.get_template("partials/navigation-tree-assets.html").render(**context)
    assert 'href="/static/css/navigation-tree.css?v=revision-123"' in html


def test_navigation_script_only_change_invalidates_default_shell_asset_digest(tmp_path, monkeypatch):
    import os
    from music_app.routes import web_asgi

    package = tmp_path / 'music_app'
    static = package / 'static'
    for relative in ('app.js', 'js/runtime-bundle.js', 'js/audio-worklets/gapless-playback-processor.js'):
        asset = static / relative
        asset.parent.mkdir(parents=True, exist_ok=True)
        asset.write_text('unchanged asset', encoding='utf-8')
    navigation = static / 'js/navigation-tree.js'
    navigation.parent.mkdir(parents=True, exist_ok=True)
    navigation.write_text('const version = 1;', encoding='utf-8')
    monkeypatch.setattr(web_asgi, '__file__', str(package / 'routes/web_asgi.py'))
    first = web_asgi._runtime_asset_version()
    assert first != 'missing'
    original_stat = navigation.stat()
    navigation.write_text('const version = 2;', encoding='utf-8')
    os.utime(navigation, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    assert web_asgi._runtime_asset_version() != first


@pytest.mark.skipif(os.name != "nt", reason="Windows native asset cache")
def test_unchanged_default_digest_never_reopens_asset_contents(tmp_path, monkeypatch):
    from music_app.routes import web_asgi
    from music_app.services.runtime_asset_versions import runtime_asset_version_cache

    package = tmp_path / "music_app"
    static = package / "static"
    static.mkdir(parents=True)
    (static / "app.js").write_text("asset")
    monkeypatch.setattr(web_asgi, "__file__", str(package / "routes" / "web_asgi.py"))
    runtime_asset_version_cache.close()
    try:
        version = web_asgi._runtime_asset_version()
        assert version != "missing"

        def forbidden(*_args, **_kwargs):
            pytest.fail("unchanged HTML request reopened static asset content")

        monkeypatch.setattr(Path, "open", forbidden)
        for _ in range(20):
            assert web_asgi._runtime_asset_version() == version
    finally:
        runtime_asset_version_cache.close()
