"""Independent finite controls. Not collected by the native tests/py owner.

These tests are authored, not execution evidence. Fixture answers are derived
from the accepted contracts, never by asking the subject to normalize them.
"""
from __future__ import annotations

import ast
import builtins
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import http.client  # Load SSL's real socket base before effect sentinels.
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import signal
import socket
import ssl
import stat
import struct
import subprocess
import sys
import urllib.request
import zipfile
import zlib
from xml.sax.saxutils import escape

import pytest

ROOT = Path(__file__).resolve().parents[2]
SUBJECT = "scripts/ci/foobar_preview_evidence.py"
CONTROL = "scripts/ci/foobar_preview_controls_evidence.py"
WORKFLOW = ".github/workflows/foobar-preview-backend-evidence.yml"
CONTROL_WORKFLOW = ".github/workflows/foobar-preview-validation-controls.yml"
PY_FILE = "tests/ci/foobar_preview_validation_controls_cases.py"
NODE_FILE = "tests/ci/foobar_preview_transfer_literal_cases.cjs"
REPOSITORY = "idanilovqa/AlbumHaven"
BRANCH = "2026-10-03-album-tops"
HEAD = "1234567890abcdef1234567890abcdef12345678"
OLD_HASH = "8f45a3c1c3ada77a817928463527fb4add58f57f70a2d3f24cc9187cf5fb3673"
EPOCH = datetime(2026, 10, 20, tzinfo=timezone.utc)
PROCESS_IDS = ("git", "python_collection", "python_runtime", "node_inventory", "node_runtime")
RUNTIMES = (10, 60, 180, 60, 180)
SOURCE_PATHS = (
    WORKFLOW, ".github/workflows/new-feature-backend-evidence.yml",
    "scripts/ci/admit-new-feature-evidence.py", "scripts/ci/new_feature_evidence.py",
    SUBJECT, "scripts/ci/foobar_preview_plan.json",
    "tests/py/test_new_feature_ci_contract.py", "tests/py/test_new_feature_evidence.py",
    "tests/py/test_foobar_preview_ci_contract.py", "tests/py/test_foobar_preview_evidence.py",
    "music_app/services/foobar_snapshot_parser.py", "music_app/services/foobar_snapshot_preview.py",
    "tests/py/test_foobar_snapshot_preview.py", "tests/py/test_foobar_snapshot_preview_resources.py",
    CONTROL_WORKFLOW, CONTROL, PY_FILE, NODE_FILE, "requirements.txt",
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def stamp(seconds=0):
    return (EPOCH + timedelta(seconds=seconds)).isoformat()


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def put(root, name, value):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value if isinstance(value, bytes) else encode(value))
    return path


def get(root, name):
    return json.loads((root / name).read_bytes())


@pytest.fixture(autouse=True)
def no_external_effects(monkeypatch):
    """Attempts survive caught sentinels; no CI/product/network/process effects."""
    attempts = []
    def blocked(operation):
        def call(*args, **kwargs):
            attempts.append(operation)
            raise AssertionError("forbidden external effect: " + operation)
        return call
    for obj, names in ((subprocess, ("Popen", "run", "call", "check_call", "check_output")),
                       (os, ("system", "popen", "kill", "killpg", "getpgid")),
                       (urllib.request, ("urlopen",)),
                       (socket, ("create_connection", "getaddrinfo"))):
        for name in names:
            monkeypatch.setattr(obj, name, blocked(name), raising=False)
    class NoSocket(socket.socket):
        def __new__(cls, *args, **kwargs):
            return blocked("socket.socket")(*args, **kwargs)
    monkeypatch.setattr(socket, "socket", NoSocket)
    original_import = builtins.__import__
    def guarded_import(name, *args, **kwargs):
        if name == "music_app" or name.startswith("music_app."):
            return blocked("product import " + name)()
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guarded_import)
    monkeypatch.setattr(signal, "SIGKILL", getattr(signal, "SIGKILL", 9), raising=False)
    monkeypatch.setattr(sys, "dont_write_bytecode", True)
    yield attempts
    assert attempts == [], "A caught forbidden-effect sentinel must still fail: " + repr(attempts)


def load_subject(relative, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def subject():
    return load_subject(SUBJECT, "isolated_preview_controls_subject")


@pytest.fixture
def validator():
    return load_subject(CONTROL, "isolated_controls_validator_subject").validate_controls_evidence


def admission_fixture():
    """Six independently written public observations, not an admit() call."""
    pr = {"number": 17, "state": "open", "draft": True,
          "head": {"sha": HEAD, "ref": BRANCH, "repo": {"full_name": REPOSITORY}},
          "labels": [{"name": "run_reviews"}]}
    event = {"action": "synchronize", "number": 17,
             "repository": {"full_name": REPOSITORY}, "pull_request": copy.deepcopy(pr)}
    normalized = {"repository": REPOSITORY, "number": 17, "branch": BRANCH,
                  "head_sha": HEAD, "draft": True, "control_labels": ["run_reviews"],
                  "all_labels": ["run_reviews"]}
    native = {"id": 901, "workflow_id": 7, "run_number": 22, "run_attempt": 3,
              "head_sha": HEAD, "head_branch": BRANCH, "event": "pull_request",
              "path": ".github/workflows/pr-gates.yml", "name": "PR Gates",
              "repository": {"full_name": REPOSITORY}, "head_repository": {"full_name": REPOSITORY},
              "pull_requests": [{"number": 17, "head": {"sha": HEAD, "ref": BRANCH}}],
              "status": "completed", "conclusion": "failure"}
    names = ("PR Review Scope", "Review Prerequisites", "JavaScript Tests (Portable)",
             "Component Tests (Pinned Chrome)", "JavaScript Tests (Windows Contract)", "Python Tests")
    jobs = [{"id": 80 + i, "name": name, "run_id": 901, "run_attempt": 3,
             "head_sha": HEAD, "head_branch": BRANCH, "workflow_name": "PR Gates",
             "status": "completed", "conclusion": "success", "started_at": stamp(-100)}
            for i, name in enumerate(names)]
    base = "https://api.github.com/repos/" + REPOSITORY
    observations = [
        ("/pulls/17", pr),
        ("/actions/workflows/pr-gates.yml", {"id": 7, "name": "PR Gates", "path": ".github/workflows/pr-gates.yml", "state": "active"}),
        ("/actions/workflows/pr-gates.yml/runs?head_sha=" + HEAD + "&branch=" + BRANCH + "&event=pull_request&per_page=100&page=1", {"total_count": 1, "workflow_runs": [native]}),
        ("/actions/runs/901", native), ("/actions/runs/901/attempts/3", native),
        ("/actions/runs/901/attempts/3/jobs?per_page=100&page=1", {"total_count": 6, "jobs": jobs}),
    ]
    result = {"schema_version": 1, "decision": "admit", "reason_codes": [],
              "observed_at": stamp(-50), "authority": "supplemental-only", "coverage": "unproven",
              "trigger": copy.deepcopy(normalized), "current": copy.deepcopy(normalized),
              "native": {"id": 901, "run_number": 22, "attempt": 3, "workflow_id": 7,
                         "head_sha": HEAD, "status": "completed", "conclusion": "failure", "jobs": jobs},
              "inspected": [{"url": base + route, "fetched_at": stamp(-49 + i), "body": copy.deepcopy(body)}
                            for i, (route, body) in enumerate(observations)]}
    return event, result


def python_capture(ids):
    return {"schema_version": 1, "discovered_nodeids": list(ids), "nodeids": list(ids),
            "deselected_nodeids": [], "collection_errors": []}


def phase_capture(ids, failed=()):
    return {"schema_version": 1, "reports": [
        {"nodeid": node, "when": phase, "outcome": "failed" if node in failed and phase == "call" else "passed", "wasxfail": None}
        for node in ids for phase in ("setup", "call", "teardown")]}


def junit(ids, failed=()):
    cases = []
    for node in ids:
        parts = node.split("::")
        cls = parts[0][:-3].replace("/", ".") + "".join("." + item for item in parts[1:-1])
        body = '<failure message="synthetic assertion" />' if node in failed else ""
        cases.append('<testcase classname="' + escape(cls, {'"': '&quot;'}) + '" name="' + escape(parts[-1], {'"': '&quot;'}) + '">' + body + '</testcase>')
    return ('<testsuite tests="' + str(len(ids)) + '" failures="' + str(len(failed)) + '" errors="0" skipped="0">' + ''.join(cases) + '</testsuite>').encode()


def seal(root, prefix="foobar-preview-controls"):
    records = [{"path": path.relative_to(root).as_posix(), "size": path.stat().st_size,
                "sha256": digest(path.read_bytes())}
               for path in sorted(root.rglob("*")) if path.is_file() and path.name not in ("inventory.json", "complete.json")]
    inventory = put(root, "inventory.json", {"schema_version": prefix + "-inventory-v1", "files": records})
    put(root, "complete.json", {"schema_version": prefix + "-complete-v1", "inventory_sha256": digest(inventory.read_bytes()),
                               "receipt_sha256": digest((root / "receipt.json").read_bytes()), "writer_complete": True})


def process(argv, start, duration=1):
    return {"argv": argv, "exit_code": 0, "timed_out": False, "cleanup_complete": True,
            "writer_errors": [], "cancelled": False, "started_at": stamp(start), "finished_at": stamp(start + duration)}


def controls_proof(tmp_path):
    root = tmp_path / "proof"
    root.mkdir()
    event, admission = admission_fixture()
    expected = {"repository": REPOSITORY, "head_sha": HEAD, "checkout_head": HEAD,
                "workflow_path": CONTROL_WORKFLOW, "job_id": "validation_controls", "run_id": 1234,
                "run_attempt": 2, "cancelled": False, "root": str(tmp_path / "checkout"),
                "git_executable": "/synthetic/bin/git", "python_executable": "/synthetic/bin/python",
                "node_executable": "/synthetic/bin/node", "python_version": "3.11.9", "node_version": "v20.18.0",
                "source_hashes": {name: digest(("independently supplied " + name).encode()) for name in SOURCE_PATHS},
                "event_sha256": digest(encode(event)), "admission_sha256": digest(encode(admission)),
                "bootstrap_sha256": digest(b"synthetic reviewed bootstrap\n"),
                "transfer_literal_sha256": digest(b"synthetic reviewed literal\n")}
    expected["source_hashes"]["scripts/ci/new_feature_evidence.py"] = OLD_HASH
    context = {"schema_version": 1, "repository": REPOSITORY, "head_sha": HEAD, "run_id": 1234,
               "attempt": 2, "admission_sha256": expected["admission_sha256"], "event_sha256": expected["event_sha256"],
               "workflow_path": CONTROL_WORKFLOW, "job_id": "validation_controls"}
    expected["admission_context_sha256"] = digest(encode(context))
    identity = {key: copy.deepcopy(value) for key, value in expected.items() if key != "cancelled"}
    put(root, "context.json", identity)
    put(root, "receipt.json", {"schema_version": "foobar-preview-controls-receipt-v1", "identity": identity,
                               "attempted_process_ids": list(PROCESS_IDS)})
    put(root, "event.json", event); put(root, "admission.json", admission); put(root, "admission-context.json", context)
    put(root, "empty-pytest.ini", b"")
    argv = [
        [expected["git_executable"], "rev-parse", "HEAD"],
        [expected["python_executable"], "-I", "-B", "-c", "synthetic reviewed bootstrap\n", expected["root"], str(root / "context.json"), "collect"],
        [expected["python_executable"], "-I", "-B", "-c", "synthetic reviewed bootstrap\n", expected["root"], str(root / "context.json"), "run"],
        [expected["node_executable"], str(Path(expected["root"]) / NODE_FILE), "--list", "--root", expected["root"], "--evidence-dir", str(root)],
        [expected["node_executable"], str(Path(expected["root"]) / NODE_FILE), "--run", "--root", expected["root"], "--evidence-dir", str(root)],
    ]
    for i, (name, args) in enumerate(zip(PROCESS_IDS, argv)):
        put(root, "processes/" + name + ".json", process(args, 10 * i))
        put(root, "logs/" + name + ".log", (HEAD + "\n").encode() if i == 0 else b"synthetic output\n")
    ids = [PY_FILE + "::test_synthetic_one", PY_FILE + "::SyntheticClass::test_synthetic_two[utf8-\u00e9]"]
    put(root, "python/collection.json", python_capture(ids))
    put(root, "python/reports.json", phase_capture(ids)); put(root, "python/junit.xml", junit(ids))
    binding = {"workflow_path": WORKFLOW, "workflow_sha256": expected["source_hashes"][WORKFLOW],
               "literal_sha256": expected["transfer_literal_sha256"], "harness_path": NODE_FILE,
               "harness_sha256": expected["source_hashes"][NODE_FILE],
               "capability_profile": "foobar-preview-transfer-fakes-v1", "node_version": "v20.18.0"}
    put(root, "node/list.json", {"schema_version": "foobar-preview-controls-node-list-v1", "case_ids": list(NODE_IDS), "binding": binding})
    events = []
    for i, node in enumerate(NODE_IDS):
        ledger_path = "node/ledgers/%03d.json" % (i + 1)
        events.extend([{"event": "start", "case_id": node, "sequence": i * 2 + 1},
                       {"event": "finish", "case_id": node, "sequence": i * 2 + 2,
                        "status": "passed", "error_code": None, "ledger_path": ledger_path}])
        ledgers = []
        if node.endswith("::fixture_forbidden_effect_attempt_survives_catch") or node.endswith("::fixture_unlisted_module_denied"):
            ledgers = [{"sequence": 1, "origin": "control", "capability": "forbidden",
                        "operation": "child_process.spawn" if "survives_catch" in node else "require.node:net",
                        "disposition": "blocked", "requested_bytes": None, "returned_bytes": None, "fake_time_ms": 0}]
        elif node.endswith("::fixture_host_environment_not_exposed"):
            ledgers = [{"sequence": 1, "origin": "control", "capability": "environment", "operation": "read.GITHUB_TOKEN",
                        "disposition": "fake", "requested_bytes": None, "returned_bytes": None, "fake_time_ms": 0}]
        put(root, ledger_path, {"schema_version": "foobar-preview-controls-fake-ledger-v1", "case_id": node, "events": ledgers})
    put(root, "node/runtime.json", {"schema_version": "foobar-preview-controls-node-runtime-v1", "binding": binding,
                                   "case_ids": list(NODE_IDS), "events": events, "writer_complete": True})
    seal(root)
    return root, expected, ids


def assert_result(result, status, *, code=None, phase=None):
    assert set(result) == {"schema_version", "authority", "status", "errors", "phases", "expected_ids", "observed_ids", "nodes", "completion", "continue_allowed"}
    assert result["schema_version"] == "foobar-preview-controls-validation-v1"
    assert result["authority"] == "supplemental-only" and result["completion"] == "unproven"
    assert result["continue_allowed"] is False and result["status"] == status
    assert [item["id"] for item in result["phases"]] == list(PROCESS_IDS)
    assert all(set(item) == {"id", "status"} for item in result["phases"])
    assert [item["case_id"] for item in result["nodes"]] == result["expected_ids"]
    assert result["observed_ids"] == [item["case_id"] for item in result["nodes"] if item["status"] == "passed"]
    for error in result["errors"]:
        assert set(error) == {"code", "location", "phase", "case_id", "message"}
        assert error["location"].startswith("/") and error["message"]
        assert error["phase"] in (*PROCESS_IDS, None)
        assert error["case_id"] is None or error["case_id"] in result["expected_ids"]
    if status == "passed":
        assert result["errors"] == []
    else:
        assert result["errors"]
    if code:
        assert any(item["code"] == code and (phase is None or item["phase"] == phase) for item in result["errors"])


def mutate_json(root, name, mutation):
    value = get(root, name)
    mutation(value)
    put(root, name, value)
    seal(root)


def cut_prefix(root, count):
    receipt = get(root, "receipt.json")
    receipt["attempted_process_ids"] = list(PROCESS_IDS[:count]); put(root, "receipt.json", receipt)
    for name in PROCESS_IDS[count:]:
        (root / ("processes/" + name + ".json")).unlink()
        (root / ("logs/" + name + ".log")).unlink()
    for prefix, required in (("python/collection.json", 2), ("python/reports.json", 3), ("python/junit.xml", 3), ("node/list.json", 4), ("node/runtime.json", 5)):
        if count < required:
            (root / prefix).unlink()
    if count < 5:
        for path in (root / "node/ledgers").glob("*.json"):
            path.unlink()
        (root / "node/ledgers").rmdir()
    for directory in (root / "python", root / "node"):
        if directory.exists() and not list(directory.iterdir()):
            directory.rmdir()
    seal(root)

NODE_IDS = (
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::positive_helper_exact_artifact",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::positive_reconcile_complete_chain",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::two_anonymous_metadata_requests",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::raw_acquisition_bytes_and_digests",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::public_api_and_blob_no_authorization",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::artifact_service_only_synthetic_token",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_non200",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::artifact_service_non200",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::blob_non200",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_link_header",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_location_header",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::redirect_no_follow",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::compressed_response",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::stream_error",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::stream_aborted",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::incomplete_stream",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::request_timeout",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::cancellation",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::shared_deadline_not_reset",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::request_deadline_at_10_seconds",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::request_deadline_over_10_seconds",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::shared_deadline_before_110_seconds",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::shared_deadline_at_110_seconds",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::no_retry_or_credential_fallback",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_declared_exact_limit",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_declared_over_limit",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_chunked_over_limit",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_aggregate_exact_limit",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::metadata_aggregate_over_limit",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::blob_declared_over_capacity",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::blob_chunked_over_capacity",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::actual_length_short",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::actual_length_long",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::invalid_utf8",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::nonfinite_exponent_positive",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::nonfinite_exponent_negative",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::nonfinite_literal",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::wrong_artifact_owner",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::wrong_artifact_name",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::wrong_artifact_run",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::wrong_artifact_id",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::wrong_artifact_digest",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::duplicate_artifact_ids",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::unsupported_signed_host",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::request_pull_64k_bound",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::buffer_capacity_bound",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_file_read_64k_bound",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_file_mutation_during_read",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_symlink_rejected",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::archive_aggregate_over_limit",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::retained_outputs_no_bearer",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::retained_outputs_no_signed_url",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::missing_upload_outputs_reconcile_explicit_absence",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::missing_upload_outputs_producer_holds",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::partial_upload_identity_rejected",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_forbidden_effect_attempt_survives_catch",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_unlisted_module_denied",
    "tests/ci/foobar_preview_transfer_literal_cases.cjs::fixture_host_environment_not_exposed",
)


def test_validator_complete_raw_pair_is_read_only_and_not_final_completion(validator, tmp_path):
    root, expected, ids = controls_proof(tmp_path)
    before = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    snapshot = copy.deepcopy(expected)
    result = validator(root, expected=expected)
    assert_result(result, "passed")
    assert result["expected_ids"] == ids + list(NODE_IDS) == result["observed_ids"]
    assert all(p["status"] == "passed" for p in result["phases"])
    assert all(n["cause"] is None for n in result["nodes"])
    assert before == {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    assert expected == snapshot
    assert validator(root, expected=expected) is not result


@pytest.mark.parametrize("key,value", [
    ("repository", "wrong/repo"), ("head_sha", "f" * 40), ("checkout_head", "e" * 40),
    ("workflow_path", WORKFLOW), ("job_id", "helper"), ("run_id", True), ("run_attempt", 1),
    ("root", "relative"), ("python_version", "3.12.0"), ("node_version", "v22.0.0"),
    ("event_sha256", "a" * 64), ("admission_sha256", "a" * 64),
    ("admission_context_sha256", "a" * 64), ("bootstrap_sha256", "a" * 64),
    ("transfer_literal_sha256", "a" * 64),
])
def test_validator_independent_expected_mismatch(validator, tmp_path, key, value):
    root, expected, _ = controls_proof(tmp_path)
    expected[key] = value
    result = validator(root, expected=expected)
    assert_result(result, "invalid")
    assert not result["observed_ids"]


@pytest.mark.parametrize("path", SOURCE_PATHS)
def test_validator_every_source_hash_is_mandatory_and_not_self_attested(validator, tmp_path, path):
    root, expected, _ = controls_proof(tmp_path)
    expected["source_hashes"][path] = "e" * 64
    result = validator(root, expected=expected)
    assert_result(result, "invalid")
    assert result["observed_ids"] == []


@pytest.mark.parametrize("record,field", [("context.json", "job_id"), ("receipt.json", "unexpected"),
    ("admission-context.json", "attempt"), ("node/list.json", "unexpected"), ("node/runtime.json", "unexpected")])
def test_validator_closed_record_schema(validator, tmp_path, record, field):
    root, expected, _ = controls_proof(tmp_path)
    mutate_json(root, record, lambda value: value.update({field: "wrong"}))
    assert_result(validator(root, expected=expected), "invalid")


@pytest.mark.parametrize("mutation", ["omitted_inspection", "draft", "scope", "native_active", "older_active", "prerequisite", "wrong_attempt", "hold"])
def test_validator_original_admission_is_rechecked_not_decision_only(validator, tmp_path, mutation):
    root, expected, _ = controls_proof(tmp_path)
    raw = get(root, "admission.json")
    if mutation == "omitted_inspection": raw["inspected"] = []
    elif mutation == "draft": raw["current"]["draft"] = False
    elif mutation == "scope": raw["current"]["control_labels"] = ["skip_tests"]
    elif mutation == "native_active": raw["native"]["status"] = "in_progress"
    elif mutation == "older_active":
        listing = raw["inspected"][2]["body"]
        older = copy.deepcopy(listing["workflow_runs"][0]); older.update(id=900, run_number=21, status="in_progress", conclusion=None)
        listing["workflow_runs"].append(older); listing["total_count"] = 2
    elif mutation == "prerequisite": raw["native"]["jobs"][0]["conclusion"] = "failure"
    elif mutation == "wrong_attempt": raw["inspected"][4]["body"]["run_attempt"] = 2
    else: raw["decision"] = "hold"
    put(root, "admission.json", raw)
    expected["admission_sha256"] = digest(encode(raw))
    context = get(root, "admission-context.json"); context["admission_sha256"] = expected["admission_sha256"]
    put(root, "admission-context.json", context); expected["admission_context_sha256"] = digest(encode(context))
    identity = {k: v for k, v in expected.items() if k != "cancelled"}
    put(root, "context.json", identity)
    receipt = get(root, "receipt.json"); receipt["identity"] = identity; put(root, "receipt.json", receipt); seal(root)
    assert_result(validator(root, expected=expected), "invalid", code="admission")


@pytest.mark.parametrize("payload", [b'{"a":1,"a":2}', b'{"x":1e999}', b'{"x":-1e999}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":"\xff"}', b'{}{}'])
def test_validator_strict_raw_json_even_when_inventory_is_resealed(validator, tmp_path, payload):
    root, expected, _ = controls_proof(tmp_path)
    put(root, "node/runtime.json", payload); seal(root)
    assert_result(validator(root, expected=expected), "invalid")


@pytest.mark.parametrize("mutation", ["digest", "size", "duplicate", "unsorted", "extra", "escape", "marker", "writing", "missing"])
def test_validator_complete_inventory_is_not_a_success_claim(validator, tmp_path, mutation):
    root, expected, _ = controls_proof(tmp_path)
    inventory = get(root, "inventory.json")
    if mutation == "digest": inventory["files"][0]["sha256"] = "f" * 64
    elif mutation == "size": inventory["files"][0]["size"] += 1
    elif mutation == "duplicate": inventory["files"].append(copy.deepcopy(inventory["files"][0]))
    elif mutation == "unsorted": inventory["files"].reverse()
    elif mutation == "escape": inventory["files"][0]["path"] = "../escape"
    elif mutation == "extra": put(root, "unlisted.json", b"{}")
    elif mutation == "writing": put(root, "receipt.json.writing", b"partial")
    elif mutation == "missing": (root / "node/runtime.json").unlink()
    if mutation == "marker":
        marker = get(root, "complete.json"); marker["writer_complete"] = False; put(root, "complete.json", marker)
    else:
        put(root, "inventory.json", inventory)
        marker = get(root, "complete.json"); marker["inventory_sha256"] = digest(encode(inventory)); put(root, "complete.json", marker)
    result = validator(root, expected=expected)
    assert result["status"] != "passed" and result["errors"]
    assert result["observed_ids"] == []


@pytest.mark.parametrize("pid", PROCESS_IDS)
@pytest.mark.parametrize("key,value,status", [("cleanup_complete", False, "cleanup_unsafe"), ("writer_errors", ["synthetic error"], "writer_uncertain"), ("cancelled", True, "cancelled")])
def test_validator_process_safety_overrides_green_reports(validator, tmp_path, pid, key, value, status):
    root, expected, _ = controls_proof(tmp_path)
    mutate_json(root, "processes/" + pid + ".json", lambda p: p.update({key: value}))
    assert_result(validator(root, expected=expected), status)


@pytest.mark.parametrize("mutation", ["argv", "extra_arg", "reversed", "overlap", "order", "over_budget", "null_finish", "bool_exit"])
def test_validator_actual_process_arguments_timeline_and_limits(validator, tmp_path, mutation):
    root, expected, _ = controls_proof(tmp_path)
    name = "processes/python_runtime.json"
    def change(p):
        if mutation == "argv": p["argv"][0] = "/other/python"
        elif mutation == "extra_arg": p["argv"].append("--only-one")
        elif mutation == "reversed": p["finished_at"] = stamp(19)
        elif mutation == "overlap": p["started_at"] = stamp(10)
        elif mutation == "over_budget": p["finished_at"] = stamp(261)
        elif mutation == "null_finish": p["finished_at"] = None
        elif mutation == "bool_exit": p["exit_code"] = False
    if mutation == "order":
        mutate_json(root, "receipt.json", lambda r: r["attempted_process_ids"].reverse())
    else: mutate_json(root, name, change)
    assert_result(validator(root, expected=expected), "invalid")


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "deselected", "skipped_collector", "failed_collector", "wrong_module", "reordered"])
def test_validator_whole_python_collection_has_no_silent_omission(validator, tmp_path, mutation):
    root, expected, ids = controls_proof(tmp_path)
    def change(p):
        if mutation == "missing": p["nodeids"].pop()
        elif mutation == "duplicate": p["nodeids"].append(ids[0])
        elif mutation == "deselected": p["deselected_nodeids"] = [ids[0]]
        elif mutation.endswith("collector"): p["collection_errors"] = [{"nodeid": PY_FILE, "outcome": "skipped" if mutation.startswith("skipped") else "failed", "longrepr": "synthetic"}]
        elif mutation == "wrong_module": p["discovered_nodeids"][0] = p["nodeids"][0] = "tests/py/other.py::test_no"
        else: p["nodeids"].reverse()
    mutate_json(root, "python/collection.json", change)
    result = validator(root, expected=expected)
    assert result["status"] != "passed"
    assert result["expected_ids"] == list(NODE_IDS), "Invalid collection cannot invent canonical Python ownership"


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "skip", "xfail", "xpass", "setup_error", "teardown_error", "wrong_node", "phase_order"])
def test_validator_raw_python_setup_call_teardown_is_authoritative(validator, tmp_path, mutation):
    root, expected, _ = controls_proof(tmp_path)
    def change(p):
        reports = p["reports"]
        if mutation == "missing": reports.pop()
        elif mutation == "duplicate": reports.append(copy.deepcopy(reports[0]))
        elif mutation == "skip": reports[1]["outcome"] = "skipped"
        elif mutation in ("xfail", "xpass"):
            reports[1]["wasxfail"] = "not acceptance"; reports[1]["outcome"] = "skipped" if mutation == "xfail" else "passed"
        elif mutation == "setup_error": reports[0]["outcome"] = "failed"
        elif mutation == "teardown_error": reports[2]["outcome"] = "failed"
        elif mutation == "wrong_node": reports[1]["nodeid"] = PY_FILE + "::uncollected"
        else: reports[0], reports[1] = reports[1], reports[0]
    mutate_json(root, "python/reports.json", change)
    assert validator(root, expected=expected)["status"] != "passed"


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "unmapped", "skip", "failure", "error", "counts", "dtd", "utf16"])
def test_validator_junit_identity_and_safe_xml_are_independent(validator, tmp_path, mutation):
    root, expected, ids = controls_proof(tmp_path)
    if mutation == "missing": raw = junit(ids[:1])
    elif mutation == "duplicate": raw = junit([ids[0], ids[0]])
    elif mutation == "unmapped": raw = junit([ids[0], PY_FILE + "::other"])
    else:
        raw = junit(ids)
        if mutation in ("skip", "failure", "error"):
            tag = "skipped" if mutation == "skip" else mutation
            raw = raw.replace(b'</testcase>', ('<' + tag + '/></testcase>').encode(), 1)
        elif mutation == "counts": raw = raw.replace(b'tests="2"', b'tests="3"')
        elif mutation == "dtd": raw = b'<!DOCTYPE testsuite [<!ENTITY secret "bad">]>' + raw
        else: raw = raw.decode().encode("utf-16")
    put(root, "python/junit.xml", raw); seal(root)
    result = validator(root, expected=expected)
    assert result["status"] != "passed" and any(e["code"] == "junit" for e in result["errors"])


@pytest.mark.parametrize("record", ["node/list.json", "node/runtime.json"])
@pytest.mark.parametrize("mutation", ["missing", "duplicate", "extra", "reorder", "binding", "literal", "version"])
def test_validator_fixed_node_tuple_and_source_binding(validator, tmp_path, record, mutation):
    root, expected, _ = controls_proof(tmp_path)
    def change(p):
        if mutation == "missing": p["case_ids"].pop()
        elif mutation == "duplicate": p["case_ids"].append(p["case_ids"][0])
        elif mutation == "extra": p["case_ids"].append(NODE_FILE + "::unreviewed")
        elif mutation == "reorder": p["case_ids"].reverse()
        elif mutation == "binding": p["binding"]["harness_sha256"] = "0" * 64
        elif mutation == "literal": p["binding"]["literal_sha256"] = "0" * 64
        else: p["binding"]["node_version"] = "v22.0.0"
    mutate_json(root, record, change)
    assert_result(validator(root, expected=expected), "invalid")


@pytest.mark.parametrize("mutation", ["missing_finish", "duplicate", "wrong_sequence", "skip", "unknown", "path", "writer", "caught_subject", "unexpected_control", "bad_control", "nan_clock", "unknown_capability"])
def test_validator_node_events_and_capability_ledger_cannot_mask_effects(validator, tmp_path, mutation):
    root, expected, _ = controls_proof(tmp_path)
    if mutation in ("caught_subject", "unexpected_control", "bad_control", "nan_clock", "unknown_capability"):
        name = "node/ledgers/001.json"
        event = {"sequence": 1, "origin": "subject", "capability": "forbidden", "operation": "child_process.spawn",
                 "disposition": "blocked", "requested_bytes": None, "returned_bytes": None, "fake_time_ms": 1}
        if mutation == "unexpected_control": event["origin"] = "control"
        elif mutation == "bad_control": event.update(origin="control", operation="require.fs")
        elif mutation == "unknown_capability": event.update(capability="real_network", disposition="fake")
        elif mutation == "nan_clock": event.update(capability="clock", disposition="fake", fake_time_ms=-1)
        mutate_json(root, name, lambda p: p["events"].append(event))
    else:
        def change(p):
            if mutation == "missing_finish": p["events"].pop()
            elif mutation == "duplicate": p["events"].append(copy.deepcopy(p["events"][-1]))
            elif mutation == "wrong_sequence": p["events"][1]["sequence"] = 1
            elif mutation == "skip": p["events"][1]["status"] = "skipped"
            elif mutation == "unknown": p["events"][1]["case_id"] = NODE_FILE + "::not_declared"
            elif mutation == "path": p["events"][1]["ledger_path"] = "../outside.json"
            else: p["writer_complete"] = False
        mutate_json(root, "node/runtime.json", change)
    result = validator(root, expected=expected)
    assert result["status"] != "passed"
    assert not any(node in result["observed_ids"] for node in NODE_IDS)


def test_validator_mixed_python_failure_never_promotes_green_nodes_from_exit_one(validator, tmp_path):
    root, expected, ids = controls_proof(tmp_path)
    cut_prefix(root, 3)
    put(root, "python/reports.json", phase_capture(ids, failed=ids[:1])); put(root, "python/junit.xml", junit(ids, failed=ids[:1]))
    mutate_json(root, "processes/python_runtime.json", lambda p: p.update(exit_code=1))
    result = validator(root, expected=expected)
    assert_result(result, "failed", code="assertion", phase="python_runtime")
    assert result["observed_ids"] == []
    assert [(n["status"], n["cause"]) for n in result["nodes"][:2]] == [("failed", "assertion_failed"), ("unknown", "invocation_nonzero_exit")]
    assert all(n["status"] == "unrun" for n in result["nodes"][2:])


@pytest.mark.parametrize("exit_code,terminal,error,status,cause", [
    (1, "failed", "assertion", "failed", "assertion_failed"),
    (2, "error", "harness", "invalid", "harness_error"),
    (7, "passed", None, "invalid", "unexpected_exit"),
    (0, "failed", "assertion", "invalid", "exit_report_mismatch"),
    (2, "passed", None, "invalid", "exit_report_mismatch"),
])
def test_validator_node_nonzero_and_exit_report_mismatch_accounting(validator, tmp_path, exit_code, terminal, error, status, cause):
    root, expected, ids = controls_proof(tmp_path)
    mutate_json(root, "processes/node_runtime.json", lambda p: p.update(exit_code=exit_code))
    mutate_json(root, "node/runtime.json", lambda p: p["events"][1].update(status=terminal, error_code=error))
    result = validator(root, expected=expected)
    assert_result(result, status)
    assert result["observed_ids"] == ids
    assert result["nodes"][2]["cause"] == cause
    assert all(n["status"] != "passed" for n in result["nodes"][2:])


@pytest.mark.parametrize("pid,count", [("python_collection", 2), ("python_runtime", 3), ("node_inventory", 4), ("node_runtime", 5)])
def test_validator_timeout_ownership_does_not_invent_runtime_attempts(validator, tmp_path, pid, count):
    root, expected, ids = controls_proof(tmp_path)
    cut_prefix(root, count)
    mutate_json(root, "processes/" + pid + ".json", lambda p: p.update(timed_out=True, exit_code=-9))
    result = validator(root, expected=expected)
    assert_result(result, "incomplete")
    assert result["phases"][count - 1]["status"] == "timed_out"
    if pid == "python_collection":
        assert result["expected_ids"] == list(NODE_IDS)
        assert all(n["status"] == "unrun" for n in result["nodes"])
    elif pid == "python_runtime":
        assert all(n["status"] == "timed_out" for n in result["nodes"][:2])
        assert all(n["status"] == "unrun" for n in result["nodes"][2:])
    elif pid == "node_inventory":
        assert result["observed_ids"] == ids
        assert all(n["status"] == "unrun" and n["cause"] == "predecessor_nonpass" for n in result["nodes"][2:])
    else: assert all(n["status"] == "timed_out" for n in result["nodes"][2:])


def test_validator_cancellation_is_external_and_dominates_safety_precedence(validator, tmp_path):
    root, expected, _ = controls_proof(tmp_path)
    expected["cancelled"] = True
    mutate_json(root, "processes/node_runtime.json", lambda p: p.update(cleanup_complete=False, writer_errors=["writer"]))
    result = validator(root, expected=expected)
    assert_result(result, "cancelled", code="cancellation")
    assert result["observed_ids"] == []

# Frozen plan data from the accepted specification, not the subject at runtime.
PLAN = json.loads(r'''
{
  "schema_version": "foobar-preview-plan-v1",
  "workflow_path": ".github/workflows/foobar-preview-backend-evidence.yml",
  "lane": "foobar-preview",
  "selectors": [
    "tests/py/test_foobar_snapshot_preview.py",
    "tests/py/test_foobar_snapshot_preview_resources.py"
  ],
  "legacy_helper_selectors": [
    "tests/py/test_new_feature_ci_contract.py",
    "tests/py/test_new_feature_evidence.py"
  ],
  "helper_selectors": [
    "tests/py/test_foobar_preview_ci_contract.py",
    "tests/py/test_foobar_preview_evidence.py"
  ],
  "core_count": 380,
  "resource_ids": [
    "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_entry_limit_is_not_truncation[at-limit]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_entry_limit_is_not_truncation[over-limit]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_revision_validation_precedes_count_and_count_precedes_entry_validation",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[at-limit-ascii]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[at-limit-utf8]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[over-limit-ascii]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[over-limit-utf8]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[invalid-over-budget]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[duplicate-over-budget]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[invalid-over-duplicate]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_maximum_parser_rows_are_preserved_and_share_one_candidate_projection",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_many_distinct_path_groups_keep_exact_counts_and_bounded_candidates",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_all_inventory_entries_can_be_distinct_candidates_without_false_uniqueness",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_invalid_parser_row_dimensions_reject_without_partial_results[empty]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_invalid_parser_row_dimensions_reject_without_partial_results[over-limit]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_header_width_boundary[at-limit]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_header_width_boundary[over-limit]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_total_cells_includes_header[at-limit]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_total_cells_includes_header[over-limit]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-ascii-header]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-ascii-cell]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-utf8-header]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-utf8-cell]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-ascii-header]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-ascii-cell]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-utf8-header]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-utf8-cell]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[at-limit-header]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[at-limit-row]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[over-limit-header]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[over-limit-row]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_zero_byte_data_record_is_invalid_even_with_consistent_empty_path",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_reconstructed_parser_64_mib_lower_bound[at-limit]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_reconstructed_parser_64_mib_lower_bound[over-limit]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_exact_diagnostic_prefix_and_truncation_accounting[at-cap]",
    "tests/py/test_foobar_snapshot_preview_resources.py::test_exact_diagnostic_prefix_and_truncation_accounting[over-cap]"
  ],
  "shards": [
    {
      "index": 1,
      "job": "resource_1",
      "assigned_ids": [
        "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_entry_limit_is_not_truncation[at-limit]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_entry_limit_is_not_truncation[over-limit]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_revision_validation_precedes_count_and_count_precedes_entry_validation",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[at-limit-ascii]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[at-limit-utf8]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[over-limit-ascii]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_inventory_aggregate_budget_counts_repeated_strings_per_entry[over-limit-utf8]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[invalid-over-budget]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[duplicate-over-budget]"
      ]
    },
    {
      "index": 2,
      "job": "resource_2",
      "assigned_ids": [
        "tests/py/test_foobar_snapshot_preview_resources.py::test_all_entries_and_duplicates_are_checked_before_aggregate_rejection[invalid-over-duplicate]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_maximum_parser_rows_are_preserved_and_share_one_candidate_projection",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_many_distinct_path_groups_keep_exact_counts_and_bounded_candidates",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_all_inventory_entries_can_be_distinct_candidates_without_false_uniqueness",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_invalid_parser_row_dimensions_reject_without_partial_results[empty]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_invalid_parser_row_dimensions_reject_without_partial_results[over-limit]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_header_width_boundary[at-limit]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_header_width_boundary[over-limit]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_total_cells_includes_header[at-limit]"
      ]
    },
    {
      "index": 3,
      "job": "resource_3",
      "assigned_ids": [
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_total_cells_includes_header[over-limit]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-ascii-header]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-ascii-cell]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-utf8-header]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[at-limit-utf8-cell]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-ascii-header]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-ascii-cell]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-utf8-header]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_cell_and_header_byte_bounds[over-limit-utf8-cell]"
      ]
    },
    {
      "index": 4,
      "job": "resource_4",
      "assigned_ids": [
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[at-limit-header]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[at-limit-row]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[over-limit-header]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_record_budget_includes_tab_separators[over-limit-row]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_parser_zero_byte_data_record_is_invalid_even_with_consistent_empty_path",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_reconstructed_parser_64_mib_lower_bound[at-limit]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_reconstructed_parser_64_mib_lower_bound[over-limit]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_exact_diagnostic_prefix_and_truncation_accounting[at-cap]",
        "tests/py/test_foobar_snapshot_preview_resources.py::test_exact_diagnostic_prefix_and_truncation_accounting[over-cap]"
      ]
    }
  ],
  "reuse": {
    "path": "scripts/ci/new_feature_evidence.py",
    "sha256": "8f45a3c1c3ada77a817928463527fb4add58f57f70a2d3f24cc9187cf5fb3673",
    "callables": [
      "run_owned",
      "process_success",
      "node_list",
      "timestamp",
      "owned_file"
    ]
  },
  "limits": {
    "collection_seconds": 300,
    "core_seconds": 600,
    "resource_seconds": 300,
    "helper_collection_seconds": 60,
    "helper_runtime_seconds": 180,
    "term_seconds": 30,
    "kill_reap_seconds": 30,
    "git_seconds": 10,
    "artifact_bytes": 268435456,
    "artifact_files": 4096,
    "file_bytes": 33554432,
    "aggregate_bytes": 2147483648,
    "aggregate_files": 32768
  },
  "job_minutes": {
    "admission": 2,
    "helper": 40,
    "core": 45,
    "resource_1": 90,
    "resource_2": 90,
    "resource_3": 90,
    "resource_4": 90,
    "reconcile": 15
  },
  "overhead_seconds": {
    "checkout": 120,
    "setup_python": 300,
    "install": 300,
    "download": 120,
    "verify": 120,
    "finalize": 120,
    "upload": 180
  }
}
''')

OWNERS = ("admission", "helper", "core", "resource_1", "resource_2", "resource_3", "resource_4", "reconcile")
STAGES = {
    "checkout": "Checkout exact pull-request head",
    "download": "Transfer only exact authenticated same-attempt artifact IDs",
    "verify": "Decode bounded inputs and validate complete upstream proof before setup",
    "setup_python": "Set up Python without post-job cache work",
    "install": "Install only existing requirements after raw-proof admission",
    "legacy": "Execute unchanged complete legacy CI-helper lane first",
    "admission": "Observe unchanged first-attempt and native-terminal admission",
}


def preview_process(root, relative, selected, start, *, runtime, collection=False, git=False, legacy=False):
    argv = ["git", "rev-parse", "HEAD"] if git else ["python", "-m", "pytest", *( ["--collect-only"] if collection else []),
        "--noconftest", "--import-mode=importlib", "-p", "no:cacheprovider", *selected]
    result = dict(process(argv, start, 3), id=relative, raw_log=relative + ".log",
                  limits={"runtime_seconds": runtime, "term_seconds": 30, "kill_reap_seconds": 30}, supervisor_sha256=OLD_HASH)
    put(root, result["raw_log"], (HEAD + "\n").encode() if git else b"synthetic raw output\n")
    if not legacy:
        put(root, relative + ".process.json", result)
    return result


def preview_pair(root, prefix, selectors, ids, start, *, product=False, legacy=False):
    record = preview_process(root, prefix + "/collect", selectors, start, runtime=300 if product else 60, collection=True, legacy=legacy)
    raw = python_capture(ids)
    if legacy:
        raw.pop("schema_version")
        raw.update({key: value for key, value in record.items() if key not in ("id", "limits", "supervisor_sha256")})
        raw["raw_log"] = raw["raw_log"].removeprefix("legacy/")
    path = prefix + "/collection.json"; put(root, path, raw)
    collection = {"path": path, "sha256": digest(encode(raw)), "selectors": selectors, "process": record}
    return collection


def preview_invocation(root, prefix, ids, start, runtime, *, legacy=False):
    invocation = preview_process(root, prefix + "/runtime", ids, start, runtime=runtime, legacy=legacy)
    invocation.update(selected_nodeids=ids, reports_json=prefix + "/reports.json", junit_xml=prefix + "/junit.xml")
    reports = phase_capture(ids)
    if legacy:
        reports.update(python_capture(ids))
    put(root, invocation["reports_json"], reports); put(root, invocation["junit_xml"], junit(ids))
    return invocation


def job_fixture(owner, start=100, duration=3):
    main = [STAGES["checkout"]]
    if owner == "admission": main += [STAGES["admission"], "Retain fresh original admission even on hold"]
    else:
        main += [STAGES[k] for k in ("download", "verify", "setup_python", "install")]
        if owner == "helper": main.append(STAGES["legacy"])
        main += ["Execute fixed " + ("resource" if owner.startswith("resource_") else owner) + " phase with fail-closed evidence", "Retain " + owner + " proof without masking any failure"]
    names = ["Set up job", *main, *(["Post " + STAGES["setup_python"]] if owner != "admission" else []), "Post " + STAGES["checkout"], "Complete job"]
    steps = []
    cursor = start
    for i, name in enumerate(names):
        span = 50 if name.startswith("Execute ") else duration
        steps.append({"name": name, "number": i + 1, "status": "completed", "conclusion": "success", "started_at": stamp(cursor), "completed_at": stamp(cursor + span)})
        cursor += span
    return {"id": 300 + OWNERS.index(owner), "name": owner, "run_id": 1234, "run_attempt": 2,
            "head_sha": HEAD, "head_branch": BRANCH, "workflow_name": "Foobar Preview Backend Evidence (supplemental)",
            "run_url": "https://api.github.com/repos/" + REPOSITORY + "/actions/runs/1234",
            "url": "https://api.github.com/repos/" + REPOSITORY + "/actions/jobs/" + str(300 + OWNERS.index(owner)),
            "status": "completed", "conclusion": "success", "started_at": stamp(start), "completed_at": stamp(cursor), "steps": steps}


def at_step(job, name):
    step = next(s for s in job["steps"] if s["name"] == name)
    return int((datetime.fromisoformat(step["started_at"]) - EPOCH).total_seconds()) + 1


def preview_graph(tmp_path):
    """Complete raw seven-owner graph, independent synthetic 380+36 collection."""
    base = tmp_path / "main-proof"; base.mkdir()
    sources = {p: digest(("source bytes " + p).encode()) for p in SOURCE_PATHS[:14]}
    sources["scripts/ci/new_feature_evidence.py"] = OLD_HASH
    expected = {"repository": REPOSITORY, "head_sha": HEAD, "checkout_head": HEAD, "workflow_path": WORKFLOW,
                "workflow_sha256": sources[WORKFLOW], "plan_sha256": sources["scripts/ci/foobar_preview_plan.json"],
                "run_id": 1234, "run_attempt": 2, "producer_job": "reconcile", "cancelled": False,
                "source_hashes": sources, "provenance": []}
    dirs, receipts, jobs = {}, {}, {}
    for owner in OWNERS[:-1]:
        path = base / owner; path.mkdir(); dirs[owner] = path
        expected["provenance"].append({"producer_job": owner, "artifact_name": "preview-v1-" + HEAD + "-1234-2-" + owner,
            "artifact_id": 500 + OWNERS.index(owner), "repository": REPOSITORY, "head_sha": HEAD,
            "workflow_path": WORKFLOW, "run_id": 1234, "run_attempt": 2})
        jobs[owner] = job_fixture(owner, 100 + OWNERS.index(owner) * 300)
    _, adm = admission_fixture()
    admission_path = put(dirs["admission"], "admission.json", adm)
    admission_hash = digest(admission_path.read_bytes())
    put(dirs["admission"], "admission-context.json", {"schema_version": 1, "repository": REPOSITORY, "head_sha": HEAD,
                                                    "run_id": 1234, "attempt": 2, "admission_sha256": admission_hash})
    full = [PLAN["selectors"][0] + "::test_synthetic_%03d" % i for i in range(380)] + PLAN["resource_ids"]
    for owner in OWNERS[1:-1]:
        path, job = dirs[owner], jobs[owner]
        for file in ("admission.json", "admission-context.json"):
            put(path, "admission/" + file, (dirs["admission"] / file).read_bytes())
        phase = "resource" if owner.startswith("resource_") else owner
        start = at_step(job, "Execute fixed " + phase + " phase with fail-closed evidence")
        selectors = PLAN["helper_selectors"] if owner == "helper" else PLAN["selectors"]
        ids = [p + "::test_synthetic" for p in selectors] if owner == "helper" else full
        assigned = ids if owner == "helper" else full[:380] if owner == "core" else PLAN["resource_ids"][(int(owner[-1]) - 1) * 9:int(owner[-1]) * 9]
        git = preview_process(path, "preview/git" if owner == "helper" else "git", [], start, runtime=10, git=True)
        collection = preview_pair(path, "preview" if owner == "helper" else "all", selectors, ids, start + 4, product=owner != "helper")
        invocations = [preview_invocation(path, "preview" if owner == "helper" else "execution/%02d" % i, nodes, start + 8 + 4 * i,
                                         180 if owner == "helper" else 600 if owner == "core" else 300)
                       for i, nodes in enumerate([assigned] if owner in ("helper", "core") else [[n] for n in assigned])]
        receipt = {"schema_version": "foobar-preview-evidence-v1", "lane": "foobar-preview", "phase": phase,
            **{key: expected[key] for key in ("repository", "head_sha", "workflow_path", "workflow_sha256", "plan_sha256", "run_id", "run_attempt")},
            "job_id": owner, "artifact_name": "preview-v1-" + HEAD + "-1234-2-" + owner,
            "admission_sha256": admission_hash, "helper_receipt_sha256": None if owner == "helper" else digest((dirs["helper"] / "receipt.json").read_bytes()),
            "canonical_core_sha256": digest((dirs["core"] / "receipt.json").read_bytes()) if phase == "resource" else None,
            "predecessor_receipt_sha256": digest((dirs[OWNERS[OWNERS.index(owner) - 1]] / "receipt.json").read_bytes()) if phase == "resource" else None,
            "source_hashes": {p: sources[p] for p in SOURCE_PATHS[:10 if owner == "helper" else 14]},
            "selectors": selectors, "collection_sha256": collection["sha256"], "full_discovered_ids": ids, "full_final_ids": ids,
            "collection_errors": [], "deselected_ids": [], "shard_index": int(owner[-1]) if phase == "resource" else None,
            "shard_count": 4, "assigned_ids": assigned, "invocation_ids": [r["id"] for r in invocations],
            "invocations": invocations, "collection": collection, "helper_proofs": None,
            "git_operations": [git], "claimed_status": "passed"}
        if owner == "helper":
            legacy_start = at_step(job, STAGES["legacy"])
            legacy_selectors = PLAN["legacy_helper_selectors"]; legacy_ids = [p + "::test_synthetic" for p in legacy_selectors]
            legacy_git = preview_process(path, "legacy/checkout", [], legacy_start, runtime=10, git=True, legacy=True)
            legacy_collection = preview_pair(path, "legacy", legacy_selectors, legacy_ids, legacy_start + 4, legacy=True)
            legacy_invocation = preview_invocation(path, "legacy", legacy_ids, legacy_start + 8, 180, legacy=True)
            receipt["git_operations"].insert(0, legacy_git)
            receipt["helper_proofs"] = {"legacy": {"selectors": legacy_selectors, "identity_path": "legacy/identity.json", "collection": legacy_collection, "invocation": legacy_invocation},
                                        "preview": {"selectors": selectors, "identity_path": "preview/identity.json", "collection": collection, "invocation": invocations[0]}}
            common = {"schema_version": 1, "head_sha": HEAD, "checkout_head": HEAD, "run_id": 1234, "admission_sha256": admission_hash}
            put(path, "legacy/identity.json", {**common, "lane": "ci-helper", "attempt": 2, "authority": "supplemental-only", "python_version": "3.11.9", "selectors": legacy_selectors,
                  "file_hashes": {p: sources[p] for p in [*legacy_selectors, "scripts/ci/new_feature_evidence.py", "scripts/ci/admit-new-feature-evidence.py"]}})
            put(path, "preview/identity.json", {**common, "lane": "foobar-preview-helper", "repository": REPOSITORY, "run_attempt": 2, "selectors": selectors, "source_hashes": receipt["source_hashes"]})
            for file in ("admission.json", "admission-context.json"):
                put(path, "legacy/" + file, (dirs["admission"] / file).read_bytes())
            put(path, "legacy/checkout-process.json", {k: v for k, v in legacy_git.items() if k not in ("id", "raw_log", "limits", "supervisor_sha256")})
            put(path, "legacy/collection.capture.json", dict(python_capture(legacy_ids), reports=[]))
            original = {k: v for k, v in legacy_invocation.items() if k not in ("limits", "supervisor_sha256")}
            for key in ("id", "raw_log", "reports_json", "junit_xml"): original[key] = original[key].removeprefix("legacy/")
            put(path, "legacy/invocations.json", [original])
        put(path, "receipt.json", receipt); seal(path, "foobar-preview")
        receipts[owner] = receipt
    jobs["reconcile"] = dict(job_fixture("reconcile", 2200), status="in_progress", conclusion=None, completed_at=None, steps=[])
    return dirs, receipts, jobs, expected


def transfer_fixture(tmp_path, monkeypatch, expected, jobs):
    transfer = tmp_path / "runner" / "foobar-preview-transfer"; transfer.mkdir(parents=True)
    monkeypatch.setenv("RUNNER_TEMP", str(transfer.parent)); monkeypatch.setenv("PREVIEW_TRANSFER_OUTCOME", "success")
    run = {"id": 1234, "run_attempt": 2, "repository": {"full_name": REPOSITORY}, "head_sha": HEAD,
           "head_branch": BRANCH, "event": "pull_request", "path": WORKFLOW,
           "name": "Foobar Preview Backend Evidence (supplemental)", "status": "in_progress", "conclusion": None}
    listing = {"total_count": len(jobs), "jobs": list(jobs.values())}
    base = "https://api.github.com/repos/" + REPOSITORY + "/actions/runs/1234/attempts/2"
    records = []
    for i, (kind, name, value, url) in enumerate((("run", "run-attempt.json", run, base), ("jobs", "attempt-jobs.json", listing, base + "/jobs?per_page=100&page=1"))):
        raw = encode(value); put(transfer, name, raw)
        records.append({"kind": kind, "url": url, "status": 200, "started_at": stamp(2300 + i), "finished_at": stamp(2300.5 + i), "size": len(raw), "sha256": digest(raw), "path": name})
    put(transfer, "acquisition.json", {"schema_version": "foobar-preview-acquisition-v1", **{key: expected[key] for key in ("repository", "head_sha", "workflow_path", "run_id", "run_attempt")},
                                     "consumer_job": expected["producer_job"], "responses": records})
    return transfer


def duration_of(record, finish="completed_at"):
    return (datetime.fromisoformat(record[finish]) - datetime.fromisoformat(record["started_at"])).total_seconds()


def independently_account(job, receipt):
    """Arithmetic oracle includes endpoint uncertainty, never subject helpers."""
    by_name = {p["name"]: p for p in job["steps"]}
    upper = {name: duration_of(p) + 2 for name, p in by_name.items()}
    overhead = dict.fromkeys(PLAN["overhead_seconds"], 0)
    overhead["checkout"] = upper[STAGES["checkout"]] + upper["Post " + STAGES["checkout"]]
    admission = job["name"] == "admission"
    overhead["upload"] = upper["Retain fresh original admission even on hold" if admission else "Retain " + job["name"] + " proof without masking any failure"]
    if not admission:
        for key in ("download", "verify", "setup_python", "install"): overhead[key] += upper[STAGES[key]]
        overhead["setup_python"] += upper["Post " + STAGES["setup_python"]]
        groups = [("Execute fixed " + ("resource" if job["name"].startswith("resource_") else job["name"]) + " phase with fail-closed evidence",
                   [receipt["git_operations"][-1], receipt["collection"]["process"], *receipt["invocations"]])]
        if job["name"] == "helper":
            legacy = receipt["helper_proofs"]["legacy"]
            groups.insert(0, (STAGES["legacy"], [receipt["git_operations"][0], legacy["collection"]["process"], legacy["invocation"]]))
        residual = sum(upper[name] - sum(max(0, duration_of(p, "finished_at") - 2) for p in records) for name, records in groups)
        overhead["verify"] += residual; overhead["finalize"] += residual
    slack = duration_of(job) + 2 - sum(max(0, duration_of(p) - 2) for p in job["steps"] if p["name"] not in ("Set up job", "Complete job"))
    return overhead, slack


def timing_fixture(owner="core"):
    job = job_fixture(owner)
    if owner == "admission": return job, None
    start = at_step(job, "Execute fixed " + ("resource" if owner.startswith("resource_") else owner) + " phase with fail-closed evidence")
    records = [dict(process(["synthetic"], start + i * 4, 3), limits={"runtime_seconds": 10 if i == 0 else 300, "term_seconds": 30, "kill_reap_seconds": 30}) for i in range(3)]
    receipt = {"git_operations": records[:1], "collection": {"process": records[1]}, "invocations": records[2:]}
    if owner == "helper":
        start = at_step(job, STAGES["legacy"])
        legacy = [dict(process(["synthetic"], start + i * 4, 3), limits={"runtime_seconds": 10 if i == 0 else 60 if i == 1 else 180, "term_seconds": 30, "kill_reap_seconds": 30}) for i in range(3)]
        receipt["git_operations"].insert(0, legacy[0])
        receipt["helper_proofs"] = {"legacy": {"collection": {"process": legacy[1]}, "invocation": legacy[2]}}
    return job, receipt


def extend_step(job, name, amount, receipt=None):
    """Shift downstream times coherently, keeping every owned process in its step."""
    step = next(s for s in job["steps"] if s["name"] == name)
    boundary = datetime.fromisoformat(step["completed_at"])
    step["completed_at"] = (boundary + timedelta(seconds=amount)).isoformat()
    for later in job["steps"][job["steps"].index(step) + 1:]:
        for key in ("started_at", "completed_at"): later[key] = (datetime.fromisoformat(later[key]) + timedelta(seconds=amount)).isoformat()
    job["completed_at"] = (datetime.fromisoformat(job["completed_at"]) + timedelta(seconds=amount)).isoformat()
    if receipt:
        records = [*receipt["git_operations"], receipt["collection"]["process"], *receipt["invocations"]]
        if "helper_proofs" in receipt:
            proof = receipt["helper_proofs"]["legacy"]; records += [proof["collection"]["process"], proof["invocation"]]
        for record in records:
            if datetime.fromisoformat(record["started_at"]) >= boundary:
                for key in ("started_at", "finished_at"): record[key] = (datetime.fromisoformat(record[key]) + timedelta(seconds=amount)).isoformat()


@pytest.mark.parametrize("owner", OWNERS[:-1])
def test_g01_complete_raw_prerequisites_and_exact_category_accounting(subject, tmp_path, monkeypatch, owner):
    directories, receipts, jobs, expected = preview_graph(tmp_path)
    consumer = OWNERS[OWNERS.index(owner) + 1]
    expected["producer_job"] = consumer
    jobs[consumer] = dict(jobs[consumer], status="in_progress", conclusion=None, completed_at=None, steps=[])
    jobs = {name: job for name, job in jobs.items() if OWNERS.index(name) <= OWNERS.index(consumer)}
    transfer_fixture(tmp_path, monkeypatch, expected, jobs)
    result = subject._c_completed_stages(copy.deepcopy(PLAN), expected, directories)
    assert result["holds"] == []
    assert [p["producer_job"] for p in result["owners"]] == list(OWNERS[:OWNERS.index(consumer)])
    assert result["own_future_completion"] == "unproven"
    assert result["timestamp_uncertainty_seconds_per_endpoint"] == 1
    assert result["residual_policy"] == "charge_each_mixed_step_residual_to_both_verify_and_finalize"
    for record in result["owners"]:
        name = record["producer_job"]
        overhead, slack = independently_account(jobs[name], receipts.get(name))
        assert record["overhead_upper_seconds"] == overhead
        assert record["unassigned_upper_seconds"] == slack
        assert record["job_upper_seconds"] == duration_of(jobs[name]) + 2
        assert record["completion"] == "complete" and record["source"] == "exact-attempt-jobs-api"


@pytest.mark.parametrize("category", ["checkout", "setup_python", "download", "verify", "install", "upload"])
@pytest.mark.parametrize("over", [0, 0.001])
def test_g02_separate_category_boundaries_include_post_and_residual(subject, category, over):
    job, receipt = timing_fixture()
    overhead, _ = independently_account(job, receipt)
    step_name = "Retain core proof without masking any failure" if category == "upload" else "Post " + STAGES[category] if category in ("checkout", "setup_python") else STAGES[category]
    extend_step(job, step_name, PLAN["overhead_seconds"][category] - overhead[category] + over, receipt)
    if over:
        with pytest.raises(Exception): subject._c_completed_job(job, "core", PLAN, receipt, {"status": "passed"}, EPOCH + timedelta(days=1))
    else:
        result = subject._c_completed_job(job, "core", PLAN, receipt, {"status": "passed"}, EPOCH + timedelta(days=1))
        assert result["overhead_upper_seconds"][category] == PLAN["overhead_seconds"][category]


def test_g02_full_residual_cannot_borrow_the_other_120_second_bucket(subject):
    job, receipt = timing_fixture()
    run = "Execute fixed core phase with fail-closed evidence"
    # Three owned durations are 3 s, lower bound 1 s each. 119+2-3=118 residual.
    extend_step(job, run, 69, receipt)
    overhead, _ = independently_account(job, receipt)
    assert overhead["finalize"] == 118 < 120
    assert overhead["verify"] == 123 > 120
    with pytest.raises(Exception): subject._c_completed_job(job, "core", PLAN, receipt, {"status": "passed"}, EPOCH + timedelta(days=1))


@pytest.mark.parametrize("mutation", ["reverse", "overlap", "reorder", "outside_start", "outside_end", "lower_sum", "runtime_cleanup"])
def test_g03_owned_time_cannot_buy_overhead_with_invalid_intervals(subject, mutation):
    step = {"started_at": stamp(100), "completed_at": stamp(120)}
    records = [dict(process(["synthetic"], 101 + 5 * i, 4), limits={"runtime_seconds": 10, "term_seconds": 30, "kill_reap_seconds": 30}) for i in range(3)]
    if mutation == "reverse": records[0]["finished_at"] = stamp(100)
    elif mutation == "overlap": records[1]["started_at"] = stamp(104)
    elif mutation == "reorder": records.reverse()
    elif mutation == "outside_start": records[0]["started_at"] = stamp(98)
    elif mutation == "outside_end": records[-1]["finished_at"] = stamp(122)
    elif mutation == "lower_sum":
        # With valid order/containment this branch cannot independently fail:
        # sum(max(0, duration-2)) <= enclosing duration <= enclosing upper.
        # This attempted excess must reject at the earliest effective guard.
        records[0]["finished_at"] = stamp(130)
    else:
        records = records[:1]
        records[0]["finished_at"] = stamp(172)
        step["completed_at"] = stamp(180)
    with pytest.raises(Exception): subject._c_owned_residual(step, records)


def test_g03_valid_endpoint_uncertainty_and_exact_runtime_cleanup_bound(subject):
    start, finish, upper, lower = subject._c_interval({"started_at": stamp(10), "completed_at": stamp(11)})
    assert (start, finish, upper, lower) == (EPOCH + timedelta(seconds=10), EPOCH + timedelta(seconds=11), 3, 0)
    record = dict(process(["synthetic"], 10, 70), limits={"runtime_seconds": 10, "term_seconds": 30, "kill_reap_seconds": 30})
    assert subject._c_owned_residual({"started_at": stamp(10), "completed_at": stamp(80)}, [record]) == 4


@pytest.mark.parametrize("owner,cap", [("helper", 280), ("core", 350), ("resource_1", 470)])
@pytest.mark.parametrize("location", ["Set up job", "Complete job", "interstage_gap"])
@pytest.mark.parametrize("over", [0, 0.001])
def test_g04_unassigned_setup_complete_and_gap_consume_fixed_slack(subject, owner, cap, location, over):
    job, receipt = timing_fixture(owner)
    _, slack = independently_account(job, receipt)
    if location == "interstage_gap":
        # Increase the containing job's leading gap without altering named work.
        job["started_at"] = (datetime.fromisoformat(job["started_at"]) - timedelta(seconds=cap - slack + over)).isoformat()
    else: extend_step(job, location, cap - slack + over, receipt)
    if over:
        with pytest.raises(Exception): subject._c_completed_job(job, owner, PLAN, receipt, {"status": "passed"}, EPOCH + timedelta(days=1))
    else:
        result = subject._c_completed_job(job, owner, PLAN, receipt, {"status": "passed"}, EPOCH + timedelta(days=1))
        assert result["completion"] == "complete"
        assert result["unassigned_upper_seconds"] == cap


def test_g04_job_cap_is_not_replaced_by_early_category_completion(subject):
    job, receipt = timing_fixture("core")
    # This case proves observed overall overrun rejection, not exclusive branch
    # coverage: under all subordinate bounds the overall cap is conservative.
    job["started_at"] = (datetime.fromisoformat(job["completed_at"]) - timedelta(seconds=2700)).isoformat()
    with pytest.raises(Exception): subject._c_completed_job(job, "core", PLAN, receipt, {"status": "passed"}, EPOCH + timedelta(days=1))


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "unknown", "reordered", "number", "running", "cancelled", "failed", "future", "unknown_post"])
def test_g05_exact_completed_stage_inventory(subject, mutation):
    job, receipt = timing_fixture()
    if mutation == "missing": job["steps"].pop()
    elif mutation == "duplicate": job["steps"].append(copy.deepcopy(job["steps"][0]))
    elif mutation in ("unknown", "unknown_post"): job["steps"][-2]["name"] = "Post unobserved action"
    elif mutation == "reordered": job["steps"][1], job["steps"][2] = job["steps"][2], job["steps"][1]
    elif mutation == "number": job["steps"][1]["number"] = job["steps"][0]["number"]
    elif mutation == "running": job["steps"][1]["status"] = "in_progress"
    elif mutation in ("cancelled", "failed"): job["steps"][1]["conclusion"] = "cancelled" if mutation == "cancelled" else "failure"
    observed = EPOCH if mutation == "future" else EPOCH + timedelta(days=1)
    with pytest.raises(Exception): subject._c_completed_job(job, "core", PLAN, receipt, {"status": "passed"}, observed)


@pytest.mark.parametrize("raw_status", ["assertion_failed", "timed_out_safe"])
@pytest.mark.parametrize("post_form", ["completed", "null", "equal", "positive", "half_null", "missing", "checkout_skipped", "upload_skipped"])
def test_g06_safe_failure_requires_observed_exact_conditional_post(subject, raw_status, post_form):
    job, receipt = timing_fixture()
    job["conclusion"] = "failure"
    next(p for p in job["steps"] if p["name"] == "Execute fixed core phase with fail-closed evidence")["conclusion"] = "failure"
    post = next(p for p in job["steps"] if p["name"] == "Post " + STAGES["setup_python"])
    if post_form in ("null", "equal", "positive", "half_null", "missing"): post["conclusion"] = "skipped"
    if post_form == "null": post.update(started_at=None, completed_at=None)
    elif post_form == "equal": post["completed_at"] = post["started_at"]
    elif post_form == "half_null": post["completed_at"] = None
    elif post_form == "missing": job["steps"].remove(post)
    elif post_form == "checkout_skipped": job["steps"][-2]["conclusion"] = "skipped"
    elif post_form == "upload_skipped": next(p for p in job["steps"] if p["name"].startswith("Retain "))["conclusion"] = "skipped"
    if post_form in ("completed", "null", "equal"):
        result = subject._c_completed_job(job, "core", PLAN, receipt, {"status": raw_status}, EPOCH + timedelta(days=1))
        assert result["completion"] == "complete"
        assert result["overhead_upper_seconds"]["setup_python"] == (10 if post_form == "completed" else 5)
    else:
        with pytest.raises(Exception): subject._c_completed_job(job, "core", PLAN, receipt, {"status": raw_status}, EPOCH + timedelta(days=1))


def test_g06_helper_failure_never_uses_product_safe_continuation(subject):
    job, receipt = timing_fixture("helper"); job["conclusion"] = "failure"
    with pytest.raises(Exception): subject._c_completed_job(job, "helper", PLAN, receipt, {"status": "assertion_failed"}, EPOCH + timedelta(days=1))


def refresh_acquisition(transfer):
    envelope = get(transfer, "acquisition.json")
    for record in envelope["responses"]:
        raw = (transfer / record["path"]).read_bytes()
        record.update(size=len(raw), sha256=digest(raw))
    put(transfer, "acquisition.json", envelope)


@pytest.mark.parametrize("mutation", ["head", "attempt", "run", "repository", "workflow", "owner", "url", "run_url", "duplicate_id", "duplicate_owner", "serial_overlap"])
def test_g07_exact_observed_producer_identity_and_serial_ownership(subject, tmp_path, monkeypatch, mutation):
    directories, _, jobs, expected = preview_graph(tmp_path)
    transfer = transfer_fixture(tmp_path, monkeypatch, expected, jobs)
    listing = get(transfer, "attempt-jobs.json")
    target = listing["jobs"][1]
    replacements = {"head": ("head_sha", "f" * 40), "attempt": ("run_attempt", 1), "run": ("run_id", 111),
                    "workflow": ("workflow_name", "Other workflow"), "owner": ("name", "other"),
                    "url": ("url", "https://api.github.com/repos/other/repo/actions/jobs/301"),
                    "run_url": ("run_url", "https://api.github.com/repos/other/repo/actions/runs/1234")}
    if mutation in replacements: target[replacements[mutation][0]] = replacements[mutation][1]
    elif mutation == "duplicate_id": target["id"] = listing["jobs"][0]["id"]
    elif mutation == "duplicate_owner": target["name"] = listing["jobs"][0]["name"]
    elif mutation == "serial_overlap": target["started_at"] = listing["jobs"][0]["started_at"]
    else:
        run = get(transfer, "run-attempt.json"); run["repository"]["full_name"] = "other/repo"; put(transfer, "run-attempt.json", run)
    put(transfer, "attempt-jobs.json", listing); refresh_acquisition(transfer)
    if mutation == "serial_overlap":
        result = subject._c_completed_stages(PLAN, expected, directories)
        assert any(h["producer_job"] == "helper" for h in result["holds"])
        assert not any(o["producer_job"] == "helper" for o in result["owners"])
    else:
        with pytest.raises(Exception): subject._c_completed_stages(PLAN, expected, directories)


@pytest.mark.parametrize("mutation", ["missing_response", "third_response", "wrong_url", "status", "digest", "size", "reverse", "overlap", "ten_seconds", "missing_transfer", "duplicate_json", "overflow_json", "utf8"])
def test_g08_exact_bounded_two_response_acquisition(subject, tmp_path, monkeypatch, mutation):
    directories, _, jobs, expected = preview_graph(tmp_path)
    transfer = transfer_fixture(tmp_path, monkeypatch, expected, jobs)
    envelope = get(transfer, "acquisition.json")
    if mutation == "missing_response": envelope["responses"].pop()
    elif mutation == "third_response": envelope["responses"].append(copy.deepcopy(envelope["responses"][0]))
    elif mutation == "wrong_url": envelope["responses"][1]["url"] += "&page=2"
    elif mutation == "status": envelope["responses"][0]["status"] = True
    elif mutation == "digest": envelope["responses"][0]["sha256"] = "0" * 64
    elif mutation == "size": envelope["responses"][0]["size"] += 1
    elif mutation == "reverse": envelope["responses"][0]["finished_at"] = stamp(2299)
    elif mutation == "overlap": envelope["responses"][1]["started_at"] = stamp(2300.25)
    elif mutation == "ten_seconds": envelope["responses"][0]["finished_at"] = stamp(2310)
    elif mutation == "missing_transfer": monkeypatch.delenv("PREVIEW_TRANSFER_OUTCOME")
    else:
        raw = (transfer / "run-attempt.json").read_bytes().rstrip()
        addition = {"duplicate_json": b',"id":1234', "overflow_json": b',"ignored":1e999', "utf8": b',"ignored":"\xff"'}[mutation]
        raw = raw[:-1] + addition + b"}\n"
        put(transfer, "run-attempt.json", raw)
        envelope["responses"][0].update(size=len(raw), sha256=digest(raw))
    put(transfer, "acquisition.json", envelope)
    with pytest.raises(Exception): subject._c_completed_stages(PLAN, expected, directories)


@pytest.mark.parametrize("consumer", ["core", "reconcile"])
@pytest.mark.parametrize("mutation", ["raw_phase", "cleanup", "inventory", "legacy_checkout"])
def test_g09_timing_success_cannot_replace_actual_raw_proof(subject, tmp_path, monkeypatch, consumer, mutation):
    directories, receipts, jobs, expected = preview_graph(tmp_path)
    expected["producer_job"] = consumer
    jobs[consumer] = dict(jobs[consumer], status="in_progress", conclusion=None, completed_at=None, steps=[])
    jobs = {name: job for name, job in jobs.items() if OWNERS.index(name) <= OWNERS.index(consumer)}
    transfer_fixture(tmp_path, monkeypatch, expected, jobs)
    root = directories["helper"]
    if mutation == "raw_phase":
        reports = get(root, "preview/reports.json"); reports["reports"].pop(); put(root, "preview/reports.json", reports)
    elif mutation == "cleanup":
        raw = get(root, "preview/runtime.process.json"); raw["cleanup_complete"] = False; put(root, "preview/runtime.process.json", raw)
    elif mutation == "legacy_checkout":
        raw = get(root, "legacy/checkout-process.json"); raw["exit_code"] = 1; put(root, "legacy/checkout-process.json", raw)
    else: put(root, "unexpected.bin", b"not owned")
    if mutation != "inventory": seal(root, "foobar-preview")
    if consumer == "core":
        with pytest.raises(Exception): subject._c_completed_stages(PLAN, expected, directories)
    else:
        result = subject._c_completed_stages(PLAN, expected, directories)
        assert any(h["producer_job"] == "helper" for h in result["holds"])
        assert not any(o["producer_job"] != "admission" for o in result["owners"])
        assert result["own_future_completion"] == "unproven"


def test_g10_local_gate_never_fabricates_its_future_post_or_upload(subject, tmp_path, monkeypatch):
    directories, _, jobs, expected = preview_graph(tmp_path)
    transfer_fixture(tmp_path, monkeypatch, expected, jobs)
    result = subject._c_completed_stages(PLAN, expected, directories)
    assert result["own_future_completion"] == "unproven"
    assert "reconcile" not in [r["producer_job"] for r in result["owners"]]
    assert jobs["reconcile"]["completed_at"] is None and jobs["reconcile"]["steps"] == []


def independent_zip(entries, *, count=None, gap=b"", zip64=False):
    """Small byte-level ZIP writer, no subject/ZipFile used for expected bytes."""
    local, central = bytearray(), bytearray()
    for specification in entries:
        item = dict(specification); name = item.get("name", "one.bin").encode("utf-8")
        data = item.get("data", b"bounded payload")
        method, flags = item.get("method", 0), item.get("flags", 2048)
        if "compressed" in item: compressed = item["compressed"]
        elif method == 8:
            compressor = zlib.compressobj(level=6, wbits=-15); compressed = compressor.compress(data) + compressor.flush()
        else: compressed = data
        crc = item.get("crc", zlib.crc32(data) & 0xffffffff)
        size = item.get("size", len(data)); compressed_size = item.get("compressed_size", len(compressed))
        offset = item.get("offset", len(local)); local_name = item.get("local_name", name)
        local.extend(struct.pack('<4s5H3I2H', b'PK\x03\x04', 20, item.get("local_flags", flags), item.get("local_method", method), 0, 0,
                                 item.get("local_crc", crc), item.get("local_compressed_size", compressed_size), item.get("local_size", size), len(local_name), 0))
        local.extend(local_name); local.extend(compressed); local.extend(item.get("descriptor", b""))
        central.extend(struct.pack('<4s6H3I5H2I', b'PK\x01\x02', (3 << 8) | 20, 20, flags, method, 0, 0, crc, compressed_size, size,
                                   len(name), 0, 0, 0, 0, item.get("mode", stat.S_IFREG | 0o600) << 16, offset)); central.extend(name)
    start, length = len(local), len(central)
    content = bytes(local + central) + gap
    n = len(entries) if count is None else count
    if zip64:
        zip_offset = len(content)
        content += struct.pack('<4sQ2H2I4Q', b'PK\x06\x06', 44, 45, 45, 0, 0, n, n, length, start)
        content += struct.pack('<4sIQI', b'PK\x06\x07', 0, zip_offset, 1)
        content += struct.pack('<4s4H2IH', b'PK\x05\x06', 0, 0, 65535, 65535, 4294967295, 4294967295, 0)
    else: content += struct.pack('<4s4H2IH', b'PK\x05\x06', 0, 0, n, n, length, start, 0)
    return content, start


class ReadLedger:
    def __init__(self, stream, ledger): self.stream, self.ledger = stream, ledger
    def read(self, size=-1):
        self.ledger.append(size)
        assert type(size) is int and 0 <= size <= 65557, "unbounded archive read"
        return self.stream.read(size)
    def __getattr__(self, name): return getattr(self.stream, name)
    def __enter__(self): return self
    def __exit__(self, *args): return self.stream.__exit__(*args)


@pytest.mark.parametrize("method,data,compressed", [(0, b"abcdef", None), (8, b"abcdef", None), (0, b"", None), (8, b"", None), (8, b"", b"\x01\x00\x00\xff\xff")])
def test_g11_small_stored_deflated_empty_and_output_free_terminal_blocks(subject, tmp_path, method, data, compressed):
    specification = {"data": data, "method": method}
    if compressed is not None: specification["compressed"] = compressed
    raw, central = independent_zip([specification]); archive = put(tmp_path, "input.zip", raw)
    assert subject._c_zip_preflight(archive) == (1, central)
    assert subject._c_decode_zip(archive, tmp_path / "output", len(data), 1) == (len(data), 1)
    assert (tmp_path / "output/one.bin").read_bytes() == data


def test_g12_actual_4097_records_reject_before_zipfile_allocates(subject, tmp_path, monkeypatch):
    raw, _ = independent_zip([{"name": "%04d" % i, "data": b""} for i in range(4097)], count=4096)
    path = put(tmp_path, "input.zip", raw)
    constructors, reads = [], []
    original = Path.open
    def opening(p, *args, **kwargs):
        stream = original(p, *args, **kwargs)
        return ReadLedger(stream, reads) if p == path else stream
    def constructor(*args, **kwargs):
        constructors.append(True); raise AssertionError("ZipFile allocated before bounded central count")
    monkeypatch.setattr(Path, "open", opening); monkeypatch.setattr(subject.zipfile, "ZipFile", constructor)
    with pytest.raises(Exception): subject._c_decode_zip(path, tmp_path / "output", 268435456, 4096)
    assert constructors == [] and reads and max(reads) <= 65557
    assert not (tmp_path / "output").exists()


@pytest.mark.parametrize("mutation", ["signature", "empty_name", "long_name", "extra_escape", "comment_escape", "truncated", "count", "multidisk", "directory_over"])
def test_g13_malformed_central_directory_rejects_before_constructor(subject, tmp_path, monkeypatch, mutation):
    raw, central = independent_zip([{"data": b"x"}]); raw = bytearray(raw)
    if mutation == "signature": raw[central:central + 4] = b"BAD!"
    elif mutation == "empty_name": struct.pack_into('<H', raw, central + 28, 0)
    elif mutation == "long_name": struct.pack_into('<H', raw, central + 28, 4097)
    elif mutation == "extra_escape": struct.pack_into('<H', raw, central + 30, 65535)
    elif mutation == "comment_escape": struct.pack_into('<H', raw, central + 32, 65535)
    elif mutation == "truncated": del raw[central + 20:central + 30]
    elif mutation == "count": struct.pack_into('<HH', raw, len(raw) - 14, 2, 2)
    elif mutation == "multidisk": struct.pack_into('<H', raw, len(raw) - 18, 1)
    else: struct.pack_into('<I', raw, len(raw) - 12, 8388609)
    path = put(tmp_path, "input.zip", bytes(raw)); constructors = []
    def constructor(*a, **kw): constructors.append(True); raise AssertionError("constructor reached")
    monkeypatch.setattr(subject.zipfile, "ZipFile", constructor)
    with pytest.raises(Exception): subject._c_decode_zip(path, tmp_path / "output", 268435456, 4096)
    assert constructors == []


def test_g13_exact_4096_central_records_are_not_truncated(subject, tmp_path):
    raw, central = independent_zip([{"name": "%04d" % i, "data": b""} for i in range(4096)])
    assert subject._c_zip_preflight(put(tmp_path, "exact.zip", raw)) == (4096, central)


@pytest.mark.parametrize("mutation", ["gap", "second_directory", "locator", "noncontiguous", "nonsentinel_bad"])
def test_g14_ambiguous_or_noncontiguous_end_records_hold(subject, tmp_path, monkeypatch, mutation):
    raw, central = independent_zip([{"data": b"x"}], gap=b"gap" if mutation == "gap" else b"", zip64=mutation in ("locator", "noncontiguous", "nonsentinel_bad"))
    raw = bytearray(raw)
    if mutation == "second_directory": raw = raw[:-22] + raw[central:]
    elif mutation == "locator": struct.pack_into('<I', raw, len(raw) - 38, 1)
    elif mutation == "noncontiguous": struct.pack_into('<Q', raw, len(raw) - 34, central)
    elif mutation == "nonsentinel_bad":
        struct.pack_into('<HHII', raw, len(raw) - 14, 1, 1, 53, central)
        struct.pack_into('<Q', raw, len(raw) - 94, 43)
    constructors = []
    def constructor(*a, **kw): constructors.append(True); raise AssertionError("constructor reached")
    monkeypatch.setattr(subject.zipfile, "ZipFile", constructor)
    with pytest.raises(Exception): subject._c_decode_zip(put(tmp_path, "input.zip", bytes(raw)), tmp_path / "output", 268435456, 4096)
    assert constructors == []


def test_g14_restricted_contiguous_zip64_is_valid(subject, tmp_path):
    raw, central = independent_zip([{"data": b"zip64"}], zip64=True)
    archive = put(tmp_path, "input.zip", raw)
    assert subject._c_zip_preflight(archive) == (1, central)
    assert subject._c_decode_zip(archive, tmp_path / "output", 5, 1) == (5, 1)
    assert (tmp_path / "output/one.bin").read_bytes() == b"zip64"


@pytest.mark.parametrize("specifications", [
    [{"name": "same"}, {"name": "same"}], [{"name": "/absolute"}], [{"name": "../escape"}],
    [{"name": "a\\b"}], [{"name": "C:bad"}], [{"name": "nul\x00suffix"}], [{"name": "directory/"}],
    [{"mode": stat.S_IFLNK | 0o777}], [{"mode": stat.S_IFIFO | 0o600}], [{"flags": 2049}], [{"method": 99}],
    [{"local_name": b"two.bin"}], [{"local_flags": 0}], [{"local_method": 8}], [{"local_size": 123}],
    [{"local_compressed_size": 123}], [{"local_crc": 1}],
])
def test_g15_unconfined_and_disagreeing_zip_entries_hold(subject, tmp_path, specifications):
    raw, _ = independent_zip(specifications)
    with pytest.raises(Exception): subject._c_decode_zip(put(tmp_path, "input.zip", raw), tmp_path / "output", 268435456, 4096)
    assert not (tmp_path / "escape").exists()


@pytest.mark.parametrize("size", [268435456, 268435457])
def test_g16_encoded_size_gate_precedes_consumption_without_allocating_archive(subject, size):
    effects = []
    class ConsumptionProbe(Exception): pass
    class SyntheticPath:
        def stat(self): return type("Metadata", (), {"st_size": size})()
        def open(self, mode):
            effects.append(("open", mode)); raise ConsumptionProbe()
    if size == 268435456:
        with pytest.raises(ConsumptionProbe): subject._c_zip_preflight(SyntheticPath())
        assert effects == [("open", "rb")]
    else:
        with pytest.raises(Exception): subject._c_zip_preflight(SyntheticPath())
        assert effects == []


@pytest.mark.parametrize("case", ["file_exact", "file_over", "decoded_exact", "decoded_over", "remaining_exact", "remaining_over", "files_exact", "files_over"])
def test_g16_metadata_capacity_boundaries_before_local_payload_read(subject, tmp_path, monkeypatch, case):
    """A deliberate consumption probe proves only the metadata gate, not decoded acceptance."""
    sizes = {"file_exact": [33554432], "file_over": [33554433],
             "decoded_exact": [33554432] * 8, "decoded_over": [33554432] * 8 + [1],
             "remaining_exact": [17], "remaining_over": [18], "files_exact": [0, 0], "files_over": [0, 0]}[case]
    archive, _ = independent_zip([{"name": "f%d" % i, "data": b""} for i in range(len(sizes))])
    path = put(tmp_path, "metadata.zip", archive)
    infos = []
    for i, size in enumerate(sizes):
        info = zipfile.ZipInfo("f%d" % i)
        info.external_attr = (stat.S_IFREG | 0o600) << 16
        info.file_size = size; info.compress_size = size; info.compress_type = 0; info.flag_bits = 0
        infos.append(info)
    acquired, consumed = [], []
    class ConsumptionProbe(Exception): pass
    class FakeArchive:
        def __enter__(self): acquired.append("constructor"); return self
        def __exit__(self, *args): return False
        def infolist(self): return infos
    original_open = Path.open
    class PayloadProbe:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def seek(self, *args): pass
        def read(self, amount): consumed.append(amount); raise ConsumptionProbe()
    def opening(p, *args, **kwargs):
        if p == path and acquired: return PayloadProbe()
        return original_open(p, *args, **kwargs)
    monkeypatch.setattr(subject.zipfile, "ZipFile", lambda *a, **kw: FakeArchive())
    monkeypatch.setattr(Path, "open", opening)
    remaining = 17 if case.startswith("remaining_") else 2147483648
    files = 1 if case == "files_over" else len(sizes)
    if case.endswith("exact"):
        with pytest.raises(ConsumptionProbe): subject._c_decode_zip(path, tmp_path / "output", remaining, files)
        assert consumed == [30]
    else:
        with pytest.raises(Exception): subject._c_decode_zip(path, tmp_path / "output", remaining, files)
        assert consumed == []
    # In particular decoded_over cannot borrow the 2 GiB joining allowance.


@pytest.mark.parametrize("mutation", ["data_crosses", "overlap", "descriptor_bad", "descriptor_ambiguous", "crc", "truncated", "concatenated", "overflow"])
def test_g17_data_descriptor_stream_and_crc_fail_closed(subject, tmp_path, mutation):
    entry = {"name": "one.bin", "data": b"abc", "method": 8}
    if mutation == "data_crosses": entry["compressed_size"] = 10000
    elif mutation == "descriptor_bad": entry.update(flags=2056, descriptor=struct.pack('<III', 1, 1, 1))
    elif mutation == "descriptor_ambiguous": entry.update(data=b"", method=0, flags=2056, descriptor=b"\0" * 20)
    elif mutation == "crc": entry["crc"] = 1
    elif mutation == "truncated": entry["compressed"] = b"\x4b\x4c"
    elif mutation == "concatenated": entry["compressed"] = b"\x4b\x4c\x4a\x06\x00\x03\x00"
    elif mutation == "overflow": entry.update(data=b"x", size=0, crc=0)
    entries = [entry]
    if mutation == "overlap":
        nested_name, nested_data = b"two.bin", b"abc"
        nested = struct.pack('<4s5H3I2H', b'PK\x03\x04', 20, 2048, 0, 0, 0, zlib.crc32(nested_data) & 0xffffffff, 3, 3, len(nested_name), 0) + nested_name + nested_data
        entries = [{"name": "one.bin", "data": b"prefix" + nested},
                   {"name": "two.bin", "data": nested_data, "offset": 30 + len(b"one.bin") + len(b"prefix")}]

    raw, _ = independent_zip(entries)
    with pytest.raises(Exception): subject._c_decode_zip(put(tmp_path, "input.zip", raw), tmp_path / "output", 268435456, 4096)
    if mutation == "overflow":
        assert (tmp_path / "output/one.bin").read_bytes() == b""


@pytest.mark.parametrize("signature,width", [(False, 32), (True, 32), (False, 64), (True, 64)])
def test_g17_unique_valid_data_descriptors_preserve_exact_bytes(subject, tmp_path, signature, width):
    data = b"descriptor bytes"; crc = zlib.crc32(data) & 0xffffffff
    descriptor = (b'PK\x07\x08' if signature else b'') + struct.pack('<III' if width == 32 else '<IQQ', crc, len(data), len(data))
    raw, _ = independent_zip([{"data": data, "flags": 2056, "descriptor": descriptor}])
    assert subject._c_decode_zip(put(tmp_path, "input.zip", raw), tmp_path / "output", len(data), 1) == (len(data), 1)
    assert (tmp_path / "output/one.bin").read_bytes() == data


def test_g18_bounded_reads_inflater_capacity_and_zero_allowance_probe(subject, tmp_path, monkeypatch):
    raw, _ = independent_zip([{"data": b"x", "method": 8, "size": 0, "crc": 0}])
    path = put(tmp_path, "input.zip", raw)
    reads, capacities, writes, extraction = [], [], [], []
    original_open, original_inflater = Path.open, zlib.decompressobj
    class Inflater:
        def __init__(self, inner): self.inner = inner
        def decompress(self, data, size):
            capacities.append(size); assert 0 < size <= 65536
            return self.inner.decompress(data, size)
        def __getattr__(self, name): return getattr(self.inner, name)
    class Output:
        def __init__(self, inner): self.inner = inner
        def __enter__(self): return self
        def __exit__(self, *args): return self.inner.__exit__(*args)
        def write(self, data): writes.append(len(data)); return self.inner.write(data)
        def __getattr__(self, name): return getattr(self.inner, name)
    def opening(p, *args, **kwargs):
        stream = original_open(p, *args, **kwargs)
        if p == path: return ReadLedger(stream, reads)
        if args and args[0] == "xb": return Output(stream)
        return stream
    def extract(*a, **kw): extraction.append(True); raise AssertionError("unsafe extraction")
    monkeypatch.setattr(Path, "open", opening)
    monkeypatch.setattr(subject.zlib, "decompressobj", lambda *a: Inflater(original_inflater(*a)))
    monkeypatch.setattr(subject.zipfile.ZipFile, "extractall", extract)
    with pytest.raises(Exception): subject._c_decode_zip(path, tmp_path / "output", 268435456, 4096)
    assert reads and all(0 <= size <= 65557 for size in reads)
    assert capacities == [1] and writes == [] and extraction == []


def test_g18_existing_destination_is_never_reused(subject, tmp_path):
    raw, _ = independent_zip([{"data": b"safe"}]); destination = tmp_path / "output"; destination.mkdir()
    sentinel = put(destination, "keep", b"unchanged")
    with pytest.raises(Exception): subject._c_decode_zip(put(tmp_path, "input.zip", raw), destination, 268435456, 4096)
    assert sentinel.read_bytes() == b"unchanged" and list(destination.iterdir()) == [sentinel]


def raw_invocation_fixture(tmp_path):
    root = tmp_path / "invocation"; root.mkdir()
    ids = [PLAN["selectors"][0] + "::test_synthetic_one", PLAN["selectors"][0] + "::test_synthetic_two"]
    invocation = preview_invocation(root, "owned", ids, 10, 600)
    return root, invocation, ids


def test_g19_actual_process_sidecar_and_envelope_agree(subject, tmp_path):
    root, invocation, ids = raw_invocation_fixture(tmp_path)
    result = subject.validate_invocation(root, invocation, assigned_ids=ids, owner="core")
    assert result["status"] == "passed" and result["observed_ids"] == ids


@pytest.mark.parametrize("key,value", [("cleanup_complete", False), ("timed_out", True), ("cancelled", True),
    ("exit_code", 1), ("writer_errors", ["lost writer"]), ("argv", ["other"]), ("started_at", stamp(11)),
    ("finished_at", stamp(14)), ("limits", {"runtime_seconds": 601, "term_seconds": 30, "kill_reap_seconds": 30}),
    ("supervisor_sha256", "0" * 64), ("raw_log", "other.log"), ("id", "other")])
def test_g19_actual_sidecar_contradiction_cannot_be_hidden_by_green_envelope(subject, tmp_path, key, value):
    root, invocation, ids = raw_invocation_fixture(tmp_path)
    raw = get(root, "owned/runtime.process.json"); raw[key] = value; put(root, "owned/runtime.process.json", raw)
    result = subject.validate_invocation(root, invocation, assigned_ids=ids, owner="core")
    assert result["status"] != "passed" and result["observed_ids"] == []
    assert any(error["code"] == "process" for error in result["errors"])


def test_g19_resealed_full_artifact_still_cross_checks_actual_sidecar(subject, tmp_path):
    directories, _, _, expected = preview_graph(tmp_path)
    expected["producer_job"] = "helper"
    raw = get(directories["helper"], "preview/runtime.process.json"); raw["cleanup_complete"] = False
    put(directories["helper"], "preview/runtime.process.json", raw); seal(directories["helper"], "foobar-preview")
    result = subject.validate_artifact(directories["helper"], plan=PLAN, expected=expected, inputs={"admission": directories["admission"]})
    assert result["status"] != "passed" and result["observed_ids"] == []


def test_g20_synthetic_direct_fixture_without_production_markers_remains_valid(subject, tmp_path):
    root, invocation, ids = raw_invocation_fixture(tmp_path)
    (root / "owned/runtime.process.json").unlink()
    assert subject.validate_invocation(root, invocation, assigned_ids=ids, owner="core")["status"] == "passed"


def test_g20_producer_inventory_marker_requires_actual_sidecar(subject, tmp_path):
    directories, _, _, expected = preview_graph(tmp_path); expected["producer_job"] = "helper"
    root = directories["helper"]
    put(root, "transfer-context.json", {"synthetic": "production inventory marker"})
    (root / "preview/runtime.process.json").unlink(); seal(root, "foobar-preview")
    result = subject.validate_artifact(root, plan=PLAN, expected=expected, inputs={"admission": directories["admission"]})
    assert result["status"] != "passed" and result["observed_ids"] == []
    assert any("process.json" in error["location"] for error in result["errors"])


def test_g20_real_wrapper_without_actual_sidecar_is_not_synthetic_direct_mode(subject, tmp_path):
    directories, receipts, _, expected = preview_graph(tmp_path); expected["producer_job"] = "core"
    root = directories["core"]; receipt = receipts["core"]; invocation = receipt["invocations"][0]
    # Read the literal as source data. This never invokes the child program.
    tree = ast.parse((ROOT / SUBJECT).read_text(encoding="utf-8"))
    program = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == "_CHILD_PROGRAM" for t in node.targets))
    base = invocation["raw_log"][:-4]
    invocation["reports_json"] = base + ".json"
    old_junit = invocation["junit_xml"]
    invocation["junit_xml"] = base + ".xml"
    put(root, invocation["junit_xml"], (root / old_junit).read_bytes())
    (root / old_junit).unlink()
    put(root, invocation["reports_json"], (root / "execution/00/reports.json").read_bytes())
    (root / "execution/00/reports.json").unlink()
    invocation["argv"] = ["python", "-c", program, str(tmp_path / "checkout"), str(root / (base + ".request.json")), *invocation["selected_nodeids"]]
    request = {"schema_version": "foobar-preview-child-v1", "mode": "run", "phase": "core", "expected": expected,
               "selection": invocation["selected_nodeids"], "collection_path": receipt["collection"]["path"],
               "reports_path": invocation["reports_json"], "junit_path": invocation["junit_xml"]}
    put(root, base + ".request.json", request)
    (root / (base + ".process.json")).unlink(); put(root, "receipt.json", receipt); seal(root, "foobar-preview")
    result = subject.validate_artifact(root, plan=PLAN, expected=expected, inputs={p: directories[p] for p in ("admission", "helper")})
    assert result["status"] != "passed" and result["observed_ids"] == []
    assert any("process.json" in error["location"] for error in result["errors"])


@pytest.mark.parametrize("raw", [b'{"x":1e999}', b'{"x":-1e999}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":-Infinity}', b'{"x":1,"x":2}', b'{"x":"\xff"}'])
def test_g21_all_raw_json_decoders_reject_nonfinite_duplicate_invalid_utf8(subject, raw):
    with pytest.raises(Exception): subject._c_json_bytes(raw)
    with pytest.raises(Exception): subject._v_decode(raw, "/synthetic")


def test_g21_ordinary_finite_json_retains_exact_raw_digest(subject):
    raw = b' { "unused" : [1e3, -0.25, null, true, "\xc3\xa9"] }\n'
    wanted = {"unused": [1000.0, -0.25, None, True, "\u00e9"]}
    assert subject._c_json_bytes(raw) == wanted == subject._v_decode(raw, "/synthetic")
    assert digest(raw) != digest(encode(wanted))


@pytest.mark.parametrize("value", [b"1e999", b"-1e999", b"NaN", b"Infinity"])
def test_g21_even_ignored_admission_metadata_is_finite_raw_json(subject, tmp_path, value):
    directories, _, _, expected = preview_graph(tmp_path)
    path = directories["admission"] / "admission.json"
    raw = path.read_bytes().rstrip(); raw = raw[:-1] + b',"ignored":' + value + b'}\n'; path.write_bytes(raw)
    context = get(directories["admission"], "admission-context.json"); context["admission_sha256"] = digest(raw)
    put(directories["admission"], "admission-context.json", context)
    result = subject.reconcile_artifacts(directories["admission"].parent, plan=PLAN, expected=expected)
    assert result["status"] != "passed" and result["observed_ids"] == []
    assert next(owner for owner in result["owners"] if owner["job_id"] == "admission")["status"] != "passed"


def install_read_observer(monkeypatch, target, *, oversized=False, changing=False, interrupt=False):
    """Model descriptor acquisition separately from consuming target bytes."""
    real_open, real_io_open, real_os_open, real_read = builtins.open, io.open, os.open, os.read
    real_stat, real_lstat, real_fstat, real_close = os.stat, os.lstat, os.fstat, os.close
    target_info = real_stat(target); fds, observed, consumption = set(), [], []
    def is_target(value):
        if isinstance(value, int):
            try: return value in fds or real_fstat(value).st_ino == target_info.st_ino
            except OSError: return False
        try: return os.fspath(value) == os.fspath(target)
        except TypeError: return False
    class Metadata:
        def __init__(self, info, ordinal): self.info, self.ordinal = info, ordinal
        def __getattr__(self, key):
            if key == "st_size" and oversized: return 33554433
            if key == "st_ino" and changing and self.ordinal > 1: return self.info.st_ino + 1
            return getattr(self.info, key)
    def metadata(info, value):
        if not is_target(value): return info
        observed.append("metadata")
        return Metadata(info, len(observed))
    def stat_call(value, *args, **kwargs): return metadata(real_stat(value, *args, **kwargs), value)
    def lstat_call(value, *args, **kwargs): return metadata(real_lstat(value, *args, **kwargs), value)
    def fstat_call(fd): return metadata(real_fstat(fd), fd)
    def consume(size):
        consumption.append(size)
        if interrupt: raise KeyboardInterrupt()
        assert isinstance(size, int) and 0 < size <= 33554432, "unbounded proof read"
        assert not oversized, "oversized metadata must reject before reading, not before opening"
    class File:
        def __init__(self, stream): self.stream = stream
        def __enter__(self): return self
        def __exit__(self, *args):
            fd = self.stream.fileno()
            try: return self.stream.__exit__(*args)
            finally: fds.discard(fd)
        def close(self):
            fd = self.stream.fileno()
            try: return self.stream.close()
            finally: fds.discard(fd)
        def __getattr__(self, key): return getattr(self.stream, key)
        def read(self, size=-1): consume(size); return self.stream.read(size)
        def readinto(self, buffer): consume(len(buffer)); return self.stream.readinto(buffer)
        def readline(self, size=-1): consume(size); return self.stream.readline(size)
    def wrapping(original):
        def open_call(value, *args, **kwargs):
            stream = original(value, *args, **kwargs)
            if is_target(value): fds.add(stream.fileno()); return File(stream)
            return stream
        return open_call
    def os_open(value, *args, **kwargs):
        fd = real_os_open(value, *args, **kwargs)
        if is_target(value): fds.add(fd)
        return fd
    def os_read(fd, size):
        if is_target(fd): consume(size)
        return real_read(fd, size)
    def os_close(fd):
        try: return real_close(fd)
        finally: fds.discard(fd)
    monkeypatch.setattr(builtins, "open", wrapping(real_open)); monkeypatch.setattr(io, "open", wrapping(real_io_open))
    monkeypatch.setattr(os, "open", os_open); monkeypatch.setattr(os, "read", os_read); monkeypatch.setattr(os, "close", os_close)
    monkeypatch.setattr(os, "stat", stat_call); monkeypatch.setattr(os, "lstat", lstat_call); monkeypatch.setattr(os, "fstat", fstat_call)
    return observed, consumption


def test_validator_safe_open_then_fstat_is_allowed_but_oversized_consumption_is_not(validator, tmp_path, monkeypatch):
    root, expected, _ = controls_proof(tmp_path)
    metadata, consumed = install_read_observer(monkeypatch, root / "node/runtime.json", oversized=True)
    result = validator(root, expected=expected)
    assert result["status"] != "passed" and result["errors"]
    assert metadata and consumed == []


def test_validator_inode_change_is_coherent_for_path_and_descriptor_readers(validator, tmp_path, monkeypatch):
    root, expected, _ = controls_proof(tmp_path)
    metadata, _ = install_read_observer(monkeypatch, root / "node/runtime.json", changing=True)
    result = validator(root, expected=expected)
    assert len(metadata) >= 2
    assert result["status"] != "passed" and not any(n in result["observed_ids"] for n in NODE_IDS)


def test_validator_every_target_read_is_positive_and_bounded(validator, tmp_path, monkeypatch):
    root, expected, _ = controls_proof(tmp_path)
    _, consumed = install_read_observer(monkeypatch, root / "node/runtime.json")
    assert_result(validator(root, expected=expected), "passed")
    assert consumed and all(0 < n <= 33554432 for n in consumed)


def test_validator_descriptor_or_stream_interruption_cannot_be_swallowed(validator, tmp_path, monkeypatch):
    root, expected, _ = controls_proof(tmp_path)
    _, consumed = install_read_observer(monkeypatch, root / "node/runtime.json", interrupt=True)
    with pytest.raises(KeyboardInterrupt): validator(root, expected=expected)
    assert consumed


def source_strings(tree):
    return [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)]


def workflow_blocks(source):
    """Closed, indentation-based source contract; unsupported YAML forms reject."""
    import re
    assert "\t" not in source and "\r" not in source
    lines = source.splitlines()
    assert lines.count("jobs:") == 1
    index = lines.index("jobs:")
    body = lines[index + 1:]
    # All direct child keys, including hyphens, are enumerated before narrowing.
    job_headers = [line for line in body if re.match(r"^  [^ #].*:", line)]
    assert job_headers == ["  validation_controls:"]
    assert not any(line and not line.startswith(" ") and not line.startswith("#") for line in body)
    step_start = next(i for i, line in enumerate(body) if line == "    steps:")
    header, steps, current = body[:step_start], [], []
    for line in body[step_start + 1:]:
        if re.match(r"^      -\s", line):
            if current: steps.append("\n".join(current))
            current = [line]
        elif line.strip() and not line.lstrip().startswith("#"):
            assert current and (line.startswith("        ") or line.startswith("          ")), "unparsed step or job-level key"
            current.append(line)
        elif current: current.append(line)
    if current: steps.append("\n".join(current))
    assert steps
    return "\n".join(header), steps


def test_source_four_new_paths_do_not_expand_native_selection_or_permissions():
    import re
    source = (ROOT / CONTROL_WORKFLOW).read_text(encoding="utf-8")
    header, steps = workflow_blocks(source)
    assert "timeout-minutes: 45" in header
    assert not any(word in source for word in ("pull_request_target:", "workflow_dispatch:", "schedule:", "permissions: write-all", "contents: write", "actions: write", "id-token: write"))
    assert not re.search(r"\b[A-Za-z][A-Za-z_-]*\s*:\s*write\b", source)
    assert "contents: read" in source and BRANCH in source and "pull_request:" in source
    assert not any(word in header for word in ("services:", "strategy:", "matrix:"))
    assert not any("continue-on-error: true" in step for step in steps)
    assert any("setup-python@" in step and "3.11" in step for step in steps)
    assert any("setup-node@" in step and "20" in step for step in steps)
    assert not any("npm " in step for step in steps)


def test_source_independent_context_admission_and_checkout_precede_install_and_cases():
    _, steps = workflow_blocks((ROOT / CONTROL_WORKFLOW).read_text(encoding="utf-8"))
    install = [i for i, step in enumerate(steps) if "pip install" in step]
    runners = [i for i, step in enumerate(steps) if CONTROL in step and " run " in step]
    assert len(install) == len(runners) == 1
    earlier = "\n".join(steps[:install[0]])
    assert "admit-new-feature-evidence.py" in earlier
    assert "admission-context" in earlier and "context.json" in earlier
    assert "sha256" in earlier and "GITHUB_RUN_ATTEMPT" in earlier and ("GITHUB_SHA" in earlier or "head.sha" in earlier)
    assert ".git" in earlier and "HEAD" in earlier
    assert install[0] < runners[0]
    assert "requirements.txt" in steps[install[0]]
    assert "-I -B" in steps[runners[0]] and "--root" in steps[runners[0]] and "--event" in steps[runners[0]] and "--admission" in steps[runners[0]] and "--output" in steps[runners[0]]
    # Final completed-stage/platform provenance is reviewed externally. A local
    # file or green validator return cannot claim its own future upload completed.
    assert any("upload-artifact@" in step for step in steps[runners[0] + 1:])


def test_source_adapter_owns_raw_validation_and_reuses_only_five_primitives():
    source = (ROOT / CONTROL).read_text(encoding="utf-8"); tree = ast.parse(source)
    functions = {node.name: node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert "validate_controls_evidence" in functions
    seam = functions["validate_controls_evidence"]
    assert [arg.arg for arg in seam.args.args] == ["evidence_dir"]
    assert [arg.arg for arg in seam.args.kwonlyargs] == ["expected"]
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import): imports.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom): imports.append(node.module or "")
    assert not any(name == "music_app" or name.startswith("music_app.") for name in imports)
    allowed = {"run_owned", "process_success", "node_list", "timestamp", "owned_file"}
    strings = source_strings(tree)
    assert all(name in strings or "." + name in source for name in allowed)
    assert not any("." + name + "(" in source for name in ("validate_artifact", "validate_invocation", "reconcile_artifacts", "Capture", "reconcile"))
    assert "pytest_collection_finish" in source and "pytest_runtest_logreport" in source
    assert "pytest_deselected" in source and "pytest_collectreport" in source
    assert "--rootdir" in source and "--noconftest" in source and "--import-mode=importlib" in source
    assert "empty-pytest.ini" in source and "PYTEST_DISABLE_PLUGIN_AUTOLOAD" in source
    assert all(path in source for path in SOURCE_PATHS)
    assert PY_FILE in strings and NODE_FILE in strings
    assert "python_collection" in strings and "node_inventory" in strings


def test_source_node_whole_file_registry_and_literal_binding_are_fixed():
    source = (ROOT / NODE_FILE).read_text(encoding="utf-8")
    assert all(case_id.split("::", 1)[1] in source for case_id in NODE_IDS)
    assert "PREVIEW_TRANSFER_SCRIPT" in source and "--list" in source and "--run" in source
    assert "foobar-preview-transfer-fakes-v1" in source
    assert "65a5239082ab154affd06ec85183a5ecd451d630954e43d8aeb04ca46eebbe90" in source
    assert "fixture_forbidden_effect_attempt_survives_catch" in source
    assert "fixture_unlisted_module_denied" in source and "fixture_host_environment_not_exposed" in source
    # Runtime behavior is the separate complete 58-case owner, not this source check.


@pytest.mark.parametrize("pid,index", list(zip(PROCESS_IDS, range(5))))
def test_validator_exact_owned_runtime_plus_cleanup_ceiling_is_not_overrejected(validator, tmp_path, pid, index):
    root, expected, _ = controls_proof(tmp_path)
    delta = RUNTIMES[index] + 60 - 1
    for i in range(index, 5):
        name = "processes/" + PROCESS_IDS[i] + ".json"
        record = get(root, name)
        if i != index: record["started_at"] = (datetime.fromisoformat(record["started_at"]) + timedelta(seconds=delta)).isoformat()
        record["finished_at"] = (datetime.fromisoformat(record["finished_at"]) + timedelta(seconds=delta)).isoformat()
        put(root, name, record)
    seal(root)
    assert_result(validator(root, expected=expected), "passed")


@pytest.mark.parametrize("mutation", ["missing_key", "extra_key", "missing_source", "extra_source", "bool_attempt", "unknown_phase", "later_after_failure"])
def test_validator_closed_expected_identity_and_attempt_prefix(validator, tmp_path, mutation):
    root, expected, _ = controls_proof(tmp_path)
    if mutation == "missing_key": expected.pop("event_sha256")
    elif mutation == "extra_key": expected["self_attested"] = True
    elif mutation == "missing_source": expected["source_hashes"].pop(SOURCE_PATHS[-1])
    elif mutation == "extra_source": expected["source_hashes"]["unreviewed.py"] = "f" * 64
    elif mutation == "bool_attempt": expected["run_attempt"] = True
    elif mutation == "unknown_phase": mutate_json(root, "receipt.json", lambda p: p["attempted_process_ids"].append("retry"))
    else: mutate_json(root, "processes/python_collection.json", lambda p: p.update(exit_code=1))
    result = validator(root, expected=expected)
    assert_result(result, "invalid")
    assert not result["observed_ids"]


@pytest.mark.parametrize("missing", ["processes/python_runtime.json", "python/reports.json", "python/junit.xml", "node/list.json", "node/runtime.json", "node/ledgers/001.json"])
def test_validator_attempted_but_missing_proof_is_not_unrun_success(validator, tmp_path, missing):
    root, expected, _ = controls_proof(tmp_path)
    (root / missing).unlink(); seal(root)
    result = validator(root, expected=expected)
    assert_result(result, "incomplete", code="missing")


def test_validator_complete_node_harness_and_assertion_failure_mix_uses_exit_two_precedence(validator, tmp_path):
    root, expected, ids = controls_proof(tmp_path)
    mutate_json(root, "processes/node_runtime.json", lambda p: p.update(exit_code=2))
    def change(p):
        p["events"][1].update(status="failed", error_code="assertion")
        p["events"][3].update(status="error", error_code="harness")
    mutate_json(root, "node/runtime.json", change)
    result = validator(root, expected=expected)
    assert_result(result, "invalid", code="node_event", phase="node_runtime")
    assert result["observed_ids"] == ids
    assert [(node["status"], node["cause"]) for node in result["nodes"][2:5]] == [
        ("failed", "assertion_failed"), ("unknown", "harness_error"), ("unknown", "invocation_nonzero_exit")]


@pytest.mark.parametrize("phase,count", [("python_collection", 2), ("node_inventory", 4)])
def test_validator_nonpassing_inventory_never_claims_runtime_case_failure(validator, tmp_path, phase, count):
    root, expected, ids = controls_proof(tmp_path); cut_prefix(root, count)
    mutate_json(root, "processes/" + phase + ".json", lambda p: p.update(exit_code=1))
    if phase == "python_collection":
        collection = python_capture([]); collection["collection_errors"] = [{"nodeid": PY_FILE, "outcome": "failed", "longrepr": "synthetic collection failure"}]
        put(root, "python/collection.json", collection); seal(root)
    result = validator(root, expected=expected)
    assert_result(result, "failed")
    assert result["phases"][count - 1]["status"] == "failed"
    remaining = result["nodes"] if phase == "python_collection" else result["nodes"][2:]
    assert all(n["status"] == "unrun" and n["cause"] == "predecessor_nonpass" for n in remaining)
    assert result["expected_ids"] == (list(NODE_IDS) if phase == "python_collection" else ids + list(NODE_IDS))


@pytest.mark.parametrize("over", [0, 1])
def test_g08_metadata_exact_two_mebibytes_and_earliest_overflow_guard(subject, tmp_path, monkeypatch, over):
    directories, _, jobs, expected = preview_graph(tmp_path)
    transfer = transfer_fixture(tmp_path, monkeypatch, expected, jobs)
    for name, limit in (("run-attempt.json", 1048576), ("attempt-jobs.json", 1048576 + over)):
        raw = (transfer / name).read_bytes()
        put(transfer, name, raw + b" " * (limit - len(raw)))
    refresh_acquisition(transfer)
    # Two independently <=1 MiB responses cannot exceed 2 MiB together. The
    # over candidate correctly fails the second per-response guard, not an
    # invented independently reachable aggregate-only branch.
    if over:
        with pytest.raises(Exception): subject._c_completed_stages(PLAN, expected, directories)
    else:
        result = subject._c_completed_stages(PLAN, expected, directories)
        assert result["holds"] == [] and len(result["owners"]) == 7


@pytest.mark.parametrize("over", [0, 1])
def test_g13_central_directory_exact_eight_mebibyte_boundary(subject, tmp_path, over):
    # 128 central records with legal comments fill exactly 8 MiB. This tests
    # preflight only, without allocating ZipFile directory objects or outputs.
    total = 8388608 + over
    widths = [total // 128] * 128
    widths[-1] += total - sum(widths)
    central = bytearray()
    for width in widths:
        comment = width - 47
        assert 0 <= comment <= 65535
        central.extend(struct.pack('<4s6H3I5H2I', b'PK\x01\x02', 20, 20, 0, 0, 0, 0, 0, 0, 0, 1, 0, comment, 0, 0, 0, 0))
        central.extend(b'x' + b'\0' * comment)
    raw = bytes(central) + struct.pack('<4s4H2IH', b'PK\x05\x06', 0, 0, 128, 128, total, 0, 0)
    path = put(tmp_path, "central.zip", raw)
    if over:
        with pytest.raises(Exception): subject._c_zip_preflight(path)
    else: assert subject._c_zip_preflight(path) == (128, 0)


# Additive OUTPUT-relocation contract. All preceding accepted R2 bytes remain.
def relocation_snapshot(directory):
    return {path.relative_to(directory).as_posix(): path.read_bytes()
            for path in sorted(directory.rglob("*")) if path.is_file()}


def relocated_controls_proof(tmp_path):
    producer_parent = tmp_path / "original output \u00e9"
    producer_parent.mkdir()
    producer, expected, ids = controls_proof(producer_parent)
    original = relocation_snapshot(producer)
    local = tmp_path / "downloaded proof \u03b2"
    local.mkdir()
    for relative, raw in original.items():
        put(local, relative, raw)
    # The fictional original checkout was never created. Only proof A exists,
    # and the call guard below makes A unavailable even for metadata lookup.
    assert not Path(expected["root"]).exists()
    assert producer != local and relocation_snapshot(local) == original
    return producer, local, expected, ids, original


def validate_relocated_without_historical_io(validator, local, expected, producer, monkeypatch):
    """Sticky access guard, installed only for the public read-only call.

    Safe local descriptor acquisition/fstat is allowed; consumption must be
    positive and bounded. Metadata on local ancestor directories is allowed to
    establish confinement. Historical identity strings are never I/O targets.
    """
    attempts, reads, descriptors = [], [], {}
    original_open, original_io_open = builtins.open, io.open
    original_os_open, original_os_read, original_os_close = os.open, os.read, os.close
    original_stat, original_lstat, original_fstat, original_access = os.stat, os.lstat, os.fstat, os.access
    original_scandir, original_listdir, original_readlink = os.scandir, os.listdir, os.readlink
    original_resolve, original_absolute = Path.resolve, Path.absolute
    original_realpath, original_abspath = os.path.realpath, os.path.abspath
    local_name = os.fspath(local)
    ancestor_names = {os.fspath(path) for path in local.parents}
    forbidden = [os.fspath(producer), expected["root"], expected["git_executable"],
                 expected["python_executable"], expected["node_executable"]]

    def denied(operation):
        attempts.append(operation)
        raise AssertionError("forbidden proof effect: " + operation)

    def checked_path(value, operation, *, metadata=False, dir_fd=None):
        if isinstance(value, int):
            if value not in descriptors:
                return denied(operation + ":unknown-descriptor")
            name = descriptors[value]
        else:
            try:
                name = os.fsdecode(os.fspath(value))
            except (TypeError, UnicodeError):
                return denied(operation + ":malformed-path")
            if "\0" in name:
                return denied(operation + ":nul-path")
            if not os.path.isabs(name) and dir_fd is not None:
                if dir_fd not in descriptors:
                    return denied(operation + ":unknown-directory-descriptor")
                name = os.path.join(descriptors[dir_fd], name)
            # This lexical guard is not producer OUTPUT normalization. It only
            # classifies a requested filesystem operation before forwarding it.
            name = original_abspath(name)
        if any(name == path or name.startswith(path + os.sep) for path in forbidden):
            return denied(operation + ":producer-identity")
        within = name == local_name or name.startswith(local_name + os.sep)
        if not within and not (metadata and name in ancestor_names):
            return denied(operation + ":outside-local-proof")
        return name

    def consume(fd, size, operation):
        name = checked_path(fd, operation)
        if type(size) is not int or not 0 < size <= 33554432:
            return denied(operation + ":unbounded-read")
        reads.append((name, size))

    class GuardedFile:
        def __init__(self, stream, name):
            self.stream, self.fd = stream, stream.fileno()
            descriptors[self.fd] = name
        def __enter__(self):
            return self
        def __exit__(self, *args):
            try:
                return self.stream.__exit__(*args)
            finally:
                descriptors.pop(self.fd, None)
        def close(self):
            try:
                return self.stream.close()
            finally:
                descriptors.pop(self.fd, None)
        def read(self, size=-1):
            consume(self.fd, size, "file.read")
            return self.stream.read(size)
        def read1(self, size=-1):
            consume(self.fd, size, "file.read1")
            return self.stream.read1(size)
        def readinto(self, buffer):
            consume(self.fd, len(buffer), "file.readinto")
            return self.stream.readinto(buffer)
        def readinto1(self, buffer):
            consume(self.fd, len(buffer), "file.readinto1")
            return self.stream.readinto1(buffer)
        def readline(self, size=-1):
            consume(self.fd, size, "file.readline")
            return self.stream.readline(size)
        def readlines(self, *args):
            return denied("file.readlines:unbounded-read")
        def __iter__(self):
            return denied("file.iteration:unbounded-read")
        def write(self, *args):
            return denied("file.write")
        def writelines(self, *args):
            return denied("file.writelines")
        def truncate(self, *args):
            return denied("file.truncate")
        def __getattr__(self, name):
            if name in ("buffer", "raw", "peek", "readall"):
                return denied("file." + name + ":unobserved-read-route")
            return getattr(self.stream, name)

    def guarded_open(original):
        def opening(value, mode="r", *args, **kwargs):
            name = checked_path(value, "open")
            if not isinstance(mode, str) or any(flag in mode for flag in "wax+"):
                return denied("open:write-mode")
            return GuardedFile(original(value, mode, *args, **kwargs), name)
        return opening

    def os_open(value, flags, *args, **kwargs):
        directory, nofollow = getattr(os, "O_DIRECTORY", 0), getattr(os, "O_NOFOLLOW", 0)
        read_only_directory = bool(directory and nofollow and flags & directory and flags & nofollow
                                   and flags & (os.O_WRONLY | os.O_RDWR) == os.O_RDONLY)
        # Only safe directory acquisition may use the exact ancestor allowance.
        # Historical identity rejection still precedes that allowance, and
        # descriptor consumption/enumeration never receives metadata=True.
        name = checked_path(value, "os.open", metadata=read_only_directory, dir_fd=kwargs.get("dir_fd"))
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            return denied("os.open:write-flags")
        fd = original_os_open(value, flags, *args, **kwargs)
        descriptors[fd] = name
        return fd

    def os_read(fd, size):
        consume(fd, size, "os.read")
        return original_os_read(fd, size)

    def os_close(fd):
        checked_path(fd, "os.close", metadata=True)
        try:
            return original_os_close(fd)
        finally:
            descriptors.pop(fd, None)

    def metadata_call(original, operation):
        def call(value, *args, **kwargs):
            checked_path(value, operation, metadata=True, dir_fd=kwargs.get("dir_fd"))
            return original(value, *args, **kwargs)
        return call

    def directory_call(original, operation):
        def call(value=".", *args, **kwargs):
            checked_path(value, operation)
            return original(value, *args, **kwargs)
        return call

    def resolve(path, *args, **kwargs):
        checked_path(path, "Path.resolve", metadata=True)
        return original_resolve(path, *args, **kwargs)

    def absolute(path):
        checked_path(path, "Path.absolute", metadata=True)
        return original_absolute(path)

    def realpath(path, *args, **kwargs):
        checked_path(path, "realpath", metadata=True)
        return original_realpath(path, *args, **kwargs)

    def write_effect(operation):
        def call(*args, **kwargs):
            return denied(operation)
        return call

    # Restore patches before assertions/snapshots so test bookkeeping does not
    # share the subject's narrow access window. A caught sentinel remains sticky.
    with monkeypatch.context() as guard:
        guard.setattr(builtins, "open", guarded_open(original_open))
        guard.setattr(io, "open", guarded_open(original_io_open))
        guard.setattr(os, "open", os_open); guard.setattr(os, "read", os_read); guard.setattr(os, "close", os_close)
        guard.setattr(os, "stat", metadata_call(original_stat, "stat"))
        guard.setattr(os, "lstat", metadata_call(original_lstat, "lstat"))
        guard.setattr(os, "fstat", metadata_call(original_fstat, "fstat"))
        guard.setattr(os, "access", metadata_call(original_access, "access"))
        guard.setattr(os, "scandir", directory_call(original_scandir, "scandir"))
        guard.setattr(os, "listdir", directory_call(original_listdir, "listdir"))
        guard.setattr(os, "readlink", metadata_call(original_readlink, "readlink"))
        guard.setattr(Path, "resolve", resolve); guard.setattr(Path, "absolute", absolute)
        guard.setattr(os.path, "realpath", realpath)
        for operation in ("write", "writev", "pwrite", "ftruncate", "truncate", "unlink", "remove",
                          "mkdir", "makedirs", "rmdir", "removedirs", "rename", "replace", "link", "symlink", "chmod", "chown", "utime", "chdir", "fchdir"):
            guard.setattr(os, operation, write_effect("os." + operation), raising=False)
        result = validator(local, expected=expected)
    assert attempts == [], "Caught historical-path/read/write attempts remain a failure: " + repr(attempts)
    assert reads, "A validation verdict requires actual local proof consumption"
    assert all(name == local_name or name.startswith(local_name + os.sep) for name, _ in reads)
    assert all(0 < size <= 33554432 for _, size in reads)
    assert descriptors == {}, "Read-only validation must close its local descriptors"
    return result


def test_output_relocation_preserves_raw_bytes_and_never_accesses_original_paths(validator, tmp_path, monkeypatch):
    producer, local, expected, ids, original = relocated_controls_proof(tmp_path)
    expected_before = copy.deepcopy(expected)
    result = validate_relocated_without_historical_io(validator, local, expected, producer, monkeypatch)
    assert_result(result, "passed")
    assert result["expected_ids"] == ids + list(NODE_IDS) == result["observed_ids"]
    assert all(phase["status"] == "passed" for phase in result["phases"])
    assert expected == expected_before
    assert relocation_snapshot(local) == original == relocation_snapshot(producer)


@pytest.mark.parametrize("changed_process,output", [
    ("python_collection", None), ("python_runtime", None),
    ("node_inventory", None), ("node_runtime", None),
    (None, "relative/output"), (None, "/"),
    (None, "/producer/./output"), (None, "/producer/../output"),
    (None, "//producer/output"), (None, "/producer//output"),
    (None, "/producer/output/"), (None, "/producer\\output"),
    (None, "/producer:output"), (None, "/producer\0output"),
    (None, "/producer/\ud800output"),
])
def test_output_relocation_rejects_contradictory_or_noncanonical_identity_without_io(validator, tmp_path, monkeypatch, changed_process, output):
    producer, local, expected, ids, _ = relocated_controls_proof(tmp_path)
    expected_before = copy.deepcopy(expected)
    changed = [changed_process] if changed_process is not None else list(PROCESS_IDS[1:])
    replacement = str(producer) + "/different" if changed_process is not None else output
    for pid in changed:
        raw = get(local, "processes/" + pid + ".json")
        raw["argv"][6] = replacement + "/context.json" if pid.startswith("python_") else replacement
        put(local, "processes/" + pid + ".json", raw)
    seal(local)
    before = relocation_snapshot(local)
    producer_before = relocation_snapshot(producer)
    result = validate_relocated_without_historical_io(validator, local, expected, producer, monkeypatch)
    assert_result(result, "invalid", code="process")
    affected = ids if changed_process == "python_runtime" else list(NODE_IDS)
    if changed_process in (None, "python_collection"):
        affected = ids + list(NODE_IDS)
    assert not any(case_id in result["observed_ids"] for case_id in affected)
    assert not any(node["status"] == "passed" for node in result["nodes"] if node["case_id"] in affected)
    assert expected == expected_before
    assert relocation_snapshot(local) == before and relocation_snapshot(producer) == producer_before
