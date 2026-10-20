"""Synthetic new-lane admission and evidence contracts; no product imports.

Authored independently from the accepted plan and reviewed public interface.
These cases do not call GitHub, run resource payloads, activate an application,
import repository configuration, create a DB or use private fixtures.
"""
from __future__ import annotations

import copy
import builtins
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlsplit

import pytest


ROOT = Path(__file__).resolve().parents[2]
HEAD = "a" * 40
OTHER_HEAD = "b" * 40
REPO = "idanilovqa/AlbumHaven"
BRANCH = "2026-10-03-album-tops"
STAMP = "2026-10-20T06:00:00Z"
FOUNDATIONS = (
    "JavaScript Tests (Portable)",
    "Component Tests (Pinned Chrome)",
    "JavaScript Tests (Windows Contract)",
    "Python Tests",
)
REQUIRED = ("PR Review Scope", "Review Prerequisites", *FOUNDATIONS)
SAMPLE = "tests/py/test_sample_playlist.py"
SAMPLE_SELECTORS = tuple("""tests/py/sample_playlist_origin_integration_budget_test.py
tests/py/sample_playlist_origin_integration_locking_test.py
tests/py/test_sample_playlist.py
tests/py/test_sample_playlist_native_live.py
tests/py/test_sample_playlist_native_routes.py
tests/py/test_sample_playlist_origin_integrity.py
tests/py/test_sample_playlist_origin_migration.py
tests/py/test_sample_playlist_origin_projections.py
tests/py/test_sample_playlist_origin_routes.py
tests/py/test_sample_playlist_origins_live.py
tests/py/test_sample_playlist_receipt_boundaries.py
tests/py/test_sample_playlist_receipt_concurrency.py
tests/py/test_sample_playlist_receipt_integrity.py
tests/py/test_sample_playlist_receipt_random_scalar_integrity.py
tests/py/test_sample_playlist_receipts_live.py
tests/py/test_sample_playlist_remote_origin.py
tests/py/test_sample_playlist_save.py
tests/py/test_sample_playlist_save_concurrency.py
tests/py/test_sample_playlist_save_migration.py
tests/py/test_sample_playlist_source_extension_live.py
tests/py/test_sample_playlist_source_facts.py
tests/py/test_sample_playlist_sources_live.py
tests/py/test_sample_playlist_top_origins.py""".splitlines())
SAMPLE_FACET_SELECTORS = tuple("""tests/py/test_musicbrainz_artist_evidence.py
tests/py/test_sample_country_acquisition_live.py
tests/py/test_sample_country_concurrency_live.py
tests/py/test_sample_country_digest_vectors.py
tests/py/test_sample_country_disconnect.py
tests/py/test_sample_facet_bounds_live.py
tests/py/test_sample_facet_codec.py
tests/py/test_sample_facet_evaluator.py
tests/py/test_sample_facet_origin_admission_live.py
tests/py/test_sample_facet_projection_live.py
tests/py/test_sample_facet_receipts_live.py
tests/py/test_sample_facet_routes.py""".splitlines())
SAMPLE_COMPLETE_SELECTORS = SAMPLE_SELECTORS + SAMPLE_FACET_SELECTORS
CORE = "tests/py/test_foobar_snapshot_parser.py"
RESOURCE = "tests/py/test_foobar_snapshot_parser_resources.py"
CI_HELPER = ("tests/py/test_new_feature_ci_contract.py", "tests/py/test_new_feature_evidence.py")
RESOURCE_NODES = [
    RESOURCE + "::test_input_at_64_mib_reaches_record_checks_not_input_limit",
    RESOURCE + "::test_input_over_64_mib_rejects_before_utf8_or_hashing",
    RESOURCE + "::test_exact_100000_rows_are_retained_without_deduplication",
    *[RESOURCE + "::test_row_overflow_precedence[" + case + "]" for case in (
        "row-limit", "nul-before-row-limit", "cr-before-row-limit", "record-before-row-limit")],
    RESOURCE + "::test_exact_three_million_total_cells_includes_header",
    *[RESOURCE + "::test_total_cell_overflow_after_width_before_cell_size[" + case + "]" for case in (
        "total-cell-limit", "total-cells-before-cell-size", "width-before-total-cells", "columns-before-width")],
    RESOURCE + "::test_documented_59645_by_42_synthetic_shape_fits",
]


def load_helper(path, identity):
    spec = importlib.util.spec_from_file_location(identity, ROOT / path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[identity] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(identity, None)
    return module


@pytest.fixture(autouse=True)
def forbid_host_effects(monkeypatch):
    """Install before helper import, including any imported stdlib aliases."""
    original_import = builtins.__import__

    def import_only_helpers(name, *args, **kwargs):
        if name.split(".")[0] in {"music_app", "config", "lastfm", "log_history", "psycopg", "psycopg2"}:
            raise AssertionError("Synthetic CI tests must not import product/config/DB: " + name)
        return original_import(name, *args, **kwargs)

    def forbidden(*args, **kwargs):
        raise AssertionError("Synthetic CI tests must not launch, signal or connect to host resources")

    class ForbiddenSocket(socket.socket):
        """Remain a type for safe lazy ssl.SSLSocket class creation."""

        def __new__(cls, *args, **kwargs):
            forbidden(*args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_only_helpers)
    for name in ("Popen", "run", "call", "check_call", "check_output"):
        monkeypatch.setattr(subprocess, name, forbidden)
    for name in ("kill", "killpg", "system"):
        monkeypatch.setattr(os, name, forbidden, raising=False)
    monkeypatch.setattr(os, "getpgid", lambda pid: pid, raising=False)
    monkeypatch.setattr(signal, "SIGKILL", getattr(signal, "SIGKILL", 9), raising=False)
    monkeypatch.setattr(socket, "socket", ForbiddenSocket)
    monkeypatch.setattr(socket, "create_connection", forbidden)


@pytest.fixture
def admission():
    return load_helper("scripts/ci/admit-new-feature-evidence.py", "focused_admission_under_test")


@pytest.fixture
def evidence():
    return load_helper("scripts/ci/new_feature_evidence.py", "focused_evidence_under_test")


def event():
    return {
        "action": "synchronize",
        "number": 23,
        "repository": {"full_name": REPO},
        "pull_request": {
            "number": 23, "state": "open", "draft": True,
            "head": {"sha": HEAD, "ref": BRANCH, "repo": {"full_name": REPO}},
            "labels": [{"name": "ci:full-review"}, {"name": "documentation"}],
        },
    }


def native(run_id=100, run_number=77, attempt=2, **changes):
    result = {
        "id": run_id, "run_number": run_number, "run_attempt": attempt,
        "workflow_id": 7, "path": ".github/workflows/pr-gates.yml", "name": "PR Gates",
        "event": "pull_request", "head_sha": HEAD, "head_branch": BRANCH,
        "status": "completed", "conclusion": "failure",
        "created_at": STAMP, "updated_at": STAMP,
        "pull_requests": [{"number": 23, "head": {"sha": HEAD, "ref": BRANCH}}],
        "repository": {"full_name": REPO}, "head_repository": {"full_name": REPO},
    }
    result.update(changes)
    return result


def job(name, index, **changes):
    result = {
        "id": index, "name": name, "run_id": 100, "run_attempt": 2,
        "head_sha": HEAD, "head_branch": BRANCH, "workflow_name": "PR Gates",
        "status": "completed", "conclusion": "success",
        "started_at": STAMP, "completed_at": STAMP, "steps": [],
    }
    result.update(changes)
    return result


class PublicMetadata:
    """Closed fixture router: any unexpected origin, route or query fails."""

    def __init__(self):
        self.current = copy.deepcopy(event()["pull_request"])
        self.workflow = {"id": 7, "name": "PR Gates", "path": ".github/workflows/pr-gates.yml", "state": "active"}
        self.runs = [native()]
        self.detail = native()
        self.attempt_detail = native()
        self.jobs = [job(name, index + 1) for index, name in enumerate(REQUIRED)]
        self.jobs += [job("Codex PR Review", 20, conclusion="skipped", started_at=None)]
        self.calls = []
        self.overrides = {}
        self.fail_path = None
        self.runs_total = None
        self.jobs_total = None

    def __call__(self, url, *, timeout):
        parts = urlsplit(url)
        assert (parts.scheme, parts.netloc) == ("https", "api.github.com")
        assert not parts.username and not parts.password and not parts.fragment
        assert timeout == 10 or 0 < timeout <= 10
        path = parts.path
        query = parse_qs(parts.query, strict_parsing=True)
        self.calls.append((url, timeout))
        if path == self.fail_path:
            raise OSError("synthetic public API unavailable")
        if (path, parts.query) in self.overrides:
            return copy.deepcopy(self.overrides[(path, parts.query)])
        prefix = "/repos/" + REPO
        if path == prefix + "/pulls/23":
            assert query == {}
            result = self.current
        elif path in (prefix + "/actions/workflows/pr-gates.yml", prefix + "/actions/workflows/7"):
            assert query == {}
            result = self.workflow
        elif path in (prefix + "/actions/workflows/pr-gates.yml/runs", prefix + "/actions/workflows/7/runs"):
            assert query["head_sha"] == [HEAD]
            assert query["branch"] == [BRANCH]
            assert query["event"] == ["pull_request"]
            assert set(query) == {"head_sha", "branch", "event", "per_page", "page"}
            result = self.page(self.runs, query, "workflow_runs", self.runs_total)
        elif path == prefix + "/actions/runs/100":
            assert query == {}
            result = self.detail
        elif path == prefix + "/actions/runs/100/attempts/2":
            assert query == {}
            result = self.attempt_detail
        elif path == prefix + "/actions/runs/100/attempts/2/jobs":
            assert set(query) == {"per_page", "page"}
            result = self.page(self.jobs, query, "jobs", self.jobs_total)
        else:
            raise AssertionError("Unexpected metadata route: " + url)
        return copy.deepcopy(result)

    @staticmethod
    def page(items, query, field, total):
        assert query["per_page"] == ["100"]
        number = int(query["page"][0])
        assert 1 <= number <= 10
        start = (number - 1) * 100
        return {"total_count": len(items) if total is None else total, field: items[start:start + 100]}


def admit(admission, transport=None, *, original=None, attempt=2):
    transport = PublicMetadata() if transport is None else transport
    result = admission.admit(event() if original is None else original,
                             attempt=attempt, get_json=transport, observed_at=STAMP)
    assert result["schema_version"] == 1
    assert result["authority"] == "supplemental-only"
    assert result["observed_at"] == STAMP
    assert result["coverage"] == "unproven"
    assert result["decision"] in {"admit", "hold"}
    return result


def held(result, reason):
    assert result["decision"] == "hold"
    assert reason in result["reason_codes"]


def test_initial_attempt_holds_without_any_metadata_even_when_native_complete(admission):
    transport = PublicMetadata()
    result = admit(admission, transport, attempt=1)
    held(result, "initial-attempt")
    assert transport.calls == []
    assert result["trigger"]["head_sha"] == HEAD
    assert result["trigger"]["draft"] is True
    assert result["native"] is None


@pytest.mark.parametrize("attempt", [0, -1, True, "2", None])
def test_invalid_attempt_is_not_an_explicit_rerun(admission, attempt):
    transport = PublicMetadata()
    held(admit(admission, transport, attempt=attempt), "invalid-input")
    assert transport.calls == []


def test_unchanged_draft_rerun_admits_with_skipped_reviewers_and_failed_baseline(admission):
    transport = PublicMetadata()
    transport.jobs[2]["conclusion"] = "failure"
    result = admit(admission, transport)
    assert result["decision"] == "admit" and result["reason_codes"] == []
    assert result["trigger"]["draft"] is result["current"]["draft"] is True
    assert result["native"]["conclusion"] == "failure"
    assert result["native"]["id"] == 100 and result["native"]["attempt"] == 2
    assert any(item["conclusion"] == "failure" for item in result["native"]["jobs"])
    assert len(result["inspected"]) == len(transport.calls)
    assert all({"url", "fetched_at", "body"} <= set(item) for item in result["inspected"])


@pytest.mark.parametrize("conclusion", ["failure", "timed_out", "cancelled"])
@pytest.mark.parametrize("foundation", FOUNDATIONS)
def test_admitted_terminal_incomplete_foundation_does_not_create_repair_gate(admission, conclusion, foundation):
    transport = PublicMetadata()
    target = next(item for item in transport.jobs if item["name"] == foundation)
    target["conclusion"] = conclusion
    target["steps"] = [{"name": "Set up job", "status": "completed", "conclusion": "failure"}]
    result = admit(admission, transport)
    assert result["decision"] == "admit"
    kept = next(item for item in result["native"]["jobs"] if item["name"] == foundation)
    assert kept["conclusion"] == conclusion and kept["started_at"] == STAMP
    assert result["coverage"] == "unproven"


def test_control_label_order_trim_and_duplicates_are_not_context_changes(admission):
    original = event()
    original["pull_request"]["labels"] = [{"name": value} for value in
                                          [" ci:full-review ", "run_reviews", "run_reviews", "ci:e2e:abc", "ci:e2e-performance:load", "old-note"]]
    transport = PublicMetadata()
    transport.current["labels"] = [{"name": value} for value in
                                    ["new-note", "ci:e2e-performance:load", "ci:e2e:abc", "run_reviews", "ci:full-review"]]
    result = admit(admission, transport, original=original)
    assert result["decision"] == "admit"
    assert result["trigger"]["control_labels"] == result["current"]["control_labels"]
    assert "old-note" in result["trigger"]["all_labels"]
    assert "new-note" in result["current"]["all_labels"]


@pytest.mark.parametrize("control", ["run_reviews", "skip_tests", "ci:full-review", "ci:focused-e2e", "ci:focused-related", "ci:e2e:foo", "ci:e2e-performance:bar"])
def test_every_native_control_change_holds_original_event(admission, control):
    transport = PublicMetadata()
    labels = transport.current["labels"]
    if any(item["name"] == control for item in labels):
        transport.current["labels"] = [item for item in labels if item["name"] != control]
    else:
        labels.append({"name": control})
    held(admit(admission, transport), "context-changed")


def test_historical_skip_reviews_label_does_not_invent_native_policy(admission):
    transport = PublicMetadata()
    transport.current["labels"].append({"name": "skip_reviews"})
    assert admit(admission, transport)["decision"] == "admit"


@pytest.mark.parametrize("change", ["draft", "head", "branch", "repository", "closed", "number"])
def test_current_context_must_match_original_event(admission, change):
    transport = PublicMetadata()
    current = transport.current
    if change == "draft": current["draft"] = False
    elif change == "head": current["head"]["sha"] = OTHER_HEAD
    elif change == "branch": current["head"]["ref"] = "other"
    elif change == "repository": current["head"]["repo"]["full_name"] = "other/AlbumHaven"
    elif change == "closed": current["state"] = "closed"
    else: current["number"] = 24
    held(admit(admission, transport), "context-changed")


@pytest.mark.parametrize("mutation", ["draft", "labels", "head", "repo", "number"])
def test_malformed_event_fails_before_network(admission, mutation):
    original = event()
    pr = original["pull_request"]
    if mutation == "draft": pr["draft"] = "false"
    elif mutation == "labels": pr["labels"] = [{"name": None}]
    elif mutation == "head": pr["head"]["sha"] = "https://untrusted.invalid/steal"
    elif mutation == "repo": pr["head"]["repo"]["full_name"] = "other/AlbumHaven"
    else: pr["number"] = "23/../actions"
    transport = PublicMetadata()
    held(admit(admission, transport, original=original), "invalid-input")
    assert transport.calls == []


@pytest.mark.parametrize("status", ["queued", "in_progress", "waiting", "requested", "pending"])
def test_newer_native_work_blocks_older_convenient_completion(admission, status):
    transport = PublicMetadata()
    transport.runs.append(native(101, 78, status=status, conclusion=None))
    result = admit(admission, transport)
    assert result["decision"] == "hold"
    assert result["reason_codes"]


@pytest.mark.parametrize("owner", ["runs", "detail", "attempt_detail"])
def test_workflow_level_cancellation_is_not_individual_job_cancellation(admission, owner):
    transport = PublicMetadata()
    if owner == "runs": transport.runs[0]["conclusion"] = "cancelled"
    else: getattr(transport, owner)["conclusion"] = "cancelled"
    result = admit(admission, transport)
    assert result["decision"] == "hold"
    assert {"native-cancelled", "metadata-invalid"} & set(result["reason_codes"])


@pytest.mark.parametrize("field,value", [("id", 999), ("workflow_id", 8), ("head_sha", OTHER_HEAD), ("head_branch", "other"), ("event", "push"), ("run_attempt", 3)])
@pytest.mark.parametrize("owner", ["detail", "attempt_detail"])
def test_run_and_attempt_identity_disagreement_holds(admission, field, value, owner):
    transport = PublicMetadata()
    getattr(transport, owner)[field] = value
    held(admit(admission, transport), "metadata-invalid")


@pytest.mark.parametrize("mutation", ["duplicate-id", "duplicate-number", "wrong-pr", "no-pr", "wrong-workflow", "attempt-zero", "attempt-bool"])
def test_run_listing_ambiguity_never_falls_back(admission, mutation):
    transport = PublicMetadata()
    if mutation == "duplicate-id": transport.runs.append(copy.deepcopy(transport.runs[0]))
    elif mutation == "duplicate-number": transport.runs.append(native(101, 77))
    elif mutation == "wrong-pr": transport.runs[0]["pull_requests"] = [{"number": 24}]
    elif mutation == "no-pr": transport.runs[0]["pull_requests"] = []
    elif mutation == "wrong-workflow": transport.runs[0]["workflow_id"] = 8
    elif mutation == "attempt-zero": transport.runs[0]["run_attempt"] = 0
    else: transport.runs[0]["run_attempt"] = True
    assert admit(admission, transport)["decision"] == "hold"


@pytest.mark.parametrize("name", REQUIRED[:2])
@pytest.mark.parametrize("mutation", ["missing", "duplicate", "failure", "skipped", "active"])
def test_required_native_prerequisite_is_unique_terminal_success(admission, name, mutation):
    transport = PublicMetadata()
    target = next(item for item in transport.jobs if item["name"] == name)
    if mutation == "missing": transport.jobs.remove(target)
    elif mutation == "duplicate": transport.jobs.append(dict(target, id=99))
    elif mutation == "active": target.update(status="in_progress", conclusion=None)
    else: target["conclusion"] = mutation
    assert admit(admission, transport)["decision"] == "hold"


@pytest.mark.parametrize("name", FOUNDATIONS)
@pytest.mark.parametrize("mutation", ["missing", "duplicate", "skipped", "not-started"])
def test_foundation_admission_not_just_terminal_status_is_required(admission, name, mutation):
    transport = PublicMetadata()
    target = next(item for item in transport.jobs if item["name"] == name)
    if mutation == "missing": transport.jobs.remove(target)
    elif mutation == "duplicate": transport.jobs.append(dict(target, id=99))
    elif mutation == "not-started": target["started_at"] = None
    else: target["conclusion"] = "skipped"
    assert admit(admission, transport)["decision"] == "hold"


def test_every_native_job_must_be_terminal_not_only_foundations(admission):
    transport = PublicMetadata()
    transport.jobs.append(job("Feature other (Linux, non-authoritative)", 88,
                              status="in_progress", conclusion=None))
    held(admit(admission, transport), "native-not-ready")


def test_unrelated_matrix_display_names_can_repeat_with_distinct_job_ids(admission):
    transport = PublicMetadata()
    transport.jobs.extend([job("Matrix display", 88), job("Matrix display", 89)])
    assert admit(admission, transport)["decision"] == "admit"


def test_pagination_reads_late_jobs_and_does_not_miss_active_resource_wave(admission):
    transport = PublicMetadata()
    transport.jobs.extend(job("Matrix " + str(index), index) for index in range(1000, 1094))
    transport.jobs[-1].update(status="in_progress", conclusion=None)
    assert len(transport.jobs) == 101
    held(admit(admission, transport), "native-not-ready")
    assert any("page=2" in url for url, _ in transport.calls)


def test_pagination_uses_run_number_not_list_order(admission):
    transport = PublicMetadata()
    old = [native(index + 1000, index + 1) for index in range(76)]
    transport.runs = [*old, native()]
    assert admit(admission, transport)["decision"] == "admit"


@pytest.mark.parametrize("owner", ["runs", "jobs"])
@pytest.mark.parametrize("total", [1001, -1, "7", True, None])
def test_bad_or_overflow_page_counts_hold(admission, owner, total):
    transport = PublicMetadata()
    if total is None:
        setattr(transport, owner + "_total", 102)
    else:
        setattr(transport, owner + "_total", total)
    result = admit(admission, transport)
    assert result["decision"] == "hold"
    assert len(transport.calls) <= 15


@pytest.mark.parametrize("owner", ["runs", "jobs"])
def test_duplicate_ids_across_pages_hold(admission, owner):
    transport = PublicMetadata()
    if owner == "runs":
        transport.runs = [native(index + 1000, index + 1) for index in range(100)]
        transport.runs.append(copy.deepcopy(transport.runs[0]))
    else:
        transport.jobs.extend(job("Matrix " + str(index), index) for index in range(1000, 1093))
        transport.jobs.append(copy.deepcopy(transport.jobs[0]))
    assert len(getattr(transport, owner)) == 101
    assert admit(admission, transport)["decision"] == "hold"


@pytest.mark.parametrize("suffix", ["/pulls/23", "/actions/workflows/pr-gates.yml", "/actions/runs/100", "/actions/runs/100/attempts/2", "/actions/runs/100/attempts/2/jobs"])
def test_api_errors_do_not_poll_retry_or_become_green(admission, suffix):
    transport = PublicMetadata()
    transport.fail_path = "/repos/" + REPO + suffix
    result = admit(admission, transport)
    held(result, "api-error")
    assert sum(urlsplit(url).path == transport.fail_path for url, _ in transport.calls) == 1


def dump(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def phases(nodes):
    return [{"nodeid": node, "when": when, "outcome": "passed", "wasxfail": None}
            for node in nodes for when in ("setup", "call", "teardown")]


def make_evidence(directory, *, lane="sample"):
    directory.mkdir()
    if lane == "sample":
        nodes = [path + "::test_one" for path in SAMPLE_COMPLETE_SELECTORS] + [SAMPLE + "::test_two"]
        selectors = list(SAMPLE_COMPLETE_SELECTORS)
    elif lane == "foobar":
        nodes = [CORE + "::test_core", *RESOURCE_NODES]
        selectors = [CORE, RESOURCE]
    elif lane == "ci-helper":
        selectors = list(CI_HELPER)
        nodes = [CI_HELPER[0] + "::test_guard[success]", CI_HELPER[0] + "::test_guard[failure]",
                 CI_HELPER[1] + "::test_phase[setup]", CI_HELPER[1] + "::test_phase[teardown]"]
    else:
        raise AssertionError("Unknown synthetic evidence lane")
    hashes = {path: "c" * 64 for path in [*selectors, "scripts/ci/new_feature_evidence.py", "scripts/ci/admit-new-feature-evidence.py"]}
    if lane == "foobar": hashes["music_app/services/foobar_snapshot_parser.py"] = "d" * 64
    dump(directory / "admission.json", {
        "schema_version": 1, "decision": "admit", "reason_codes": [], "observed_at": STAMP,
        "authority": "supplemental-only", "coverage": "unproven", "trigger": {
            "repository": REPO, "number": 23, "branch": BRANCH, "head_sha": HEAD,
            "draft": True, "control_labels": ["ci:full-review"], "all_labels": ["ci:full-review"]},
        "current": {"repository": REPO, "number": 23, "branch": BRANCH, "head_sha": HEAD,
                    "draft": True, "control_labels": ["ci:full-review"], "all_labels": ["ci:full-review"]},
        "native": {"id": 100, "run_number": 77, "attempt": 2, "workflow_id": 7,
                   "head_sha": HEAD, "status": "completed", "conclusion": "failure",
                   "jobs": [job(name, index + 1) for index, name in enumerate(REQUIRED)]},
        "inspected": [],
    })
    admission_hash = hashlib.sha256((directory / "admission.json").read_bytes()).hexdigest()
    dump(directory / "admission-context.json", {
        "schema_version": 1, "repository": REPO, "head_sha": HEAD,
        "run_id": 200, "attempt": 2, "admission_sha256": admission_hash,
    })
    dump(directory / "identity.json", {
        "schema_version": 1, "lane": lane, "head_sha": HEAD, "checkout_head": HEAD,
        "run_id": 200, "attempt": 2, "authority": "supplemental-only", "python_version": "3.11.10",
        "selectors": selectors, "file_hashes": hashes,
        "admission_sha256": admission_hash,
    })
    (directory / "collection.log").write_text("synthetic collected nodes\n", encoding="utf-8")
    dump(directory / "collection.json", {"exit_code": 0, "timed_out": False, "cleanup_complete": True,
                                         "writer_errors": [], "nodeids": nodes,
                                         "discovered_nodeids": list(nodes), "deselected_nodeids": [],
                                         "collection_errors": [], "raw_log": "collection.log"})
    groups = [[nodes[0]], *[[node] for node in RESOURCE_NODES]] if lane == "foobar" else [nodes]
    invocations = []
    for index, group in enumerate(groups):
        prefix = "run-" + str(index)
        (directory / (prefix + ".log")).write_text("synthetic complete runtime\n", encoding="utf-8")
        (directory / (prefix + ".xml")).write_text(
            '<testsuites><testsuite tests="' + str(len(group)) + '" errors="0" failures="0" skipped="0">' +
            ''.join('<testcase name="node' + str(i) + '" />' for i in range(len(group))) +
            '</testsuite></testsuites>', encoding="utf-8")
        dump(directory / (prefix + ".json"), {"schema_version": 1, "reports": phases(group)})
        invocations.append({
            "id": prefix, "argv": [sys.executable, "-m", "pytest", *group], "selected_nodeids": group,
            "started_at": "2026-10-20T06:" + f"{index:02}" + ":00Z",
            "finished_at": "2026-10-20T06:" + f"{index:02}" + ":30Z",
            "exit_code": 0, "timed_out": False, "cleanup_complete": True, "writer_errors": [],
            "raw_log": prefix + ".log", "junit_xml": prefix + ".xml", "reports_json": prefix + ".json",
        })
    dump(directory / "invocations.json", invocations)
    return directory


def reconciled(evidence, directory, expected):
    before = (directory / "admission.json").read_bytes() if (directory / "admission.json").exists() else None
    result = evidence.reconcile(directory)
    assert result["schema_version"] == 1 and result["authority"] == "supplemental-only"
    assert result["status"] == expected
    assert bool(result["errors"]) == (expected == "fail")
    if before is not None:
        assert (directory / "admission.json").read_bytes() == before
    return result


@pytest.mark.parametrize("lane", ["sample", "foobar", "ci-helper"])
def test_complete_exact_success_requires_all_phases_and_keeps_native_failure(evidence, tmp_path, lane):
    directory = make_evidence(tmp_path / "evidence", lane=lane)
    result = reconciled(evidence, directory, "pass")
    expected = read(directory / "collection.json")["nodeids"]
    assert result["expected_nodeids"] == expected
    assert sorted(result["observed_nodeids"]) == sorted(expected)
    assert read(directory / "admission.json")["coverage"] == "unproven"
    assert read(directory / "admission.json")["native"]["conclusion"] == "failure"


@pytest.mark.parametrize("change", ["duplicate", "empty", "unselected", "missing-module", "nonzero", "timeout", "cleanup", "writer"])
def test_collection_must_be_exact_complete_and_successful(evidence, tmp_path, change):
    directory = make_evidence(tmp_path / "evidence")
    collection = read(directory / "collection.json")
    if change == "duplicate": collection["nodeids"].append(collection["nodeids"][0])
    elif change == "empty": collection["nodeids"] = []
    elif change == "unselected": collection["nodeids"].append("tests/py/other.py::test_leak")
    elif change == "missing-module":
        identity = read(directory / "identity.json")
        identity["selectors"].append("tests/py/test_second.py")
        identity["file_hashes"]["tests/py/test_second.py"] = "e" * 64
        dump(directory / "identity.json", identity)
    elif change == "nonzero": collection["exit_code"] = 5
    elif change == "timeout": collection["timed_out"] = True
    elif change == "cleanup": collection["cleanup_complete"] = False
    else: collection["writer_errors"] = ["cannot flush"]
    dump(directory / "collection.json", collection)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("phase", ["setup", "call", "teardown"])
@pytest.mark.parametrize("change", ["missing", "duplicate", "failed", "skipped", "xfail", "xpass"])
def test_each_node_needs_exactly_one_successful_nonxfail_report_per_phase(evidence, tmp_path, phase, change):
    directory = make_evidence(tmp_path / "evidence")
    reports = read(directory / "run-0.json")
    target = next(item for item in reports["reports"] if item["when"] == phase)
    if change == "missing": reports["reports"].remove(target)
    elif change == "duplicate": reports["reports"].append(copy.deepcopy(target))
    elif change in {"failed", "skipped"}: target["outcome"] = change
    else:
        target["wasxfail"] = "known failure"
        target["outcome"] = "skipped" if change == "xfail" else "passed"
    dump(directory / "run-0.json", reports)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("change", ["missing-node", "extra-node", "renamed-parameter", "duplicate-invocation", "duplicate-selected", "empty-invocations"])
def test_collection_runtime_multisets_must_match_without_first_success_masking(evidence, tmp_path, change):
    directory = make_evidence(tmp_path / "evidence")
    reports = read(directory / "run-0.json")
    invocations = read(directory / "invocations.json")
    if change == "missing-node": reports["reports"] = reports["reports"][:3]
    elif change == "extra-node": reports["reports"].extend(phases([SAMPLE + "::test_other"]))
    elif change == "renamed-parameter": reports["reports"][0]["nodeid"] += "[different]"
    elif change == "duplicate-invocation": invocations.append(copy.deepcopy(invocations[0]))
    elif change == "duplicate-selected": invocations[0]["selected_nodeids"].append(invocations[0]["selected_nodeids"][0])
    else: invocations = []
    dump(directory / "run-0.json", reports)
    dump(directory / "invocations.json", invocations)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("field,value", [("exit_code", 1), ("exit_code", 5), ("exit_code", -15), ("timed_out", True), ("cleanup_complete", False), ("writer_errors", ["flush failed"])])
def test_successful_reports_cannot_mask_failed_or_interrupted_process(evidence, tmp_path, field, value):
    directory = make_evidence(tmp_path / "evidence")
    invocations = read(directory / "invocations.json")
    invocations[0][field] = value
    dump(directory / "invocations.json", invocations)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("filename", ["identity.json", "admission.json", "admission-context.json", "collection.json", "invocations.json", "collection.log", "run-0.log", "run-0.xml", "run-0.json"])
def test_every_required_artifact_must_exist(evidence, tmp_path, filename):
    directory = make_evidence(tmp_path / "evidence")
    (directory / filename).unlink()
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("filename", ["identity.json", "admission.json", "admission-context.json", "collection.json", "invocations.json", "run-0.json", "run-0.xml"])
def test_corrupt_artifacts_fail_closed(evidence, tmp_path, filename):
    directory = make_evidence(tmp_path / "evidence")
    (directory / filename).write_text("not valid JSON or XML", encoding="utf-8")
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("xml", [
    '<testsuites><testsuite tests="2" failures="1"><testcase /></testsuite></testsuites>',
    '<testsuites><testsuite tests="2"><testcase><failure /></testcase></testsuite></testsuites>',
    '<testsuites><testsuite tests="2"><testcase><error /></testcase></testsuite></testsuites>',
    '<testsuites><testsuite tests="2"><testcase><skipped /></testcase></testsuite></testsuites>',
    '<testsuites><testsuite tests="0" /></testsuites>',
])
def test_junit_is_required_corroboration_not_silently_ignored(evidence, tmp_path, xml):
    directory = make_evidence(tmp_path / "evidence")
    (directory / "run-0.xml").write_text(xml, encoding="utf-8")
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("field,value", [("head_sha", OTHER_HEAD), ("checkout_head", OTHER_HEAD), ("run_id", 0), ("attempt", True), ("authority", "full-verification")])
def test_identity_must_be_complete_and_bound_to_admission(evidence, tmp_path, field, value):
    directory = make_evidence(tmp_path / "evidence")
    identity = read(directory / "identity.json")
    identity[field] = value
    dump(directory / "identity.json", identity)
    reconciled(evidence, directory, "fail")


def test_admission_hold_cannot_be_green_even_with_perfect_test_evidence(evidence, tmp_path):
    directory = make_evidence(tmp_path / "evidence")
    data = read(directory / "admission.json")
    data.update(decision="hold", reason_codes=["context-changed"])
    dump(directory / "admission.json", data)
    identity = read(directory / "identity.json")
    identity["admission_sha256"] = hashlib.sha256((directory / "admission.json").read_bytes()).hexdigest()
    dump(directory / "identity.json", identity)
    context = read(directory / "admission-context.json")
    context["admission_sha256"] = identity["admission_sha256"]
    dump(directory / "admission-context.json", context)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("path", ["../outside.xml", "/tmp/unowned-evidence.xml"])
def test_artifact_paths_cannot_escape_owned_evidence_directory(evidence, tmp_path, path):
    directory = make_evidence(tmp_path / "evidence")
    invocations = read(directory / "invocations.json")
    invocations[0]["junit_xml"] = path
    dump(directory / "invocations.json", invocations)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("change", ["missing", "duplicate", "overlap", "grouped", "reordered", "foreign"])
def test_all_thirteen_resource_nodes_are_individual_exact_sequential_invocations(evidence, tmp_path, change):
    directory = make_evidence(tmp_path / "evidence", lane="foobar")
    invocations = read(directory / "invocations.json")
    assert len(RESOURCE_NODES) == 13 and len(invocations) == 14
    if change == "missing": invocations.pop()
    elif change == "duplicate": invocations.append(copy.deepcopy(invocations[-1]))
    elif change == "overlap": invocations[2]["started_at"] = invocations[1]["started_at"]
    elif change == "grouped": invocations[1]["selected_nodeids"].extend(invocations[2]["selected_nodeids"])
    elif change == "reordered": invocations[1], invocations[2] = invocations[2], invocations[1]
    else: invocations[-1]["selected_nodeids"] = ["tests/py/test_other.py::test_other"]
    dump(directory / "invocations.json", invocations)
    reconciled(evidence, directory, "fail")


class FakeChild:
    """Never starts a child; records only lifecycle calls from run_owned."""

    pid = 424242

    def __init__(self, results):
        self.results = list(results)
        self.waits = []
        self.returncode = None

    def wait(self, timeout=None):
        self.waits.append(timeout)
        result = self.results.pop(0)
        if isinstance(result, BaseException):
            raise result
        self.returncode = result
        return result

    def poll(self):
        return self.returncode


def owned(evidence, tmp_path, monkeypatch, results):
    child = FakeChild(results)
    calls = []
    signals = []

    def factory(argv, **kwargs):
        calls.append((argv, kwargs))
        return child

    intercept_signals(evidence, monkeypatch, signals)
    result = evidence.run_owned([sys.executable, "synthetic-only.py"], cwd=tmp_path,
                                env={"PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"},
                                log_path=tmp_path / "child.log", timeout_seconds=300,
                                terminate_grace_seconds=30, popen_factory=factory)
    return result, child, calls, signals


def intercept_signals(evidence, monkeypatch, signals):
    def killpg(pid, sig):
        signals.append((pid, sig))
    monkeypatch.setattr(os, "killpg", killpg, raising=False)
    # An implementation using "from os import killpg" is intercepted too.
    if hasattr(evidence, "killpg"):
        monkeypatch.setattr(evidence, "killpg", killpg)
    monkeypatch.setattr(os, "getpgid", lambda pid: pid, raising=False)
    if hasattr(evidence, "getpgid"):
        monkeypatch.setattr(evidence, "getpgid", lambda pid: pid)


def test_owned_success_uses_new_session_no_shell_and_bounded_wait(evidence, tmp_path, monkeypatch):
    result, child, calls, signals = owned(evidence, tmp_path, monkeypatch, [0])
    assert result["exit_code"] == 0 and result["timed_out"] is False
    assert result["cleanup_complete"] is True and result["writer_errors"] == []
    assert len(calls) == 1 and calls[0][1]["start_new_session"] is True
    assert calls[0][1].get("shell", False) is False
    assert len(child.waits) == 1 and 0 < child.waits[0] <= 300 and signals == []


def test_timeout_then_zero_exit_remains_interrupted(evidence, tmp_path, monkeypatch):
    timeout = subprocess.TimeoutExpired("synthetic-only.py", 300)
    result, child, _, signals = owned(evidence, tmp_path, monkeypatch, [timeout, 0])
    assert result["timed_out"] is True and result["cleanup_complete"] is True
    assert signals == [(child.pid, signal.SIGTERM)]
    assert len(child.waits) == 2
    assert 0 < child.waits[0] <= 300
    assert 0 < child.waits[1] <= 30


def test_timeout_escalates_only_its_owned_group_and_reaps_with_bound(evidence, tmp_path, monkeypatch):
    timeout = subprocess.TimeoutExpired("synthetic-only.py", 300)
    grace = subprocess.TimeoutExpired("synthetic-only.py", 30)
    result, child, _, signals = owned(evidence, tmp_path, monkeypatch, [timeout, grace, -9])
    assert result["timed_out"] is True and result["cleanup_complete"] is True
    assert signals == [(child.pid, signal.SIGTERM), (child.pid, signal.SIGKILL)]
    assert len(child.waits) == 3
    assert 0 < child.waits[0] <= 300
    assert 0 < child.waits[1] <= 30
    assert 0 < child.waits[2] <= 30


def test_unreapable_owned_process_is_unsafe_not_success(evidence, tmp_path, monkeypatch):
    timeout = subprocess.TimeoutExpired("synthetic-only.py", 300)
    result, _, _, _ = owned(evidence, tmp_path, monkeypatch, [timeout, timeout, timeout])
    assert result["timed_out"] is True and result["cleanup_complete"] is False


def test_nonzero_exit_is_preserved_without_assertion_retry(evidence, tmp_path, monkeypatch):
    result, _, calls, _ = owned(evidence, tmp_path, monkeypatch, [1])
    assert result["exit_code"] == 1 and len(calls) == 1


def test_spawn_failure_cannot_create_success(evidence, tmp_path, monkeypatch):
    def factory(*args, **kwargs):
        raise OSError("synthetic spawn failure")
    try:
        result = evidence.run_owned(["synthetic-only"], cwd=tmp_path, env={},
                                    log_path=tmp_path / "child.log", timeout_seconds=300,
                                    popen_factory=factory)
    except OSError:
        return
    assert result["exit_code"] != 0
    assert result["writer_errors"] or result["cleanup_complete"] is False


@pytest.mark.parametrize("interrupt", [KeyboardInterrupt, SystemExit])
def test_caller_cancellation_cleans_owned_child_and_never_returns_success(evidence, tmp_path, monkeypatch, interrupt):
    child = FakeChild([interrupt(), -15])
    signals = []
    intercept_signals(evidence, monkeypatch, signals)
    try:
        result = evidence.run_owned(["synthetic-only"], cwd=tmp_path, env={},
                                    log_path=tmp_path / "child.log", timeout_seconds=300,
                                    popen_factory=lambda *args, **kwargs: child)
    except interrupt:
        result = None
    assert signals == [(child.pid, signal.SIGTERM)]
    assert result is None or result["exit_code"] != 0 or result["timed_out"] is True


@pytest.mark.parametrize("field", ["discovered_nodeids", "deselected_nodeids", "collection_errors"])
def test_collection_must_explicitly_record_discovery_deselection_and_errors(evidence, tmp_path, field):
    directory = make_evidence(tmp_path / "evidence")
    collection = read(directory / "collection.json")
    del collection[field]
    dump(directory / "collection.json", collection)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("change", ["deselected", "hidden-discovered", "collection-error", "duplicate-discovered"])
def test_equal_final_runtime_nodes_cannot_mask_collection_omission(evidence, tmp_path, change):
    directory = make_evidence(tmp_path / "evidence")
    collection = read(directory / "collection.json")
    hidden = SAMPLE + "::test_silently_omitted"
    if change == "deselected":
        collection["discovered_nodeids"].append(hidden)
        collection["deselected_nodeids"].append(hidden)
    elif change == "hidden-discovered": collection["discovered_nodeids"].append(hidden)
    elif change == "collection-error": collection["collection_errors"].append("synthetic collection failure")
    else: collection["discovered_nodeids"].append(collection["discovered_nodeids"][0])
    dump(directory / "collection.json", collection)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("field,value", [
    ("repository", "other/AlbumHaven"), ("head_sha", OTHER_HEAD), ("run_id", 199),
    ("attempt", 1), ("attempt", True), ("admission_sha256", "0" * 64), ("schema_version", 2),
])
def test_cross_runner_admission_sidecar_is_same_repository_head_run_attempt_and_bytes(evidence, tmp_path, field, value):
    directory = make_evidence(tmp_path / "evidence")
    context = read(directory / "admission-context.json")
    context[field] = value
    dump(directory / "admission-context.json", context)
    reconciled(evidence, directory, "fail")


def test_admission_bytes_cannot_change_after_artifact_hashing(evidence, tmp_path):
    directory = make_evidence(tmp_path / "evidence")
    with (directory / "admission.json").open("a", encoding="utf-8") as stream:
        stream.write("\n")
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("change", ["missing-selector-hash", "missing-helper-hash", "invalid-hash", "duplicate-selector"])
def test_evidence_identity_has_complete_frozen_file_inventory(evidence, tmp_path, change):
    directory = make_evidence(tmp_path / "evidence")
    identity = read(directory / "identity.json")
    if change == "missing-selector-hash": del identity["file_hashes"][SAMPLE]
    elif change == "missing-helper-hash": del identity["file_hashes"]["scripts/ci/new_feature_evidence.py"]
    elif change == "invalid-hash": identity["file_hashes"][SAMPLE] = "not-sha256"
    else: identity["selectors"].append(SAMPLE)
    dump(directory / "identity.json", identity)
    reconciled(evidence, directory, "fail")


def test_foobar_must_retain_actual_parser_hash(evidence, tmp_path):
    directory = make_evidence(tmp_path / "evidence", lane="foobar")
    identity = read(directory / "identity.json")
    del identity["file_hashes"]["music_app/services/foobar_snapshot_parser.py"]
    dump(directory / "identity.json", identity)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("failed_index", [0, 1, 7, 13])
@pytest.mark.parametrize("interrupted", [False, True])
def test_complete_later_resource_evidence_is_retained_after_ordinary_failure_or_safely_cleaned_timeout(evidence, tmp_path, failed_index, interrupted):
    directory = make_evidence(tmp_path / "evidence", lane="foobar")
    invocations = read(directory / "invocations.json")
    target = invocations[failed_index]
    target["exit_code"] = 1
    target["timed_out"] = interrupted
    target["cleanup_complete"] = True
    dump(directory / "invocations.json", invocations)
    before = (directory / "invocations.json").read_bytes()
    result = reconciled(evidence, directory, "fail")
    assert len(result["expected_nodeids"]) == 14
    assert (directory / "invocations.json").read_bytes() == before
    assert len(read(directory / "invocations.json")) == 14


def test_stale_success_reconciliation_file_is_not_evidence(evidence, tmp_path):
    directory = make_evidence(tmp_path / "evidence")
    dump(directory / "reconciliation.json", {"status": "pass", "errors": []})
    (directory / "run-0.json").unlink()
    reconciled(evidence, directory, "fail")


def test_synthetic_transport_deadline_stops_without_sleeping_or_polling(admission, monkeypatch):
    expired = [False]
    clock = lambda: 76.0 if expired[0] else 0.0
    monkeypatch.setattr(time, "monotonic", clock)
    monkeypatch.setattr(time, "perf_counter", clock)
    for name in ("monotonic", "perf_counter"):
        if hasattr(admission, name): monkeypatch.setattr(admission, name, clock)
    transport = PublicMetadata()

    def slow_fixture(url, *, timeout):
        result = transport(url, timeout=timeout)
        expired[0] = True
        return result

    result = admit(admission, slow_fixture)
    held(result, "deadline-exceeded")
    assert len(transport.calls) == 1


def test_changed_pagination_count_holds_instead_of_accepting_partial_jobs(admission):
    transport = PublicMetadata()
    transport.jobs.extend(job("Matrix " + str(index), index) for index in range(1000, 1094))

    def changed_count(url, *, timeout):
        result = transport(url, timeout=timeout)
        if urlsplit(url).path.endswith("/jobs") and parse_qs(urlsplit(url).query)["page"] == ["2"]:
            result["total_count"] += 1
        return result

    held(admit(admission, changed_count), "metadata-invalid")


def test_missing_second_page_holds(admission):
    transport = PublicMetadata()
    transport.jobs.extend(job("Matrix " + str(index), index) for index in range(1000, 1094))

    def truncated(url, *, timeout):
        result = transport(url, timeout=timeout)
        if urlsplit(url).path.endswith("/jobs") and parse_qs(urlsplit(url).query)["page"] == ["2"]:
            result["jobs"] = []
        return result

    held(admit(admission, truncated), "metadata-invalid")


def test_log_creation_failure_cannot_start_child_or_return_success(evidence, tmp_path):
    calls = []
    log_directory = tmp_path / "not-a-log"
    log_directory.mkdir()
    try:
        result = evidence.run_owned(["synthetic-only"], cwd=tmp_path, env={},
                                    log_path=log_directory, timeout_seconds=300,
                                    popen_factory=lambda *args, **kwargs: calls.append((args, kwargs)))
    except OSError:
        result = None
    assert calls == []
    assert result is None or result["exit_code"] != 0 or result["writer_errors"]


def test_cleanup_signal_error_cannot_become_success(evidence, tmp_path, monkeypatch):
    child = FakeChild([subprocess.TimeoutExpired("synthetic-only", 300), -15])

    def signal_error(*args):
        raise PermissionError("synthetic signal failure, no host signal sent")

    monkeypatch.setattr(os, "killpg", signal_error, raising=False)
    if hasattr(evidence, "killpg"): monkeypatch.setattr(evidence, "killpg", signal_error)
    try:
        result = evidence.run_owned(["synthetic-only"], cwd=tmp_path, env={},
                                    log_path=tmp_path / "child.log", timeout_seconds=300,
                                    popen_factory=lambda *args, **kwargs: child)
    except (OSError, subprocess.TimeoutExpired):
        result = None
    assert result is None or result["timed_out"] is True


def test_valid_paginated_run_listing_can_find_latest_exact_context_on_last_page(admission):
    transport = PublicMetadata()
    transport.runs = [native(index + 1000, index + 1) for index in range(100)] + [native(run_number=201)]
    transport.detail["run_number"] = transport.attempt_detail["run_number"] = 201
    result = admit(admission, transport)
    assert result["decision"] == "admit" and result["native"]["run_number"] == 201
    assert any(urlsplit(url).path.endswith("/runs") and parse_qs(urlsplit(url).query)["page"] == ["2"]
               for url, _ in transport.calls)


@pytest.mark.parametrize("mutation", ["duplicate-id", "wrong-run", "wrong-attempt", "wrong-head", "missing-status", "unknown-conclusion"])
def test_exact_attempt_jobs_cannot_be_ambiguous_or_reused_from_another_attempt(admission, mutation):
    transport = PublicMetadata()
    target = transport.jobs[2]
    if mutation == "duplicate-id": transport.jobs.append(dict(target, name="Another display"))
    elif mutation == "wrong-run": target["run_id"] = 99
    elif mutation == "wrong-attempt": target["run_attempt"] = 1
    elif mutation == "wrong-head": target["head_sha"] = OTHER_HEAD
    elif mutation == "missing-status": del target["status"]
    else: target["conclusion"] = "mystery"
    assert admit(admission, transport)["decision"] == "hold"


def test_control_labels_are_case_sensitive_not_silently_lowercased(admission):
    transport = PublicMetadata()
    transport.current["labels"].append({"name": "RUN_REVIEWS"})
    result = admit(admission, transport)
    assert result["decision"] == "admit"
    assert "RUN_REVIEWS" in result["current"]["all_labels"]
    assert "RUN_REVIEWS" not in result["current"]["control_labels"]


def test_reports_with_unknown_phase_or_missing_outcome_do_not_count_as_execution(evidence, tmp_path):
    directory = make_evidence(tmp_path / "evidence")
    reports = read(directory / "run-0.json")
    reports["reports"][0] = {"nodeid": reports["reports"][0]["nodeid"], "when": "collect", "wasxfail": None}
    dump(directory / "run-0.json", reports)
    reconciled(evidence, directory, "fail")


def test_symlinked_artifact_cannot_escape_owned_evidence(evidence, tmp_path):
    directory = make_evidence(tmp_path / "evidence")
    outside = tmp_path / "outside.xml"
    outside.write_bytes((directory / "run-0.xml").read_bytes())
    (directory / "run-0.xml").unlink()
    (directory / "run-0.xml").symlink_to(outside)
    reconciled(evidence, directory, "fail")


def test_ci_helper_is_exact_two_full_modules_one_parameter_expanded_invocation(evidence, tmp_path):
    directory = make_evidence(tmp_path / "ci-helper", lane="ci-helper")
    identity = read(directory / "identity.json")
    invocations = read(directory / "invocations.json")
    assert identity["lane"] == "ci-helper" and identity["selectors"] == list(CI_HELPER)
    assert len(invocations) == 1
    assert any("[" in node for node in invocations[0]["selected_nodeids"])
    assert set(identity["file_hashes"]) == {*CI_HELPER, "scripts/ci/admit-new-feature-evidence.py", "scripts/ci/new_feature_evidence.py"}
    result = reconciled(evidence, directory, "pass")
    assert result["expected_nodeids"] == invocations[0]["selected_nodeids"]
    assert sorted(result["observed_nodeids"]) == sorted(invocations[0]["selected_nodeids"])


@pytest.mark.parametrize("mutation", ["missing-module", "reversed", "extra-module", "duplicate-module", "parser-hash", "missing-helper-hash", "missing-test-hash", "invalid-helper-hash", "wrong-lane"])
def test_ci_helper_identity_cannot_expand_or_substitute_the_fixed_scope(evidence, tmp_path, mutation):
    directory = make_evidence(tmp_path / "ci-helper", lane="ci-helper")
    identity = read(directory / "identity.json")
    if mutation == "missing-module": identity["selectors"].pop()
    elif mutation == "reversed": identity["selectors"].reverse()
    elif mutation == "extra-module": identity["selectors"].append(CORE)
    elif mutation == "duplicate-module": identity["selectors"].append(CI_HELPER[0])
    elif mutation == "parser-hash": identity["file_hashes"]["music_app/services/foobar_snapshot_parser.py"] = "d" * 64
    elif mutation == "missing-helper-hash": del identity["file_hashes"]["scripts/ci/admit-new-feature-evidence.py"]
    elif mutation == "missing-test-hash": del identity["file_hashes"][CI_HELPER[1]]
    elif mutation == "invalid-helper-hash": identity["file_hashes"]["scripts/ci/new_feature_evidence.py"] = "invalid"
    else: identity["lane"] = "arbitrary-other-helper"
    dump(directory / "identity.json", identity)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("mutation", ["split-runtime", "subset", "duplicate", "missing-phase", "deselected", "collection-error", "timeout", "unsafe-cleanup", "writer-error"])
def test_ci_helper_cannot_succeed_with_partial_interrupted_or_split_validation(evidence, tmp_path, mutation):
    directory = make_evidence(tmp_path / "ci-helper", lane="ci-helper")
    invocations = read(directory / "invocations.json")
    if mutation == "split-runtime":
        second = copy.deepcopy(invocations[0])
        second["id"] = "second-runtime"
        second["selected_nodeids"] = invocations[0]["selected_nodeids"][2:]
        invocations[0]["selected_nodeids"] = invocations[0]["selected_nodeids"][:2]
        second.update(raw_log="run-1.log", junit_xml="run-1.xml", reports_json="run-1.json")
        dump(directory / "run-0.json", {"schema_version": 1, "reports": phases(invocations[0]["selected_nodeids"])})
        dump(directory / "run-1.json", {"schema_version": 1, "reports": phases(second["selected_nodeids"])})
        (directory / "run-1.log").write_text("synthetic complete second half\n", encoding="utf-8")
        xml = '<testsuites><testsuite tests="2" errors="0" failures="0" skipped="0"><testcase name="one"/><testcase name="two"/></testsuite></testsuites>'
        (directory / "run-0.xml").write_text(xml, encoding="utf-8")
        (directory / "run-1.xml").write_text(xml, encoding="utf-8")
        second.update(started_at="2026-10-20T06:01:00Z", finished_at="2026-10-20T06:01:30Z")
        invocations.append(second)
    elif mutation == "subset": invocations[0]["selected_nodeids"].pop()
    elif mutation == "duplicate": invocations.append(copy.deepcopy(invocations[0]))
    elif mutation == "missing-phase":
        reports = read(directory / "run-0.json")
        reports["reports"].pop()
        dump(directory / "run-0.json", reports)
    elif mutation in {"deselected", "collection-error"}:
        collection = read(directory / "collection.json")
        field = "deselected_nodeids" if mutation == "deselected" else "collection_errors"
        collection[field].append(CI_HELPER[0] + "::test_missing")
        dump(directory / "collection.json", collection)
    elif mutation == "timeout": invocations[0]["timed_out"] = True
    elif mutation == "unsafe-cleanup": invocations[0]["cleanup_complete"] = False
    else: invocations[0]["writer_errors"] = ["synthetic writer failure"]
    dump(directory / "invocations.json", invocations)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("phase", ["setup", "call", "teardown"])
@pytest.mark.parametrize("outcome,wasxfail", [("failed", None), ("skipped", None), ("skipped", "known"), ("passed", "unexpected pass")])
def test_ci_helper_requires_every_parameter_node_and_phase_to_pass(evidence, tmp_path, phase, outcome, wasxfail):
    directory = make_evidence(tmp_path / "ci-helper", lane="ci-helper")
    reports = read(directory / "run-0.json")
    target = next(report for report in reports["reports"] if report["when"] == phase)
    target.update(outcome=outcome, wasxfail=wasxfail)
    dump(directory / "run-0.json", reports)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("field,value", [("head_sha", OTHER_HEAD), ("run_id", 199), ("attempt", 1), ("admission_sha256", "0" * 64)])
def test_ci_helper_must_match_the_same_exact_admission_artifact_identity(evidence, tmp_path, field, value):
    directory = make_evidence(tmp_path / "ci-helper", lane="ci-helper")
    sidecar = read(directory / "admission-context.json")
    sidecar[field] = value
    dump(directory / "admission-context.json", sidecar)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("sample_fails", [False, True])
def test_failed_helper_validation_never_rewrites_earlier_sample_results(evidence, tmp_path, sample_fails):
    sample = make_evidence(tmp_path / "sample", lane="sample")
    helper = make_evidence(tmp_path / "ci-helper", lane="ci-helper")
    if sample_fails:
        invocations = read(sample / "invocations.json")
        invocations[0]["exit_code"] = 1
        dump(sample / "invocations.json", invocations)
    helper_invocations = read(helper / "invocations.json")
    helper_invocations[0]["exit_code"] = 1
    dump(helper / "invocations.json", helper_invocations)
    sample_bytes = {path.name: path.read_bytes() for path in sample.iterdir() if path.is_file()}
    reconciled(evidence, helper, "fail")
    reconciled(evidence, sample, "fail" if sample_fails else "pass")
    assert {path.name: path.read_bytes() for path in sample.iterdir() if path.is_file()} == sample_bytes
    assert not (tmp_path / "foobar").exists()
    # This is only the preserved local Sample result. Final supplemental
    # acceptance remains unvalidated without a matching successful helper lane.


@pytest.mark.parametrize("status", ["queued", "in_progress", "waiting", "requested", "pending"])
def test_any_observed_active_exact_head_native_run_holds_even_with_older_run_number(admission, status):
    transport = PublicMetadata()
    # The newest numbered run is complete, but an older run has been rerun.
    # Its active attempt is already visible in the same exact-head listing.
    transport.runs.append(native(99, 76, attempt=3, status=status, conclusion=None))
    result = admit(admission, transport)
    held(result, "native-not-ready")
    assert any(item["body"].get("workflow_runs") for item in result["inspected"])


def test_metadata_fetched_at_is_actual_per_fetch_time_not_invocation_start(admission, monkeypatch):
    from datetime import datetime as RealDateTime, timedelta, timezone

    transport = PublicMetadata()
    wall = [RealDateTime.fromisoformat(STAMP.replace("Z", "+00:00")) + timedelta(seconds=5)]
    intervals = []

    class FetchClock:
        @classmethod
        def now(cls, tz=None):
            return wall[0] if tz is None else wall[0].astimezone(tz)

    # This is the existing source owner's datetime seam, not a public API.
    monkeypatch.setattr(admission, "datetime", FetchClock)

    def metadata(url, *, timeout):
        started = wall[0]
        body = transport(url, timeout=timeout)
        wall[0] += timedelta(seconds=1)
        intervals.append((url, started, wall[0]))
        return body

    result = admit(admission, metadata)
    assert result["decision"] == "admit"
    assert result["observed_at"] == STAMP
    assert len(result["inspected"]) == len(intervals) > 1
    actual_times = []
    for inspected, (url, start, end) in zip(result["inspected"], intervals):
        assert inspected["url"] == url
        actual = RealDateTime.fromisoformat(inspected["fetched_at"].replace("Z", "+00:00"))
        assert actual.tzinfo is not None and actual.utcoffset() == timedelta(0)
        assert start <= actual.astimezone(timezone.utc) <= end
        actual_times.append(actual)
    assert len(set(actual_times)) > 1


def test_skipped_collector_is_retained_as_nonpassing_collection_evidence(evidence, tmp_path):
    class SkippedCollector:
        nodeid = CI_HELPER[0] + "::SkippedCollector"
        outcome = "skipped"
        failed = False
        skipped = True
        passed = False
        longrepr = "synthetic collector skipped before complete discovery"

    # Exercise the actual existing hook, not an invented replacement recorder.
    capture = evidence.Capture()
    capture.pytest_collectreport(SkippedCollector())
    assert capture.data["collection_errors"], "A skipped collector must not disappear as successful discovery"
    assert any("synthetic collector skipped" in str(item) for item in capture.data["collection_errors"])
    directory = make_evidence(tmp_path / "ci-helper", lane="ci-helper")
    collection = read(directory / "collection.json")
    collection["collection_errors"] = capture.data["collection_errors"]
    dump(directory / "collection.json", collection)
    reconciled(evidence, directory, "fail")


def test_owned_group_term_grace_is_not_restarted_after_direct_child_exits(evidence, tmp_path, monkeypatch):
    clock = [0.0]
    group_alive = [True]
    signals = []
    spawns = []
    event_waits = []

    class ChildWithSurvivingDescendants:
        pid = 424243
        returncode = None

        def __init__(self):
            self.waits = []

        def wait(self, timeout=None):
            assert timeout is not None and timeout > 0
            self.waits.append(timeout)
            if len(self.waits) == 1:
                assert timeout <= 300
                clock[0] += timeout
                raise subprocess.TimeoutExpired("synthetic-group-owner", timeout)
            if len(self.waits) == 2:
                assert 20 <= timeout <= 30
                clock[0] += 20
                self.returncode = -int(signal.SIGTERM)
                return self.returncode
            self.returncode = -int(signal.SIGKILL)
            return self.returncode

        def poll(self):
            return self.returncode

    child = ChildWithSurvivingDescendants()

    def fake_popen(argv, **kwargs):
        spawns.append((argv, kwargs))
        return child

    def fake_killpg(pid, sig):
        assert pid == child.pid, "Only the synthetic owned group may be inspected/signalled"
        if sig == 0:
            if not group_alive[0]:
                raise ProcessLookupError("synthetic group is gone")
            return
        signals.append((sig, clock[0]))
        if sig == signal.SIGKILL:
            group_alive[0] = False

    class FakeEvent:
        def wait(self, timeout=None):
            assert timeout is not None and 0 < timeout <= 30
            event_waits.append(timeout)
            assert len(event_waits) <= 1000, "Synthetic lifecycle must remain bounded"
            clock[0] += timeout
            return False

    # Use the existing non-factory branch because source R2 intentionally skips
    # descendant inspection when popen_factory is supplied. Every host seam is
    # replaced first: no process, signal, event wait or wall-clock delay occurs.
    monkeypatch.setattr(evidence.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(evidence.os, "killpg", fake_killpg, raising=False)
    monkeypatch.setattr(evidence.os, "getpgid", lambda pid: pid, raising=False)
    monkeypatch.setattr(evidence.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(evidence.threading, "Event", FakeEvent)
    result = evidence.run_owned(["synthetic-group-owner"], cwd=tmp_path, env={},
                                log_path=tmp_path / "owned-group.log", timeout_seconds=300,
                                terminate_grace_seconds=30)
    assert len(spawns) == 1
    assert spawns[0][1]["start_new_session"] is True and spawns[0][1].get("shell", False) is False
    assert result["timed_out"] is True and result["cleanup_complete"] is True
    first_term = next(at for sig, at in signals if sig == signal.SIGTERM)
    first_kill = next(at for sig, at in signals if sig == signal.SIGKILL)
    assert first_kill - first_term <= 30 + 1e-6
    assert group_alive[0] is False


def rewrite_sample_recorded_nodes(directory, nodes, *, rewrite_collection=True):
    """Keep synthetic phases/JUnit/argv consistent while varying module scope."""
    if rewrite_collection:
        collection = read(directory / "collection.json")
        collection["nodeids"] = list(nodes)
        collection["discovered_nodeids"] = list(nodes)
        dump(directory / "collection.json", collection)
    invocations = read(directory / "invocations.json")
    assert len(invocations) == 1
    invocations[0]["selected_nodeids"] = list(nodes)
    invocations[0]["argv"] = [sys.executable, "-m", "pytest", *nodes]
    dump(directory / "invocations.json", invocations)
    dump(directory / "run-0.json", {"schema_version": 1, "reports": phases(nodes)})
    (directory / "run-0.xml").write_text(
        '<testsuites><testsuite tests="' + str(len(nodes)) + '" errors="0" failures="0" skipped="0">' +
        ''.join('<testcase name="node' + str(index) + '" />' for index in range(len(nodes))) +
        '</testsuite></testsuites>', encoding="utf-8")


def test_complete_sample_facet_selection_matches_helper_and_reconciles_all_nodes(evidence, tmp_path):
    # selected_for is the existing source owner, not a new public helper API.
    assert tuple(evidence.selected_for("sample")) == SAMPLE_COMPLETE_SELECTORS
    assert SAMPLE_COMPLETE_SELECTORS[:23] == SAMPLE_SELECTORS
    assert SAMPLE_COMPLETE_SELECTORS[23:] == SAMPLE_FACET_SELECTORS
    assert len(SAMPLE_COMPLETE_SELECTORS) == len(set(SAMPLE_COMPLETE_SELECTORS)) == 35
    directory = make_evidence(tmp_path / "sample", lane="sample")
    identity = read(directory / "identity.json")
    collection = read(directory / "collection.json")
    assert identity["selectors"] == list(SAMPLE_COMPLETE_SELECTORS)
    assert set(SAMPLE_COMPLETE_SELECTORS) <= set(identity["file_hashes"])
    assert {node.split("::", 1)[0] for node in collection["nodeids"]} == set(SAMPLE_COMPLETE_SELECTORS)
    invocations = read(directory / "invocations.json")
    assert len(invocations) == 1 and invocations[0]["selected_nodeids"] == collection["nodeids"]
    result = reconciled(evidence, directory, "pass")
    assert result["expected_nodeids"] == collection["nodeids"]
    assert sorted(result["observed_nodeids"]) == sorted(collection["nodeids"])


@pytest.mark.parametrize("module", SAMPLE_FACET_SELECTORS)
@pytest.mark.parametrize("omission", ["selector", "source-hash", "collected-module"])
def test_each_new_sample_facet_module_selector_hash_and_collection_are_required(evidence, tmp_path, module, omission):
    directory = make_evidence(tmp_path / "sample", lane="sample")
    identity = read(directory / "identity.json")
    if omission == "source-hash":
        del identity["file_hashes"][module]
    else:
        nodes = [node for node in read(directory / "collection.json")["nodeids"]
                 if node.split("::", 1)[0] != module]
        rewrite_sample_recorded_nodes(directory, nodes)
        if omission == "selector":
            identity["selectors"].remove(module)
            del identity["file_hashes"][module]
    dump(directory / "identity.json", identity)
    # Every surviving process, phase, log and XML is complete and passing.
    # The omitted selector/hash/selected module itself must prevent success.
    reconciled(evidence, directory, "fail")


def test_original_twenty_three_module_only_sample_evidence_is_no_longer_complete(evidence, tmp_path):
    directory = make_evidence(tmp_path / "sample", lane="sample")
    identity = read(directory / "identity.json")
    identity["selectors"] = list(SAMPLE_SELECTORS)
    for module in SAMPLE_FACET_SELECTORS:
        del identity["file_hashes"][module]
    dump(directory / "identity.json", identity)
    nodes = [node for node in read(directory / "collection.json")["nodeids"]
             if node.split("::", 1)[0] in SAMPLE_SELECTORS]
    rewrite_sample_recorded_nodes(directory, nodes)
    assert {node.split("::", 1)[0] for node in nodes} == set(SAMPLE_SELECTORS)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("mutation", ["reordered", "duplicate", "partial", "extra"])
def test_refreshed_sample_tuple_rejects_reordering_duplicates_partial_or_extra_scope(evidence, tmp_path, mutation):
    directory = make_evidence(tmp_path / "sample", lane="sample")
    identity = read(directory / "identity.json")
    nodes = read(directory / "collection.json")["nodeids"]
    if mutation == "reordered":
        identity["selectors"][23], identity["selectors"][24] = identity["selectors"][24], identity["selectors"][23]
    elif mutation == "duplicate":
        identity["selectors"].append(SAMPLE_FACET_SELECTORS[-1])
    elif mutation == "partial":
        removed = identity["selectors"].pop()
        del identity["file_hashes"][removed]
        nodes = [node for node in nodes if node.split("::", 1)[0] != removed]
        rewrite_sample_recorded_nodes(directory, nodes)
    else:
        extra = "tests/py/test_sample_unapproved_extra.py"
        identity["selectors"].append(extra)
        identity["file_hashes"][extra] = "e" * 64
        rewrite_sample_recorded_nodes(directory, [*nodes, extra + "::test_extra"])
    dump(directory / "identity.json", identity)
    reconciled(evidence, directory, "fail")


@pytest.mark.parametrize("module", SAMPLE_FACET_SELECTORS)
@pytest.mark.parametrize("incomplete", ["missing-node", "missing-teardown"])
def test_every_sample_facet_module_needs_complete_runtime_node_and_phase_evidence(evidence, tmp_path, module, incomplete):
    directory = make_evidence(tmp_path / "sample", lane="sample")
    nodes = read(directory / "collection.json")["nodeids"]
    target = next(node for node in nodes if node.split("::", 1)[0] == module)
    if incomplete == "missing-node":
        rewrite_sample_recorded_nodes(directory, [node for node in nodes if node != target], rewrite_collection=False)
    else:
        reports = read(directory / "run-0.json")
        reports["reports"] = [report for report in reports["reports"]
                              if not (report["nodeid"] == target and report["when"] == "teardown")]
        dump(directory / "run-0.json", reports)
    reconciled(evidence, directory, "fail")
