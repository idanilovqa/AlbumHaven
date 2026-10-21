"""Independent preview evidence oracles. Synthetic files only; no product execution."""
from __future__ import annotations

import builtins
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = "scripts/ci/foobar_preview_evidence.py"
OLD = "scripts/ci/new_feature_evidence.py"
ADMIT = "scripts/ci/admit-new-feature-evidence.py"
PLAN = "scripts/ci/foobar_preview_plan.json"
WORKFLOW = ".github/workflows/foobar-preview-backend-evidence.yml"
SUPERVISOR_SHA = "8f45a3c1c3ada77a817928463527fb4add58f57f70a2d3f24cc9187cf5fb3673"
REPO = "idanilovqa/AlbumHaven"
HEAD = "a" * 40
CORE = "tests/py/test_foobar_snapshot_preview.py"
RESOURCE = "tests/py/test_foobar_snapshot_preview_resources.py"
SELECTORS = [CORE, RESOURCE]
LEGACY = ["tests/py/test_new_feature_ci_contract.py", "tests/py/test_new_feature_evidence.py"]
HELPER = ["tests/py/test_foobar_preview_ci_contract.py", "tests/py/test_foobar_preview_evidence.py"]
CONTROLS = [WORKFLOW, ".github/workflows/new-feature-backend-evidence.yml", ADMIT, OLD, ADAPTER, PLAN, *LEGACY, *HELPER]
PRODUCTS = ["music_app/services/foobar_snapshot_parser.py", "music_app/services/foobar_snapshot_preview.py", *SELECTORS]
JOBS = ["admission", "helper", "core", "resource_1", "resource_2", "resource_3", "resource_4", "reconcile"]
REUSE = ["run_owned", "process_success", "node_list", "timestamp", "owned_file"]
RESOURCE_IDS = [
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
]
CORE_IDS = [CORE + "::test_synthetic_case[" + str(index) + "]" for index in range(380)]
FULL_IDS = CORE_IDS + RESOURCE_IDS
ERROR_CODES = set("schema plan identity provenance source_hash admission helper_proof predecessor inventory path size_limit writer collection selection invocation phase junit process deadline cancellation cleanup missing_owner duplicate_owner global_ownership assertion_failed timed_out".split())
STATUSES = set("passed assertion_failed timed_out_safe collection_failed identity_failed helper_failed cancelled cleanup_unsafe evidence_invalid writer_uncertain incomplete".split())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def raw_json(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw_json(value))


def get(path):
    return json.loads(path.read_bytes())


def when(seconds):
    return (datetime(2026, 10, 21, tzinfo=timezone.utc) + timedelta(seconds=seconds)).isoformat()


def plan_record():
    return {"schema_version": "foobar-preview-plan-v1", "workflow_path": WORKFLOW, "lane": "foobar-preview",
            "selectors": SELECTORS[:], "legacy_helper_selectors": LEGACY[:], "helper_selectors": HELPER[:],
            "core_count": 380, "resource_ids": RESOURCE_IDS[:],
            "shards": [{"index": i, "job": "resource_" + str(i), "assigned_ids": RESOURCE_IDS[(i-1)*9:i*9]} for i in range(1, 5)],
            "reuse": {"path": OLD, "sha256": SUPERVISOR_SHA, "callables": REUSE[:]},
            "limits": {"collection_seconds": 300, "core_seconds": 600, "resource_seconds": 300,
                       "helper_collection_seconds": 60, "helper_runtime_seconds": 180, "term_seconds": 30,
                       "kill_reap_seconds": 30, "git_seconds": 10, "artifact_bytes": 268435456,
                       "artifact_files": 4096, "file_bytes": 33554432, "aggregate_bytes": 2147483648,
                       "aggregate_files": 32768},
            "job_minutes": {"admission": 2, "helper": 40, "core": 45,
                            **{"resource_" + str(i): 90 for i in range(1, 5)}, "reconcile": 15},
            "overhead_seconds": {"checkout": 120, "setup_python": 300, "install": 300, "download": 120,
                                 "verify": 120, "finalize": 120, "upload": 180}}


def artifact_name(owner):
    return "preview-v1-" + HEAD + "-200-2-" + owner


def expected_record(plan, owner):
    hashes = {path: sha(("synthetic admitted source " + path).encode()) for path in CONTROLS + PRODUCTS}
    hashes[OLD] = SUPERVISOR_SHA
    hashes[PLAN] = sha(raw_json(plan))
    return {"repository": REPO, "head_sha": HEAD, "checkout_head": HEAD,
            "workflow_path": WORKFLOW, "workflow_sha256": hashes[WORKFLOW], "plan_sha256": hashes[PLAN],
            "run_id": 200, "run_attempt": 2, "producer_job": owner, "cancelled": False,
            "source_hashes": hashes,
            "provenance": [{"producer_job": job, "artifact_name": artifact_name(job), "artifact_id": 700+i,
                            "repository": REPO, "head_sha": HEAD, "workflow_path": WORKFLOW,
                            "run_id": 200, "run_attempt": 2} for i, job in enumerate(JOBS[:-1])]}


def phase_reports(nodes):
    return {"schema_version": 1, "reports": [{"nodeid": node, "when": phase, "outcome": "passed", "wasxfail": None}
            for node in nodes for phase in ("setup", "call", "teardown")]}


def junit(nodes, failed=()):
    failed = set(failed)
    cases = ''.join('<testcase name="synthetic-' + str(i) + '">' +
                    ('<failure message="synthetic assertion" />' if node in failed else '') + '</testcase>'
                    for i, node in enumerate(nodes))
    return ('<testsuites tests="' + str(len(nodes)) + '" failures="' + str(len(failed)) + '" errors="0" skipped="0">'
            '<testsuite tests="' + str(len(nodes)) + '" failures="' + str(len(failed)) + '" errors="0" skipped="0">' +
            cases + '</testsuite></testsuites>').encode()


def process(directory, identity, argv, seconds, start):
    relative = identity + ".log"
    path = directory / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((HEAD+"\n").encode() if list(argv) == ["git", "rev-parse", "HEAD"] else b"synthetic retained stdout and stderr\n")
    return {"id": identity, "argv": list(argv), "started_at": when(start), "finished_at": when(start+1),
            "exit_code": 0, "timed_out": False, "cleanup_complete": True, "writer_errors": [], "cancelled": False,
            "raw_log": relative, "limits": {"runtime_seconds": seconds, "term_seconds": 30, "kill_reap_seconds": 30},
            "supervisor_sha256": SUPERVISOR_SHA}


def invocation(directory, nodes, identity="run", *, seconds=600, start=4):
    record = process(directory, identity, [sys.executable, "-m", "pytest", "--noconftest", "--import-mode=importlib",
                                         "-p", "no:cacheprovider", *nodes], seconds, start)
    record.update(selected_nodeids=list(nodes), reports_json=identity+".json", junit_xml=identity+".xml")
    put(directory / record["reports_json"], phase_reports(nodes))
    (directory / record["junit_xml"]).write_bytes(junit(nodes))
    return record


def collection(directory, nodes, selectors, identity="collection", *, seconds=300, start=2, legacy=False):
    data = {"schema_version": 1, "discovered_nodeids": list(nodes), "nodeids": list(nodes),
            "deselected_nodeids": [], "collection_errors": []}
    proc = process(directory, identity, [sys.executable, "-m", "pytest", "--collect-only", "--noconftest",
                                        "--import-mode=importlib", "-p", "no:cacheprovider", *selectors], seconds, start)
    if legacy:
        # Unchanged legacy collection.json has the supervisor fields, not a new envelope version.
        data.pop("schema_version")
        data.update({key: value for key, value in proc.items() if key not in {"id", "limits", "supervisor_sha256"}})
        data["raw_log"] = "collection.log"
    relative = identity + ".json"
    put(directory / relative, data)
    return {"path": relative, "sha256": sha((directory / relative).read_bytes()), "selectors": list(selectors), "process": proc}


def admission_files(directory):
    trigger = {"repository": REPO, "number": 23, "branch": "2026-10-03-album-tops", "head_sha": HEAD,
               "draft": True, "control_labels": ["ci:full-review"], "all_labels": ["ci:full-review"]}
    names = ["PR Review Scope", "Review Prerequisites", "JavaScript Tests (Portable)", "Component Tests (Pinned Chrome)",
             "JavaScript Tests (Windows Contract)", "Python Tests"]
    jobs = [{"id": i+1, "name": name, "status": "completed", "conclusion": "success",
             "started_at": when(0), "completed_at": when(1), "run_id": 100, "run_attempt": 2,
             "head_sha": HEAD, "head_branch": "2026-10-03-album-tops", "workflow_name": "PR Gates"} for i, name in enumerate(names)]
    record = {"schema_version": 1, "decision": "admit", "reason_codes": [], "observed_at": when(0),
              "authority": "supplemental-only", "coverage": "unproven", "trigger": trigger,
              "current": copy.deepcopy(trigger), "native": {"id": 100, "run_number": 77, "attempt": 2,
              "workflow_id": 7, "head_sha": HEAD, "status": "completed", "conclusion": "failure", "jobs": jobs}, "inspected": []}
    put(directory / "admission.json", record)
    digest = sha((directory / "admission.json").read_bytes())
    put(directory / "admission-context.json", {"schema_version": 1, "repository": REPO, "head_sha": HEAD,
         "run_id": 200, "attempt": 2, "admission_sha256": digest})
    return digest


def seal(directory):
    files = []
    for path in sorted(directory.rglob("*")):
        if path.is_file() and path.relative_to(directory).as_posix() not in {"inventory.json", "complete.json"}:
            data = path.read_bytes()
            files.append({"path": path.relative_to(directory).as_posix(), "size": len(data), "sha256": sha(data)})
    put(directory / "inventory.json", {"schema_version": "foobar-preview-inventory-v1", "files": files})
    put(directory / "complete.json", {"schema_version": "foobar-preview-complete-v1", "writer_complete": True,
         "inventory_sha256": sha((directory / "inventory.json").read_bytes()),
         "receipt_sha256": sha((directory / "receipt.json").read_bytes())})


def make_world(directory):
    directory.mkdir()
    plan = plan_record()
    expected = expected_record(plan, "reconcile")
    adigest = admission_files(directory / "admission")
    receipts = {}
    for owner in JOBS[1:-1]:
        dest = directory / owner
        dest.mkdir()
        admission_files(dest / "admission")
        index = JOBS.index(owner)
        start = index * 1000
        phase = "helper" if owner == "helper" else "core" if owner == "core" else "resource"
        selectors = HELPER if phase == "helper" else SELECTORS
        nodes = [path + "::test_synthetic[one]" for path in HELPER] if phase == "helper" else FULL_IDS
        assigned = nodes[:] if phase == "helper" else CORE_IDS[:] if phase == "core" else RESOURCE_IDS[(index-3)*9:(index-2)*9]
        col = collection(dest, nodes, selectors, "preview/collection" if phase == "helper" else "collection",
                         seconds=60 if phase == "helper" else 300, start=start+8 if phase == "helper" else start+2)
        runtime = [invocation(dest, assigned, "preview/run", seconds=180, start=start+10)] if phase == "helper" else (
                  [invocation(dest, assigned, "core", seconds=600, start=start+4)] if phase == "core" else
                  [invocation(dest, [node], "resource-"+str(i), seconds=300, start=start+4+i*2) for i, node in enumerate(assigned)])
        git = [process(dest, "git", ["git", "rev-parse", "HEAD"], 10, start)]
        helper_proofs = None
        if phase == "helper":
            legacy_nodes = [path+"::test_synthetic[old]" for path in LEGACY]
            old_col = collection(dest, legacy_nodes, LEGACY, "legacy/collection", seconds=60, start=start+2, legacy=True)
            old_inv = invocation(dest, legacy_nodes, "legacy/run-0", seconds=180, start=start+4)
            old_identity = {"schema_version": 1, "lane": "ci-helper", "head_sha": HEAD, "checkout_head": HEAD,
                            "run_id": 200, "attempt": 2, "authority": "supplemental-only", "python_version": "3.11.10",
                            "selectors": LEGACY[:], "file_hashes": {p: expected["source_hashes"][p] for p in [*LEGACY, OLD, ADMIT]},
                            "admission_sha256": adigest}
            put(dest / "legacy/identity.json", old_identity)
            admission_files(dest / "legacy")
            # Preserve the legacy raw invocation record shape separately from its new enclosing reference.
            legacy_record = {k: v for k, v in old_inv.items() if k not in {"limits", "supervisor_sha256"}}
            legacy_record.update(id="run-0", raw_log="run-0.log", reports_json="run-0.json", junit_xml="run-0.xml")
            put(dest / "legacy/invocations.json", [legacy_record])
            # Retain the unchanged legacy capture envelopes and checkout process, not a synthetic summary substitute.
            legacy_capture = {"schema_version": 1, "discovered_nodeids": legacy_nodes[:], "nodeids": legacy_nodes[:],
                              "deselected_nodeids": [], "collection_errors": [], "reports": []}
            put(dest / "legacy/collection.capture.json", legacy_capture)
            legacy_capture["reports"] = phase_reports(legacy_nodes)["reports"]
            put(dest / "legacy/run-0.json", legacy_capture)
            (dest / "git.log").unlink()
            git[0] = process(dest, "legacy/checkout", ["git", "rev-parse", "HEAD"], 10, start)
            (dest / "legacy/checkout.log").write_bytes((HEAD+"\n").encode())
            put(dest / "legacy/checkout-process.json", {key: value for key, value in git[0].items()
                if key not in {"id", "raw_log", "limits", "supervisor_sha256"}})
            put(dest / "legacy/reconciliation.json", {"schema_version": 1, "status": "pass", "authority": "supplemental-only",
                "errors": [], "expected_nodeids": legacy_nodes[:], "observed_nodeids": legacy_nodes[:]})
            put(dest / "preview/identity.json", {"schema_version": 1, "lane": "foobar-preview-helper", "repository": REPO,
                "head_sha": HEAD, "checkout_head": HEAD, "run_id": 200, "run_attempt": 2,
                "selectors": HELPER[:], "source_hashes": {p: expected["source_hashes"][p] for p in CONTROLS}, "admission_sha256": adigest})
            helper_proofs = {"legacy": {"selectors": LEGACY[:], "identity_path": "legacy/identity.json", "collection": old_col, "invocation": old_inv},
                             "preview": {"selectors": HELPER[:], "identity_path": "preview/identity.json", "collection": copy.deepcopy(col), "invocation": copy.deepcopy(runtime[0])}}
            git.append(process(dest, "preview/git", ["git", "rev-parse", "HEAD"], 10, start+6))
        receipt = {"schema_version": "foobar-preview-evidence-v1", "lane": "foobar-preview", "phase": phase,
                   "repository": REPO, "plan_sha256": expected["plan_sha256"], "head_sha": HEAD,
                   "workflow_path": WORKFLOW, "workflow_sha256": expected["workflow_sha256"], "run_id": 200, "run_attempt": 2,
                   "job_id": owner, "artifact_name": artifact_name(owner), "admission_sha256": adigest,
                   "helper_receipt_sha256": None, "canonical_core_sha256": None, "predecessor_receipt_sha256": None,
                   "source_hashes": {p: expected["source_hashes"][p] for p in (CONTROLS if phase == "helper" else CONTROLS+PRODUCTS)},
                   "selectors": list(selectors), "collection_sha256": col["sha256"], "full_discovered_ids": list(nodes),
                   "full_final_ids": list(nodes), "collection_errors": [], "deselected_ids": [],
                   "shard_index": None if phase != "resource" else index-2, "shard_count": 4,
                   "assigned_ids": assigned, "invocation_ids": [r["id"] for r in runtime], "invocations": runtime,
                   "collection": col, "helper_proofs": helper_proofs, "git_operations": git, "claimed_status": "passed"}
        receipts[owner] = receipt
        put(dest / "receipt.json", receipt)
    world = SimpleNamespace(directory=directory, plan=plan, expected=expected)
    reseal_world(world)
    return world


def reseal_world(world):
    """Refresh only integrity/chain digests after an intended semantic mutation."""
    for owner in JOBS[1:-1]:
        directory = world.directory / owner
        if not (directory / "receipt.json").exists():
            continue
        r = get(directory / "receipt.json")
        if owner != "helper":
            r["helper_receipt_sha256"] = sha((world.directory / "helper/receipt.json").read_bytes())
        if owner.startswith("resource_"):
            r["canonical_core_sha256"] = sha((world.directory / "core/receipt.json").read_bytes())
            predecessor = "core" if owner == "resource_1" else "resource_"+str(int(owner[-1])-1)
            r["predecessor_receipt_sha256"] = sha((world.directory / predecessor / "receipt.json").read_bytes())
        put(directory / "receipt.json", r)
        seal(directory)


def assert_no_host_effects(attempts):
    assert not attempts, "Forbidden host-effect attempts were caught or escaped: " + repr(attempts)


def install_host_effect_sentinels(monkeypatch, attempts):
    """Record before raising, so a validator's ordinary-exception handler cannot hide effects."""
    original = builtins.__import__
    def reject(label):
        attempts.append(label)
        raise AssertionError("Validation must not perform " + label)
    def forbidden(label):
        def denied(*args, **kwargs):
            reject(label)
        return denied
    def safe_import(name, *args, **kwargs):
        if name.split(".")[0] in {"music_app", "config", "psycopg", "psycopg2", "sqlalchemy", "lastfm", "log_history"}:
            reject("product/config/provider/DB import: " + name)
        return original(name, *args, **kwargs)
    class NoSocket(socket.socket):
        def __new__(cls, *args, **kwargs):
            reject("socket.socket")
    monkeypatch.setattr(builtins, "__import__", safe_import)
    for name in ("Popen", "run", "call", "check_call", "check_output"):
        monkeypatch.setattr(subprocess, name, forbidden("subprocess." + name))
    for name in ("kill", "killpg", "system", "getpgid", "fork", "forkpty", "posix_spawn", "posix_spawnp",
                 "spawnl", "spawnle", "spawnlp", "spawnlpe", "spawnv", "spawnve", "spawnvp", "spawnvpe",
                 "execl", "execle", "execlp", "execlpe", "execv", "execve", "execvp", "execvpe"):
        monkeypatch.setattr(os, name, forbidden("os." + name), raising=False)
    for name in ("signal", "raise_signal", "pthread_kill"):
        monkeypatch.setattr(signal, name, forbidden("signal." + name), raising=False)
    monkeypatch.setattr(pytest, "main", forbidden("pytest.main"))
    original_spec = importlib.util.spec_from_file_location
    def safe_spec(name, location, *args, **kwargs):
        value = Path(location).as_posix()
        if "/music_app/" in value or value.endswith("/config.py"):
            reject("product file loader: " + value)
        return original_spec(name, location, *args, **kwargs)
    monkeypatch.setattr(importlib.util, "spec_from_file_location", safe_spec)
    monkeypatch.setattr(signal, "SIGKILL", getattr(signal, "SIGKILL", 9), raising=False)
    monkeypatch.setattr(socket, "socket", NoSocket)
    monkeypatch.setattr(socket, "create_connection", forbidden("socket.create_connection"))
    monkeypatch.setattr(time, "sleep", forbidden("time.sleep"))


@pytest.fixture(autouse=True)
def forbid_host_effects(monkeypatch):
    attempts = []
    install_host_effect_sentinels(monkeypatch, attempts)
    yield
    assert_no_host_effects(attempts)


@pytest.fixture
def adapter(monkeypatch):
    assert sha((ROOT / OLD).read_bytes()) == SUPERVISOR_SHA
    spec = importlib.util.spec_from_file_location("preview_evidence_under_test", ROOT / ADAPTER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def assessment(result, kind, *, status=None, codes=(), continuation=None):
    assert set(result) == {"schema_version", "authority", "kind", "status", "continue_allowed", "errors", "nodes", "expected_ids", "observed_ids", "owners"}
    assert result["schema_version"] == "foobar-preview-validation-v1"
    assert result["authority"] == "supplemental-only" and result["kind"] == kind
    assert result["status"] in STATUSES and type(result["continue_allowed"]) is bool
    if status is not None:
        assert result["status"] == status
    if continuation is not None:
        assert result["continue_allowed"] is continuation
    if codes:
        assert set(codes) & {error["code"] for error in result["errors"]}
    assert bool(result["errors"]) == (result["status"] != "passed")
    for error in result["errors"]:
        assert set(error) == {"code", "location", "message", "owner", "invocation_id", "nodeid"}
        assert error["code"] in ERROR_CODES and isinstance(error["location"], str)
        assert error["location"] == "" or error["location"].startswith("/")
        assert error["invocation_id"] is None or isinstance(error["invocation_id"], str)
        assert error["nodeid"] is None or isinstance(error["nodeid"], str)
        assert isinstance(error["message"], str) and error["message"]
        assert error["owner"] is None or error["owner"] in JOBS
    assert [node["nodeid"] for node in result["nodes"]] == result["expected_ids"]
    assert len(result["expected_ids"]) == len(set(result["expected_ids"]))
    for node in result["nodes"]:
        assert set(node) == {"nodeid", "owner", "status", "cause"}
        assert node["status"] in {"passed", "failed", "timed_out", "unrun", "unknown"}
        assert node["owner"] in JOBS
    passed = {node["nodeid"] for node in result["nodes"] if node["status"] == "passed"}
    assert result["observed_ids"] == [node for node in result["expected_ids"] if node in passed]
    assert len(result["observed_ids"]) == len(set(result["observed_ids"]))
    if kind == "invocation":
        assert result["owners"] == []
    if kind == "global":
        assert result["continue_allowed"] is False
        assert [x["job_id"] for x in result["owners"]] == JOBS
        assert result["owners"][-1]["completion"] == "unproven"
    for owner in result["owners"]:
        assert set(owner) == {"job_id", "status", "completion", "cause"}
        assert owner["completion"] in {"complete", "incomplete", "unproven"}
    return result


def leaf(adapter, directory, record, nodes, **expect):
    return assessment(adapter.validate_invocation(directory, record, assigned_ids=list(nodes), owner="core"), "invocation", **expect)


def artifact(adapter, world, owner, **expect):
    expected = copy.deepcopy(world.expected)
    expected["producer_job"] = owner
    inputs = {job: world.directory / job for job in JOBS[:JOBS.index(owner)]}
    return assessment(adapter.validate_artifact(world.directory / owner, plan=world.plan, expected=expected, inputs=inputs), "artifact", **expect)


def global_result(adapter, world, **expect):
    return assessment(adapter.reconcile_artifacts(world.directory, plan=world.plan, expected=world.expected), "global", **expect)


def leaf_fixture(tmp_path):
    nodes = CORE_IDS[:2]
    directory = tmp_path / "leaf"
    directory.mkdir()
    return directory, invocation(directory, nodes), nodes


def test_invocation_complete_pass_accounts_only_accepted_nodes(adapter, tmp_path):
    directory, record, nodes = leaf_fixture(tmp_path)
    before = copy.deepcopy(record)
    result = leaf(adapter, directory, record, nodes, status="passed", continuation=True)
    assert result["expected_ids"] == result["observed_ids"] == nodes
    assert result["nodes"] == [{"nodeid": node, "owner": "core", "status": "passed", "cause": None} for node in nodes]
    assert record == before


@pytest.mark.parametrize("phase", ["setup", "call", "teardown"])
@pytest.mark.parametrize("mutation", ["missing", "duplicate", "unknown-phase", "unknown-node", "missing-wasxfail"])
def test_phase_identity_and_exact_multiplicity_are_required(adapter, tmp_path, phase, mutation):
    directory, record, nodes = leaf_fixture(tmp_path)
    data = get(directory / record["reports_json"])
    index = next(i for i, report in enumerate(data["reports"]) if report["when"] == phase)
    if mutation == "missing": data["reports"].pop(index)
    elif mutation == "duplicate": data["reports"].append(copy.deepcopy(data["reports"][index]))
    elif mutation == "unknown-phase": data["reports"][index]["when"] = "collect"
    elif mutation == "unknown-node": data["reports"][index]["nodeid"] = CORE + "::unselected"
    else: del data["reports"][index]["wasxfail"]
    put(directory / record["reports_json"], data)
    result = leaf(adapter, directory, record, nodes, codes=("phase", "schema", "selection"), continuation=False)
    assert result["status"] != "passed" and result["observed_ids"] == []


@pytest.mark.parametrize("when", ["setup", "call", "teardown"])
@pytest.mark.parametrize("outcome,xfail", [("failed", None), ("skipped", None), ("skipped", "xfail"), ("passed", "XPASS")])
def test_nonpass_phase_is_not_hidden_by_successful_process_or_xml(adapter, tmp_path, when, outcome, xfail):
    directory, record, nodes = leaf_fixture(tmp_path)
    data = get(directory / record["reports_json"])
    target = next(report for report in data["reports"] if report["when"] == when)
    target.update(outcome=outcome, wasxfail=xfail)
    put(directory / record["reports_json"], data)
    result = leaf(adapter, directory, record, nodes, codes=("phase", "junit", "process"), continuation=False)
    assert result["status"] != "passed" and result["observed_ids"] == []


@pytest.mark.parametrize("content", [b"{", b"[]", b"null", b'{"schema_version":2,"reports":[]}',
    b'{"schema_version":true,"reports":[]}', b'{"schema_version":1,"reports":{}}',
    b'{"schema_version":1,"schema_version":1,"reports":[]}', b'{"schema_version":NaN,"reports":[]}',
    b'{"schema_version":1,"reports":[]} trailing', b'\xff', b'{"schema_version":1,"reports":[null]}'])
def test_report_json_bad_schema_and_ambiguous_encoding_fail_closed(adapter, tmp_path, content):
    directory, record, nodes = leaf_fixture(tmp_path)
    (directory / record["reports_json"]).write_bytes(content)
    result = leaf(adapter, directory, record, nodes, codes=("schema", "phase"), continuation=False)
    assert result["status"] != "passed"


@pytest.mark.parametrize("field", ["raw_log", "reports_json", "junit_xml"])
@pytest.mark.parametrize("mutation", ["missing", "empty", "parent", "absolute", "backslash", "drive", "unc", "dot"])
def test_proof_files_must_be_present_nonempty_and_confined(adapter, tmp_path, field, mutation):
    directory, record, nodes = leaf_fixture(tmp_path)
    path = directory / record[field]
    if mutation == "missing": path.unlink()
    elif mutation == "empty": path.write_bytes(b"")
    else:
        record[field] = {"parent": "../outside", "absolute": str(tmp_path / "outside"),
                         "backslash": "nested\\proof", "drive": "C:/proof", "unc": "//host/proof", "dot": "./proof"}[mutation]
    result = leaf(adapter, directory, record, nodes, codes=("path", "schema", "junit", "phase", "process"), continuation=False)
    assert result["status"] != "passed"


@pytest.mark.parametrize("content", [b"<", b"<wrong/>", b"<testsuite tests='2'/>",
    b"<!DOCTYPE testsuite [<!ENTITY external SYSTEM 'file:///denied'>]><testsuite>&external;</testsuite>",
    b"<testsuite><testcase/><testcase/><testcase/></testsuite>",
    b"<testsuite tests='2'><testcase><failure/></testcase><testcase/></testsuite>",
    b"<testsuite tests='2'><testcase><error/></testcase><testcase/></testsuite>",
    b"<testsuite tests='2'><testcase><skipped/></testcase><testcase/></testsuite>"])
def test_junit_structure_entities_cardinality_and_failure_elements_cannot_pass(adapter, tmp_path, content):
    directory, record, nodes = leaf_fixture(tmp_path)
    (directory / record["junit_xml"]).write_bytes(content)
    leaf(adapter, directory, record, nodes, codes=("junit", "schema"), continuation=False)


@pytest.mark.parametrize("attribute", ["tests", "failures", "errors", "skipped"])
@pytest.mark.parametrize("value", ["-1", "false", "NaN", "1.5", "999"])
def test_junit_each_aggregate_is_checked_not_only_testcase_count(adapter, tmp_path, attribute, value):
    directory, record, nodes = leaf_fixture(tmp_path)
    content = (directory / record["junit_xml"]).read_text()
    old = 'tests="2"' if attribute == "tests" else attribute+'="0"'
    content = content.replace(old, attribute+'="'+value+'"', 1)
    (directory / record["junit_xml"]).write_text(content)
    leaf(adapter, directory, record, nodes, codes=("junit",), continuation=False)


@pytest.mark.parametrize("field,value,codes", [
    ("exit_code", 1, ("process", "phase", "junit")), ("exit_code", None, ("process", "schema")),
    ("exit_code", False, ("process", "schema")), ("exit_code", 5, ("process",)),
    ("cleanup_complete", False, ("cleanup", "process")), ("cancelled", True, ("cancellation", "process")),
    ("writer_errors", ["short write"], ("writer", "process")), ("supervisor_sha256", "0"*64, ("source_hash", "process")),
    ("started_at", "2026-10-21T12:00:00", ("invocation", "schema")),
    ("finished_at", when(1), ("invocation", "deadline")), ("finished_at", when(665), ("deadline",)),
    ("argv", [], ("invocation", "schema")), ("argv", [1], ("invocation", "schema")),
    ("id", "", ("invocation", "schema"))])
def test_process_identity_outcome_time_and_command_fields_are_required(adapter, tmp_path, field, value, codes):
    directory, record, nodes = leaf_fixture(tmp_path)
    record[field] = value
    leaf(adapter, directory, record, nodes, codes=codes, continuation=False)


@pytest.mark.parametrize("field,value", [("runtime_seconds", 601), ("term_seconds", 31), ("kill_reap_seconds", 31),
                                         ("runtime_seconds", 0), ("term_seconds", True)])
def test_runtime_and_cleanup_limits_cannot_expand_or_use_boolean_numbers(adapter, tmp_path, field, value):
    directory, record, nodes = leaf_fixture(tmp_path)
    record["limits"][field] = value
    leaf(adapter, directory, record, nodes, codes=("deadline", "schema", "process"), continuation=False)


@pytest.mark.parametrize("mutation", ["duplicate", "missing", "extra", "reordered"])
def test_invocation_selection_matches_exact_caller_assignment(adapter, tmp_path, mutation):
    directory, record, nodes = leaf_fixture(tmp_path)
    if mutation == "duplicate": record["selected_nodeids"].append(nodes[0])
    elif mutation == "missing": record["selected_nodeids"].pop()
    elif mutation == "extra": record["selected_nodeids"].append(CORE+"::extra")
    else: record["selected_nodeids"].reverse()
    leaf(adapter, directory, record, nodes, codes=("selection", "invocation", "phase"), continuation=False)


def make_assertion_failure(directory, record, failed):
    data = get(directory / record["reports_json"])
    for report in data["reports"]:
        if report["nodeid"] in failed and report["when"] == "call": report["outcome"] = "failed"
    put(directory / record["reports_json"], data)
    (directory / record["junit_xml"]).write_bytes(junit(record["selected_nodeids"], failed))
    record["exit_code"] = 1


def make_timeout(directory, record):
    record.update(timed_out=True, exit_code=-15, cleanup_complete=True, junit_xml=None)
    put(directory / record["reports_json"], {"schema_version": 1, "reports": []})


def test_mixed_exit_one_keeps_other_successful_phases_unknown_not_accepted(adapter, tmp_path):
    directory, record, nodes = leaf_fixture(tmp_path)
    make_assertion_failure(directory, record, [nodes[0]])
    result = leaf(adapter, directory, record, nodes, status="assertion_failed", codes=("assertion_failed",), continuation=True)
    assert result["observed_ids"] == []
    assert result["nodes"] == [{"nodeid": nodes[0], "owner": "core", "status": "failed", "cause": "assertion_failed"},
                               {"nodeid": nodes[1], "owner": "core", "status": "unknown", "cause": "invocation_nonzero_exit"}]


@pytest.mark.parametrize("mutation", ["setup", "teardown", "exit2", "xml-count", "xfail", "cleanup", "writer"])
def test_false_assertion_failure_continuation_is_held(adapter, tmp_path, mutation):
    directory, record, nodes = leaf_fixture(tmp_path)
    make_assertion_failure(directory, record, [nodes[0]])
    if mutation in {"setup", "teardown", "xfail"}:
        data = get(directory / record["reports_json"])
        target = next(x for x in data["reports"] if x["when"] == (mutation if mutation != "xfail" else "call"))
        if mutation == "xfail": target["wasxfail"] = "unexpected xpass"
        else: target["outcome"] = "failed"
        put(directory / record["reports_json"], data)
    elif mutation == "exit2": record["exit_code"] = 2
    elif mutation == "xml-count": (directory / record["junit_xml"]).write_bytes(junit(nodes))
    elif mutation == "cleanup": record["cleanup_complete"] = False
    else: record["writer_errors"] = ["unflushed"]
    result = leaf(adapter, directory, record, nodes, continuation=False)
    assert result["status"] != "passed" and result["observed_ids"] == []


@pytest.mark.parametrize("exit_code", [-15, -9, 0])
def test_safe_timeout_never_becomes_pass_even_when_parent_returns_zero(adapter, tmp_path, exit_code):
    directory, record, nodes = leaf_fixture(tmp_path)
    make_timeout(directory, record)
    record["exit_code"] = exit_code
    result = leaf(adapter, directory, record, nodes, status="timed_out_safe", codes=("timed_out",), continuation=True)
    assert result["observed_ids"] == []
    assert result["nodes"] == [{"nodeid": node, "owner": "core", "status": "timed_out", "cause": "timed_out"} for node in nodes]


@pytest.mark.parametrize("mutation", ["missing-report", "malformed-report", "unknown-report", "missing-referenced-xml", "malformed-xml",
                                       "cancelled", "unsafe", "unreaped", "writer"])
def test_timeout_continuation_requires_truthful_retained_cleanup_proof(adapter, tmp_path, mutation):
    directory, record, nodes = leaf_fixture(tmp_path)
    make_timeout(directory, record)
    if mutation == "missing-report": (directory / record["reports_json"]).unlink()
    elif mutation == "malformed-report": (directory / record["reports_json"]).write_bytes(b"{")
    elif mutation == "unknown-report": put(directory / record["reports_json"], phase_reports([CORE+"::unknown"]))
    elif mutation == "missing-referenced-xml": record["junit_xml"] = "absent.xml"
    elif mutation == "malformed-xml": record["junit_xml"] = "bad.xml"; (directory / "bad.xml").write_bytes(b"<")
    elif mutation == "cancelled": record["cancelled"] = True
    elif mutation == "unsafe": record["cleanup_complete"] = False
    elif mutation == "unreaped": record["exit_code"] = None
    else: record["writer_errors"] = ["uncertain"]
    result = leaf(adapter, directory, record, nodes, continuation=False)
    assert result["status"] != "passed" and result["observed_ids"] == []


@pytest.mark.parametrize("owner", JOBS[1:-1])
def test_every_complete_owner_validates_with_raw_upstream_proofs(adapter, tmp_path, owner):
    world = make_world(tmp_path / "world")
    result = artifact(adapter, world, owner, status="passed", continuation=True)
    expected = ([path+"::test_synthetic[old]" for path in LEGACY] + [path+"::test_synthetic[one]" for path in HELPER]
                if owner == "helper" else CORE_IDS if owner == "core" else RESOURCE_IDS[(int(owner[-1])-1)*9:int(owner[-1])*9])
    assert result["expected_ids"] == result["observed_ids"] == expected
    assert result["owners"][0]["job_id"] == owner


def test_complete_global_success_covers_each_rightful_node_once_and_upload_is_unproven(adapter, tmp_path):
    world = make_world(tmp_path / "world")
    result = global_result(adapter, world, status="passed")
    assert result["expected_ids"] == result["observed_ids"] == FULL_IDS
    assert [node["nodeid"] for node in result["nodes"]] == FULL_IDS
    assert [node["owner"] for node in result["nodes"]] == ["core"]*380 + ["resource_"+str(i//9+1) for i in range(36)]
    assert result["owners"][-1]["completion"] == "unproven"
    assert get(world.directory / "admission/admission.json")["native"]["conclusion"] == "failure"
    assert get(world.directory / "admission/admission.json")["coverage"] == "unproven"


@pytest.mark.parametrize("field,value", [("repository", "other/repo"), ("head_sha", "b"*40), ("run_id", 201),
    ("run_attempt", 3), ("job_id", "resource_1"), ("artifact_name", "old-run"), ("workflow_path", "other.yml"),
    ("workflow_sha256", "b"*64), ("plan_sha256", "b"*64), ("lane", "foobar"), ("phase", "resource")])
def test_receipt_identity_cannot_override_trusted_current_context(adapter, tmp_path, field, value):
    world = make_world(tmp_path / "world")
    file = world.directory / "core/receipt.json"
    r = get(file); r[field] = value; put(file, r); reseal_world(world)
    result = artifact(adapter, world, "core", codes=("identity", "plan", "provenance", "schema", "selection"), continuation=False)
    assert result["status"] != "passed" and result["observed_ids"] == []


@pytest.mark.parametrize("field,value", [("head_sha", "b"*40), ("checkout_head", "b"*40), ("run_id", 201),
    ("run_attempt", 1), ("run_attempt", True), ("repository", "other/repo"), ("workflow_path", "other.yml"),
    ("workflow_sha256", "b"*64), ("plan_sha256", "b"*64)])
def test_independent_expected_context_mismatch_holds(adapter, tmp_path, field, value):
    world = make_world(tmp_path / "world")
    world.expected[field] = value
    result = artifact(adapter, world, "core", codes=("identity", "plan", "provenance", "schema"), continuation=False)
    assert result["status"] != "passed"


@pytest.mark.parametrize("mutation", ["missing", "duplicate-owner", "duplicate-id", "wrong-head", "wrong-attempt", "wrong-name", "wrong-workflow", "wrong-run"])
def test_provenance_values_must_be_present_unique_and_match_not_self_certify(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    records = world.expected["provenance"]
    target = next(x for x in records if x["producer_job"] == "core")
    if mutation == "missing": records.remove(target)
    elif mutation == "duplicate-owner": records.append(copy.deepcopy(target))
    elif mutation == "duplicate-id": target["artifact_id"] = records[0]["artifact_id"]
    else:
        key, value = {"wrong-head": ("head_sha", "b"*40), "wrong-attempt": ("run_attempt", 1),
                      "wrong-name": ("artifact_name", "replayed"), "wrong-workflow": ("workflow_path", "other.yml"),
                      "wrong-run": ("run_id", 199)}[mutation]
        target[key] = value
    artifact(adapter, world, "core", codes=("provenance", "identity"), continuation=False)
    # Historical origin of value-identical dictionaries is deliberately not a pure-function oracle.


@pytest.mark.parametrize("path", CONTROLS + PRODUCTS)
@pytest.mark.parametrize("mutation", ["missing", "wrong"])
def test_each_required_source_hash_is_bound_independently(adapter, tmp_path, path, mutation):
    world = make_world(tmp_path / "world")
    file = world.directory / "core/receipt.json"
    r = get(file)
    if mutation == "missing": del r["source_hashes"][path]
    else: r["source_hashes"][path] = "f"*64
    put(file, r); reseal_world(world)
    artifact(adapter, world, "core", codes=("source_hash", "identity", "helper_proof"), continuation=False)


@pytest.mark.parametrize("mutation", ["missing-proof", "collect-only", "wrong-module", "legacy-source", "preview-source", "partial-new", "split", "product-hash"])
def test_helper_gate_requires_both_complete_source_bound_pairs(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    directory = world.directory / "helper"
    r = get(directory / "receipt.json")
    if mutation == "missing-proof": del r["helper_proofs"]["legacy"]
    elif mutation == "collect-only": r["helper_proofs"]["legacy"]["invocation"] = None
    elif mutation == "wrong-module": r["helper_proofs"]["legacy"]["selectors"] = [CORE]
    elif mutation == "legacy-source":
        f = directory / "legacy/identity.json"; identity = get(f); identity["file_hashes"][OLD] = "f"*64; put(f, identity)
    elif mutation == "preview-source":
        f = directory / "preview/identity.json"; identity = get(f); identity["source_hashes"][ADAPTER] = "f"*64; put(f, identity)
    elif mutation == "partial-new": r["invocations"][0]["selected_nodeids"].pop()
    elif mutation == "split": r["invocations"].append(copy.deepcopy(r["invocations"][0])); r["invocation_ids"].append("extra")
    else: r["source_hashes"][PRODUCTS[0]] = world.expected["source_hashes"][PRODUCTS[0]]
    put(directory / "receipt.json", r); reseal_world(world)
    artifact(adapter, world, "core", codes=("helper_proof", "source_hash", "schema", "selection", "invocation"), continuation=False)


@pytest.mark.parametrize("mutation", ["missing", "false", "inventory-digest", "receipt-digest", "unknown-key"])
def test_complete_writer_marker_is_not_an_optional_summary(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    path = world.directory / "core/complete.json"
    value = get(path)
    if mutation == "missing": path.unlink()
    else:
        if mutation == "false": value["writer_complete"] = False
        elif mutation == "inventory-digest": value["inventory_sha256"] = "f"*64
        elif mutation == "receipt-digest": value["receipt_sha256"] = "f"*64
        else: value["success"] = True
        put(path, value)
    artifact(adapter, world, "core", codes=("writer", "inventory", "schema", "path"), continuation=False)


@pytest.mark.parametrize("mutation", ["duplicate", "unlisted", "missing", "bad-size", "bad-hash", "parent", "absolute", "reverse"])
def test_inventory_is_exact_confined_and_integrity_checked(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    directory = world.directory / "core"
    inventory = get(directory / "inventory.json")
    if mutation == "duplicate": inventory["files"].append(copy.deepcopy(inventory["files"][0]))
    elif mutation == "unlisted": (directory / "unlisted.log").write_bytes(b"unlisted")
    elif mutation == "missing": (directory / inventory["files"][0]["path"]).unlink()
    elif mutation == "bad-size": inventory["files"][0]["size"] += 1
    elif mutation == "bad-hash": inventory["files"][0]["sha256"] = "f"*64
    elif mutation == "parent": inventory["files"][0]["path"] = "../outside"
    elif mutation == "absolute": inventory["files"][0]["path"] = "/outside"
    else: inventory["files"].reverse()
    put(directory / "inventory.json", inventory)
    marker = get(directory / "complete.json"); marker["inventory_sha256"] = sha((directory / "inventory.json").read_bytes()); put(directory / "complete.json", marker)
    artifact(adapter, world, "core", codes=("inventory", "path", "schema"), continuation=False)


def update_collection(directory, receipt, data):
    path = directory / receipt["collection"]["path"]
    put(path, data)
    receipt["collection"]["sha256"] = receipt["collection_sha256"] = sha(path.read_bytes())
    receipt["full_discovered_ids"] = data["discovered_nodeids"][:]
    receipt["full_final_ids"] = data["nodeids"][:]
    receipt["collection_errors"] = copy.deepcopy(data["collection_errors"])
    receipt["deselected_ids"] = data["deselected_nodeids"][:]


@pytest.mark.parametrize("mutation", ["core379", "core381", "missing-resource", "duplicate", "extra-module", "resource-order", "discovery", "deselection", "error", "skip"])
def test_whole_collection_is_canonical_complete_and_unfiltered(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    directory = world.directory / "core"
    r = get(directory / "receipt.json"); data = get(directory / r["collection"]["path"])
    if mutation == "core379": data["nodeids"].remove(CORE_IDS[0])
    elif mutation == "core381": data["nodeids"].insert(380, CORE+"::extra")
    elif mutation == "missing-resource": data["nodeids"].remove(RESOURCE_IDS[0])
    elif mutation == "duplicate": data["nodeids"].append(data["nodeids"][0])
    elif mutation == "extra-module": data["nodeids"].append("tests/py/support.py::unselected")
    elif mutation == "resource-order": data["nodeids"][-2:] = list(reversed(data["nodeids"][-2:]))
    elif mutation == "discovery": data["discovered_nodeids"].append(CORE+"::hidden")
    elif mutation == "deselection": data["deselected_nodeids"] = [CORE+"::hidden"]
    else: data["collection_errors"] = [{"nodeid": CORE, "outcome": "skipped" if mutation == "skip" else "failed", "longrepr": "synthetic collection nonpass"}]
    if mutation not in {"discovery", "deselection", "error", "skip"}: data["discovered_nodeids"] = data["nodeids"][:]
    update_collection(directory, r, data); put(directory / "receipt.json", r); reseal_world(world)
    artifact(adapter, world, "core", codes=("collection", "selection"), continuation=False)


@pytest.mark.parametrize("owner", ["resource_1", "resource_2", "resource_3", "resource_4"])
@pytest.mark.parametrize("mutation", ["collection-bytes", "assignment-order", "assignment-missing", "assignment-extra", "index", "count", "core-replay"])
def test_each_resource_has_exact_canonical_collection_and_own_nine_singletons(adapter, tmp_path, owner, mutation):
    world = make_world(tmp_path / "world")
    directory = world.directory / owner
    r = get(directory / "receipt.json")
    if mutation == "collection-bytes":
        f = directory / r["collection"]["path"]; f.write_bytes(f.read_bytes()+b"\n")
        r["collection"]["sha256"] = r["collection_sha256"] = sha(f.read_bytes())
    elif mutation == "assignment-order": r["assigned_ids"].reverse()
    elif mutation == "assignment-missing": r["assigned_ids"].pop()
    elif mutation == "assignment-extra": r["assigned_ids"].append(CORE_IDS[0])
    elif mutation == "index": r["shard_index"] = 0
    elif mutation == "count": r["shard_count"] = 3
    else: r["invocations"][0]["selected_nodeids"] = CORE_IDS[:]
    put(directory / "receipt.json", r); reseal_world(world)
    artifact(adapter, world, owner, codes=("collection", "selection", "invocation", "schema", "global_ownership"), continuation=False)


@pytest.mark.parametrize("field", ["admission_sha256", "helper_receipt_sha256", "canonical_core_sha256", "predecessor_receipt_sha256"])
def test_raw_chain_reference_digests_are_not_job_output_hints(adapter, tmp_path, field):
    world = make_world(tmp_path / "world")
    directory = world.directory / "resource_2"
    r = get(directory / "receipt.json"); r[field] = "e"*64; put(directory / "receipt.json", r); seal(directory)
    artifact(adapter, world, "resource_2", codes=("admission", "helper_proof", "predecessor", "identity"), continuation=False)


@pytest.mark.parametrize("mutation", ["duplicate-id", "missing-invocation", "extra-invocation", "grouped", "reordered", "overlap", "extra-git", "git-limit"])
def test_invocation_and_process_ownership_cannot_be_split_replayed_or_unbudgeted(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    directory = world.directory / "resource_1"
    r = get(directory / "receipt.json")
    if mutation == "duplicate-id": r["invocations"][1]["id"] = r["invocations"][0]["id"]
    elif mutation == "missing-invocation": r["invocations"].pop(); r["invocation_ids"].pop()
    elif mutation == "extra-invocation": r["invocations"].append(copy.deepcopy(r["invocations"][0])); r["invocation_ids"].append(r["invocations"][0]["id"])
    elif mutation == "grouped": r["invocations"][0]["selected_nodeids"].extend(r["invocations"][1]["selected_nodeids"])
    elif mutation == "reordered": r["invocations"].reverse(); r["invocation_ids"].reverse()
    elif mutation == "overlap": r["invocations"][1]["started_at"] = r["invocations"][0]["started_at"]
    elif mutation == "extra-git": r["git_operations"].append(copy.deepcopy(r["git_operations"][0]))
    else: r["git_operations"][0]["limits"]["runtime_seconds"] = 11
    put(directory / "receipt.json", r); reseal_world(world)
    artifact(adapter, world, "resource_1", codes=("invocation", "selection", "deadline", "process", "global_ownership"), continuation=False)


@pytest.mark.parametrize("mutation", ["hold", "different-head", "current-draft", "native-active", "prerequisite", "sidecar-run"])
def test_admission_raw_snapshot_and_original_sidecar_are_revalidated(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    for owner in ["admission", "helper", "core", "resource_1", "resource_2", "resource_3", "resource_4"]:
        directory = world.directory / owner if owner == "admission" else world.directory / owner / "admission"
        r = get(directory / "admission.json")
        if mutation == "hold": r["decision"] = "hold"
        elif mutation == "different-head": r["trigger"]["head_sha"] = "b"*40
        elif mutation == "current-draft": r["current"]["draft"] = False
        elif mutation == "native-active": r["native"]["status"] = "in_progress"
        elif mutation == "prerequisite": r["native"]["jobs"][0]["conclusion"] = "failure"
        put(directory / "admission.json", r)
        c = get(directory / "admission-context.json"); c["admission_sha256"] = sha((directory / "admission.json").read_bytes())
        if mutation == "sidecar-run": c["run_id"] = 199
        put(directory / "admission-context.json", c)
    # Keep all copied byte/hash bindings internally consistent, so rejection proves admission semantics.
    original = world.directory / "admission"
    digest = sha((original / "admission.json").read_bytes())
    for name in ("admission.json", "admission-context.json"):
        (world.directory / "helper/legacy" / name).write_bytes((original / name).read_bytes())
    for owner in JOBS[1:-1]:
        receipt_path = world.directory / owner / "receipt.json"
        receipt = get(receipt_path); receipt["admission_sha256"] = digest; put(receipt_path, receipt)
    for path in ("legacy/identity.json", "preview/identity.json"):
        identity_path = world.directory / "helper" / path
        identity = get(identity_path); identity["admission_sha256"] = digest; put(identity_path, identity)
    reseal_world(world)
    artifact(adapter, world, "core", codes=("admission", "identity", "helper_proof"), continuation=False)


@pytest.mark.parametrize("owner", JOBS[:-1])
def test_global_missing_each_owner_is_incomplete_not_fabricated_success(adapter, tmp_path, owner):
    world = make_world(tmp_path / "world")
    (world.directory / owner).rename(tmp_path / ("held-"+owner))
    result = global_result(adapter, world, codes=("missing_owner", "admission", "helper_proof", "predecessor", "collection"))
    assert result["status"] != "passed"
    assert next(x for x in result["owners"] if x["job_id"] == owner)["completion"] != "complete"
    if owner == "core":
        assert result["expected_ids"] == RESOURCE_IDS
        assert not any(node.startswith(CORE+"::") for node in result["expected_ids"])


@pytest.mark.parametrize("name", ["resource_5", "previous-run", "reconcile"])
def test_global_does_not_recursively_discover_extra_or_previous_results(adapter, tmp_path, name):
    world = make_world(tmp_path / "world")
    extra = world.directory / name; extra.mkdir(); put(extra / "result.json", {"status": "passed"})
    result = global_result(adapter, world, codes=("duplicate_owner", "global_ownership", "inventory", "path"))
    assert result["status"] != "passed"


def test_mixed_core_assertion_failure_remains_unaccepted_despite_all_resources_passing(adapter, tmp_path):
    world = make_world(tmp_path / "world")
    directory = world.directory / "core"
    r = get(directory / "receipt.json")
    make_assertion_failure(directory, r["invocations"][0], [CORE_IDS[0]])
    r["claimed_status"] = "assertion_failed"; put(directory / "receipt.json", r); reseal_world(world)
    local = artifact(adapter, world, "core", status="assertion_failed", continuation=True)
    assert local["observed_ids"] == []
    result = global_result(adapter, world, status="assertion_failed", codes=("assertion_failed",))
    assert result["observed_ids"] == RESOURCE_IDS
    assert result["nodes"][0]["status"] == "failed" and result["nodes"][0]["cause"] == "assertion_failed"
    assert all(n["status"] == "unknown" and n["cause"] == "invocation_nonzero_exit" for n in result["nodes"][1:380])
    assert all(n["status"] == "passed" for n in result["nodes"][380:])


@pytest.mark.parametrize("failure", ["assertion_failed", "timed_out_safe"])
def test_safe_singleton_failure_retains_later_independent_work_but_global_is_nonpass(adapter, tmp_path, failure):
    world = make_world(tmp_path / "world")
    directory = world.directory / "resource_1"
    r = get(directory / "receipt.json")
    if failure == "assertion_failed": make_assertion_failure(directory, r["invocations"][0], [RESOURCE_IDS[0]])
    else: make_timeout(directory, r["invocations"][0])
    r["claimed_status"] = failure; put(directory / "receipt.json", r); reseal_world(world)
    local = artifact(adapter, world, "resource_1", status=failure, continuation=True)
    assert local["observed_ids"] == RESOURCE_IDS[1:9]
    artifact(adapter, world, "resource_4", status="passed", continuation=True)
    result = global_result(adapter, world, status=failure)
    assert result["observed_ids"] == CORE_IDS + RESOURCE_IDS[1:]
    assert result["nodes"][380]["status"] == ("failed" if failure == "assertion_failed" else "timed_out")


@pytest.mark.parametrize("mutation", ["cancelled", "cleanup", "writer", "missing-report", "false-claim"])
def test_unsafe_predecessor_or_false_claim_holds_following_artifact(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    directory = world.directory / "resource_1"
    r = get(directory / "receipt.json"); record = r["invocations"][0]
    if mutation == "cancelled": record["cancelled"] = True
    elif mutation == "cleanup": record["cleanup_complete"] = False
    elif mutation == "writer": record["writer_errors"] = ["uncertain"]
    elif mutation == "missing-report": (directory / record["reports_json"]).unlink()
    else: make_assertion_failure(directory, record, [RESOURCE_IDS[0]])  # claimed_status intentionally remains passed.
    put(directory / "receipt.json", r); reseal_world(world)
    result = artifact(adapter, world, "resource_2", codes=("predecessor", "cleanup", "writer", "cancellation", "phase", "path", "process", "identity"), continuation=False)
    assert result["status"] != "passed" and result["observed_ids"] == []


def test_current_cancellation_overrides_earlier_safe_receipts(adapter, tmp_path):
    world = make_world(tmp_path / "world")
    world.expected["cancelled"] = True
    result = artifact(adapter, world, "resource_4", codes=("cancellation",), continuation=False)
    assert result["status"] != "passed" and result["observed_ids"] == []
    result = global_result(adapter, world, codes=("cancellation",))
    assert result["status"] != "passed"


def test_failed_helper_cannot_be_blessed_by_core_or_global_green_summaries(adapter, tmp_path):
    world = make_world(tmp_path / "world")
    directory = world.directory / "helper"
    r = get(directory / "receipt.json")
    new = r["invocations"][0]
    make_assertion_failure(directory, new, new["selected_nodeids"][:1])
    r["helper_proofs"]["preview"]["invocation"] = copy.deepcopy(new)
    r["claimed_status"] = "assertion_failed"; put(directory / "receipt.json", r); reseal_world(world)
    result = artifact(adapter, world, "core", codes=("helper_proof",), continuation=False)
    assert result["observed_ids"] == []
    result = global_result(adapter, world, codes=("helper_proof",))
    assert result["status"] != "passed" and result["observed_ids"] == []


@pytest.mark.parametrize("section,key,value", [("limits", "collection_seconds", 301), ("limits", "resource_seconds", 301),
    ("limits", "term_seconds", 31), ("limits", "kill_reap_seconds", 31), ("limits", "artifact_bytes", 268435457),
    ("limits", "aggregate_bytes", 2147483649), ("limits", "aggregate_files", 32769),
    ("job_minutes", "resource_4", 91), ("overhead_seconds", "install", 301)])
def test_plan_cannot_authorize_more_time_or_storage(adapter, tmp_path, section, key, value):
    world = make_world(tmp_path / "world")
    world.plan[section][key] = value
    artifact(adapter, world, "core", codes=("plan", "identity", "deadline"), continuation=False)


@pytest.mark.parametrize("mutation", ["resource-order", "resource-duplicate", "shard-missing", "shard-extra", "helper-subset", "arbitrary-selector", "extra-reuse", "core-count", "unknown-key"])
def test_plan_is_closed_not_user_supplied_execution_authority(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    p = world.plan
    if mutation == "resource-order": p["resource_ids"].reverse()
    elif mutation == "resource-duplicate": p["resource_ids"].append(p["resource_ids"][0])
    elif mutation == "shard-missing": p["shards"].pop()
    elif mutation == "shard-extra": p["shards"].append(copy.deepcopy(p["shards"][0]))
    elif mutation == "helper-subset": p["helper_selectors"].pop()
    elif mutation == "arbitrary-selector": p["selectors"] = [CORE+"::partial"]
    elif mutation == "extra-reuse": p["reuse"]["callables"].append("reconcile")
    elif mutation == "core-count": p["core_count"] = 379
    else: p["allow_retry"] = True
    artifact(adapter, world, "core", codes=("plan", "schema", "identity"), continuation=False)


def test_validation_is_read_only_and_cannot_reuse_a_cached_result(adapter, tmp_path):
    world = make_world(tmp_path / "world")
    def snapshot():
        return {p.relative_to(world.directory).as_posix(): p.read_bytes() for p in world.directory.rglob("*") if p.is_file()}
    before = snapshot(); plan_before = copy.deepcopy(world.plan); expected_before = copy.deepcopy(world.expected)
    global_result(adapter, world, status="passed")
    assert snapshot() == before and world.plan == plan_before and world.expected == expected_before
    target = world.directory / "resource_4/resource-8.json"
    target.write_bytes(b"{")
    result = global_result(adapter, world, codes=("inventory", "schema", "phase"))
    assert result["status"] != "passed"
    assert target.read_bytes() == b"{"


def fake_stat(monkeypatch, path, *, size=None, mode=None, inode=None, nlink=None):
    """Coherent path/descriptor metadata over one tiny real regular file."""
    target = os.path.abspath(os.fspath(path))
    baseline = os.stat(target, follow_symlinks=False)
    identity = (baseline.st_dev, baseline.st_ino)
    def replaced(result):
        fields = list(result)
        for index, replacement in [(0, mode), (1, inode), (3, nlink), (6, size)]:
            if replacement is not None: fields[index] = replacement
        return os.stat_result(fields, {name: getattr(result, name) for name in
            ("st_atime_ns", "st_mtime_ns", "st_ctime_ns", "st_birthtime", "st_birthtime_ns",
             "st_file_attributes", "st_reparse_tag") if hasattr(result, name)})
    for name in ("stat", "lstat"):
        original = getattr(os, name)
        def wrapped(value, *args, _original=original, **kwargs):
            result = _original(value, *args, **kwargs)
            matches = ((result.st_dev, result.st_ino) == identity if isinstance(value, int)
                       else os.path.abspath(os.fspath(value)) == target)
            if matches:
                return replaced(result)
            return result
        monkeypatch.setattr(os, name, wrapped)
    original_fstat = os.fstat
    def descriptor_stat(fd):
        result = original_fstat(fd)
        return replaced(result) if (result.st_dev, result.st_ino) == identity else result
    monkeypatch.setattr(os, "fstat", descriptor_stat)


def forbid_target_reads(monkeypatch, path):
    """Permit acquisition/fstat/close; block and record actual read attempts before bytes move."""
    target = os.path.abspath(os.fspath(path))
    baseline = os.stat(target, follow_symlinks=False)
    identity = (baseline.st_dev, baseline.st_ino)
    touched = []
    def is_target(value):
        if isinstance(value, int):
            result = os.fstat(value)
            return (result.st_dev, result.st_ino) == identity
        return os.path.abspath(os.fspath(value)) == target
    def denied(operation):
        touched.append(operation)
        raise AssertionError("Over-limit or special proof must be refused before consuming bytes")
    class Guarded:
        def __init__(self, raw): self._file = raw
        def __getattr__(self, name): return getattr(self._file, name)
        def __enter__(self): return self
        def __exit__(self, *args): self._file.close()
        @property
        def buffer(self): return self
        @property
        def raw(self): return self
        def read(self, *args, **kwargs): denied("read")
        def readinto(self, *args, **kwargs): denied("readinto")
        def read1(self, *args, **kwargs): denied("read1")
        def readinto1(self, *args, **kwargs): denied("readinto1")
        def readall(self, *args, **kwargs): denied("readall")
        def readline(self, *args, **kwargs): denied("readline")
        def readlines(self, *args, **kwargs): denied("readlines")
        def peek(self, *args, **kwargs): denied("peek")
        def __iter__(self): return self
        def __next__(self): denied("iteration")
    for module in (builtins, io):
        original = module.open
        def guarded(value, *args, _original=original, **kwargs):
            raw = _original(value, *args, **kwargs)
            return Guarded(raw) if is_target(value) else raw
        monkeypatch.setattr(module, "open", guarded)
    for name in ("read", "pread", "readv", "preadv"):
        if not hasattr(os, name): continue
        original = getattr(os, name)
        def guarded_descriptor(fd, *args, _name=name, _original=original, **kwargs):
            if is_target(fd): denied("os." + _name)
            return _original(fd, *args, **kwargs)
        monkeypatch.setattr(os, name, guarded_descriptor)
    return touched


@pytest.mark.parametrize("field", ["raw_log", "reports_json", "junit_xml"])
def test_declared_overlimit_file_is_rejected_before_reading_contents(adapter, tmp_path, monkeypatch, field):
    directory, record, nodes = leaf_fixture(tmp_path)
    target = directory / record[field]
    fake_stat(monkeypatch, target, size=33554433)
    touched = forbid_target_reads(monkeypatch, target)
    leaf(adapter, directory, record, nodes, codes=("size_limit",), continuation=False)
    assert not touched, "Exception handling must not hide a forbidden read"


@pytest.mark.parametrize("mode", [stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o600, stat.S_IFCHR | 0o600])
def test_link_and_special_file_metadata_is_rejected_without_host_side_effects(adapter, tmp_path, monkeypatch, mode):
    directory, record, nodes = leaf_fixture(tmp_path)
    target = directory / record["raw_log"]
    fake_stat(monkeypatch, target, mode=mode)
    touched = forbid_target_reads(monkeypatch, target)
    leaf(adapter, directory, record, nodes, codes=("path",), continuation=False)
    assert not touched, "Exception handling must not hide a forbidden read"


@pytest.mark.parametrize("extra", [0, 1])
def test_artifact_exact_file_count_limit_and_one_over(adapter, tmp_path, extra):
    world = make_world(tmp_path / "world")
    directory = world.directory / "core"
    count = sum(p.is_file() for p in directory.rglob("*"))
    for index in range(4096+extra-count): (directory / ("retained-"+str(index)+".log")).write_bytes(b"x")
    seal(directory)
    assert sum(p.is_file() for p in directory.rglob("*")) == 4096+extra
    if extra: artifact(adapter, world, "core", codes=("size_limit",), continuation=False)
    else: artifact(adapter, world, "core", status="passed", continuation=True)


def test_inventory_declared_total_limit_is_checked_before_padding_reads(adapter, tmp_path, monkeypatch):
    world = make_world(tmp_path / "world")
    directory = world.directory / "core"
    inventory = get(directory / "inventory.json")
    touched = []
    for index in range(9):
        path = directory / ("padding-"+str(index)+".log"); path.write_bytes(b"x")
        inventory["files"].append({"path": path.name, "size": 33554432, "sha256": "f"*64})
        fake_stat(monkeypatch, path, size=33554432)
        touched.append(forbid_target_reads(monkeypatch, path))
    inventory["files"].sort(key=lambda entry: entry["path"])
    put(directory / "inventory.json", inventory)
    marker = get(directory / "complete.json"); marker["inventory_sha256"] = sha((directory / "inventory.json").read_bytes()); put(directory / "complete.json", marker)
    artifact(adapter, world, "core", codes=("size_limit",), continuation=False)
    assert not any(touched), "Overflow must be rejected before synthetic padding reads"


def test_fixed_global_owner_bounds_do_not_invent_extra_owners_to_reach_aggregate_cap():
    plan = plan_record()
    # Seven transferred input owners cannot reach the higher eight-artifact aggregate ceiling.
    assert len(JOBS[:-1])*plan["limits"]["artifact_bytes"] < plan["limits"]["aggregate_bytes"]
    assert len(JOBS[:-1])*plan["limits"]["artifact_files"] < plan["limits"]["aggregate_files"]
    assert plan["limits"]["aggregate_bytes"] == 2*1024**3
    assert plan["limits"]["aggregate_files"] == 32768


class CountedBytes:
    """Small deterministic chunks, never one huge materialized synthetic file."""
    def __init__(self, length, prefix=b"synthetic retained log\n"):
        self.length, self.prefix, self.consumed, self.requests = length, prefix, 0, []
        self.bad_request = False

    def read(self, size=-1):
        self.requests.append(size)
        if type(size) is not int or not 0 < size <= 33554433:
            self.bad_request = True
            raise AssertionError("Underlying proof reads must have an explicit bounded length")
        count = min(size, 65536, self.length-self.consumed)
        start = self.consumed
        self.consumed += count
        prefix = self.prefix[start:start+count] if start < len(self.prefix) else b""
        return prefix + b" " * (count-len(prefix))


def intercept_counted_file(monkeypatch, path, *, declared, actual):
    """Intercept ordinary file and descriptor reads; no huge file or host process."""
    target = os.path.abspath(os.fspath(path))
    state = SimpleNamespace(streams=[], descriptors={})
    fake_stat(monkeypatch, path, size=declared)
    original_fstat, original_open, original_read, original_close = os.fstat, os.open, os.read, os.close

    def is_target(value):
        return not isinstance(value, int) and os.path.abspath(os.fspath(value)) == target

    def virtual_stat(fd):
        result = original_fstat(fd)
        if fd in state.descriptors:
            fields = list(result); fields[6] = declared
            return os.stat_result(fields, {name: getattr(result, name) for name in
                    ("st_atime_ns", "st_mtime_ns", "st_ctime_ns", "st_birthtime", "st_birthtime_ns",
                     "st_file_attributes", "st_reparse_tag") if hasattr(result, name)})
        return result

    class Wrapped:
        def __init__(self, stream, raw, binary):
            self.stream, self.raw, self.binary = stream, raw, binary
        def __getattr__(self, name): return getattr(self.raw, name)
        def __enter__(self): return self
        def __exit__(self, *args): self.close()
        def close(self):
            state.descriptors.pop(self.raw.fileno(), None)
            return self.raw.close()
        def read(self, size=-1):
            value = self.stream.read(size)
            return value if self.binary else value.decode("ascii")
        def readinto(self, buffer):
            value = self.stream.read(len(buffer)); buffer[:len(value)] = value
            return len(value)
        read1 = read
        readinto1 = readinto

    for module in (builtins, io):
        original = module.open
        def wrapped(value, *args, _original=original, **kwargs):
            raw = _original(value, *args, **kwargs)
            if not is_target(value): return raw
            stream = CountedBytes(actual); state.streams.append(stream)
            state.descriptors[raw.fileno()] = stream
            mode = args[0] if args else kwargs.get("mode", "r")
            return Wrapped(stream, raw, "b" in mode)
        monkeypatch.setattr(module, "open", wrapped)

    def descriptor_open(value, *args, **kwargs):
        fd = original_open(value, *args, **kwargs)
        if is_target(value):
            stream = CountedBytes(actual); state.streams.append(stream); state.descriptors[fd] = stream
        return fd
    def descriptor_read(fd, size):
        return state.descriptors[fd].read(size) if fd in state.descriptors else original_read(fd, size)
    def descriptor_close(fd):
        state.descriptors.pop(fd, None)
        return original_close(fd)
    monkeypatch.setattr(os, "open", descriptor_open)
    monkeypatch.setattr(os, "read", descriptor_read)
    monkeypatch.setattr(os, "close", descriptor_close)
    monkeypatch.setattr(os, "fstat", virtual_stat)
    return state


@pytest.mark.parametrize("declared,actual,passing", [(33554432, 33554432, True),
    (33554432, 33554433, False), (100, 99, False), (100, 101, False)])
def test_counted_stream_file_boundary_and_short_or_grown_proof(adapter, tmp_path, monkeypatch, declared, actual, passing):
    directory, record, nodes = leaf_fixture(tmp_path)
    state = intercept_counted_file(monkeypatch, directory / record["raw_log"], declared=declared, actual=actual)
    result = leaf(adapter, directory, record, nodes, status="passed" if passing else None, continuation=passing)
    assert state.streams, "The required raw log was never opened"
    assert not any(stream.bad_request for stream in state.streams), "An exception handler masked an unbounded read"
    assert all(stream.consumed <= 33554433 for stream in state.streams), "Overflow was consumed beyond the sentinel byte"
    if passing:
        assert any(stream.consumed == actual for stream in state.streams)
    else:
        assert result["status"] != "passed" and result["errors"]


def changing_stat_identity(monkeypatch, path):
    """One target-aware sequence for path stat/lstat, stat(fd), and fstat."""
    target = os.path.abspath(os.fspath(path))
    baseline = os.stat(target, follow_symlinks=False)
    identity = (baseline.st_dev, baseline.st_ino)
    state = {"calls": 0}
    for name in ("stat", "lstat", "fstat"):
        original = getattr(os, name)
        def altered(value, *args, _original=original, **kwargs):
            result = _original(value, *args, **kwargs)
            matches = ((result.st_dev, result.st_ino) == identity or
                       (not isinstance(value, int) and os.path.abspath(os.fspath(value)) == target))
            if matches:
                state["calls"] += 1
                fields = list(result); fields[1] = baseline.st_ino + state["calls"]
                return os.stat_result(fields, {name: getattr(result, name) for name in
                    ("st_atime_ns", "st_mtime_ns", "st_ctime_ns", "st_birthtime", "st_birthtime_ns",
                     "st_file_attributes", "st_reparse_tag") if hasattr(result, name)})
            return result
        monkeypatch.setattr(os, name, altered)
    return state


def interrupt_proof_access(monkeypatch, path, error):
    """Inject cancellation across buffered/descriptor opens and preopened descriptor reads."""
    target = os.path.abspath(os.fspath(path))
    baseline = os.stat(target, follow_symlinks=False)
    identity = (baseline.st_dev, baseline.st_ino)
    original_fstat = os.fstat
    touched = []
    def is_target(value):
        if isinstance(value, int):
            info = original_fstat(value)
            return (info.st_dev, info.st_ino) == identity
        return os.path.abspath(os.fspath(value)) == target
    def interrupt(operation):
        touched.append(operation)
        raise error("synthetic cancellation")
    for module in (builtins, io, os):
        original = module.open
        label = module.__name__ + ".open"
        def interrupted(value, *args, _original=original, _label=label, **kwargs):
            if is_target(value): interrupt(_label)
            return _original(value, *args, **kwargs)
        monkeypatch.setattr(module, "open", interrupted)
    for name in ("read", "pread", "readv", "preadv"):
        if not hasattr(os, name): continue
        original = getattr(os, name)
        def interrupted_read(fd, *args, _original=original, _name=name, **kwargs):
            if is_target(fd): interrupt("os." + _name)
            return _original(fd, *args, **kwargs)
        monkeypatch.setattr(os, name, interrupted_read)
    return touched


@pytest.mark.parametrize("mutation", ["hardlink", "inode-changed"])
def test_inventory_detects_link_alias_and_changed_stat_identity(adapter, tmp_path, monkeypatch, mutation):
    world = make_world(tmp_path / "world")
    target = world.directory / "core/core.log"
    if mutation == "hardlink":
        fake_stat(monkeypatch, target, nlink=2)
    else:
        changing_stat_identity(monkeypatch, target)
    result = artifact(adapter, world, "core", codes=("path", "inventory", "writer"), continuation=False)
    assert result["status"] != "passed"


@pytest.mark.parametrize("mutation", ["owner-alias", "self-as-upstream", "unknown-input", "missing-ancestor"])
def test_artifact_input_roles_cannot_alias_or_extend_fixed_owners(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    expected = copy.deepcopy(world.expected); expected["producer_job"] = "resource_2"
    inputs = {job: world.directory / job for job in JOBS[:4]}
    if mutation == "owner-alias": inputs["core"] = inputs["helper"]
    elif mutation == "self-as-upstream": inputs["resource_1"] = world.directory / "resource_2"
    elif mutation == "unknown-input": inputs["resource_5"] = world.directory / "resource_1"
    else: del inputs["core"]
    result = assessment(adapter.validate_artifact(world.directory / "resource_2", plan=world.plan,
                        expected=expected, inputs=inputs), "artifact", continuation=False)
    assert result["status"] != "passed" and result["observed_ids"] == []


@pytest.mark.parametrize("error", [KeyboardInterrupt, SystemExit])
def test_interrupt_during_proof_read_is_never_swallowed_as_success(adapter, tmp_path, monkeypatch, error):
    directory, record, nodes = leaf_fixture(tmp_path)
    touched = interrupt_proof_access(monkeypatch, directory / record["reports_json"], error)
    try:
        result = leaf(adapter, directory, record, nodes, continuation=False)
    except error:
        result = None
    assert touched, "The required raw proof was not inspected"
    if result is not None: assert result["status"] != "passed"


def counted_digest(length):
    source = CountedBytes(length)
    digest = hashlib.sha256()
    while True:
        block = source.read(65536)
        if not block: break
        digest.update(block)
    return digest.hexdigest()


@pytest.mark.parametrize("extra", [0, 1])
def test_exact_artifact_byte_limit_including_containers_with_counted_streams(adapter, tmp_path, monkeypatch, extra):
    world = make_world(tmp_path / "world")
    directory = world.directory / "core"
    inventory = get(directory / "inventory.json")
    fixed = sum(entry["size"] for entry in inventory["files"])
    names = ["virtual-padding-"+str(i)+".log" for i in range(8)]
    entries = [{"path": name, "size": 33554432, "sha256": "0"*64} for name in names]
    inventory["files"].extend(entries)
    inventory["files"].sort(key=lambda entry: entry["path"])
    for name in names: (directory / name).write_bytes(b"x")
    marker = get(directory / "complete.json")
    # Only the final decimal size can change envelope length. No large fixture allocation.
    for _ in range(12):
        containers = len(raw_json(inventory)) + len(raw_json(marker))
        last = 268435456 + extra - fixed - 7*33554432 - containers
        if entries[-1]["size"] == last: break
        entries[-1]["size"] = last
    else: raise AssertionError("Synthetic envelope byte accounting failed to converge")
    assert 0 < entries[-1]["size"] <= 33554432
    for entry in entries: entry["sha256"] = counted_digest(entry["size"])
    put(directory / "inventory.json", inventory)
    marker["inventory_sha256"] = sha((directory / "inventory.json").read_bytes())
    put(directory / "complete.json", marker)
    assert fixed + sum(entry["size"] for entry in entries) + len(raw_json(inventory)) + len(raw_json(marker)) == 268435456 + extra
    states = [intercept_counted_file(monkeypatch, directory / entry["path"],
              declared=entry["size"], actual=entry["size"]) for entry in entries]
    result = artifact(adapter, world, "core", status="passed" if not extra else None,
                      codes=("size_limit",) if extra else (), continuation=not extra)
    assert not any(stream.bad_request for state in states for stream in state.streams)
    assert all(stream.consumed <= 33554433 for state in states for stream in state.streams)
    if extra:
        assert result["status"] != "passed"
    else:
        for entry, state in zip(entries, states):
            assert any(stream.consumed == entry["size"] for stream in state.streams)


@pytest.mark.parametrize("mutation", ["raw-phase", "raw-invocation", "checkout", "capture", "false-summary"])
def test_legacy_raw_proof_is_preserved_and_rechecked_not_replaced_by_enclosing_summary(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    legacy = world.directory / "helper/legacy"
    if mutation == "raw-phase":
        record = get(legacy / "run-0.json"); record["reports"].pop(); put(legacy / "run-0.json", record)
    elif mutation == "raw-invocation":
        record = get(legacy / "invocations.json"); record[0]["exit_code"] = 2; put(legacy / "invocations.json", record)
    elif mutation == "checkout":
        (legacy / "checkout.log").write_bytes(("b"*40+"\n").encode())
    elif mutation == "capture":
        record = get(legacy / "collection.capture.json"); record["nodeids"].pop(); put(legacy / "collection.capture.json", record)
    else:
        record = get(legacy / "run-0.json"); record["reports"] = []; put(legacy / "run-0.json", record)
        # Existing green reconciliation.json is deliberately left untouched.
    reseal_world(world)
    result = artifact(adapter, world, "helper", codes=("helper_proof", "phase", "process", "collection", "identity"), continuation=False)
    assert result["status"] != "passed" and result["observed_ids"] == []


@pytest.mark.parametrize("addition", [["-k", "partial"], ["-m", "selected"], ["--ignore", RESOURCE],
                                      ["--maxfail=1"], ["||", "true"], ["--reruns", "1"]])
def test_runtime_command_cannot_filter_retry_or_mask_its_owned_selection(adapter, tmp_path, addition):
    directory, record, nodes = leaf_fixture(tmp_path)
    record["argv"].extend(addition)
    result = leaf(adapter, directory, record, nodes, codes=("invocation", "selection", "process"), continuation=False)
    assert result["status"] != "passed"


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "extra", "reordered", "cross-shard", "core-replay"])
def test_global_rejects_green_reports_with_wrong_runtime_ownership(adapter, tmp_path, mutation):
    world = make_world(tmp_path / "world")
    directory = world.directory / "resource_2"
    r = get(directory / "receipt.json")
    if mutation == "missing": r["invocations"].pop()
    elif mutation == "duplicate": r["invocations"].append(copy.deepcopy(r["invocations"][0]))
    elif mutation == "extra":
        r["invocations"].append(invocation(directory, [RESOURCE_IDS[18]], "extra", seconds=300, start=4050))
    elif mutation == "reordered": r["invocations"].reverse()
    else:
        foreign = RESOURCE_IDS[0] if mutation == "cross-shard" else CORE_IDS[0]
        r["invocations"][0] = invocation(directory, [foreign], "resource-0", seconds=300, start=4004)
    r["invocation_ids"] = [record["id"] for record in r["invocations"]]
    put(directory / "receipt.json", r); reseal_world(world)
    result = global_result(adapter, world, codes=("selection", "invocation", "global_ownership", "predecessor"))
    assert result["status"] != "passed" and result["observed_ids"] != FULL_IDS
    assert all(node["status"] != "passed" for node in result["nodes"] if node["owner"] == "resource_2")


@pytest.mark.parametrize("access", ["builtin", "path", "descriptor"])
@pytest.mark.parametrize("metadata", [{"size": 33554433}, {"mode": stat.S_IFIFO | 0o600},
                                      {"mode": stat.S_IFLNK | 0o777}])
def test_r2_read_guard_allows_safe_descriptor_metadata_rejection_without_consumption(tmp_path, monkeypatch, access, metadata):
    path = tmp_path / "tiny-proof.log"
    path.write_bytes(b"tiny")
    fake_stat(monkeypatch, path, **metadata)
    touched = forbid_target_reads(monkeypatch, path)
    if access == "descriptor":
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, flags)
        try:
            observed = os.fstat(fd)
            descriptor_alias = os.stat(fd)
        finally:
            os.close(fd)
    else:
        opener = (lambda: open(path, "rb")) if access == "builtin" else (lambda: path.open("rb"))
        with opener() as stream:
            observed = os.fstat(stream.fileno())
            descriptor_alias = os.stat(stream.fileno())
    path_observed = os.lstat(path)
    for key, value in metadata.items():
        field = {"size": "st_size", "mode": "st_mode"}[key]
        assert getattr(observed, field) == getattr(descriptor_alias, field) == getattr(path_observed, field) == value
    assert touched == [], "Opening, inspecting and closing is not byte consumption"


@pytest.mark.parametrize("operation", ["read", "read1", "readinto", "readinto1", "descriptor"])
def test_r2_read_attempt_ledger_survives_caught_read_exceptions(tmp_path, monkeypatch, operation):
    path = tmp_path / "tiny-proof.log"
    path.write_bytes(b"tiny")
    fake_stat(monkeypatch, path, size=33554433)
    touched = forbid_target_reads(monkeypatch, path)
    if operation == "descriptor":
        fd = os.open(path, os.O_RDONLY)
        try:
            try: os.read(fd, 1)
            except AssertionError: pass  # Simulate an adapter converting an exception to nonpass.
        finally:
            os.close(fd)
    else:
        with path.open("rb") as stream:
            try:
                getattr(stream, operation)(bytearray(1) if "into" in operation else 1)
            except AssertionError: pass
    assert touched == ["os.read" if operation == "descriptor" else operation]


@pytest.mark.parametrize("operation", ["subprocess", "fork", "socket", "connect", "signal", "wait",
                                       "pytest", "product-import", "config-import", "product-loader"])
def test_r2_host_effect_ledger_rejects_caught_exceptions_from_every_sentinel_family(monkeypatch, operation):
    attempts = []
    with monkeypatch.context() as isolated:
        install_host_effect_sentinels(isolated, attempts)
        try:
            if operation == "subprocess": subprocess.Popen(["never-started"])
            elif operation == "fork": os.fork()
            elif operation == "socket": socket.socket()
            elif operation == "connect": socket.create_connection(("never-connected.invalid", 1))
            elif operation == "signal": signal.signal(signal.SIGTERM, lambda *args: None)
            elif operation == "wait": time.sleep(1)
            elif operation == "pytest": pytest.main([])
            elif operation == "product-import": builtins.__import__("music_app.services.foobar_snapshot_preview")
            elif operation == "config-import": builtins.__import__("config")
            else: importlib.util.spec_from_file_location("never-loaded", "/synthetic/music_app/services/foobar_snapshot_preview.py")
        except AssertionError: pass  # A structured negative return must not erase this attempted effect.
        assert len(attempts) == 1
        with pytest.raises(AssertionError, match="Forbidden host-effect attempts"):
            assert_no_host_effects(attempts)


def test_r2_clean_host_effect_ledger_remains_empty(monkeypatch):
    attempts = []
    with monkeypatch.context() as isolated:
        install_host_effect_sentinels(isolated, attempts)
        assert_no_host_effects(attempts)
    assert attempts == []


@pytest.mark.parametrize("access", ["path", "descriptor", "stat-fd", "mixed"])
def test_r3_changed_identity_sequence_reaches_path_and_descriptor_metadata(tmp_path, monkeypatch, access):
    target = tmp_path / "changing.log"; target.write_bytes(b"tiny")
    other = tmp_path / "other.log"; other.write_bytes(b"untouched")
    baseline, untouched = os.stat(target), os.stat(other)
    fd, other_fd = os.open(target, os.O_RDONLY), os.open(other, os.O_RDONLY)
    try:
        state = changing_stat_identity(monkeypatch, target)
        if access == "path": values = [os.stat(target), os.lstat(target), os.stat(target)]
        elif access == "descriptor": values = [os.fstat(fd), os.fstat(fd), os.fstat(fd)]
        elif access == "stat-fd": values = [os.stat(fd), os.stat(fd), os.stat(fd)]
        else: values = [os.lstat(target), os.fstat(fd), os.stat(fd)]
        assert [value.st_ino for value in values] == [baseline.st_ino + i for i in (1, 2, 3)]
        assert state["calls"] == 3
        assert os.stat(other).st_ino == os.fstat(other_fd).st_ino == untouched.st_ino
        assert state["calls"] == 3, "Unrelated files must not advance the mutation sequence"
    finally:
        os.close(fd); os.close(other_fd)


@pytest.mark.parametrize("error", [KeyboardInterrupt, SystemExit])
@pytest.mark.parametrize("access", ["builtin-open", "path-open", "descriptor-open", "preopened-read", "preopened-io"])
def test_r3_cancellation_reaches_descriptor_access_and_retains_attempt_ledger(tmp_path, monkeypatch, error, access):
    target = tmp_path / "cancelled.json"; target.write_bytes(b"{}")
    other = tmp_path / "other.log"; other.write_bytes(b"untouched")
    fd = os.open(target, os.O_RDONLY)
    try:
        touched = interrupt_proof_access(monkeypatch, target, error)
        with other.open("rb") as stream:
            assert stream.read() == b"untouched"
        assert touched == []
        try:
            if access == "builtin-open":
                with open(target, "rb"): pass
            elif access == "path-open":
                with target.open("rb"): pass
            elif access == "descriptor-open":
                acquired = os.open(target, os.O_RDONLY)
                os.close(acquired)
            elif access == "preopened-read": os.read(fd, 1)
            else:
                with io.open(fd, "rb", closefd=False): pass
        except error: pass  # Model an adapter's cancellation handling without erasing the ledger.
        expected = {"builtin-open": "builtins.open", "path-open": "io.open", "descriptor-open": "os.open",
                    "preopened-read": "os.read", "preopened-io": "io.open"}[access]
        assert touched == [expected], "The supported access surface must receive the injected interruption"
    finally:
        os.close(fd)
