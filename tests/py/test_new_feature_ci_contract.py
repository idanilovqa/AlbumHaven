"""Additive focused CI source contracts; no workflow or product execution.

The Sample tuple is this packet's baseline, not a permanent completeness claim.
Facet additions require a reviewed successor tuple and contract before publishing.
"""
from __future__ import annotations

import ast
import hashlib
from pathlib import Path, PurePosixPath
import re
import textwrap

import pytest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ".github/workflows/new-feature-backend-evidence.yml"
ADMISSION = "scripts/ci/admit-new-feature-evidence.py"
EVIDENCE = "scripts/ci/new_feature_evidence.py"
SAMPLE = tuple("""tests/py/sample_playlist_origin_integration_budget_test.py
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
SAMPLE_FACETS = tuple("""tests/py/test_musicbrainz_artist_evidence.py
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
SAMPLE_COMPLETE = SAMPLE + SAMPLE_FACETS
FOOBAR = ("tests/py/test_foobar_snapshot_parser.py", "tests/py/test_foobar_snapshot_parser_resources.py")
CI_HELPER = ("tests/py/test_new_feature_ci_contract.py", "tests/py/test_new_feature_evidence.py")
IMMUTABLE_SHA256 = {
    ".github/workflows/pr-gates.yml": "3c52704069bd307bf4c473fe5bdcbfa1c820d30b2d89b39b96f4827d78d7bd45",
    "tests/py/test_artist_backend_ci_selection_contract.py": "5c630313e2155f1f5b7550c1a740ca99aa94b5c13e92179951f6fa27190b1c7a",
    "pytest.ini": "08db7d4f5778db8705816274bbfe179278530470a6bc3eb8d184e18a2cec8c67",
    FOOBAR[0]: "084642e5325e0fe41aedc2de30b786b27617328005615ce6b36815b58c23270a",
    FOOBAR[1]: "354807deafcf45648721578e5855c4bc6e67295ff88e5a785be0faaa2b8af0b6",
}
IMMUTABLE_BLOBS = {
    "tests/py/conftest.py": "b2d6db7bcfe17ea3e50f4a974ad7906c162f4a26",
    "scripts/ci/bootstrap-linux-tops-postgres.py": "ac874a5573dc93584ec220b5dcb51dd004521ff4",
    "tests/py/library_mix_postgres_support.py": "5f099aaaf1ff50a76877a15ef910a9657406041e",
}
ARTIFACT_NAME = "new-feature-admission-${{ github.event.pull_request.head.sha }}-${{ github.run_id }}-${{ github.run_attempt }}"


def source(path):
    return (ROOT / path).read_text(encoding="utf-8")


def jobs(text):
    body = text.split("\njobs:\n", 1)[1]
    matches = list(re.finditer(r"(?m)^  ([a-z][a-z0-9_]*):\s*$", body))
    return {match[1]: body[match.start(): matches[index + 1].start() if index + 1 < len(matches) else len(body)]
            for index, match in enumerate(matches)}


def steps(job):
    matches = list(re.finditer(r"(?m)^      - (?:name|uses|run):", job))
    assert matches, "Jobs must retain inspectable explicit steps"
    return [job[match.start(): matches[index + 1].start() if index + 1 < len(matches) else len(job)]
            for index, match in enumerate(matches)]


def selector_block(text, lane):
    begin, end = "# BEGIN " + lane + " SELECTORS", "# END " + lane + " SELECTORS"
    assert text.count(begin) == text.count(end) == 1
    block = text.split(begin, 1)[1].split(end, 1)[0]
    selectors = tuple(re.findall(r"'([^'\n]+\.py)'", block))
    assert selectors and all(path.startswith("tests/py/") for path in selectors)
    assert not re.search(r"[*?]|\$\(|`", block)
    return selectors


def call_name(node):
    if isinstance(node, ast.Name): return node.id
    if isinstance(node, ast.Attribute): return call_name(node.value) + "." + node.attr
    return ""


def strings(node):
    return {child.value for child in ast.walk(node) if isinstance(child, ast.Constant) and isinstance(child.value, str)}


def inline_python(step):
    match = re.search(r"\bpython(?:3)?[^\n]*<<[-]?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?\s*\n", step)
    assert match, "Pre-install validation must be explicit stdlib Python, not a comment or absent helper API"
    tail = step[match.end():]
    end = re.search(r"(?m)^\s*" + re.escape(match[1]) + r"\s*$", tail)
    assert end
    return ast.parse(textwrap.dedent(tail[:end.start()]))


@pytest.mark.parametrize("path,digest", IMMUTABLE_SHA256.items())
def test_existing_locked_owners_and_complete_foobar_tests_remain_byte_identical(path, digest):
    assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == digest


@pytest.mark.parametrize("path,blob", IMMUTABLE_BLOBS.items())
def test_existing_fixture_bootstrap_owners_remain_exact_git_blobs(path, blob):
    data = (ROOT / path).read_bytes()
    assert hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest() == blob


def test_exact_baseline_selection_not_a_glob_or_permissive_subsequence():
    text = source(WORKFLOW)
    assert selector_block(text, "SAMPLE") == SAMPLE_COMPLETE
    assert selector_block(text, "FOOBAR") == FOOBAR
    assert selector_block(text, "CI_HELPER") == CI_HELPER
    assert len(SAMPLE) == len(set(SAMPLE)) == 23
    assert len(FOOBAR) == len(set(FOOBAR)) == 2
    assert SAMPLE[:2] == ("tests/py/sample_playlist_origin_integration_budget_test.py",
                          "tests/py/sample_playlist_origin_integration_locking_test.py")
    assert len(CI_HELPER) == len(set(CI_HELPER)) == 2
    assert not any("support" in path for path in (*SAMPLE, *FOOBAR, *CI_HELPER))
    for path in (*SAMPLE, *FOOBAR, *CI_HELPER):
        assert (ROOT / path).is_file() and (ROOT / path).stat().st_size > 0


def test_pr_trigger_exact_six_native_events_and_no_privileged_dispatch_route():
    text = source(WORKFLOW)
    top = text.split("\njobs:\n", 1)[0]
    assert re.search(r"(?m)^  pull_request:\s*$", top)
    assert not re.search(r"\b(pull_request_target|workflow_run|workflow_dispatch|repository_dispatch|schedule)\s*:", top)
    match = re.search(r"(?ms)^    types:\s*\n((?:      - [a-z_]+\s*\n)+)", top)
    assert match
    assert re.findall(r"- ([a-z_]+)", match[1]) == [
        "opened", "synchronize", "reopened", "ready_for_review", "labeled", "unlabeled"]
    group = re.search(r"(?m)^  group:\s*(.+)$", top)
    assert group and "pr-gates-" not in group[1]
    assert "github.event.pull_request.number" in group[1]
    assert "cancel-in-progress: true" in top


def test_only_contents_read_permissions_and_no_secret_or_write_fallback():
    text = source(WORKFLOW)
    for match in re.finditer(r"(?m)^( *)permissions:\s*\n((?:\1  [^\n]+\n)+)", text):
        assert re.findall(r"([\w-]+):\s*(\w+)", match[2]) == [("contents", "read")]
    assert re.search(r"(?m)^permissions:\s*\n  contents: read\s*$", text)
    assert not re.search(r"\b(write-all|read-all|actions:\s*read|id-token:|secrets\.|GITHUB_TOKEN|GH_TOKEN)\b", text)
    assert not re.search(r"\b(gh\s+run|curl\s|repository_dispatch|workflow_dispatch)\b", text)


def test_three_job_dependency_and_cancellation_boundary():
    selected = jobs(source(WORKFLOW))
    assert set(selected) == {"admission", "sample", "foobar"}
    for name, timeout in (("admission", 2), ("sample", 45), ("foobar", 90)):
        assert re.search(r"(?m)^    timeout-minutes:\s*" + str(timeout) + r"\s*$", selected[name])
        assert "runs-on: ubuntu-24.04" in selected[name]
    assert re.search(r"(?m)^    needs:.*admission", selected["sample"]) or re.search(r"(?m)^      - admission\s*$", selected["sample"])
    for owner in ("admission", "sample"):
        assert re.search(r"(?m)^    needs:.*\b" + owner + r"\b", selected["foobar"]) or re.search(r"(?m)^      - " + owner + r"\s*$", selected["foobar"])
    for name in ("sample", "foobar"):
        guard = re.search(r"(?m)^    if:\s*(.+)$", selected[name])
        assert guard
        assert "!cancelled()" in guard[1]
        assert "needs.admission.result == 'success'" in guard[1]
        assert "github.event.pull_request.head.repo.full_name == github.repository" in guard[1]
        assert "github.event.pull_request.head.ref == '2026-10-03-album-tops'" in guard[1]
        assert "draft" not in guard[1]
    foobar_guard = re.search(r"(?m)^    if:\s*(.+)$", selected["foobar"])[1]
    sample_guard = re.sub(r"[\s()]", "", foobar_guard)
    success, failure = "needs.sample.result=='success'", "needs.sample.result=='failure'"
    assert success not in sample_guard or success + "||" + failure in sample_guard or failure + "||" + success in sample_guard
    assert "needs.sample.result != 'cancelled'" in foobar_guard


def test_initial_admission_job_cannot_install_provision_or_launch_feature_tests():
    admission_job = jobs(source(WORKFLOW))["admission"]
    assert ADMISSION in admission_job
    assert "--event" in admission_job and "github.event_path" in admission_job
    assert "--attempt" in admission_job and "github.run_attempt" in admission_job
    assert "--output" in admission_job and "admission.json" in admission_job
    assert not re.search(r"\b(pip\s+install|pytest|services:|postgres:|bootstrap-linux|new_feature_evidence\.py\s+run)\b", admission_job)


def test_every_job_checks_out_exact_head_without_persisted_credentials():
    for name, job in jobs(source(WORKFLOW)).items():
        checkouts = [step for step in steps(job) if "uses: actions/checkout@v5" in step]
        assert len(checkouts) == 1, name
        assert "ref: ${{ github.event.pull_request.head.sha }}" in checkouts[0]
        assert "persist-credentials: false" in checkouts[0]


def test_admission_artifact_named_same_head_run_attempt_and_failure_preserving():
    admission_job = jobs(source(WORKFLOW))["admission"]
    uploads = [step for step in steps(admission_job) if "uses: actions/upload-artifact@v4" in step]
    assert len(uploads) == 1
    upload = uploads[0]
    assert ARTIFACT_NAME in upload
    assert "admission.json" in admission_job and "admission-context.json" in admission_job
    assert "always()" in upload and "if-no-files-found: error" in upload
    assert "retention-days: 14" in upload
    assert "continue-on-error" not in admission_job


@pytest.mark.parametrize("lane", ["sample", "foobar"])
def test_exact_admission_artifact_validation_precedes_dependency_install_and_bootstrap(lane):
    job_steps = steps(jobs(source(WORKFLOW))[lane])
    downloads = [(i, step) for i, step in enumerate(job_steps) if "uses: actions/download-artifact@v4" in step]
    assert len(downloads) == 1
    download_index, download = downloads[0]
    assert ARTIFACT_NAME in download
    for forbidden in ("run-id:", "repository:", "github-token:", "merge-multiple:", "pattern:"):
        assert forbidden not in download
    candidate = [(i, step) for i, step in enumerate(job_steps)
                 if i > download_index and "admission-context.json" in step and "sha256" in step and "run:" in step]
    assert candidate, "A downloaded artifact is not yet validated admission"
    validation_index, validation = candidate[0]
    tree = inline_python(validation)
    called = {call_name(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
    assert called & {"json.load", "json.loads"}
    assert "hashlib.sha256" in called
    comparisons = set().union(*(strings(node) for node in ast.walk(tree) if isinstance(node, ast.Compare)))
    assert {"repository", "head_sha", "run_id", "attempt", "admission_sha256", "decision", "authority"} <= comparisons
    assert {"idanilovqa/AlbumHaven", "admit", "supplemental-only"} <= strings(tree)
    assert any(isinstance(node, (ast.Assert, ast.Raise)) for node in ast.walk(tree))
    assert "github.event.pull_request.head.sha" in validation
    assert "github.run_id" in validation and "github.run_attempt" in validation
    installs = [i for i, step in enumerate(job_steps) if re.search(r"\bpip\s+install\b|bootstrap-linux-tops-postgres\.py", step)]
    assert installs and all(i > validation_index for i in installs)
    runners = [i for i, step in enumerate(job_steps) if EVIDENCE + " run" in step]
    expected_lanes = ("sample",) if lane == "sample" else ("ci-helper", "foobar")
    assert len(runners) == len(expected_lanes)
    for runner_lane in expected_lanes:
        matching = [i for i in runners if "--lane " + runner_lane in job_steps[i]]
        assert len(matching) == 1 and matching[0] > validation_index
    test_commands = [i for i, step in enumerate(job_steps) if "run:" in step and re.search(r"\bpytest\b", step)]
    assert all(i > validation_index for i in test_commands)
    assert "continue-on-error" not in validation and "|| true" not in validation


def test_sample_reuses_postgres_bootstrap_normal_fixtures_and_existing_requirements():
    selected = jobs(source(WORKFLOW))
    sample = selected["sample"]
    assert "image: postgres:17" in sample
    for health in ("pg_isready -U postgres", "--health-interval 5s", "--health-timeout 5s", "--health-retries 12"):
        assert health in sample
    assert "actions/setup-python@v5" in sample and 'python-version: "3.11"' in sample
    assert "cache: pip" in sample and "cache-dependency-path: requirements.txt" in sample
    assert "python -m pip install -r requirements.txt" in sample
    assert 'python scripts/ci/bootstrap-linux-tops-postgres.py --suffix "tops_${{ github.run_id }}_${{ github.run_attempt }}"' in sample
    for forbidden in ("initialize-loved", "initialize-popularity", "--noconftest", "PYTEST_DISABLE_PLUGIN_AUTOLOAD", "--confcutdir", "CREATE DATABASE", "ALTER ROLE"):
        assert forbidden not in sample
    assert "services:" not in selected["admission"] and "services:" not in selected["foobar"]
    assert "postgres" not in selected["foobar"].lower()


@pytest.mark.parametrize("job_lane,lane", [("sample", "sample"), ("foobar", "ci-helper"), ("foobar", "foobar")])
def test_runner_arguments_and_always_upload_identity_are_complete(job_lane, lane):
    job = jobs(source(WORKFLOW))[job_lane]
    runners = [step for step in steps(job) if EVIDENCE + " run" in step and "--lane " + lane in step]
    assert len(runners) == 1
    runner = runners[0]
    for argument in ("--lane " + lane, "--selection", "--evidence-dir", "--admission", "--head", "--run-id", "--attempt"):
        assert argument in runner
    assert "github.event.pull_request.head.sha" in runner
    assert "github.run_id" in runner and "github.run_attempt" in runner
    uploads = [step for step in steps(job) if "uses: actions/upload-artifact@v4" in step]
    assert len(uploads) == 1
    upload = uploads[0]
    assert "always()" in upload and "if-no-files-found: error" in upload and "retention-days: 14" in upload
    assert all(value in upload for value in (job_lane, "github.event.pull_request.head.sha", "github.run_id", "github.run_attempt"))
    assert "continue-on-error" not in job and "|| true" not in job


@pytest.mark.parametrize("path", [ADMISSION, EVIDENCE])
def test_helpers_have_import_safe_guarded_cli_and_no_product_or_config_imports(path):
    tree = ast.parse(source(path))
    assert any(isinstance(node, ast.If) and "__main__" in strings(node.test) for node in tree.body)
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [node.module] if isinstance(node, ast.ImportFrom) else [alias.name for alias in node.names]
            assert not any((name or "").split(".")[0] in {"music_app", "config", "pytest", "lastfm", "log_history", "psycopg", "psycopg2"} for name in names)
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            pytest.fail("Helper performs an unguarded call at import: " + call_name(node.value.func))
    assert "requests" not in {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}


def test_admission_declares_fixed_public_owners_and_bounded_snapshot_only_reads():
    text = source(ADMISSION)
    tree = ast.parse(text)
    values = strings(tree)
    assert "https://api.github.com" in values
    assert "idanilovqa/AlbumHaven" in values and "2026-10-03-album-tops" in values
    assert any("pr-gates.yml" in value for value in values)
    assert "supplemental-only" in values and "unproven" in values
    assert {"initial-attempt", "deadline-exceeded", "metadata-invalid", "context-changed"} <= values
    numbers = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and type(node.value) is int}
    assert {10, 75, 100} <= numbers
    calls = {call_name(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
    assert not any(name.endswith((".sleep", ".Popen", ".system")) for name in calls)
    assert not any(token in text for token in ("Bearer ", "token ", "GITHUB_TOKEN", "GH_TOKEN"))
    assert "Authorization" not in values


def test_foobar_harness_declares_real_module_isolation_without_changing_test_bytes():
    tree = ast.parse(source(EVIDENCE))
    values = strings(tree)
    assert "music_app.services.foobar_snapshot_parser" in values
    assert "music_app" in values and "music_app.services" in values
    assert "PYTEST_DISABLE_PLUGIN_AUTOLOAD" in values
    assert "--noconftest" in values
    assert set(FOOBAR) <= values
    assert any("foobar_snapshot_parser.py" in value for value in values)
    calls = {call_name(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
    assert any(name.endswith("spec_from_file_location") for name in calls)
    assert any(name.endswith("module_from_spec") for name in calls)
    assert any(name.endswith("exec_module") for name in calls)
    assert not any(name.endswith((".set_int_max_str_digits", ".setrecursionlimit")) for name in calls)
    assert not any(name in calls for name in ("socket.socket", "os.system", "subprocess.run", "subprocess.call"))
    # Real parser and test bytes must be hashed, not copied/rewritten by the harness.
    assert any(name.endswith("sha256") for name in calls)
    forbidden_modules = {"config", "lastfm", "log_history", "psycopg", "psycopg2"}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom): assert (node.module or "").split(".")[0] not in forbidden_modules
        elif isinstance(node, ast.Import): assert not any(alias.name.split(".")[0] in forbidden_modules for alias in node.names)


def test_evidence_capture_includes_discovery_deselection_and_each_runtime_phase():
    tree = ast.parse(source(EVIDENCE))
    functions = {node.name for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert {"pytest_deselected", "pytest_runtest_logreport", "pytest_collectreport"} <= functions
    values = strings(tree)
    assert {"discovered_nodeids", "deselected_nodeids", "collection_errors", "wasxfail", "setup", "call", "teardown"} <= values
    assert {"reconciliation.json", "admission-context.json", "admission_sha256"} <= values
    numbers = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and type(node.value) is int}
    assert {30, 300, 600, 1800} <= numbers
    calls = {call_name(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
    assert any(name.endswith("killpg") for name in calls)
    assert not any(name.endswith((".killall", ".pkill", ".sleep")) for name in calls)
    assert not any(value.startswith(("pkill ", "killall ")) for value in values)


def test_foobar_resource_inventory_is_thirteen_fixed_nodes_by_source_arithmetic():
    tree = ast.parse(source(FOOBAR[1]))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name.startswith("test_")]
    assert len(functions) == 7
    counts = []
    for function in functions:
        count = 1
        for decorator in function.decorator_list:
            if isinstance(decorator, ast.Call) and call_name(decorator.func) == "pytest.mark.parametrize":
                ids = next(keyword.value for keyword in decorator.keywords if keyword.arg == "ids")
                assert isinstance(ids, (ast.Tuple, ast.List))
                assert len(ids.elts) == 4
                count *= len(ids.elts)
        counts.append(count)
    assert sorted(counts) == [1, 1, 1, 1, 1, 4, 4]
    assert sum(counts) == 13


def test_ci_helper_is_first_after_dependencies_and_parser_requires_its_success():
    job_steps = steps(jobs(source(WORKFLOW))["foobar"])
    helper_index, helper_step = next((i, step) for i, step in enumerate(job_steps)
                                    if EVIDENCE + " run" in step and "--lane ci-helper" in step)
    parser_index, parser_step = next((i, step) for i, step in enumerate(job_steps)
                                    if EVIDENCE + " run" in step and "--lane foobar" in step)
    installs = [i for i, step in enumerate(job_steps) if re.search(r"\bpip\s+install\b", step)]
    assert installs and all(i < helper_index for i in installs)
    assert helper_index < parser_index
    assert "continue-on-error" not in helper_step and "|| true" not in helper_step
    helper_id = re.search(r"(?m)^        id:\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*$", helper_step)
    assert helper_id, "The truthful phase outcome needs an identifiable helper step"
    parser_guard = re.search(r"(?m)^        if:\s*(.+)$", parser_step)
    if parser_guard:
        # An explicit status expression must not bypass a failed helper step.
        explicit_success = re.search(r"steps\." + re.escape(helper_id[1]) + r"\.(?:outcome|conclusion)\s*==\s*'success'", parser_guard[1])
        implicit_success = re.sub(r"\s", "", parser_guard[1]) in {"${{success()}}", "success()"}
        assert explicit_success or implicit_success
    # An absent step-level if uses Actions' default success() condition.


def test_ci_helper_has_separate_evidence_inside_the_same_failure_preserving_artifact():
    job_steps = steps(jobs(source(WORKFLOW))["foobar"])
    runners = {lane: next(step for step in job_steps if EVIDENCE + " run" in step and "--lane " + lane in step)
               for lane in ("ci-helper", "foobar")}
    directory_args = {}
    for lane, step in runners.items():
        match = re.search(r"--evidence-dir\s+(\"[^\"]+\"|'[^']+'|\S+)", step)
        assert match
        directory_args[lane] = match[1].strip("\"'")
    assert directory_args["ci-helper"] != directory_args["foobar"]
    upload = next(step for step in job_steps if "uses: actions/upload-artifact@v4" in step)
    assert "always()" in upload and "if-no-files-found: error" in upload
    # The archive must select both child directories or their common parent.
    path = re.search(r"(?ms)^          path:\s*(.+?)(?=^          [a-zA-Z][\w-]*:|\Z)", upload)
    assert path
    uploaded = path[1]
    common_parent = str(PurePosixPath(directory_args["ci-helper"]).parent)
    assert all(directory in uploaded for directory in directory_args.values()) or (
        common_parent != "." and common_parent == str(PurePosixPath(directory_args["foobar"]).parent) and common_parent in uploaded)


def test_phase_summary_keeps_unrun_parser_and_sample_diagnostic_status_explicit():
    # No filename or private JSON field names are pinned by this contract.
    job_steps = steps(jobs(source(WORKFLOW))["foobar"])
    candidates = [step for step in job_steps if "run:" in step and "always()" in step
                  and "unrun" in step.lower() and "unproven" in step.lower()]
    assert candidates, "Failed helper validation must leave a truthful retained phase outcome"
    summary = "\n".join(candidates)
    assert "diagnostic" in summary.lower() and "unvalidated" in summary.lower()
    assert "sample" in summary.lower() and "foobar" in summary.lower()
    # Exact head/run/attempt/helper-hash linkage is already required in each
    # lane's identity artifact, not a new private summary schema.
    assert "GITHUB_STEP_SUMMARY" not in summary or re.search(r"\b(open|write_text|write_bytes|tee)\b|>\s*[^$]", summary)


def test_ci_helper_lane_has_fixed_tuple_bounds_and_separate_no_parser_identity():
    tree = ast.parse(source(EVIDENCE))
    values = strings(tree)
    assert "ci-helper" in values and set(CI_HELPER) <= values
    numbers = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and type(node.value) is int}
    assert {60, 180, 30, 300, 600, 1800} <= numbers
    assert "--noconftest" in values and "PYTEST_DISABLE_PLUGIN_AUTOLOAD" in values
    # The source review must trace the ci-helper child without calling the
    # separate Foobar package/parser initializer. No private callable is pinned.
    assert {"file_hashes", "lane", "selectors"} <= values


def test_sample_complete_tuple_is_exact_baseline_plus_all_twelve_facet_modules():
    selected = selector_block(source(WORKFLOW), "SAMPLE")
    assert selected == SAMPLE_COMPLETE
    assert selected[:23] == SAMPLE
    assert selected[23:] == SAMPLE_FACETS
    assert len(SAMPLE) == len(set(SAMPLE)) == 23
    assert len(SAMPLE_FACETS) == len(set(SAMPLE_FACETS)) == 12
    assert len(selected) == len(set(selected)) == 35
    assert "tests/py/test_musicbrainz_artist_evidence.py" in selected
    assert selected.count("tests/py/test_sample_playlist.py") == 1
    assert "tests/py/sample_facet_support.py" not in selected
    assert all(path.startswith("tests/py/") and path.endswith(".py") and "::" not in path for path in selected)
    assert not any(path.endswith((".js", ".mjs", ".cjs", ".ts", ".tsx")) for path in selected)


@pytest.mark.parametrize("path", SAMPLE_FACETS)
def test_every_appended_sample_facet_whole_module_exists_and_is_nonempty(path):
    assert (ROOT / path).is_file()
    assert (ROOT / path).stat().st_size > 0
