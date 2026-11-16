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


def test_work_queued_through_a_launcher_parameter_is_a_background_entrypoint(tmp_path: Path):
    _write(tmp_path, "music_app/services/relations.py", "def build_relation_views(albums):\n    return albums\n")
    _write(tmp_path, "music_app/services/queueing.py", """
import functools
import threading
from concurrent.futures import ThreadPoolExecutor
from music_app.services.relations import build_relation_views

_POOL = ThreadPoolExecutor(max_workers=1)

def _queue(config, key, action, *, trailing=False):
    return _POOL.submit(action)

def _queue_later(config, job):
    return _queue(config, "later", job)

class Runner:
    def start(self, work):
        threading.Thread(target=work, daemon=True).start()

def ensure_views(config):
    return build_relation_views(config["albums"])

def warm_cache(config):
    return None

def rebuild_now(config):
    return None

@router.post("/refresh")
def request_refresh(config):
    _queue(config, "refresh", lambda: ensure_views(config), trailing=True)
    _queue_later(config, functools.partial(warm_cache, config))
    Runner().start(work=rebuild_now)
""")
    analysis = discovery.analyze_python_repository(
        tmp_path,
        library_scale_operations=["py:music_app/services/relations.py#build_relation_views"],
    )
    keys = {item["key"] for item in analysis["entrypoints"]}
    assert {
        "py:music_app/services/queueing.py#ensure_views:background:executor",
        "py:music_app/services/queueing.py#warm_cache:background:executor",
        "py:music_app/services/queueing.py#rebuild_now:background:thread",
    } <= keys
    # The queued rebuild needs a contract; the route that only queues it does not reach it.
    library_scale = [(item["entrypoint"].split("#")[1], item["reject"]) for item in analysis["hazards"] if item["operation"].startswith("library-scale")]
    assert library_scale == [("ensure_views:background:executor", False)]


def test_route_scanning_a_registered_library_state_collection_needs_a_contract(tmp_path: Path):
    _write(tmp_path, "music_app/services/lookup.py", """
def album_index(library_state):
    return {album.key: album for album in library_state.get("albums", [])}

def selected(library_state, key):
    return library_state.get("albums_by_key", {}).get(key)
""")
    _write(tmp_path, "music_app/routes/read.py", """
from music_app.services.lookup import album_index, selected

@router.post("/versions/mark")
def mark(request):
    state = _library_state(request)
    albums = state.get("albums") or []
    by_key = {album.key: album for album in albums}
    return sorted(state["file_cache"].items())

@router.get("/indexed")
def indexed(request):
    return album_index(request.app.state.library_state)

@router.get("/one")
def one(request, payload):
    count = len(_library_state(request)["albums"])
    return selected(_library_state(request), payload["key"]), [row for row in payload["albums"]], count
""")
    analysis = discovery.analyze_python_repository(tmp_path, library_state_collections=["albums", "file_cache"])
    scans = sorted(
        (item["entrypoint"].split("#")[1], item["operation"], item["line"], item["depth"], item["reject"])
        for item in analysis["hazards"]
    )
    assert scans == [
        ("indexed:route:GET /indexed", "library-state-scan:albums", 3, "indirect", False),
        ("mark:route:POST /versions/mark", "library-state-scan:albums", 8, "direct", False),
        ("mark:route:POST /versions/mark", "library-state-scan:file_cache", 9, "direct", False),
    ]


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


def test_thread_and_executor_targets_are_background_entrypoints(tmp_path: Path):
    _write(tmp_path, "music_app/services/workers.py", """
import functools
import threading

def rebuild_everything():
    pass

def warm_cache(config):
    pass

def probe(path):
    pass

def delayed():
    pass

def watch_folders():
    pass

def awaited():
    pass

def start(pool, loop, config):
    threading.Thread(target=rebuild_everything, daemon=True).start()
    pool.submit(functools.partial(warm_cache, config))
    loop.run_in_executor(None, lambda: probe(config))
    threading.Timer(5, delayed).start()
    threading.Thread(target=watch_folders).start()
    return pool.submit(awaited).result()
""")
    keys = [item["key"].split("#")[1] for item in discovery.discover_python_entrypoints(tmp_path)]
    assert keys == [
        "delayed:background:thread",
        "probe:background:executor",
        "rebuild_everything:background:thread",
        "warm_cache:background:executor",
        "watch_folders:watcher:name",
    ]


def test_awaited_executor_work_is_followed_synchronously(tmp_path: Path):
    _write(tmp_path, "music_app/services/relations.py", "def build_relation_views(albums):\n    return albums\n")
    _write(tmp_path, "music_app/routes/read.py", """
import asyncio
from music_app.services.relations import build_relation_views

@router.get("/pooled")
def pooled(state, pool):
    return pool.submit(build_relation_views, state).result()

@router.get("/pooled-lambda")
def pooled_lambda(state, pool):
    return pool.submit(lambda: build_relation_views(state)).result()

@router.get("/executor")
async def executor(state):
    return await asyncio.get_running_loop().run_in_executor(None, build_relation_views, state)

@router.post("/queued")
def queued(state, pool):
    pool.submit(build_relation_views, state)
""")
    analysis = discovery.analyze_python_repository(
        tmp_path,
        library_scale_operations=["py:music_app/services/relations.py#build_relation_views"],
    )
    rejected = sorted(item["entrypoint"].split("#")[1] for item in analysis["hazards"] if item["reject"])
    assert rejected == [
        "executor:route:GET /executor",
        "pooled:route:GET /pooled",
        "pooled_lambda:route:GET /pooled-lambda",
    ]


def test_existence_and_open_probes_count_only_per_item(tmp_path: Path):
    _write(tmp_path, "music_app/routes/read.py", """
@router.get("/one")
def one(path):
    return path.exists() and path.is_dir() and path.is_file() and path.open()

@router.get("/many")
def many(paths):
    return [path for path in paths if path.exists() and path.is_dir() and path.is_file() and path.open()]
""")
    hazards = discovery.analyze_python_repository(tmp_path)["hazards"]
    assert sorted((item["entrypoint"].split("#")[1], item["operation"]) for item in hazards) == [
        ("many:route:GET /many", "Path.exists"),
        ("many:route:GET /many", "Path.is_dir"),
        ("many:route:GET /many", "Path.is_file"),
        ("many:route:GET /many", "Path.open"),
    ]


def test_a_method_name_defined_by_several_classes_follows_every_candidate(tmp_path: Path):
    _write(tmp_path, "music_app/services/indexes.py", """
import os

class FolderIndex:
    def collect(self, root):
        return list(os.walk(root))

    def get(self, root):
        return list(os.walk(root))

class MemoryIndex:
    def collect(self, root):
        return []

    def get(self, root):
        return []
""")
    _write(tmp_path, "music_app/routes/read.py", """
@router.get("/collect")
def collect(request, root):
    return request.app.state.index.collect(root)

@router.get("/lookup")
def lookup(request, root):
    return request.query_params.get(root)
""")
    hazards = discovery.analyze_python_repository(tmp_path)["hazards"]
    # `get` is also a dict method: an ambiguous builtin protocol name is not followed.
    assert [(item["entrypoint"].split("#")[1], item["operation"], item["via"]) for item in hazards] == [
        ("collect:route:GET /collect", "os.walk", ["FolderIndex.collect"]),
    ]


def test_every_call_chain_is_followed_to_its_end_whatever_its_depth(tmp_path: Path):
    # Traversal is exhaustive, so depth never hides work: a probe twenty calls
    # down is reported where it happens, and a long chain of helpers that does
    # no such work reports nothing.
    probe = "\n".join(f"def step{level}(paths):\n    step{level + 1}(paths)\n" for level in range(1, 20))
    quiet = "\n".join(f"def hop{level}():\n    hop{level + 1}()\n" for level in range(1, 20))
    _write(tmp_path, "music_app/routes/read.py", f"""
{probe}
def step20(paths):
    return [path.stat() for path in paths]

{quiet}
def hop20():
    return None

@router.get('/deep')
def deep(paths):
    step1(paths)

@router.get('/quiet')
def quiet():
    hop1()
""")
    hazards = discovery.analyze_python_repository(tmp_path)["hazards"]
    assert [(item["entrypoint"].split("#")[1], item["operation"], item["function"], len(item["via"])) for item in hazards] == [
        ("deep:route:GET /deep", "Path.stat", "step20", 20),
    ]


def test_a_cyclic_call_graph_terminates_and_reports_each_reachable_probe_once(tmp_path: Path):
    _write(tmp_path, "music_app/routes/read.py", """
def ping(paths):
    pong(paths)
    return [path.exists() for path in paths]

def pong(paths):
    ping(paths)

@router.get('/cycle')
def cycle(paths):
    ping(paths)
""")
    hazards = discovery.analyze_python_repository(tmp_path)["hazards"]
    assert [(item["operation"], item["function"]) for item in hazards] == [("Path.exists", "ping")]


def test_a_loop_iterable_runs_once_and_a_loop_over_constants_does_not_repeat_per_item(tmp_path: Path):
    _write(tmp_path, "music_app/routes/read.py", """
def tags(path):
    with path.open("rb") as handle:
        return {"size": handle.tell()}

def variant(base):
    for extension in (".png", ".webp", ".jpg"):
        if base.with_suffix(extension).exists():
            return extension
    return [attempt for attempt in range(2) if base.is_file()]

@router.get("/one")
def one(path):
    for key, value in tags(path).items():
        print(key, value)
    return [name for name in sorted(tags(path)) if name]

@router.get("/variant")
def variant_route(base):
    return variant(base)

@router.get("/each")
def each(paths, roots):
    for path in paths:
        tags(path)
    for extension in (".png", ".jpg"):
        for root in roots:
            variant(root)
    return [tags(path) for path in paths]
""")
    hazards = discovery.analyze_python_repository(tmp_path)["hazards"]
    assert sorted((item["entrypoint"].split("#")[1].split(":")[0], item["operation"], item["function"]) for item in hazards) == [
        ("each", "Path.exists", "variant"),
        ("each", "Path.is_file", "variant"),
        ("each", "Path.open", "tags"),
    ]


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


def _hazards(root: Path, rule: str, **kwargs) -> list[dict[str, object]]:
    analysis = discovery.analyze_python_repository(root, **kwargs)
    return [hazard for hazard in analysis["hazards"] if hazard["rule"] == rule]


def test_event_loop_blocking_follows_sync_helpers_to_a_database_connect(tmp_path: Path):
    _write(tmp_path, "music_app/services/store.py", """
import psycopg

def load_rows(url):
    return _open(url)

def _open(url):
    return psycopg.connect(url)
""")
    _write(tmp_path, "music_app/routes/home.py", """
from music_app.services.store import load_rows

def build_home(url):
    return {"rows": load_rows(url)}

@router.get('/home')
async def home(request):
    return build_home(request.app.state.url)
""")
    [hazard] = _hazards(tmp_path, "BI-08")
    assert hazard["reject"] is True
    assert hazard["operation"] == "event-loop-blocking:database:psycopg.connect@music_app/services/store.py:8"
    assert (hazard["path"], hazard["line"]) == ("music_app/routes/home.py", 9)
    assert hazard["via"] == ["build_home", "load_rows", "_open"]


def test_event_loop_blocking_ignores_offloaded_awaited_and_plain_def_work(tmp_path: Path):
    _write(tmp_path, "music_app/routes/clean.py", """
import asyncio
import time
from starlette.concurrency import run_in_threadpool

def slow():
    time.sleep(1)

def label(value):
    return str(value).strip()

async def fetch_json(request):
    return await request.json()

@router.get('/offloaded')
async def offloaded(request):
    await run_in_threadpool(slow)
    await asyncio.to_thread(lambda: slow())
    await asyncio.get_running_loop().run_in_executor(None, slow)
    await asyncio.sleep(0.1)
    return label(await fetch_json(request))

@router.get('/threadpool')
def threadpool_route(request):
    slow()
""")
    assert _hazards(tmp_path, "BI-08") == []


def test_event_loop_blocking_follows_awaited_coroutines_and_callable_arguments(tmp_path: Path):
    _write(tmp_path, "music_app/routes/chain.py", """
from pathlib import Path

def read_keys(config):
    return Path(config["path"]).read_text()

def revert(config, *, load_keys):
    return load_keys(config)

async def resolve(config):
    return revert(config, load_keys=read_keys)

@app.middleware('http')
async def boundary(request, call_next):
    await resolve(request.app.state.config)
    return await call_next(request)
""")
    [hazard] = _hazards(tmp_path, "BI-08")
    assert hazard["entrypoint"] == "py:music_app/routes/chain.py#boundary:middleware:MIDDLEWARE http"
    assert hazard["function"] == "resolve"
    assert hazard["operation"].startswith("event-loop-blocking:filesystem:Path.read_text@")
    assert hazard["via"] == ["resolve", "read_keys"]


def test_event_loop_blocking_follows_container_named_methods_on_app_class_receivers(tmp_path: Path):
    _write(tmp_path, "music_app/services/history.py", """
import psycopg

class Store:
    def __init__(self, config):
        self.url = config["url"]

    def _connect(self):
        return psycopg.connect(self.url)

class HistoryAdapter(Store):
    def append(self, entry):
        with self._connect() as connection:
            return connection.execute("select 1 for update").fetchall()

    def get(self, key):
        return None

def append_history(config, entry):
    return HistoryAdapter(config).append(entry)

def typed_append(adapter: HistoryAdapter, entry):
    return adapter.append(entry)

def bound_append(config, entry):
    adapter = HistoryAdapter(config)
    return adapter.append(entry)

def builtin_append(rows, entry):
    rows.append(entry)
    return {}.get(entry)
""")
    _write(tmp_path, "music_app/routes/history.py", """
from music_app.services.history import append_history, bound_append, builtin_append, typed_append

@router.post('/constructed')
async def constructed(request):
    return append_history(request.app.state.config, {})

@router.post('/typed')
async def typed(request):
    return typed_append(request.app.state.adapter, {})

@router.post('/bound')
async def bound(request):
    return bound_append(request.app.state.config, {})

@router.post('/builtin')
async def builtin(request):
    return builtin_append([], {})
""")
    hazards = {hazard["entrypoint"].split("#")[1]: hazard for hazard in _hazards(tmp_path, "BI-08")}
    assert sorted(hazards) == ["bound:route:POST /bound", "constructed:route:POST /constructed", "typed:route:POST /typed"]
    assert hazards["constructed:route:POST /constructed"]["via"] == ["append_history", "HistoryAdapter.append"]
    assert all(hazard["operation"].startswith("event-loop-blocking:database:") for hazard in hazards.values())


def test_connection_per_loop_item_is_rejected_in_a_route_and_reported_at_the_loop(tmp_path: Path):
    _write(tmp_path, "music_app/services/roots.py", """
import psycopg

def load_settings(config):
    with psycopg.connect(config["url"]) as connection:
        return connection.execute("select 1").fetchall()

def resolve_path(config, raw_path):
    return (load_settings(config), raw_path)

def resolve_once(config, raw_paths):
    settings = load_settings(config)
    return [(settings, raw_path) for raw_path in raw_paths]

def first_match(config, raw_paths):
    for raw_path in raw_paths:
        if raw_path:
            return resolve_path(config, raw_path)
    return None
""")
    _write(tmp_path, "music_app/routes/tracks.py", """
from music_app.services.roots import first_match, resolve_once, resolve_path

@router.post('/tracks')
def tracks(request, paths):
    resolved = [resolve_path(request.app.state.config, path) for path in paths]
    return resolved, resolve_once(request.app.state.config, paths), first_match(request.app.state.config, paths)
""")
    [hazard] = _hazards(tmp_path, "BI-05")
    assert hazard["reject"] is True
    assert (hazard["path"], hazard["line"], hazard["function"]) == ("music_app/routes/tracks.py", 6, "tracks")
    assert hazard["operation"] == "database-connect-per-item:psycopg.connect@music_app/services/roots.py:5"


def test_library_state_receivers_are_found_through_getters_and_call_sites(tmp_path: Path):
    _write(tmp_path, "music_app/routes/repair.py", """
def _library_state(request):
    return request.app.state.library_state

def rebuild(*, get_state):
    st = get_state()
    return [album for album in st["albums"]]

def reindex(updated_file_cache):
    return list(updated_file_cache.values())

def unrelated(st):
    return [album for album in st["albums"]]

@router.post('/repair')
def repair(request):
    rebuild(get_state=lambda: _library_state(request))
    reindex(_library_state(request)["file_cache"])
    unrelated({"albums": []})
""")
    scans = _hazards(tmp_path, "BI-04", library_state_collections=["albums", "file_cache"])
    assert sorted((hazard["function"], hazard["operation"]) for hazard in scans) == [
        ("rebuild", "library-state-scan:albums"),
        ("reindex", "library-state-scan:file_cache"),
    ]
