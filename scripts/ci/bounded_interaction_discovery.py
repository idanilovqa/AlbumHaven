"""Static inventory of backend interaction entrypoints and reachable hazards.

Discovery proves coverage, not boundedness. Entrypoints are routes, background
owners found by name, and every thread or executor target. Direct filesystem
enumeration in an interactive entrypoint is rejected outright; filesystem/media
work reached through helpers is reported so the registry can demand a runtime
contract; and any interactive path that reaches a registered library-scale
operation is rejected at any depth.

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
MEDIA_CALLS = {"MutagenFile": "mutagen.File"}
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
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    methods[item.name] = Definition(relative, f"{node.name}.{item.name}", item, module.name, node.name)
    # Function-local imports are merged into module scope: resolution only needs
    # to know which module a name came from, and local imports never shadow it.
    for node in _iter_statements(tree.body):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    module.imports[alias.asname] = (alias.name, None)
        elif isinstance(node, ast.ImportFrom):
            source_module = node.module or ""
            if node.level:
                parts = package.split(".")[: len(package.split(".")) - node.level + 1]
                source_module = ".".join([*parts, source_module] if source_module else parts)
            for alias in node.names:
                module.imports[alias.asname or alias.name] = (source_module, alias.name)
    return module


class Index:
    def __init__(self, modules: list[Module]):
        self.modules = {module.name: module for module in modules}
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

    def resolve(self, call_target: ast.AST, owner: Definition) -> list[Definition]:
        """Definitions a call may run. A method call on an unknown receiver may
        run any app method of that name; all candidates are followed, except
        that an ambiguous builtin protocol name (see PROTOCOL_METHODS) is not."""
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
                imported = module.imports.get(value.id)
                if imported:
                    target_module = imported[0] if imported[1] is None else f"{imported[0]}.{imported[1]}"
                    found = self.module_function(target_module, attr)
                    if found:
                        return [found]
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
    """A literal tuple, list or set of constants, or ``range`` over constants."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "range":
        return bool(node.args) and not node.keywords and all(isinstance(arg, ast.Constant) for arg in node.args)
    return isinstance(node, (ast.Tuple, ast.List, ast.Set)) and all(isinstance(item, ast.Constant) for item in node.elts)


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

    Nested defs and deferred lambdas run only when something calls them.
    """
    cached = _FACTS.get(id(definition.node))
    if cached is not None:
        return cached
    calls: list[tuple[ast.Call, bool]] = []
    nested: dict[str, Definition] = {}
    has_while = False
    lambda_loops: dict[int, bool] = {}
    stack = [(child, False) for child in ast.iter_child_nodes(definition.node)]
    evaluated_once: dict[int, bool] = {}
    while stack:
        node, in_loop = stack.pop()
        in_loop = evaluated_once.pop(id(node), in_loop)
        if isinstance(node, ast.Lambda):
            if id(node) not in lambda_loops:
                continue
            in_loop = in_loop or lambda_loops[id(node)]
        if isinstance(node, ast.Call):
            calls.append((node, in_loop))
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
        child_in_loop = in_loop or (isinstance(node, LOOP_NODES) and not _iterates_literal(node))
        # The iterable of a `for` (or of a comprehension's first `for`) is
        # evaluated once, before the loop repeats anything.
        source = _loop_source(node)
        if source is not None:
            evaluated_once[id(source)] = in_loop
        for name in node._fields:
            value = getattr(node, name, None)
            if isinstance(value, list):
                stack.extend((item, child_in_loop) for item in value if isinstance(item, ast.AST))
            elif isinstance(value, ast.AST):
                stack.append((value, child_in_loop))
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


def _filesystem_operation(node: ast.Call) -> str | None:
    base, name = _call_name(node)
    attribute = isinstance(node.func, ast.Attribute)
    if (base, name) in ENUMERATION_CALLS:
        return ENUMERATION_CALLS[(base, name)]
    if attribute and name in ENUMERATION_METHODS and base not in {"glob", "fnmatch", "re"}:
        return ENUMERATION_METHODS[name]
    if (base, name) == ("os", "stat"):
        return "os.stat"
    if attribute and name in PROBE_METHODS and base != "os":
        return PROBE_METHODS[name]
    if isinstance(node.func, ast.Name) and name == "open":
        return "open"
    if (base, name) == ("mutagen", "File") or name in MEDIA_CALLS:
        return "mutagen.File"
    return None


def _direct_hazards(definition: Definition, looped: bool) -> list[dict[str, object]]:
    """Directory enumeration always counts. A single stat/open/media parse of a
    selected file is bounded; the same probe repeated per item is not."""
    hazards = []
    for node, in_loop in _facts(definition).calls:
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
# copy over one of them is library-sized work. A receiver is library state only
# by evidence: a parameter or variable named `library_state`, or a variable
# bound from `_library_state(...)` or a `.library_state` attribute. One local
# alias (`albums = library_state.get("albums", [])`) is followed.
COPYING_CALLS = {"list", "sorted", "tuple", "set", "dict", "frozenset", "enumerate", "reversed"}
VIEW_METHODS = {"values", "items", "keys", "copy"}


def _is_library_state(node: ast.AST, state_names: set[str]) -> bool:
    if isinstance(node, ast.Name):
        return node.id in state_names
    if isinstance(node, ast.Attribute):
        return node.attr == "library_state"
    return isinstance(node, ast.Call) and _call_name(node)[1] == "_library_state"


def _library_collection(node: ast.AST, state_names: set[str], aliases: dict[str, str], collections: set[str]) -> str | None:
    """The registered collection an expression reads, through copies and views."""
    while True:
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in COPYING_CALLS and node.args:
            node = node.args[0]
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in VIEW_METHODS and not node.args:
            node = node.func.value
        elif isinstance(node, ast.BoolOp):
            found = [_library_collection(value, state_names, aliases, collections) for value in node.values]
            return next((item for item in found if item), None)
        else:
            break
    if isinstance(node, ast.Name):
        return aliases.get(node.id)
    key = None
    if isinstance(node, ast.Subscript) and _is_library_state(node.value, state_names):
        key = node.slice
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get" and node.args:
        if _is_library_state(node.func.value, state_names):
            key = node.args[0]
    if isinstance(key, ast.Constant) and key.value in collections:
        return str(key.value)
    return None


def _library_state_scans(definition: Definition, collections: set[str]) -> list[dict[str, object]]:
    if not collections:
        return []
    node = definition.node
    state_names = {"library_state"} & set(_parameter_names(definition))
    statements = [item for item in ast.walk(node) if isinstance(item, ast.Assign) and len(item.targets) == 1 and isinstance(item.targets[0], ast.Name)]
    for statement in statements:
        if _is_library_state(statement.value, set()) or statement.targets[0].id == "library_state":
            state_names.add(statement.targets[0].id)
    aliases: dict[str, str] = {}
    for statement in statements:
        collection = _library_collection(statement.value, state_names, {}, collections)
        if collection:
            aliases[statement.targets[0].id] = collection
    hazards = []
    seen = set()
    for item in ast.walk(node):
        sources = []
        if isinstance(item, (ast.For, ast.AsyncFor)):
            sources = [item.iter]
        elif isinstance(item, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            sources = [generator.iter for generator in item.generators]
        elif isinstance(item, ast.Call) and isinstance(item.func, ast.Name) and item.func.id in COPYING_CALLS and item.args:
            sources = [item.args[0]]
        for source in sources:
            collection = _library_collection(source, state_names, aliases, collections)
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


def _callees(definition: Definition, index: Index) -> list[tuple[Definition, bool]]:
    found = []
    resolve = _resolver(definition, index)
    for node, in_loop in _facts(definition).calls:
        found.extend((target, in_loop) for target in resolve(node.func))
        _, name = _call_name(node)
        position = SYNCHRONOUS_DISPATCH.get(name)
        dispatched = node.args[position] if position is not None and len(node.args) > position else None
        submit = _awaited_submit(node)
        if submit is not None and submit.args:
            dispatched = submit.args[0]
        if dispatched is not None:
            found.extend((target, in_loop) for target in resolve(_callable_target(dispatched)))
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


def _entrypoints(module: Module) -> list[tuple[dict[str, object], Definition]]:
    found = []
    definitions = list(module.functions.values()) + [
        definition for methods in module.methods.values() for definition in methods.values()
    ]
    for definition in definitions:
        node = definition.node
        for trigger in _route_triggers(node):
            found.append((_entry(definition, "route", trigger, node.lineno), definition))
        if _route_triggers(node):
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
    found = [item for module in modules if module.path.startswith(ENTRYPOINT_ROOTS) for item in _entrypoints(module)]
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
    modules = load_modules(root, overrides)
    index = Index(modules)
    library_scale = set(library_scale_operations)
    collections = set(library_state_collections)
    entrypoints: list[dict[str, object]] = []
    hazards: list[dict[str, object]] = []
    hazard_cache: dict[tuple[int, bool], list[dict[str, object]]] = {}
    callee_cache: dict[int, list[tuple[Definition, bool]]] = {}
    for entry, definition in _all_entrypoints(modules, index):
        entrypoints.append(entry)
        interactive = entry["kind"] == "route"
        queue = deque([(definition, [], False)])
        seen = set()
        while queue:
            current, via, looped = queue.popleft()
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
                hazard_cache[cache_key] = [*_direct_hazards(current, looped), *_library_state_scans(current, collections)]
            for hazard in hazard_cache[cache_key]:
                record = {key: value for key, value in hazard.items() if key != "enumeration"}
                hazards.append({
                    **record,
                    "entrypoint": entry["key"],
                    "depth": depth,
                    "via": via,
                    "reject": interactive and depth == "direct" and bool(hazard["enumeration"]),
                })
            if id(current.node) not in callee_cache:
                callee_cache[id(current.node)] = _callees(current, index)
            for callee, call_in_loop in callee_cache[id(current.node)]:
                queue.append((callee, [*via, callee.qualname], looped or call_in_loop))
    unique: dict[str, dict[str, object]] = {}
    for hazard in hazards:
        hazard["key"] = f"{hazard['entrypoint']}:{hazard['rule']}:{hazard['operation']}@{hazard['path']}#{hazard['function']}"
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
