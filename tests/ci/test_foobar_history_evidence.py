"""Product-free controls for the fixed supplemental history evidence owner."""
from __future__ import annotations

import ast
import builtins
from contextlib import ExitStack
import copy
import fnmatch
import hashlib
import http.client  # Finish SSL/socket class initialization before effect guards.
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import platform
import re
import resource
import shlex
import signal
import socket
import stat
import subprocess
import sys
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
ADAPTER = "scripts/ci/foobar_history_evidence.py"
WORKFLOW = ".github/workflows/foobar-history-backend-evidence.yml"
MANIFEST = "scripts/ci/foobar_history_nodes.txt"
CONTROL = "tests/ci/test_foobar_history_evidence.py"
HISTORY = "tests/py/test_foobar_history_projection.py"
PRODUCT = "music_app/services/foobar_history_projection.py"
HELPER = "scripts/ci/new_feature_evidence.py"
ADMISSION = "scripts/ci/admit-new-feature-evidence.py"
REPOSITORY = "idanilovqa/AlbumHaven"
BRANCH = "2026-10-03-album-tops"
HEAD = "1234567890abcdef1234567890abcdef12345678"
LIMIT = 1048576
LIMITS = {"RLIMIT_AS": [536870912, 536870912], "RLIMIT_CPU": [20, 30],
          "RLIMIT_NOFILE": [64, 64], "RLIMIT_CORE": [0, 0],
          "RLIMIT_FSIZE": [1048576, 1048576]}
SOURCES = ("music_app/__init__.py", "music_app/services/__init__.py", PRODUCT,
           HISTORY, ADMISSION, HELPER, WORKFLOW, ADAPTER, MANIFEST, CONTROL)
FILES = ("admission-context.json", "admission.json", "admission.log",
         "collection.json", "controls-result.json", "controls.log", "git.log",
         "history.log", "identity.json", "inventory.json", "process-records.json",
         "result.json")
CONTROL_IDS = (
    "test_foobar_history_evidence.HistoryEvidenceTests.test_canonical_loading_boundaries",
    "test_foobar_history_evidence.HistoryEvidenceTests.test_collection_identity_and_multiplicity",
    "test_foobar_history_evidence.HistoryEvidenceTests.test_evidence_limits_and_fresh_paths",
    "test_foobar_history_evidence.HistoryEvidenceTests.test_exact_selection_and_source_guards",
    "test_foobar_history_evidence.HistoryEvidenceTests.test_native_admission_identity_and_hold",
    "test_foobar_history_evidence.HistoryEvidenceTests.test_process_failure_and_cleanup",
    "test_foobar_history_evidence.HistoryEvidenceTests.test_standard_result_and_subtest_accounting",
    "test_foobar_history_evidence.HistoryEvidenceTests.test_workflow_and_budget_contract",
)
# Frozen from the independent pre-implementation inventory, never discovery.
HISTORY_IDS = (
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_10001_events_are_structurally_rejected_in_both_modes",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_aligned_second_event_extrema_and_millisecond_extrema_are_accepted",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_canonical_remap_with_revision_change_does_not_mutate_old_snapshot",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_coarse_unknown_or_null_boundaries_never_imply_semantic_conflict",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_coverage_and_first_relation_cross_field_shape_is_validated",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_display_sorting_uses_coarse_and_unknown_nonnull_keys",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_dto_fields_are_frozen_slots_and_contain_no_invented_facts",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_duplicate_event_refs_are_invalid_even_at_different_timestamps",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_equal_anchor_order_is_first_then_events_then_bucket",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_equal_boundaries_keep_two_distinct_rows_first_before_bucket",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_event_count_exceeds_total_without_silently_dropping_evidence",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_event_permutations_produce_identical_values_in_both_modes",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_event_precision_requires_exact_nonnull_second_or_millisecond",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_events_container_and_nested_records_require_exact_types",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_exact_10000_event_bound_is_preserved_without_truncation",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_exact_event_outside_bounds_is_not_reinterpreted_by_this_projection",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_full_event_coverage_membership_matrix_in_both_modes",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_full_event_coverage_without_boundaries_has_no_bucket",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_grouped_is_one_total_at_last_for_one_two_and_large_counts",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_grouped_missing_boundaries_are_retained_without_anchor_substitution",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_history_total_is_exact_nonnegative_signed_64_bit_integer",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_individual_confirmed_first_one_and_remainder",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_individual_missing_first_is_one_whole_unknown_bucket",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_individual_missing_last_does_not_reuse_first_as_bucket_anchor",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_invalid_input_error_message_is_fixed_and_does_not_echo_source_text",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_known_anchors_precede_null_anchors_even_at_minimum_key",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_labels_and_precision_are_preserved_without_timestamp_parsing",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_nonempty_references_and_labels_are_not_stripped_or_reparsed",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_null_keys_are_retained_and_kind_order_resolves_unknown_anchors",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_order_key_is_exact_signed_64_bit_or_none",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_ordinary_python_argument_errors_remain_type_errors",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_partial_events_additional_first_consumes_exactly_one_remainder_member",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_partial_events_included_do_not_double_count_first",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_partial_events_without_first_keep_only_events_and_remaining_bucket",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_precision_coverage_relation_and_mode_use_strict_enumerations",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_reconciliation_precedence_is_shared_before_mode_selection",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_reference_and_label_utf8_bounds_are_bytes_not_characters",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_safe_comparability_uses_intervals_not_raw_anchor_inequality",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_same_label_or_timestamp_is_not_membership_evidence",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_same_time_distinct_refs_preserve_multiplicity_and_lexicographic_order",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_second_alignment_is_required_for_boundaries_and_events",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_single_count_has_exactly_one_hidden_count_boundary_or_unknown_row",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_single_count_noncomparable_boundaries_keep_first_and_both_endpoints",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_source_kind_rejects_lastfm_inapp_mixed_and_unproven_enhanced_origin",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_source_track_revision_and_mode_namespace_keys_without_delimiters",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_structural_invalidity_precedes_semantic_reconciliation",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_unknown_first_overlap_blocks_only_individual_when_remainder_exists",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_unreconciled_events_are_not_hidden_by_grouped_total",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_zero_has_no_rows_in_either_mode",
    "test_foobar_history_projection.FoobarHistoryProjectionTests.test_zero_with_any_boundary_requires_reconciliation",
)


def _digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _json(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True,
                       allow_nan=False) + "\n").encode("utf-8")


def _reference():
    return {"repository": REPOSITORY, "head_sha": HEAD, "pr_number": 17,
            "run_id": 801, "attempt": 2}


def _case(mode="ok", name="test_case"):
    def body(self):
        if mode == "failure":
            self.fail("synthetic assertion")
        elif mode == "error":
            raise ValueError("synthetic error")
        elif mode == "skip":
            self.skipTest("synthetic 'reason'\nline")
        elif mode == "expected":
            self.fail("expected synthetic assertion")
        elif mode == "subtest-failure":
            with self.subTest(value=7):
                self.fail("synthetic subtest assertion")
        elif mode == "subtest-error":
            with self.subTest(value=7):
                raise ValueError("synthetic subtest error")
        elif mode == "subtest-skip":
            with self.subTest(value=7):
                self.skipTest("synthetic subtest skip")
    if mode in ("expected", "unexpected"):
        body = unittest.expectedFailure(body)
    # No callback overrides, id overrides, product import, or outer-log writes.
    cls = type("SyntheticCase", (unittest.TestCase,),
               {"__module__": "synthetic_history_controls", name: body})
    return cls(name)


def _run_synthetic(mode="ok", name="test_case"):
    case = _case(mode, name)
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2, failfast=False,
                                    buffer=False).run(unittest.TestSuite([case]))
    return case, result, stream.getvalue().encode("utf-8")


def _log(ids):
    return ("".join(f"{node.rsplit('.', 1)[1]} ({node}) ... ok\n" for node in ids)
            + f"\n----------------------------------------------------------------------\n"
            + f"Ran {len(ids)} tests in 0.001s\n\nOK\n").encode("utf-8")


def _candidate(lane, identity, ids):
    raw = _log(ids)
    return {"schema_version": 1, "lane": lane, "identity": copy.deepcopy(identity),
            "collected_ids": list(ids), "expected_ids": list(ids), "testsRun": len(ids),
            "errors": [], "failures": [], "skipped": [], "expectedFailures": [],
            "unexpectedSuccesses": [], "shouldStop": False, "wasSuccessful": True,
            "outcomes": [{"id": node, "outcome": "ok", "raw_line": line}
                         for node, line in zip(ids, raw.decode().splitlines())],
            "summary_counts": [len(ids)], "unparsed_outcome_lines": [],
            "log": {"name": lane + ".log", "size_bytes": len(raw), "sha256": _digest(raw)},
            "source_check": {"ok": True, "modules": [], "unexpected": [], "errors": []},
            "candidate_pass": True}


def _admission():
    context = {"repository": REPOSITORY, "number": 17, "branch": BRANCH,
               "head_sha": HEAD, "draft": False, "control_labels": ["run_reviews"],
               "all_labels": ["run_reviews"]}
    names = ("PR Review Scope", "Review Prerequisites", "JavaScript Tests (Portable)",
             "Component Tests (Pinned Chrome)", "JavaScript Tests (Windows Contract)",
             "Python Tests")
    jobs = [{"id": 101 + i, "name": name, "run_id": 901, "run_attempt": 3,
             "head_sha": HEAD, "head_branch": BRANCH, "workflow_name": "PR Gates",
             "status": "completed", "conclusion": "success",
             "started_at": "2026-10-21T00:00:00Z"} for i, name in enumerate(names)]
    return {"schema_version": 1, "decision": "admit", "reason_codes": [],
            "observed_at": "2026-10-21T00:00:01Z", "authority": "supplemental-only",
            "coverage": "unproven", "trigger": copy.deepcopy(context),
            "current": copy.deepcopy(context), "inspected": [],
            "native": {"id": 901, "run_number": 1096, "attempt": 3, "workflow_id": 7,
                       "head_sha": HEAD, "status": "completed", "conclusion": "failure",
                       "jobs": jobs}}


class _MemoryFiles:
    """Only an invented evidence directory/event; real checkout reads stay real."""
    base = Path("/__foobar_history_controls__")
    output = base / "foobar-history-801-2"
    event = base / "event.json"

    def __init__(self, *, existing=False):
        self.files = {}
        self.dirs = {str(self.base)}
        if existing:
            self.dirs.add(str(self.output))
        self.links = {}  # Each synthetic link names a readable regular-file target.
        self.events = []
        self.handles = {}
        self.stack = ExitStack()
        self.next_fd = 20000
        self.read_requests = []

    def _virtual(self, value):
        return not isinstance(value, int) and (str(value) == str(self.base)
                                               or str(value).startswith(str(self.base) + "/"))

    def put(self, path, data):
        self.files[str(path)] = data if isinstance(data, bytes) else _json(data)

    def get(self, name):
        return json.loads(self.files[str(self.output / name)])

    def _stat(self, path, *, follow_symlinks=True):
        key = str(path)
        if follow_symlinks and key in self.links:
            key = self.links[key]
        if key in self.links:
            mode = stat.S_IFLNK | 0o777
        elif key in self.dirs:
            mode = stat.S_IFDIR | 0o700
        elif key in self.files:
            mode = stat.S_IFREG | 0o600
        else:
            raise FileNotFoundError(key)
        return os.stat_result((mode, 1, 1, 1, 1, 1, len(self.files.get(key, b"")), 0, 0, 0))

    def _open(self, file, mode="r", *args, **kwargs):
        if not self._virtual(file):
            # Preserve setup's ledger-bearing guard, including caught attempts.
            return self.original_open(file, mode, *args, **kwargs)
        key = str(file)
        if "x" in mode and (key in self.files or key in self.links):
            raise FileExistsError(key)
        if key in self.links:
            key = self.links[key]
        if key in self.dirs:
            raise IsADirectoryError(key)
        if "r" in mode and key not in self.files:
            raise FileNotFoundError(key)
        if any(char in mode for char in "wax"):
            if str(Path(key).parent) not in self.dirs:
                raise FileNotFoundError(str(Path(key).parent))
            self.files.setdefault(key, b"")
        self.next_fd += 1
        fd = self.next_fd
        owner = self
        writable = any(char in mode for char in "wax+")
        initial = b"" if any(char in mode for char in "wx") else self.files[key]

        class Stream(io.BytesIO):
            def fileno(self):
                return fd

            def read(self, size=-1):
                owner.read_requests.append((key, size))
                return super().read(size)

            def write(self, data):
                owner.events.append(("write", key, len(data)))
                return super().write(data)

            def flush(self):
                owner.events.append(("flush", key))
                if writable and not self.closed:
                    owner.files[key] = self.getvalue()
                return super().flush()

            def close(self):
                if not self.closed:
                    if writable:
                        owner.files[key] = self.getvalue()
                    owner.events.append(("close", key))
                super().close()

        handle = Stream(initial)
        if "a" in mode:
            handle.seek(0, io.SEEK_END)
        self.handles[fd] = (key, handle)
        self.events.append(("open", key, mode))
        if "b" in mode:
            return handle
        return io.TextIOWrapper(handle, encoding=kwargs.get("encoding") or "utf-8",
                                errors=kwargs.get("errors"), newline=kwargs.get("newline"))

    def __enter__(self):
        self.original_open = builtins.open
        original_stat, original_lstat = os.stat, os.lstat
        original_resolve, original_iterdir = Path.resolve, Path.iterdir
        original_glob, original_rglob = Path.glob, Path.rglob
        original_openfd = os.open
        original_mkdir, original_fsync = os.mkdir, os.fsync
        original_fstat, original_close = os.fstat, os.close
        original_fdopen = os.fdopen
        owner = self

        def stat_file(path, *args, **kwargs):
            return owner._stat(path, **kwargs) if owner._virtual(path) else original_stat(path, *args, **kwargs)

        def lstat_file(path, *args, **kwargs):
            return owner._stat(path, follow_symlinks=False) if owner._virtual(path) else original_lstat(path, *args, **kwargs)

        def mkdir(path, mode=0o777, *, dir_fd=None):
            if not owner._virtual(path):
                return original_mkdir(path, mode, dir_fd=dir_fd)
            key = str(path)
            if key in owner.dirs or key in owner.files or key in owner.links:
                raise FileExistsError(key)
            if str(Path(key).parent) not in owner.dirs:
                raise FileNotFoundError(str(Path(key).parent))
            owner.dirs.add(key)
            owner.events.append(("mkdir", key))

        def resolve(path, strict=False):
            if not owner._virtual(path):
                return original_resolve(path, strict=strict)
            if strict:
                owner._stat(path)
            key = os.path.normpath(str(path))
            return Path(owner.links.get(key, key))

        def iterdir(path):
            if not owner._virtual(path):
                return original_iterdir(path)
            return iter(Path(key) for key in sorted(set(owner.files) | owner.dirs | set(owner.links))
                        if str(Path(key).parent) == str(path))

        def glob(path, pattern, **kwargs):
            if not owner._virtual(path):
                return original_glob(path, pattern, **kwargs)
            return iter(p for p in iterdir(path) if fnmatch.fnmatch(p.name, pattern))

        def rglob(path, pattern, **kwargs):
            if not owner._virtual(path):
                return original_rglob(path, pattern, **kwargs)
            return iter(Path(key) for key in sorted(owner.files) if key.startswith(str(path) + "/")
                        and fnmatch.fnmatch(Path(key).name, pattern))

        def fsync(fd):
            if fd not in owner.handles:
                return original_fsync(fd)
            key, handle = owner.handles[fd]
            if handle.closed:
                raise OSError("closed descriptor")
            owner.events.append(("fsync", key))

        def openfd(path, flags, mode=0o777, *, dir_fd=None):
            if not owner._virtual(path):
                return original_openfd(path, flags, mode, dir_fd=dir_fd)
            if flags & os.O_NOFOLLOW and str(path) in owner.links:
                raise OSError("synthetic no-follow open rejects link")
            mode_string = "xb" if flags & os.O_EXCL else "r+b" if flags & os.O_RDWR else "rb"
            return owner._open(path, mode_string).fileno()

        def fdopen(fd, mode="r", *args, **kwargs):
            if fd not in owner.handles:
                return original_fdopen(fd, mode, *args, **kwargs)
            handle = owner.handles[fd][1]
            return handle if "b" in mode else io.TextIOWrapper(handle, encoding=kwargs.get("encoding") or "utf-8")

        def fstat(fd):
            return owner._stat(owner.handles[fd][0]) if fd in owner.handles else original_fstat(fd)

        def close(fd):
            return owner.handles[fd][1].close() if fd in owner.handles else original_close(fd)

        for obj, name, replacement in (
            (builtins, "open", self._open), (io, "open", self._open),
            (os, "stat", stat_file), (os, "lstat", lstat_file), (os, "mkdir", mkdir),
            (os, "fsync", fsync), (os, "open", openfd), (os, "fdopen", fdopen),
            (os, "fstat", fstat), (os, "close", close), (Path, "resolve", resolve),
            (Path, "iterdir", iterdir), (Path, "glob", glob), (Path, "rglob", rglob),
        ):
            self.stack.enter_context(mock.patch.object(obj, name, replacement))
        return self

    def __exit__(self, *args):
        return self.stack.__exit__(*args)


def _identity():
    return {"schema_version": 1, **_reference(), "branch": BRANCH,
            "python": {"implementation": platform.python_implementation(), "version": platform.python_version(),
                       "executable": sys.executable},
            "file_hashes": {name: _digest((ROOT / name).read_bytes()) for name in SOURCES},
            "limits": copy.deepcopy(LIMITS)}


def _history_module_records():
    # Inert origin records only. No product source or test body is imported.
    records = {}
    for name, relative in (("music_app", "music_app/__init__.py"),
                           ("music_app.services", "music_app/services/__init__.py"),
                           ("music_app.services.foobar_history_projection", PRODUCT),
                           ("test_foobar_history_projection", HISTORY)):
        module = types.ModuleType(name)
        module.__file__ = str(ROOT / relative)
        module.__spec__ = types.SimpleNamespace(origin=module.__file__)
        records[name] = module
    return records


def _event():
    return {"action": "synchronize", "number": 17,
            "repository": {"full_name": REPOSITORY},
            "pull_request": {"number": 17, "state": "open", "draft": False,
                             "labels": [{"name": "run_reviews"}],
                             "head": {"sha": HEAD, "ref": BRANCH,
                                      "repo": {"full_name": REPOSITORY}}}}


def _record(argv):
    return {"argv": list(argv), "exit_code": 0, "timed_out": False,
            "cleanup_complete": True, "writer_errors": [], "cancelled": False,
            "started_at": "2026-10-21T00:00:00Z", "finished_at": "2026-10-21T00:00:01Z"}


def _process_success(record):
    # The pinned helper is a validator: None on success, ValueError on failure.
    if not isinstance(record, dict):
        raise ValueError("synthetic missing process record")
    if type(record.get("exit_code")) is not int or record["exit_code"] != 0:
        raise ValueError("synthetic nonzero or absent process exit")
    if record.get("timed_out") is not False or record.get("cleanup_complete") is not True:
        raise ValueError("synthetic interrupted or unsafe process")
    if record.get("writer_errors") != [] or record.get("cancelled", False):
        raise ValueError("synthetic writer failure or cancellation")


class HistoryEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.effects = []
        self.addCleanup(self.assertEqual, self.effects, [])

        def blocked(label):
            def call(*args, **kwargs):
                self.effects.append(label)
                raise AssertionError("forbidden effect: " + label)
            return call

        for obj, names in ((subprocess, ("Popen", "run", "call", "check_call", "check_output")),
                           (os, ("system", "popen", "kill", "killpg", "fork", "posix_spawn", "posix_spawnp",
                                 "mkdir", "fsync", "unlink", "remove", "rename", "replace", "rmdir", "chdir")),
                           (socket, ("socket", "create_connection", "getaddrinfo")),
                           (resource, ("setrlimit",)), (signal, ("signal", "setitimer"))):
            for name in names:
                if hasattr(obj, name):
                    self.stack.enter_context(mock.patch.object(obj, name, blocked(name)))
        original_import = builtins.__import__
        original_dynamic = importlib.import_module
        original_spec = importlib.util.spec_from_file_location
        original_open, original_io_open, original_openfd = builtins.open, io.open, os.open

        def guard(name):
            if name.split(".")[0] in ("music_app", "test_foobar_history_projection", "conftest",
                                       "pytest", "fastapi", "flask", "psycopg", "psycopg2"):
                blocked("product import " + name)()

        def guarded_import(name, *args, **kwargs):
            guard(name)
            return original_import(name, *args, **kwargs)

        def guarded_dynamic(name, *args, **kwargs):
            guard(name)
            return original_dynamic(name, *args, **kwargs)

        def guarded_spec(name, location, *args, **kwargs):
            guard(name)
            if str(location).endswith((PRODUCT, HISTORY)) or "/music_app/" in str(location):
                blocked("product spec " + str(location))()
            return original_spec(name, location, *args, **kwargs)

        def guarded_open(file, mode="r", *args, **kwargs):
            if any(char in mode for char in "wax+"):
                blocked("real file write")()
            return original_open(file, mode, *args, **kwargs)

        def guarded_io_open(file, mode="r", *args, **kwargs):
            if any(char in mode for char in "wax+"):
                blocked("real io file write")()
            return original_io_open(file, mode, *args, **kwargs)

        def guarded_openfd(path, flags, *args, **kwargs):
            if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
                blocked("real descriptor write")()
            return original_openfd(path, flags, *args, **kwargs)

        self.stack.enter_context(mock.patch.object(builtins, "__import__", guarded_import))
        self.stack.enter_context(mock.patch.object(importlib, "import_module", guarded_dynamic))
        self.stack.enter_context(mock.patch.object(importlib.util, "spec_from_file_location", guarded_spec))
        self.stack.enter_context(mock.patch.object(builtins, "open", guarded_open))
        self.stack.enter_context(mock.patch.object(io, "open", guarded_io_open))
        self.stack.enter_context(mock.patch.object(os, "open", guarded_openfd))
        self.stack.enter_context(mock.patch.object(sys, "dont_write_bytecode", True))
        spec = importlib.util.spec_from_file_location("history_evidence_control_subject", ROOT / ADAPTER)
        self.subject = importlib.util.module_from_spec(spec)
        self.stack.enter_context(mock.patch.dict(sys.modules, {spec.name: self.subject}))
        spec.loader.exec_module(self.subject)
        self.assertIsNone(self.subject.shared)

    def _document(self, result, raw, ids, **changes):
        values = dict(lane="controls", identity=_reference(), collected_ids=list(ids),
                      expected_ids=list(ids), result=result, raw_log=raw,
                      source_check={"ok": True, "modules": [], "unexpected": [], "errors": []})
        values.update(changes)
        return self.subject.result_document(**values)

    def _driver(self, *, record_change=None, admission_change=None, log_append=b"",
                git_head=HEAD, event_change=None, existing=False, attempt=2,
                document_change=None, output_change=None):
        fs = _MemoryFiles(existing=existing)
        event = _event()
        if event_change:
            event_change(event)
        fs.put(fs.event, event)
        admission = _admission()
        if admission_change:
            admission_change(admission)
        calls, records, limit_installs = [], [], []

        def install_limits():
            limit_installs.append(True)
            return copy.deepcopy(LIMITS)

        def run_owned(argv, *, cwd, env, log_path, timeout_seconds, terminate_grace_seconds=30):
            self.assertEqual(len(limit_installs), 1, "limits must precede all children and never reset driver CPU")
            phase = Path(log_path).stem
            calls.append({"name": phase, "argv": list(argv), "cwd": cwd, "env": dict(env),
                          "timeout": timeout_seconds, "grace": terminate_grace_seconds})
            record = _record(argv)
            fs.put(log_path, (git_head + "\n").encode() if phase == "git" else b"")
            if phase == "admission":
                fs.put(fs.output / "admission.json", admission)
            elif phase in ("controls", "history"):
                ids = CONTROL_IDS if phase == "controls" else HISTORY_IDS
                identity = {key: fs.get("identity.json")[key] for key in _reference()}
                document = _candidate(phase, identity, ids)
                if document_change:
                    document_change(phase, document)
                fs.put(log_path, _log(ids) + (log_append if phase == "controls" else b""))
                fs.put(fs.output / ("controls-result.json" if phase == "controls" else "result.json"), document)
                if phase == "history":
                    fs.put(fs.output / "collection.json", {"schema_version": 1, "lane": "history",
                           "identity": identity, "collected_ids": list(ids), "loader_errors": [], "modules": []})
            if record_change:
                record_change(phase, record)
            if output_change:
                output_change(phase, fs)
            records.append(copy.deepcopy(record))
            return record

        shared = types.SimpleNamespace(run_owned=mock.Mock(side_effect=run_owned),
                    process_success=mock.Mock(side_effect=_process_success),
                    verify_source_hashes=mock.Mock(return_value=None))
        with fs, mock.patch.object(self.subject, "shared", shared), \
                mock.patch.object(self.subject, "install_limits", side_effect=install_limits), \
                mock.patch.object(self.subject, "install_cancellation", return_value={"cancelled": False, "signal": None}), \
                mock.patch.object(sys, "stderr", io.StringIO()), mock.patch.object(sys, "stdout", io.StringIO()):
            code = self.subject.run_driver(ROOT, fs.output, fs.event, 801, attempt)
        return code, fs, calls, records, shared

    def test_exact_selection_and_source_guards(self):
        self.assertEqual(self.subject.expected_ids(ROOT, "controls"), list(CONTROL_IDS))
        self.assertEqual(self.subject.expected_ids(ROOT, "history"), list(HISTORY_IDS))
        self.assertEqual((ROOT / MANIFEST).read_bytes(), ("\n".join(HISTORY_IDS) + "\n").encode())
        self.assertEqual(len(HISTORY_IDS), 50)
        self.assertEqual(len(set(HISTORY_IDS)), 50)
        self.assertEqual(list(HISTORY_IDS), sorted(HISTORY_IDS))
        for invalid in ("driver", "other", "", "../history"):
            with self.subTest(invalid_lane=invalid), mock.patch.object(unittest, "TestLoader") as loader:
                with self.assertRaises(ValueError):
                    self.subject.expected_ids(ROOT, invalid)
                with self.assertRaises(ValueError):
                    self.subject.discover_suite(ROOT, invalid)
                loader.assert_not_called()
        for lane, pattern in (("controls", "test_foobar_history_evidence.py"),
                              ("history", "test_foobar_history_projection.py")):
            with self.subTest(lane=lane):
                first, second = _case(name="test_alpha"), _case(name="test_beta")
                inner = unittest.TestSuite([second])
                suite = unittest.TestSuite([first, inner])
                errors = ["synthetic import failure"]
                loader = types.SimpleNamespace(errors=errors, discover=mock.Mock(return_value=suite))
                with mock.patch.object(unittest, "TestLoader", return_value=loader), \
                        mock.patch.object(unittest, "TextTestRunner") as runner:
                    actual, ids, observed_errors = self.subject.discover_suite(ROOT, lane)
                self.assertIs(actual, suite)
                self.assertEqual(ids, ["synthetic_history_controls.SyntheticCase.test_alpha",
                                       "synthetic_history_controls.SyntheticCase.test_beta"])
                self.assertEqual(observed_errors, errors)
                self.assertIsNot(observed_errors, errors)
                self.assertEqual(list(suite), [first, inner])
                self.assertEqual(list(inner), [second])
                runner.assert_not_called()
                args, kwargs = loader.discover.call_args
                # Standard discover accepts positional start_dir; normalize only its call shape.
                bound = dict(zip(("start_dir", "pattern", "top_level_dir"), args)) | kwargs
                self.assertEqual(set(bound), {"start_dir", "pattern", "top_level_dir"})
                directory = ROOT / ("tests/ci" if lane == "controls" else "tests/py")
                self.assertEqual(Path(bound["start_dir"]), directory)
                self.assertEqual(Path(bound["top_level_dir"]), directory)
                self.assertEqual(bound["pattern"], pattern)
                self.assertEqual(loader.discover.call_count, 1)
        for relative, expected in (
            (PRODUCT, "adc4e167df34d80342e4bd1fa44207aae1e282b4b9c40e303ca5749559a28192"),
            (HISTORY, "37e6b1dad5067da86d1fe49015def1313d6d41f36a17cd0873a544c70dc0a724"),
            (HELPER, "8f45a3c1c3ada77a817928463527fb4add58f57f70a2d3f24cc9187cf5fb3673"),
        ):
            self.assertEqual(_digest((ROOT / relative).read_bytes()), expected)
        self.assertEqual((ROOT / "music_app/services/__init__.py").read_bytes(), b"")
        for relative, blob in (("music_app/__init__.py", "1953ff01479342f66c8ebf61a89f9682e2646ee9"),
                               (ADMISSION, "1c2fafe96e46f0bc044b124afb18a962b04303a6")):
            raw = (ROOT / relative).read_bytes()
            self.assertEqual(hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest(), blob)
        tree = ast.parse((ROOT / HISTORY).read_text(encoding="utf-8"))
        owners = [node for node in tree.body if isinstance(node, ast.ClassDef)
                  and node.name == "FoobarHistoryProjectionTests"]
        self.assertEqual(len(owners), 1)
        self.assertEqual([ast.unparse(base) for base in owners[0].bases], ["unittest.TestCase"])
        methods = [node for node in owners[0].body if isinstance(node, ast.FunctionDef)
                   and node.name.startswith("test_")]
        self.assertEqual(["test_foobar_history_projection.FoobarHistoryProjectionTests." + node.name
                          for node in sorted(methods, key=lambda item: item.name)], list(HISTORY_IDS))
        self.assertTrue(all(ast.get_docstring(node) is None for node in methods))
        self.assertFalse(any(isinstance(node, ast.FunctionDef) and node.name == "load_tests"
                             for node in ast.walk(tree)))
        own = ast.parse((ROOT / CONTROL).read_text(encoding="utf-8"))
        owner = next(node for node in own.body if isinstance(node, ast.ClassDef) and node.name == "HistoryEvidenceTests")
        authored = [node for node in owner.body if isinstance(node, ast.FunctionDef) and node.name.startswith("test_")]
        self.assertEqual(["test_foobar_history_evidence.HistoryEvidenceTests." + node.name
                          for node in sorted(authored, key=lambda item: item.name)], list(CONTROL_IDS))
        self.assertTrue(all(ast.get_docstring(node) is None for node in authored))

    def test_canonical_loading_boundaries(self):
        source = (ROOT / ADAPTER).read_text(encoding="utf-8")
        tree = ast.parse(source)
        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [item.name for item in node.names] if isinstance(node, ast.Import) else [node.module]
                self.assertTrue(all(name.split(".")[0] in sys.stdlib_module_names for name in names))
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)]
        for node in calls:
            name = ast.unparse(node.func)
            self.assertNotIn(name, ("exec", "eval", "compile", "types.ModuleType",
                                   "unittest.FunctionTestCase", "shared.write_json", "shared.run_lane",
                                   "shared.validate_identity", "shared.admission_chain"))
        self.assertFalse(any(isinstance(node, ast.ClassDef) and any(
            ast.unparse(base) in ("unittest.TestCase", "unittest.TestResult", "unittest.TextTestResult")
            for base in node.bases) for node in ast.walk(tree)))
        invalid_modules = [(name, "music_app/unexpected.py", "music_app/unexpected.py") for name in
                           ("music_app", "music_app.config", "music_app.services.foobar_history_projection",
                            "music_app.routes", "music_app.db", "music_app.services.foobar_snapshot_preview")]
        invalid_modules.extend((("test_foobar_history_evidence", CONTROL, "unexpected.py"),
                                ("test_foobar_history_evidence", "unexpected.py", CONTROL)))
        for unexpected, file, origin in invalid_modules:
            with self.subTest(unexpected=unexpected, file=file, origin=origin):
                fs = _MemoryFiles(existing=True)
                fs.put(fs.output / "identity.json", _identity())
                fake = types.ModuleType(unexpected)
                fake.__file__ = str(ROOT / file)
                fake.__spec__ = types.SimpleNamespace(origin=str(ROOT / origin))
                shared = types.SimpleNamespace(verify_source_hashes=mock.Mock(),
                                               run_owned=mock.Mock(), process_success=mock.Mock())
                synthetic = unittest.TestSuite([_case()])
                synthetic_ids = ["synthetic_history_controls.SyntheticCase.test_case"]
                with fs, mock.patch.object(self.subject, "shared", shared), \
                        mock.patch.dict(sys.modules, {unexpected: fake}), \
                        mock.patch.object(self.subject, "install_limits", return_value=copy.deepcopy(LIMITS)), \
                        mock.patch.object(signal, "signal"), mock.patch.object(signal, "setitimer"), \
                        mock.patch.object(sys, "stderr", io.StringIO()), mock.patch.object(sys, "stdout", io.StringIO()), \
                        mock.patch.object(self.subject, "expected_ids", return_value=synthetic_ids), \
                        mock.patch.object(self.subject, "discover_suite", return_value=(synthetic, synthetic_ids, [])), \
                        mock.patch.object(unittest, "TextTestRunner") as runner:
                    self.assertEqual(self.subject.run_suite(ROOT, fs.output, "controls"), 1)
                runner.assert_not_called()
                shared.run_owned.assert_not_called()
        # A new nested package can widen standard discovery even with a literal pattern.
        fs = _MemoryFiles(existing=True)
        fs.put(fs.output / "identity.json", _identity())
        original_glob, original_rglob, original_is_file = Path.glob, Path.rglob, Path.is_file
        nested = ROOT / "tests/ci/synthetic_nested/__init__.py"
        def guarded_glob(path, pattern, **kwargs):
            values = list(original_glob(path, pattern, **kwargs))
            if path == ROOT / "tests/ci" and ("__init__" in pattern or pattern in ("*", "**/*", "*.py", "**/*.py")):
                values.append(nested)
            return iter(values)
        def guarded_rglob(path, pattern, **kwargs):
            values = list(original_rglob(path, pattern, **kwargs))
            if path == ROOT / "tests/ci" and ("__init__" in pattern or pattern in ("*", "*.py")):
                values.append(nested)
            return iter(values)
        with fs, mock.patch.object(self.subject, "shared", types.SimpleNamespace(verify_source_hashes=mock.Mock())), \
                mock.patch.object(self.subject, "install_limits", return_value=copy.deepcopy(LIMITS)), \
                mock.patch.object(signal, "signal"), mock.patch.object(signal, "setitimer"), \
                mock.patch.object(Path, "glob", guarded_glob), mock.patch.object(Path, "rglob", guarded_rglob), \
                mock.patch.object(Path, "is_file", lambda path: True if path == nested else original_is_file(path)), \
                mock.patch.object(sys, "stderr", io.StringIO()), mock.patch.object(sys, "stdout", io.StringIO()), \
                mock.patch.object(self.subject, "discover_suite") as discover:
            self.assertEqual(self.subject.run_suite(ROOT, fs.output, "controls"), 1)
        discover.assert_not_called()
        fs = _MemoryFiles(existing=True)
        fs.put(fs.output / "identity.json", _identity())
        shared = types.SimpleNamespace(verify_source_hashes=mock.Mock(side_effect=ValueError("stale source")))
        with fs, mock.patch.object(self.subject, "shared", shared), \
                mock.patch.object(self.subject, "install_limits", return_value=copy.deepcopy(LIMITS)), \
                mock.patch.object(signal, "signal"), mock.patch.object(signal, "setitimer"), \
                mock.patch.object(sys, "stderr", io.StringIO()), mock.patch.object(sys, "stdout", io.StringIO()), \
                mock.patch.object(self.subject, "discover_suite") as discover, \
                mock.patch.object(unittest, "TextTestRunner") as runner:
            self.assertEqual(self.subject.run_suite(ROOT, fs.output, "controls"), 1)
        shared.verify_source_hashes.assert_called()
        discover.assert_not_called()
        runner.assert_not_called()
        # A valid synthetic loader path must use the same suite and standard runner options.
        fs = _MemoryFiles(existing=True)
        fs.put(fs.output / "identity.json", _identity())
        fs.put(fs.output / "controls.log", b"")
        case = _case()
        suite = unittest.TestSuite([case])
        ids = ["synthetic_history_controls.SyntheticCase.test_case"]
        stream = io.StringIO()
        standard_runner = unittest.TextTestRunner
        shared = types.SimpleNamespace(verify_source_hashes=mock.Mock())
        observed = []
        def run(actual):
            self.assertIs(actual, suite)
            result = standard_runner(stream=stream, verbosity=2, failfast=False, buffer=False).run(actual)
            fs.put(fs.output / "controls.log", stream.getvalue().encode("utf-8"))
            observed.append(result)
            return result
        with fs, mock.patch.object(self.subject, "shared", shared), \
                mock.patch.object(self.subject, "install_limits", return_value=copy.deepcopy(LIMITS)), \
                mock.patch.object(signal, "signal"), mock.patch.object(signal, "setitimer"), \
                mock.patch.object(self.subject, "expected_ids", return_value=ids), \
                mock.patch.object(self.subject, "discover_suite", return_value=(suite, ids, [])) as discover, \
                mock.patch.object(unittest, "TextTestRunner", return_value=types.SimpleNamespace(run=run)) as factory, \
                mock.patch.object(sys, "stderr", stream), mock.patch.object(sys, "stdout", io.StringIO()):
            self.assertEqual(self.subject.run_suite(ROOT, fs.output, "controls"), 0)
        self.assertEqual(discover.call_count, 1)
        args, kwargs = discover.call_args
        self.assertEqual(dict(zip(("root", "lane"), args)) | kwargs, {"root": ROOT, "lane": "controls"})
        self.assertEqual(factory.call_count, 1)
        bound = inspect.signature(standard_runner).bind(*factory.call_args.args, **factory.call_args.kwargs)
        bound.apply_defaults()
        for key, expected in (("stream", stream), ("verbosity", 2), ("failfast", False),
                              ("buffer", False), ("descriptions", True), ("resultclass", None)):
            self.assertEqual(bound.arguments[key], expected)
        self.assertEqual(len(observed), 1)
        self.assertTrue(observed[0].wasSuccessful())
        self.assertIs(fs.get("controls-result.json")["candidate_pass"], True)

    def test_collection_identity_and_multiplicity(self):
        control_module = sys.modules["test_foobar_history_evidence"]
        ids = ["synthetic_history_controls.SyntheticCase.test_alpha",
               "synthetic_history_controls.SyntheticCase.test_beta"]
        # Fail before runner construction, not merely in the post-run serializer.
        invalid_discoveries = ((ids, ["synthetic loader error"]), ([], []), (ids[:1], []),
                               (ids + [ids[0]], []), (list(reversed(ids)), []),
                               (ids + ["unexpected.Case.test_extra"], []))
        for lane in ("controls", "history"):
            for actual_ids, loader_errors in invalid_discoveries:
                with self.subTest(pre_execution_lane=lane, ids=actual_ids, errors=loader_errors):
                    fs = _MemoryFiles(existing=True)
                    fs.put(fs.output / "identity.json", _identity())
                    suite = unittest.TestSuite([_case(name="test_alpha"), _case(name="test_beta")])
                    shared = types.SimpleNamespace(verify_source_hashes=mock.Mock())
                    records = _history_module_records() if lane == "history" else {}
                    with fs, mock.patch.object(self.subject, "shared", shared), \
                            mock.patch.dict(sys.modules, records), \
                            mock.patch.object(self.subject, "install_limits", return_value=copy.deepcopy(LIMITS)), \
                            mock.patch.object(signal, "signal"), mock.patch.object(signal, "setitimer"), \
                            mock.patch.object(self.subject, "expected_ids", return_value=ids), \
                            mock.patch.object(self.subject, "discover_suite", return_value=(suite, actual_ids, loader_errors)) as discover, \
                            mock.patch.object(unittest, "TextTestRunner") as runner, \
                            mock.patch.object(sys, "stderr", io.StringIO()), mock.patch.object(sys, "stdout", io.StringIO()):
                        if lane == "history":
                            self.assertIs(sys.modules.pop("test_foobar_history_evidence"), control_module)
                            self.assertNotIn("test_foobar_history_evidence", sys.modules)
                        self.assertEqual(self.subject.run_suite(ROOT, fs.output, lane), 1)
                    if lane == "history":
                        self.assertIs(sys.modules.get("test_foobar_history_evidence"), control_module)
                    discover.assert_called_once()
                    runner.assert_not_called()
                    self.assertEqual(suite.countTestCases(), 2)
        # Observe the history-only collection deadline with no real signal/timer.
        standard_runner = unittest.TextTestRunner
        for expired in (False, True):
            with self.subTest(collection_expired=expired):
                fs = _MemoryFiles(existing=True)
                fs.put(fs.output / "identity.json", _identity())
                fs.put(fs.output / "history.log", b"")
                suite = unittest.TestSuite([_case(name="test_alpha"), _case(name="test_beta")])
                stream, events, handlers = io.StringIO(), [], {}
                timer_state = {"seconds": 0, "expiry_called": False, "expiry_raised": False}
                previous_handler = lambda signum, frame: None

                def install_signal(signum, handler):
                    previous = handlers.get(signum, previous_handler)
                    handlers[signum] = handler
                    return previous

                def set_timer(which, seconds, interval=0):
                    events.append(("timer", which, seconds, interval))
                    previous = timer_state["seconds"]
                    timer_state["seconds"] = seconds
                    return previous, 0

                def discover(root, lane):
                    events.append(("discover", timer_state["seconds"]))
                    if expired:
                        timer_state["expiry_called"] = True
                        handler = handlers.get(signal.SIGALRM)
                        if callable(handler):
                            try:
                                handler(signal.SIGALRM, None)
                            except BaseException:
                                timer_state["expiry_raised"] = True
                                raise
                    return suite, ids, []

                def run(actual):
                    events.append(("run", timer_state["seconds"]))
                    self.assertIs(actual, suite)
                    result = standard_runner(stream=stream, verbosity=2, failfast=False, buffer=False).run(actual)
                    fs.put(fs.output / "history.log", stream.getvalue().encode("utf-8"))
                    return result

                with fs, mock.patch.object(self.subject, "shared", types.SimpleNamespace(verify_source_hashes=mock.Mock())), \
                        mock.patch.dict(sys.modules, _history_module_records()), \
                        mock.patch.object(self.subject, "install_limits", return_value=copy.deepcopy(LIMITS)), \
                        mock.patch.object(signal, "signal", side_effect=install_signal), \
                        mock.patch.object(signal, "getsignal", return_value=previous_handler), \
                        mock.patch.object(signal, "setitimer", side_effect=set_timer), \
                        mock.patch.object(self.subject, "expected_ids", return_value=ids), \
                        mock.patch.object(self.subject, "discover_suite", side_effect=discover) as discovery, \
                        mock.patch.object(unittest, "TextTestRunner", return_value=types.SimpleNamespace(run=run)) as runner, \
                        mock.patch.object(sys, "stderr", stream), mock.patch.object(sys, "stdout", io.StringIO()):
                    self.assertIs(sys.modules.pop("test_foobar_history_evidence"), control_module)
                    self.assertNotIn("test_foobar_history_evidence", sys.modules)
                    self.assertEqual(self.subject.run_suite(ROOT, fs.output, "history"), 1 if expired else 0)
                self.assertIs(sys.modules.get("test_foobar_history_evidence"), control_module)
                discovery.assert_called_once()
                self.assertEqual([event for event in events if event[0] == "timer"],
                                 [("timer", signal.ITIMER_REAL, 10, 0), ("timer", signal.ITIMER_REAL, 0, 0)])
                self.assertEqual([event for event in events if event[0] == "discover"], [("discover", 10)])
                self.assertEqual(timer_state, {"seconds": 0, "expiry_called": expired, "expiry_raised": expired})
                if expired:
                    runner.assert_not_called()
                    self.assertEqual(suite.countTestCases(), 2)
                else:
                    runner.assert_called_once()
                    self.assertEqual([event for event in events if event[0] == "run"], [("run", 0)])
                    self.assertIs(fs.get("result.json")["candidate_pass"], True)
        cases = [_case(name="test_alpha"), _case(name="test_beta")]
        stream = io.StringIO()
        result = unittest.TextTestRunner(stream=stream, verbosity=2, failfast=False,
                                        buffer=False).run(unittest.TestSuite(cases))
        raw = stream.getvalue().encode()
        passing = self._document(result, raw, ids)
        self.assertIs(passing["candidate_pass"], True)
        for collected in ([], ids[:1], ids + [ids[0]], list(reversed(ids)), ids + ["unexpected.Case.test_extra"]):
            with self.subTest(collected=collected):
                actual = self._document(result, raw, ids, collected_ids=collected)
                self.assertIs(actual["candidate_pass"], False)
                self.assertEqual(actual["collected_ids"], collected)
        for expected in ([], ids[:1], ids + [ids[0]], list(reversed(ids))):
            with self.subTest(expected=expected):
                self.assertIs(self._document(result, raw, ids, expected_ids=expected)["candidate_pass"], False)
        lines = raw.splitlines(keepends=True)
        for damaged in (b"".join(lines[1:]), lines[0] + raw, lines[1] + lines[0] + b"".join(lines[2:]),
                        raw + b"Ran 2 tests in 0.001s\n", raw.replace(b"Ran 2 tests", b"Ran 1 test"),
                        raw.replace(b"Ran 2 tests", b"Prefix Ran 2 tests"),
                        raw.replace(b" ... ok", b" ... OK", 1),
                        raw.replace(b" ... ok", b" ... skipped not-a-quoted-reason", 1),
                        raw.replace(b" ... ok", b" ... skipped 'reason' trailing", 1),
                        raw.replace(b"test_alpha (", b"test_wrong (", 1),
                        raw + b"test_extra (unexpected.Case.test_extra) ... ok\n"):
            with self.subTest(raw=damaged):
                self.assertIs(self._document(result, damaged, ids)["candidate_pass"], False)
        repeated = self.subject.parse_outcomes(lines[0] + raw)
        self.assertEqual([row["id"] for row in repeated["outcomes"]], [ids[0], *ids])
        self.assertEqual(repeated["summary_counts"], [2])
        malformed = b"  test_alpha (synthetic_history_controls.SyntheticCase.test_alpha) (x=1) ... FAIL\n"
        unfinished = b"test_alpha (synthetic_history_controls.SyntheticCase.test_alpha) ... \n"
        parsed = self.subject.parse_outcomes(malformed + unfinished)
        self.assertEqual(parsed["outcomes"], [])
        self.assertEqual(parsed["unparsed_outcome_lines"], (malformed + unfinished).decode().splitlines())
        for raw_invalid in (b"\xff", b"x" * (LIMIT + 1)):
            with self.subTest(invalid_size=len(raw_invalid)), self.assertRaises((ValueError, UnicodeError)):
                self.subject.parse_outcomes(raw_invalid)

    def test_standard_result_and_subtest_accounting(self):
        fields = {"schema_version", "lane", "identity", "collected_ids", "expected_ids", "testsRun",
                  "errors", "failures", "skipped", "expectedFailures", "unexpectedSuccesses", "shouldStop",
                  "wasSuccessful", "outcomes", "summary_counts", "unparsed_outcome_lines", "log",
                  "source_check", "candidate_pass"}
        outcomes = {"ok": "ok", "failure": "FAIL", "error": "ERROR", "skip": "skipped",
                    "expected": "expected failure", "unexpected": "unexpected success"}
        for mode in (*outcomes, "subtest-failure", "subtest-error", "subtest-skip"):
            with self.subTest(mode=mode):
                case, result, raw = _run_synthetic(mode)
                self.assertEqual(result.testsRun, 1)
                doc = self._document(result, raw, ["synthetic_history_controls.SyntheticCase.test_case"])
                self.assertEqual(set(doc), fields)
                self.assertEqual(doc["schema_version"], 1)
                self.assertEqual(doc["lane"], "controls")
                self.assertEqual(doc["identity"], _reference())
                self.assertEqual(doc["testsRun"], 1)
                self.assertIs(doc["wasSuccessful"], result.wasSuccessful())
                self.assertIs(doc["candidate_pass"], mode == "ok")
                self.assertEqual(doc["summary_counts"], [1])
                self.assertEqual(doc["log"], {"name": "controls.log", "size_bytes": len(raw), "sha256": _digest(raw)})
                for name in ("errors", "failures", "skipped", "expectedFailures"):
                    self.assertEqual(doc[name], [{"id": test.id(), "detail": detail}
                                                 for test, detail in getattr(result, name)])
                self.assertEqual(doc["unexpectedSuccesses"], [test.id() for test in result.unexpectedSuccesses])
                if mode in outcomes:
                    self.assertEqual(len(doc["outcomes"]), 1)
                    row = doc["outcomes"][0]
                    self.assertEqual(row["id"], case.id())
                    self.assertEqual(row["outcome"], outcomes[mode])
                    self.assertEqual(row["raw_line"], raw.decode().splitlines()[0])
                    self.assertEqual(doc["unparsed_outcome_lines"], [])
                else:
                    self.assertEqual(doc["outcomes"], [])
                    self.assertTrue(doc["unparsed_outcome_lines"])
                    name = {"subtest-failure": "failures", "subtest-error": "errors", "subtest-skip": "skipped"}[mode]
                    self.assertEqual(len(doc[name]), 1)
                    self.assertIn("(value=7)", doc[name][0]["id"])
                    self.assertNotEqual(doc[name][0]["id"], case.id())
        case, result, raw = _run_synthetic()
        result.stop()
        self.assertIs(self._document(result, raw, [case.id()])["candidate_pass"], False)
        self.assertIs(self._document(result, raw, [case.id()])["shouldStop"], True)
        result.shouldStop = False
        for check in ({"ok": False, "modules": [], "unexpected": [], "errors": ["changed source"]},
                      {"ok": False, "modules": [], "unexpected": ["music_app.db"], "errors": []}):
            self.assertIs(self._document(result, raw, [case.id()], source_check=check)["candidate_pass"], False)
        # Collected-but-unrun is not success, even though the standard empty result is successful.
        empty = unittest.TestResult()
        self.assertTrue(empty.wasSuccessful())
        self.assertIs(self._document(empty, b"", [case.id()])["candidate_pass"], False)

    def test_process_failure_and_cleanup(self):
        self.assertIsNone(_process_success(_record(["synthetic"])))
        without_optional_cancelled = _record(["synthetic"])
        del without_optional_cancelled["cancelled"]
        self.assertIsNone(_process_success(without_optional_cancelled))
        invalid_records = [None, {}, {**_record([]), "exit_code": False},
                           {**_record([]), "exit_code": 0.0}]
        invalid_records.extend({**_record([]), key: value} for key, value in (
            ("exit_code", 7), ("timed_out", True), ("cleanup_complete", False),
            ("cancelled", True), ("writer_errors", ["synthetic writer failure"])))
        for invalid in invalid_records:
            with self.subTest(mock_record=invalid), self.assertRaises(ValueError):
                _process_success(invalid)
        code, fs, calls, records, shared = self._driver()
        self.assertEqual(code, 0)
        self.assertEqual([call["name"] for call in calls], ["git", "admission", "controls", "history"])
        self.assertEqual(shared.run_owned.call_count, 4)
        self.assertGreaterEqual(shared.process_success.call_count, 4)
        shared.verify_source_hashes.assert_called()
        self.assertEqual([call["timeout"] for call in calls], [10, 75, 30, 60])
        self.assertEqual([call["grace"] for call in calls], [30] * 4)
        self.assertTrue(all(Path(call["cwd"]) == ROOT for call in calls))
        self.assertEqual(calls[0]["argv"], ["git", "rev-parse", "HEAD"])
        self.assertEqual(calls[1]["argv"], [sys.executable, "-I", "-S", "-B", str(ROOT / ADMISSION),
                         "--event", str(fs.event), "--attempt", "2", "--output", str(fs.output / "admission.json")])
        for call in calls[2:]:
            self.assertEqual(call["argv"], [sys.executable, "-I", "-S", "-B", str(ROOT / ADAPTER),
                             call["name"], "--root", str(ROOT), "--output", str(fs.output)])
        for call in calls:
            self.assertTrue(set(call["env"]).isdisjoint({"PYTHONPATH", "PYTHONHOME", "PYTEST_ADDOPTS",
                                                        "PYTEST_PLUGINS", "GITHUB_TOKEN", "GH_TOKEN"}))
        process = fs.get("process-records.json")
        self.assertEqual(set(process), {"schema_version", "identity", "limits", "cancelled", "phases", "finalization_errors"})
        self.assertEqual(process["identity"], _reference())
        self.assertEqual(process["limits"], LIMITS)
        self.assertEqual([phase["record"] for phase in process["phases"]], records)
        self.assertEqual([phase["closed_log_agrees"] for phase in process["phases"]], [None, None, True, True])
        self.assertEqual(process["finalization_errors"], [])
        self.assertIs(process["cancelled"], False)
        for phase in process["phases"]:
            self.assertEqual(set(phase), {"name", "record", "log", "result_sha256", "closed_log_agrees"})
            name = phase["name"] + ".log"
            raw = fs.files[str(fs.output / name)]
            self.assertEqual(phase["log"], {"name": name, "size_bytes": len(raw), "sha256": _digest(raw)})
            result_name = {"controls": "controls-result.json", "history": "result.json"}.get(phase["name"])
            self.assertEqual(phase["result_sha256"],
                             _digest(fs.files[str(fs.output / result_name)]) if result_name else None)
        for field, value in (("exit_code", 7), ("timed_out", True), ("cleanup_complete", False),
                             ("cancelled", True), ("writer_errors", ["synthetic fsync failure"])):
            for phase in ("git", "admission", "controls", "history"):
                with self.subTest(field=field, phase=phase):
                    def change(name, record):
                        if name == phase:
                            record[field] = value
                    failed, partial, attempted, actual_records, _ = self._driver(record_change=change)
                    self.assertEqual(failed, 1)
                    prefix = ["git", "admission", "controls", "history"][:1 + ["git", "admission", "controls", "history"].index(phase)]
                    self.assertEqual([call["name"] for call in attempted], prefix)
                    self.assertEqual([item["record"] for item in partial.get("process-records.json")["phases"]], actual_records)
                    written = [entry[1] for entry in partial.events if entry[0] == "open" and "x" in entry[2]]
                    self.assertEqual(written.count(str(partial.output / "process-records.json")), 1)
                    self.assertEqual(written.count(str(partial.output / "inventory.json")), 1)
                    self.assertEqual(written[-1], str(partial.output / "inventory.json"))
        # The child sees a valid prefix; the supervisor closes a longer final file.
        for suffix in (b"late stdout\n", b"Traceback (most recent call last):\nlate failure\n"):
            failed, partial, attempted, _, _ = self._driver(log_append=suffix)
            self.assertEqual(failed, 1)
            self.assertEqual([call["name"] for call in attempted], ["git", "admission", "controls"])
            self.assertIs(partial.get("process-records.json")["phases"][-1]["closed_log_agrees"], False)
        corruptions = (
            lambda data: data["identity"].update(head_sha="f" * 40),
            lambda data: data["log"].update(sha256="f" * 64),
            lambda data: data["log"].update(size_bytes=data["log"]["size_bytes"] - 1),
            lambda data: data["outcomes"][0].update(raw_line="altered terminal row"),
            lambda data: data.update(outcomes=data["outcomes"][:-1]),
            lambda data: data.update(summary_counts=[7]),
            lambda data: data.update(collected_ids=data["collected_ids"][:-1]),
            lambda data: data.update(candidate_pass=False),
        )
        for index, change in enumerate(corruptions):
            def corrupt(lane, data):
                if lane == "controls":
                    change(data)
            with self.subTest(corruption=index):
                failed, _, attempted, _, _ = self._driver(document_change=corrupt)
                self.assertEqual(failed, 1)
                self.assertEqual([call["name"] for call in attempted], ["git", "admission", "controls"])
        with mock.patch.object(signal, "signal") as install:
            state = self.subject.install_cancellation()
        self.assertEqual(state, {"cancelled": False, "signal": None})
        handlers = {call.args[0]: call.args[1] for call in install.call_args_list}
        self.assertEqual(set(handlers), {signal.SIGTERM, signal.SIGINT, signal.SIGXCPU})
        with self.assertRaises(KeyboardInterrupt):
            handlers[signal.SIGTERM](signal.SIGTERM, None)
        self.assertIs(state["cancelled"], True)
        self.assertEqual(state["signal"], signal.SIGTERM)
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGXCPU):
            handlers[signum](signum, None)
        self.assertEqual(state["signal"], signal.SIGTERM)

    def test_evidence_limits_and_fresh_paths(self):
        # Caught nonvirtual mutations must still reach setup's failure ledger.
        # These probes are expected controls of the guard, never real effects.
        before = list(self.effects)
        with _MemoryFiles(existing=True):
            for attempt in (lambda: builtins.open("/__forbidden_history_control__", "wb"),
                            lambda: io.open("/__forbidden_history_control__", "wb"),
                            lambda: os.open("/__forbidden_history_control__", os.O_WRONLY | os.O_CREAT),
                            lambda: os.mkdir("/__forbidden_history_control__"),
                            lambda: os.fsync(-1)):
                with self.assertRaises(AssertionError):
                    attempt()
        self.assertEqual(self.effects[len(before):], ["real file write", "real file write",
                                                      "real descriptor write", "mkdir", "fsync"])
        # Remove only the five explicitly asserted probe entries, not subject attempts.
        del self.effects[len(before):]
        self.assertEqual(self.effects, before)
        owners = {"driver": ("identity.json", "admission-context.json", "process-records.json", "inventory.json"),
                  "controls": ("controls-result.json",), "history": ("collection.json", "result.json")}
        value = {"z": "\u043f\u0440\u0438\u0432\u0435\u0442", "a": [1, True, None]}
        for lane, names in owners.items():
            for name in names:
                with self.subTest(lane=lane, name=name), _MemoryFiles(existing=True) as fs:
                    self.subject.write_document(fs.output, name, value, lane=lane)
                    path = str(fs.output / name)
                    self.assertEqual(fs.files[path], _json(value))
                    self.assertEqual(set(fs.files), {path})
                    operations = [entry[0] for entry in fs.events if entry[1] == path]
                    self.assertLess(operations.index("flush"), operations.index("fsync"))
                    self.assertLess(operations.index("fsync"), operations.index("close"))
                    with self.assertRaises((OSError, ValueError)):
                        self.subject.write_document(fs.output, name, value, lane=lane)
                    self.assertEqual(fs.files[path], _json(value))
        for lane in owners:
            forbidden = set(FILES) - set(owners[lane])
            forbidden.update(("../result.json", "/result.json", "extra.json", "result.json.writing-1"))
            for name in forbidden:
                with self.subTest(lane=lane, forbidden=name), _MemoryFiles(existing=True) as fs:
                    with self.assertRaises((OSError, ValueError)):
                        self.subject.write_document(fs.output, name, value, lane=lane)
                    self.assertEqual(fs.files, {})
        for value in ({"x": "a" * LIMIT}, {"x": float("nan")}, {"x": float("inf")}):
            with self.subTest(invalid=value.keys()), _MemoryFiles(existing=True) as fs:
                with self.assertRaises((OSError, ValueError)):
                    self.subject.write_document(fs.output, "result.json", value, lane="history")
                self.assertEqual(fs.files, {})
                self.assertFalse(any(event[0] == "open" for event in fs.events))
        exact = {"x": "a" * (LIMIT - len(_json({"x": ""})))}
        with _MemoryFiles(existing=True) as fs:
            self.subject.write_document(fs.output, "result.json", exact, lane="history")
            self.assertEqual(len(fs.files[str(fs.output / "result.json")]), LIMIT)
        with _MemoryFiles(existing=True) as fs, mock.patch.object(os, "fsync", side_effect=OSError("fsync failed")):
            with self.assertRaises(OSError):
                self.subject.write_document(fs.output, "result.json", {"synthetic": True}, lane="history")
            self.assertEqual(set(fs.files), {str(fs.output / "result.json")})
        for body, safe in ((_json(_admission()), True), (b"{\"decision\":", False),
                           (b"{}" + b" " * LIMIT, False), (b"\xff", False)):
            with self.subTest(size=len(body)), _MemoryFiles(existing=True) as fs:
                path = fs.output / "admission.json"
                fs.put(path, body)
                if safe:
                    self.assertEqual(self.subject.read_admission(fs.output), _admission())
                    self.assertIn(("fsync", str(path)), fs.events)
                else:
                    with self.assertRaises((OSError, ValueError, UnicodeError)):
                        self.subject.read_admission(fs.output)
                self.assertEqual(fs.files[str(path)], body)
                reads = [size for key, size in fs.read_requests if key == str(path)]
                self.assertTrue(all(0 <= size <= LIMIT + 1 for size in reads))
                self.assertLessEqual(sum(reads), LIMIT + 1)
                self.assertFalse(any(entry[0] == "write" for entry in fs.events))
        for unsafe in ("symlink", "directory", "missing"):
            with self.subTest(unsafe=unsafe), _MemoryFiles(existing=True) as fs:
                path = str(fs.output / "admission.json")
                if unsafe == "symlink":
                    target = str(fs.output / "readable-admission-target.json")
                    fs.put(target, _admission())
                    fs.links[path] = target
                    self.assertTrue(stat.S_ISREG(os.stat(path).st_mode))
                    self.assertTrue(stat.S_ISLNK(os.lstat(path).st_mode))
                    self.assertEqual(Path(path).resolve(), Path(target))
                    with open(path, "rb") as ordinary:
                        self.assertEqual(ordinary.read(), _json(_admission()))
                    with os.fdopen(os.open(path, os.O_RDONLY), "rb") as ordinary:
                        self.assertEqual(ordinary.read(), _json(_admission()))
                    with self.assertRaises(OSError):
                        os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                elif unsafe == "directory":
                    fs.dirs.add(path)
                with self.assertRaises((OSError, ValueError)):
                    self.subject.read_admission(fs.output)
        failed, _, calls, _, _ = self._driver(existing=True)
        self.assertEqual(failed, 1)
        self.assertEqual(calls, [])
        code, fs, _, _, _ = self._driver()
        self.assertEqual(code, 0)
        inventory = fs.get("inventory.json")
        self.assertEqual(set(inventory), {"schema_version", "identity", "files", "missing", "complete"})
        self.assertEqual(inventory["files"], [{"name": name, "size_bytes": len(fs.files[str(fs.output / name)]),
                          "sha256": _digest(fs.files[str(fs.output / name)])}
                         for name in FILES if name != "inventory.json"])
        self.assertEqual(inventory["missing"], [])
        self.assertIs(inventory["complete"], True)
        self.assertEqual(sorted(Path(path).name for path in fs.files if Path(path).parent == fs.output), list(FILES))
        self.assertTrue(all(len(data) <= LIMIT for path, data in fs.files.items() if Path(path).parent == fs.output))
        for unsafe in ("unknown", "oversize", "symlink"):
            def change(phase, evidence):
                if phase == "history":
                    if unsafe == "unknown":
                        evidence.put(evidence.output / "unexpected.json", {})
                    elif unsafe == "oversize":
                        evidence.put(evidence.output / "history.log", b"x" * (LIMIT + 1))
                    else:
                        path = str(evidence.output / "history.log")
                        target = str(evidence.base / "readable-history-target.log")
                        evidence.put(target, evidence.files.pop(path))
                        evidence.links[path] = target
            with self.subTest(finalization=unsafe):
                failed, _, _, _, _ = self._driver(output_change=change)
                self.assertEqual(failed, 1)

    def test_native_admission_identity_and_hold(self):
        code, fs, calls, _, _ = self._driver()
        self.assertEqual(code, 0)
        identity = fs.get("identity.json")
        self.assertEqual(set(identity), {"schema_version", "repository", "branch", "head_sha", "pr_number",
                                        "run_id", "attempt", "python", "file_hashes", "limits"})
        self.assertEqual(set(identity["file_hashes"]), set(SOURCES))
        self.assertEqual(identity["file_hashes"], _identity()["file_hashes"])
        self.assertEqual(identity["limits"], LIMITS)
        self.assertEqual({key: identity[key] for key in _reference()}, _reference())
        context = fs.get("admission-context.json")
        self.assertEqual(context, {"schema_version": 1, "identity": _reference(),
            "admission_sha256": _digest(fs.files[str(fs.output / "admission.json")]),
            "decision": "admit", "reason_codes": [],
            "native": {key: _admission()["native"][key] for key in
                       ("id", "run_number", "attempt", "head_sha", "status", "conclusion")}})
        mutations = (
            ("hold", lambda data: data.update(decision="hold", reason_codes=["native-not-ready"])),
            ("reason", lambda data: data.update(reason_codes=["initial-attempt"])),
            ("head", lambda data: data["current"].update(head_sha="f" * 40)),
            ("repository", lambda data: data["current"].update(repository="other/repo")),
            ("branch", lambda data: data["current"].update(branch="main")),
            ("pr", lambda data: data["current"].update(number=18)),
            ("draft", lambda data: data["current"].update(draft=True)),
            ("labels", lambda data: data["current"].update(control_labels=["skip_tests"])),
            ("native-active", lambda data: data["native"].update(status="in_progress", conclusion=None)),
            ("native-cancelled", lambda data: data["native"].update(conclusion="cancelled")),
            ("native-head", lambda data: data["native"].update(head_sha="f" * 40)),
            ("native-attempt", lambda data: data["native"].update(attempt=0)),
            ("no-native", lambda data: data.update(native=None)),
        )
        for name, mutation in mutations:
            with self.subTest(mutation=name):
                code, fs, calls, _, _ = self._driver(admission_change=mutation)
                self.assertEqual(code, 1)
                self.assertEqual([call["name"] for call in calls], ["git", "admission"])
                self.assertNotIn(str(fs.output / "controls-result.json"), fs.files)
                self.assertNotIn(str(fs.output / "result.json"), fs.files)
        code, _, calls, _, _ = self._driver(attempt=1, admission_change=lambda data: data.update(
            decision="hold", reason_codes=["initial-attempt"]))
        self.assertEqual(code, 1)
        self.assertNotIn("controls", [call["name"] for call in calls])
        code, _, calls, _, _ = self._driver(git_head="f" * 40)
        self.assertEqual(code, 1)
        self.assertEqual([call["name"] for call in calls], ["git"])
        root, output, event = str(ROOT), str(_MemoryFiles.output), str(_MemoryFiles.event)
        valid = ["driver", "--root", root, "--output", output, "--event", event,
                 "--run-id", "801", "--attempt", "2"]
        invalid = ([], ["unknown"], valid + ["--attempt", "2"], valid + ["--extra", "x"],
                   valid[:-2], valid[:-1] + ["0"], valid[:-1] + ["-1"], valid[:-1] + ["1.5"],
                   ["driver", "--root", "relative", *valid[3:]],
                   ["controls", "--root", root, "--output", output, "--event", event],
                   ["history", "--root", root, "--output", output, "--manifest", MANIFEST])
        with mock.patch.object(self.subject, "run_driver", return_value=1) as driver, \
                mock.patch.object(self.subject, "run_suite", return_value=1) as suite, \
                mock.patch.object(sys, "stderr", io.StringIO()):
            for argv in invalid:
                with self.subTest(argv=argv):
                    self.assertEqual(self.subject.main(argv), 2)
            driver.assert_not_called()
            suite.assert_not_called()
            self.assertEqual(self.subject.main(valid), 1)
            self.assertEqual(driver.call_count, 1)
            args, kwargs = driver.call_args
            self.assertEqual(dict(zip(("root", "output", "event", "run_id", "attempt"), args)) | kwargs,
                             {"root": ROOT, "output": _MemoryFiles.output, "event": _MemoryFiles.event,
                              "run_id": 801, "attempt": 2})
            for lane in ("controls", "history"):
                self.assertEqual(self.subject.main([lane, "--root", root, "--output", output]), 1)
                args, kwargs = suite.call_args
                self.assertEqual(dict(zip(("root", "output", "lane"), args)) | kwargs,
                                 {"root": ROOT, "output": _MemoryFiles.output, "lane": lane})

        # Draft is identity, not a readiness gate. Preserve both Boolean values
        # before passing the unchanged native admission owner its real event.
        def event_draft(data, value):
            data["pull_request"]["draft"] = value

        def admission_draft(data, value):
            data["trigger"]["draft"] = value
            data["current"]["draft"] = value

        for draft in (False, True):
            with self.subTest(draft_context=draft):
                event_value = _event()
                event_draft(event_value, draft)
                before = copy.deepcopy(event_value)
                expected = copy.deepcopy(_admission()["trigger"])
                expected["draft"] = draft
                observed = self.subject._event_context(event_value)
                self.assertEqual(observed, expected)
                self.assertIs(observed["draft"], draft)
                self.assertEqual(event_value, before)
                code, fs, calls, _, _ = self._driver(
                    event_change=lambda data: event_draft(data, draft),
                    admission_change=lambda data: admission_draft(data, draft))
                self.assertEqual(code, 0)
                self.assertEqual([call["name"] for call in calls], ["git", "admission", "controls", "history"])
                self.assertIs(fs.get("admission.json")["trigger"]["draft"], draft)
                self.assertIs(fs.get("admission.json")["current"]["draft"], draft)
                self.assertTrue(fs.get("inventory.json")["complete"])

        missing_draft = object()
        for label, value in (("missing", missing_draft), ("null", None), ("zero", 0), ("one", 1),
                             ("false-string", "false"), ("true-string", "true"), ("list", []), ("mapping", {})):
            def malformed_draft(data):
                if value is missing_draft:
                    del data["pull_request"]["draft"]
                else:
                    event_draft(data, value)
            with self.subTest(malformed_draft=label):
                code, fs, calls, _, shared = self._driver(event_change=malformed_draft)
                self.assertEqual(code, 1)
                self.assertEqual(calls, [])
                shared.run_owned.assert_not_called()
                self.assertIsNone(fs.get("process-records.json")["identity"])
                self.assertEqual(fs.get("process-records.json")["phases"], [])
                for name in ("identity.json", "git.log", "admission.json", "controls-result.json", "result.json"):
                    self.assertNotIn(str(fs.output / name), fs.files)

        # The original false-event/current-true rejection above is unchanged.
        # Add the other view/direction combinations rather than replacing it.
        for draft, view in ((False, "trigger"), (True, "trigger"), (True, "current")):
            def mismatch_draft(data):
                admission_draft(data, draft)
                data[view]["draft"] = not draft
            with self.subTest(draft_identity_change=(draft, view)):
                code, fs, calls, _, _ = self._driver(
                    event_change=lambda data: event_draft(data, draft), admission_change=mismatch_draft)
                self.assertEqual(code, 1)
                self.assertEqual([call["name"] for call in calls], ["git", "admission"])
                self.assertNotIn(str(fs.output / "controls-result.json"), fs.files)
                self.assertNotIn(str(fs.output / "result.json"), fs.files)

        for draft in (False, True):
            def initial_hold(data):
                data["trigger"]["draft"] = draft
                data.update(decision="hold", reason_codes=["initial-attempt"],
                            current=None, native=None, inspected=[])
            def hold_exit(phase, record):
                if phase == "admission":
                    record["exit_code"] = 1
            with self.subTest(initial_draft=draft), mock.patch.object(
                    _MemoryFiles, "output", _MemoryFiles.base / "foobar-history-801-1"):
                code, fs, calls, records, _ = self._driver(attempt=1,
                    event_change=lambda data: event_draft(data, draft),
                    admission_change=initial_hold, record_change=hold_exit)
                self.assertEqual(code, 1)
                self.assertEqual(fs.output.name, "foobar-history-801-1")
                self.assertEqual([call["name"] for call in calls], ["git", "admission"])
                self.assertEqual([record["exit_code"] for record in records], [0, 1])
                held = fs.get("admission.json")
                self.assertIs(held["trigger"]["draft"], draft)
                self.assertEqual(held["decision"], "hold")
                self.assertEqual(held["reason_codes"], ["initial-attempt"])
                self.assertIsNone(held["current"])
                self.assertIsNone(held["native"])
                self.assertEqual(held["inspected"], [])
                expected_reference = {**_reference(), "attempt": 1}
                recorded = fs.get("process-records.json")
                self.assertEqual(recorded["identity"], expected_reference)
                self.assertEqual([phase["name"] for phase in recorded["phases"]], ["git", "admission"])
                self.assertEqual(recorded["phases"][-1]["record"]["exit_code"], 1)
                self.assertEqual(recorded["phases"][-1]["log"],
                                 {"name": "admission.log", "size_bytes": 0, "sha256": _digest(b"")})
                inventory = fs.get("inventory.json")
                self.assertEqual(inventory["identity"], expected_reference)
                self.assertFalse(inventory["complete"])
                self.assertIn("admission.json", [entry["name"] for entry in inventory["files"]])
                for name in ("controls.log", "controls-result.json", "history.log", "collection.json", "result.json"):
                    self.assertNotIn(str(fs.output / name), fs.files)
                    self.assertIn(name, inventory["missing"])

    def test_workflow_and_budget_contract(self):
        def assert_workflow(text):
            # Concrete workflow checks only; no general-purpose YAML parser or new dependency.
            clean = "\n".join(line.split("#", 1)[0].rstrip() for line in text.splitlines())
            clean = re.sub(r"(?m)^(\s*(?:-\s+)?)[\"']([a-z-]+)[\"']:", r"\1\2:", clean)
            text = clean
            top_keys = re.findall(r"(?m)^['\"]?([a-z_-]+)['\"]?:", clean)
            self.assertCountEqual(top_keys, ["name", "on", "permissions", "concurrency", "jobs"])
            self.assertRegex(text, r"(?m)^name:\s*['\"]?Foobar History Backend Evidence \(supplemental\)['\"]?\s*$")
            self.assertRegex(text, r"(?m)^\s{2}history:\s*$")
            self.assertEqual(len(re.findall(r"(?m)^\s{2}[A-Za-z_][\w-]*:\s*$", text.split("jobs:", 1)[1])), 1)
            self.assertRegex(text, r"(?m)^\s+name:\s*Foobar History Evidence\s*$")
            self.assertRegex(text, r"(?m)^\s+runs-on:\s*ubuntu-24\.04\s*$")
            self.assertRegex(text, r"(?m)^\s{4}timeout-minutes:\s*20\s*$")
            events_block = re.search(r"(?ms)^['\"]?on['\"]?:\s*\n(.*?)(?=^\S)", clean).group(1)
            self.assertEqual(re.findall(r"[a-z_]+", events_block),
                             ["pull_request", "types", "opened", "synchronize", "reopened", "ready_for_review", "labeled", "unlabeled"])
            permissions_block = re.search(r"(?ms)^permissions:\s*\n(.*?)(?=^\S)", clean).group(1)
            self.assertEqual(re.findall(r"[a-z_-]+", permissions_block), ["contents", "read"])
            self.assertRegex(text, r"(?m)^\s+contents:\s*read\s*$")
            self.assertIn("foobar-history-evidence-${{ github.event.pull_request.number }}", text)
            self.assertRegex(text, r"(?m)^\s+group:\s*['\"]?foobar-history-evidence-\$\{\{ github\.event\.pull_request\.number \}\}['\"]?\s*$")
            self.assertRegex(text, r"(?m)^\s+cancel-in-progress:\s*true\s*$")
            steps_text = text.split("steps:", 1)[1]
            starts = list(re.finditer(r"(?m)^( +)- (?=\w)", steps_text))
            indentation = min(len(match.group(1)) for match in starts)
            starts = [match.start() for match in starts if len(match.group(1)) == indentation]
            self.assertEqual(len(starts), 4)
            steps = [steps_text[start:end] for start, end in zip(starts, starts[1:] + [len(steps_text)])]
            self.assertEqual([ref.strip("'\"") for ref in re.findall(r"uses:\s*(\S+)", text)],
                             ["actions/checkout@v5", "actions/setup-python@v5", "actions/upload-artifact@v4"])
            self.assertEqual([int(value) for value in re.findall(r"timeout-minutes:\s*(\d+)", text)], [20, 2, 5, 9, 3])
            self.assertIn("${{ github.event.pull_request.head.sha }}", text)
            self.assertIn("actions/checkout@v5", steps[0])
            self.assertRegex(steps[0], r"(?m)^\s+ref:\s*['\"]?\$\{\{ github\.event\.pull_request\.head\.sha \}\}['\"]?\s*$")
            self.assertRegex(steps[0], r"persist-credentials:\s*false")
            self.assertIn("actions/setup-python@v5", steps[1])
            self.assertRegex(steps[1], r"python-version:\s*['\"]3\.11['\"]")
            self.assertIn(ADAPTER, steps[2])
            self.assertNotIn("uses:", steps[2])
            self.assertIn("actions/upload-artifact@v4", steps[3])
            self.assertRegex(steps[3], r"if:\s*(?:\$\{\{\s*)?always\(\)(?:\s*\}\})?")
            self.assertRegex(steps[3], r"(?m)^\s+path:\s*['\"]?\$\{\{ runner\.temp \}\}/foobar-history-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}['\"]?\s*$")
            self.assertRegex(text, r"persist-credentials:\s*false")
            self.assertRegex(text, r"python-version:\s*['\"]3\.11['\"]")
            self.assertRegex(text, r"if:\s*(?:\$\{\{\s*)?always\(\)(?:\s*\}\})?")
            for key, value in (("if-no-files-found", "error"), ("overwrite", "false"), ("retention-days", "14")):
                self.assertRegex(text, key + r":\s*" + value + r"\b")
            self.assertIn("foobar-history-v1-${{ github.event.pull_request.head.sha }}-${{ github.run_id }}-${{ github.run_attempt }}", text)
            self.assertIn("foobar-history-${{ github.run_id }}-${{ github.run_attempt }}", text)
            self.assertRegex(text, r"python\s+-I\s+-S\s+-B\s+")
            self.assertIn(ADAPTER, text)
            for option in ("driver", "--root", "--output", "--event", "--run-id", "--attempt"):
                self.assertIn(option, text)
            for forbidden in ("workflow_dispatch", "pull_request_target", "schedule:", "cache:", "pip install",
                              "services:", "download-artifact", "secrets.", "matrix:", "continue-on-error"):
                self.assertNotIn(forbidden, text)
            # Only this four-step workflow is recognized, not arbitrary YAML.
            def fields(step):
                matches = list(re.finditer(r"(?m)^( +)with:\s*$", step))
                self.assertEqual(len(matches), 1)
                match = matches[0]
                indentation = len(match.group(1))
                rows = []
                for line in step[match.end():].splitlines():
                    if not line.strip():
                        continue
                    if len(line) - len(line.lstrip()) <= indentation:
                        break
                    field = re.fullmatch(r"\s+([a-z-]+):\s*(.*?)\s*", line)
                    self.assertIsNotNone(field)
                    rows.append(field.groups())
                self.assertEqual(len({key for key, value in rows}), len(rows))
                return {key: value[1:-1] if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'"
                        else value for key, value in rows}

            self.assertEqual(len(re.findall(r"(?m)^\s*(?:-\s+)?['\"]?permissions['\"]?:", text)), 1)
            self.assertEqual(len(re.findall(r"(?m)^\s*['\"]?contents['\"]?:", text)), 1)
            for key in ("runs-on", "group", "cancel-in-progress"):
                self.assertEqual(len(re.findall(r"(?m)^\s*" + key + ":", text)), 1)
            self.assertNotRegex(text, r"(?m)^\s*(?:-\s+)?(?:defaults|working-directory):")
            self.assertEqual(fields(steps[0]), {"ref": "${{ github.event.pull_request.head.sha }}",
                                               "persist-credentials": "false"})
            self.assertEqual(fields(steps[1]), {"python-version": "3.11"})
            self.assertEqual(fields(steps[3]), {
                "name": "foobar-history-v1-${{ github.event.pull_request.head.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
                "path": "${{ runner.temp }}/foobar-history-${{ github.run_id }}-${{ github.run_attempt }}",
                "if-no-files-found": "error", "overwrite": "false", "retention-days": "14"})
            conditions = re.findall(r"(?m)^\s*(?:-\s+)?if:\s*(.*?)\s*$", text)
            self.assertEqual(len(conditions), 1)
            self.assertIn(conditions[0], ("always()", "${{ always() }}"))
            self.assertEqual(len(re.findall(r"(?m)^\s*(?:-\s+)?run:", text)), 1)
            shells = re.findall(r"(?m)^\s*(?:-\s+)?shell:\s*(.*?)\s*$", text)
            self.assertIn(shells, ([], ["bash"]))
            run_matches = list(re.finditer(r"(?m)^( *)(?:- )?run:\s*([^\n]*)$", steps[2]))
            self.assertEqual(len(run_matches), 1)
            match = run_matches[0]
            value = match.group(2).strip()
            if value in ("|", "|-", "|+", ">", ">-", ">+"):
                rows = []
                for line in steps[2][match.end():].splitlines():
                    if not line.strip() and not rows:
                        continue
                    if line.strip() and len(line) - len(line.lstrip()) <= len(match.group(1)):
                        break
                    rows.append(line)
                while rows and not rows[-1].strip():
                    rows.pop()
                self.assertTrue(rows)
                self.assertTrue(all(line.strip() for line in rows))
                if value.startswith(">"):
                    self.assertEqual(len({len(line) - len(line.lstrip()) for line in rows}), 1)
                raw_run = "\n".join(rows)
                command = (" " if value.startswith(">") else "\n").join(line.strip() for line in rows)
            else:
                raw_run = value
                command = value
                if len(command) >= 2 and command[0] == command[-1] and command[0] in "\"'":
                    command = ast.literal_eval(command)
            command = command.replace("\\\n", "").strip()
            self.assertNotIn("\n", command)
            self.assertNotRegex(command, r"[;&|<>`]|\$\(")
            self.assertNotRegex(command, r"\\\$")
            # Expressions are interpolated before the shell; environment variables
            # must not be single-quoted. Only the exact runner bindings are allowed.
            substitutions = (
                ("GITHUB_WORKSPACE", "github.workspace", "__ROOT__"),
                ("RUNNER_TEMP", "runner.temp", "__TEMP__"),
                ("GITHUB_EVENT_PATH", "github.event_path", "__EVENT__"),
                ("GITHUB_RUN_ID", "github.run_id", "__RUN__"),
                ("GITHUB_RUN_ATTEMPT", "github.run_attempt", "__ATTEMPT__"),
            )
            for variable, expression, token in substitutions:
                self.assertNotIn(token, command)
                command = command.replace("${{ " + expression + " }}", token)
            for quoted in re.findall(r"'[^']*'", command):
                self.assertNotRegex(quoted, r"\$(?:[A-Z_]|\{[A-Z_])")
            for variable, expression, token in substitutions:
                command = re.sub(r"\$\{" + variable + r"\}|\$" + variable + r"\b", token, command)
            argv = shlex.split(command, posix=True)
            if len(argv) > 4 and argv[4] == "__ROOT__/" + ADAPTER:
                argv[4] = ADAPTER
            self.assertEqual(argv, ["python", "-I", "-S", "-B", ADAPTER, "driver",
                "--root", "__ROOT__", "--output", "__TEMP__/foobar-history-__RUN__-__ATTEMPT__",
                "--event", "__EVENT__", "--run-id", "__RUN__", "--attempt", "__ATTEMPT__"])
            return raw_run, text

        text = (ROOT / WORKFLOW).read_text(encoding="utf-8")
        raw_run, text = assert_workflow(text)
        echo_only = text.replace(raw_run, re.sub(r"\bpython\b", "echo python", raw_run, count=1), 1)
        write_all = re.sub(r"(?m)^( +)runs-on:", r"\1permissions: write-all\n\1runs-on:", text, count=1)
        self.assertNotEqual(echo_only, text)
        self.assertNotEqual(write_all, text)
        for mutation in (echo_only, write_all):
            with self.assertRaises(AssertionError):
                assert_workflow(mutation)
        resources = self.subject.resource
        observed = {}
        events = []
        def set_limit(name, pair):
            observed[name] = tuple(pair)
            events.append(("set", name, tuple(pair)))
        def get_limit(name):
            events.append(("get", name))
            return observed[name]
        with mock.patch.object(resources, "setrlimit", side_effect=set_limit) as setter, \
                mock.patch.object(resources, "getrlimit", side_effect=get_limit) as getter:
            self.assertEqual(self.subject.install_limits(), LIMITS)
        self.assertEqual(set(observed), {getattr(resources, name) for name in LIMITS})
        self.assertEqual(setter.call_count, 5)
        self.assertEqual(getter.call_count, 5)
        for name, pair in LIMITS.items():
            key = getattr(resources, name)
            self.assertEqual(observed[key], tuple(pair))
            self.assertLess(events.index(("set", key, tuple(pair))), events.index(("get", key)))
        with mock.patch.object(resources, "setrlimit"), \
                mock.patch.object(resources, "getrlimit", return_value=(0, 0)), self.assertRaises((OSError, ValueError, RuntimeError)):
            self.subject.install_limits()
        with mock.patch.object(resources, "setrlimit", side_effect=OSError("unsupported limit")), \
                self.assertRaises((OSError, ValueError, RuntimeError)):
            self.subject.install_limits()
        self.assertEqual(120 + 300 + 540 + 180 + 60, 1200)
        self.assertEqual(70 + 135 + 90 + 120 + 60 + 65, 540)
        self.assertEqual(5 * LIMITS["RLIMIT_CPU"][1], 150)
        self.assertEqual(2 * LIMITS["RLIMIT_AS"][1], 1073741824)
        self.assertEqual(len(FILES) * LIMIT, 12582912)
