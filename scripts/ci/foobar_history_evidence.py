"""One fixed, source-pinned, supplemental stdlib history evidence invocation.

Importing this adapter is inert. Only its explicit Linux hosted entrypoints may
install limits, load repository modules, or invoke the unchanged supervisor.
"""
from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import resource
import signal
import stat
import sys
import time
import unittest


REPOSITORY = "idanilovqa/AlbumHaven"
BRANCH = "2026-10-03-album-tops"
ADAPTER = "scripts/ci/foobar_history_evidence.py"
HELPER = "scripts/ci/new_feature_evidence.py"
ADMISSION = "scripts/ci/admit-new-feature-evidence.py"
WORKFLOW = ".github/workflows/foobar-history-backend-evidence.yml"
MANIFEST = "scripts/ci/foobar_history_nodes.txt"
CONTROL = "tests/ci/test_foobar_history_evidence.py"
HISTORY = "tests/py/test_foobar_history_projection.py"
PRODUCT = "music_app/services/foobar_history_projection.py"
SOURCES = ("music_app/__init__.py", "music_app/services/__init__.py", PRODUCT,
           HISTORY, ADMISSION, HELPER, WORKFLOW, ADAPTER, MANIFEST, CONTROL)
PINNED_BLOBS = {
    "music_app/__init__.py": "1953ff01479342f66c8ebf61a89f9682e2646ee9",
    "music_app/services/__init__.py": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    PRODUCT: "90f3a3b2aaa46a7742e1a73cf751ba240453d13a",
    HISTORY: "14f78db6e286494cb3e5ff7cff55f2de99d4c9bd",
    HELPER: "99b5f61d498351d3a5a588480ab2dc93cd4b0694",
    ADMISSION: "1c2fafe96e46f0bc044b124afb18a962b04303a6",
}
MANIFEST_HASH = "2975f3e7e21bc7e6252a695c41636259bc1c93fc4e81f72607e4a78a901c684d"
CONTROL_HASH = "c91127a92e4659147b62889b8dc3a6b1df2e2f5dbba98aa72f50515959689a88"
CONTROL_IDS = tuple("test_foobar_history_evidence.HistoryEvidenceTests." + name for name in (
    "test_canonical_loading_boundaries", "test_collection_identity_and_multiplicity",
    "test_evidence_limits_and_fresh_paths", "test_exact_selection_and_source_guards",
    "test_native_admission_identity_and_hold", "test_process_failure_and_cleanup",
    "test_standard_result_and_subtest_accounting", "test_workflow_and_budget_contract"))
LIMIT = 1048576
LIMITS = {"RLIMIT_AS": [536870912, 536870912], "RLIMIT_CPU": [20, 30],
          "RLIMIT_NOFILE": [64, 64], "RLIMIT_CORE": [0, 0],
          "RLIMIT_FSIZE": [LIMIT, LIMIT]}
WRITERS = {"driver": ("identity.json", "admission-context.json", "process-records.json", "inventory.json"),
           "controls": ("controls-result.json",), "history": ("collection.json", "result.json")}
FILES = tuple(sorted(("admission.json", "git.log", "admission.log", "controls.log", "history.log",
                      *WRITERS["driver"], *WRITERS["controls"], *WRITERS["history"])))
REFERENCE_KEYS = ("repository", "head_sha", "pr_number", "run_id", "attempt")
EVENTS = ("opened", "synchronize", "reopened", "ready_for_review", "labeled", "unlabeled")
LABELS = ("run_reviews", "skip_tests", "ci:full-review", "ci:focused-e2e", "ci:focused-related")
FOUNDATIONS = ("JavaScript Tests (Portable)", "Component Tests (Pinned Chrome)",
               "JavaScript Tests (Windows Contract)", "Python Tests")
PREREQUISITES = ("PR Review Scope", "Review Prerequisites")
shared = None


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _positive(value):
    return type(value) is int and value > 0


def _digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _directory(path):
    path = Path(path)
    _require(path.is_absolute() and path.resolve(strict=True) == path
             and not path.is_symlink() and path.is_dir(), "Unsafe directory")
    return path


def _read(path, *, sync=False):
    path = Path(path)
    _directory(path.parent)
    _require(not path.is_symlink() and path.resolve(strict=True) == path
             and stat.S_ISREG(path.lstat().st_mode), "Unsafe regular file")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        info = os.fstat(stream.fileno())
        _require(stat.S_ISREG(info.st_mode) and info.st_size <= LIMIT, "Oversized or unsafe file")
        raw = stream.read(LIMIT + 1)
        _require(len(raw) <= LIMIT, "Oversized file")
        if sync:
            os.fsync(stream.fileno())
    return raw


def _decode(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            _require(key not in value, "Duplicate JSON key")
            value[key] = item
        return value

    def invalid(value):
        raise ValueError("Nonfinite JSON value")

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique, parse_constant=invalid)
    _require(isinstance(value, dict), "Expected JSON object")
    return value


def write_document(output: Path, name: str, document: dict, *, lane: str) -> None:
    _require(lane in WRITERS and name in WRITERS[lane], "Unowned output filename")
    _require(isinstance(document, dict), "Expected document object")
    raw = (json.dumps(document, sort_keys=True, indent=2, ensure_ascii=True,
                      allow_nan=False) + "\n").encode("utf-8")
    _require(len(raw) <= LIMIT, "Oversized document")
    output = _directory(output)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    with os.fdopen(os.open(output / name, flags, 0o600), "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def read_admission(output: Path) -> dict:
    return _decode(_read(_directory(output) / "admission.json", sync=True))


def install_limits() -> dict:
    for name, pair in LIMITS.items():
        constant = getattr(resource, name)
        resource.setrlimit(constant, tuple(pair))
        _require(resource.getrlimit(constant) == tuple(pair), "Resource limit mismatch: " + name)
    return {name: list(pair) for name, pair in LIMITS.items()}


def install_cancellation() -> dict:
    state = {"cancelled": False, "signal": None}

    def cancel(signum, frame):
        if not state["cancelled"]:
            state.update(cancelled=True, signal=signum)
            raise KeyboardInterrupt

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGXCPU):
        signal.signal(signum, cancel)
    return state


def _source_hashes(root):
    root = _directory(root)
    hashes = {}
    for relative in SOURCES:
        path = root / relative
        _require(path.resolve(strict=True).is_relative_to(root), "Source escaped checkout")
        raw = _read(path)
        hashes[relative] = _digest(raw)
        if relative in PINNED_BLOBS:
            blob = hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
            _require(blob == PINNED_BLOBS[relative], "Pinned source changed: " + relative)
        if path.suffix == ".py":
            _require(not path.with_suffix(".pyc").exists()
                     and not any((path.parent / "__pycache__").glob(path.stem + ".*.pyc")),
                     "Bytecode present for allowed source")
    _require(hashes[MANIFEST] == MANIFEST_HASH and hashes[CONTROL] == CONTROL_HASH,
             "Independent manifest or accepted controls changed")
    return hashes


def _load_shared(root):
    global shared
    # Tests replace this one module attribute; production has no alternate factory.
    if shared is None:
        _source_hashes(root)
        spec = importlib.util.spec_from_file_location("foobar_history_shared_owner", root / HELPER)
        _require(spec is not None and spec.loader is not None, "Missing supervisor loader")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        shared = module


def expected_ids(root: Path, lane: str) -> list[str]:
    _require(lane in ("controls", "history"), "Invalid suite lane")
    if lane == "controls":
        return list(CONTROL_IDS)
    raw = _read(root / MANIFEST)
    _require(_digest(raw) == MANIFEST_HASH, "Frozen node manifest changed")
    ids = raw.decode("utf-8").splitlines()
    _require(len(ids) == 50 and ids == sorted(set(ids))
             and raw == ("\n".join(ids) + "\n").encode("utf-8"), "Invalid node manifest")
    return ids


def discover_suite(root: Path, lane: str) -> tuple[unittest.TestSuite, list[str], list[str]]:
    _require(lane in ("controls", "history"), "Invalid suite lane")
    directory = root / ("tests/ci" if lane == "controls" else "tests/py")
    pattern = Path(CONTROL if lane == "controls" else HISTORY).name
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=str(directory), pattern=pattern, top_level_dir=str(directory))
    ids = []

    def visit(node):
        if isinstance(node, unittest.TestSuite):
            for child in node:
                visit(child)
        else:
            _require(isinstance(node, unittest.TestCase), "Unexpected suite member")
            ids.append(node.id())

    visit(suite)
    return suite, ids, list(loader.errors)


def parse_outcomes(raw_log: bytes) -> dict:
    _require(isinstance(raw_log, bytes) and len(raw_log) <= LIMIT, "Invalid log bytes")
    outcomes, counts, unparsed = [], [], []
    for line in raw_log.decode("utf-8").splitlines():
        match = re.fullmatch(r"(test_\w+) \(([A-Za-z_][\w.]*)\) \.\.\. (.+)", line)
        if match:
            method, node, status = match.groups()
            valid = status in ("ok", "FAIL", "ERROR", "expected failure", "unexpected success")
            if status.startswith("skipped "):
                reason = status[len("skipped "):]
                try:
                    parsed = ast.literal_eval(reason)
                    valid = isinstance(parsed, str) and repr(parsed) == reason
                except (SyntaxError, ValueError):
                    valid = False
            if valid and node.rsplit(".", 1)[-1] == method:
                outcomes.append({"id": node, "outcome": "skipped" if status.startswith("skipped ") else status,
                                 "raw_line": line})
            else:
                unparsed.append(line)
        elif " ... " in line or line.lstrip().startswith("test_"):
            unparsed.append(line)
        summary = re.fullmatch(r"Ran ([0-9]+) tests? in ([0-9]+(?:\.[0-9]+)?)s", line)
        if summary:
            counts.append(int(summary[1]))
    return {"outcomes": outcomes, "summary_counts": counts, "unparsed_outcome_lines": unparsed}


def _candidate_pass(document):
    expected = document["expected_ids"]
    return bool(expected and len(expected) == len(set(expected))
                and document["collected_ids"] == expected
                and [row["id"] for row in document["outcomes"]] == expected
                and all(row["outcome"] == "ok" for row in document["outcomes"])
                and document["summary_counts"] == [len(expected)]
                and not document["unparsed_outcome_lines"]
                and type(document["testsRun"]) is int and document["testsRun"] == len(expected)
                and all(document[name] == [] for name in ("errors", "failures", "skipped",
                                                           "expectedFailures", "unexpectedSuccesses"))
                and document["shouldStop"] is False and document["wasSuccessful"] is True
                and document["source_check"]["ok"] is True
                and document["source_check"]["unexpected"] == []
                and document["source_check"]["errors"] == [])


def result_document(*, lane: str, identity: dict, collected_ids: list[str], expected_ids: list[str],
                    result: unittest.TestResult, raw_log: bytes, source_check: dict) -> dict:
    _require(lane in ("controls", "history"), "Invalid suite lane")
    document = {"schema_version": 1, "lane": lane, "identity": dict(identity),
                "collected_ids": list(collected_ids), "expected_ids": list(expected_ids),
                "testsRun": result.testsRun, "shouldStop": result.shouldStop,
                "wasSuccessful": result.wasSuccessful(), **parse_outcomes(raw_log),
                "log": _file_record(lane + ".log", raw_log), "source_check": source_check}
    for name in ("errors", "failures", "skipped", "expectedFailures"):
        document[name] = [{"id": test.id(), "detail": detail} for test, detail in getattr(result, name)]
    document["unexpectedSuccesses"] = [test.id() for test in result.unexpectedSuccesses]
    document["candidate_pass"] = _candidate_pass(document)
    return document


def _file_record(name, raw):
    return {"name": name, "size_bytes": len(raw), "sha256": _digest(raw)}


def _reference(identity):
    return {key: identity[key] for key in REFERENCE_KEYS}


def _validate_identity(root, identity):
    _require(set(identity) == {"schema_version", *REFERENCE_KEYS, "branch", "python", "file_hashes", "limits"}
             and identity["schema_version"] == 1 and identity["repository"] == REPOSITORY
             and identity["branch"] == BRANCH and re.fullmatch(r"[0-9a-f]{40}", identity["head_sha"])
             and all(_positive(identity[key]) for key in ("pr_number", "run_id", "attempt"))
             and identity["limits"] == LIMITS and set(identity["file_hashes"]) == set(SOURCES),
             "Invalid invocation identity")
    _require(identity["python"] == {"implementation": platform.python_implementation(),
             "version": platform.python_version(), "executable": sys.executable}, "Interpreter identity changed")
    _require(identity["file_hashes"] == _source_hashes(root), "Source manifest changed")
    shared.verify_source_hashes(root, identity)


def _boundary(root, lane):
    directory = root / ("tests/ci" if lane == "controls" else "tests/py")
    _directory(directory)
    _require(not any(path.is_file() for path in directory.rglob("__init__.py")),
             "Unexpected test package boundary")
    tree = ast.parse(_read(root / (CONTROL if lane == "controls" else HISTORY)).decode("utf-8"))
    _require(not any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "load_tests"
                     for node in ast.walk(tree)), "Unexpected discovery hook")


def _modules(root, lane, identity):
    allowed = {ADAPTER, HELPER, CONTROL} if lane == "controls" else {
        ADAPTER, HELPER, HISTORY, PRODUCT, "music_app/__init__.py", "music_app/services/__init__.py"}
    canonical = {"test_foobar_history_evidence": CONTROL} if lane == "controls" else {
        "music_app": "music_app/__init__.py", "music_app.services": "music_app/services/__init__.py",
        "music_app.services.foobar_history_projection": PRODUCT, "test_foobar_history_projection": HISTORY}
    observed = []
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None)
        origin = getattr(getattr(module, "__spec__", None), "origin", None)
        # Direct script startup has no import spec. This exception is only the
        # already-hashed adapter itself, never an application/test module.
        if name == "__main__" and file == str(root / ADAPTER) and getattr(module, "__spec__", None) is None:
            origin = file
        sensitive = name == "music_app" or name.startswith("music_app.") or name in (
            "test_foobar_history_evidence", "test_foobar_history_projection")
        paths = [Path(value) for value in (file, origin) if isinstance(value, str) and Path(value).is_absolute()]
        local = any(path.is_relative_to(root) or path.resolve().is_relative_to(root) for path in paths)
        if sensitive or local:
            _require(isinstance(file, str) and isinstance(origin, str), "Missing module origin: " + name)
            path = Path(file)
            _require(path == Path(origin) and path.is_relative_to(root), "Noncanonical module: " + name)
            relative = str(path.relative_to(root))
            _require(relative in allowed and (not sensitive or canonical.get(name) == relative),
                     "Unexpected repository module: " + name)
            _require(relative not in canonical.values() or canonical.get(name) == relative,
                     "Aliased canonical module: " + name)
            digest = _digest(_read(path))
            _require(digest == identity["file_hashes"][relative], "Loaded source changed: " + name)
            observed.append({"name": name, "file": file, "origin": origin, "sha256_before": digest,
                             "sha256_after": digest})
    return sorted(observed, key=lambda item: item["name"])


def run_suite(root: Path, output: Path, lane: str) -> int:
    previous_path = list(sys.path)
    try:
        _require(lane in ("controls", "history"), "Invalid suite lane")
        install_limits()
        cancellation = install_cancellation()
        root, output = _directory(root), _directory(output)
        _load_shared(root)
        identity = _decode(_read(output / "identity.json"))
        _validate_identity(root, identity)
        _boundary(root, lane)
        _modules(root, lane, identity)
        wanted = expected_ids(root, lane)
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
        if lane == "history":
            def expired(signum, frame):
                raise TimeoutError("History collection deadline expired")
            previous = signal.signal(signal.SIGALRM, expired)
            try:
                signal.setitimer(signal.ITIMER_REAL, 10)
                suite, ids, errors = discover_suite(root, lane)
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, previous)
        else:
            suite, ids, errors = discover_suite(root, lane)
        modules = _modules(root, lane, identity)
        if lane == "history":
            write_document(output, "collection.json", {"schema_version": 1, "lane": lane,
                "identity": _reference(identity), "collected_ids": ids, "loader_errors": errors,
                "modules": modules}, lane=lane)
        _require(wanted and ids == wanted and len(ids) == len(set(ids)) and not errors
                 and not cancellation["cancelled"], "Invalid actual collection")
        result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2, failfast=False, buffer=False).run(suite)
        sys.stderr.flush()
        raw_log = _read(output / (lane + ".log"))
        _validate_identity(root, identity)
        after = _modules(root, lane, identity)
        _require(after == modules and not cancellation["cancelled"], "Module closure changed or interrupted")
        document = result_document(lane=lane, identity=_reference(identity), collected_ids=ids,
            expected_ids=wanted, result=result, raw_log=raw_log,
            source_check={"ok": True, "modules": after, "unexpected": [], "errors": []})
        write_document(output, "controls-result.json" if lane == "controls" else "result.json", document, lane=lane)
        return 0 if document["candidate_pass"] else 1
    except (Exception, KeyboardInterrupt, SystemExit) as error:
        print("History evidence stopped: " + type(error).__name__ + ": " + str(error)[:1000], file=sys.stderr)
        return 1
    finally:
        sys.path[:] = previous_path


def _event_context(event):
    pr = event["pull_request"]
    head = pr["head"]
    _require(event.get("action") in EVENTS and event["repository"]["full_name"] == REPOSITORY
             and head["repo"]["full_name"] == REPOSITORY and head["ref"] == BRANCH
             and pr["state"] == "open" and pr["draft"] is False and _positive(pr["number"])
             and event["number"] == pr["number"] and re.fullmatch(r"[0-9a-f]{40}", head["sha"]),
             "Invalid pull-request identity")
    names = sorted({item["name"].strip() for item in pr["labels"] if item["name"].strip()})
    controls = [name for name in names if name in LABELS or name.startswith(("ci:e2e:", "ci:e2e-performance:"))]
    return {"repository": REPOSITORY, "number": pr["number"], "branch": BRANCH,
            "head_sha": head["sha"], "draft": False, "control_labels": controls, "all_labels": names}


def _admitted(admission, context, attempt):
    _require(attempt > 1 and admission.get("schema_version") == 1 and admission.get("decision") == "admit"
             and admission.get("reason_codes") == [] and admission.get("authority") == "supplemental-only"
             and admission.get("coverage") == "unproven", "Native admission held")
    for view in (admission.get("trigger"), admission.get("current")):
        _require(isinstance(view, dict) and all(view.get(key) == context[key] for key in (
            "repository", "number", "branch", "head_sha", "draft", "control_labels")), "Admission identity changed")
    native = admission.get("native")
    _require(isinstance(native, dict) and all(_positive(native.get(key)) for key in (
        "id", "run_number", "attempt", "workflow_id")) and native.get("head_sha") == context["head_sha"]
        and native.get("status") == "completed" and native.get("conclusion") in ("success", "failure"),
        "Native workflow is not admissible")
    jobs = native.get("jobs")
    _require(isinstance(jobs, list), "Missing native jobs")
    for job in jobs:
        _require(job.get("run_id") == native["id"] and job.get("run_attempt") == native["attempt"]
                 and job.get("head_sha") == context["head_sha"] and job.get("head_branch") == BRANCH
                 and job.get("workflow_name") == "PR Gates" and job.get("status") == "completed",
                 "Unfinished or mismatched native job")
    for name in (*PREREQUISITES, *FOUNDATIONS):
        owners = [job for job in jobs if job.get("name") == name]
        allowed = ("success",) if name in PREREQUISITES else ("success", "failure", "timed_out", "cancelled")
        _require(len(owners) == 1 and owners[0].get("conclusion") in allowed
                 and (name in PREREQUISITES or bool(owners[0].get("started_at"))), "Missing native prerequisite")


def _check_result(root, output, lane, identity, raw):
    name = "controls-result.json" if lane == "controls" else "result.json"
    result_raw = _read(output / name)
    document = _decode(result_raw)
    wanted = expected_ids(root, lane)
    fields = {"schema_version", "lane", "identity", "collected_ids", "expected_ids", "testsRun",
              "errors", "failures", "skipped", "expectedFailures", "unexpectedSuccesses", "shouldStop",
              "wasSuccessful", "outcomes", "summary_counts", "unparsed_outcome_lines", "log",
              "source_check", "candidate_pass"}
    _require(set(document) == fields and type(document["schema_version"]) is int
             and document["schema_version"] == 1 and document.get("lane") == lane
             and document.get("identity") == _reference(identity) and document.get("expected_ids") == wanted
             and document.get("candidate_pass") is True and _candidate_pass(document), "Invalid suite result")
    _require(document.get("log") == _file_record(lane + ".log", raw)
             and all(document.get(key) == value for key, value in parse_outcomes(raw).items()),
             "Final closed log disagrees with child evidence")
    if lane == "history":
        collection = _decode(_read(output / "collection.json"))
        _require(set(collection) == {"schema_version", "lane", "identity", "collected_ids", "loader_errors", "modules"}
                 and type(collection["schema_version"]) is int and collection["schema_version"] == 1
                 and collection.get("lane") == lane
                 and collection.get("identity") == _reference(identity)
                 and collection.get("collected_ids") == wanted and collection.get("loader_errors") == [],
                 "Invalid pre-run collection evidence")
    return _digest(result_raw)


def _inventory(output, identity):
    found = {path.name for path in output.iterdir()}
    _require(found.issubset(FILES) and "inventory.json" not in found, "Unknown or preexisting evidence")
    entries = [_file_record(name, _read(output / name)) for name in sorted(found)]
    _require(sum(item["size_bytes"] for item in entries) <= 11 * LIMIT, "Aggregate evidence overflow")
    missing = sorted(set(FILES) - {"inventory.json"} - found)
    return {"schema_version": 1, "identity": identity, "files": entries,
            "missing": missing, "complete": not missing}


def run_driver(root: Path, output: Path, event: Path, run_id: int, attempt: int) -> int:
    phases, errors = [], []
    identity = None
    reference = None
    limits = {}
    cancellation = {"cancelled": False, "signal": None}
    created, success = False, False
    started, child_seconds = time.monotonic(), 0.0
    try:
        limits = install_limits()
        cancellation = install_cancellation()
        root = _directory(root)
        _require(_positive(run_id) and _positive(attempt) and output.is_absolute()
                 and output.name == f"foobar-history-{run_id}-{attempt}"
                 and not output.is_relative_to(root), "Invalid output identity")
        _directory(output.parent)
        output.mkdir(mode=0o700)
        created = True
        context = _event_context(_decode(_read(event)))
        reference = {"repository": REPOSITORY, "head_sha": context["head_sha"],
                     "pr_number": context["number"], "run_id": run_id, "attempt": attempt}
        _load_shared(root)
        identity = {"schema_version": 1, **reference, "branch": BRANCH,
            "python": {"implementation": platform.python_implementation(), "version": platform.python_version(),
                       "executable": sys.executable}, "file_hashes": _source_hashes(root), "limits": limits}
        _validate_identity(root, identity)
        write_document(output, "identity.json", identity, lane="driver")
        # setup-python supplies its Linux shared-library search path. Preserve
        # that explicit runtime input, not arbitrary Python/plugin/secret env.
        env = {name: os.environ[name] for name in ("PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "LD_LIBRARY_PATH")
               if name in os.environ}
        prefix = [sys.executable, "-I", "-S", "-B"]
        commands = (
            ("git", ["git", "rev-parse", "HEAD"], 10),
            ("admission", [*prefix, str(root / ADMISSION), "--event", str(event), "--attempt", str(attempt),
                           "--output", str(output / "admission.json")], 75),
            ("controls", [*prefix, str(root / ADAPTER), "controls", "--root", str(root), "--output", str(output)], 30),
            ("history", [*prefix, str(root / ADAPTER), "history", "--root", str(root), "--output", str(output)], 60))
        for name, argv, timeout in commands:
            _require(not cancellation["cancelled"] and time.monotonic() - started - child_seconds <= 60,
                     "Driver cancelled or verification budget exhausted")
            phase = {"name": name, "record": None, "log": None, "result_sha256": None,
                     "closed_log_agrees": False if name in ("controls", "history") else None}
            phases.append(phase)
            before = time.monotonic()
            try:
                record = shared.run_owned(argv, cwd=root, env=env, log_path=output / (name + ".log"),
                                          timeout_seconds=timeout, terminate_grace_seconds=30)
                phase["record"] = record
            finally:
                duration = time.monotonic() - before
                child_seconds += duration
                # Diagnostic observations survive a missing return or failed
                # process. They never assert cleanup, log agreement or a pass.
                try:
                    phase["log"] = _file_record(name + ".log", _read(output / (name + ".log")))
                except (OSError, ValueError):
                    pass
                if name in ("controls", "history"):
                    result_name = "controls-result.json" if name == "controls" else "result.json"
                    try:
                        phase["result_sha256"] = _digest(_read(output / result_name))
                    except (OSError, ValueError):
                        pass
            if isinstance(record, dict) and record.get("cancelled"):
                cancellation["cancelled"] = True
            raw = _read(output / (name + ".log"))
            phase["log"] = _file_record(name + ".log", raw)
            shared.process_success(record)
            _require(duration <= timeout + 60 and not cancellation["cancelled"], "Owned phase exceeded budget")
            _validate_identity(root, identity)
            if name == "git":
                _require(raw == (context["head_sha"] + "\n").encode("ascii"), "Checkout head mismatch")
            elif name == "admission":
                admission = read_admission(output)
                native = admission.get("native")
                write_document(output, "admission-context.json", {"schema_version": 1, "identity": reference,
                    "admission_sha256": _digest(_read(output / "admission.json")),
                    "decision": admission.get("decision"), "reason_codes": admission.get("reason_codes"),
                    "native": {key: native.get(key) for key in ("id", "run_number", "attempt", "head_sha",
                               "status", "conclusion")} if isinstance(native, dict) else None}, lane="driver")
                _admitted(admission, context, attempt)
            else:
                phase["result_sha256"] = _check_result(root, output, name, identity, raw)
                phase["closed_log_agrees"] = True
        success = True
    except (Exception, KeyboardInterrupt, SystemExit) as error:
        errors.append(type(error).__name__ + ": " + str(error)[:1000])
    finally:
        if created:
            try:
                _require(not cancellation["cancelled"] or not success, "Interrupted completion")
                write_document(output, "process-records.json", {"schema_version": 1, "identity": reference,
                    "limits": limits, "cancelled": cancellation["cancelled"], "phases": phases,
                    "finalization_errors": errors}, lane="driver")
                inventory = _inventory(output, reference)
                write_document(output, "inventory.json", inventory, lane="driver")
                success = success and inventory["complete"] and not errors
            except (Exception, KeyboardInterrupt, SystemExit):
                success = False
    elapsed = time.monotonic() - started
    return 0 if success and not cancellation["cancelled"] and elapsed <= 540 and elapsed - child_seconds <= 60 else 1


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        _require(argv and argv[0] in ("driver", "controls", "history"), "Expected fixed mode")
        mode = argv[0]
        options = ("--root", "--output", "--event", "--run-id", "--attempt") if mode == "driver" else ("--root", "--output")
        _require(len(argv) == 1 + 2 * len(options), "Wrong argument count")
        names, values = argv[1::2], argv[2::2]
        _require(set(names) == set(options) and len(set(names)) == len(names), "Unknown or duplicate option")
        args = dict(zip(names, values))
        for name in ("--root", "--output", "--event"):
            if name in args:
                args[name] = Path(args[name])
                _require(args[name].is_absolute(), "Expected absolute path")
        if mode == "driver":
            for name in ("--run-id", "--attempt"):
                _require(re.fullmatch(r"[1-9][0-9]*", args[name]), "Expected positive integer")
                args[name] = int(args[name])
    except (ValueError, TypeError, IndexError):
        return 2
    if mode == "driver":
        return run_driver(args["--root"], args["--output"], args["--event"], args["--run-id"], args["--attempt"])
    return run_suite(args["--root"], args["--output"], mode)


if __name__ == "__main__":
    raise SystemExit(main())
