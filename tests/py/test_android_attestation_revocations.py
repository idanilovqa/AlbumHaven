"""Revocation rows: the one-time startup import and the attest contract. Database writes against a real
Postgres are tested in test_android_artifacts.py."""

import base64
import json
import secrets
import threading
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

from cryptography.hazmat.primitives import serialization

from music_app.services import android_key_attestation
from music_app.services.android_artifact_access import (
    ATTESTATION_STATUS_ENV,
    SIGNING_CERTIFICATES_ENV,
    AndroidArtifactAccess,
)
from music_app.services.android_attestation_revocations import BATCH_SIZE, import_status_list_on_startup
from tests.py.android_attestation_testing import NOW, SIGNER, AttestationPki, certificate
from tests.py.bounded_interactions import CountingConnection, OperationCounts, measure_scale_pair
from tests.py.filesystem_operation_counting import count_filesystem_and_media

CONFIG = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"}


class _Result:
    def __init__(self, row=None, rowcount=0):
        self._row, self.rowcount = row, rowcount
        self.description = None if row is None else ("row",)

    def fetchone(self):
        return self._row


class _Database:
    """Answers the statements the attestation and import code send; records every one."""

    def __init__(self, revoked=(), loaded=True):
        self.revoked, self.loaded, self.statements = set(revoked), loaded, []

    def connect(self, _url):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return None

    def execute(self, query, params=None):
        self.statements.append(" ".join(query.split()))
        if "exists(select 1 from app.android_attestation_revocation_sources" in query:
            return _Result({"loaded": self.loaded, "revoked": [s for s in params[0] if s in self.revoked]})
        if query.startswith("select 1 from app.android_attestation_revocation_sources"):
            return _Result({"loaded": 1} if self.loaded else None)
        if "delete from app.android_artifact_challenges" in query and "returning" in query:
            return _Result({"account_id": 1, "session_id": 1, "channel": "sandbox", "purpose": "attest",
                            "expires_at": NOW + timedelta(minutes=1)})
        if "insert into app.android_device_keys" in query:
            return _Result({"id": uuid4()})
        if "insert into app.android_attestation_revocations" in query:
            self.revoked.update(params[1])
        if "insert into app.android_attestation_revocation_sources" in query:
            self.loaded = True
        return _Result()


def _status_file(tmp_path, count):
    path = tmp_path / "status.json"
    path.write_text(json.dumps({"entries": {format(serial, "X"): {"reason": "KEY_COMPROMISE"}
                                            for serial in range(0x1000, 0x1000 + count)}}), encoding="utf-8")
    return str(path)


def test_startup_imports_a_never_loaded_list_in_batches_and_marks_it_loaded(tmp_path):
    database = _Database(loaded=False)
    environ = {ATTESTATION_STATUS_ENV: _status_file(tmp_path, BATCH_SIZE + 1)}
    assert import_status_list_on_startup(CONFIG, environ=environ, connect=database.connect) == "imported"
    assert len(database.revoked) == BATCH_SIZE + 1 and database.loaded
    assert sum("insert into app.android_attestation_revocations" in s for s in database.statements) == 2


def test_startup_with_a_loaded_list_reads_one_row_and_never_the_file(tmp_path, monkeypatch):
    database, counts = _Database(loaded=True), OperationCounts()
    environ = {ATTESTATION_STATUS_ENV: _status_file(tmp_path, 3)}
    with count_filesystem_and_media(monkeypatch, counts):
        status = import_status_list_on_startup(CONFIG, environ=environ, connect=database.connect)
    assert (status, counts.open_calls, len(database.statements)) == ("done", 0, 1)


def test_startup_leaves_an_unreadable_list_unloaded(tmp_path):
    database = _Database(loaded=False)
    environ = {ATTESTATION_STATUS_ENV: str(tmp_path / "absent.json")}
    assert import_status_list_on_startup(CONFIG, environ=environ, connect=database.connect) == "failed"
    assert not database.loaded and not database.revoked


def test_a_stopped_startup_import_is_not_marked_loaded(tmp_path):
    database, stop = _Database(loaded=False), threading.Event()
    stop.set()
    environ = {ATTESTATION_STATUS_ENV: _status_file(tmp_path, 3)}
    assert import_status_list_on_startup(CONFIG, environ=environ, connect=database.connect,
                                         stop_requested=stop) == "stopped"
    assert not database.loaded


def test_startup_skips_a_server_without_a_status_list():
    def no_database(_url):
        raise AssertionError("no status list means no database work")

    assert import_status_list_on_startup(CONFIG, environ={}, connect=no_database) == "skipped"


def test_attest_contract_reads_roots_once_and_revocations_with_one_keyed_select(tmp_path, monkeypatch, request):
    pki = AttestationPki()
    root = certificate("Test attestation root", pki.root_key, "Test attestation root", pki.root_key, ca=True)
    roots_pem = tmp_path / "roots.pem"
    roots_pem.write_bytes(root.public_bytes(serialization.Encoding.PEM))
    monkeypatch.setattr(android_key_attestation.load_root_public_keys.__wrapped__, "__defaults__", (roots_pem,))
    request.addfinalizer(android_key_attestation.load_root_public_keys.cache_clear)  # drop the test roots
    actor = SimpleNamespace(is_authenticated=True, account_id=1, session_id=1)
    environ = {SIGNING_CERTIFICATES_ENV["sandbox"]: SIGNER, ATTESTATION_STATUS_ENV: "configured"}

    def run(revoked_rows: int) -> OperationCounts:
        android_key_attestation.load_root_public_keys.cache_clear()
        counts = OperationCounts()
        database = _Database(revoked=(format(serial, "x") for serial in range(0x100000, 0x100000 + revoked_rows)))

        def connect(_url):
            counts.pool_leases += 1
            return CountingConnection(database, counts)

        access = AndroidArtifactAccess(CONFIG, {"hmac": {"secret": "0" * 32, "key_version": 1}},
                                       clock=lambda: NOW, connect=connect, environ=environ)
        with count_filesystem_and_media(monkeypatch, counts):
            for _ in range(2):  # the second attestation reuses the roots read by the first
                raw = secrets.token_bytes(32)
                chain, _ = pki.chain(raw)
                challenge = base64.urlsafe_b64encode(raw).decode().rstrip("=")
                result = access.attest(actor, "sandbox", challenge,
                                       [base64.b64encode(item).decode() for item in chain])
                assert result["securityLevel"] == "tee"
        return counts

    measure_scale_pair(
        interaction_id="py:routes/android_artifacts_asgi.py#android_artifact_attest",
        small=1,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 0, "open_calls": 1, "sql_statements": 8,
                 "returned_rows": 6, "pool_leases": 4},
        growth=("sql_statements", 0),
    )
