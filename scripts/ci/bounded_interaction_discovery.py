"""Static inventory of backend interaction entrypoints and reachable hazards.

Discovery proves coverage, not boundedness. Direct filesystem enumeration in an
interactive entrypoint is rejected outright; filesystem/media work reached
through helpers is reported so the registry can demand a runtime contract; and
any interactive path that reaches a registered library-scale operation is
rejected at any depth.
"""

from __future__ import annotations

import argparse
import ast
import json
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
PROBE_METHODS = {"stat": "Path.stat", "lstat": "Path.stat", "read_bytes": "Path.read_bytes", "read_text": "Path.read_text"}
MEDIA_CALLS = {"MutagenFile": "mutagen.File"}
SYNCHRONOUS_DISPATCH = {"run_in_threadpool", "to_thread"}
MAX_CALL_DEPTH = 8


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
        seen: dict[str, list[Definition]] = {}
        for module in modules:
            for methods in module.methods.values():
                for name, definition in methods.items():
                    seen.setdefault(name, []).append(definition)
        self.unique_methods = {name: defs[0] for name, defs in seen.items() if len(defs) == 1 and not name.startswith("__")}

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

    def resolve(self, call_target: ast.AST, owner: Definition) -> Definition | None:
        module = self.modules[owner.module]
        if isinstance(call_target, ast.Name):
            name = call_target.id
            if name in module.functions:
                return module.functions[name]
            imported = module.imports.get(name)
            if imported and imported[1]:
                return self.module_function(imported[0], imported[1])
            return None
        if isinstance(call_target, ast.Attribute):
            value = call_target.value
            attr = call_target.attr
            if isinstance(value, ast.Name):
                if value.id in {"self", "cls"} and owner.class_name:
                    method = module.methods.get(owner.class_name, {}).get(attr)
                    if method:
                        return method
                imported = module.imports.get(value.id)
                if imported:
                    target_module = imported[0] if imported[1] is None else f"{imported[0]}.{imported[1]}"
                    found = self.module_function(target_module, attr)
                    if found:
                        return found
            return self.unique_methods.get(attr)
        return None


NESTED_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
LOOP_NODES = (ast.For, ast.AsyncFor, ast.While, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
# Callables that run a lambda argument before returning; per-item consumers run
# it once per element. Any other lambda argument may be deferred (executors,
# queues, threads) and is not followed.
ITERATING_LAMBDA_CONSUMERS = {"sorted", "sort", "min", "max", "map", "filter", "any", "all", "sum"}


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
    while stack:
        node, in_loop = stack.pop()
        if isinstance(node, ast.Lambda):
            if id(node) not in lambda_loops:
                continue
            in_loop = in_loop or lambda_loops[id(node)]
        if isinstance(node, ast.Call):
            calls.append((node, in_loop))
            consumer = _call_name(node)[1]
            if consumer in ITERATING_LAMBDA_CONSUMERS or consumer in SYNCHRONOUS_DISPATCH:
                for argument in [*node.args, *(keyword.value for keyword in node.keywords)]:
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
        child_in_loop = in_loop or isinstance(node, LOOP_NODES)
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


def _callees(definition: Definition, index: Index) -> list[tuple[Definition, bool]]:
    found = []
    facts = _facts(definition)

    def resolve(target: ast.AST) -> Definition | None:
        if isinstance(target, ast.Name) and target.id in facts.nested:
            return facts.nested[target.id]
        return index.resolve(target, definition)

    for node, in_loop in facts.calls:
        target = resolve(node.func)
        if target is not None:
            found.append((target, in_loop))
        _, name = _call_name(node)
        if name in SYNCHRONOUS_DISPATCH and node.args:
            dispatched = resolve(node.args[0])
            if dispatched is not None:
                found.append((dispatched, in_loop))
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
    overrides: dict[str, str] | None = None,
) -> dict[str, list[dict[str, object]]]:
    _FACTS.clear()
    modules = load_modules(root, overrides)
    index = Index(modules)
    library_scale = set(library_scale_operations)
    entrypoints: list[dict[str, object]] = []
    hazards: list[dict[str, object]] = []
    hazard_cache: dict[tuple[int, bool], list[dict[str, object]]] = {}
    callee_cache: dict[int, list[tuple[Definition, bool]]] = {}
    for module in modules:
        if not module.path.startswith(ENTRYPOINT_ROOTS):
            continue
        for entry, definition in _entrypoints(module):
            entrypoints.append(entry)
            interactive = entry["kind"] == "route"
            queue = deque([(definition, [], False)])
            seen = set()
            while queue:
                current, via, looped = queue.popleft()
                if (id(current.node), looped) in seen or len(via) > MAX_CALL_DEPTH:
                    continue
                seen.add((id(current.node), looped))
                depth = "direct" if not via else "indirect"
                if interactive and current.key in library_scale:
                    hazards.append({
                        "rule": "BI-04",
                        "operation": f"library-scale:{current.key}",
                        "path": current.path,
                        "function": current.qualname,
                        "line": current.node.lineno,
                        "entrypoint": entry["key"],
                        "depth": depth,
                        "via": via,
                        "reject": True,
                    })
                    continue
                cache_key = (id(current.node), looped)
                if cache_key not in hazard_cache:
                    hazard_cache[cache_key] = _direct_hazards(current, looped)
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


def _library_scale_from_registry(registry_path: Path | None) -> list[str]:
    if registry_path is None or not registry_path.exists():
        return []
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    return [str(item["operation"]) for item in registry.get("libraryScaleOperations", [])]


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
            library_scale_operations=_library_scale_from_registry(args.registry),
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
