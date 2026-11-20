"""Static inventory of backend interaction entrypoints and reachable hazards.

Discovery proves coverage, not boundedness. Entrypoints are routes, background
owners found by name, and every thread or executor target. Direct filesystem
enumeration in an interactive entrypoint is rejected outright; filesystem/media
work reached through helpers is reported so the registry can demand a runtime
contract; any interactive path that reaches a registered library-scale
operation is rejected at any depth; an `async def` route, websocket or
middleware whose event-loop call chain reaches blocking I/O is rejected
(BI-08); a database connection opened per loop item is rejected in an
interactive path and needs a contract elsewhere (BI-05); and filesystem, media
or database work done per item of a loop over the whole library state
(`library-state-scan-io`, BI-04) is reported at the loop, which the validator
rejects in any background entry narrower than background-batch.

Calls are followed through local function aliases, sibling closures, lambdas
and functions a callee runs through its parameter, and a local guard
lambda (`run_guard or (lambda action: action())`). Library-state evidence
reaches closures and `**kwargs` forwarding, and a collection parameter counts
only where the followed call passes a collection for it.

The traversal retains finite semantic edges for each reachable state. A
converging caller does not erase a connection witness; recursion terminates
without enumerating exponentially many complete paths or imposing a depth cap.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import logging
import sys
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

SCAN_ROOT = "music_app"
ENTRYPOINT_ROOTS = ("music_app/routes", "music_app/services")
# The app factory installs middleware and routes as closures.
DECORATED_ENTRYPOINT_ROOTS = (*ENTRYPOINT_ROOTS, "music_app/__init__.py")
ROUTE_METHODS = {"get", "post", "put", "patch", "delete"}
BACKGROUND_TERMS = (
    ("watch", "watcher"),
    ("poll", "poller"),
    ("schedule", "scheduler"),
    ("reconcil", "reconciler"),
    ("refresh", "refresh"),
    ("publish", "publisher"),
)
ENUMERATION_CALLS = {
    ("os", "walk"): "os.walk",
    ("os", "scandir"): "os.scandir",
    ("os", "listdir"): "os.listdir",
    ("glob", "glob"): "glob.glob",
    ("glob", "iglob"): "glob.iglob",
}
ENUMERATION_METHODS = {"rglob": "Path.rglob", "glob": "Path.glob", "iterdir": "Path.iterdir"}
PROBE_METHODS = {
    "stat": "Path.stat",
    "lstat": "Path.stat",
    "read_bytes": "Path.read_bytes",
    "read_text": "Path.read_text",
    "exists": "Path.exists",
    "is_dir": "Path.is_dir",
    "is_file": "Path.is_file",
    "open": "Path.open",
}
# `os.path` functions that ask the filesystem (`realpath` follows links).
OS_PATH_PROBES = frozenset({
    "exists", "lexists", "isfile", "isdir", "islink", "getmtime", "getctime", "getatime", "getsize",
    "realpath", "samefile",
})
# `resolve` is a common app method name, so it counts as `Path.resolve` only
# on a receiver that is evidently a path: a path constructor or a path-valued
# expression, or with the path-only `strict` keyword.
PATH_CONSTRUCTORS = frozenset({"Path", "PurePath", "PosixPath", "WindowsPath"})
PATH_VALUED_METHODS = frozenset({"joinpath", "with_name", "with_suffix", "with_stem", "expanduser", "absolute"})
MEDIA_CALLS = {"MutagenFile": "mutagen.File"}
# Blocking families on the ASGI event loop (BI-08), by import-qualified name.
DATABASE_CONNECTS = frozenset({
    "psycopg.connect", "psycopg.Connection.connect", "psycopg2.connect", "psycopg_pool.ConnectionPool",
})
BLOCKING_CALLS = {
    **{name: "database" for name in DATABASE_CONNECTS},
    **{f"subprocess.{name}": "subprocess" for name in ("run", "Popen", "call", "check_call", "check_output")},
    "time.sleep": "sleep",
    "urllib.request.urlopen": "http",
    **{f"{client}.{verb}": "http" for client in ("requests", "httpx") for verb in ("get", "post", "put", "patch", "delete", "head", "request", "stream")},
    "httpx.Client": "http",
    "PIL.Image.open": "image",
    # Waiting for executor futures blocks until another thread finishes.
    "concurrent.futures.wait": "wait",
    "concurrent.futures.as_completed": "wait",
}
# DB-API calls on a connection, cursor or pool. They count where there is
# evidence the receiver is one: the module imports a database driver or the
# app's pooled-connection module, the receiver was bound by
# `with <connection factory>(...) as name`, or the call reads the result of an
# `execute` (`connection.execute(...).fetchone()`).
DATABASE_METHODS = frozenset({"execute", "executemany", "fetchone", "fetchall", "fetchmany", "getconn", "connection"})
DATABASE_DRIVERS = ("psycopg", "psycopg2", "psycopg_pool")
POOLED_CONNECTION_MODULE = "music_app.services.postgres_connections"
# Methods that open, lease or wrap a connection: `with store._connect(url) as
# connection`, `with pool.connection() as connection`, `with connection.cursor() as cursor`.
CONNECTION_FACTORY_METHODS = frozenset({"connection", "_connect", "_connect_to_database", "getconn", "cursor"})
FETCH_METHODS = frozenset({"fetchone", "fetchall", "fetchmany"})
# Filesystem changes, by import-qualified name and as `pathlib` methods.
FILESYSTEM_MUTATORS = frozenset({
    *(f"os.{name}" for name in ("remove", "unlink", "rename", "renames", "replace", "makedirs", "mkdir", "rmdir", "removedirs")),
    *(f"shutil.{name}" for name in ("copy", "copy2", "copyfile", "copytree", "copymode", "copystat", "move", "rmtree")),
})
FILESYSTEM_WRITE_METHODS = {
    name: f"Path.{name}" for name in ("write_text", "write_bytes", "unlink", "mkdir", "touch", "rmdir")
}
# `rename` and `replace` are string methods too: they count only on a receiver evidently a path.
PATH_ONLY_WRITE_METHODS = {"rename": "Path.rename", "replace": "Path.replace"}
# Waits that block the calling thread, by the import-qualified constructor of
# their receiver: `asyncio` primitives of the same names are awaited instead.
# A receiver built by `executor.submit(...)` or
# `asyncio.run_coroutine_threadsafe(...)` is a `concurrent.futures.Future`.
FUTURE = "concurrent.futures.Future"
BLOCKING_WAITS = {
    "threading.Event": {"wait"},
    "threading.Condition": {"wait", "wait_for", "acquire"},
    # A thread lock waits for whichever thread holds it, which may be doing
    # network or database work (`with _RETRY_LOCK:` around Last.fm calls).
    **{f"threading.{kind}": {"acquire"} for kind in ("Lock", "RLock", "Semaphore", "BoundedSemaphore")},
    "threading.Barrier": {"wait"},
    "threading.Thread": {"join"},
    "threading.Timer": {"join"},
    **{f"queue.{kind}": {"get", "join"} for kind in ("Queue", "LifoQueue", "PriorityQueue", "SimpleQueue")},
    FUTURE: {"result", "exception"},
}
WAIT_METHODS = frozenset(name for names in BLOCKING_WAITS.values() for name in names)
# Calls whose callable runs on another thread: the event loop is free while it
# runs. `executor.submit(fn).result()` waits for it and is not a hand-off.
OFFLOADING_CALLS = frozenset({"run_in_threadpool", "to_thread", "run_sync", "run_in_executor", "submit"})
# Dispatchers whose callable runs before the caller continues: the callable is
# the first argument, or the second for `loop.run_in_executor(executor, fn)`.
SYNCHRONOUS_DISPATCH = {"run_in_threadpool": 0, "to_thread": 0, "run_in_executor": 1}
# Method names of builtin containers, strings, paths, files, loggers, DB-API
# connections and cursors, threads, futures, and locks. Such a call on a
# receiver of unknown type is far more likely a library call than one of
# several app classes, so it is followed only when one app class defines it.
PROTOCOL_METHODS = frozenset({
    *(name for kind in (dict, list, set, str, bytes, Path, logging.Logger) for name in dir(kind) if not name.startswith("_")),
    "acquire", "cancel", "close", "commit", "cursor", "done", "execute", "executemany", "fetchall", "fetchmany",
    "fetchone", "flush", "is_set", "open", "put", "read", "readline", "release", "result", "rollback", "run",
    "send", "start", "submit", "wait", "write",
})
# Builtin container and string methods: on a receiver of unknown type such a
# call (`rows.append(row)`) is the builtin, so it is followed only when the
# receiver resolves to an app class: a constructor call (`Adapter(config).append`),
# a class, or a local or parameter typed by one (`x = Adapter(config)`,
# `x: Adapter`).
CONTAINER_METHODS = frozenset(name for kind in (dict, list, set, str, bytes) for name in dir(kind) if not name.startswith("_"))


@dataclass
class Definition:
    path: str
    qualname: str
    node: ast.AST
    module: str
    class_name: str = ""

    @property
    def key(self) -> str:
        return f"py:{self.path}#{self.qualname}"


@dataclass
class Module:
    path: str
    name: str
    functions: dict[str, Definition] = field(default_factory=dict)
    methods: dict[str, dict[str, Definition]] = field(default_factory=dict)
    imports: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    # `self.<attribute> = <function> or <function>` bindings, per class: the
    # names a method call through that attribute may run.
    bound_callables: dict[str, dict[str, list[str]]] = field(default_factory=dict)
    # Every value assigned to `self.<attribute>`, per class.
    attribute_values: dict[str, dict[str, list[ast.AST]]] = field(default_factory=dict)
    class_bases: dict[str, list[str]] = field(default_factory=dict)
    # Every value assigned to a module-level name: aliases (`_ALIAS = run`),
    # dispatch tables (`_HANDLERS = {"a": run}`), and shared instances.
    assignments: dict[str, list[ast.AST]] = field(default_factory=dict)
    # The annotation of each module-level name declared with one
    # (`_WAKE: threading.Event | None = None`).
    annotations: dict[str, ast.AST] = field(default_factory=dict)
    tree: ast.Module | None = None


def _relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _module_name(relative: str) -> str:
    return relative[: -len(".py")].replace("/", ".").removesuffix(".__init__")


def _iter_python_files(root: Path, base: str):
    directory = root / base
    if not directory.exists():
        return
    for path in sorted(directory.rglob("*.py")):
        relative = _relative(path, root)
        if "/tests/" in f"/{relative}" or "__pycache__" in relative:
            continue
        yield path, relative


def _iter_statements(statements: list[ast.stmt]):
    stack = list(statements)
    while stack:
        node = stack.pop()
        yield node
        for field_name in ("body", "orelse", "finalbody", "handlers"):
            stack.extend(getattr(node, field_name, ()) or ())


def _load_module(path: Path, relative: str, overrides: dict[str, str]) -> Module:
    source = overrides.get(relative)
    if source is None:
        source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=relative)
    module = Module(path=relative, name=_module_name(relative), tree=tree)
    package = module.name.rsplit(".", 1)[0] if "." in module.name else module.name
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            module.functions[node.name] = Definition(relative, node.name, node, module.name)
        elif isinstance(node, ast.ClassDef):
            methods = module.methods.setdefault(node.name, {})
            module.class_bases[node.name] = [base.attr if isinstance(base, ast.Attribute) else getattr(base, "id", "") for base in node.bases]
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    methods[item.name] = Definition(relative, f"{node.name}.{item.name}", item, module.name, node.name)
                    for statement in ast.walk(item):
                        if isinstance(statement, ast.Assign):
                            for target in statement.targets:
                                if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "self":
                                    names = [value.id for value in ast.walk(statement.value) if isinstance(value, ast.Name)]
                                    module.bound_callables.setdefault(node.name, {}).setdefault(target.attr, []).extend(names)
                                    module.attribute_values.setdefault(node.name, {}).setdefault(target.attr, []).append(statement.value)
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
            for target in _binding_targets(node):
                if isinstance(target, ast.Name):
                    module.assignments.setdefault(target.id, []).append(node.value)
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            module.annotations[node.target.id] = node.annotation
    # Function-local imports are merged into module scope: resolution only needs
    # to know which module a name came from, and local imports never shadow it.
    for node in _iter_statements(tree.body):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    module.imports[alias.asname] = (alias.name, None)
                else:
                    head = alias.name.split(".")[0]
                    module.imports.setdefault(head, (head, None))
        elif isinstance(node, ast.ImportFrom):
            source_module = node.module or ""
            if node.level:
                parts = package.split(".")[: len(package.split(".")) - node.level + 1]
                source_module = ".".join([*parts, source_module] if source_module else parts)
            for alias in node.names:
                module.imports[alias.asname or alias.name] = (source_module, alias.name)
    return module


def _binding_targets(node: ast.AST) -> list[ast.AST]:
    """The targets a statement or comprehension binds names to."""
    if isinstance(node, ast.Assign):
        return node.targets
    if isinstance(node, (ast.AnnAssign, ast.AugAssign, ast.For, ast.AsyncFor, ast.NamedExpr, ast.comprehension)):
        return [node.target]
    if isinstance(node, (ast.With, ast.AsyncWith)):
        return [item.optional_vars for item in node.items if item.optional_vars is not None]
    return []


def _shared_callback(owner: Definition, target: ast.AST) -> bool:
    return (owner.key == "py:music_app/services/scan_cache_persistence.py#_SharedConnection.transaction"
            and isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name)
            and target.value.id == "self" and target.attr == "_connect")


_SHARED_CONSTRUCTOR_BODY = """self.database_url = database_url
self._connect = connect
self._lock = threading.Lock()
self._connection: Any = None"""
_ADAPTER_CONSTRUCTOR_BODY = '''self._config = config
self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
self._connect = connect or _connect
self._build_albums = build_albums'''
_SHARED_FACTORY_BODY = '''database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip() if isinstance(config, dict) else ""
if not database_url or _SHARED_CONNECTION.get() is not None:
    yield
    return
shared = _SharedConnection(database_url, PostgresScanCacheAdapter(config)._connect_to_database)
token = _SHARED_CONNECTION.set(shared)
try:
    yield
finally:
    _SHARED_CONNECTION.reset(token)
    shared.close()'''


def _body_matches(node: ast.AST, source: str) -> bool:
    body = node.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    return ast.dump(ast.Module(body=body, type_ignores=[]), include_attributes=False) == ast.dump(ast.parse(source), include_attributes=False)


class Index:
    def __init__(self, modules: list[Module]):
        self.modules = {module.name: module for module in modules}
        self._local_types: dict[tuple[int, str], tuple[str, str] | None] = {}
        self.methods_by_name: dict[str, list[Definition]] = {}
        self._shared_binding: dict[str, object] | None = None
        for module in modules:
            for methods in module.methods.values():
                for name, definition in methods.items():
                    if not name.startswith("__"):
                        self.methods_by_name.setdefault(name, []).append(definition)

    def shared_connection_binding(self) -> dict[str, object]:
        """The one sealed callback contract, not a general instance model."""
        if self._shared_binding is None:
            target = self._sealed_shared_connection_target()
            self._shared_binding = {"status": "resolved" if target else "rejected", "target": target,
                                    "reason": "unique-unmodified-factory" if target else "unproven-shared-connector"}
        return self._shared_binding

    def _known_adapter_connector_read(self, module: Module, owner_name: str, call: ast.Call) -> bool:
        # This existing getter reads a separately constructed adapter; it never
        # receives the shared instance. Unknown reads remain conservative.
        if module.path != "music_app/services/cache.py" or owner_name != "_persist_cache_updates" or call.keywords or ast.dump(call, include_attributes=False) != ast.dump(ast.parse('getattr(adapter, "_connect", None)', mode="eval").body, include_attributes=False):
            return False
        owner = module.functions.get(owner_name)
        wrapper = module.functions.get("_select_runtime_scan_cache_adapter")
        scan = self.modules.get("music_app.services.scan_cache_persistence")
        selector = scan.functions.get("select_scan_cache_adapter") if scan else None
        if not owner or not wrapper or not selector or owner.node.decorator_list or wrapper.node.decorator_list or selector.node.decorator_list:
            return False
        if "select_scan_cache_adapter" in scan.assignments or "select_scan_cache_adapter" in scan.imports or sum(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "select_scan_cache_adapter" for node in ast.walk(scan.tree)) != 1:
            return False
        if not _body_matches(wrapper.node, "from music_app.services.scan_cache_persistence import select_scan_cache_adapter\nreturn select_scan_cache_adapter(config)"):
            return False
        if [arg.arg for arg in wrapper.node.args.args] != ["config"] or wrapper.node.args.defaults or wrapper.node.args.kwonlyargs or wrapper.node.args.vararg or wrapper.node.args.kwarg:
            return False
        if any(name in module.assignments or name in module.imports for name in ("getattr", "_select_runtime_scan_cache_adapter")) or "getattr" in module.functions:
            return False
        if sum(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == "_select_runtime_scan_cache_adapter" for node in ast.walk(module.tree)) != 1:
            return False
        stores = [node for node in ast.walk(owner.node) if isinstance(node, ast.Name) and node.id == "adapter" and isinstance(node.ctx, (ast.Store, ast.Del))]
        parents = {id(child): parent for parent in ast.walk(owner.node) for child in ast.iter_child_nodes(parent)}
        if len(stores) != 1:
            return False
        assignment = parents[id(stores[0])]
        if not isinstance(assignment, ast.Assign) or assignment.targets != stores or ast.dump(assignment.value, include_attributes=False) != ast.dump(ast.parse("_select_runtime_scan_cache_adapter(config)", mode="eval").body, include_attributes=False):
            return False
        if any(isinstance(node, ast.Name) and node.id == "getattr" and isinstance(node.ctx, (ast.Store, ast.Del)) or isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "getattr" for node in ast.walk(owner.node)):
            return False
        if any(arg.arg == "getattr" for arg in [*owner.node.args.args, *owner.node.args.posonlyargs, *owner.node.args.kwonlyargs]):
            return False
        if [arg.arg for arg in selector.node.args.args] != ["config"] or selector.node.args.posonlyargs or selector.node.args.defaults or selector.node.args.kwonlyargs or selector.node.args.vararg or selector.node.args.kwarg:
            return False
        returns = [node for node in _own_nodes(selector) if isinstance(node, ast.Return)]
        return len(returns) == 1 and returns[0].value is not None and ast.dump(returns[0].value, include_attributes=False) == ast.dump(ast.parse("PostgresScanCacheAdapter(config)", mode="eval").body, include_attributes=False)

    def _sealed_shared_connection_target(self) -> Definition | None:
        module = self.modules.get("music_app.services.scan_cache_persistence")
        if module is None or module.tree is None:
            return None
        classes = [node for node in ast.walk(module.tree) if isinstance(node, ast.ClassDef) and node.name == "_SharedConnection"]
        factories = [node for node in module.tree.body if isinstance(node, ast.FunctionDef) and node.name == "shared_scan_cache_connection"]
        if len(classes) != 1 or classes[0] not in module.tree.body or len(factories) != 1 or classes[0].bases or classes[0].keywords or classes[0].decorator_list:
            return None
        shared, factory = classes[0], factories[0]
        adapters = [node for node in ast.walk(module.tree) if isinstance(node, ast.ClassDef) and node.name == "PostgresScanCacheAdapter"]
        if len(adapters) != 1 or adapters[0] not in module.tree.body or adapters[0].bases or adapters[0].keywords or adapters[0].decorator_list:
            return None
        adapter = adapters[0]
        for node in shared.body:
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                continue
            if not isinstance(node, ast.FunctionDef) or node.name not in {"__init__", "transaction", "_discard", "close"}:
                return None
            expected_decorators = [ast.Name(id="contextmanager", ctx=ast.Load())] if node.name == "transaction" else []
            if [ast.dump(value, include_attributes=False) for value in node.decorator_list] != [ast.dump(value, include_attributes=False) for value in expected_decorators]:
                return None
        if len([node for node in shared.body if isinstance(node, ast.FunctionDef)]) != 4:
            return None
        for node in adapter.body:
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                continue
            if ast.dump(node, include_attributes=False) == ast.dump(ast.parse("backend = PERSISTENCE_BACKEND_POSTGRES").body[0], include_attributes=False):
                continue
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name.startswith("__") and node.name != "__init__" or node.name in {"_connect", "_database_url", "_config", "_build_albums"}:
                    return None
                if node.name in {"__init__", "_connect_to_database"} and (not isinstance(node, ast.FunctionDef) or node.decorator_list):
                    return None
            else:
                return None
        adapter_initializers = [node for node in adapter.body if isinstance(node, ast.FunctionDef) and node.name == "__init__"]
        adapter_connectors = [node for node in adapter.body if isinstance(node, ast.FunctionDef) and node.name == "_connect_to_database"]
        if len(adapter_initializers) != 1 or len(adapter_connectors) != 1:
            return None
        adapter_init = adapter_initializers[0]
        adapter_args = adapter_init.args
        if [arg.arg for arg in adapter_args.args] != ["self", "config"] or adapter_args.posonlyargs or adapter_args.defaults or adapter_args.vararg or adapter_args.kwarg or [arg.arg for arg in adapter_args.kwonlyargs] != ["connect", "build_albums"] or ast.dump(ast.List(elts=adapter_args.kw_defaults, ctx=ast.Load()), include_attributes=False) != ast.dump(ast.parse("[None, build_albums_from_file_cache]", mode="eval").body, include_attributes=False) or not _body_matches(adapter_init, _ADAPTER_CONSTRUCTOR_BODY):
            return None
        adapter_assignment = next(node.targets[0] for node in adapter_init.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Attribute) and node.targets[0].attr == "_connect")
        if [ast.dump(node, include_attributes=False) for node in factory.decorator_list] != [ast.dump(ast.Name(id="contextmanager", ctx=ast.Load()), include_attributes=False)] or module.imports.get("contextmanager") != ("contextlib", "contextmanager") or "contextmanager" in module.assignments:
            return None
        if [arg.arg for arg in factory.args.args] != ["config"] or factory.args.posonlyargs or factory.args.kwonlyargs or factory.args.defaults or factory.args.vararg or factory.args.kwarg or not _body_matches(factory, _SHARED_FACTORY_BODY):
            return None
        for node in ast.walk(module.tree):
            if isinstance(node, ast.Name) and node.id == "PostgresScanCacheAdapter" and isinstance(node.ctx, (ast.Store, ast.Del)) or isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in {"PostgresScanCacheAdapter", "_SharedConnection"}:
                return None
            if isinstance(node, (ast.Import, ast.ImportFrom)) and any((alias.asname or alias.name.split('.')[0]) in {"PostgresScanCacheAdapter", "_SharedConnection", "contextmanager"} and not (isinstance(node, ast.ImportFrom) and node.module == "contextlib" and alias.name == "contextmanager" and alias.asname is None) for alias in node.names):
                return None
        constructors = [node for node in shared.body if isinstance(node, ast.FunctionDef) and node.name == "__init__"]
        if len(constructors) != 1:
            return None
        constructor = constructors[0]
        args = constructor.args
        if constructor.decorator_list or [arg.arg for arg in args.args] != ["self", "database_url", "connect"] or args.posonlyargs or args.kwonlyargs or args.defaults or args.vararg or args.kwarg or not _body_matches(constructor, _SHARED_CONSTRUCTOR_BODY):
            return None
        threading_imports = [node for node in ast.walk(module.tree) if isinstance(node, (ast.Import, ast.ImportFrom)) and
                             any((alias.asname or alias.name.split('.')[0]) == "threading" for alias in node.names)]
        if len(threading_imports) != 1 or threading_imports[0] not in module.tree.body or ast.dump(threading_imports[0], include_attributes=False) != ast.dump(ast.parse("import threading").body[0], include_attributes=False):
            return None
        lock_module = next(node for node in ast.walk(constructor) if isinstance(node, ast.Name) and node.id == "threading")
        if any(isinstance(node, ast.Name) and node.id == "threading" and node is not lock_module or isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == "threading" for node in ast.walk(module.tree)):
            return None
        assignments = [node for node in ast.walk(constructor) if isinstance(node, ast.Assign) and
                       len(node.targets) == 1 and ast.dump(node.targets[0], include_attributes=False) ==
                       "Attribute(value=Name(id='self', ctx=Load()), attr='_connect', ctx=Store())"]
        if len(assignments) != 1 or not isinstance(assignments[0].value, ast.Name) or assignments[0].value.id != "connect":
            return None
        assignment = assignments[0].targets[0]
        construction = [node for node in ast.walk(factory) if isinstance(node, ast.Call) and
                        isinstance(node.func, ast.Name) and node.func.id == "_SharedConnection"]
        expected = ast.parse("_SharedConnection(database_url, PostgresScanCacheAdapter(config)._connect_to_database)", mode="eval").body
        if len(construction) != 1 or ast.dump(construction[0], include_attributes=False) != ast.dump(expected, include_attributes=False):
            return None
        parent_map = {id(child): parent for parent in ast.walk(module.tree) for child in ast.iter_child_nodes(parent)}
        if not isinstance(parent_map[id(construction[0])], ast.Assign) or len(parent_map[id(construction[0])].targets) != 1 or not isinstance(parent_map[id(construction[0])].targets[0], ast.Name) or parent_map[id(construction[0])].targets[0].id != "shared":
            return None
        annotation = next((node for node in module.tree.body if isinstance(node, ast.AnnAssign) and
                           isinstance(node.target, ast.Name) and node.target.id == "_SHARED_CONNECTION"), None)
        annotation_nodes = {id(node) for node in ast.walk(annotation.annotation)} if annotation else set()
        shared_nodes = {id(node) for node in ast.walk(shared)}
        known_context_owners = {"persist_cover_selection_in_shared_transaction", "scan_cache_transaction", "shared_scan_cache_connection"}
        for candidate in self.modules.values():
            if candidate.tree is None:
                return None
            parents = {id(child): parent for parent in ast.walk(candidate.tree) for child in ast.iter_child_nodes(parent)}
            owners = {}

            def visit(node, owner=None, class_name=None, function=None, cls=None):
                if isinstance(node, ast.ClassDef):
                    class_name = node.name
                    cls = node
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    owner = node.name
                    function = node
                owners[id(node)] = (owner, class_name, function, cls)
                for child in ast.iter_child_nodes(node):
                    visit(child, owner, class_name, function, cls)

            visit(candidate.tree)
            module_aliases = {name for name, (source, attr) in candidate.imports.items()
                              if source == module.name and attr is None or f"{source}.{attr}" == module.name}
            other_owners = {}

            def known_other_self(function, cls):
                key = id(function)
                if key not in other_owners:
                    valid = (isinstance(function, ast.FunctionDef) and isinstance(cls, ast.ClassDef)
                             and cls in candidate.tree.body and parents.get(id(function)) is cls
                             and cls.name not in {"_SharedConnection", "PostgresScanCacheAdapter"}
                             and not cls.bases and not cls.keywords and not cls.decorator_list
                             and function.name == "__init__" and not function.decorator_list
                             and [*function.args.posonlyargs, *function.args.args]
                             and [*function.args.posonlyargs, *function.args.args][0].arg == "self"
                             and cls.name not in candidate.assignments and cls.name not in candidate.imports and cls.name not in candidate.functions)
                    if valid:
                        valid = (sum(isinstance(node, ast.ClassDef) and node.name == cls.name for node in ast.walk(candidate.tree)) == 1
                                 and not any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in {"__new__", "__getattribute__", "__getattr__", "__setattr__", "__delattr__"} for node in cls.body)
                                 and all(isinstance(parents.get(id(node)), ast.Attribute) and parents[id(node)].value is node and parents[id(node)].attr != "__class__" for node in ast.walk(function) if isinstance(node, ast.Name) and node.id == "self"))
                    other_owners[key] = bool(valid)
                return other_owners[key]

            for node in ast.walk(candidate.tree):
                parent = parents.get(id(node))
                owner, class_name, function, cls = owners[id(node)]
                local = candidate is module
                if isinstance(node, ast.Name) and node.id in module_aliases and not (isinstance(parent, ast.Attribute) and parent.value is node and parent.attr not in {"_SharedConnection", "_SHARED_CONNECTION", "__dict__"}):
                    return None
                if isinstance(node, ast.ImportFrom) and node.module == module.name and any(alias.name in {"_SharedConnection", "*"} for alias in node.names):
                    return None
                if isinstance(node, ast.Attribute) and node.attr == "_SharedConnection":
                    return None
                if isinstance(node, ast.Name) and node.id == "_SharedConnection" and not (local and (id(node) in annotation_nodes or node is construction[0].func)):
                    return None
                if isinstance(node, ast.Constant) and node.value in {"_SharedConnection", "_SHARED_CONNECTION"}:
                    return None
                if isinstance(node, ast.Attribute) and node.attr == "_connect":
                    own_self = isinstance(node.value, ast.Name) and node.value.id == "self"
                    if isinstance(node.ctx, (ast.Store, ast.Del)) and node is not assignment and node is not adapter_assignment and not (own_self and known_other_self(function, cls)):
                        return None
                    if local and id(node) in shared_nodes and node is not assignment and not (own_self and isinstance(parent, ast.Call) and parent.func is node and not parent.args and not parent.keywords):
                        return None
                if isinstance(node, ast.Attribute) and node.attr == "_connect_to_database" and isinstance(node.ctx, (ast.Store, ast.Del)):
                    if not (isinstance(node.value, ast.Name) and node.value.id == "self" and known_other_self(function, cls)):
                        return None
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"setattr", "delattr", "getattr"} and any(isinstance(arg, ast.Constant) and arg.value in {"_connect", "_connect_to_database"} for arg in node.args):
                    if not (node.args and isinstance(node.args[0], ast.Name) and node.args[0].id == "self" and known_other_self(function, cls)) and not (node.func.id == "getattr" and self._known_adapter_connector_read(candidate, owner, node)):
                        return None
                if local and id(node) in shared_nodes and isinstance(node, ast.Name) and node.id == "self" and not (isinstance(parent, ast.Attribute) and parent.value is node):
                    return None
                if isinstance(node, ast.Name) and node.id == "_SHARED_CONNECTION" and not (local and
                        (owner in known_context_owners and isinstance(parent, ast.Attribute) and parent.value is node and parent.attr in {"get", "set", "reset"}
                         or isinstance(parent, ast.AnnAssign) and parent.target is node)):
                    return None
                if local and owner in known_context_owners and isinstance(node, ast.Name) and node.id == "shared":
                    stored = isinstance(node.ctx, ast.Store) and isinstance(parent, ast.Assign) and parent.targets == [node] and (
                        parent.value is construction[0] or isinstance(parent.value, ast.Call) and
                        ast.dump(parent.value, include_attributes=False) == ast.dump(ast.parse("_SHARED_CONNECTION.get()", mode="eval").body, include_attributes=False))
                    compared = isinstance(parent, ast.Compare) and len(parent.ops) == 1 and isinstance(parent.ops[0], (ast.Is, ast.IsNot)) and parent.left is node and len(parent.comparators) == 1 and isinstance(parent.comparators[0], ast.Constant) and parent.comparators[0].value is None
                    allowed = stored or isinstance(parent, ast.Attribute) and parent.value is node or compared
                    allowed = allowed or isinstance(parent, ast.Call) and isinstance(parent.func, ast.Attribute) and isinstance(parent.func.value, ast.Name) and parent.func.value.id == "_SHARED_CONNECTION" and parent.func.attr == "set" and parent.args == [node]
                    if not allowed:
                        return None
        return module.methods.get("PostgresScanCacheAdapter", {}).get("_connect_to_database")

    def module_function(self, module_name: str, name: str, depth: int = 0) -> Definition | None:
        """A function a module defines, imports, or aliases (`_ALIAS = run`)."""
        module = self.modules.get(module_name)
        if module is None or depth > 8:
            return None
        if name in module.functions:
            return module.functions[name]
        imported = module.imports.get(name)
        if imported and imported[1] and imported[0] != module_name:
            return self.module_function(imported[0], imported[1], depth + 1)
        alias = module.assignments.get(name, [])
        if len(alias) == 1 and isinstance(alias[0], ast.Name):
            return self.module_function(module_name, alias[0].id, depth + 1)
        return None

    def constructor(self, class_ref: tuple[str, str] | None) -> list[Definition]:
        """The `__init__` a call of an app class runs."""
        found = self.class_method(class_ref, "__init__") if class_ref is not None else None
        return [found] if found is not None else []

    def class_ref(self, module_name: str, name: str, depth: int = 0) -> tuple[str, str] | None:
        """The (module, class) an app class name refers to in a module."""
        module = self.modules.get(module_name)
        if module is None or depth > 8:
            return None
        if name in module.methods:
            return module_name, name
        imported = module.imports.get(name)
        if imported and imported[1] and imported[0] != module_name:
            return self.class_ref(imported[0], imported[1], depth + 1)
        return None

    def class_method(self, class_ref: tuple[str, str], name: str, depth: int = 0) -> Definition | None:
        """A method of an app class or of the app classes it inherits from."""
        module_name, class_name = class_ref
        module = self.modules[module_name]
        method = module.methods[class_name].get(name)
        if method is not None or depth > 8:
            return method
        for base in module.class_bases.get(class_name, []):
            base_ref = self.class_ref(module_name, base)
            if base_ref is not None and (found := self.class_method(base_ref, name, depth + 1)):
                return found
        return None

    def _type_ref(self, node: ast.AST | None, module_name: str) -> tuple[str, str] | None:
        """The app class a type annotation or a class expression names."""
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return self.class_ref(module_name, node.value)
        if isinstance(node, ast.Name):
            return self.class_ref(module_name, node.id)
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            imported = self.modules[module_name].imports.get(node.value.id)
            if imported and imported[1] is None:
                return self.class_ref(imported[0], node.attr)
        return None

    def _call_class(self, call: ast.Call, owner: Definition) -> tuple[str, str] | None:
        """The app class a call returns an instance of: a constructor call, or a
        call of a factory whose return annotation names one class or whose every
        `return` is a constructor call of one class."""
        found = self._type_ref(call.func, owner.module)
        if found is not None or not isinstance(call.func, ast.Name):
            return found
        targets = self.resolve(call.func, owner)
        if len(targets) != 1:
            return None
        factory = targets[0]
        if (annotated := self._type_ref(getattr(factory.node, "returns", None), factory.module)) is not None:
            return annotated
        returned = {
            self._type_ref(node.value.func, factory.module) if isinstance(node.value, ast.Call) else None
            for node in _own_nodes(factory)
            if isinstance(node, ast.Return)
        }
        return next(iter(returned)) if len(returned) == 1 else None

    def receiver_class(self, value: ast.AST, owner: Definition) -> tuple[str, str] | None:
        """The app class a method call's receiver is an instance of (or is):
        a constructor or factory call, a class, or a local or parameter whose
        every binding in the owner is such a call of, or an annotation naming,
        one class."""
        if isinstance(value, ast.Call):
            return self._call_class(value, owner)
        if not isinstance(value, ast.Name) or value.id in {"self", "cls"}:
            return None
        key = (id(owner.node), value.id)
        if key not in self._local_types:
            self._local_types[key] = self._local_type(value, owner)
        return self._local_types[key]

    def _local_type(self, value: ast.Name, owner: Definition) -> tuple[str, str] | None:
        name = value.id
        local_types = set()
        arguments = getattr(owner.node, "args", None)
        for argument in [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs] if arguments else []:
            if argument.arg == name:
                local_types.add(self._type_ref(argument.annotation, owner.module))
        for node in ast.walk(owner.node):
            if not any(isinstance(bound, ast.Name) and bound.id == name
                       for target in _binding_targets(node) for bound in ast.walk(target)):
                continue
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) \
                    and isinstance(node.value, ast.Call):
                local_types.add(self._call_class(node.value, owner))
            elif isinstance(node, ast.AnnAssign):
                local_types.add(self._type_ref(node.annotation, owner.module))
            else:
                local_types.add(None)
        if local_types:
            return next(iter(local_types)) if len(local_types) == 1 else None
        return self._type_ref(value, owner.module)

    def _external_import(self, module: Module, name: str, depth: int = 0) -> bool:
        """Whether a name a module imports comes from a third-party package,
        through app re-exports (`from music_app.services.covers import Image`)."""
        imported = module.imports.get(name)
        if imported is None or depth > 8:
            return False
        source, attribute = imported
        if source.split(".")[0] != "music_app":
            return bool(source)
        origin = self.modules.get(source)
        if origin is None or attribute is None or attribute in origin.functions or attribute in origin.methods:
            return False
        return self._external_import(origin, attribute, depth + 1)

    def built_by_library(self, value: ast.AST, module: Module, owner: Definition) -> bool:
        """A local receiver every binding of which is a call into a third-party
        import (`img = Image.open(...)`): its methods are that library's
        (`img.load()`), never an app method that happens to share the name."""
        if not isinstance(value, ast.Name):
            return False
        bound = [
            node.value for node in _own_nodes(owner)
            if isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name) and node.targets[0].id == value.id
        ]
        if not bound:
            return False
        for item in bound:
            func = item.func if isinstance(item, ast.Call) else None
            while isinstance(func, ast.Attribute):
                func = func.value
            if not isinstance(func, ast.Name) or not self._external_import(module, func.id):
                return False
        return True

    def resolve(self, call_target: ast.AST, owner: Definition, call: ast.Call | None = None) -> list[Definition]:
        """Definitions a call may run. A call of an app class runs its
        `__init__`; a module-level alias runs the function it names, and an
        entry of a module-level dispatch table (`_HANDLERS[key](...)`) any of
        its functions. A method call on a receiver that resolves to an app
        class runs that class's method. On an unknown receiver it may run any
        app method of that name; all candidates are followed, except that a
        builtin container name (CONTAINER_METHODS) or an ambiguous builtin
        protocol name (PROTOCOL_METHODS) is not."""
        module = self.modules[owner.module]
        if _shared_callback(owner, call_target):
            binding = self.shared_connection_binding()
            if binding["status"] == "resolved" and (call is None or not call.args and not call.keywords):
                return [binding["target"]]
        if isinstance(call_target, ast.Name):
            found = self.module_function(module.name, call_target.id)
            return [found] if found else self.constructor(self.class_ref(module.name, call_target.id))
        if isinstance(call_target, ast.Subscript) and isinstance(call_target.value, ast.Name):
            # A dispatch table the function builds (`handlers = {"go": run}`)
            # or a module-level one.
            tables = [
                node.value for node in _own_nodes(owner)
                if isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name) and node.targets[0].id == call_target.value.id
            ] or module.assignments.get(call_target.value.id, [])
            if len(tables) == 1 and isinstance(tables[0], ast.Dict):
                return [found for value in tables[0].values for found in self.resolve(_callable_target(value), owner)]
            return []
        if isinstance(call_target, ast.Attribute):
            value = call_target.value
            attr = call_target.attr
            if isinstance(value, ast.Name):
                if value.id in {"self", "cls"} and owner.class_name:
                    method = module.methods.get(owner.class_name, {}).get(attr)
                    if method:
                        return [method]
                    bound = module.bound_callables.get(owner.class_name, {}).get(attr, [])
                    found = [item for name in bound if (item := self.module_function(module.name, name))]
                    if found:
                        return found
                imported = module.imports.get(value.id)
                if imported:
                    target_module = imported[0] if imported[1] is None else f"{imported[0]}.{imported[1]}"
                    found = self.module_function(target_module, attr)
                    if found:
                        return [found]
                    if constructed := self.constructor(self.class_ref(target_module, attr)):
                        return constructed
            receiver = self.receiver_class(value, owner)
            if receiver is not None and (method := self.class_method(receiver, attr)):
                return [method]
            if attr in CONTAINER_METHODS or self.built_by_library(value, module, owner) or _library_constructed(value, module, owner):
                return []
            # A DB-API call on a connection or cursor is database work, not
            # an app method that happens to share the name.
            if attr in DATABASE_METHODS and (_imports_database_access(module) or _connection_receiver(value, module, owner)):
                return []
            candidates = self.methods_by_name.get(attr, [])
            if len(candidates) > 1 and attr in PROTOCOL_METHODS:
                return []
            # A method the call's arguments cannot bind (`event.set()` against
            # `Cache.set(self, key, value)`) is not what it runs.
            return [candidate for candidate in candidates if call is None or _accepts_call(candidate, call)]
        return []


NESTED_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
LOOP_NODES = (ast.For, ast.AsyncFor, ast.While, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
# Callables that run a lambda argument before returning; per-item consumers run
# it once per element. Any other lambda argument may be deferred (executors,
# queues, threads) and is not followed.
ITERATING_LAMBDA_CONSUMERS = {"sorted", "sort", "min", "max", "map", "filter", "any", "all", "sum"}


def _is_constant_literal(node: ast.AST) -> bool:
    """A tuple, list or set display without unpacking (a fixed number of
    items), or ``range`` over constants."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "range":
        return bool(node.args) and not node.keywords and all(isinstance(arg, ast.Constant) for arg in node.args)
    return isinstance(node, (ast.Tuple, ast.List, ast.Set)) and not any(isinstance(item, ast.Starred) for item in node.elts)


def _loop_source(node: ast.AST) -> ast.AST | None:
    if isinstance(node, (ast.For, ast.AsyncFor)):
        return node.iter
    if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
        return node.generators[0].iter
    return None


def _iterates_literal(node: ast.AST) -> bool:
    """A loop over a literal of constants, such as ``for ext in (".png", ".jpg")``,
    runs a fixed number of times: work inside it is not repeated per item."""
    if isinstance(node, (ast.For, ast.AsyncFor)):
        return _is_constant_literal(node.iter)
    if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
        return all(_is_constant_literal(generator.iter) for generator in node.generators)
    return False


@dataclass
class BodyFacts:
    calls: list[tuple[ast.Call, bool]]
    nested: dict[str, Definition]
    has_while: bool


_FACTS: dict[int, BodyFacts] = {}
# Every loaded module by name, for evidence that lives in another module.
_MODULES: dict[str, "Module"] = {}
# Parameters each definition calls, directly or through the helpers it passes them to.
_CALLED_PARAMETERS: dict[int, set[str]] = {}
# Thread locks some code holds across blocking work, with that work as witness.
_LOCKS_HELD_ACROSS_IO: dict[tuple[str, ...], str] = {}


def _module_scope(module: "Module") -> "Definition":
    """A definition with no body of its own, for module-level lookups."""
    return Definition(module.path, "", ast.Module(body=[], type_ignores=[]), module.name)
# The definition each nested function is defined in.
_PARENTS: dict[int, Definition] = {}


def _facts(definition: Definition) -> BodyFacts:
    """Calls that execute when the definition runs, each marked when it runs in a loop.

    Nested defs and deferred lambdas run only when something calls them. A
    block that ends the loop (`break`) runs at most once per enclosing loop, and
    one that leaves the function (`return`, `raise`) at most once per call.
    """
    cached = _FACTS.get(id(definition.node))
    if cached is not None:
        return cached
    calls: list[tuple[ast.Call, bool]] = []
    nested: dict[str, Definition] = {}
    has_while = False
    lambda_loops: dict[int, bool] = {}
    # Each node carries the number of repeating loops around it in this body.
    stack = [(child, 0) for child in ast.iter_child_nodes(definition.node)]
    evaluated_once: dict[int, int] = {}
    while stack:
        node, depth = stack.pop()
        depth = evaluated_once.pop(id(node), depth)
        if isinstance(node, ast.Lambda):
            if id(node) not in lambda_loops:
                continue
            depth += int(lambda_loops[id(node)])
        if isinstance(node, ast.Call):
            calls.append((node, depth > 0))
            consumer = _call_name(node)[1]
            awaited_submit = _awaited_submit(node)
            synchronous = [node] if consumer in ITERATING_LAMBDA_CONSUMERS or consumer in SYNCHRONOUS_DISPATCH else []
            for call in [*synchronous, *([awaited_submit] if awaited_submit else [])]:
                for argument in [*call.args, *(keyword.value for keyword in call.keywords)]:
                    if isinstance(argument, ast.Lambda):
                        lambda_loops[id(argument)] = consumer in ITERATING_LAMBDA_CONSUMERS
        elif isinstance(node, ast.While):
            has_while = True
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            nested[node.name] = Definition(
                definition.path,
                f"{definition.qualname}.<locals>.{node.name}",
                node,
                definition.module,
                definition.class_name,
            )
            _PARENTS[id(node)] = definition
        if isinstance(node, NESTED_SCOPES):
            continue
        if isinstance(node, (ast.Return, ast.Raise)):
            child_depth = 0
        else:
            child_depth = depth + int(isinstance(node, LOOP_NODES) and not _iterates_literal(node))
        # The iterable of a `for` (or of a comprehension's first `for`) is
        # evaluated once, before the loop repeats anything.
        source = _loop_source(node)
        if source is not None:
            evaluated_once[id(source)] = depth
        for name in node._fields:
            value = getattr(node, name, None)
            if isinstance(value, list):
                block_depth = child_depth
                if value and isinstance(value[-1], ast.Break):
                    block_depth = max(child_depth - 1, 0)
                elif value and isinstance(value[-1], (ast.Return, ast.Raise)):
                    block_depth = 0
                stack.extend((item, block_depth) for item in value if isinstance(item, ast.AST))
            elif isinstance(value, ast.AST):
                stack.append((value, child_depth))
    calls.sort(key=lambda item: (item[0].lineno, item[0].col_offset))
    facts = BodyFacts(calls, nested, has_while)
    _FACTS[id(definition.node)] = facts
    return facts


def _call_name(node: ast.Call) -> tuple[str, str]:
    func = node.func
    if isinstance(func, ast.Name):
        return "", func.id
    if isinstance(func, ast.Attribute):
        base = func.value.id if isinstance(func.value, ast.Name) else ""
        return base, func.attr
    return "", ""


def _awaited_submit(node: ast.Call) -> ast.Call | None:
    """`pool.submit(fn, ...)` when it is immediately waited on with `.result()`."""
    func = node.func
    if isinstance(func, ast.Attribute) and func.attr == "result" and isinstance(func.value, ast.Call):
        if _call_name(func.value)[1] == "submit":
            return func.value
    return None


def _launched_callable(node: ast.Call) -> tuple[str, ast.AST] | None:
    """The callable a thread or executor runs in the background, with its trigger."""
    _, name = _call_name(node)
    if name in {"Thread", "Timer"}:
        for keyword in node.keywords:
            if keyword.arg in {"target", "function"}:
                return "thread", keyword.value
        # Thread(group, target) and Timer(interval, function).
        return ("thread", node.args[1]) if len(node.args) > 1 else None
    if name == "submit" and node.args:
        return "executor", _context_run_target(node.args, 0)
    if name == "run_in_executor" and len(node.args) > 1:
        return "executor", _context_run_target(node.args, 1)
    return None


def _context_run_target(args: list[ast.AST], position: int) -> ast.AST:
    """The callable at `position`, or, when that is `copy_context().run`
    (`submit(contextvars.copy_context().run, job, ...)`), the callable it runs."""
    target = args[position]
    if (
        isinstance(target, ast.Attribute) and target.attr == "run"
        and isinstance(target.value, ast.Call) and _call_name(target.value)[1] == "copy_context"
        and len(args) > position + 1
    ):
        return args[position + 1]
    return target


def _callable_target(node: ast.AST) -> ast.AST | None:
    """Unwraps `functools.partial(fn, ...)` and `lambda: fn(...)` to `fn`."""
    if isinstance(node, ast.Call) and _call_name(node)[1] == "partial" and node.args:
        return _callable_target(node.args[0])
    if isinstance(node, ast.Lambda):
        return node.body.func if isinstance(node.body, ast.Call) else None
    return node


ENUMERATIONS = frozenset({*ENUMERATION_CALLS.values(), *ENUMERATION_METHODS.values()})


def _qualified_name(node: ast.AST, module: Module) -> str:
    """The dotted name a call target refers to, with its leading name resolved
    through the module's imports (`from psycopg import connect` -> `psycopg.connect`)."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return ""
    imported = module.imports.get(node.id)
    head = node.id
    if imported:
        head = imported[0] if imported[1] is None else f"{imported[0]}.{imported[1]}"
    return ".".join([head, *reversed(parts)])


def _imports_database_driver(module: Module) -> bool:
    return any(source.split(".")[0] in DATABASE_DRIVERS for source, _ in module.imports.values())


def _imports_database_access(module: Module) -> bool:
    """A database driver or the app's pooled-connection module is imported."""
    return _imports_database_driver(module) or any(
        source == POOLED_CONNECTION_MODULE or source.startswith(f"{POOLED_CONNECTION_MODULE}.")
        for source, _ in module.imports.values()
    )


def _opens_connection(call: ast.AST, module: Module) -> bool:
    if not isinstance(call, ast.Call):
        return False
    name = _qualified_name(call.func, module)
    if name in DATABASE_CONNECTS or name.startswith(f"{POOLED_CONNECTION_MODULE}."):
        return True
    return isinstance(call.func, ast.Attribute) and call.func.attr in CONNECTION_FACTORY_METHODS


def _connection_receiver(value: ast.AST, module: Module, owner: Definition) -> bool:
    """A name the definition bound with `with <connection factory>(...) as name`."""
    if not isinstance(value, ast.Name):
        return False
    return any(
        isinstance(item.optional_vars, ast.Name) and item.optional_vars.id == value.id
        and _opens_connection(item.context_expr, module)
        for node in _own_nodes(owner) if isinstance(node, (ast.With, ast.AsyncWith))
        for item in node.items
    )


def _database_call(node: ast.Call, module: Module, owner: Definition) -> bool:
    """A DB-API call on evidence that its receiver is a connection or cursor."""
    if not isinstance(node.func, ast.Attribute) or node.func.attr not in DATABASE_METHODS:
        return False
    receiver = node.func.value
    executed = (
        node.func.attr in FETCH_METHODS and isinstance(receiver, ast.Call)
        and isinstance(receiver.func, ast.Attribute) and receiver.func.attr == "execute"
    )
    return executed or _imports_database_access(module) or _connection_receiver(receiver, module, owner)


def _lock_key(value: ast.AST, module: Module, owner: Definition) -> tuple[str, ...] | None:
    """Which thread lock an expression names: a module-level lock (followed
    through app imports) or a `self` attribute of the owner's class."""
    if isinstance(value, ast.Name):
        imported = module.imports.get(value.id)
        if imported and imported[1] and imported[0] in _MODULES and value.id not in module.assignments:
            return (imported[0], imported[1])
        return (module.name, value.id)
    if isinstance(value, ast.Attribute) and isinstance(value.value, ast.Name) and value.value.id == "self" and owner.class_name:
        return (module.name, owner.class_name, value.attr)
    return None


def _thread_lock(value: ast.AST, module: Module, owner: Definition) -> tuple[str, tuple[str, ...] | None]:
    """(lock kind, lock key) when `value` is evidently a thread lock, else ("", None)."""
    kind = _receiver_constructor(value, module, owner)
    if kind.startswith("threading.") and "acquire" in BLOCKING_WAITS.get(kind, ()):
        return kind, _lock_key(value, module, owner)
    return "", None


def _lock_blocks(definition: Definition, module: Module):
    """`with lock:` statements on a thread lock: (statement, kind, key)."""
    for node in _own_nodes(definition):
        if isinstance(node, ast.With):
            for item in node.items:
                kind, key = _thread_lock(item.context_expr, module, definition)
                if kind:
                    yield node, kind, key


def _lock_waits(definition: Definition, module: Module) -> list[tuple[str, int]]:
    """`with lock:` blocks in the definition on a thread lock that some holder
    keeps across blocking work (`_LOCKS_HELD_ACROSS_IO`), as (operation, line).
    A lock held only around in-memory bookkeeping is released at once."""
    found = [
        (f"{kind.rsplit('.', 1)[1]}.acquire", node.lineno)
        for node, kind, key in _lock_blocks(definition, module)
        if key in _LOCKS_HELD_ACROSS_IO
    ]
    return sorted(found, key=lambda item: item[1])


def _database_connect(node: ast.Call, module: Module) -> str | None:
    """A new database connection or pool: the psycopg call that opens it."""
    name = _qualified_name(node.func, module)
    return name if name in DATABASE_CONNECTS else None


def _blocking_operation(node: ast.Call, module: Module, owner: Definition) -> tuple[str, str] | None:
    """(family, operation) for a call that blocks its thread until I/O or
    another thread completes."""
    name = _qualified_name(node.func, module)
    if name in BLOCKING_CALLS:
        return BLOCKING_CALLS[name], name
    if name in FILESYSTEM_MUTATORS:
        return "filesystem", name
    operation = _filesystem_operation(node)
    if operation is not None:
        return ("media" if operation == "mutagen.File" else "filesystem"), operation
    if isinstance(node.func, ast.Attribute):
        attr, receiver = node.func.attr, node.func.value
        if attr in FILESYSTEM_WRITE_METHODS:
            return "filesystem", FILESYSTEM_WRITE_METHODS[attr]
        if attr in PATH_ONLY_WRITE_METHODS and (
            _path_valued(receiver) or _receiver_constructor(receiver, module, owner).startswith("pathlib.")
        ):
            return "filesystem", PATH_ONLY_WRITE_METHODS[attr]
        if _database_call(node, module, owner):
            return "database", f"db.{attr}"
        if attr in WAIT_METHODS and not _non_blocking_get(node):
            kind = _receiver_constructor(receiver, module, owner)
            lock_acquire = attr == "acquire" and kind.startswith("threading.")
            if attr in BLOCKING_WAITS.get(kind, ()) and (
                not lock_acquire or _lock_key(receiver, module, owner) in _LOCKS_HELD_ACROSS_IO
            ):
                return "wait", f"{kind.rsplit('.', 1)[1]}.{attr}"
    return None


def _non_blocking_get(node: ast.Call) -> bool:
    """`queue.get(False)`, `queue.get(block=False)` and `lock.acquire(False)`
    (or `blocking=False`) return at once."""
    keyword_name = {"get": "block", "acquire": "blocking"}.get(node.func.attr)
    if keyword_name is None:
        return False
    block = next((keyword.value for keyword in node.keywords if keyword.arg == keyword_name), node.args[0] if node.args else None)
    return isinstance(block, ast.Constant) and block.value is False


def _receiver_constructor(value: ast.AST, module: Module, owner: Definition, _seen: frozenset[str] = frozenset()) -> str:
    """The import-qualified constructor that built a receiver, or "": a call,
    or a local, module-level name, or `self` attribute every assignment of
    which is a call of that one constructor. `submit(...)` and
    `asyncio.run_coroutine_threadsafe(...)` build a `concurrent.futures.Future`."""
    if isinstance(value, ast.Call):
        name = _qualified_name(value.func, module)
        if name == "asyncio.run_coroutine_threadsafe" or _call_name(value)[1] == "submit":
            return FUTURE
        return name
    if isinstance(value, ast.Name):
        bound = [
            node.value for node in _own_nodes(owner)
            if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None
            and any(isinstance(target, ast.Name) and target.id == value.id for target in _binding_targets(node))
        ] or module.assignments.get(value.id, [])
        imported = module.imports.get(value.id)
        source = _MODULES.get(imported[0]) if not bound and imported and imported[1] else None
        if source is not None and source is not module:
            # A module-level instance another app module defines
            # (`from music_app.services.lastfm_retry import _RETRY_LOCK`).
            return _receiver_constructor(ast.Name(id=imported[1]), source, _module_scope(source))
    elif isinstance(value, ast.Attribute) and isinstance(value.value, ast.Name) and value.value.id == "self":
        bound = module.attribute_values.get(owner.class_name, {}).get(value.attr, [])
    else:
        return ""
    # `None` placeholders say nothing about what the name holds once set.
    # A local bound from another local (`event = threading.Event(); _WAKE = event`) is followed.
    seen = _seen | ({value.id} if isinstance(value, ast.Name) else set())
    kinds = {
        _receiver_constructor(item, module, owner) if isinstance(item, ast.Call)
        else _receiver_constructor(item, module, owner, seen) if isinstance(item, ast.Name) and item.id not in seen
        else ""
        for item in bound if not (isinstance(item, ast.Constant) and item.value is None)
    }
    if len(kinds) == 1 and "" not in kinds:
        return next(iter(kinds))
    annotated = _annotated_kind(module.annotations.get(value.id), module) if isinstance(value, ast.Name) else ""
    if annotated and not kinds - {annotated}:
        return annotated
    return next(iter(kinds)) if len(kinds) == 1 else ""


def _annotated_kind(annotation: ast.AST | None, module: Module) -> str:
    """The one import-qualified type an annotation names, through `X | None`
    and `Optional[X]`, or ""."""
    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        sides = [side for side in (annotation.left, annotation.right) if not (isinstance(side, ast.Constant) and side.value is None)]
        return _annotated_kind(sides[0], module) if len(sides) == 1 else ""
    if isinstance(annotation, ast.Subscript) and _qualified_name(annotation.value, module) in {"typing.Optional", "Optional"}:
        return _annotated_kind(annotation.slice, module)
    if isinstance(annotation, (ast.Name, ast.Attribute)):
        return _qualified_name(annotation, module)
    return ""


def _library_constructed(value: ast.AST, module: Module, owner: Definition) -> bool:
    """A receiver evidently built by a stdlib or third-party constructor
    (`threading.Event()`, `queue.Queue()`): its methods are that library's."""
    kind = _receiver_constructor(value, module, owner)
    return "." in kind and kind.split(".")[0] != "music_app"


def _is_os_path(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Attribute) and node.attr == "path"
        and isinstance(node.value, ast.Name) and node.value.id == "os"
    )


def _path_valued(node: ast.AST) -> bool:
    """Whether an expression evidently evaluates to a `pathlib` path."""
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Name):
            return func.id in PATH_CONSTRUCTORS
        if isinstance(func, ast.Attribute):
            return func.attr in PATH_CONSTRUCTORS or (func.attr in PATH_VALUED_METHODS and _path_valued(func.value))
        return False
    if isinstance(node, ast.Attribute) and node.attr in {"parent", "parents"}:
        return _path_valued(node.value)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        return _path_valued(node.left)
    return False


# In-memory streams: `Image.open(io.BytesIO(raw))` decodes bytes already read.
MEMORY_STREAMS = frozenset({"BytesIO", "StringIO"})


def _filesystem_operation(node: ast.Call) -> str | None:
    base, name = _call_name(node)
    attribute = isinstance(node.func, ast.Attribute)
    if name == "open" and node.args and isinstance(node.args[0], ast.Call) and _call_name(node.args[0])[1] in MEMORY_STREAMS:
        return None
    if (base, name) in ENUMERATION_CALLS:
        return ENUMERATION_CALLS[(base, name)]
    if attribute and name in ENUMERATION_METHODS and base not in {"glob", "fnmatch", "re"}:
        return ENUMERATION_METHODS[name]
    if (base, name) == ("os", "stat"):
        return "os.stat"
    if attribute and name in OS_PATH_PROBES and _is_os_path(node.func.value):
        return f"os.path.{name}"
    if attribute and name == "resolve" and (
        _path_valued(node.func.value) or any(keyword.arg == "strict" for keyword in node.keywords)
    ):
        return "Path.resolve"
    if attribute and name in PROBE_METHODS and base != "os":
        return PROBE_METHODS[name]
    if isinstance(node.func, ast.Name) and name == "open":
        return "open"
    if (base, name) == ("mutagen", "File") or name in MEDIA_CALLS:
        return "mutagen.File"
    return None


def _direct_hazards(definition: Definition, looped: bool, module: Module | None = None, index: Index | None = None) -> list[dict[str, object]]:
    """Directory enumeration always counts. A single stat/open/media parse of a
    selected file is bounded; the same probe repeated per item is not. A new
    database connection opened per item (BI-05) is an N+1 connection storm."""
    hazards = []
    for node, in_loop in _facts(definition).calls:
        unresolved = index is not None and _shared_callback(definition, node.func) and (
            index.shared_connection_binding()["status"] != "resolved" or node.args or node.keywords)
        connect = "unresolved-shared-connector" if unresolved else _database_connect(node, module) if module is not None else None
        if connect is not None and (in_loop or looped or unresolved):
            hazards.append({
                "rule": "BI-05",
                "operation": f"database-connect-per-item:{connect}",
                "path": definition.path,
                "function": definition.qualname,
                "line": node.lineno,
                "enumeration": False,
                "per_item_connect": True,
                "_site_node": node,
            })
            continue
        operation = _filesystem_operation(node)
        if operation is None:
            continue
        enumeration = operation in ENUMERATIONS
        if not (enumeration or in_loop or looped):
            continue
        hazards.append({
            "rule": "BI-06",
            "operation": operation,
            "path": definition.path,
            "function": definition.qualname,
            "line": node.lineno,
            "enumeration": enumeration,
        })
    return hazards


# Library-state scans. The in-memory library state holds the whole library in
# registered collections (`library_state["albums"]`); a loop, comprehension, or
# copy over one of them is library-sized work. A receiver is library state by
# evidence through the call graph, whatever it is named (see
# LibraryStateEvidence). One local alias (`albums = st.get("albums", [])`) is
# followed.
COPYING_CALLS = {"list", "sorted", "tuple", "set", "dict", "frozenset", "enumerate", "reversed"}
VIEW_METHODS = {"values", "items", "keys", "copy"}


def _library_collection(node: ast.AST, is_state, aliases: dict[str, str], collections: set[str]) -> str | None:
    """The registered collection an expression reads, through copies and views."""
    while True:
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in COPYING_CALLS and node.args:
            node = node.args[0]
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in VIEW_METHODS and not node.args:
            node = node.func.value
        elif isinstance(node, (ast.BoolOp, ast.IfExp)):
            values = node.values if isinstance(node, ast.BoolOp) else [node.body, node.orelse]
            found = [_library_collection(value, is_state, aliases, collections) for value in values]
            return next((item for item in found if item), None)
        else:
            break
    if isinstance(node, ast.Name):
        return aliases.get(node.id)
    key = None
    if isinstance(node, ast.Subscript) and is_state(node.value):
        key = node.slice
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get" and node.args:
        if is_state(node.func.value):
            key = node.args[0]
    if isinstance(key, ast.Constant) and key.value in collections:
        return str(key.value)
    return None


_OWN_NODES: dict[int, list[ast.AST]] = {}


def _own_nodes(definition: Definition) -> list[ast.AST]:
    """The definition's nodes outside nested functions and classes."""
    if id(definition.node) in _OWN_NODES:
        return _OWN_NODES[id(definition.node)]
    pending = list(ast.iter_child_nodes(definition.node))
    found = []
    while pending:
        node = pending.pop()
        found.append(node)
        if not isinstance(node, NESTED_SCOPES):
            pending.extend(ast.iter_child_nodes(node))
    _OWN_NODES[id(definition.node)] = found
    return found


class LibraryStateEvidence:
    """Which values are the app's library state, proven through the call graph.

    Evidence is a `.library_state` attribute (`request.app.state.library_state`);
    a call of a getter that returns library state (`_library_state(request)`,
    found by its returns); a parameter or local bound from such a value
    (`st = get_state()`); a getter parameter whose call sites pass a getter or a
    lambda returning library state (`get_state=lambda: _library_state(request)`);
    and a parameter whose call sites pass library state or one of its registered
    collections (`updated_file_cache=st["file_cache"]`). The facts are solved to
    a fixpoint over every call site.
    """

    def __init__(self, modules: list[Module], index: Index, collections: set[str]):
        self.index = index
        self.collections = collections
        self.getters: set[int] = set()
        self.state_params: dict[int, set[str]] = {}
        self.getter_params: dict[int, set[str]] = {}
        self.collection_params: dict[int, dict[str, str]] = {}
        self._caller_views: dict[tuple[int, frozenset[str] | None], tuple[object, dict[str, str]]] = {}
        definitions = list(_all_definitions(modules)) if collections else []
        # A nested function reads its enclosing function's parameters and locals.
        self.parents: dict[int, Definition] = {
            id(nested.node): item for item in definitions for nested in _facts(item).nested.values()
        }
        returns = {id(item.node): [node.value for node in _own_nodes(item) if isinstance(node, ast.Return) and node.value is not None] for item in definitions}
        changed = True
        while changed:
            changed = False
            for definition in definitions:
                is_state = self._state_predicate(definition)
                if id(definition.node) not in self.getters and any(is_state(value) for value in returns[id(definition.node)]):
                    self.getters.add(id(definition.node))
                    changed = True
                resolve = _resolver(definition, index)
                aliases = self.aliases(definition, is_state)
                for node, _ in _facts(definition).calls:
                    for target in resolve(node.func, call=node):
                        for parameter, argument in _bound_arguments(node, target):
                            if is_state(argument):
                                changed |= self._add(self.state_params, target, parameter)
                            elif self._is_getter(argument, definition, is_state):
                                changed |= self._add(self.getter_params, target, parameter)
                            elif collection := _library_collection(argument, is_state, aliases, collections):
                                known = self.collection_params.setdefault(id(target.node), {})
                                if parameter not in known:
                                    known[parameter] = collection
                                    changed = True
                        changed |= self._forward_keywords(node, definition, target)

    def _forward_keywords(self, node: ast.Call, definition: Definition, target: Definition) -> bool:
        """`target(**kwargs)` inside a definition that collected `**kwargs`
        passes on what its callers put there (`get_state=lambda: ...` given to
        a queueing helper reaches the finalizer it calls)."""
        kwarg = definition.node.args.kwarg
        if kwarg is None or not any(item.arg is None and isinstance(item.value, ast.Name) and item.value.id == kwarg.arg for item in node.keywords):
            return False
        names = set(_parameter_names(target))
        explicit = {item.arg for item in node.keywords if item.arg is not None}
        changed = False
        for facts in (self.state_params, self.getter_params):
            for name in list(facts.get(id(definition.node), ())):
                key = name.removeprefix("**")
                if name.startswith("**") and key not in explicit:
                    parameter = key if key in names else f"**{key}" if target.node.args.kwarg else None
                    if parameter is not None:
                        changed |= self._add(facts, target, parameter)
        for name, collection in list(self.collection_params.get(id(definition.node), {}).items()):
            key = name.removeprefix("**")
            if name.startswith("**") and key not in explicit:
                parameter = key if key in names else f"**{key}" if target.node.args.kwarg else None
                known = self.collection_params.setdefault(id(target.node), {})
                if parameter is not None and parameter not in known:
                    known[parameter] = collection
                    changed = True
        return changed

    def _enclosing(self, definition: Definition):
        """The functions a nested definition closes over, innermost first."""
        parent = self.parents.get(id(definition.node))
        while parent is not None:
            yield parent
            parent = self.parents.get(id(parent.node))

    def _closure_facts(self, facts: dict[int, set[str]], definition: Definition) -> set[str]:
        """The names a definition sees with a fact: its own parameters, and
        those of the functions it closes over that it does not shadow."""
        own = set(_parameter_names(definition))
        found = set(facts.get(id(definition.node), set()))
        for parent in self._enclosing(definition):
            found |= {name for name in facts.get(id(parent.node), set()) if name not in own}
            own |= set(_parameter_names(parent))
        return found

    @staticmethod
    def _add(facts: dict[int, set[str]], target: Definition, parameter: str) -> bool:
        known = facts.setdefault(id(target.node), set())
        if parameter in known:
            return False
        known.add(parameter)
        return True

    def _calls_getter(self, node: ast.Call, definition: Definition) -> bool:
        func = node.func
        if isinstance(func, ast.Name) and func.id in self._closure_facts(self.getter_params, definition):
            return True
        return any(id(target.node) in self.getters for target in _resolver(definition, self.index)(func))

    def _state_predicate(self, definition: Definition):
        """`is_state(expr)` for expressions inside `definition`."""
        # A `library_state` parameter or local keeps counting as evidence
        # where its callers cannot be resolved.
        names = self._closure_facts(self.state_params, definition) | ({"library_state"} & set(_parameter_names(definition)))

        def is_state(node: ast.AST) -> bool:
            if isinstance(node, ast.Name):
                return node.id in names
            if isinstance(node, ast.Attribute):
                return node.attr == "library_state"
            return isinstance(node, ast.Call) and (_call_name(node)[1] == "_library_state" or self._calls_getter(node, definition))

        # Assignments in nested functions count too: closures read them.
        assignments = sorted(
            (node for node in ast.walk(definition.node) if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)),
            key=lambda node: node.lineno,
        )
        for assignment in assignments:
            if is_state(assignment.value) or assignment.targets[0].id == "library_state":
                names.add(assignment.targets[0].id)
        return is_state

    def _is_getter(self, node: ast.AST, definition: Definition, is_state) -> bool:
        if isinstance(node, ast.Lambda):
            return is_state(node.body)
        if isinstance(node, ast.Name) and node.id in self._closure_facts(self.getter_params, definition):
            return True
        return isinstance(node, (ast.Name, ast.Attribute)) and any(
            id(target.node) in self.getters for target in _resolver(definition, self.index)(node)
        )

    def aliases(self, definition: Definition, is_state, bound: frozenset[str] | None = None) -> dict[str, str]:
        """Names that hold a library-state collection. `bound`, when known, is
        the parameters the call being followed passed a collection for: another
        caller passing the whole file cache to the same parameter does not make
        this call's argument one."""
        own = set(_parameter_names(definition))
        aliases = {}
        for parent in reversed(list(self._enclosing(definition))):
            aliases.update({name: collection for name, collection in self.collection_params.get(id(parent.node), {}).items() if name not in own})
        aliases.update({
            name: collection for name, collection in self.collection_params.get(id(definition.node), {}).items()
            if bound is None or name in bound
        })
        for node in ast.walk(definition.node):
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                collection = _library_collection(node.value, is_state, {}, self.collections)
                if collection:
                    aliases[node.targets[0].id] = collection
        return aliases

    def scans(self, definition: Definition, bound: frozenset[str] | None = None) -> list[dict[str, object]]:
        if not self.collections:
            return []
        is_state = self._state_predicate(definition)
        aliases = self.aliases(definition, is_state, bound)
        hazards = []
        seen = set()
        for item in ast.walk(definition.node):
            sources = []
            if isinstance(item, (ast.For, ast.AsyncFor)):
                sources = [item.iter]
            elif isinstance(item, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                sources = [generator.iter for generator in item.generators]
            elif isinstance(item, ast.Call) and isinstance(item.func, ast.Name) and item.func.id in COPYING_CALLS and item.args:
                sources = [item.args[0]]
            for source in sources:
                collection = _library_collection(source, is_state, aliases, self.collections)
                if collection and (source.lineno, collection) not in seen:
                    seen.add((source.lineno, collection))
                    hazards.append({
                        "rule": "BI-04",
                        "operation": f"library-state-scan:{collection}",
                        "path": definition.path,
                        "function": definition.qualname,
                        "line": source.lineno,
                        "enumeration": False,
                    })
        return hazards

    def bound_collections(self, caller: Definition, caller_bound: frozenset[str] | None, call: ast.Call, callee: Definition) -> frozenset[str] | None:
        """The callee parameters this call passes a library-state collection
        for, or None when the call does not bind the callee's parameters
        directly (a dispatch, a lambda or a callable argument)."""
        if not self.collections or not any(target.node is callee.node for target in _resolver(caller, self.index)(call.func)):
            return None
        key = (id(caller.node), caller_bound)
        if key not in self._caller_views:
            is_state = self._state_predicate(caller)
            self._caller_views[key] = (is_state, self.aliases(caller, is_state, caller_bound))
        is_state, aliases = self._caller_views[key]
        return frozenset(
            parameter for parameter, argument in _bound_arguments(call, callee)
            if _library_collection(argument, is_state, aliases, self.collections)
        )

    def scan_calls(self, definition: Definition, bound: frozenset[str] | None = None) -> dict[int, tuple[str, int, ast.AST]]:
        """Calls made once per item of a loop or comprehension over a library
        state collection: {id(call): (collection, loop line, source AST)}."""
        if not self.collections:
            return {}
        is_state = self._state_predicate(definition)
        aliases = self.aliases(definition, is_state, bound)
        found: dict[int, tuple[str, int, ast.AST]] = {}
        for item in _own_nodes(definition):
            if isinstance(item, (ast.For, ast.AsyncFor)):
                sources, bodies = [item.iter], [item.body]
            elif isinstance(item, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                sources = [item.generators[0].iter]
                bodies = [
                    *([item.key, item.value] if isinstance(item, ast.DictComp) else [item.elt]),
                    *(condition for generator in item.generators for condition in generator.ifs),
                    *(generator.iter for generator in item.generators[1:]),
                ]
            else:
                continue
            collection = _library_collection(sources[0], is_state, aliases, self.collections)
            if not collection:
                continue
            # A block that leaves the function (`return`, `raise`) or ends the
            # scan (`break` outside a nested loop) runs at most once per scan.
            pending = [(body, False) for body in bodies]
            while pending:
                node, nested_loop = pending.pop()
                if isinstance(node, list):
                    last = node[-1] if node else None
                    if isinstance(last, (ast.Return, ast.Raise)) or (isinstance(last, ast.Break) and not nested_loop):
                        continue
                    pending.extend((child, nested_loop) for child in node)
                    continue
                if isinstance(node, (*NESTED_SCOPES, ast.Lambda)):
                    continue
                if isinstance(node, ast.Call):
                    found.setdefault(id(node), (collection, sources[0].lineno, sources[0]))
                inner = nested_loop or isinstance(node, LOOP_NODES)
                for name in node._fields:
                    value = getattr(node, name, None)
                    if isinstance(value, list):
                        pending.append(([child for child in value if isinstance(child, ast.AST)], inner))
                    elif isinstance(value, ast.AST):
                        pending.append((value, inner))
        return found


# Per-item work that turns a scan of the whole library state into library-sized
# I/O: a filesystem or media probe, or a database call, for every cached item.
SCAN_IO_FAMILIES = frozenset({"filesystem", "media", "database"})


def _local_callable_bindings(definition: Definition, name: str) -> list[ast.AST]:
    """The callables a local name is bound to, when every binding in the
    definition names one (`respond = _cover_response`), else none: a local
    bound to a call result or a parameter is not followed."""
    values = [
        node.value for node in _own_nodes(definition)
        if isinstance(node, ast.Assign) and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name) and node.targets[0].id == name
    ]
    if not values or not all(isinstance(value, (ast.Name, ast.Attribute)) for value in values):
        return []
    return values


def _accepts_call(method: Definition, call: ast.Call) -> bool:
    """Whether a method call's arguments can bind the method's parameters
    (its receiver excluded): no required parameter left unfilled and no
    surplus positional argument. Unpacked arguments may fill anything."""
    if any(isinstance(arg, ast.Starred) for arg in call.args) or any(keyword.arg is None for keyword in call.keywords):
        return True
    arguments = method.node.args
    positional = [*arguments.posonlyargs, *arguments.args]
    if positional and positional[0].arg in {"self", "cls"}:
        positional = positional[1:]
    if len(call.args) > len(positional) and arguments.vararg is None:
        return False
    named = {keyword.arg for keyword in call.keywords}
    required = positional[: len(positional) - len(arguments.defaults)]
    if any(parameter.arg not in named for parameter in required[len(call.args):]):
        return False
    return all(
        parameter.arg in named
        for parameter, default in zip(arguments.kwonlyargs, arguments.kw_defaults)
        if default is None
    )


def _visible_nested(definition: Definition) -> dict[str, Definition]:
    """Nested functions a definition can call by name: its own, then those of
    the functions it is nested in (a sibling closure such as `resolved_cover`
    called from `cover_identity`), innermost first."""
    visible: dict[str, Definition] = {}
    current: Definition | None = definition
    while current is not None:
        for name, nested in _facts(current).nested.items():
            visible.setdefault(name, nested)
        current = _PARENTS.get(id(current.node))
    return visible


def _resolver(definition: Definition, index: Index):
    nested = _visible_nested(definition)

    def resolve(target: ast.AST | None, seen: frozenset[str] = frozenset(), call: ast.Call | None = None) -> list[Definition]:
        if target is None:
            return []
        if isinstance(target, ast.Name) and target.id in nested:
            return [nested[target.id]]
        found = index.resolve(target, definition, call)
        if found or not isinstance(target, ast.Name) or target.id in seen:
            return found
        # A local alias of one or more functions (`respond = _legacy_cover_response`).
        return [
            item
            for value in _local_callable_bindings(definition, target.id)
            for item in resolve(value, seen | {target.id})
        ]

    return resolve


def _lambda_calls(node: ast.Lambda) -> list[ast.Call]:
    """The calls a lambda's body makes when it runs (not those of a nested lambda)."""
    found = []
    pending = [node.body]
    while pending:
        item = pending.pop()
        if isinstance(item, ast.Lambda):
            continue
        if isinstance(item, ast.Call):
            found.append(item)
        pending.extend(ast.iter_child_nodes(item))
    return found


def _invoked_arguments(node: ast.Call, targets: list[Definition], definition: Definition) -> list[ast.AST]:
    """Callable arguments a call runs before it returns: one passed for a
    parameter the callee calls (`_post_commit_value(warnings, stage, callback)`
    calling `callback()`), or one passed to a local bound to a lambda that
    calls its own parameter (`guard = run_guard or (lambda action: action())`)."""
    arguments = []
    for target in targets:
        for parameter in _called_parameters(target):
            argument = _argument_for(node, target, parameter)
            if argument is not None:
                arguments.append(argument)
    if not targets and isinstance(node.func, ast.Name):
        for assignment in _own_nodes(definition):
            if not (isinstance(assignment, ast.Assign) and len(assignment.targets) == 1
                    and isinstance(assignment.targets[0], ast.Name) and assignment.targets[0].id == node.func.id):
                continue
            for guard in (item for item in ast.walk(assignment.value) if isinstance(item, ast.Lambda)):
                called = {call.func.id for call in _lambda_calls(guard) if isinstance(call.func, ast.Name)}
                for position, parameter in enumerate(guard.args.args):
                    if parameter.arg in called and position < len(node.args):
                        arguments.append(node.args[position])
    return arguments


def _callees(definition: Definition, index: Index) -> list[tuple[Definition, bool, int, ast.Call]]:
    """What each call runs, with whether it runs per loop item, its line and
    the call. A callable the call itself runs (see `_invoked_arguments`) is
    followed too: a lambda through its body (`_post_commit_value(..., lambda:
    guard(refresh_runtime_state), ...)` runs `refresh_runtime_state` here), and
    a nested or module function passed by name (`expand(url,
    log_event=log_app_event)` runs `log_app_event` wherever `expand` calls
    `log_event`)."""
    found = []
    resolve = _resolver(definition, index)
    pending = deque(_facts(definition).calls)
    seen: set[int] = set()
    while pending:
        node, in_loop = pending.popleft()
        if id(node) in seen:
            continue
        seen.add(id(node))
        targets = resolve(node.func, call=node)
        found.extend((target, in_loop, node.lineno, node) for target in targets)
        _, name = _call_name(node)
        position = SYNCHRONOUS_DISPATCH.get(name)
        dispatched = _context_run_target(node.args, position) if position is not None and len(node.args) > position else None
        submit = _awaited_submit(node)
        if submit is not None and submit.args:
            dispatched = _context_run_target(submit.args, 0)
        if dispatched is not None:
            found.extend((target, in_loop, node.lineno, node) for target in resolve(_callable_target(dispatched)))
        for argument in _invoked_arguments(node, targets, definition):
            if isinstance(argument, ast.Lambda):
                pending.extend((call, in_loop) for call in _lambda_calls(argument))
            else:
                found.extend((target, in_loop, node.lineno, node) for target in resolve(_callable_target(argument)))
    return found


def _loop_calls(definition: Definition, index: Index) -> list[tuple[ast.Call, list[Definition]]]:
    """Calls that run on the caller's thread, each with the definitions it runs.

    A callable handed to a thread (`run_in_threadpool`, `asyncio.to_thread`,
    `anyio.to_thread.run_sync`, `loop.run_in_executor`, `executor.submit`) runs
    elsewhere: neither it nor a lambda passed with it is followed, unless
    `.result()` waits for the submitted work.
    """
    resolve = _resolver(definition, index)
    calls = [node for node, _ in _facts(definition).calls]
    waited = {id(submit): submit for node in calls if (submit := _awaited_submit(node)) is not None and submit.args}
    offloaded: set[int] = set()
    for node in calls:
        if _call_name(node)[1] in OFFLOADING_CALLS and id(node) not in waited:
            offloaded.add(id(node))
            for argument in [*node.args, *(keyword.value for keyword in node.keywords)]:
                if isinstance(argument, ast.Lambda):
                    offloaded.update(id(item) for item in ast.walk(argument.body) if isinstance(item, ast.Call))
    found = []
    for node in calls:
        if id(node) in offloaded:
            continue
        targets = resolve(node.func, call=node)
        # A callable argument the callee calls through its parameter
        # (`revert(config, load_keys=load_ignored_keys)`) runs here too.
        for target in list(targets):
            for parameter in _called_parameters(target):
                argument = _argument_for(node, target, parameter)
                if argument is not None:
                    targets.extend(resolve(_callable_target(argument)))
        found.append((node, targets))
    found.extend((submit, resolve(_callable_target(_context_run_target(submit.args, 0)))) for submit in waited.values())
    return found


def _directly_called_parameters(definition: Definition) -> set[str]:
    parameters = set(_parameter_names(definition))
    return {node.func.id for node, _ in _facts(definition).calls if isinstance(node.func, ast.Name) and node.func.id in parameters}


def _called_parameters(definition: Definition) -> set[str]:
    """Parameters the definition calls, itself or through a helper it passes
    them to (`outer(action)` handing `action` to `inner`, which calls it)."""
    found = _CALLED_PARAMETERS.get(id(definition.node))
    return found if found is not None else _directly_called_parameters(definition)


def _compute_called_parameters(modules: list[Module], index: Index) -> None:
    """`_called_parameters` for every definition, to a fixpoint."""
    definitions = list(_all_definitions(modules))
    called = {id(definition.node): _directly_called_parameters(definition) for definition in definitions}
    changed = True
    while changed:
        changed = False
        for definition in definitions:
            parameters = set(_parameter_names(definition))
            own = called[id(definition.node)]
            resolve = _resolver(definition, index)
            for node, _ in _facts(definition).calls:
                for target in resolve(node.func, call=node):
                    for parameter in called.get(id(target.node), ()):
                        argument = _argument_for(node, target, parameter)
                        if isinstance(argument, ast.Name) and argument.id in parameters and argument.id not in own:
                            own.add(argument.id)
                            changed = True
    _CALLED_PARAMETERS.update(called)


def _awaited_call_ids(definition: Definition) -> set[int]:
    pending = list(ast.iter_child_nodes(definition.node))
    awaited = set()
    while pending:
        node = pending.pop()
        if isinstance(node, NESTED_SCOPES):
            continue
        if isinstance(node, ast.Await) and isinstance(node.value, ast.Call):
            awaited.add(id(node.value))
        pending.extend(ast.iter_child_nodes(node))
    return awaited


class EventLoopAnalysis:
    """Blocking work an `async def` runs on the event loop (BI-08).

    Uvicorn runs every `async def` route, websocket and middleware on the one
    event-loop thread, so a synchronous call made there (not awaited and not
    handed to a thread) stalls every other request until it returns. The chain
    of such calls is followed through sync helpers to a blocking operation: a
    database connection or DB-API call, filesystem or media I/O (changes
    included), a subprocess, `time.sleep` or a wait on a thread, event, queue
    or future, synchronous HTTP, a PIL image open, or registered library-scale
    work. A coroutine called from the chain runs on the loop too
    and is followed as part of it.
    """

    def __init__(self, index: Index, library_scale: set[str]):
        self.index = index
        self.library_scale = library_scale
        self._witnesses: dict[int, tuple[str, str, str, int, list[str]] | None] = {}

    def _direct_operation(self, definition: Definition) -> tuple[str, str, int] | None:
        if definition.key in self.library_scale:
            return "library-scale", definition.key, definition.node.lineno
        module = self.index.modules[definition.module]
        blocking = [
            (*found, node.lineno) for node, _ in _facts(definition).calls
            if (found := _blocking_operation(node, module, definition)) is not None
        ]
        blocking += [("wait", operation, line) for operation, line in _lock_waits(definition, module)]
        return min(blocking, key=lambda item: item[2]) if blocking else None

    def witness(self, start: Definition) -> tuple[str, str, str, int, list[str]] | None:
        """The nearest blocking operation a synchronous call of `start` runs:
        (family, operation, path, line, chain of definitions after `start`)."""
        if id(start.node) in self._witnesses:
            return self._witnesses[id(start.node)]
        queue = deque([(start, [])])
        seen = {id(start.node)}
        found = None
        while queue:
            current, via = queue.popleft()
            direct = self._direct_operation(current)
            if direct is not None:
                found = (direct[0], direct[1], current.path, direct[2], via)
                break
            for _, targets in _loop_calls(current, self.index):
                for target in targets:
                    if isinstance(target.node, ast.AsyncFunctionDef) or id(target.node) in seen:
                        continue
                    seen.add(id(target.node))
                    queue.append((target, [*via, target.qualname]))
        self._witnesses[id(start.node)] = found
        return found

    def find_locks_held_across_io(self, modules: list[Module]) -> None:
        """Records each thread lock some `with lock:` body holds across
        blocking work (I/O, or taking another such lock; not waiting on an
        event or condition, which releases nothing it holds): taking that
        lock may wait for the whole I/O. Repeated until no new lock is found,
        since holding one such lock while taking another holds across it too."""
        definitions = list(_all_definitions(modules))
        while True:
            self._witnesses.clear()
            found = False
            for definition in definitions:
                module = self.index.modules[definition.module]
                resolve = _resolver(definition, self.index)
                for statement, _kind, key in _lock_blocks(definition, module):
                    if key is None or key in _LOCKS_HELD_ACROSS_IO:
                        continue
                    witness = self._held_work(statement, definition, module, resolve)
                    if witness is not None:
                        _LOCKS_HELD_ACROSS_IO[key] = witness
                        found = True
            if not found:
                self._witnesses.clear()
                return

    def _held_work(self, statement: ast.With, definition: Definition, module: Module, resolve) -> str | None:
        calls = []
        pending = list(statement.body)
        while pending:
            node = pending.pop()
            if isinstance(node, (*NESTED_SCOPES, ast.Lambda)):
                continue
            if isinstance(node, ast.Call):
                calls.append(node)
            pending.extend(ast.iter_child_nodes(node))
        for node in sorted(calls, key=lambda item: (item.lineno, item.col_offset)):
            direct = _blocking_operation(node, module, definition)
            if direct is not None and (direct[0] != "wait" or direct[1].endswith(".acquire")):
                return f"{direct[1]}@{definition.path}:{node.lineno}"
            for target in resolve(node.func, call=node):
                if isinstance(target.node, ast.AsyncFunctionDef):
                    continue
                witness = self.witness(target)
                if witness is not None and (witness[0] != "wait" or witness[1].endswith(".acquire")):
                    return f"{witness[1]}@{witness[2]}:{witness[3]}"
        return None

    def hazards(self, entry: dict[str, object], root: Definition) -> list[dict[str, object]]:
        if not isinstance(root.node, ast.AsyncFunctionDef):
            return []
        found = []
        queue = deque([(root, [])])
        seen = {id(root.node)}
        while queue:
            current, via = queue.popleft()
            awaited = _awaited_call_ids(current)
            module = self.index.modules[current.module]
            # `with lock:` on a thread lock waits on the loop thread itself.
            for operation, line in _lock_waits(current, module):
                found.append({
                    "rule": "BI-08",
                    "operation": f"event-loop-blocking:wait:{operation}@{current.path}:{line}",
                    "path": current.path,
                    "function": current.qualname,
                    "line": line,
                    "entrypoint": entry["key"],
                    "depth": "indirect" if via else "direct",
                    "via": list(via),
                    "reject": True,
                })
            for node, targets in _loop_calls(current, self.index):
                blocking = []
                if id(node) not in awaited and (direct := _blocking_operation(node, module, current)) is not None:
                    blocking.append((*direct, current.path, node.lineno, []))
                for target in targets:
                    if isinstance(target.node, ast.AsyncFunctionDef):
                        if id(target.node) not in seen:
                            seen.add(id(target.node))
                            queue.append((target, [*via, target.qualname]))
                    elif (witness := self.witness(target)) is not None:
                        family, operation, path, line, chain = witness
                        blocking.append((family, operation, path, line, [target.qualname, *chain]))
                for family, operation, path, line, chain in blocking[:1]:
                    found.append({
                        "rule": "BI-08",
                        "operation": f"event-loop-blocking:{family}:{operation}@{path}:{line}",
                        "path": current.path,
                        "function": current.qualname,
                        "line": node.lineno,
                        "entrypoint": entry["key"],
                        "depth": "indirect" if via or chain else "direct",
                        "via": [*via, *chain],
                        "reject": True,
                    })
        return found


def _all_definitions(modules: list[Module]):
    """Every function and method, nested definitions included."""
    pending = [
        definition
        for module in modules
        for definition in [*module.functions.values(), *(item for methods in module.methods.values() for item in methods.values())]
    ]
    while pending:
        definition = pending.pop()
        yield definition
        pending.extend(_facts(definition).nested.values())


def _parameter_names(definition: Definition) -> list[str]:
    arguments = definition.node.args
    return [argument.arg for argument in [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs]]


def _argument_for(node: ast.Call, definition: Definition, parameter: str) -> ast.AST | None:
    """The argument a call passes for one parameter of the called definition."""
    for keyword in node.keywords:
        if keyword.arg == parameter:
            return keyword.value
    names = _parameter_names(definition)
    positional = [*definition.node.args.posonlyargs, *definition.node.args.args]
    # `self.method(x)` and `cls.method(x)` bind the receiver to the first parameter.
    offset = 1 if definition.class_name and positional and positional[0].arg in {"self", "cls"} and isinstance(node.func, ast.Attribute) else 0
    position = names.index(parameter) - offset if parameter in names[: len(positional)] else -1
    if 0 <= position < len(node.args) and not any(isinstance(arg, ast.Starred) for arg in node.args[: position + 1]):
        return node.args[position]
    return None


def _bound_arguments(node: ast.Call, definition: Definition) -> list[tuple[str, ast.AST]]:
    """(parameter, argument) for each argument a call binds; a keyword the
    definition does not name lands in its `**kwargs` as `**<keyword>`."""
    names = _parameter_names(definition)
    bound = [(name, argument) for name in names if (argument := _argument_for(node, definition, name)) is not None]
    if definition.node.args.kwarg is not None:
        bound.extend((f"**{item.arg}", item.value) for item in node.keywords if item.arg is not None and item.arg not in names)
    return bound


def _launcher_parameters(modules: list[Module], index: Index) -> dict[int, dict[str, str]]:
    """Helpers that launch one of their own parameters in the background
    (`_queue(config, key, action)` submitting `action` to an executor), to a
    fixpoint: a helper that passes its parameter to another launcher launches it
    too. Maps each helper's node id to {parameter: trigger}."""
    definitions = list(_all_definitions(modules))
    launchers: dict[int, dict[str, str]] = {}
    changed = True
    while changed:
        changed = False
        for definition in definitions:
            parameters = set(_parameter_names(definition))
            facts = _facts(definition)
            resolve = _resolver(definition, index)
            awaited = {id(submit) for node, _ in facts.calls if (submit := _awaited_submit(node)) is not None}
            for node, _ in facts.calls:
                handed: list[tuple[str, ast.AST]] = []
                launched = None if id(node) in awaited else _launched_callable(node)
                if launched is not None:
                    handed.append(launched)
                for callee in resolve(node.func, call=node):
                    for parameter, trigger in launchers.get(id(callee.node), {}).items():
                        argument = _argument_for(node, callee, parameter)
                        if argument is not None:
                            handed.append((trigger, argument))
                for trigger, argument in handed:
                    if isinstance(argument, ast.Name) and argument.id in parameters:
                        own = launchers.setdefault(id(definition.node), {})
                        if argument.id not in own:
                            own[argument.id] = trigger
                            changed = True
    return launchers


def _launched_entrypoints(module: Module, index: Index, launchers: dict[int, dict[str, str]]) -> list[tuple[str, Definition]]:
    """Background entrypoints found by how they start: thread and executor
    targets, including a lambda, `partial`, or function passed to a helper that
    launches that parameter."""
    found = []
    for definition in _all_definitions([module]):
        facts = _facts(definition)
        resolve = _resolver(definition, index)
        awaited = {id(submit) for node, _ in facts.calls if (submit := _awaited_submit(node)) is not None}
        for node, _ in facts.calls:
            launched = None if id(node) in awaited else _launched_callable(node)
            handed = [launched] if launched is not None else []
            for callee in resolve(node.func, call=node):
                for parameter, trigger in launchers.get(id(callee.node), {}).items():
                    argument = _argument_for(node, callee, parameter)
                    if argument is not None:
                        handed.append((trigger, argument))
            for trigger, target in handed:
                found.extend((trigger, callee) for callee in resolve(_callable_target(target)))
    return found


def _route_triggers(node: ast.AST) -> list[str]:
    triggers = []
    for decorator in getattr(node, "decorator_list", []):
        if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
            continue
        method = decorator.func.attr
        if not decorator.args or not isinstance(decorator.args[0], ast.Constant) or not isinstance(decorator.args[0].value, str):
            continue
        route = decorator.args[0].value
        if method in ROUTE_METHODS:
            triggers.append(f"{method.upper()} {route}")
        elif method == "websocket":
            triggers.append(f"WEBSOCKET {route}")
        elif method == "middleware":
            triggers.append(f"MIDDLEWARE {route}")
        elif method == "api_route":
            methods = ["GET"]
            for keyword in decorator.keywords:
                if keyword.arg == "methods" and isinstance(keyword.value, (ast.List, ast.Tuple)):
                    methods = [str(item.value) for item in keyword.value.elts if isinstance(item, ast.Constant)]
            triggers.append(f"{'|'.join(methods)} {route}")
    return triggers


def _background_kind(name: str) -> str | None:
    lowered = name.lower()
    for term, kind in BACKGROUND_TERMS:
        if term in lowered:
            return kind
    return None


def _middleware_class_triggers(definition: Definition, module: Module) -> list[str]:
    """`dispatch` of a `BaseHTTPMiddleware` subclass, or an ASGI middleware's
    `async def __call__(self, scope, receive, send)`."""
    if not definition.class_name or not isinstance(definition.node, ast.AsyncFunctionDef):
        return []
    name = definition.node.name
    if name == "__call__" and _parameter_names(definition)[1:4] == ["scope", "receive", "send"]:
        return ["MIDDLEWARE asgi"]
    if name == "dispatch":
        bases = module.class_bases.get(definition.class_name, [])
        if "BaseHTTPMiddleware" in bases:
            return ["MIDDLEWARE dispatch"]
    return []


def _entrypoints(module: Module) -> list[tuple[dict[str, object], Definition]]:
    """Decorated routes, websockets and middleware at any nesting (an app
    factory installs them as closures), and, in route and service modules,
    background owners found by name among top-level functions and methods."""
    found = []
    top_level = {
        id(definition.node)
        for definition in [*module.functions.values(), *(item for methods in module.methods.values() for item in methods.values())]
    }
    for definition in _all_definitions([module]):
        node = definition.node
        triggers = [*_route_triggers(node), *_middleware_class_triggers(definition, module)]
        for trigger in triggers:
            kind = "middleware" if trigger.startswith("MIDDLEWARE ") else "route"
            found.append((_entry(definition, kind, trigger, node.lineno), definition))
        if triggers or id(node) not in top_level or not module.path.startswith(ENTRYPOINT_ROOTS):
            continue
        kind = _background_kind(node.name)
        if kind is None:
            continue
        if _facts(definition).has_while:
            found.append((_entry(definition, "background", "while", node.lineno), definition))
        else:
            found.append((_entry(definition, kind, "name", node.lineno), definition))
    return found


def _all_entrypoints(modules: list[Module], index: Index) -> list[tuple[dict[str, object], Definition]]:
    """Routes and name-matched background owners, plus any thread or executor
    target not already discovered under its own name."""
    found = [item for module in modules if module.path.startswith(DECORATED_ENTRYPOINT_ROOTS) for item in _entrypoints(module)]
    known = {id(definition.node) for _, definition in found}
    launchers = _launcher_parameters(modules, index)
    for module in modules:
        for trigger, definition in _launched_entrypoints(module, index, launchers):
            if id(definition.node) in known:
                continue
            known.add(id(definition.node))
            found.append((_entry(definition, "background", trigger, definition.node.lineno), definition))
    return found


def _entry(definition: Definition, kind: str, trigger: str, line: int) -> dict[str, object]:
    return {
        "key": f"{definition.key}:{kind}:{trigger}",
        "language": "python",
        "path": definition.path,
        "owner": definition.qualname,
        "kind": kind,
        "trigger": trigger,
        "line": line,
    }


def load_modules(root: Path, overrides: dict[str, str] | None = None) -> list[Module]:
    overrides = overrides or {}
    return [
        _load_module(path, relative, overrides)
        for path, relative in _iter_python_files(root, SCAN_ROOT)
    ]


def _semantic_digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def discover_cover_connection_contracts(modules: list[Module], index: Index) -> list[dict]:
    """Closed source guards for the three reviewed cover connection families."""
    by_path = {module.path: module for module in modules}
    prefix = "music_app/services/"
    scan, cache, execution, pools, mutations = [prefix + name + ".py" for name in
        ("scan_cache_persistence", "cache", "cover_refresh_execution", "postgres_connections", "cover_mutations_postgres")]

    def require(condition):
        if not condition:
            raise ValueError("unmatched-cover-source-guard")

    def one(nodes):
        values = list(nodes)
        require(len(values) == 1)
        return values[0]

    def definition(path, name):
        module = by_path.get(path)
        require(module is not None and module.tree is not None)
        if "." in name:
            cls, method = name.split(".", 1)
            value = module.methods.get(cls, {}).get(method)
        else:
            value = module.functions.get(name)
        require(value is not None)
        return value

    def expression(node, source):
        return ast.dump(node, include_attributes=False) == ast.dump(ast.parse(source, mode="eval").body, include_attributes=False)

    def statements(nodes, source):
        return ast.dump(ast.Module(body=nodes, type_ignores=[]), include_attributes=False) == ast.dump(ast.parse(source), include_attributes=False)

    def calls(owner, name):
        return [node for node in ast.walk(owner.node) if isinstance(node, ast.Call) and
                (isinstance(node.func, ast.Name) and node.func.id == name or isinstance(node.func, ast.Attribute) and node.func.attr == name)]

    def anchor(anchors, role, owner, node):
        pending = [(owner.node, [])]
        while pending:
            current, path = pending.pop()
            if current is node:
                anchors.append({"role": role, "site": {"owner": owner.key, "astPath": path}})
                return
            for name, value in ast.iter_fields(current):
                if isinstance(value, ast.AST):
                    pending.append((value, [*path, name]))
                elif isinstance(value, list):
                    pending.extend((child, [*path, name, position]) for position, child in enumerate(value) if isinstance(child, ast.AST))
        raise ValueError("unowned-cover-source-site")

    def cleanup(anchors):
        factory = definition(scan, "shared_scan_cache_connection")
        require(_body_matches(factory.node, _SHARED_FACTORY_BODY))
        final = one(node for node in factory.node.body if isinstance(node, ast.Try))
        require(statements(final.finalbody, "_SHARED_CONNECTION.reset(token)\nshared.close()"))
        anchor(anchors, "scope-cleanup", factory, final)

    def mutation_guards(anchors):
        expected = [(cache, "execute_cover_mutation_for_config", "cache-injection"),
                    (execution, "_recover_existing_cover_selection", "recovery-injection"),
                    (execution, "_build_automatic_cover_write_guard", "automatic-injection")]
        known_calls = []
        for path, name, role in expected:
            owner = definition(path, name)
            call = one(calls(owner, "PostgresCoverMutationRepository"))
            keywords = {item.arg: item.value for item in call.keywords}
            require(not call.args and len(keywords) == len(call.keywords) and set(keywords) == {"database_url", "connect_to_database"})
            require(expression(keywords["connect_to_database"], "scan_cache_transaction"))
            url = "database_url" if path == cache else 'str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()'
            require(expression(keywords["database_url"], url))
            known_calls.append(call)
            anchor(anchors, role, owner, call)
        # There is no fourth authority construction/alias inside these owners.
        for path in (cache, execution):
            for node in ast.walk(by_path[path].tree):
                if isinstance(node, ast.Call) and (isinstance(node.func, ast.Name) and node.func.id == "PostgresCoverMutationRepository" or isinstance(node.func, ast.Attribute) and node.func.attr == "PostgresCoverMutationRepository"):
                    require(node in known_calls)
        cache_owner = definition(cache, "execute_cover_mutation_for_config")
        url_assignment = one(node for node in cache_owner.node.body if isinstance(node, ast.Assign) and
                             len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "database_url")
        require(expression(url_assignment.value, 'str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()'))
        scope = definition(scan, "scan_cache_transaction")
        branch = one(node for node in scope.node.body if isinstance(node, ast.If) and isinstance(node.test, ast.BoolOp))
        require(expression(branch.test, "shared is not None and shared.database_url == database_url"))
        require(statements(branch.body, "with shared.transaction() as connection:\n    yield connection"))
        anchor(anchors, "matching-dsn", scope, branch)
        runner = definition(execution, "run_cover_jobs")
        scoped = one(node for node in runner.node.body if isinstance(node, ast.With))
        require(len(scoped.items) == 1 and expression(scoped.items[0].context_expr, "shared_scan_cache_connection(config)"))
        require(len(scoped.body) == 1 and isinstance(scoped.body[0], ast.Return) and isinstance(scoped.body[0].value, ast.Call) and expression(scoped.body[0].value.func, "_run_cover_jobs"))
        require(all(node is scoped or isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str) for node in runner.node.body))
        forwarded = [item.value for item in scoped.body[0].value.keywords if item.arg == "config"]
        require(len(forwarded) == 1 and expression(forwarded[0], "config") and all(item.arg is not None for item in scoped.body[0].value.keywords))
        require(not any(isinstance(node, ast.Name) and node.id == "config" and isinstance(node.ctx, (ast.Store, ast.Del)) for node in ast.walk(runner.node)))
        anchor(anchors, "run-scope", runner, scoped)
        worker = definition(execution, "_run_cover_jobs")
        submit = one(node for node in calls(worker, "submit") if node.args and expression(node.args[0], "contextvars.copy_context().run"))
        require(len(submit.args) >= 2 and expression(submit.args[1], "execute_cover_job"))
        anchor(anchors, "copied-worker-context", worker, submit)
        cleanup(anchors)

    def lazy_guards(anchors):
        require(index.shared_connection_binding()["status"] == "resolved")
        factory = definition(scan, "shared_scan_cache_connection")
        anchor(anchors, "sealed-constructor", factory, one(calls(factory, "_SharedConnection")))
        constructor = definition(scan, "_SharedConnection.__init__")
        field = one(node for node in constructor.node.body if isinstance(node, ast.Assign) and
                    any(isinstance(target, ast.Attribute) and target.attr == "_connect" for target in node.targets))
        anchor(anchors, "field-assignment", constructor, field)
        require(any(isinstance(node, ast.Assign) and statements([node], "self._lock = threading.Lock()") for node in constructor.node.body))
        initial = one(node for node in constructor.node.body if isinstance(node, (ast.Assign, ast.AnnAssign)) and
                      any(isinstance(target, ast.Attribute) and target.attr == "_connection" for target in _binding_targets(node)))
        require(isinstance(initial.value, ast.Constant) and initial.value.value is None)
        transaction = definition(scan, "_SharedConnection.transaction")
        locked = one(node for node in transaction.node.body if isinstance(node, ast.With))
        require(len(locked.items) == 1 and expression(locked.items[0].context_expr, "self._lock"))
        branch = one(node for node in locked.body if isinstance(node, ast.If))
        require(expression(branch.test, "self._connection is None") and not branch.orelse)
        require(statements(branch.body, "self._connection = self._connect()"))
        stores = [node for node in ast.walk(transaction.node) if isinstance(node, ast.Attribute) and node.attr == "_connection" and isinstance(node.ctx, (ast.Store, ast.Del))]
        require(len(stores) == 1 and stores[0] is branch.body[0].targets[0])
        initializer = one(calls(transaction, "_connect"))
        anchor(anchors, "lazy-guard", transaction, branch)
        anchor(anchors, "initializer", transaction, initializer)
        anchor(anchors, "transaction-lock", transaction, locked)
        close = definition(scan, "_SharedConnection.close")
        require(statements(close.node.body, "with self._lock:\n    if self._connection is not None:\n        self._discard()"))
        discard = definition(scan, "_SharedConnection._discard")
        require(statements(discard.node.body, "connection, self._connection = self._connection, None\ntry:\n    connection.close()\nexcept Exception:\n    pass"))
        allowed_stores = {id(node) for owner in (constructor, transaction, discard) for node in ast.walk(owner.node)
                          if isinstance(node, ast.Attribute) and node.attr == "_connection" and isinstance(node.ctx, ast.Store)}
        shared_class = one(node for node in by_path[scan].tree.body if isinstance(node, ast.ClassDef) and node.name == "_SharedConnection")
        require(all(id(node) in allowed_stores for node in ast.walk(shared_class) if isinstance(node, ast.Attribute) and node.attr == "_connection" and isinstance(node.ctx, (ast.Store, ast.Del))))
        cleanup(anchors)

    def pool_guards(anchors):
        owner = definition(pools, "cover_lock_connection")
        pool_module = by_path[pools]
        require([arg.arg for arg in owner.node.args.args] == ["database_url"] and not owner.node.args.posonlyargs and not owner.node.args.defaults and not owner.node.args.kwonlyargs and not owner.node.args.vararg and not owner.node.args.kwarg)
        require([ast.dump(node, include_attributes=False) for node in owner.node.decorator_list] == [ast.dump(ast.Name(id="contextmanager", ctx=ast.Load()), include_attributes=False)] and pool_module.imports.get("contextmanager") == ("contextlib", "contextmanager") and "contextmanager" not in pool_module.assignments)
        require(_body_matches(owner.node, '''if not isinstance(database_url, str) or not database_url.strip():
    raise RuntimeError("Postgres configuration required.")
if ConnectionPool is None:
    raise RuntimeError("psycopg pool support required; install requirements.")
pool_key = ("dedicated", database_url, "cover-lock")
with _lock:
    pool = _pools.get(pool_key)
    if pool is None:
        pool = ConnectionPool(conninfo=database_url, min_size=0, max_size=4, max_waiting=32, timeout=30, max_idle=120, max_lifetime=600, kwargs={"autocommit": True}, open=True)
        _pools[pool_key] = pool
with ExitStack() as stack:
    try:
        connection = stack.enter_context(pool.connection())
    except PoolTimeout as exc:
        raise RuntimeError("Postgres connection pool exhausted.") from exc
    yield connection'''))
        imports = one(node for node in pool_module.tree.body if isinstance(node, ast.Try) and
                      any(isinstance(child, ast.ImportFrom) and child.module == "psycopg_pool" for child in node.body))
        require(statements([imports], '''try:
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool, PoolTimeout
except ImportError:
    ConnectionPool = None
    PoolTimeout = TimeoutError
    dict_row = None'''))
        fallback = imports.handlers[0].body[0].targets[0]
        pool_parents = {id(child): parent for parent in ast.walk(pool_module.tree) for child in ast.iter_child_nodes(parent)}
        for node in ast.walk(pool_module.tree):
            if isinstance(node, ast.Name) and node.id == "ConnectionPool" and isinstance(node.ctx, (ast.Store, ast.Del)):
                require(node is fallback)
            if isinstance(node, ast.Name) and node.id == "ConnectionPool" and isinstance(node.ctx, ast.Load):
                parent = pool_parents[id(node)]
                require(isinstance(parent, ast.Call) and parent.func is node or isinstance(parent, ast.Compare) and parent.left is node and len(parent.ops) == 1 and isinstance(parent.ops[0], ast.Is) and len(parent.comparators) == 1 and isinstance(parent.comparators[0], ast.Constant) and parent.comparators[0].value is None)
            if isinstance(node, (ast.Import, ast.ImportFrom)) and any((alias.asname or alias.name.split('.')[0]) == "ConnectionPool" for alias in node.names):
                require(node is imports.body[1])
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == "ConnectionPool":
                require(False)
        for name, source in (("_pools", "{}"), ("_lock", "Lock()")):
            assignment = one(node for node in pool_module.tree.body if isinstance(node, ast.Assign) and
                             len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == name)
            require(expression(assignment.value, source))
            require(sum(isinstance(node, ast.Name) and node.id == name and isinstance(node.ctx, (ast.Store, ast.Del)) for node in ast.walk(pool_module.tree)) == 1)
            if name == "_lock":
                lock_initializer = assignment.value.func
        lock_imports = [node for node in ast.walk(pool_module.tree) if isinstance(node, (ast.Import, ast.ImportFrom)) and
                        any((alias.asname or alias.name.split('.')[0]) == "Lock" for alias in node.names)]
        require(len(lock_imports) == 1 and lock_imports[0] in pool_module.tree.body and
                statements(lock_imports, "from threading import Lock") and pool_module.imports.get("Lock") == ("threading", "Lock"))
        require(not any(isinstance(node, ast.Name) and node.id == "Lock" and node is not lock_initializer or
                        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == "Lock" for node in ast.walk(pool_module.tree)))
        key = one(node for node in owner.node.body if isinstance(node, ast.Assign) and
                  len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "pool_key")
        require(expression(key.value, '("dedicated", database_url, "cover-lock")'))
        locked = one(node for node in owner.node.body if isinstance(node, ast.With) and len(node.items) == 1 and expression(node.items[0].context_expr, "_lock"))
        lookup = one(node for node in locked.body if isinstance(node, ast.Assign))
        require(statements([lookup], "pool = _pools.get(pool_key)"))
        branch = one(node for node in locked.body if isinstance(node, ast.If))
        require(expression(branch.test, "pool is None") and not branch.orelse and len(branch.body) == 2)
        require(isinstance(branch.body[0], ast.Assign) and len(branch.body[0].targets) == 1 and isinstance(branch.body[0].targets[0], ast.Name) and branch.body[0].targets[0].id == "pool")
        initializer = branch.body[0].value
        require(expression(initializer, 'ConnectionPool(conninfo=database_url,min_size=0,max_size=4,max_waiting=32,timeout=30,max_idle=120,max_lifetime=600,kwargs={"autocommit":True},open=True)'))
        require(calls(owner, "ConnectionPool") == [initializer])
        require(sum(isinstance(node, ast.Name) and node.id == "pool" and isinstance(node.ctx, ast.Store) for node in ast.walk(owner.node)) == 2)
        require(statements([branch.body[1]], "_pools[pool_key] = pool"))
        require(len(locked.body) == 2)
        require(sum(isinstance(node, ast.Name) and node.id == "pool_key" and isinstance(node.ctx, (ast.Store, ast.Del)) for node in ast.walk(owner.node)) == 1)
        cache_uses = {id(lookup.value.func.value), id(branch.body[1].targets[0].value)}
        require(all(id(node) in cache_uses for node in ast.walk(owner.node) if isinstance(node, ast.Name) and node.id == "_pools"))
        close = definition(pools, "close_pools")
        require(statements(close.node.body, "with _lock:\n    pools = list(_pools.values())\n    _pools.clear()\nfor pool in pools:\n    pool.close()"))
        require(sum(isinstance(node, ast.Call) and expression(node, "atexit.register(close_pools)") for node in ast.walk(by_path[pools].tree)) == 1)
        for role, node in (("cache-key", key), ("cache-lookup", lookup), ("cache-guard", branch),
                           ("initializer", initializer), ("cache-store", branch.body[1]), ("cache-lock", locked)):
            anchor(anchors, role, owner, node)
        anchor(anchors, "pool-cleanup", close, close.node.body[0])

    contracts = []
    for family, paths, check in (
        ("cover-mutation-shared-transaction", [cache, execution, scan, mutations], mutation_guards),
        ("shared-adapter-lazy-initializer", [scan], lazy_guards),
        ("cover-advisory-lock-pool-initializer", [pools], pool_guards),
    ):
        anchors = []
        sources = [{"path": path, "astFingerprint": hashlib.sha256(ast.dump(by_path[path].tree, include_attributes=False).encode()).hexdigest()
                    if path in by_path and by_path[path].tree is not None else None} for path in sorted(paths)]
        try:
            require(all(source["astFingerprint"] for source in sources))
            check(anchors)
            status = "matched"
        except ValueError:
            status = "rejected"
        contract = {"schemaVersion": 1, "id": family + "/v1", "status": status,
                    "sources": sources, "anchors": sorted(anchors, key=lambda anchor: anchor["role"])}
        contract["fingerprint"] = _semantic_digest(contract)
        contracts.append(contract)
    return contracts


def analyze_python_repository(
    root: Path,
    *,
    library_scale_operations: list[str] | tuple[str, ...] = (),
    library_state_collections: list[str] | tuple[str, ...] = (),
    overrides: dict[str, str] | None = None,
) -> dict[str, object]:
    _FACTS.clear()
    _OWN_NODES.clear()
    _PARENTS.clear()
    _MODULES.clear()
    _CALLED_PARAMETERS.clear()
    _LOCKS_HELD_ACROSS_IO.clear()
    modules = load_modules(root, overrides)
    index = Index(modules)
    _MODULES.update(index.modules)
    _compute_called_parameters(modules, index)
    library_scale = set(library_scale_operations)
    collections = set(library_state_collections)
    entrypoints: list[dict[str, object]] = []
    hazards: list[dict[str, object]] = []
    hazard_cache: dict[tuple[int, bool], list[dict[str, object]]] = {}
    callee_cache: dict[int, list[tuple[Definition, bool, int, ast.Call]]] = {}
    scan_cache: dict[tuple[int, frozenset[str] | None], dict[int, tuple[str, int, ast.AST]]] = {}
    event_loop = EventLoopAnalysis(index, library_scale)
    event_loop.find_locks_held_across_io(modules)
    library_state = LibraryStateEvidence(modules, index, collections)
    source_fingerprints = {}
    connection_graphs = []
    site_cache = {}

    def semantic_site(owner: Definition, node: ast.AST) -> dict[str, object]:
        if id(owner.node) not in site_cache:
            paths = {}

            def collect(current, address):
                paths[id(current)] = address
                for name, value in ast.iter_fields(current):
                    if isinstance(value, ast.AST):
                        collect(value, [*address, name])
                    elif isinstance(value, list):
                        for position, child in enumerate(value):
                            if isinstance(child, ast.AST):
                                collect(child, [*address, name, position])

            collect(owner.node, [])
            site_cache[id(owner.node)] = paths
        return {"owner": owner.key, "astPath": site_cache[id(owner.node)][id(node)]}

    for entry, definition in _all_entrypoints(modules, index):
        entrypoints.append(entry)
        interactive = entry["kind"] in {"route", "middleware"}
        hazards.extend(event_loop.hazards(entry, definition))
        queue = deque([(definition, [], None, None, None)])
        seen = set()
        graph_nodes, graph_edges, graph_sinks = {}, {}, {}

        def state_node(current, loop, scan, bound):
            state = {"owner": current.key, "loop": loop[3] if loop else None,
                     "scan": {"collection": scan[0], **scan[4]} if scan else None,
                     "bound": sorted(bound) if bound is not None else None}
            node_id = _semantic_digest(state)
            graph_nodes[node_id] = {"id": node_id, **state}
            return node_id

        root_node = state_node(definition, None, None, None)
        reachable_sources = set()
        entry_hazards = []
        while queue:
            # `loop` is the call site (path, line, function), inside a loop
            # body, through which the current definition runs once per item
            # (None outside any loop). `scan` is the loop over a library-state
            # collection, (collection, path, line, function), that runs it
            # once per cached item.
            # `bound` is the parameters the followed call passed a library-state
            # collection for (None when that is not known).
            current, via, loop, scan, bound = queue.popleft()
            looped = loop is not None
            visit = state_node(current, loop, scan, bound)
            if visit in seen:
                continue
            seen.add(visit)
            reachable_sources.add(current.path)
            depth = "direct" if not via else "indirect"
            # A route never reaches library-scale work; a background entrypoint
            # may, but only under a contract proving its batching, coalescing,
            # and convergence.
            if current.key in library_scale:
                entry_hazards.append({
                    "rule": "BI-04",
                    "operation": f"library-scale:{current.key}",
                    "path": current.path,
                    "function": current.qualname,
                    "line": current.node.lineno,
                    "entrypoint": entry["key"],
                    "depth": depth,
                    "via": via,
                    "reject": interactive,
                })
                continue
            cache_key = (id(current.node), looped, bound)
            if cache_key not in hazard_cache:
                hazard_cache[cache_key] = [
                    *_direct_hazards(current, looped, index.modules[current.module], index),
                    *library_state.scans(current, bound),
                ]
            for hazard in hazard_cache[cache_key]:
                record = {key: value for key, value in hazard.items() if key not in {"enumeration", "per_item_connect", "_site_node"}}
                if hazard.get("per_item_connect"):
                    # Reported at the loop that repeats the connection: the
                    # place to load once and pass the result down.
                    loop_path, loop_line, loop_function = loop[:3] if loop else (hazard["path"], hazard["line"], hazard["function"])
                    sink_site = semantic_site(current, hazard["_site_node"])
                    sink = {"node": visit, "operation": hazard["operation"], "site": sink_site,
                            "loop": loop[3] if loop else sink_site}
                    sink_id = _semantic_digest(sink)
                    graph_sinks[sink_id] = {"id": sink_id, **sink}
                    record.update({
                        "graphId": entry["key"], "sinkId": sink_id,
                        "operation": f"{hazard['operation']}@{hazard['path']}:{hazard['line']}",
                        "path": loop_path,
                        "line": loop_line,
                        "function": loop_function,
                    })
                # A route rejects direct enumeration, and a connection opened per
                # item at any depth: one request must not open N connections.
                rejected = (depth == "direct" and bool(hazard["enumeration"])) or bool(hazard.get("per_item_connect"))
                entry_hazards.append({
                    **record,
                    "entrypoint": entry["key"],
                    "depth": depth,
                    "via": via,
                    "reject": interactive and rejected,
                })
            if (id(current.node), bound) not in scan_cache:
                scan_cache[(id(current.node), bound)] = library_state.scan_calls(current, bound)
            scanned = scan_cache[(id(current.node), bound)]

            def scan_of(call: ast.Call):
                local = scanned.get(id(call))
                return scan or (local and (local[0], current.path, local[1], current.qualname, semantic_site(current, local[2])))

            # Per-item I/O inside a scan of the whole library state: library-sized
            # I/O on one interaction. Reported at the scan, the place to bound;
            # the validator rejects it for a background entry whose registered
            # work class is narrower than background-batch, and a route needs a
            # contract for it like for any reachable hazard.
            module = index.modules[current.module]
            for node, _ in _facts(current).calls:
                site = scan_of(node)
                io = site and _blocking_operation(node, module, current)
                if io and io[0] in SCAN_IO_FAMILIES:
                    collection, scan_path, scan_line, scan_function = site[:4]
                    entry_hazards.append({
                        "rule": "BI-04",
                        "operation": f"library-state-scan-io:{collection}",
                        "witness": f"{io[1]}@{current.path}:{node.lineno}",
                        "path": scan_path,
                        "function": scan_function,
                        "line": scan_line,
                        "entrypoint": entry["key"],
                        "depth": depth,
                        "via": via,
                        "scanIo": True,
                        # Judged by the validator against the entry's work class.
                        "reject": False,
                    })
            if id(current.node) not in callee_cache:
                callee_cache[id(current.node)] = _callees(current, index)
            for callee, call_in_loop, line, call in callee_cache[id(current.node)]:
                call_site = semantic_site(current, call)
                callee_loop = loop or ((current.path, line, current.qualname, call_site) if call_in_loop else None)
                callee_bound = library_state.bound_collections(current, bound, call, callee)
                callee_scan = scan_of(call)
                edge = {"from": visit, "to": state_node(callee, callee_loop, callee_scan, callee_bound), "site": call_site}
                edge_id = _semantic_digest(edge)
                graph_edges[edge_id] = {"id": edge_id, **edge}
                # Retain every state edge before seen-state collapse. A merged
                # relay need not be expanded once per complete incoming path.
                queue.append((callee, [*via, callee.qualname], callee_loop, callee_scan, callee_bound))
        connection_hazards = [hazard for hazard in entry_hazards if hazard["rule"] == "BI-05"]
        if connection_hazards:
            # These bindings are precisely what this analyzer cannot infer.
            # Include their complete AST in the reviewed context identity.
            if entry["key"] in {
                "py:music_app/routes/api_wave_d_asgi_routes.py#utilities_fetch_cover:route:POST /utilities/fetch-cover",
                "py:music_app/routes/api_wave_d_asgi_routes.py#utilities_fetch_covers_unsuccessful:route:POST /utilities/fetch-covers-unsuccessful",
            }:
                reachable_sources.update({
                    "music_app/services/cache.py", "music_app/services/cover_refresh_execution.py",
                    "music_app/services/scan_cache_persistence.py", "music_app/services/cover_mutations_postgres.py",
                    "music_app/services/cover_refresh_runtime.py", "music_app/jobs/cover_handlers.py",
                    "scripts/run_jobs_worker.py",
                })
            for source in reachable_sources - source_fingerprints.keys():
                text = (overrides or {}).get(source)
                if text is None:
                    if not (root / source).is_file():
                        source_fingerprints[source] = None
                        continue
                    text = (root / source).read_text(encoding="utf-8-sig")
                source_fingerprints[source] = hashlib.sha256(ast.dump(ast.parse(text), include_attributes=False).encode()).hexdigest()
            graph = {"schemaVersion": 1, "id": entry["key"], "entrypoint": entry["key"], "root": root_node,
                     "nodes": [graph_nodes[key] for key in sorted(graph_nodes)],
                     "edges": [graph_edges[key] for key in sorted(graph_edges)],
                     "sinks": [graph_sinks[key] for key in sorted(graph_sinks)],
                     "sources": [{"path": source, "astFingerprint": source_fingerprints[source]} for source in sorted(reachable_sources)]}
            graph["fingerprint"] = _semantic_digest(graph)
            connection_graphs.append(graph)
        hazards.extend(entry_hazards)
    unique: dict[str, dict[str, object]] = {}
    for hazard in hazards:
        site = f"{hazard['path']}#{hazard['function']}"
        if hazard["rule"] == "BI-05":
            # Representative paths and diagnostic lines cannot erase a sink.
            hazard["key"] = f"{hazard['graphId']}:BI-05:{hazard['sinkId']}"
        else:
            hazard["key"] = f"{hazard['entrypoint']}:{hazard['rule']}:{hazard['operation']}@{site}"
        if hazard["rule"] == "BI-08":
            # Each blocking call site is its own fix.
            hazard["key"] += f":{hazard['line']}"
        unique.setdefault(hazard["key"], hazard)
    entrypoints.sort(key=lambda item: (item["key"], item["line"]))
    deduped: dict[str, dict[str, object]] = {}
    for item in entrypoints:
        deduped.setdefault(str(item["key"]), item)
    contract_fingerprints = {}
    for source in (
        "tests/py/test_cover_batch_bounded_contracts.py",
        "tests/py/test_cover_batch_bounded_contracts_postgres_live.py",
        "tests/py/bounded_interactions.py",
    ):
        text = (overrides or {}).get(source)
        if text is None and (root / source).is_file():
            text = (root / source).read_text(encoding="utf-8-sig")
        if text is not None:
            contract_fingerprints[source] = hashlib.sha256(ast.dump(ast.parse(text), include_attributes=False).encode()).hexdigest()
    return {
        "pythonSemanticsFingerprint": hashlib.sha256(ast.dump(ast.parse(Path(__file__).read_text(encoding="utf-8")), include_attributes=False).encode()).hexdigest(),
        "pythonContractFingerprints": contract_fingerprints,
        "coverConnectionContracts": discover_cover_connection_contracts(modules, index),
        "connectionGraphs": sorted(connection_graphs, key=lambda graph: graph["id"]),
        "entrypoints": list(deduped.values()),
        "hazards": sorted(unique.values(), key=lambda item: (item["key"], item["line"])),
    }


def discover_python_entrypoints(root: Path) -> list[dict[str, object]]:
    return analyze_python_repository(root)["entrypoints"]


def find_python_hazards(path: Path) -> list[dict[str, object]]:
    relative = path.name
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    hazards = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            hazards.extend(_direct_hazards(Definition(relative, node.name, node, ""), looped=True))
    return sorted(({key: value for key, value in hazard.items() if key != "_site_node"} for hazard in hazards), key=lambda item: item["line"])


def _registry_names(registry_path: Path | None, key: str, field: str) -> list[str]:
    if registry_path is None or not registry_path.exists():
        return []
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    return [str(item[field]) for item in registry.get(key, [])]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--analysis", action="store_true", help="print entrypoints and hazards as one JSON document")
    parser.add_argument("--overrides", type=Path, help="JSON object mapping repository paths to replacement source")
    args = parser.parse_args(argv)
    overrides = json.loads(args.overrides.read_text(encoding="utf-8")) if args.overrides else None
    try:
        analysis = analyze_python_repository(
            args.root,
            library_scale_operations=_registry_names(args.registry, "libraryScaleOperations", "operation"),
            library_state_collections=_registry_names(args.registry, "libraryStateCollections", "collection"),
            overrides=overrides,
        )
    except (OSError, SyntaxError, UnicodeDecodeError) as error:
        print(f"bounded interaction discovery failed: {error}", file=sys.stderr)
        return 1
    if args.analysis:
        json.dump(analysis, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
    else:
        for entry in analysis["entrypoints"]:
            print(json.dumps(entry, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
