"""Exact, failure-preserving evidence for supplemental backend/helper lanes.

Importing this module does not import pytest or any application module. Child
pytest entrypoints are reached only by the explicit hosted runner command.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time
import types
import xml.etree.ElementTree as ET


REPOSITORY = "idanilovqa/AlbumHaven"
BRANCH = "2026-10-03-album-tops"
ADMISSION_HELPER = "scripts/ci/admit-new-feature-evidence.py"
EVIDENCE_HELPER = "scripts/ci/new_feature_evidence.py"
PARSER = "music_app/services/foobar_snapshot_parser.py"
PARSER_MODULE = "music_app.services.foobar_snapshot_parser"
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
tests/py/test_sample_playlist_top_origins.py
tests/py/test_musicbrainz_artist_evidence.py
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
FOOBAR = ("tests/py/test_foobar_snapshot_parser.py",
          "tests/py/test_foobar_snapshot_parser_resources.py")
CI_HELPER = ("tests/py/test_new_feature_ci_contract.py",
             "tests/py/test_new_feature_evidence.py")
RESOURCE_NODES = (
    FOOBAR[1] + "::test_input_at_64_mib_reaches_record_checks_not_input_limit",
    FOOBAR[1] + "::test_input_over_64_mib_rejects_before_utf8_or_hashing",
    FOOBAR[1] + "::test_exact_100000_rows_are_retained_without_deduplication",
    *(FOOBAR[1] + "::test_row_overflow_precedence[" + name + "]" for name in
      ("row-limit", "nul-before-row-limit", "cr-before-row-limit", "record-before-row-limit")),
    FOOBAR[1] + "::test_exact_three_million_total_cells_includes_header",
    *(FOOBAR[1] + "::test_total_cell_overflow_after_width_before_cell_size[" + name + "]"
      for name in ("total-cell-limit", "total-cells-before-cell-size",
                   "width-before-total-cells", "columns-before-width")),
    FOOBAR[1] + "::test_documented_59645_by_42_synthetic_shape_fits",
)
COLLECTION_SECONDS = 300
SAMPLE_SECONDS = 1800
FOOBAR_CORE_SECONDS = 600
RESOURCE_SECONDS = 300
CI_HELPER_COLLECTION_SECONDS = 60
CI_HELPER_SECONDS = 180
GRACE_SECONDS = 30


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def positive(value):
    return type(value) is int and value > 0


def digest(value, length=64):
    return isinstance(value, str) and re.fullmatch("[0-9a-f]{" + str(length) + "}", value) is not None


def write_json(path, value):
    """Atomic replacement is restricted to an invocation-owned output path."""
    path = Path(path)
    temporary = path.with_name(path.name + ".writing-" + str(os.getpid()))
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        # An old successful reconciliation must never survive a failed rewrite.
        if path.name == "reconciliation.json":
            path.unlink(missing_ok=True)
        raise


def owned_file(directory, relative):
    require(isinstance(relative, str) and relative, "Missing artifact path")
    part = Path(relative)
    require(not part.is_absolute() and ".." not in part.parts, "Artifact path escapes evidence")
    root = Path(directory).resolve(strict=True)
    path = root / part
    require(not path.is_symlink(), "Symlinked evidence file is not accepted")
    resolved = path.resolve(strict=True)
    require(resolved.is_relative_to(root) and resolved.is_file(), "Artifact is not an owned file")
    return resolved


def read_json(directory, relative):
    return json.loads(owned_file(directory, relative).read_text(encoding="utf-8"))


def selected_for(lane):
    require(lane in ("sample", "foobar", "ci-helper"), "Unknown evidence lane")
    return {"sample": SAMPLE, "foobar": FOOBAR, "ci-helper": CI_HELPER}[lane]


def admission_chain(directory, head, run_id, attempt):
    require(digest(head, 40) and positive(run_id) and positive(attempt) and attempt > 1,
            "Invalid companion head/run/attempt")
    data = owned_file(directory, "admission.json").read_bytes()
    actual_hash = hashlib.sha256(data).hexdigest()
    record = json.loads(data)
    context = read_json(directory, "admission-context.json")
    require(isinstance(context, dict) and type(context.get("schema_version")) is int
            and context["schema_version"] == 1, "Invalid admission sidecar schema")
    require(context.get("repository") == REPOSITORY and context.get("head_sha") == head,
            "Admission sidecar repository/head mismatch")
    require(type(context.get("run_id")) is int and context["run_id"] == run_id
            and type(context.get("attempt")) is int and context["attempt"] == attempt,
            "Admission sidecar run/attempt mismatch")
    require(context.get("admission_sha256") == actual_hash, "Admission bytes/hash mismatch")
    require(isinstance(record, dict) and type(record.get("schema_version")) is int
            and record["schema_version"] == 1 and record.get("decision") == "admit"
            and record.get("reason_codes") == [] and record.get("authority") == "supplemental-only"
            and record.get("coverage") == "unproven", "Artifact is not admitted supplemental evidence")
    trigger, current, native = (record.get(name) for name in ("trigger", "current", "native"))
    require(isinstance(trigger, dict) and isinstance(current, dict), "Missing admission context")
    keys = ("repository", "number", "branch", "head_sha", "draft", "control_labels")
    require(all(key in trigger and key in current and trigger[key] == current[key] for key in keys),
            "Changed admission context")
    require(trigger["repository"] == REPOSITORY and trigger["branch"] == BRANCH
            and trigger["head_sha"] == head and positive(trigger["number"])
            and type(trigger["draft"]) is bool, "Invalid admitted PR context")
    require(isinstance(trigger["control_labels"], list)
            and all(isinstance(item, str) for item in trigger["control_labels"]),
            "Invalid admitted control labels")
    require(isinstance(native, dict) and native.get("head_sha") == head
            and native.get("status") == "completed"
            and native.get("conclusion") in ("success", "failure")
            and all(positive(native.get(key)) for key in ("id", "run_number", "attempt", "workflow_id")),
            "Invalid admitted native identity")
    return record, context, actual_hash


def validate_identity(directory):
    identity = read_json(directory, "identity.json")
    require(isinstance(identity, dict) and type(identity.get("schema_version")) is int
            and identity["schema_version"] == 1, "Invalid identity schema")
    require(identity.get("authority") == "supplemental-only", "Wrong evidence authority")
    selectors = selected_for(identity.get("lane"))
    require(identity.get("selectors") == list(selectors), "Selection is not the frozen complete tuple")
    head = identity.get("head_sha")
    require(digest(head, 40) and identity.get("checkout_head") == head, "Checkout/head mismatch")
    require(isinstance(identity.get("python_version"), str) and identity["python_version"],
            "Missing Python identity")
    _, _, admission_hash = admission_chain(directory, head, identity.get("run_id"), identity.get("attempt"))
    require(identity.get("admission_sha256") == admission_hash, "Identity/admission hash mismatch")
    hashes = identity.get("file_hashes")
    required = {*selectors, ADMISSION_HELPER, EVIDENCE_HELPER}
    if identity["lane"] == "foobar":
        required.add(PARSER)
    require(isinstance(hashes, dict) and required <= hashes.keys(), "Incomplete source hash inventory")
    if identity["lane"] == "ci-helper":
        require(set(hashes) == required, "CI-helper hash inventory must not include parser/product scope")
    require(all(isinstance(path, str) and not Path(path).is_absolute()
                and ".." not in Path(path).parts and digest(value)
                for path, value in hashes.items()), "Invalid source hash inventory")
    return identity


def node_list(value, *, nonempty=True):
    require(isinstance(value, list) and (value or not nonempty), "Missing node inventory")
    require(all(isinstance(node, str) and "::" in node and "\n" not in node and "\r" not in node
                for node in value), "Malformed node identity")
    require(len(value) == len(set(value)), "Duplicate node identity")
    return value


def process_success(record):
    require(isinstance(record, dict), "Missing process record")
    require(type(record.get("exit_code")) is int and record["exit_code"] == 0,
            "Nonzero or absent process exit")
    require(record.get("timed_out") is False and record.get("cleanup_complete") is True,
            "Interrupted or unsafe process")
    require(record.get("writer_errors") == [] and not record.get("cancelled", False),
            "Output writer failure or caller cancellation")


def validate_collection(directory, identity):
    collection = read_json(directory, "collection.json")
    process_success(collection)
    require(collection.get("deselected_nodeids") == [] and collection.get("collection_errors") == [],
            "Deselected nodes or collection errors")
    nodes = node_list(collection.get("nodeids"))
    discovered = node_list(collection.get("discovered_nodeids"))
    require(nodes == discovered, "Discovery/final collection mismatch")
    selectors = identity["selectors"]
    require({node.split("::", 1)[0] for node in nodes} == set(selectors),
            "Missing selected module or unexpected collected module")
    owned_file(directory, collection.get("raw_log"))
    if identity["lane"] == "foobar":
        resources = [node for node in nodes if node.split("::", 1)[0] == FOOBAR[1]]
        require(resources == list(RESOURCE_NODES), "Resource collection is not the exact frozen thirteen nodes")
    return nodes


def timestamp(value):
    require(isinstance(value, str), "Missing process timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.utcoffset() is not None, "Timestamp has no time zone")
    return parsed


def reconcile(evidence_dir):
    """Read all retained facts afresh; never rewrite an upstream result."""
    result = {"schema_version": 1, "status": "fail", "authority": "supplemental-only",
              "errors": [], "expected_nodeids": [], "observed_nodeids": []}
    directory = Path(evidence_dir)
    try:
        identity = validate_identity(directory)
        expected = validate_collection(directory, identity)
        result["expected_nodeids"] = expected
        invocations = read_json(directory, "invocations.json")
        require(isinstance(invocations, list) and invocations, "No runtime invocations")
        ids, all_selected, groups, previous_finish = set(), [], [], None
        for invocation in invocations:
            try:
                require(isinstance(invocation, dict), "Malformed invocation")
                identity_value = invocation.get("id")
                require(isinstance(identity_value, str) and identity_value and identity_value not in ids,
                        "Duplicate or missing invocation id")
                ids.add(identity_value)
                selected = node_list(invocation.get("selected_nodeids"))
                groups.append(selected)
                all_selected.extend(selected)
                argv = invocation.get("argv")
                require(isinstance(argv, list) and argv and all(isinstance(arg, str) for arg in argv),
                        "Missing invocation argv")
                start, finish = timestamp(invocation.get("started_at")), timestamp(invocation.get("finished_at"))
                require(start <= finish and (previous_finish is None or previous_finish <= start),
                        "Overlapping or reversed process intervals")
                previous_finish = finish
                owned_file(directory, invocation.get("raw_log"))
                reports = read_json(directory, invocation.get("reports_json"))
                require(isinstance(reports, dict) and reports.get("schema_version") == 1
                        and isinstance(reports.get("reports"), list), "Malformed phase reports")
                phase_counts = Counter()
                observed = []
                for report in reports["reports"]:
                    require(isinstance(report, dict), "Malformed phase report")
                    node, when = report.get("nodeid"), report.get("when")
                    require(node in selected and when in ("setup", "call", "teardown"),
                            "Unknown node or execution phase")
                    phase_counts[(node, when)] += 1
                    if when == "call":
                        observed.append(node)
                    require(report.get("outcome") == "passed" and "wasxfail" in report
                            and report["wasxfail"] is None, "Nonpassing or xfail/xpass report")
                result["observed_nodeids"].extend(observed)
                require(phase_counts == Counter({(node, when): 1 for node in selected
                                                 for when in ("setup", "call", "teardown")}),
                        "Missing or duplicate execution phase")
                xml = ET.parse(owned_file(directory, invocation.get("junit_xml"))).getroot()
                cases = list(xml.iter("testcase"))
                require(len(cases) == len(selected), "JUnit testcase count disagrees")
                require(not any(list(xml.iter(tag)) for tag in ("failure", "error", "skipped")),
                        "JUnit contains a nonpassing result")
                for element in xml.iter():
                    for key in ("errors", "failures", "skipped"):
                        if key in element.attrib:
                            require(int(element.attrib[key]) == 0, "JUnit aggregate is nonzero")
                process_success(invocation)
            except Exception as error:
                result["errors"].append("Invocation evidence: " + str(error))
        if Counter(all_selected) != Counter(expected):
            result["errors"].append("Collection/runtime selection multiplicity mismatch")
        if Counter(result["observed_nodeids"]) != Counter(expected):
            result["errors"].append("Collection/runtime call multiplicity mismatch")
        if identity["lane"] == "foobar":
            core = [node for node in expected if node.split("::", 1)[0] == FOOBAR[0]]
            if groups != [core, *[[node] for node in RESOURCE_NODES]]:
                result["errors"].append("Foobar processes are not core then thirteen individual ordered resource nodes")
        elif groups != [expected]:
            result["errors"].append("Sample/CI-helper must execute its complete collection in one invocation")
    except Exception as error:
        result["errors"].append("Evidence unavailable or invalid: " + str(error))
    if not result["errors"]:
        result["status"] = "pass"
    return result


def run_owned(argv, *, cwd, env, log_path, timeout_seconds,
              terminate_grace_seconds=30, popen_factory=None):
    """Own one new process group and retain every interruption/failure."""
    require(isinstance(argv, (list, tuple)) and argv and all(isinstance(arg, str) for arg in argv),
            "Invalid child argv")
    require(0 < timeout_seconds and 0 < terminate_grace_seconds <= 30, "Invalid process ceiling")
    result = {"argv": list(argv), "exit_code": None, "timed_out": False,
              "cleanup_complete": False, "writer_errors": [], "cancelled": False,
              "started_at": utc_now(), "finished_at": None}
    child = None
    synthetic = popen_factory is not None
    factory = subprocess.Popen if popen_factory is None else popen_factory
    shutdown_phases = {}

    def problem(stage, error):
        result["writer_errors"].append(stage + ": " + type(error).__name__ + ": " + str(error))

    def send(sig):
        try:
            os.killpg(child.pid, sig)
            return True
        except ProcessLookupError:
            return True
        except Exception as error:
            problem("owned group signal", error)
            return False

    def shutdown_phase(sig):
        # One group-level deadline per signal, shared by direct-child reap and
        # descendant inspection. Neither a late direct exit nor a second cleanup
        # entry may restart the TERM grace or extend the bounded KILL/reap phase.
        if sig not in shutdown_phases:
            deadline = time.monotonic() + terminate_grace_seconds
            shutdown_phases[sig] = (deadline, False)
            shutdown_phases[sig] = (deadline, send(sig))
        return shutdown_phases[sig]

    def wait_until(deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            code = child.poll()
            if code is None:
                raise subprocess.TimeoutExpired(list(argv), 0)
            return code
        return child.wait(timeout=remaining)

    def stop():
        deadline, signalled = shutdown_phase(signal.SIGTERM)
        try:
            result["exit_code"] = wait_until(deadline)
            return signalled
        except subprocess.TimeoutExpired:
            deadline, kill_signalled = shutdown_phase(signal.SIGKILL)
            signalled = kill_signalled and signalled
            try:
                result["exit_code"] = wait_until(deadline)
                return signalled
            except BaseException as error:
                problem("owned child reap", error)
                return False
        except BaseException as error:
            problem("owned child termination", error)
            deadline, _ = shutdown_phase(signal.SIGKILL)
            try:
                result["exit_code"] = wait_until(deadline)
            except BaseException as reap_error:
                problem("owned child final reap", reap_error)
            return False

    def descendants_gone():
        # The synthetic factory owns no OS processes; its wait/signal transcript
        # is its lifecycle boundary. Production also checks for surviving children
        # in the dedicated group after its direct child has been reaped.
        if synthetic:
            return True

        def alive():
            try:
                os.killpg(child.pid, 0)
                return True
            except ProcessLookupError:
                return False

        try:
            if not alive():
                return True
            waiter = threading.Event()
            for sig in (signal.SIGTERM, signal.SIGKILL):
                deadline, signalled = shutdown_phase(sig)
                if not signalled:
                    return False
                while alive():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    waiter.wait(min(0.1, remaining))
                if not alive():
                    return True
            return False
        except BaseException as error:
            problem("owned descendants", error)
            return False

    try:
        # Do not spawn if output cannot be exclusively created.
        with Path(log_path).open("xb") as log:
            try:
                child = factory(list(argv), cwd=cwd, env=env, stdout=log,
                                stderr=subprocess.STDOUT, shell=False, start_new_session=True)
                require(positive(child.pid), "Invalid owned child PID")
                try:
                    result["exit_code"] = child.wait(timeout=timeout_seconds)
                    result["cleanup_complete"] = True
                except subprocess.TimeoutExpired:
                    result["timed_out"] = True
                    result["cleanup_complete"] = stop()
                except (KeyboardInterrupt, SystemExit):
                    result["cancelled"] = True
                    result["cleanup_complete"] = stop()
                except BaseException as error:
                    problem("owned child wait", error)
                    result["cleanup_complete"] = stop()
                if result["cleanup_complete"]:
                    result["cleanup_complete"] = descendants_gone()
            except (KeyboardInterrupt, SystemExit):
                result["cancelled"] = True
                if child is not None:
                    result["cleanup_complete"] = stop()
            except Exception as error:
                problem("owned child spawn", error)
                if child is not None and positive(getattr(child, "pid", None)):
                    result["cleanup_complete"] = stop()
            try:
                log.flush()
                os.fsync(log.fileno())
            except Exception as error:
                problem("log flush", error)
    except Exception as error:
        problem("log open/close", error)
    if result["cancelled"] and result["exit_code"] == 0:
        result["exit_code"] = -int(signal.SIGTERM)
    result["finished_at"] = utc_now()
    return result


class Capture:
    """Pytest hooks record facts, never modify items or their results."""
    def __init__(self):
        self.data = {"schema_version": 1, "discovered_nodeids": [], "nodeids": [],
                     "deselected_nodeids": [], "collection_errors": [], "reports": []}

    def pytest_collection_modifyitems(self, session, config, items):
        self.data["discovered_nodeids"] = [item.nodeid for item in items]
        yield
        self.data["nodeids"] = [item.nodeid for item in items]

    def pytest_deselected(self, items):
        self.data["deselected_nodeids"].extend(item.nodeid for item in items)

    def pytest_collectreport(self, report):
        # A skipped class/subcollector can disappear before item discovery.
        # Preserve every nonpass here rather than certify an incomplete suite.
        if not report.passed:
            self.data["collection_errors"].append(str(report.longrepr))

    def pytest_runtest_logreport(self, report):
        self.data["reports"].append({"nodeid": report.nodeid, "when": report.when,
                                    "outcome": report.outcome,
                                    "wasxfail": getattr(report, "wasxfail", None)})


def verify_source_hashes(root, identity):
    for relative, expected in identity["file_hashes"].items():
        path = root / relative
        require(not path.is_symlink() and path.resolve(strict=True).is_relative_to(root),
                "Source path escaped checked-out repository")
        require(hashlib.sha256(path.read_bytes()).hexdigest() == expected,
                "Source changed after identity capture: " + relative)


def child_entry(args):
    root = Path(__file__).resolve().parents[2]
    # Match python -m pytest's repository import root, in this child only.
    sys.path.insert(0, str(root))
    directory = args.identity.parent.resolve(strict=True)
    require(args.identity.name == "identity.json", "Unexpected child identity path")
    identity = validate_identity(directory)
    verify_source_hashes(root, identity)
    selectors = list(args.selectors)
    if selectors[:1] == ["--"]:
        selectors.pop(0)
    allowed = identity["selectors"]
    if args.mode == "collect":
        require(selectors == allowed, "Collection must use complete frozen whole modules")
    else:
        node_list(selectors)
        require(all(node.split("::", 1)[0] in allowed for node in selectors),
                "Runtime contains an unselected module")
        collected = validate_collection(directory, identity)
        require(set(selectors) <= set(collected), "Runtime contains an uncollected node")
    capture_path = args.capture.resolve()
    require(capture_path.is_relative_to(directory) and not capture_path.exists(),
            "Child capture path is not fresh/owned")
    pytest_args = ["-q", "--tb=short", "-o", "faulthandler_timeout=60"]
    if identity["lane"] in ("foobar", "ci-helper"):
        require(os.environ.get("PYTEST_DISABLE_PLUGIN_AUTOLOAD") == "1",
                "Isolated child must disable external plugin autoload")
        pytest_args.extend(["--noconftest", "--import-mode=importlib", "-p", "no:cacheprovider"])
    if identity["lane"] == "foobar":
        # This initializer is deliberately unreachable for the ci-helper lane.
        require(not any(name in sys.modules for name in ("music_app", "music_app.services", PARSER_MODULE)),
                "Foobar child was not isolated")
        for name, relative in (("music_app", "music_app"), ("music_app.services", "music_app/services")):
            package = types.ModuleType(name)
            package.__path__ = [str(root / relative)]
            package.__package__ = name
            package.__spec__ = importlib.machinery.ModuleSpec(name, loader=None, is_package=True)
            package.__spec__.submodule_search_locations = package.__path__
            sys.modules[name] = package
        specification = importlib.util.spec_from_file_location(PARSER_MODULE, root / PARSER)
        require(specification is not None and specification.loader is not None, "Cannot load actual parser")
        module = importlib.util.module_from_spec(specification)
        sys.modules[PARSER_MODULE] = module
        specification.loader.exec_module(module)
        setattr(sys.modules["music_app.services"], "foobar_snapshot_parser", module)
    import pytest

    Capture.pytest_collection_modifyitems = pytest.hookimpl(hookwrapper=True, tryfirst=True)(
        Capture.pytest_collection_modifyitems)
    capture = Capture()
    if args.mode == "collect":
        pytest_args.append("--collect-only")
    else:
        require(args.junit is not None and args.junit.resolve().is_relative_to(directory)
                and not args.junit.exists(), "JUnit path is not fresh/owned")
        pytest_args.extend(["-vv", "--durations=20", "--junitxml=" + str(args.junit)])
    pytest_args.extend(selectors)
    exit_code = 1
    try:
        exit_code = int(pytest.main(pytest_args, plugins=[capture]))
    finally:
        write_json(capture_path, capture.data)
    return exit_code


def run_lane(args):
    root = Path(__file__).resolve().parents[2]
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_OS") == "Linux",
            "Feature runner is restricted to hosted Linux CI")
    require(digest(args.head, 40) and positive(args.run_id) and positive(args.attempt), "Invalid run identity")
    selectors = args.selection.read_text(encoding="utf-8").splitlines()
    require(selectors == list(selected_for(args.lane)), "Workflow selection is not the frozen tuple")
    directory = args.evidence_dir
    require(not directory.exists() and not directory.is_symlink(), "Evidence directory already exists")
    require(directory.resolve().is_relative_to(Path(os.environ["RUNNER_TEMP"]).resolve()),
            "Evidence must be in this runner's temporary directory")
    directory.mkdir(parents=True, exist_ok=False)
    invocations = []
    error = None
    try:
        require(args.admission.name == "admission.json", "Unexpected admission artifact name")
        _, _, admission_hash = admission_chain(args.admission.parent, args.head, args.run_id, args.attempt)
        for name in ("admission.json", "admission-context.json"):
            with (directory / name).open("xb") as stream:
                stream.write(owned_file(args.admission.parent, name).read_bytes())
        env = dict(os.environ)
        checkout = run_owned(["git", "rev-parse", "HEAD"], cwd=root, env=env,
                             log_path=directory / "checkout.log", timeout_seconds=10)
        write_json(directory / "checkout-process.json", checkout)
        process_success(checkout)
        checkout_head = (directory / "checkout.log").read_text(encoding="utf-8").strip()
        require(checkout_head == args.head, "Checkout is not exact admitted head")
        files = [*selectors, ADMISSION_HELPER, EVIDENCE_HELPER]
        if args.lane == "foobar":
            files.append(PARSER)
        hashes = {}
        for relative in files:
            path = root / relative
            require(not path.is_symlink() and path.resolve(strict=True).is_relative_to(root),
                    "Unowned source file")
            hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        identity = {"schema_version": 1, "lane": args.lane, "head_sha": args.head,
                    "checkout_head": checkout_head, "run_id": args.run_id, "attempt": args.attempt,
                    "authority": "supplemental-only", "python_version": sys.version,
                    "selectors": selectors, "file_hashes": hashes, "admission_sha256": admission_hash}
        write_json(directory / "identity.json", identity)
        write_json(directory / "invocations.json", invocations)
        if args.lane in ("foobar", "ci-helper"):
            env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
        base = [sys.executable, "-u", str(Path(__file__).resolve()), "_child",
                "--identity", str(directory / "identity.json")]
        capture = directory / "collection.capture.json"
        collection_argv = [*base, "--mode", "collect", "--capture", str(capture), "--", *selectors]
        collection_process = run_owned(collection_argv, cwd=root, env=env,
                                       log_path=directory / "collection.log",
                                       timeout_seconds=(CI_HELPER_COLLECTION_SECONDS
                                                        if args.lane == "ci-helper" else COLLECTION_SECONDS))
        collection = {"discovered_nodeids": [], "nodeids": [], "deselected_nodeids": [],
                      "collection_errors": ["Collection capture was not produced"],
                      **collection_process, "raw_log": "collection.log"}
        if capture.is_file():
            captured = read_json(directory, capture.name)
            for key in ("discovered_nodeids", "nodeids", "deselected_nodeids", "collection_errors"):
                collection[key] = captured.get(key)
        write_json(directory / "collection.json", collection)
        nodes = validate_collection(directory, identity)
        if args.lane == "sample":
            groups = [(nodes, SAMPLE_SECONDS)]
        elif args.lane == "ci-helper":
            groups = [(nodes, CI_HELPER_SECONDS)]
        else:
            core = [node for node in nodes if node.split("::", 1)[0] == FOOBAR[0]]
            groups = [(core, FOOBAR_CORE_SECONDS), *[([node], RESOURCE_SECONDS) for node in RESOURCE_NODES]]
        for index, (selected, ceiling) in enumerate(groups):
            verify_source_hashes(root, identity)
            prefix = "run-" + str(index)
            log_name, xml_name, reports_name = prefix + ".log", prefix + ".xml", prefix + ".json"
            argv = [*base, "--mode", "runtime", "--capture", str(directory / reports_name),
                    "--junit", str(directory / xml_name), "--", *selected]
            invocation = run_owned(argv, cwd=root, env=env, log_path=directory / log_name,
                                   timeout_seconds=ceiling)
            invocation.update({"id": prefix, "selected_nodeids": selected, "raw_log": log_name,
                               "junit_xml": xml_name, "reports_json": reports_name})
            invocations.append(invocation)
            write_json(directory / "invocations.json", invocations)
            if invocation["cancelled"] or not invocation["cleanup_complete"]:
                break
            # Ordinary failure or a safely reaped timeout never drops later
            # independent resource cases. No assertion is retried.
    except (KeyboardInterrupt, SystemExit) as exc:
        error = "Caller cancellation: " + type(exc).__name__
    except Exception as exc:
        error = type(exc).__name__ + ": " + str(exc)
    result = reconcile(directory)
    if error:
        result["status"] = "fail"
        result["errors"].append(error)
    write_json(directory / "reconciliation.json", result)
    return 0 if result["status"] == "pass" else 1


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    runner = commands.add_parser("run")
    runner.add_argument("--lane", choices=("sample", "foobar", "ci-helper"), required=True)
    runner.add_argument("--selection", type=Path, required=True)
    runner.add_argument("--evidence-dir", type=Path, required=True)
    runner.add_argument("--admission", type=Path, required=True)
    runner.add_argument("--head", required=True)
    runner.add_argument("--run-id", type=int, required=True)
    runner.add_argument("--attempt", type=int, required=True)
    child = commands.add_parser("_child")
    child.add_argument("--mode", choices=("collect", "runtime"), required=True)
    child.add_argument("--identity", type=Path, required=True)
    child.add_argument("--capture", type=Path, required=True)
    child.add_argument("--junit", type=Path)
    child.add_argument("selectors", nargs=argparse.REMAINDER)
    review = commands.add_parser("reconcile")
    review.add_argument("evidence_dir", type=Path)
    args = parser.parse_args()

    def cancelled(signum, frame):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, cancelled)
    if args.command == "_child":
        return child_entry(args)
    if args.command == "run":
        return run_lane(args)
    result = reconcile(args.evidence_dir)
    write_json(args.evidence_dir / "reconciliation.json", result)
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(cli())
