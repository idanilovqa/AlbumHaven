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


def test_a_local_alias_of_functions_is_followed_to_every_function_it_names(tmp_path: Path):
    """`respond = _legacy; if x: respond = _modern` hands either function to the
    executor; a local bound to a call result or a parameter is not an alias."""
    _write(tmp_path, "music_app/routes/covers.py", """
import asyncio

def _legacy(path):
    return path.stat()

def _modern(path):
    return path.stat()

def _built(path):
    return path

def make(path):
    return _built

@router.get("/cover")
async def cover(path, loop_id, run):
    respond = _legacy
    if loop_id:
        respond = _modern
    built = make(path)
    await asyncio.get_running_loop().run_in_executor(None, built, path)
    await asyncio.get_running_loop().run_in_executor(None, run, path)
    return await asyncio.get_running_loop().run_in_executor(None, respond, path)
""")
    keys = sorted(item["key"].split("#")[1] for item in discovery.discover_python_entrypoints(tmp_path))
    assert keys == [
        "_legacy:background:executor",
        "_modern:background:executor",
        "cover:route:GET /cover",
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


def test_os_path_probes_and_path_resolution_count_per_item(tmp_path: Path):
    _write(tmp_path, "music_app/routes/read.py", """
import os
from pathlib import Path

@router.get("/real")
def real(paths):
    return [os.path.realpath(path) for path in paths]

@router.get("/probed")
def probed(paths):
    return [path for path in paths if os.path.isfile(path) and os.path.getsize(path)]

def constructed(path):
    return Path(path).resolve()

def derived(root, path):
    return (Path(root) / path).parent.resolve()

def strict(path):
    return path.resolve(strict=False)

@router.get("/resolved")
def resolved(paths, root):
    return [(constructed(path), derived(root, path), strict(path)) for path in paths]
""")
    hazards = discovery.analyze_python_repository(tmp_path)["hazards"]
    assert sorted((item["entrypoint"].split("#")[1], item["operation"], item["function"]) for item in hazards) == [
        ("probed:route:GET /probed", "os.path.getsize", "probed"),
        ("probed:route:GET /probed", "os.path.isfile", "probed"),
        ("real:route:GET /real", "os.path.realpath", "real"),
        ("resolved:route:GET /resolved", "Path.resolve", "constructed"),
        ("resolved:route:GET /resolved", "Path.resolve", "derived"),
        ("resolved:route:GET /resolved", "Path.resolve", "strict"),
    ]


def test_resolve_on_a_receiver_that_is_not_evidently_a_path_is_not_filesystem_work(tmp_path: Path):
    _write(tmp_path, "music_app/routes/actors.py", """
import os

@router.get("/actors")
async def actors(request, tokens):
    resolver = request.app.state.current_actor_resolver
    names = [os.path.basename(token) for token in tokens]
    return [resolver.resolve(token) for token in tokens] + names
""")
    assert discovery.analyze_python_repository(tmp_path)["hazards"] == []


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


def _blocking_by_route(root: Path) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for hazard in _hazards(root, "BI-08"):
        route = hazard["entrypoint"].split("#")[1].split(":")[0]
        found.setdefault(route, []).append(hazard["operation"].split(":")[2].split("@")[0])
    return {route: sorted(operations) for route, operations in found.items()}


def test_event_loop_blocking_reports_filesystem_changes(tmp_path: Path):
    _write(tmp_path, "music_app/routes/files.py", """
import os as _os
import shutil
from pathlib import Path
from shutil import move

@router.post('/os')
async def os_changes(request):
    _os.remove("a")
    _os.makedirs("b", exist_ok=True)
    _os.replace("c", "d")

@router.post('/shutil')
async def shutil_changes(request):
    shutil.rmtree("a")
    shutil.copy2("b", "c")
    move("d", "e")

@router.post('/paths')
async def path_changes(request, name):
    Path(name).unlink()
    Path(name).parent.mkdir(parents=True)
    (Path(name) / "x").touch()
    Path(name).rename("y")
    target = Path(name)
    target.replace("z")

@router.post('/strings')
async def string_changes(request, name):
    label = name.replace("a", "b")
    return "".join(label).replace("c", "d")
""")
    assert _blocking_by_route(tmp_path) == {
        "os_changes": ["os.makedirs", "os.remove", "os.replace"],
        "path_changes": ["Path.mkdir", "Path.rename", "Path.replace", "Path.touch", "Path.unlink"],
        "shutil_changes": ["shutil.copy2", "shutil.move", "shutil.rmtree"],
    }


def test_event_loop_blocking_follows_constructors_aliases_dispatch_tables_and_factories(tmp_path: Path):
    _write(tmp_path, "music_app/services/store.py", """
import psycopg

class Loader:
    def __init__(self, path):
        self.text = open(path).read()

class Repo:
    def update(self, value):
        with psycopg.connect(value) as connection:
            connection.execute("select 1")

def make_repo(config):
    return Repo()

def make_rows(config):
    return {}
""")
    _write(tmp_path, "music_app/routes/dispatch.py", """
from music_app.services import store
from music_app.services.store import Loader, make_repo, make_rows

def blocking(config):
    return open(config).read()

_ALIAS = blocking
_HANDLERS = {"a": blocking}

@router.post('/constructed')
async def constructed(request):
    Loader("a")

@router.post('/module-constructed')
async def module_constructed(request):
    store.Loader("a")

@router.post('/alias')
async def alias(request):
    _ALIAS("a")

@router.post('/table')
async def table(request):
    _HANDLERS["a"]("a")

@router.post('/factory')
async def factory(request):
    repo = make_repo(request)
    repo.update("a")
    make_repo(request).update("b")

@router.post('/builtin')
async def builtin(request):
    rows = {}
    rows.update({"a": 1})
    make_rows(request).update({"b": 2})
""")
    assert _blocking_by_route(tmp_path) == {
        "alias": ["open"],
        "constructed": ["open"],
        "factory": ["psycopg.connect", "psycopg.connect"],
        "module_constructed": ["open"],
        "table": ["open"],
    }


def test_event_loop_blocking_reports_thread_waits_but_not_asyncio_waits(tmp_path: Path):
    _write(tmp_path, "music_app/routes/waits.py", """
import asyncio
import queue
import threading
from concurrent.futures import ThreadPoolExecutor
from time import sleep

_READY = threading.Event()
_POOL = ThreadPoolExecutor(max_workers=1)

class Drain:
    def __init__(self):
        self.jobs = queue.Queue()

    def next_job(self):
        return self.jobs.get()

    def next_job_now(self):
        return self.jobs.get(block=False)

def work():
    return 1

@router.post('/event')
async def event(request):
    _READY.wait(1)

@router.post('/thread')
async def thread(request):
    worker = threading.Thread(target=work)
    worker.start()
    worker.join()

@router.post('/future')
async def future(request):
    pending = _POOL.submit(work)
    return pending.result()

@router.post('/queue')
async def queued(request):
    return Drain().next_job()

@router.post('/sleep')
async def sleeping(request):
    sleep(1)

@router.post('/asyncio')
async def asyncio_waits(request):
    await asyncio.sleep(1)
    ready = asyncio.Event()
    await ready.wait()
    jobs = asyncio.Queue()
    await jobs.get()
    task = asyncio.ensure_future(asyncio.sleep(0))
    await task
    task.result()
    Drain().next_job_now()
    return {}.get("a")
""")
    assert _blocking_by_route(tmp_path) == {
        "event": ["Event.wait"],
        "future": ["Future.result"],
        "queued": ["Queue.get"],
        "sleeping": ["time.sleep"],
        "thread": ["Thread.join"],
    }


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


# The structural tag save finalizer that resolved every cached file's cover
# path (owner incident, sandbox2, 11-17), reduced to its call shape: the state
# getter arrives through a queueing helper's `**kwargs`, the refresh is a
# closure run through `_post_commit_value(..., lambda: guard(refresh), ...)`
# and an optional mutation guard, and the per-file probe sits in a sibling
# closure of the scan.
_FINALIZE_SHAPE = """
import os
from pathlib import Path

def _library_state(request):
    return request.app.state.library_state

def _post_commit_value(warnings, stage, callback, default):
    try:
        return callback()
    except Exception:
        return default

def _mark(*, file_cache, changed_paths):
    def resolved(cover):
        return os.path.normcase(str(Path(cover).resolve(strict=False)))

    def identity(entry):
        return resolved(entry["cover_path"])

    wanted = {identity(file_cache[path]) for path in changed_paths}
    return {path: entry for path, entry in SCANNED if identity(entry) in wanted}

def finalize(task_id, *, get_state, changed_paths, run_state_mutation=None):
    def refresh_runtime_state():
        st = get_state()
        st["marked"] = _mark(file_cache=st["file_cache"], changed_paths=changed_paths)

    guard = run_state_mutation or (lambda action: action())
    _post_commit_value([], "Runtime state refresh", lambda: guard(refresh_runtime_state), None)

def queue_finalize(*, wait_for_completion=False, **kwargs):
    if wait_for_completion:
        finalize(**kwargs)
        return
    EXECUTOR.submit(finalize, **kwargs)

def save(request, changed_paths):
    queue_finalize(wait_for_completion=True, get_state=lambda: _library_state(request), changed_paths=changed_paths)
"""


def _finalize_hazards(tmp_path: Path, scanned: str) -> list[tuple[str, str, str]]:
    _write(tmp_path, "music_app/services/save_tasks.py", _FINALIZE_SHAPE.replace("SCANNED", scanned))
    analysis = discovery.analyze_python_repository(tmp_path, library_state_collections=["albums", "file_cache"])
    return sorted(
        (hazard["operation"], hazard.get("witness", ""), hazard["function"])
        for hazard in analysis["hazards"]
        if hazard["entrypoint"].endswith("#finalize:background:executor") and hazard["rule"] in {"BI-04", "BI-06"}
    )


def test_a_save_finalizer_resolving_every_cached_file_is_a_library_state_scan_with_per_item_io(tmp_path: Path):
    hazards = _finalize_hazards(tmp_path, "file_cache.items()")
    assert (
        "library-state-scan-io:file_cache",
        "Path.resolve@music_app/services/save_tasks.py:16",
        "_mark",
    ) in hazards
    assert ("library-state-scan:file_cache", "", "_mark") in hazards


def test_a_save_finalizer_bounded_by_the_edited_albums_has_no_library_state_scan(tmp_path: Path):
    # The same closure chain over the affected candidates only: the per-item
    # probe remains (a contract counts it) but nothing scans the library state.
    hazards = _finalize_hazards(tmp_path, "((path, file_cache[path]) for path in changed_paths)")
    assert not [hazard for hazard in hazards if hazard[0].startswith("library-state-scan")]
    assert ("Path.resolve", "", "_mark.<locals>.resolved") in hazards


def test_a_collection_parameter_scans_only_where_the_call_passes_the_collection(tmp_path: Path):
    _write(tmp_path, "music_app/services/membership.py", """
def rejected(entries):
    return [entry for entry in entries if entry]

def library_wide(library_state):
    return rejected(library_state["file_cache"].values())

def from_rows(rows):
    return rejected([row for row in rows])

def refresh_rows(rows):
    return from_rows(rows)

def refresh_library(library_state):
    return library_wide(library_state)
""")
    analysis = discovery.analyze_python_repository(tmp_path, library_state_collections=["file_cache"])
    scans = sorted(
        (hazard["entrypoint"].split("#")[1], hazard["function"])
        for hazard in analysis["hazards"] if hazard["operation"].startswith("library-state-scan")
    )
    assert scans == [("refresh_library:refresh:name", "rejected")]


def test_a_receiver_built_by_a_third_party_call_is_not_an_app_method(tmp_path: Path):
    _write(tmp_path, "music_app/services/images.py", """
from PIL import Image

def decode(raw):
    img = Image.open(raw)
    img.load()
    return img

class Dismissals:
    def load(self):
        return self.path.stat()

def refresh_preview(raw):
    return decode(raw)

def refresh_dismissals(store):
    return store.load()
""")
    analysis = discovery.analyze_python_repository(tmp_path)
    reached = sorted(hazard["entrypoint"].split("#")[1] for hazard in analysis["hazards"])
    assert "refresh_preview:refresh:name" not in " ".join(reached)


def test_a_function_passed_by_name_is_followed_only_where_the_callee_calls_it(tmp_path: Path):
    """`expand(url, log_event=write_history)` runs `write_history` once per
    URL, because `expand` calls its `log_event`; a callee that only stores or
    hands the function to an executor does not run it."""
    _write(tmp_path, "music_app/services/history.py", """
import psycopg

def write_history(action):
    with psycopg.connect("postgresql://") as connection:
        connection.execute("insert into history values (%s)", (action,))

def log_only(action):
    return action
""")
    _write(tmp_path, "music_app/routes/links.py", """
from music_app.services.history import log_only, write_history

def expand(url, *, log_event):
    log_event(url)
    return [url]

def remember(url, *, log_event):
    HANDLERS.append(log_event)
    POOL.submit(log_event, url)
    return [url]

@router.post("/history-per-url")
def history_per_url(urls):
    return [expand(url, log_event=write_history) for url in urls]

@router.post("/log-per-url")
def log_per_url(urls):
    return [expand(url, log_event=log_only) for url in urls]

@router.post("/stored-per-url")
def stored_per_url(urls):
    return [remember(url, log_event=write_history) for url in urls]
""")
    [hazard] = _hazards(tmp_path, "BI-05")
    assert hazard["entrypoint"].endswith("#history_per_url:route:POST /history-per-url")
    assert hazard["reject"] is True
    # Attributed to the call that hands it over, where the loop is.
    assert hazard["via"] == ["write_history"]


def test_opening_an_in_memory_stream_is_not_filesystem_work(tmp_path: Path):
    _write(tmp_path, "music_app/routes/images.py", """
import io
from PIL import Image

@router.post("/decode")
def decode(blobs, paths):
    decoded = [Image.open(io.BytesIO(blob)) for blob in blobs]
    files = [Image.open(path) for path in paths]
    return decoded, files
""")
    probes = [hazard["line"] for hazard in _hazards(tmp_path, "BI-06")]
    assert probes == [8]


def _event_loop_operations(tmp_path: Path) -> dict[str, list[str]]:
    analysis = discovery.analyze_python_repository(tmp_path)
    found: dict[str, list[str]] = {}
    for hazard in analysis["hazards"]:
        if hazard["rule"] == "BI-08":
            route = hazard["entrypoint"].split("#")[1].split(":")[0]
            found.setdefault(route, []).append(hazard["operation"].split(":")[2].split("@")[0])
    return found


def test_sql_on_pooled_or_with_bound_connections_blocks_the_event_loop(tmp_path: Path):
    _write(tmp_path, "music_app/services/postgres_connections.py", """
import contextlib

@contextlib.contextmanager
def pooled_connection(url, *, workload):
    yield None
""")
    _write(tmp_path, "music_app/services/store.py", """
from music_app.services.postgres_connections import pooled_connection

class Store:
    def __init__(self, url, connect=pooled_connection):
        self._connect = connect
        self._url = url

    def named(self, path):
        with self._connect(self._url, workload="store") as connection:
            return connection.execute("select 1").fetchone()
""")
    _write(tmp_path, "music_app/services/other.py", """
class Shell:
    def execute(self, command):
        return command

class Script:
    def execute(self, command):
        return command
""")
    _write(tmp_path, "music_app/routes/read.py", """
from music_app.services.store import Store

@router.get("/store")
async def store_route(request):
    return Store("url").named("p")

@router.get("/pool")
async def pool_route(request):
    with request.app.state.pool.connection() as connection:
        connection.execute("select 1")

@router.get("/executed")
async def executed_route(request, connection):
    return CONNECTION.execute("select 1").fetchone()

@router.get("/shell")
async def shell_route(request, shell):
    return shell.execute("ls")
""")
    found = _event_loop_operations(tmp_path)
    # The witness is the first statement call, `execute` or the `fetchone` on its result.
    assert found["store_route"][0] in {"db.execute", "db.fetchone"}
    assert found["pool_route"] == ["db.execute"]
    assert found["executed_route"] == ["db.fetchone"]
    assert "shell_route" not in found


def test_a_callable_passed_through_helpers_is_followed_to_a_fixpoint(tmp_path: Path):
    _write(tmp_path, "music_app/routes/read.py", """
import time

def inner(action):
    return action()

def outer(action):
    return inner(action)

def outermost(action):
    return outer(action)

def keeps(action):
    return [action]

def block():
    time.sleep(1)

@router.get("/two")
async def two(request):
    outermost(block)

@router.get("/kept")
async def kept(request):
    keeps(block)

@router.get("/table")
async def table(request):
    handlers = {"go": block}
    handlers["go"]()
""")
    found = _event_loop_operations(tmp_path)
    assert found["two"] == ["time.sleep"]
    assert found["table"] == ["time.sleep"]
    assert "kept" not in found


def test_thread_locks_held_across_io_and_future_waits_block_the_event_loop(tmp_path: Path):
    _write(tmp_path, "music_app/services/retry.py", """
import threading
import urllib.request

RETRY_LOCK = threading.Lock()
BOOKKEEPING_LOCK = threading.Lock()

def send_pending(url):
    with RETRY_LOCK:
        return urllib.request.urlopen(url)

def note(state):
    with BOOKKEEPING_LOCK:
        state["seen"] = True
""")
    _write(tmp_path, "music_app/routes/read.py", """
import asyncio
import concurrent.futures
import threading
from concurrent.futures import as_completed
from music_app.services.retry import BOOKKEEPING_LOCK, RETRY_LOCK

LOCAL = threading.RLock()

def refresh(path):
    with LOCAL:
        return open(path).read()

@router.get("/imported-lock")
async def imported_lock(request):
    with RETRY_LOCK:
        return 1

@router.get("/acquire")
async def acquire(request):
    LOCAL.acquire()

@router.get("/try-acquire")
async def try_acquire(request):
    return LOCAL.acquire(blocking=False)

@router.get("/wait")
async def wait(request, futures):
    concurrent.futures.wait(futures)

@router.get("/completed")
async def completed(request, futures):
    return list(as_completed(futures))

@router.get("/bookkeeping")
async def bookkeeping(request):
    with BOOKKEEPING_LOCK:
        return 1

@router.get("/async-lock")
async def async_lock(request):
    async with asyncio.Lock():
        return 1
""")
    found = _event_loop_operations(tmp_path)
    assert found["imported_lock"] == ["Lock.acquire"]
    assert found["acquire"] == ["RLock.acquire"]
    assert found["wait"] == ["concurrent.futures.wait"]
    assert found["completed"] == ["concurrent.futures.as_completed"]
    # Only a lock some holder keeps across I/O can make the loop wait on it.
    assert "try_acquire" not in found and "async_lock" not in found and "bookkeeping" not in found


def test_work_submitted_through_a_copied_context_is_the_callable_it_runs(tmp_path: Path):
    _write(tmp_path, "music_app/services/jobs.py", """
import contextvars

def cover_job(job):
    return job

def start(pool, jobs):
    return [pool.submit(contextvars.copy_context().run, cover_job, job) for job in jobs]
""")
    keys = [item["key"].split("#")[1] for item in discovery.discover_python_entrypoints(tmp_path)]
    assert keys == ["cover_job:background:executor"]
