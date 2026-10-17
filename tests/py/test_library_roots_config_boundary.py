"""The explicit-root/scoped paths must not import the legacy config module."""
import ast
import json
from pathlib import Path
import subprocess
import sys

from library_mix_postgres_support import mix_db, mix_urls
from music_app.services import library_roots


def test_root_module_import_and_explicit_path_resolution_are_config_free(tmp_path):
    target = tmp_path / "audio.wav"
    target.write_bytes(b"test-owned media fixture")
    script = """
import sys
from pathlib import Path
from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.private_native_targets import PrivateNativeTargets
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
assert 'config' not in sys.modules
assert 'music_app.services.persistence_selection' not in sys.modules
assert 'music_app.services.track_preferences' not in sys.modules
root, target = (Path(value).resolve() for value in sys.argv[1:])
assert resolve_configured_media_path({}, str(target), configured_root_paths=(root,)) == target
assert resolve_configured_media_path({}, str(root.parent / 'outside.wav'), configured_root_paths=(root,)) is None
assert 'config' not in sys.modules
assert 'music_app.services.persistence_selection' not in sys.modules
"""
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path), str(target)],
                            text=True, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_legacy_backend_constant_remains_in_only_the_two_unscoped_branches():
    tree = ast.parse(Path(library_roots.__file__).read_text())
    assert not any(isinstance(node, ast.ImportFrom) and node.module == "config" for node in tree.body)
    owners = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    for name in ("load_library_root_settings", "save_library_root_settings"):
        function = owners[name]
        imports = [node for node in ast.walk(function) if isinstance(node, ast.ImportFrom) and node.module == "config"]
        assert len(imports) == 1
        assert [(item.name, item.asname) for item in imports[0].names] == [("PERSISTENCE_BACKEND_POSTGRES", None)]
        # The explicit-scope return precedes the legacy-only import.
        explicit_branch = next(node for node in function.body if isinstance(node, ast.If))
        assert any(isinstance(node, ast.Return) for node in ast.walk(explicit_branch))
        assert explicit_branch.end_lineno < imports[0].lineno


def test_scoped_root_read_and_save_use_real_postgres_without_legacy_selection(mix_db):
    db = mix_db
    payload = {"version": 1, "main_library_roots": [
        {"id": db.token, "path": str(db.root_path), "layout_mode": "artist"}],
        "hoarding_library_roots": [], "new_arrivals_roots": [], "move_policy": {}}
    # Ordinary pytest safety fixtures intentionally import config in the parent.
    # A fresh interpreter proves the boundary without deleting modules or fakes.
    # Its real scoped writes use the same committed, uniquely owned fixture rows.
    script = """
import json
import sys
from music_app.services import library_roots
assert 'config' not in sys.modules
assert 'music_app.services.persistence_selection' not in sys.modules
data = json.load(sys.stdin)
config, payload, library_id = data['config'], data['payload'], data['library_id']
written = library_roots.save_library_root_settings(config, payload,
    library_id=library_id, media_host_library_id=library_id)
assert written == payload
loaded = library_roots.load_library_root_settings(config,
    library_id=library_id, media_host_library_id=library_id)
assert loaded == payload
assert 'config' not in sys.modules
assert 'music_app.services.persistence_selection' not in sys.modules
"""
    result = subprocess.run([sys.executable, "-c", script],
        input=json.dumps({"config": db.config, "payload": payload, "library_id": db.library}),
        cwd=Path(__file__).resolve().parents[2], text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
