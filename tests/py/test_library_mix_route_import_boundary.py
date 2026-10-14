"""Normal-import and exact view-helper ownership checks; no view/DB execution."""
import ast
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
ROUTE = ROOT / "music_app/routes/owned_playlists_asgi.py"
VIEW_MODULE = "music_app.services.playlist_read_seams"


def test_owned_playlist_router_imports_normally_without_loading_config_or_view_graph():
    # A fresh interpreter avoids attributing unrelated conftest imports to this
    # boundary. No synthetic modules, packages, monkeypatches, or import loaders.
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(ROOT)
    completed = subprocess.run([sys.executable, "-c", "\n".join([
        "import sys",
        "from music_app.routes import owned_playlists_asgi as routes",
        "assert 'config' not in sys.modules",
        "assert 'music_app.services.playlist_read_seams' not in sys.modules",
        "assert callable(routes.playlist_view_response)",
        "expected = {",
        " ('POST', '/playlists/creation-source/library-mix'): routes.create_library_mix_source,",
        " ('GET', '/playlists/creation-source/library-mix'): routes.read_library_mix_source,",
        " ('POST', '/playlists/creation-source/library-mix/native-queue'): routes.library_mix_native_queue,",
        "}",
        "for (method, path), endpoint in expected.items():",
        " matches = [route for route in routes.router.routes if route.path == path and method in route.methods]",
        " assert len(matches) == 1 and matches[0].endpoint is endpoint",
    ])], cwd=ROOT, env=environment, capture_output=True, text=True, timeout=30)
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_view_graph_import_has_one_owner_before_the_unchanged_view_try():
    tree = ast.parse(ROUTE.read_text(encoding="utf-8"))
    view = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                and node.name == "playlist_view_response")
    imports = [node for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
               and node.module == VIEW_MODULE]
    assert len(imports) == 1
    imported = imports[0]
    assert imported in view.body
    assert [(alias.name, alias.asname) for alias in imported.names] == [("build_view_surface_payload", None)]
    assert imported.level == 0
    guarded = next(node for node in view.body if isinstance(node, ast.Try))
    assert view.body.index(imported) < view.body.index(guarded)
    assert not any(isinstance(node, ast.ImportFrom) and node.module == VIEW_MODULE
                   for node in tree.body)
    calls = [node for node in ast.walk(view) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Name) and node.func.id == "build_view_surface_payload"]
    assert len(calls) == 1
    assert len(calls[0].args) == 1 and isinstance(calls[0].args[0], ast.Constant)
    assert calls[0].args[0].value == "playlists"


def test_mix_endpoints_do_not_enter_the_view_helper():
    tree = ast.parse(ROUTE.read_text(encoding="utf-8"))
    for name in ("create_library_mix_source", "read_library_mix_source", "library_mix_native_queue"):
        endpoint = next(node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                        and node.name == name)
        assert not any(isinstance(node, ast.Name) and node.id in {
            "playlist_view_response", "build_view_surface_payload"} for node in ast.walk(endpoint))
