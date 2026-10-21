"""Static preview CI contracts. This module never imports either evidence helper.

Only source bytes, Python ASTs, the closed JSON plan and inspectable workflow
text are read. No collection, product import, process or network is needed.
Source checks are necessary guards, not a proof of arbitrary Python control
flow: implementation review must trace trusted provenance, loader/gate order,
pre-materialization limits and actual final upload completion.
"""
from __future__ import annotations

import ast
import hashlib
import itertools
import json
from pathlib import Path
import re
import textwrap


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ".github/workflows/foobar-preview-backend-evidence.yml"
ADAPTER = "scripts/ci/foobar_preview_evidence.py"
PLAN = "scripts/ci/foobar_preview_plan.json"
OLD_WORKFLOW = ".github/workflows/new-feature-backend-evidence.yml"
ADMISSION = "scripts/ci/admit-new-feature-evidence.py"
OLD_HELPER = "scripts/ci/new_feature_evidence.py"
OLD_HELPER_SHA256 = "8f45a3c1c3ada77a817928463527fb4add58f57f70a2d3f24cc9187cf5fb3673"
LEGACY_HELPERS = (
    "tests/py/test_new_feature_ci_contract.py",
    "tests/py/test_new_feature_evidence.py",
)
HELPERS = (
    "tests/py/test_foobar_preview_ci_contract.py",
    "tests/py/test_foobar_preview_evidence.py",
)
SELECTORS = (
    "tests/py/test_foobar_snapshot_preview.py",
    "tests/py/test_foobar_snapshot_preview_resources.py",
)
PRODUCTS = (
    "music_app/services/foobar_snapshot_parser.py",
    "music_app/services/foobar_snapshot_preview.py",
    *SELECTORS,
)
NEW_PATHS = (WORKFLOW, ADAPTER, PLAN, *HELPERS)
CONTROL_PATHS = (WORKFLOW, OLD_WORKFLOW, ADMISSION, OLD_HELPER, ADAPTER, PLAN,
                 *LEGACY_HELPERS, *HELPERS)
REUSE_CALLABLES = ("run_owned", "process_success", "node_list", "timestamp", "owned_file")
JOBS = ("admission", "helper", "core", "resource_1", "resource_2",
        "resource_3", "resource_4", "reconcile")
NEEDS = {
    "admission": (),
    "helper": ("admission",),
    "core": ("admission", "helper"),
    "resource_1": ("admission", "helper", "core"),
    "resource_2": ("admission", "helper", "resource_1"),
    "resource_3": ("admission", "helper", "resource_2"),
    "resource_4": ("admission", "helper", "resource_3"),
    "reconcile": JOBS[:-1],
}
JOB_MINUTES = {"admission": 2, "helper": 40, "core": 45,
               "resource_1": 90, "resource_2": 90, "resource_3": 90,
               "resource_4": 90, "reconcile": 15}
LIMITS = {
    "collection_seconds": 300, "core_seconds": 600, "resource_seconds": 300,
    "helper_collection_seconds": 60, "helper_runtime_seconds": 180,
    "term_seconds": 30, "kill_reap_seconds": 30, "git_seconds": 10,
    "artifact_bytes": 268435456, "artifact_files": 4096, "file_bytes": 33554432,
    "aggregate_bytes": 2147483648, "aggregate_files": 32768,
}
OVERHEAD = {"checkout": 120, "setup_python": 300, "install": 300,
            "download": 120, "verify": 120, "finalize": 120, "upload": 180}
COMMON_OPTIONS = {"--root", "--plan", "--admission", "--evidence-dir",
                  "--expected-head", "--run-id", "--attempt"}
EXTRA_OPTIONS = {"--helper-evidence", "--shard-index", "--canonical-core-evidence",
                 "--predecessor-evidence", "--input-dir"}
PUBLIC_SEAMS = {
    "validate_invocation": (("evidence_dir", "invocation"), ("assigned_ids", "owner")),
    "validate_artifact": (("evidence_dir",), ("plan", "expected", "inputs")),
    "reconcile_artifacts": (("input_dir",), ("plan", "expected")),
}

# Frozen Git blob IDs observed at the admitted public feature head.
IMMUTABLE_BLOBS = {'.github/workflows/capabilities-release-diagnostics.yml': '9a73601528e4ec7df935afbf2bc81eb2f8a33ea5',
 '.github/workflows/chat-editor-foundation-repair.yml': '89f4956e40ecfb5b416c74e1935b6d3e6bd9bc22',
 '.github/workflows/chat-editor-python-only.yml': 'bbee19172c0c91ecd0c0020b97d32ee154b913b8',
 '.github/workflows/mobile-ci-failure-inventory.yml': '5398afb296b1f1c6ac1f6cdbe6fcbc2924fcdb5b',
 '.github/workflows/mobile-fixture-reproduction.yml': 'e043d6f22ca37fcd3153703b5bba2879cdc29ebc',
 '.github/workflows/mobile-focused-tools.yml': '99171a9c4475ecc9972dbaef9beefdc4387308c1',
 '.github/workflows/mobile-layout-checks.yml': 'd7e8aba4f9f0792b0c19b75c275cea6bee583d65',
 '.github/workflows/new-feature-backend-evidence.yml': '237398b95f79f0f3a28d5707ef0a681526b5baa6',
 '.github/workflows/pr-gates.yml': 'b5ada04f688a4a8bf668b9ee2479a529af43ee2c',
 'music_app/services/foobar_snapshot_parser.py': '98709a3fcc38496ec359006a8e4c3f47763fc719',
 'pytest.ini': '4e741a52ef234f94d211d881067806bb29201efc',
 'scripts/ci/admit-new-feature-evidence.py': '1c2fafe96e46f0bc044b124afb18a962b04303a6',
 'scripts/ci/bootstrap-linux-tops-postgres.py': 'ac874a5573dc93584ec220b5dcb51dd004521ff4',
 'scripts/ci/new_feature_evidence.py': '99b5f61d498351d3a5a588480ab2dc93cd4b0694',
 'tests/py/conftest.py': 'b2d6db7bcfe17ea3e50f4a974ad7906c162f4a26',
 'tests/py/library_mix_postgres_support.py': '5f099aaaf1ff50a76877a15ef910a9657406041e',
 'tests/py/test_artist_backend_ci_selection_contract.py': '1ec69fc73d35e2b399e89da00ab14598583c4b2f',
 'tests/py/test_foobar_snapshot_parser.py': '1cc9db078b48f5de3699e1544017a5444efa4aa8',
 'tests/py/test_foobar_snapshot_parser_resources.py': 'c1d5d67ceccdce6172c02339b21318b2d3b21293',
 'tests/py/test_new_feature_ci_contract.py': '7be4735accfbe50bf549af76474f2f9eb4b7c810',
 'tests/py/test_new_feature_evidence.py': 'c5cfdd8ca655ba59322a713bd732b218e4337141'}

SUPPLIER_SHA256 = {'music_app/services/foobar_snapshot_preview.py': '4b053caa1e6b5835f2fb2fe381c4694b8ee327a3d0771a61bfe8bbc793231f7b',
 'tests/py/test_foobar_snapshot_preview.py': '4940dca3e6d818129c5b3aff204761c2460c8ac0c9340f089f08041d1a5a5fe6',
 'tests/py/test_foobar_snapshot_preview_resources.py': '9d0aebeabee2cca98a114ee75a913fa8ea45ffa13defe52ae322aa291ba444b4'}

RESOURCE_IDS = (
    'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_entry_limit_is_not_truncation[at-limit]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_entry_limit_is_not_truncation[over-limit]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_revision_validation_precedes_count_and_count_precedes_entry_validation',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[at-limit-ascii]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[at-limit-utf8]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[over-limit-ascii]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[over-limit-utf8]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[invalid-over-budget]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[duplicate-over-budget]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[invalid-over-duplicate]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_maximum_parser_rows_are_preserved_and_share_one_candidate_projection',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_many_distinct_path_groups_keep_exact_counts_and_bounded_candidates',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_all_inventory_entries_can_be_distinct_candidates_without_false_uniqueness',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_invalid_parser_row_dimensions_reject_without_partial_results[empty]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_invalid_parser_row_dimensions_reject_without_partial_results[over-limit]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_header_width_boundary[at-limit]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_header_width_boundary[over-limit]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_total_cells_includes_header[at-limit]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_total_cells_includes_header[over-limit]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-ascii-header]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-ascii-cell]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-utf8-header]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-utf8-cell]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-ascii-header]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-ascii-cell]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-utf8-header]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-utf8-cell]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[at-limit-header]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[at-limit-row]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[over-limit-header]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[over-limit-row]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_parser_zero_byte_data_record_is_invalid_even_with_consistent_empty_path',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_reconstructed_parser_64_mib_lower_bound[at-limit]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_reconstructed_parser_64_mib_lower_bound[over-limit]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_exact_diagnostic_prefix_and_truncation_accounting[at-cap]',
    'tests/py/test_foobar_snapshot_preview_resources.py::test_exact_diagnostic_prefix_and_truncation_accounting[over-cap]',
)


def _bytes(path):
    target = ROOT / path
    assert target.is_file() and not target.is_symlink(), path
    return target.read_bytes()


def _source(path):
    return _bytes(path).decode("utf-8")


def _tree(path=ADAPTER):
    return ast.parse(_source(path), filename=path)


def _name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return _name(node.value) + "." + node.attr
    return ""


def _strings(node):
    return {item.value for item in ast.walk(node)
            if isinstance(item, ast.Constant) and isinstance(item.value, str)}


def _calls(node):
    return [item for item in ast.walk(node) if isinstance(item, ast.Call)]


def _call_names(node):
    return {_name(item.func) for item in _calls(node)}


def _strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            assert key not in result, "Duplicate JSON key: " + key
            result[key] = value
        return result

    def constant(value):
        raise AssertionError("Nonfinite JSON constant: " + value)

    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)


def _plan():
    return _strict_json(_bytes(PLAN))


def _expected_plan():
    return {
        "schema_version": "foobar-preview-plan-v1", "workflow_path": WORKFLOW,
        "lane": "foobar-preview", "selectors": list(SELECTORS),
        "legacy_helper_selectors": list(LEGACY_HELPERS),
        "helper_selectors": list(HELPERS), "core_count": 380,
        "resource_ids": list(RESOURCE_IDS),
        "shards": [{"index": index, "job": "resource_" + str(index),
                    "assigned_ids": list(RESOURCE_IDS[(index - 1) * 9:index * 9])}
                   for index in range(1, 5)],
        "reuse": {"path": OLD_HELPER, "sha256": OLD_HELPER_SHA256,
                  "callables": list(REUSE_CALLABLES)},
        "limits": dict(LIMITS), "job_minutes": dict(JOB_MINUTES),
        "overhead_seconds": dict(OVERHEAD),
    }


def _assert_exact_json(actual, expected, path="plan"):
    # Ordinary Python equality would incorrectly accept True in place of 1.
    assert type(actual) is type(expected), (path, type(actual), type(expected))
    if isinstance(expected, dict):
        assert set(actual) == set(expected), path
        for key in expected:
            _assert_exact_json(actual[key], expected[key], path + "/" + key)
    elif isinstance(expected, list):
        assert len(actual) == len(expected), path
        for index, (left, right) in enumerate(zip(actual, expected)):
            _assert_exact_json(left, right, path + "/" + str(index))
    else:
        assert actual == expected, (path, actual, expected)


def _indented_body(text, indent):
    """Keep a mapping/list body without absorbing the next enclosing field."""
    offset = 0
    for line in text.splitlines(keepends=True):
        if line.strip() and not line.lstrip(" ").startswith("#"):
            depth = len(line) - len(line.lstrip(" "))
            if depth <= indent:
                return text[:offset]
        offset += len(line)
    return text


def _owner_entries(text, indent):
    """Inventory every same-level owner; unsupported syntax must not vanish."""
    entries, offset = [], 0
    for raw in text.splitlines(keepends=True):
        line = raw.rstrip("\r\n")
        if line.strip() and not line.lstrip(" ").startswith("#"):
            depth = len(line) - len(line.lstrip(" "))
            assert depth >= indent, "Unsupported owner indentation"
            if depth == indent:
                entries.append((offset, line[indent:]))
            else:
                assert entries, "Nested content before an explicit owner"
        offset += len(raw)
    assert entries, "At least one explicit owner is required"
    return entries


def _blocks(text, indent):
    entries = _owner_entries(text, indent)
    result = {}
    for index, (offset, line) in enumerate(entries):
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(?:#.*)?", line)
        assert match is not None, "Unsupported mapping owner: " + line
        assert match[1] not in result, "Duplicate mapping owner"
        end = entries[index + 1][0] if index + 1 < len(entries) else len(text)
        result[match[1]] = text[offset:end]
    return result


def _jobs(text=None):
    text = _source(WORKFLOW) if text is None else text
    assert text.count("\njobs:\n") == 1, "Use explicit inspectable workflow job blocks"
    return _blocks(_indented_body(text.split("\njobs:\n", 1)[1], 0), 2)


def _steps(job):
    headers = list(re.finditer(r"(?m)^    steps:[^\n]*$", job))
    assert len(headers) == 1, "Each job must expose one explicit steps list"
    assert re.fullmatch(r"    steps:[ \t]*(?:#.*)?", headers[0][0]), (
        "Inline or aliased steps are not inspectable")
    body = _indented_body(job[headers[0].end():], 4)
    entries = _owner_entries(body, 6)
    for _, line in entries:
        assert re.fullmatch(r"- [A-Za-z_][A-Za-z0-9_-]*:(?:[ \t].*)?", line), (
            "Unsupported step-list item: " + line)
    return [body[offset:entries[index + 1][0]
                 if index + 1 < len(entries) else len(body)]
            for index, (offset, _) in enumerate(entries)]


def _field(text, key, indent, default=None):
    # Every recognized first step key, including if/run/uses/timeout-minutes,
    # has the same mapping indentation as its subsequent keys.
    if indent >= 2:
        text = re.sub(r"\A" + " " * (indent - 2)
                      + r"- (?=[A-Za-z_][A-Za-z0-9_-]*:)", " " * indent, text, count=1)
    match = re.search(r"(?m)^" + " " * indent + re.escape(key) + r":[ \t]*(.*)$", text)
    if match is None:
        return default
    value = match[1].strip()
    if value and value not in ("|", "|-", ">", ">-"):
        return value
    tail = text[match.end():]
    boundary = re.search(r"(?m)^(?!\s*$) {0," + str(indent) + r"}\S", tail)
    return tail[:boundary.start() if boundary else len(tail)].strip()


def _assert_read_only_permissions(text):
    # Only explicit plain workflow/job keys and block contents: read maps are
    # supported. Reject quoting, merges and explicit-key syntax at these owner
    # levels too, so an alternate permissions spelling cannot evade inventory.
    declarations = 0
    scopes = [(text, 0), *((job, 4) for job in _jobs(text).values())]
    for scope, indent in scopes:
        for match in re.finditer(r"(?m)^" + " " * indent + r"(\S[^\n]*)$", scope):
            line = match[1]
            if line.startswith("#"):
                continue
            key = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t].*)?", line)
            assert key is not None, "Unsupported workflow/job mapping declaration: " + line
            if key[1] != "permissions":
                continue
            declarations += 1
            assert re.fullmatch(r"permissions:[ \t]*(?:#.*)?", line), (
                "Inline, aliased or expression permissions are not inspectable")
            body = _indented_body(scope[match.end():], indent)
            contents = [line for line in body.splitlines()
                        if line.strip() and not line.lstrip(" ").startswith("#")]
            assert len(contents) == 1 and re.fullmatch(
                " " * (indent + 2) + r"contents:[ \t]+read[ \t]*(?:#.*)?", contents[0]), (
                    "Every permissions declaration must be exactly contents: read")
    assert declarations, "An explicit read-only permissions declaration is required"


def _unquote(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _needs(job):
    value = _field(job, "needs", 4, "")
    if not value:
        return ()
    if value.startswith("["):
        return tuple(_unquote(item.strip()) for item in value[1:-1].split(",") if item.strip())
    if value.startswith("-"):
        return tuple(_unquote(item.strip()) for item in re.findall(r"(?m)^\s*-\s+(.+)$", value))
    return (_unquote(value),)


def _condition(text, indent):
    return re.sub(r"\s+", "", _field(text, "if", indent, ""))


def _step_timeout(step):
    value = _field(step, "timeout-minutes", 8)
    assert value is not None and re.fullmatch(r"[1-9][0-9]*", value), (
        "An action/run step needs a literal enclosing wall bound", step.splitlines()[0])
    return int(value) * 60


def _run(step):
    return _field(step, "run", 8, "")


def _adapter_steps(job, phase):
    command = re.compile(re.escape(ADAPTER) + r"\s+" + phase + r"(?:\s|$)")
    return [(index, step) for index, step in enumerate(_steps(job)) if command.search(_run(step))]


def _literal_sequence(node):
    try:
        result = ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError):
        return None
    return result if isinstance(result, (tuple, list, set, frozenset)) else None


def _functions(tree):
    return {node.name: node for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}


def _reachable(tree, starts, stop_at=()):
    """Conservative direct-name call graph, not arbitrary-program verification."""
    functions = _functions(tree)
    result, pending = set(), list(starts)
    while pending:
        name = pending.pop()
        if name in result or name not in functions or name in stop_at:
            continue
        result.add(name)
        pending.extend(_name(call.func) for call in _calls(functions[name]))
    return result


def _main_roots(tree):
    guards = [node for node in tree.body if isinstance(node, ast.If)
              and "__main__" in _strings(node.test)]
    assert len(guards) == 1, "One guarded CLI entry point is required"
    return {_name(call.func) for call in _calls(guards[0])}


def _embedded_trees(tree):
    # Parse literal Python child programs without compiling or running any.
    result = [tree]
    for value in _strings(tree):
        if "music_app.services" not in value or "\n" not in value:
            continue
        try:
            result.append(ast.parse(textwrap.dedent(value)))
        except SyntaxError:
            continue
    return result


def _old_loader_names(tree):
    path_constants = {target.id for node in tree.body if isinstance(node, ast.Assign)
                      and isinstance(node.value, ast.Constant) and node.value.value == OLD_HELPER
                      for target in node.targets if isinstance(target, ast.Name)}
    result = set()
    for name, function in _functions(tree).items():
        values = _strings(function)
        names = {node.id for node in ast.walk(function) if isinstance(node, ast.Name)}
        references_old = OLD_HELPER in values or bool(names & path_constants) or {"reuse", "path"} <= values
        if references_old and any(call.endswith("spec_from_file_location") for call in _call_names(function)):
            result.add(name)
    return result


def _old_helper_aliases(tree, scope):
    """Recognize module objects without confusing callable maps or local scopes."""
    aliases, imported, factories = set(), {}, set()
    functions = _functions(tree)
    loader_modules = {}
    for name in _old_loader_names(tree):
        module_names = {target.id for node in ast.walk(functions[name])
                        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)
                        and _name(node.value.func).endswith("module_from_spec")
                        for target in node.targets if isinstance(target, ast.Name)}
        loader_modules[name] = module_names
        if any(isinstance(node, ast.Return) and isinstance(node.value, ast.Name)
               and node.value.id in module_names for node in ast.walk(functions[name])):
            factories.add(name)
    # A module import at top level is visible to every scope. A local alias
    # stays local; returning a dictionary of allowed callables is not returning
    # the old module object and must not taint ordinary dict methods.
    imports = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))]
    imports += [node for node in ast.walk(scope) if isinstance(node, (ast.Import, ast.ImportFrom))]
    for node in imports:
        if isinstance(node, ast.Import):
            aliases.update(item.asname or item.name for item in node.names
                           if item.name.endswith("new_feature_evidence"))
        elif (node.module or "").endswith("new_feature_evidence"):
            imported.update((item.asname or item.name, item.name) for item in node.names)
    if isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef)):
        aliases.update(loader_modules.get(scope.name, ()))
    assignments = [node for node in tree.body if isinstance(node, (ast.Assign, ast.AnnAssign))]
    assignments += [node for node in ast.walk(scope) if isinstance(node, (ast.Assign, ast.AnnAssign))]
    changed = True
    while changed:
        before = set(aliases)
        for node in assignments:
            value = node.value
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if (isinstance(value, ast.Name) and value.id in aliases) or (
                    isinstance(value, ast.Call) and _name(value.func) in factories):
                aliases.update(target.id for target in targets if isinstance(target, ast.Name))
        changed = before != aliases
    return aliases, imported


def _adapter_scopes(tree):
    return [ast.Module(body=[node for node in tree.body if not isinstance(
                node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))], type_ignores=[]),
            *_functions(tree).values()]


# S01: ownership and frozen predecessors/suppliers.
def test_s01_exact_five_additive_paths_and_two_test_owners_exist():
    assert len(NEW_PATHS) == len(set(NEW_PATHS)) == 5
    assert tuple(path for path in NEW_PATHS if path.startswith("tests/")) == HELPERS
    assert not set(NEW_PATHS) & set(IMMUTABLE_BLOBS)
    for path in NEW_PATHS:
        assert _bytes(path), path
    assert len(CONTROL_PATHS) == len(set(CONTROL_PATHS)) == 10
    assert len(set(CONTROL_PATHS + PRODUCTS)) == 14


def test_s01_all_twenty_one_public_predecessors_remain_exact_git_blobs():
    assert len(IMMUTABLE_BLOBS) == 21
    for path, expected in IMMUTABLE_BLOBS.items():
        raw = _bytes(path)
        actual = hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
        assert actual == expected, path


def test_s01_accepted_three_preview_suppliers_remain_byte_identical():
    for path, expected in SUPPLIER_SHA256.items():
        assert hashlib.sha256(_bytes(path)).hexdigest() == expected, path
    assert hashlib.sha256(_bytes(OLD_HELPER)).hexdigest() == OLD_HELPER_SHA256


def test_s01_unchanged_old_three_job_and_sample35_parser13_guards_stay_in_place():
    assert set(_jobs(_source(OLD_WORKFLOW))) == {"admission", "sample", "foobar"}
    tree = _tree(LEGACY_HELPERS[0])
    values = _strings(tree)
    assert {"admission", "sample", "foobar"} <= values
    assert len(set(re.findall(r"tests/py/[^'\"\n ]+\.py", _source(LEGACY_HELPERS[0])))) >= 35
    # Byte guards above, rather than new reimplementations, retain every old
    # Sample35/native/parser13 assertion and its exact helper ownership.
    assert any(isinstance(node, ast.Compare) and any(
        isinstance(item, ast.Constant) and item.value == 13 for item in ast.walk(node))
               for node in ast.walk(tree))


# S02: workflow shape, native admission, identity and privilege boundary.
def test_s02_exact_eight_jobs_and_dependency_sets():
    jobs = _jobs()
    assert set(jobs) == set(JOBS)
    for name, expected in NEEDS.items():
        actual = _needs(jobs[name])
        assert len(actual) == len(set(actual)), name
        assert set(actual) == set(expected), (name, actual, expected)


def test_s02_separate_pr_concurrency_and_read_only_permissions():
    text = _source(WORKFLOW)
    top = text.split("\njobs:\n", 1)[0]
    assert _field(top, "group", 2) == "foobar-preview-evidence-${{ github.event.pull_request.number }}"
    assert _field(top, "cancel-in-progress", 2) == "true"
    _assert_read_only_permissions(text)
    assert re.search(r"(?m)^permissions:\s*\n  contents: read\s*$", top)
    assert not re.search(r"(?m)^\s*(services|secrets|environment|container):", text)
    assert not re.search(r"secrets\.|\b(?:write-all|read-all|GITHUB_TOKEN|GH_TOKEN)\b", text)


def test_s02_native_pr_trigger_has_no_privileged_or_new_dispatch_route():
    top = _source(WORKFLOW).split("\njobs:\n", 1)[0]
    assert re.search(r"(?m)^  pull_request:\s*$", top)
    assert not re.search(r"\b(?:pull_request_target|workflow_run|workflow_dispatch|repository_dispatch|schedule)\s*:", top)
    types = _field(top, "types", 4)
    assert types is not None
    assert re.findall(r"-\s+([a-z_]+)", types) == [
        "opened", "synchronize", "reopened", "ready_for_review", "labeled", "unlabeled"]


def test_s02_each_job_uses_hosted_runner_exact_head_and_no_persisted_credentials():
    for name, job in _jobs().items():
        assert _unquote(_field(job, "runs-on", 4, "")) == "ubuntu-24.04", name
        checkout = [step for step in _steps(job) if re.search(r"uses:\s*actions/checkout@", step)]
        assert len(checkout) == 1, name
        assert _field(checkout[0], "ref", 10) == "${{ github.event.pull_request.head.sha }}", name
        assert _field(checkout[0], "persist-credentials", 10) == "false", name


def test_s02_admission_uses_unchanged_script_actual_context_and_fresh_own_artifact():
    admission = _jobs()["admission"]
    calls = [step for step in _steps(admission) if ADMISSION in _run(step)]
    assert len(calls) == 1
    command = _run(calls[0])
    for item in ("--event", "github.event_path", "--attempt", "github.run_attempt", "--output"):
        assert item in command
    for item in ("github.event.pull_request.head.sha", "github.run_id", "github.run_attempt",
                 "admission.json", "admission-context.json"):
        assert item in admission
    assert not re.search(r"\bpip\s+install\b|\bpytest\b|bootstrap-linux|postgres|" + re.escape(ADAPTER), admission)
    old = _tree(ADMISSION)
    assert {"initial-attempt", "native", "missing-prerequisite", "draft", "control_labels"} <= _strings(old)
    # Script bytes, including its explicit first-attempt/native-terminal hold,
    # are frozen independently above; no companion replacement is permitted.
    assert "continue-on-error" not in admission and "|| true" not in command


# S03: scheduler hints cannot substitute for raw receipt validation.
def test_s03_resource_conditions_allow_safe_failure_but_never_cancellation():
    for index in range(1, 5):
        name = "resource_" + str(index)
        previous = "core" if index == 1 else "resource_" + str(index - 1)
        condition = _condition(_jobs()[name], 4)
        assert "always()" in condition and "!cancelled()" in condition, name
        assert "needs.admission.result=='success'" in condition, name
        assert "needs.helper.result=='success'" in condition, name
        assert re.search(r"needs\." + previous + r"\.outputs\.[A-Za-z_][A-Za-z0-9_-]*", condition), name
        # An unconditional success-only needs test would discard an otherwise
        # valid assertion_failed/timed_out_safe predecessor's independent work.
        success = "needs." + previous + ".result=='success'"
        if success in condition:
            assert "needs." + previous + ".result=='failure'" in condition and "||" in condition
        assert "success()" not in condition, name
        assert "needs." + previous + ".result!='cancelled'" in condition or "!cancelled()" in condition


def test_s03_products_require_admission_and_helper_with_complete_predecessor_arguments():
    jobs = _jobs()
    for name in JOBS[2:-1]:
        phase = "core" if name == "core" else "resource"
        entries = _adapter_steps(jobs[name], phase)
        assert len(entries) == 1, name
        _, step = entries[0]
        command = _run(step)
        assert "--helper-evidence" in command and "--admission" in command, name
        if phase == "resource":
            assert "--canonical-core-evidence" in command and "--predecessor-evidence" in command
            assert re.search(r"--shard-index\s+[\"']?" + name[-1] + r"(?:[\"']?\s|$)", command), name
        assert "continue-on-error" not in step and "|| true" not in command, name
    values = _strings(_tree())
    assert {"predecessor_receipt_sha256", "helper_receipt_sha256", "canonical_core_sha256",
            "continue_allowed", "cancelled", "assertion_failed", "timed_out_safe"} <= values
    assert "validate_artifact" in _call_names(_tree()), "A job-output hint is not an artifact validator"


def test_s03_no_setup_or_product_execution_is_silently_unconditional_after_failure():
    for name in JOBS[1:]:
        for step in _steps(_jobs()[name]):
            command = _run(step)
            assert not re.search(r"\|\|\s*(?:true|:)(?:\s|$)", command), name
            assert "continue-on-error" not in step, name
            if re.search(r"\bpip\s+install\b", command):
                assert "always()" not in _condition(step, 8), name
    # Exact control-flow admission/helper/raw-receipt validation before relevant
    # install/execution steps is also a mandatory implementation-review gate.


# S04: exact plan budgets and inspectable enclosing workflow bounds.
def test_s04_hard_job_caps_are_exact_not_runtime_promises():
    for name, job in _jobs().items():
        assert _field(job, "timeout-minutes", 4) == str(JOB_MINUTES[name]), name
    _assert_exact_json(_plan()["job_minutes"], JOB_MINUTES)
    _assert_exact_json(_plan()["limits"], LIMITS)
    _assert_exact_json(_plan()["overhead_seconds"], OVERHEAD)


def test_s04_cleanup_reserves_and_all_four_worst_case_totals_are_charged():
    limits = _plan()["limits"]
    overhead = _plan()["overhead_seconds"]
    cleanup = limits["term_seconds"] + limits["kill_reap_seconds"]
    git = limits["git_seconds"] + cleanup
    assert cleanup == 60 and git == 70
    assert sum(overhead.values()) == 1260
    resource = 9 * (limits["resource_seconds"] + cleanup) + limits["collection_seconds"] + cleanup + git + sum(overhead.values())
    core = limits["collection_seconds"] + cleanup + limits["core_seconds"] + cleanup + git + sum(overhead.values())
    helper = 2 * (limits["helper_collection_seconds"] + cleanup + limits["helper_runtime_seconds"] + cleanup) + 2 * git + sum(overhead.values())
    reconcile = sum(overhead[key] for key in ("checkout", "download", "verify", "finalize", "upload")) + git
    assert (resource, core, helper, reconcile) == (4930, 2350, 2120, 730)
    assert (90 * 60 - resource, 45 * 60 - core, 40 * 60 - helper, 15 * 60 - reconcile) == (470, 350, 280, 170)
    # Slack is not a fifth process budget, an automatic retry or a new timeout.
    assert set(limits) == set(LIMITS)


def test_s04_all_nonadmission_steps_have_enclosing_wall_bounds():
    for name in JOBS[1:]:
        for step in _steps(_jobs()[name]):
            assert _step_timeout(step) <= JOB_MINUTES[name] * 60, name
            assert "background" not in (_field(step, "uses", 8, "").lower())
            assert not re.search(r"(?:^|[;\n])\s*(?:nohup|disown)\b|&\s*$", _run(step), re.MULTILINE)


def test_s04_action_setup_install_download_upload_aggregate_bounds():
    for name in JOBS[1:]:
        groups = {key: [] for key in ("checkout", "setup_python", "install", "download", "upload")}
        for step in _steps(_jobs()[name]):
            for action, category in (("checkout", "checkout"), ("setup-python", "setup_python"),
                                     ("download-artifact", "download"), ("upload-artifact", "upload")):
                if re.search(r"uses:\s*actions/" + action + "@", step):
                    groups[category].append(_step_timeout(step))
            if re.search(r"\bpip\s+install\b", _run(step)):
                groups["install"].append(_step_timeout(step))
        assert groups["checkout"] and groups["upload"], name
        for category, durations in groups.items():
            assert sum(durations) <= OVERHEAD[category], (name, category, durations)
        if name != "reconcile":
            assert len(groups["setup_python"]) == len(groups["install"]) == 1, name
        else:
            assert not groups["setup_python"] and not groups["install"], name
    # Decoder/verification/finalization work within the adapter also has the
    # fixed aggregate bounds. Their actual enforcement needs source tracing.


def test_s04_requirements_only_no_retry_actions_or_extra_process_supervisors():
    text = _source(WORKFLOW)
    for job in _jobs().values():
        for step in _steps(job):
            command = _run(step)
            if re.search(r"\bpip\s+install\b", command):
                assert re.search(r"\bpip\s+install\s+-r\s+requirements\.txt(?:\s|$)", command)
                assert not re.search(r"(?:^|\s)(?:--upgrade|-U|--extra-index-url)(?:\s|$)", command)
            assert not re.search(r"uses:\s*[^\n]*(?:retry|rerun)", step, re.IGNORECASE)
    assert not re.search(r"\bgh\s+(?:run\s+(?:rerun|watch)|workflow\s+run)\b", text)
    calls = _call_names(_tree())
    assert not calls & {"subprocess.run", "subprocess.Popen", "subprocess.call",
                        "subprocess.check_call", "subprocess.check_output", "os.system",
                        "os.popen", "os.fork", "os.posix_spawn", "os.spawnv", "os.execv"}
    assert not any(name.endswith((".killpg", ".pkill", ".killall")) for name in calls)
    assert not any(name.endswith((".retry", ".rerun")) for name in calls)


# S05: closed selection plan and immutable resource order, without collection.
def test_s05_entire_plan_is_exact_closed_data_including_order_and_types():
    _assert_exact_json(_plan(), _expected_plan())


def test_s05_exact_36_resources_form_four_disjoint_contiguous_nine_node_slices():
    plan = _plan()
    assert len(RESOURCE_IDS) == len(set(RESOURCE_IDS)) == 36
    combined = []
    for index, shard in enumerate(plan["shards"], 1):
        assert shard["index"] == index and shard["job"] == "resource_" + str(index)
        assert shard["assigned_ids"] == list(RESOURCE_IDS[(index - 1) * 9:index * 9])
        assert len(shard["assigned_ids"]) == 9
        combined.extend(shard["assigned_ids"])
    assert combined == plan["resource_ids"] == list(RESOURCE_IDS)
    assert len(set(combined)) == len(combined)


def test_s05_resource_decorator_text_derives_exact_manifest_without_product_imports():
    tree = _tree(SELECTORS[1])
    derived = []
    for function in tree.body:
        if not isinstance(function, ast.FunctionDef) or not function.name.startswith("test_"):
            continue
        dimensions = []
        # pytest applies bottom decorators first; the final dimension varies
        # fastest. Only admitted literal IDs/values are inspected here.
        for decorator in reversed(function.decorator_list):
            if not isinstance(decorator, ast.Call) or _name(decorator.func) != "pytest.mark.parametrize":
                continue
            ids = next((keyword.value for keyword in decorator.keywords if keyword.arg == "ids"), None)
            if ids is None:
                assert len(decorator.args) >= 2
                ids = decorator.args[1]
            dimension = ast.literal_eval(ids)
            assert isinstance(dimension, (list, tuple)) and all(type(item) is str for item in dimension)
            assert dimension and len(set(dimension)) == len(dimension)
            dimensions.append(dimension)
        base = SELECTORS[1] + "::" + function.name
        if dimensions:
            derived.extend(base + "[" + "-".join(ids) + "]" for ids in itertools.product(*dimensions))
        else:
            derived.append(base)
    assert tuple(derived) == RESOURCE_IDS


def test_s05_full_collections_and_core_ownership_are_not_hardcoded_node_subsets():
    values = _strings(_tree())
    assert {"selectors", "core_count", "resource_ids", "shards", "assigned_ids",
            "full_discovered_ids", "full_final_ids", "discovered_nodeids", "nodeids",
            "collection_errors", "deselected_nodeids", "collection_sha256"} <= values
    assert not any(value.startswith(SELECTORS[0] + "::") for value in values), (
        "The core belongs to its complete actual collection, not authored function names")
    for name in JOBS[2:-1]:
        job = _jobs()[name]
        assert "--plan" in job and PLAN in job, name
        for step in _steps(job):
            command = _run(step)
            assert not re.search(r"(?:^|\s)(?:-k|--deselect|--ignore|--ignore-glob|--lf|--ff|--last-failed)\s+", command), name
            # '-m pip' is a Python module switch, not a pytest marker filter.
            # The only permitted occurrence is the existing dependency command.
            if " -m " in command:
                assert " -m pip install -r requirements.txt" in command


# S06: unchanged low-level helper reuse, not the old closed reconciler.
def test_s06_plan_freezes_exact_five_callable_reuse_and_real_source_hash():
    _assert_exact_json(_plan()["reuse"], {"path": OLD_HELPER, "sha256": OLD_HELPER_SHA256,
                                        "callables": list(REUSE_CALLABLES)})
    old_definitions = _functions(_tree(OLD_HELPER))
    assert set(REUSE_CALLABLES) <= set(old_definitions)
    assert "reconcile" not in REUSE_CALLABLES
    assert hashlib.sha256(_bytes(OLD_HELPER)).hexdigest() == OLD_HELPER_SHA256


def test_s06_detected_old_module_calls_are_allowlisted_and_never_mutated():
    tree = _tree()
    for scope in _adapter_scopes(tree):
        aliases, imported = _old_helper_aliases(tree, scope)
        assert set(imported.values()) <= set(REUSE_CALLABLES), imported
        for call in _calls(scope):
            if isinstance(call.func, ast.Attribute) and _name(call.func.value) in aliases:
                assert call.func.attr in REUSE_CALLABLES, _name(call.func)
            if isinstance(call.func, ast.Name) and call.func.id in imported:
                assert imported[call.func.id] in REUSE_CALLABLES
            if _name(call.func) in {"setattr", "delattr", "vars"} and call.args and _name(call.args[0]) in aliases:
                raise AssertionError("The unchanged helper cannot expose mutable globals or be mutated")
            if _name(call.func) == "getattr" and call.args and _name(call.args[0]) in aliases:
                if len(call.args) >= 2 and isinstance(call.args[1], ast.Constant):
                    assert call.args[1].value in REUSE_CALLABLES
        for node in ast.walk(scope):
            if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.Delete)):
                targets = node.targets if isinstance(node, (ast.Assign, ast.Delete)) else [node.target]
                for target in targets:
                    root = _name(target.value) if isinstance(target, (ast.Attribute, ast.Subscript)) else ""
                    assert not any(root == alias or root.startswith(alias + ".") for alias in aliases), root
    # Dynamic alias dispatch requires independent source review; an absence of
    # detected aliases does not certify a hidden import or broaden the allowlist.


def test_s06_no_closed_reconciler_extraction_or_invented_legacy_validator_exports():
    tree = _tree()
    calls = _call_names(tree)
    assert not any(name.endswith((".getsource", ".getsourcefile", ".getfile")) for name in calls)
    assert not calls & {"eval", "exec", "compile", "marshal.loads", "types.FunctionType", "types.CodeType"}
    assert not any(isinstance(node, ast.Attribute) and node.attr in {"__code__", "__globals__"}
                   for node in ast.walk(tree))
    for scope in _adapter_scopes(tree):
        aliases, imported = _old_helper_aliases(tree, scope)
        for node in ast.walk(scope):
            if isinstance(node, ast.Attribute) and _name(node.value) in aliases:
                assert node.attr not in {"reconcile", "read_json", "validate_json", "validate_junit", "validate_reports"}
        assert "reconcile" not in imported.values()
    values = _strings(tree)
    assert {"reuse", "sha256", "callables"} <= values
    assert any(name.endswith("sha256") for name in calls)
    assert any(name.endswith("spec_from_file_location") for name in calls)
    assert any(name.endswith("exec_module") for name in calls)
    # Ordering and the same confined bytes being hashed then imported are
    # mandatory implementation-review obligations, not just token presence.


def test_s06_legacy_and_new_whole_helper_pairs_have_separate_actual_commands():
    helper = _jobs()["helper"]
    steps = _steps(helper)
    old = [(index, step) for index, step in enumerate(steps)
           if re.search(re.escape(OLD_HELPER) + r"\s+run\b", _run(step))]
    new = _adapter_steps(helper, "helper")
    assert len(old) == len(new) == 1
    assert old[0][0] < new[0][0]
    old_command, new_command = _run(old[0][1]), _run(new[0][1])
    assert re.search(r"--lane\s+[\"']?ci-helper(?:[\"']?\s|$)", old_command)
    assert "--selection" in old_command and "--evidence-dir" in old_command
    for option in ("--admission", "--head", "--run-id", "--attempt"):
        assert option in old_command
    assert "--plan" in new_command
    assert not any("always()" in _condition(step, 8) for _, step in (old + new))
    values = _strings(_tree())
    assert {"helper_proofs", "legacy", "preview", "identity_path", "collection", "invocation"} <= values
    assert _plan()["legacy_helper_selectors"] == list(LEGACY_HELPERS)
    assert _plan()["helper_selectors"] == list(HELPERS)


# S07: import-safe source and isolated product child, never product helpers.
def test_s07_adapter_has_no_direct_product_config_database_or_provider_imports():
    banned = {"music_app", "config", "lastfm", "log_history", "psycopg", "psycopg2",
              "sqlalchemy", "django", "flask"}
    for tree in _embedded_trees(_tree()):
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            assert not any(name.split(".")[0] in banned for name in names), names
    assert not any(name.endswith((".set_int_max_str_digits", ".setrecursionlimit"))
                   for tree in _embedded_trees(_tree()) for name in _call_names(tree))


def test_s07_module_import_has_no_unguarded_host_action():
    tree = _tree()
    _main_roots(tree)
    evaluated = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [node.module or ""] if isinstance(node, ast.ImportFrom) else [alias.name for alias in node.names]
            assert not any(name.split(".")[0] in {"pytest", "music_app", "config"} for name in names)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            evaluated.extend(node.decorator_list)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                evaluated.extend(node.args.defaults)
                evaluated.extend(value for value in node.args.kw_defaults if value is not None)
            else:
                evaluated.extend(node.bases)
                evaluated.extend(keyword.value for keyword in node.keywords)
                evaluated.extend(child for child in node.body if not isinstance(
                    child, (ast.FunctionDef, ast.AsyncFunctionDef)))
        elif isinstance(node, ast.If) and "__main__" in _strings(node.test):
            continue
        else:
            evaluated.append(node)
    names = set().union(*(_call_names(node) for node in evaluated)) if evaluated else set()
    for reachable in _reachable(tree, names):
        names.update(_call_names(_functions(tree)[reachable]))
    forbidden = {"subprocess.run", "subprocess.Popen", "subprocess.call", "os.system",
                 "os.popen", "os.fork", "socket.socket", "urllib.request.urlopen",
                 "requests.get", "requests.post", "pytest.main", "signal.signal",
                 "signal.raise_signal", "os.kill", "os.killpg", "time.sleep"}
    assert not names & forbidden, names & forbidden
    assert not any(name.rsplit(".", 1)[-1] in {"run_owned", "write_bytes", "write_text",
                   "unlink", "mkdir", "makedirs", "rmtree"} for name in names)
    # Hashing and safely loading the unchanged old helper are allowed read-only
    # operations, not product imports. Synthetic sentinels independently cover
    # import effects that alias dispatch can hide from a direct-name AST graph.


def test_s07_read_only_validation_seams_have_no_process_signal_network_or_write_calls():
    tree = _tree()
    functions = _functions(tree)
    reachable = _reachable(tree, PUBLIC_SEAMS)
    assert set(PUBLIC_SEAMS) <= reachable
    forbidden = {"run_owned", "open_connection", "urlopen", "urlretrieve", "sleep",
                 "Popen", "system", "popen", "fork", "kill", "killpg", "send_signal",
                 "connect", "send", "sendall", "request", "write_text", "write_bytes",
                 "unlink", "rename", "mkdir", "makedirs",
                 "rmdir", "rmtree", "chmod", "chown"}
    for function_name in reachable:
        for call in _calls(functions[function_name]):
            name = _name(call.func)
            assert name.rsplit(".", 1)[-1] not in forbidden, (function_name, name)
            if name == "open" or name.endswith(".open"):
                modes = [item.value for item in call.args[1:] if isinstance(item, ast.Constant) and isinstance(item.value, str)]
                modes += [item.value.value for item in call.keywords if item.arg == "mode"
                          and isinstance(item.value, ast.Constant) and isinstance(item.value.value, str)]
                assert all(not set(mode) & set("wax+") for mode in modes), (function_name, modes)
    # This static direct-name graph is backed by synthetic host-effect/import
    # sentinels. It cannot substitute for reviewing alias/dispatch reachability.


def test_s07_isolated_child_source_has_real_file_loaders_and_inert_namespace_shells():
    trees = _embedded_trees(_tree())
    values = set().union(*(_strings(tree) for tree in trees))
    calls = set().union(*(_call_names(tree) for tree in trees))
    assert {"music_app", "music_app.services", "music_app.services.foobar_snapshot_parser",
            "music_app.services.foobar_snapshot_preview"} <= values
    assert any(name.endswith("ModuleType") for name in calls)
    assert any(name.endswith("spec_from_file_location") for name in calls)
    assert any(name.endswith("module_from_spec") for name in calls)
    assert any(name.endswith("exec_module") for name in calls)
    assert any(isinstance(node, ast.Attribute) and node.attr == "__file__"
               for tree in trees for node in ast.walk(tree)) or "__file__" in values
    assert any(isinstance(node, ast.Compare) and any(isinstance(op, (ast.In, ast.NotIn)) for op in node.ops)
               and any(_name(item) == "sys.modules" for item in ast.walk(node))
               for tree in trees for node in ast.walk(tree)), "Preexisting product module state must be checked"
    assert any(name.endswith("sha256") for name in calls)
    # Actual parser-before-preview load, actual __file__, inert-shell binding,
    # preexisting-module refusal and rehash-before-each-child require tracing
    # the real CLI/child path. Source tokens alone never certify those effects.


def test_s07_pytest_isolation_and_complete_phase_capture_remain_explicit():
    trees = _embedded_trees(_tree())
    values = set().union(*(_strings(tree) for tree in trees))
    assert {"PYTEST_DISABLE_PLUGIN_AUTOLOAD", "--noconftest", "--import-mode=importlib",
            "no:cacheprovider", "-p", "wasxfail", "setup", "call", "teardown",
            "discovered_nodeids", "deselected_nodeids", "collection_errors"} <= values
    functions = {node.name for tree in trees for node in ast.walk(tree)
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert {"pytest_deselected", "pytest_collectreport", "pytest_runtest_logreport"} <= functions
    # No fixture edits or resource-budget lowering is possible without breaking
    # the immutable hashes; no helper/reconcile product import is authorized.
    assert any("faulthandler" in value for value in values) or any(
        name.endswith("faulthandler.enable") for tree in trees for name in _call_names(tree))


# S08: exact named transfer identity and storage limits; no provenance oracle.
def test_s08_uploads_use_exact_fresh_head_run_attempt_job_names():
    for name, job in _jobs().items():
        uploads = [step for step in _steps(job) if re.search(r"uses:\s*actions/upload-artifact@", step)]
        assert len(uploads) == 1, name
        upload = uploads[0]
        expected = "preview-v1-${{ github.event.pull_request.head.sha }}-${{ github.run_id }}-${{ github.run_attempt }}-" + name
        assert _unquote(_field(upload, "name", 10, "")) == expected, name
        assert "always()" in _condition(upload, 8), name
        assert _field(upload, "if-no-files-found", 10) == "error", name
        assert _field(upload, "overwrite", 10, "false") == "false", name
        assert "continue-on-error" not in upload
        if name != "admission":
            assert _step_timeout(upload) <= OVERHEAD["upload"]


def test_s08_download_actions_never_use_wildcards_merge_or_other_run_context():
    for consumer, job in _jobs().items():
        for step in _steps(job):
            if not re.search(r"uses:\s*actions/download-artifact@", step):
                continue
            assert _field(step, "pattern", 10) is None, consumer
            assert _field(step, "merge-multiple", 10, "false") == "false", consumer
            run_id = _field(step, "run-id", 10)
            assert run_id in (None, "${{ github.run_id }}"), consumer
            repository = _field(step, "repository", 10)
            assert repository in (None, "${{ github.repository }}", "idanilovqa/AlbumHaven"), consumer
            name = _field(step, "name", 10)
            artifact_ids = _field(step, "artifact-ids", 10)
            assert (name is None) != (artifact_ids is None), consumer
            if name is not None:
                prefix = "preview-v1-${{ github.event.pull_request.head.sha }}-${{ github.run_id }}-${{ github.run_attempt }}-"
                assert _unquote(name).startswith(prefix), consumer
                assert _unquote(name)[len(prefix):] in JOBS[:-1], consumer
            else:
                assert artifact_ids and not any(character in artifact_ids for character in ("*", "?", ",")), consumer
    # Artifact-ID selection is still required to derive producer and attempt
    # externally. Same-name files or matching self-declarations are insufficient.


def test_s08_adapter_carries_all_identity_provenance_and_raw_container_dimensions():
    values = _strings(_tree())
    assert {"repository", "head_sha", "checkout_head", "workflow_path", "workflow_sha256",
            "plan_sha256", "run_id", "run_attempt", "producer_job", "artifact_name",
            "artifact_id", "provenance", "source_hashes", "cancelled",
            "admission_sha256", "helper_receipt_sha256", "canonical_core_sha256",
            "predecessor_receipt_sha256", "inventory.json", "complete.json", "receipt.json",
            "inventory_sha256", "receipt_sha256", "writer_complete", "size", "sha256",
            "raw_log", "reports_json", "junit_xml"} <= values
    assert {"foobar-preview-inventory-v1", "foobar-preview-complete-v1",
            "foobar-preview-evidence-v1", "supplemental-only"} <= values
    assert any(value.startswith("preview-v1-") for value in values)


def test_s08_exact_stream_file_count_and_aggregate_ceilings_are_consumed():
    values = _strings(_tree())
    for key in ("artifact_bytes", "artifact_files", "file_bytes", "aggregate_bytes", "aggregate_files"):
        assert _plan()["limits"][key] == LIMITS[key]
        assert key in values, ("Limit must be consumed by adapter source", key)
    assert {"size_limit", "inventory", "path", "writer"} <= values
    tree = _tree()
    functions = _functions(tree)
    read_calls = []
    for name in _reachable(tree, PUBLIC_SEAMS, stop_at=_old_loader_names(tree)):
        for call in _calls(functions[name]):
            method = _name(call.func).rsplit(".", 1)[-1]
            if method in {"read", "read1"}:
                assert call.args or any(keyword.arg in {"size", "n"} for keyword in call.keywords), (
                    "Evidence reads must be bounded before consumption", name)
                for arg in call.args[:1]:
                    if isinstance(arg, ast.Constant):
                        assert type(arg.value) is int and arg.value > 0, name
                read_calls.append(call)
            assert method not in {"read_bytes", "read_text"}, (
                "An unbounded convenience read cannot prove before-consumption limits", name)
            if method == "readinto":
                assert call.args
                read_calls.append(call)
    assert read_calls, "A bounded evidence reader must be visible to the validation seams"
    # Counted-stream mutation tests exercise actual limits. Source review must
    # separately trace the transfer/decoder before materializing excess bytes.


def test_s08_no_reconcile_discovery_of_arbitrary_artifact_owner_directories():
    tree = _tree()
    function = _functions(tree)["reconcile_artifacts"]
    assert not any(name.endswith((".rglob", ".glob")) for name in _call_names(function))
    values = _strings(tree)
    assert set(JOBS) <= values
    assert {"missing_owner", "duplicate_owner", "provenance", "identity", "source_hash"} <= values
    assert {"full_discovered_ids", "full_final_ids", "collection_sha256", "invocation_ids"} <= values
    # A bounded inventory walk within one declared owner is distinct from
    # recursive discovery of arbitrary owner artifacts and is not forbidden.


# S09: real public validator seams, fixed CLI, no selector escape.
def test_s09_exact_three_public_seam_signatures_without_hidden_arguments():
    definitions = _functions(_tree())
    for name, (positional, keyword_only) in PUBLIC_SEAMS.items():
        function = definitions[name]
        assert not isinstance(function, ast.AsyncFunctionDef), name
        args = function.args
        assert tuple(arg.arg for arg in (*args.posonlyargs, *args.args)) == positional, name
        assert tuple(arg.arg for arg in args.kwonlyargs) == keyword_only, name
        assert args.vararg is None and args.kwarg is None, name
        assert not args.defaults and all(value is None for value in args.kw_defaults), name


def test_s09_guarded_cli_reaches_actual_reviewed_validators_not_test_only_copies():
    tree = _tree()
    reachable = _reachable(tree, _main_roots(tree))
    assert set(PUBLIC_SEAMS) <= reachable, ("CLI must use all three reviewed validation kernels", reachable)
    assert all(name in _call_names(tree) for name in PUBLIC_SEAMS)
    assert not any(isinstance(node, ast.ImportFrom) and node.module == "pytest"
                   for node in tree.body)
    # Direct-name reachability is a useful structural guard, not proof that an
    # unreachable branch, arbitrary dispatch table or fabricated caller context
    # cannot bypass the kernels. The executable control flow must be reviewed.


def test_s09_cli_declares_only_fixed_four_modes_and_reviewed_options():
    tree = _tree()
    options, declared_modes = set(), set()
    for call in _calls(tree):
        name = _name(call.func)
        if name.endswith(".add_argument"):
            for argument in call.args:
                if isinstance(argument, ast.Constant) and isinstance(argument.value, str) and argument.value.startswith("-"):
                    options.add(argument.value)
            for keyword in call.keywords:
                if keyword.arg == "choices":
                    sequence = _literal_sequence(keyword.value)
                    if sequence is not None and set(sequence) & {"helper", "core", "resource", "reconcile"}:
                        assert set(sequence) == {"helper", "core", "resource", "reconcile"}
                        declared_modes.update(sequence)
        elif name.endswith(".add_parser") and call.args:
            assert isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str)
            declared_modes.add(call.args[0].value)
    assert declared_modes == {"helper", "core", "resource", "reconcile"}
    assert options == COMMON_OPTIONS | EXTRA_OPTIONS
    assert not any("selector" in option or "timeout" in option or "retry" in option for option in options)


def test_s09_each_actual_workflow_command_has_exact_phase_options_and_context():
    jobs = _jobs()
    for name in JOBS[1:]:
        phase = "resource" if name.startswith("resource_") else name
        commands = _adapter_steps(jobs[name], phase)
        assert len(commands) == 1, name
        command = _run(commands[0][1])
        options = set(re.findall(r"(?<!\S)(--[a-z][a-z-]*)(?=\s|=|$)", command))
        expected = set(COMMON_OPTIONS)
        if phase in {"core", "resource", "reconcile"}:
            expected.add("--helper-evidence")
        if phase == "resource":
            expected.update(("--shard-index", "--canonical-core-evidence", "--predecessor-evidence"))
        elif phase == "reconcile":
            expected.add("--input-dir")
        assert options == expected, (name, options, expected)
        assert PLAN in command, name
        for context in ("github.event.pull_request.head.sha", "github.run_id", "github.run_attempt"):
            assert context in command or context in commands[0][1], (name, context)
        assert "continue-on-error" not in commands[0][1]


# S10: no shard-local result or missing final artifact can imply global success.
def test_s10_reconcile_runs_after_all_seven_jobs_even_on_failure_not_cancellation():
    job = _jobs()["reconcile"]
    assert set(_needs(job)) == set(JOBS[:-1])
    condition = _condition(job, 4)
    assert "always()" in condition and "!cancelled()" in condition
    assert "success()" not in condition
    assert not re.search(r"needs\.[a-z0-9_]+\.(?:result|outputs)", condition), (
        "Missing/failed upstream evidence needs truthful reconciliation, not a skipped summary")
    assert "--input-dir" in job and "--helper-evidence" in job
    assert not re.search(r"\bpip\s+install\b|\bpytest\b|bootstrap-linux|postgres", job)
    assert not _adapter_steps(job, "core") and not _adapter_steps(job, "resource") and not _adapter_steps(job, "helper")


def test_s10_global_accounting_has_truthful_nonpass_and_unproven_completion_vocabulary():
    values = _strings(_tree())
    assert {"foobar-preview-validation-v1", "authority", "supplemental-only", "kind",
            "global", "expected_ids", "observed_ids", "nodes", "owners", "status",
            "continue_allowed", "errors", "job_id", "completion", "cause", "unproven",
            "passed", "failed", "timed_out", "unrun", "unknown", "incomplete",
            "assertion_failed", "timed_out_safe", "collection_failed", "identity_failed",
            "helper_failed", "cancelled", "cleanup_unsafe", "evidence_invalid", "writer_uncertain",
            "global_ownership", "invocation_nonzero_exit"} <= values
    # Behavioral tests, not vocabulary, establish multiplicity-one, accepted
    # observations only and no invented 380-node collection or uploaded result.


def test_s10_final_result_has_a_bounded_failure_preserving_actual_upload_step():
    job = _jobs()["reconcile"]
    steps = _steps(job)
    execution = _adapter_steps(job, "reconcile")
    assert len(execution) == 1
    uploads = [(index, step) for index, step in enumerate(steps)
               if re.search(r"uses:\s*actions/upload-artifact@", step)]
    assert len(uploads) == 1 and execution[0][0] < uploads[0][0]
    upload = uploads[0][1]
    assert "always()" in _condition(upload, 8)
    assert _step_timeout(upload) <= OVERHEAD["upload"]
    assert _field(upload, "if-no-files-found", 10) == "error"
    assert _field(upload, "path", 10), "No upload can be inferred from a summary/step label"
    assert "continue-on-error" not in job
    # Only separately authorized hosted evidence can establish this step's
    # actual successful transfer. An absent/cancelled reconciler stays unknown.


def test_s08_cli_does_not_directly_feed_receipt_derived_expected_context_to_seams():
    """Reject visible receipt-to-authority flows, without an origin oracle.

    This catches ordinary assignments/copies in a function. It deliberately
    makes no claim about arbitrary aliasing or the historic origin of two
    value-identical dicts: the full transfer/context path still needs review.
    """
    tree = _tree()
    receipt_constants = {target.id for node in tree.body if isinstance(node, ast.Assign)
                         and isinstance(node.value, ast.Constant) and node.value.value == "receipt.json"
                         for target in node.targets if isinstance(target, ast.Name)}
    for function in _functions(tree).values():
        tainted = set()

        def receipt_derived(expression):
            names = {node.id for node in ast.walk(expression) if isinstance(node, ast.Name)}
            return "receipt.json" in _strings(expression) or bool(names & (tainted | receipt_constants))

        changed = True
        while changed:
            before = set(tainted)
            for node in ast.walk(function):
                if not isinstance(node, (ast.Assign, ast.AnnAssign)) or node.value is None:
                    continue
                if receipt_derived(node.value):
                    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                    for target in targets:
                        tainted.update(item.id for item in ast.walk(target) if isinstance(item, ast.Name))
            changed = before != tainted
        for call in _calls(function):
            if _name(call.func) not in {"validate_artifact", "reconcile_artifacts"}:
                continue
            expected = next((keyword.value for keyword in call.keywords if keyword.arg == "expected"), None)
            assert expected is not None, "Production caller must supply independently grounded expected context"
            assert not receipt_derived(expected), (
                "Receipt-derived identity cannot be the authority used to validate that receipt", function.name)


# Source-helper regressions for the R1 review. These use only literal strings;
# they add no adapter API, workflow implementation or product import.
def test_source_jobs_inventory_hyphenated_owners_and_reject_unsupported_forms():
    prefix = "\nname: source regression\njobs:\n  known:\n    runs-on: ubuntu-24.04\n"
    extra = "  extra-job:\n    runs-on: ubuntu-24.04\n"
    jobs = _jobs(prefix + extra)
    assert tuple(jobs) == ("known", "extra-job")
    assert "extra-job" not in jobs["known"]
    assert jobs["extra-job"] == extra
    for declaration in ("  'extra-job':", "  extra-job: {runs-on: ubuntu-24.04}",
                        "  extra-job: *owner", "  <<: *owners", "  known:"):
        try:
            _jobs(prefix + declaration + "\n")
        except AssertionError:
            pass
        else:
            raise AssertionError("Unsupported/duplicate job owner was silently accepted: " + declaration)


def test_source_steps_inventory_shell_env_and_timeout_first_keys():
    job = (
        "  known:\n    steps:\n"
        "      - name: first\n        run: echo first\n        timeout-minutes: 1\n"
        "      - shell: bash\n        run: echo second\n        timeout-minutes: 2\n"
        "      - env:\n          EXAMPLE: value\n        run: echo third\n        timeout-minutes: 3\n"
        "      - timeout-minutes: 4\n        run: echo fourth\n"
        "    env:\n      LATER_JOB_FIELD: value\n"
    )
    steps = _steps(job)
    assert len(steps) == 4
    assert [_run(step) for step in steps] == ["echo first", "echo second", "echo third", "echo fourth"]
    assert [_step_timeout(step) for step in steps] == [60, 120, 180, 240]
    assert all("LATER_JOB_FIELD" not in step for step in steps)


def test_source_steps_reject_uninspectable_items_instead_of_absorbing_them():
    prefix = "  known:\n    steps:\n      - run: echo first\n        timeout-minutes: 1\n"
    for item in ("      - *step\n", "      - {run: echo hidden}\n",
                 "      -\n        run: echo hidden\n", "      - 'run': echo hidden\n"):
        try:
            _steps(prefix + item)
        except AssertionError:
            pass
        else:
            raise AssertionError("Unsupported step-list item was silently accepted: " + item)
    for steps_value in ("[*step]", "*steps"):
        try:
            _steps("  known:\n    steps: " + steps_value + "\n")
        except AssertionError:
            pass
        else:
            raise AssertionError("Unsupported steps declaration was silently accepted: " + steps_value)


def test_source_permissions_reject_inline_write_and_uninspectable_overrides():
    prefix = "\npermissions:\n  contents: read\njobs:\n  known:\n"
    safe = "    permissions:\n      contents: read\n"
    _assert_read_only_permissions(prefix + safe)
    for override in (
            "    permissions: {contents: write}\n",
            "    permissions: {contents: read}\n",
            "    permissions: *read_only\n",
            "    permissions: ${{ inputs.permissions }}\n",
            "    permissions: write-all\n",
            "    permissions:\n      contents: write\n",
            "    permissions:\n      contents: read\n      actions: write\n",
            "    permissions:\n      <<: *read_only\n      contents: read\n",
            "    permissions:\n      contents: *read\n",
            "    'permissions': {contents: write}\n",
            '    "permiss\\u0069ons": {contents: write}\n',
            "    ? permissions\n    : {contents: write}\n",
            "    <<: *permission_override\n"):
        try:
            _assert_read_only_permissions(prefix + override)
        except AssertionError:
            pass
        else:
            raise AssertionError("Unsupported/writable permissions were silently accepted: " + override)
    for top in ("permissions: {contents: write}", "permissions: *read_only"):
        try:
            _assert_read_only_permissions("\n" + top + "\njobs:\n  known:\n" + safe)
        except AssertionError:
            pass
        else:
            raise AssertionError("Unsupported top-level permissions were silently accepted: " + top)


def test_source_condition_accepts_first_key_if_without_yaml_key_order_requirement():
    job = (
        "  known:\n    steps:\n"
        "      - if: always() && !cancelled()\n"
        "        uses: actions/upload-artifact@v4\n        timeout-minutes: 3\n"
        "      - uses: actions/upload-artifact@v4\n"
        "        if: always() && !cancelled()\n        timeout-minutes: 3\n"
    )
    first, reordered = _steps(job)
    assert _condition(first, 8) == _condition(reordered, 8) == "always()&&!cancelled()"
    assert _field(first, "uses", 8) == _field(reordered, "uses", 8) == "actions/upload-artifact@v4"
    assert _step_timeout(first) == _step_timeout(reordered) == 180
    assert _run("      - run: echo source-only\n") == "echo source-only"
