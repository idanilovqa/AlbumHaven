"""An in-memory stand-in for the listen-history and Last.fm settings tables.

It answers the SQL the Last.fm retry pass and its routes run, at the
psycopg connection seam, so the real repository code executes and every
statement and transaction is counted.
"""
from __future__ import annotations

import contextlib
import copy
from types import SimpleNamespace

from music_app.services.lastfm import LASTFM_RECENT_TRACKS_PAGE_LIMIT, LastfmError, LastfmScrobble, LastfmSubmissionOutcome
from tests.py.bounded_interactions import CountingConnection, OperationCounts

ACCOUNT_ID = 7
LIBRARY_ID = 9
MEASURED = "rendered-pcm-v1"
_LEGACY_SOURCE = "runtime_listen_history_adapter"
_MEASURED_SOURCE = "rendered_local_listen_session"


def listen_entry(number: int, *, measured: bool = True, **changes) -> dict[str, object]:
    entry = {
        "id": f"listen-{number}",
        "artist": "Artist",
        "title": f"Song {number}",
        "album": "Album",
        "duration_seconds": 200,
        "started_at_unix": 1_700_000_000 + number,
        "scrobble_eligible": True,
        "scrobbled": False,
    }
    if measured:
        entry.update({"measurement_version": MEASURED, "device_id": "device", "session_id": f"session-{number}"})
    entry.update(changes)
    return entry


class _Rows:
    def __init__(self, rows=()):
        self._rows = list(rows)

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _LedgerConnection(CountingConnection):
    """Counts statements and passes connection settings through to the ledger."""

    def __setattr__(self, name, value):
        if name == "autocommit":
            setattr(self._connection, name, value)
        else:
            super().__setattr__(name, value)


class ScrobbleLedger:
    """Listen rows by id, connected Last.fm accounts, and a log of committed writes."""

    def __init__(self, counts: OperationCounts | None = None) -> None:
        self.counts = counts or OperationCounts()
        self.rows: dict[int, dict[str, object]] = {}
        self.sessions: dict[int, str] = {}
        self.autocommit = False
        self.in_transaction = False
        self.unknown: list[str] = []

    # Rows -------------------------------------------------------------
    def add(self, entry: dict[str, object], *, account_id: int = ACCOUNT_ID, library_id: int = LIBRARY_ID) -> int:
        row_id = len(self.rows) + 1
        measured = entry.get("measurement_version") == MEASURED
        self.rows[row_id] = {
            "id": row_id,
            "account_id": account_id,
            "library_id": library_id,
            "measurement_version": MEASURED if measured else None,
            "source_family": _MEASURED_SOURCE if measured else _LEGACY_SOURCE,
            "scrobble_status": "scrobbled" if entry.get("scrobbled") else "pending",
            "metadata": {"source_payload": copy.deepcopy(entry)},
        }
        return row_id

    def add_pending(self, count: int, *, account_id: int = ACCOUNT_ID, start: int = 0, **changes) -> None:
        for number in range(start, start + count):
            self.add(listen_entry(number, **changes), account_id=account_id)

    def entry(self, row_id: int) -> dict[str, object]:
        return self.rows[row_id]["metadata"]["source_payload"]

    def entries(self) -> list[dict[str, object]]:
        return [self.entry(row_id) for row_id in sorted(self.rows)]

    def connect(self, _database_url=None, **_options):
        return _LedgerConnection(self, self.counts)

    # Connection protocol ---------------------------------------------
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return None

    @contextlib.contextmanager
    def transaction(self):
        assert self.autocommit, "a retry pass commits each batch transaction on an autocommit connection"
        self.in_transaction = True
        try:
            yield
        finally:
            self.in_transaction = False
        self.counts.transactions += 1

    def execute(self, query, params=None):
        text = " ".join(str(query).split())
        if "pg_advisory_xact_lock" in text:
            assert self.in_transaction, "provider guards are taken inside the claim transaction"
            return _Rows()
        if "for update" in text and "id = any(%s)" in text:
            assert self.in_transaction
            return _Rows(copy.deepcopy(self.rows[row_id]) for row_id in sorted(params[0]) if row_id in self.rows)
        if "jsonb_to_recordset" in text:
            assert self.in_transaction, "listen results are written inside a transaction"
            for item in params[0]:
                row = self.rows[item["row_id"]]
                assert (row["account_id"], row["library_id"]) == (item["account_id"], item["library_id"])
                row["metadata"]["source_payload"] = copy.deepcopy(item["entry"])
                row["scrobble_status"] = item["scrobble_status"]
            return _Rows()
        if "measurement_version = 'rendered-pcm-v1'" in text:
            return _Rows(copy.deepcopy(row) for row in self._ordered()
                         if row["measurement_version"] == MEASURED and row["scrobble_status"] != "scrobbled")
        if "bootstrap_context" in text and "source_family in" in text:
            return _Rows(copy.deepcopy(row) for row in self._ordered() if row["measurement_version"] is None)
        if "integration.lastfm_settings s left join" in text:
            return _Rows(
                {"account_id": account_id, "provider_username": f"listener-{account_id}",
                 "session_key_encrypted": self.sessions[account_id], "settings_payload": {},
                 "timezone_name": None, "connected_at": "2026-11-16T00:00:00+00:00"}
                for account_id in params[0] if account_id in self.sessions
            )
        if "as has_sendable_scrobbles" in text:
            from music_app.services.listen_history import is_pending_scrobble_entry, is_unverified_scrobble_entry
            return _Rows([{"has_sendable_scrobbles": any(
                (is_pending_scrobble_entry(self.entry(row_id)) or is_unverified_scrobble_entry(self.entry(row_id)))
                and not self.entry(row_id).get("scrobble_reauthentication_required")
                and row["account_id"] in self.sessions
                for row_id, row in self.rows.items()
            )}])
        if "as local_playcount" in text:
            return _Rows([{"local_playcount": 0, "total_listening_seconds": 0.0}])
        if "with scoped as" in text:
            from music_app.services.listen_history import is_pending_scrobble_entry
            scoped = [self.entry(row_id) for row_id, row in self.rows.items()
                      if (row["account_id"], row["library_id"]) == tuple(params[:2])]
            return _Rows([{"scrobbled": sum(bool(entry.get("scrobbled")) for entry in scoped),
                           "pending": sum(is_pending_scrobble_entry(entry) for entry in scoped)}])
        self.unknown.append(text[:200])
        return _Rows()

    def _ordered(self):
        return (self.rows[row_id] for row_id in sorted(self.rows))


class FakeLastfm:
    """Answers `scrobble_tracks`, recording each call and the claim state Last.fm saw it in."""

    def __init__(self, ledger: ScrobbleLedger, answer=None) -> None:
        self.ledger = ledger
        self.calls: list[SimpleNamespace] = []
        self.answer = answer or (lambda payloads: [LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted")
                                                   for _payload in payloads])

    def __call__(self, _config, payloads, *, session):
        self.ledger.counts.provider_calls += 1
        self.calls.append(SimpleNamespace(
            tracks=[payload["track"] for payload in payloads],
            session_key=session.session_key,
            claimed_states={entry.get("scrobble_submission_state") for entry in self.ledger.entries()
                            if entry.get("title") in {payload["track"] for payload in payloads}},
        ))
        result = self.answer(payloads)
        if isinstance(result, BaseException):
            raise result
        return result


class FakeRecentTracks:
    """Answers `get_lastfm_scrobbles_between` from the account's scrobbles on Last.fm,
    recording each call's window and counting the scrobbles it returns as candidate rows."""

    def __init__(self, ledger: ScrobbleLedger) -> None:
        self.ledger = ledger
        self.scrobbles: list[LastfmScrobble] = []
        self.calls: list[SimpleNamespace] = []
        # Called with each call's record; an exception it returns is raised as Last.fm's answer.
        self.answer = None

    def __call__(self, _config, *, session, after, before, page=1):
        self.ledger.counts.provider_calls += 1
        call = SimpleNamespace(session_key=session.session_key, user=session.username,
                               after=after, before=before, page=page)
        self.calls.append(call)
        failure = self.answer(call) if self.answer is not None else None
        if isinstance(failure, BaseException):
            raise failure
        listed = sorted((scrobble for scrobble in self.scrobbles if after < scrobble.timestamp < before),
                        key=lambda scrobble: -scrobble.timestamp)
        size = LASTFM_RECENT_TRACKS_PAGE_LIMIT
        found = listed[(page - 1) * size:page * size]
        self.ledger.counts.candidate_rows += len(found)
        return found, -(-len(listed) // size)

    def lists(self, *entries) -> None:
        """Puts the scrobbles these listens send on Last.fm."""
        self.scrobbles.extend(LastfmScrobble(int(entry["started_at_unix"]), str(entry["artist"]),
                                             str(entry["title"])) for entry in entries)


def transient_failure(_payloads):
    return LastfmError("Service Offline (Last.fm error 11)", code=11, retryable=True)
