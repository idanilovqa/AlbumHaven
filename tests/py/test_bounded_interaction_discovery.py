from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
_SPEC = importlib.util.spec_from_file_location(
    "bounded_interaction_discovery",
    REPO_ROOT / "scripts" / "ci" / "bounded_interaction_discovery.py",
)
discovery = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = discovery
_SPEC.loader.exec_module(discovery)


def _write(root: Path, relative: str, source: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
    return path


def test_discovers_routes_schedulers_watchers_and_filesystem_reads(tmp_path: Path):
    source = _write(tmp_path, "music_app/routes/example.py", """
@router.get('/api/items')
async def items():
    return []

def watcher_callback(paths):
    for path in paths:
        path.stat()

def scheduled_refresh():
    while True:
        refresh_projection()
""")
    found = discovery.discover_python_entrypoints(tmp_path)
    assert [item["key"] for item in found] == [
        "py:music_app/routes/example.py#items:route:GET /api/items",
        "py:music_app/routes/example.py#scheduled_refresh:background:while",
        "py:music_app/routes/example.py#watcher_callback:watcher:name",
    ]
    assert discovery.find_python_hazards(source)[0]["operation"] == "Path.stat"


def test_route_reaching_registered_library_scale_operation_is_rejected_at_any_depth(tmp_path: Path):
    _write(tmp_path, "music_app/services/relations.py", """
def build_relation_views(albums):
    return {album: album for album in albums}
""")
    _write(tmp_path, "music_app/services/browse.py", """
from music_app.services import relations

def ensure_views(state):
    if not state.get("views"):
        state["views"] = relations.build_relation_views(state["albums"])
""")
    _write(tmp_path, "music_app/routes/read.py", """
from fastapi.concurrency import run_in_threadpool
from music_app.services.browse import ensure_views

@router.get("/home-data")
async def home_data(request):
    await run_in_threadpool(ensure_views, request.state)
""")
    analysis = discovery.analyze_python_repository(
        tmp_path,
        library_scale_operations=["py:music_app/services/relations.py#build_relation_views"],
    )
    [hazard] = [item for item in analysis["hazards"] if item["reject"]]
    assert hazard["rule"] == "BI-04"
    assert hazard["entrypoint"] == "py:music_app/routes/read.py#home_data:route:GET /home-data"
    assert hazard["via"] == ["ensure_views", "build_relation_views"]


def test_background_closures_are_not_followed_until_called(tmp_path: Path):
    _write(tmp_path, "music_app/services/relations.py", "def build_relation_views(albums):\n    return albums\n")
    _write(tmp_path, "music_app/routes/read.py", """
import threading
from music_app.services.relations import build_relation_views

@router.post("/refresh")
def refresh(state):
    def publish():
        build_relation_views(state)
    threading.Thread(target=publish).start()

@router.post("/refresh-now")
def refresh_now(state):
    def publish():
        build_relation_views(state)
    publish()
""")
    analysis = discovery.analyze_python_repository(
        tmp_path,
        library_scale_operations=["py:music_app/services/relations.py#build_relation_views"],
    )
    rejected = [item["entrypoint"] for item in analysis["hazards"] if item["reject"]]
    assert rejected == ["py:music_app/routes/read.py#refresh_now:route:POST /refresh-now"]


def test_direct_enumeration_in_route_is_rejected_while_helper_reads_are_inventoried(tmp_path: Path):
    _write(tmp_path, "music_app/services/covers.py", """
def first_image(folder):
    return next(folder.iterdir(), None)
""")
    _write(tmp_path, "music_app/routes/read.py", """
import os
from music_app.services.covers import first_image

@router.get("/walk")
def walk(root):
    return list(os.walk(root))

@router.get("/cover")
def cover(folder):
    return first_image(folder)
""")
    hazards = discovery.analyze_python_repository(tmp_path)["hazards"]
    summary = sorted((item["entrypoint"].split("#")[1], item["operation"], item["depth"], item["reject"]) for item in hazards)
    assert summary == [
        ("cover:route:GET /cover", "Path.iterdir", "indirect", False),
        ("walk:route:GET /walk", "os.walk", "direct", True),
    ]


def test_cli_emits_one_sorted_json_entry_per_line(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    _write(tmp_path, "music_app/routes/read.py", "@router.get('/b')\ndef b():\n    pass\n\n@router.get('/a')\ndef a():\n    pass\n")
    assert discovery.main(["--root", str(tmp_path)]) == 0
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [line["trigger"] for line in lines] == ["GET /a", "GET /b"]


def test_deferred_lambdas_are_not_followed_but_synchronous_ones_are(tmp_path: Path):
    _write(tmp_path, "music_app/services/relations.py", "def build_relation_views(albums):\n    return albums\n")
    _write(tmp_path, "music_app/routes/read.py", """
from fastapi.concurrency import run_in_threadpool
from music_app.services.relations import build_relation_views

@router.post("/queued")
def queued(state, executor):
    executor.submit(lambda: build_relation_views(state))

@router.get("/inline")
async def inline(state):
    return await run_in_threadpool(lambda: build_relation_views(state))
""")
    analysis = discovery.analyze_python_repository(
        tmp_path,
        library_scale_operations=["py:music_app/services/relations.py#build_relation_views"],
    )
    rejected = [item["entrypoint"] for item in analysis["hazards"] if item["reject"]]
    assert rejected == ["py:music_app/routes/read.py#inline:route:GET /inline"]


def test_single_file_probes_are_bounded_but_per_item_probes_are_reported(tmp_path: Path):
    _write(tmp_path, "music_app/services/files.py", """
def size(path):
    return path.stat().st_size
""")
    _write(tmp_path, "music_app/routes/read.py", """
from music_app.services.files import size

@router.get("/track")
def track(path):
    return size(path)

@router.get("/album")
def album(paths):
    return [size(path) for path in paths]
""")
    hazards = discovery.analyze_python_repository(tmp_path)["hazards"]
    assert [(item["entrypoint"].split("#")[1], item["operation"]) for item in hazards] == [
        ("album:route:GET /album", "Path.stat"),
    ]
