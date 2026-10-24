"""UNRUN: genuine adapter/guarded helper, mocked HTTP and durable write boundary.

No DB/lock/concurrency guarantee follows from this in-memory transport. Product
imports and collection require separate admission. No credentials are loaded.
"""
from copy import deepcopy
import json
from types import SimpleNamespace
import xml.etree.ElementTree as ET

import pytest

from music_app.services import lastfm
from music_app.services import lastfm_sync_bridge as bridge
from music_app.services.listen_history_postgres import _merge_scrobble_receipt

STAMP = 1760000000
ENTRY_ID = "a" * 64
SESSION = lastfm.LastfmSession("ExactProviderUser", "synthetic-key-never-persist", "2026-10-20T10:00:00+00:00")
PAYLOAD = {"artist": "Artist", "track": "Track", "album": "Album", "album_artist": "Album artist",
           "timestamp": STAMP, "track_number": "2", "duration": 240}


def response(*, accepted=1, ignored=0, timestamp=STAMP, artist="Artist", corrected="0", code="0", count=1):
    root = ET.Element("lfm", status="ok")
    scrobbles = ET.SubElement(root, "scrobbles", accepted=str(accepted), ignored=str(ignored))
    for _ in range(count):
        scrobble = ET.SubElement(scrobbles, "scrobble")
        for tag, value, correction in (("artist", artist, corrected), ("track", "Track", "0"),
                                      ("album", "Album", "0"), ("albumArtist", "Album artist", "0")):
            ET.SubElement(scrobble, tag, corrected=correction).text = value
        ET.SubElement(scrobble, "timestamp").text = str(timestamp)
        ET.SubElement(scrobble, "ignoredMessage", code=code).text = ""
    return root


def original_entry(**changes):
    return {"id": ENTRY_ID, "scrobbled": False, "scrobble_eligible": True,
            "scrobble_submission_state": "not_sent", "scrobble_retryable": True,
            "scrobble_retry_count": 0, **changes}


class DurableReceipt:
    def __init__(self, entry=None):
        self.entry = deepcopy(entry or original_entry())
        self.trace = []
        self.refuse_final = False
        self.strip_claim_identity = False
        self.after_claim = None

    def update(self, config, entry_id, updates, *, account_id, library_id):
        assert (entry_id, account_id, library_id) == (ENTRY_ID, 7, 9)
        self.trace.append(("write", deepcopy(updates)))
        if self.refuse_final and updates.get("scrobbled") is True:
            return None
        self.entry = _merge_scrobble_receipt(self.entry, deepcopy(updates), column_status="pending")
        if updates.get("scrobble_submission_state") == "attempting":
            if self.strip_claim_identity:
                self.entry.pop("scrobble_submission_identity", None)
            if self.after_claim:
                self.after_claim()
        return deepcopy(self.entry)


def run(receipt, *, session=SESSION, payload=None, provider=lastfm.scrobble_track, before=None, **kwargs):
    return bridge._submit_guarded_measured_scrobble({}, deepcopy(receipt.entry),
        deepcopy(PAYLOAD) if payload is None else payload, account_id=7, library_id=9,
        lastfm_session=session, update_listen_history_entry=receipt.update,
        scrobble_track=provider, before_provider=before, **kwargs)


def test_actual_provider_reply_is_bound_to_committed_exact_request(monkeypatch):
    receipt = DurableReceipt()
    payload = deepcopy(PAYLOAD)
    receipt.after_claim = lambda: payload.update(artist="Later mutable caller value")

    def post(config, method, params):
        assert method == "track.scrobble"
        assert params["artist"] == "Artist" and params["timestamp"] == STAMP
        assert params["sk"] == SESSION.session_key
        assert receipt.entry["scrobble_submission_state"] == "attempting"
        identity = receipt.entry["scrobble_submission_identity"]
        assert identity["request"]["artist"] == "Artist" and identity["reply"] is None
        receipt.trace.append(("provider", None))
        return response(artist="Corrected Artist", corrected="1")

    monkeypatch.setattr(lastfm, "_post_lastfm", post)
    stored, accepted, _, attempted = run(receipt, payload=payload)
    identity = stored["scrobble_submission_identity"]
    assert accepted is True and attempted is True
    assert (identity["account_id"], identity["library_id"], identity["occurrence_id"], identity["attempt"]) == (7, 9, ENTRY_ID, 1)
    assert identity["provider_username"] == SESSION.username
    assert identity["connection_started_at"] == SESSION.connected_at
    assert identity["request"] == {key: PAYLOAD[key] for key in ("artist", "track", "timestamp", "album", "album_artist", "track_number")}
    assert identity["reply"]["artist"] == "Corrected Artist"
    assert identity["reply"]["corrected"]["artist"] is True
    assert [item[0] for item in receipt.trace] == ["write", "provider", "write"]
    assert SESSION.session_key not in json.dumps(stored)
    assert "session_key" not in json.dumps(identity)


@pytest.mark.parametrize("changes", [
    {"timestamp": STAMP + 1}, {"count": 2}, {"count": 0}, {"accepted": 2},
    {"ignored": 1}, {"code": "1"}, {"artist": "Unmarked change"}, {"corrected": "true"},
])
def test_malformed_or_ambiguous_echo_is_not_correlation_evidence(monkeypatch, changes):
    monkeypatch.setattr(lastfm, "_post_lastfm", lambda *_args: response(**changes))
    outcome = lastfm.scrobble_track({}, PAYLOAD, session=SESSION)
    assert outcome.receipt_identity is None


def test_request_or_account_lineage_missing_stays_unbound(monkeypatch):
    monkeypatch.setattr(lastfm, "_post_lastfm", lambda *_args: response())
    receipt = DurableReceipt()
    old = lastfm.LastfmSession(SESSION.username, SESSION.session_key, "")
    stored, accepted, _, attempted = run(receipt, session=old)
    assert accepted is True and attempted is True
    assert stored["scrobble_submission_identity"] is None


@pytest.mark.parametrize("session", [
    lastfm.LastfmSession("OtherProviderUser", "other-synthetic-key", SESSION.connected_at),
    lastfm.LastfmSession(SESSION.username, "new-synthetic-key", "2026-10-21T10:00:00+00:00"),
])
def test_provider_account_or_reconnection_is_not_retroactively_relabelled(monkeypatch, session):
    monkeypatch.setattr(lastfm, "_post_lastfm", lambda *_args: response())
    first, second = DurableReceipt(), DurableReceipt()
    a = run(first)[0]["scrobble_submission_identity"]
    b = run(second, session=session)[0]["scrobble_submission_identity"]
    assert (a["provider_username"], a["connection_started_at"]) != (b["provider_username"], b["connection_started_at"])
    assert a["provider_username"] == SESSION.username and a["connection_started_at"] == SESSION.connected_at


def test_accepted_old_receipt_is_not_backfilled_from_current_connection():
    receipt = DurableReceipt(original_entry(scrobbled=True, scrobble_submission_state="accepted"))
    stored, accepted, _, attempted = run(receipt, provider=lambda *_args, **_kwargs: pytest.fail("No resend"))
    assert accepted is True and attempted is False
    assert "scrobble_submission_identity" not in stored
    assert receipt.trace == []


def test_postclaim_authority_denial_keeps_no_reply_and_does_not_send():
    receipt = DurableReceipt()
    stored, accepted, _, attempted = run(receipt, before=lambda: False,
        provider=lambda *_args, **_kwargs: pytest.fail("No send after authority denial"))
    assert accepted is False and attempted is False
    assert stored["scrobble_submission_state"] == "not_sent"
    assert stored["scrobble_submission_identity"]["reply"] is None
    assert stored["scrobble_retry_count"] == 1


def test_unexpected_transport_failure_keeps_committed_claim_not_an_ack():
    receipt = DurableReceipt()
    def fail(*_args, **_kwargs):
        raise RuntimeError("synthetic interrupted transport")
    with pytest.raises(RuntimeError):
        run(receipt, provider=fail)
    assert receipt.entry["scrobble_submission_state"] == "attempting"
    assert receipt.entry["scrobble_submission_identity"]["reply"] is None
    assert len(receipt.trace) == 1


def test_refused_final_write_cannot_return_unpersisted_reply(monkeypatch):
    monkeypatch.setattr(lastfm, "_post_lastfm", lambda *_args: response())
    receipt = DurableReceipt()
    receipt.refuse_final = True
    stored, accepted, _, attempted = run(receipt)
    assert attempted is True and accepted is False
    assert stored["scrobble_submission_state"] == "attempting"
    assert stored["scrobble_submission_identity"]["reply"] is None


def test_claim_without_expected_binding_never_dispatches():
    receipt = DurableReceipt()
    receipt.strip_claim_identity = True
    _, accepted, _, attempted = run(receipt, provider=lambda *_args, **_kwargs: pytest.fail("No unbound claim"))
    assert accepted is False and attempted is False
    assert len(receipt.trace) == 1


@pytest.mark.parametrize("reply", [{"secret": "must-not-persist"},
    {"artist": "Artist", "track": "Track", "album": "Album", "album_artist": "Album artist",
     "timestamp": STAMP + 1, "corrected": {"artist": False, "track": False, "album": False, "album_artist": False}}])
def test_alternate_callback_result_cannot_inject_unvalidated_identity(reply):
    receipt = DurableReceipt()
    outcome = lastfm.LastfmSubmissionOutcome(sent=True, accepted=1, receipt_identity=reply)
    stored, _, _, _ = run(receipt, provider=lambda *_args, **_kwargs: outcome)
    assert stored["scrobble_submission_identity"]["reply"] is None
    assert "must-not-persist" not in json.dumps(stored)


def test_retry_replaces_entire_binding_instead_of_mixing_old_account_reply(monkeypatch):
    monkeypatch.setattr(lastfm, "_post_lastfm", lambda *_args: response())
    receipt = DurableReceipt(original_entry(scrobble_retry_count=1,
        scrobble_submission_identity={"provider_username": "Old user", "reply": {"invalid": "old"}}))
    stored, accepted, _, _ = run(receipt, reauthenticated=True)
    assert accepted is True
    identity = stored["scrobble_submission_identity"]
    assert identity["attempt"] == 2 and identity["provider_username"] == SESSION.username
    assert "invalid" not in identity["reply"]


@pytest.mark.parametrize("malformation", [
    "missing_ignored", "negative_ignored", "padded_ignored", "padded_accepted",
    "duplicate_envelope", "missing_status", "unknown_status", "wrong_root",
    "nested_track", "nested_timestamp", "nested_message", "track_tail", "timestamp_tail",
])
def test_original_xml_envelope_and_flat_leaf_contract_are_required(monkeypatch, malformation):
    root = response()
    envelope = root.find("scrobbles")
    if malformation == "missing_ignored":
        del envelope.attrib["ignored"]
    elif malformation == "negative_ignored":
        envelope.set("ignored", "-1")
    elif malformation == "padded_ignored":
        envelope.set("ignored", " 0 ")
    elif malformation == "padded_accepted":
        envelope.set("accepted", "01")
    elif malformation == "duplicate_envelope":
        root.append(deepcopy(envelope))
    elif malformation == "missing_status":
        del root.attrib["status"]
    elif malformation == "unknown_status":
        root.set("status", "unknown")
    elif malformation == "wrong_root":
        root.tag = "untrusted_wrapper"
    elif malformation.startswith("nested_"):
        field = {"nested_track": "track", "nested_timestamp": "timestamp", "nested_message": "ignoredMessage"}[malformation]
        ET.SubElement(envelope.find("scrobble/" + field), "unexpected").text = "hidden extra value"
    else:
        field = "track" if malformation == "track_tail" else "timestamp"
        envelope.find("scrobble/" + field).tail = "unexplained extra value"
    monkeypatch.setattr(lastfm, "_post_lastfm", lambda *_args: root)
    outcome = lastfm.scrobble_track({}, PAYLOAD, session=SESSION)
    assert outcome.receipt_identity is None
