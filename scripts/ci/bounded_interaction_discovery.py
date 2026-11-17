"""Static inventory of backend interaction entrypoints and reachable hazards.

Discovery proves coverage, not boundedness. Entrypoints are routes, background
owners found by name, and every thread or executor target. Direct filesystem
enumeration in an interactive entrypoint is rejected outright; filesystem/media
work reached through helpers is reported so the registry can demand a runtime
contract; any interactive path that reaches a registered library-scale
operation is rejected at any depth; an `async def` route, websocket or
middleware whose event-loop call chain reaches blocking I/O is rejected
(BI-08); and a database connection opened per loop item is rejected in an
interactive path and needs a contract elsewhere (BI-05).

The traversal is exhaustive: every (function, looped) pair reachable from an
entrypoint is analyzed once, so no call chain is left unexamined and no depth
limit is needed.
"""

from __future__ import annotations

import argparse
import ast
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
}
# DB-API calls on a connection, cursor or pool, counted in modules that import
# a database driver: the import is the evidence the receiver is one.
DATABASE_METHODS = frozenset({"execute", "executemany", "fetchone", "fetchall", "fetchmany", "getconn", "connection"})
DATABASE_DRIVERS = ("psycopg", "psycopg2", "psycopg_pool")
FILESYSTEM_WRITE_METHODS = {"write_text": "Path.write_text", "write_bytes": "Path.write_bytes"}
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
    class_bases: dict[str, list[str]] = field(default_factory=dict)


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
    module = Module(path=relative, name=_module_name(relative))
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


class Index:
    def __init__(self, modules: list[Module]):
        self.modules = {module.name: module for module in modules}
        self._local_types: dict[tuple[int, str], tuple[str, str] | None] = {}
        self.methods_by_name: dict[str, list[Definition]] = {}
        for module in modules:
            for methods in module.methods.values():
                for name, definition in methods.items():
                    if not name.startswith("__"):
                        self.methods_by_name.setdefault(name, []).append(definition)

    def module_function(self, module_name: str, name: str) -> Definition | None:
        module = self.modules.get(module_name)
        if module is None:
            return None
        if name in module.functions:
            return module.functions[name]
        imported = module.imports.get(name)
        if imported and imported[1] and imported[0] != module_name:
            return self.module_function(imported[0], imported[1])
        return None

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

    def receiver_class(self, value: ast.AST, owner: Definition) -> tuple[str, str] | None:
        """The app class a method call's receiver is an instance of (or is):
        a constructor call, a class, or a local or parameter whose every binding
        in the owner is a constructor call of, or an annotation naming, one class."""
        if isinstance(value, ast.Call):
            return self._type_ref(value.func, owner.module)
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
                local_types.add(self._type_ref(node.value.func, owner.module))
            elif isinstance(node, ast.AnnAssign):
                local_types.add(self._type_ref(node.annotation, owner.module))
            else:
                local_types.add(None)
        if local_types:
            return next(iter(local_types)) if len(local_types) == 1 else None
        return self._type_ref(value, owner.module)

    def resolve(self, call_target: ast.AST, owner: Definition) -> list[Definition]:
        """Definitions a call may run. A method call on a receiver that resolves
        to an app class runs that class's method. On an unknown receiver it may
        run any app method of that name; all candidates are followed, except
        that a builtin container name (CONTAINER_METHODS) or an ambiguous
        builtin protocol name (PROTOCOL_METHODS) is not."""
        module = self.modules[owner.module]
        if isinstance(call_target, ast.Name):
            name = call_target.id
            if name in module.functions:
                return [module.functions[name]]
            imported = module.imports.get(name)
            if imported and imported[1]:
                found = self.module_function(imported[0], imported[1])
                return [found] if found else []
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
            receiver = self.receiver_class(value, owner)
            if receiver is not None and (method := self.class_method(receiver, attr)):
                return [method]
            if attr in CONTAINER_METHODS:
                return []
            candidates = self.methods_by_name.get(attr, [])
            return [] if len(candidates) > 1 and attr in PROTOCOL_METHODS else candidates
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
        return "executor", node.args[0]
    if name == "run_in_executor" and len(node.args) > 1:
        return "executor", node.args[1]
    return None


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


def _database_connect(node: ast.Call, module: Module) -> str | None:
    """A new database connection or pool: the psycopg call that opens it."""
    name = _qualified_name(node.func, module)
    return name if name in DATABASE_CONNECTS else None


def _blocking_operation(node: ast.Call, module: Module) -> tuple[str, str] | None:
    """(family, operation) for a call that blocks its thread until I/O completes."""
    name = _qualified_name(node.func, module)
    if name in BLOCKING_CALLS:
        return BLOCKING_CALLS[name], name
    operation = _filesystem_operation(node)
    if operation is not None:
        return ("media" if operation == "mutagen.File" else "filesystem"), operation
    if isinstance(node.func, ast.Attribute):
        if node.func.attr in FILESYSTEM_WRITE_METHODS:
            return "filesystem", FILESYSTEM_WRITE_METHODS[node.func.attr]
        if node.func.attr in DATABASE_METHODS and _imports_database_driver(module):
            return "database", f"db.{node.func.attr}"
    return None


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


def _filesystem_operation(node: ast.Call) -> str | None:
    base, name = _call_name(node)
    attribute = isinstance(node.func, ast.Attribute)
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


def _direct_hazards(definition: Definition, looped: bool, module: Module | None = None) -> list[dict[str, object]]:
    """Directory enumeration always counts. A single stat/open/media parse of a
    selected file is bounded; the same probe repeated per item is not. A new
    database connection opened per item (BI-05) is an N+1 connection storm."""
    hazards = []
    for node, in_loop in _facts(definition).calls:
        connect = _database_connect(node, module) if module is not None else None
        if connect is not None and (in_loop or looped):
            hazards.append({
                "rule": "BI-05",
                "operation": f"database-connect-per-item:{connect}",
                "path": definition.path,
                "function": definition.qualname,
                "line": node.lineno,
                "enumeration": False,
                "per_item_connect": True,
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
        definitions = list(_all_definitions(modules)) if collections else []
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
                    for target in resolve(node.func):
                        for parameter in _parameter_names(target):
                            argument = _argument_for(node, target, parameter)
                            if argument is None:
                                continue
                            if is_state(argument):
                                changed |= self._add(self.state_params, target, parameter)
                            elif self._is_getter(argument, definition, is_state):
                                changed |= self._add(self.getter_params, target, parameter)
                            elif collection := _library_collection(argument, is_state, aliases, collections):
                                known = self.collection_params.setdefault(id(target.node), {})
                                if parameter not in known:
                                    known[parameter] = collection
                                    changed = True

    @staticmethod
    def _add(facts: dict[int, set[str]], target: Definition, parameter: str) -> bool:
        known = facts.setdefault(id(target.node), set())
        if parameter in known:
            return False
        known.add(parameter)
        return True

    def _calls_getter(self, node: ast.Call, definition: Definition) -> bool:
        func = node.func
        if isinstance(func, ast.Name) and func.id in self.getter_params.get(id(definition.node), set()):
            return True
        return any(id(target.node) in self.getters for target in _resolver(definition, self.index)(func))

    def _state_predicate(self, definition: Definition):
        """`is_state(expr)` for expressions inside `definition`."""
        # A `library_state` parameter or local keeps counting as evidence
        # where its callers cannot be resolved.
        names = self.state_params.get(id(definition.node), set()) | ({"library_state"} & set(_parameter_names(definition)))

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
        if isinstance(node, ast.Name) and node.id in self.getter_params.get(id(definition.node), set()):
            return True
        return isinstance(node, (ast.Name, ast.Attribute)) and any(
            id(target.node) in self.getters for target in _resolver(definition, self.index)(node)
        )

    def aliases(self, definition: Definition, is_state) -> dict[str, str]:
        aliases = dict(self.collection_params.get(id(definition.node), {}))
        for node in ast.walk(definition.node):
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                collection = _library_collection(node.value, is_state, {}, self.collections)
                if collection:
                    aliases[node.targets[0].id] = collection
        return aliases

    def scans(self, definition: Definition) -> list[dict[str, object]]:
        if not self.collections:
            return []
        is_state = self._state_predicate(definition)
        aliases = self.aliases(definition, is_state)
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


def _resolver(definition: Definition, index: Index):
    nested = _facts(definition).nested

    def resolve(target: ast.AST | None) -> list[Definition]:
        if target is None:
            return []
        if isinstance(target, ast.Name) and target.id in nested:
            return [nested[target.id]]
        return index.resolve(target, definition)

    return resolve


def _callees(definition: Definition, index: Index) -> list[tuple[Definition, bool, int]]:
    found = []
    resolve = _resolver(definition, index)
    for node, in_loop in _facts(definition).calls:
        found.extend((target, in_loop, node.lineno) for target in resolve(node.func))
        _, name = _call_name(node)
        position = SYNCHRONOUS_DISPATCH.get(name)
        dispatched = node.args[position] if position is not None and len(node.args) > position else None
        submit = _awaited_submit(node)
        if submit is not None and submit.args:
            dispatched = submit.args[0]
        if dispatched is not None:
            found.extend((target, in_loop, node.lineno) for target in resolve(_callable_target(dispatched)))
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
        targets = resolve(node.func)
        # A callable argument the callee calls through its parameter
        # (`revert(config, load_keys=load_ignored_keys)`) runs here too.
        for target in list(targets):
            for parameter in _called_parameters(target):
                argument = _argument_for(node, target, parameter)
                if argument is not None:
                    targets.extend(resolve(_callable_target(argument)))
        found.append((node, targets))
    found.extend((submit, resolve(_callable_target(submit.args[0]))) for submit in waited.values())
    return found


def _called_parameters(definition: Definition) -> set[str]:
    parameters = set(_parameter_names(definition))
    return {node.func.id for node, _ in _facts(definition).calls if isinstance(node.func, ast.Name) and node.func.id in parameters}


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
    database connection or DB-API call, filesystem or media I/O, a subprocess,
    `time.sleep`, synchronous HTTP, a PIL image open, or registered
    library-scale work. A coroutine called from the chain runs on the loop too
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
        for node, _ in _facts(definition).calls:
            found = _blocking_operation(node, module)
            if found is not None:
                return (*found, node.lineno)
        return None

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
            for node, targets in _loop_calls(current, self.index):
                blocking = []
                if id(node) not in awaited and (direct := _blocking_operation(node, module)) is not None:
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
                for callee in resolve(node.func):
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
            for callee in resolve(node.func):
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


def analyze_python_repository(
    root: Path,
    *,
    library_scale_operations: list[str] | tuple[str, ...] = (),
    library_state_collections: list[str] | tuple[str, ...] = (),
    overrides: dict[str, str] | None = None,
) -> dict[str, list[dict[str, object]]]:
    _FACTS.clear()
    _OWN_NODES.clear()
    modules = load_modules(root, overrides)
    index = Index(modules)
    library_scale = set(library_scale_operations)
    collections = set(library_state_collections)
    entrypoints: list[dict[str, object]] = []
    hazards: list[dict[str, object]] = []
    hazard_cache: dict[tuple[int, bool], list[dict[str, object]]] = {}
    callee_cache: dict[int, list[tuple[Definition, bool]]] = {}
    event_loop = EventLoopAnalysis(index, library_scale)
    library_state = LibraryStateEvidence(modules, index, collections)
    for entry, definition in _all_entrypoints(modules, index):
        entrypoints.append(entry)
        interactive = entry["kind"] in {"route", "middleware"}
        hazards.extend(event_loop.hazards(entry, definition))
        queue = deque([(definition, [], None)])
        seen = set()
        while queue:
            # `loop` is the call site (path, line, function), inside a loop
            # body, through which the current definition runs once per item
            # (None outside any loop).
            current, via, loop = queue.popleft()
            looped = loop is not None
            if (id(current.node), looped) in seen:
                continue
            seen.add((id(current.node), looped))
            depth = "direct" if not via else "indirect"
            # A route never reaches library-scale work; a background entrypoint
            # may, but only under a contract proving its batching, coalescing,
            # and convergence.
            if current.key in library_scale:
                hazards.append({
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
            cache_key = (id(current.node), looped)
            if cache_key not in hazard_cache:
                hazard_cache[cache_key] = [
                    *_direct_hazards(current, looped, index.modules[current.module]),
                    *library_state.scans(current),
                ]
            for hazard in hazard_cache[cache_key]:
                record = {key: value for key, value in hazard.items() if key not in {"enumeration", "per_item_connect"}}
                if hazard.get("per_item_connect"):
                    # Reported at the loop that repeats the connection: the
                    # place to load once and pass the result down.
                    loop_path, loop_line, loop_function = loop or (hazard["path"], hazard["line"], hazard["function"])
                    record.update({
                        "operation": f"{hazard['operation']}@{hazard['path']}:{hazard['line']}",
                        "path": loop_path,
                        "line": loop_line,
                        "function": loop_function,
                    })
                # A route rejects direct enumeration, and a connection opened per
                # item at any depth: one request must not open N connections.
                rejected = (depth == "direct" and bool(hazard["enumeration"])) or bool(hazard.get("per_item_connect"))
                hazards.append({
                    **record,
                    "entrypoint": entry["key"],
                    "depth": depth,
                    "via": via,
                    "reject": interactive and rejected,
                })
            if id(current.node) not in callee_cache:
                callee_cache[id(current.node)] = _callees(current, index)
            for callee, call_in_loop, line in callee_cache[id(current.node)]:
                callee_loop = loop or ((current.path, line, current.qualname) if call_in_loop else None)
                queue.append((callee, [*via, callee.qualname], callee_loop))
    unique: dict[str, dict[str, object]] = {}
    for hazard in hazards:
        site = f"{hazard['path']}#{hazard['function']}"
        if hazard["rule"] == "BI-05":
            # One N+1 per loop, whichever connection it reaches first.
            hazard["key"] = f"{hazard['entrypoint']}:BI-05:database-connect-per-item@{site}:{hazard['line']}"
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
    return {
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
    return sorted(hazards, key=lambda item: item["line"])


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
