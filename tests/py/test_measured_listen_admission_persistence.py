"""Dormant admission persistence checkpoints, authored without execution.

The established scripted connection exercises real authority and pure admission
owners without sockets, config stubs, or application-module substitution. SQL
order, values and exceptional context exits are checked; these doubles do not
prove PostgreSQL rollback, concurrent locking or deployed decoder behavior.
"""
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import hashlib
import json
from types import SimpleNamespace

import pytest

from music_app.services import measured_listen_admission as admission
from music_app.services import measured_listen_admission_postgres as postgres
from music_app.services import measured_listen_evidence as evidence
from music_app.services import measured_listen_history as ordinary
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from tests.py.owned_playlist_testing import (
    ACCOUNT, LIBRARY, NOW, Connection, Step,
    authority_steps, context as actor_context,
)


URL = "postgresql://synthetic-invalid/admission-checkpoints"
GRANTS = ("library.browse.read", "library.media.read")
DEVICE = "70000000-0000-4000-8000-000000000001"
LISTEN = "70000000-0000-4000-8000-000000000002"
DECODER = "70000000-0000-4000-8000-000000000003"
OTHER = "70000000-0000-4000-8000-000000000004"
TRACK = {"id": 901, "track_key": "synthetic-track", "file_id": 701}
PATH = "/synthetic/private-track.flac"
RATE = 8000
IDENTITY = admission.AdmissionIdentity(evidence.EvidenceScope(ACCOUNT, LIBRARY, TRACK["id"]),
                                      DEVICE, LISTEN, RATE, DECODER)
PARTIAL = admission.AdmissionMetadata(IDENTITY, 7, ((0, RATE),))


def payload(**changes):
    return {"version": evidence.VERSION, "device_id": DEVICE, "session_id": LISTEN,
            "checkpoint_sequence": 0, "sample_rate": RATE, "histogram_bin_frames": RATE,
            "histogram": [[0, RATE]], "rendered_frames": RATE, "max_observed_frame": RATE,
            "coverage_intervals": [[0, RATE]], "coverage_complete": True,
            "instrumentation_complete": True, "resolution_state": "one_second",
            "finalized": False, **changes}


def metadata_wire(metadata):
    return {"metadata_revision": metadata.metadata_revision,
            "observed_intervals": [list(pair) for pair in metadata.observed_intervals],
            "extent_state": metadata.extent_state, "verified_total_frames": metadata.verified_total_frames,
            "extent_provenance": metadata.extent_provenance, "admission_limited": metadata.admission_limited}


def receipt_wire(checkpoint, metadata, digest):
    # Independent expected receipt shape, not the persistence module's serializer.
    return json.dumps({"ok": True, "decoder_instance_id": metadata.identity.decoder_instance_id,
        "device_id": checkpoint.device_id, "session_id": checkpoint.session_id,
        "checkpoint_sequence": checkpoint.checkpoint_sequence, "digest": digest,
        "metadata_revision": metadata.metadata_revision, "extent_state": metadata.extent_state,
        "verified_total_frames": metadata.verified_total_frames, "extent_provenance": metadata.extent_provenance,
        "observation_provenance": "decoded", "admission_limited": metadata.admission_limited,
        "finalized": checkpoint.finalized}, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def stored_row(metadata=PARTIAL, *, accepted=None, accepted_metadata=None, retirement_reason=None, **changes):
    identity = metadata.identity
    row = {"decoder_instance_id": identity.decoder_instance_id, "account_id": identity.scope.account_id,
        "original_library_id": identity.scope.library_id, "original_track_id": identity.scope.track_id,
        "original_file_id": TRACK["file_id"], "live_library_id": identity.scope.library_id,
        "live_track_id": identity.scope.track_id, "live_file_id": TRACK["file_id"],
        "device_id": identity.device_id, "session_id": identity.session_id,
        "evidence_version": evidence.VERSION, "sample_rate": identity.sample_rate, "admitted_at": NOW,
        "current_admission": metadata_wire(metadata), "lifecycle_state": "retired" if retirement_reason else "open",
        "retirement_reason": retirement_reason, "retired_at": NOW if retirement_reason else None,
        "accepted_checkpoint": None, "accepted_admission": None, "accepted_digest": None,
        "accepted_sequence": None, "receipt_body": None, "receipt_status": None, "accepted_at": None}
    if accepted is not None:
        original = accepted_metadata or metadata
        checked = admission.normalize_admitted_checkpoint(accepted, original)
        digest = admission.admitted_checkpoint_digest(checked, identity)
        row.update(accepted_checkpoint=checked.wire(), accepted_admission=metadata_wire(original),
                   accepted_digest=digest, accepted_sequence=checked.checkpoint_sequence,
                   receipt_body=receipt_wire(checked, original, digest), receipt_status=200, accepted_at=NOW)
    row.update(changes)
    return row


def context(*, grants=GRANTS, **changes):
    return actor_context(grants=grants, **changes)


def lock_step(device=DEVICE, session=LISTEN):
    identity = f"{ACCOUNT}:{LIBRARY}:{device}:{session}"
    key = int.from_bytes(hashlib.sha256(identity.encode()).digest()[:8], "big", signed=True)
    return Step("select pg_advisory_xact_lock(%s)", params=(key,))


def source_step(track=TRACK, *, after=None):
    return Step("from library.local_tracks t join library.local_track_files f", [] if track is None else [track],
                (LIBRARY, PATH), after=after,
                clauses=("t.library_id=%s", "f.private_path=%s", "for share of t,f", "f.id as file_id"))


def row_step(row=None, *, decoder=DECODER, device=DEVICE, session=LISTEN, after=None):
    return Step("select * from integration.measured_listen_admission", [] if row is None else [row],
                (ACCOUNT, LIBRARY, device, session, decoder), after=after,
                clauses=("account_id=%s", "original_library_id=%s", "device_id=%s", "session_id=%s",
                         "decoder_instance_id=%s", "for update"))


def group_step(*, count=0, first=None, last=None):
    return Step("select count(*) as instance_count", [{"instance_count": count, "first_track_id": first,
                "last_track_id": last}], (ACCOUNT, LIBRARY, DEVICE, LISTEN),
                clauses=("min(original_track_id)", "max(original_track_id)", "account_id=%s",
                         "original_library_id=%s", "device_id=%s", "session_id=%s"))


def session_step():
    return authority_steps(grants=GRANTS)[3]


def start_steps(row=None, *, decoder=DECODER, device=DEVICE, session=LISTEN, track=TRACK):
    return [*authority_steps(grants=GRANTS), lock_step(device, session), source_step(track),
            row_step(row, decoder=decoder, device=device, session=session)]


def final_steps(*, track=TRACK, after_source=None):
    # Fence after the last potentially waiting canonical-source lookup.
    return [source_step(track, after=after_source), session_step()]


def record(connection, *, value=None, decoder=DECODER, cancelled=lambda: False, clock=lambda: NOW, actor=None):
    return postgres.record_checkpoint(URL, actor or context(), decoder, payload() if value is None else value,
                                     PATH, cancelled=cancelled, connect=lambda _url: connection, clock=clock)


def observe(connection, metadata=PARTIAL, *, cap=8, cancelled=lambda: False, clock=lambda: NOW,
            reason=None, actor=None):
    return postgres.record_observation(URL, actor or context(), metadata, PATH, max_instances=cap,
        cancelled=cancelled, retirement_reason=reason, connect=lambda _url: connection, clock=clock)


def persistence_error(code, operation, status=409):
    with pytest.raises(postgres.AdmissionPersistenceError) as caught:
        operation()
    assert (caught.value.code, caught.value.status) == (code, status)


def evidence_error(code, operation):
    with pytest.raises(evidence.EvidenceError) as caught:
        operation()
    assert caught.value.code == code


def no_ack(connection):
    connection.done()
    assert connection.entered == 1 and len(connection.exits) == 1
    assert connection.exits[0] is not None
    assert connection.writes == []


def test_first_decoded_observation_creates_only_an_admission_row_after_all_fences():
    connection = Connection([*start_steps(), group_step(), *final_steps(),
                             Step("insert into integration.measured_listen_admission"), session_step()])
    assert observe(connection) == PARTIAL
    connection.done()
    assert connection.entered == 1 and connection.exits == [None]
    assert len(connection.writes) == 1
    sql, values = connection.writes[0]
    assert values[:12] == (DECODER, ACCOUNT, LIBRARY, TRACK["id"], TRACK["file_id"], LIBRARY,
                           TRACK["id"], TRACK["file_id"], DEVICE, LISTEN, evidence.VERSION, RATE)
    assert values[12] == NOW and json.loads(values[13]) == metadata_wire(PARTIAL)
    assert values[14:] == ("open", None, None)
    assert "accepted_checkpoint" not in sql and "listen_history" not in sql


def test_empty_open_cannot_create_an_admission_or_reserve_a_decoder():
    connection = Connection(start_steps())
    persistence_error("admission_not_ready", lambda: observe(connection, replace(PARTIAL, observed_intervals=())))
    no_ack(connection)


def test_checkpoint_before_first_observation_is_retryable_without_creating_a_row():
    value = payload()
    before = deepcopy(value)
    connection = Connection(start_steps())
    persistence_error("admission_not_ready", lambda: record(connection, value=value))
    no_ack(connection)
    assert value == before  # The pending checkpoint bytes and sequence remain caller-owned.


def test_first_checkpoint_atomically_saves_original_snapshot_digest_sequence_and_exact_receipt():
    row = stored_row()
    connection = Connection([*start_steps(row), *final_steps(),
                             Step("update integration.measured_listen_admission set accepted_checkpoint="), session_step()])
    result = record(connection)
    connection.done()
    assert result.kind == "accept" and result.status == 200 and connection.exits == [None]
    assert len(connection.writes) == 1
    sql, values = connection.writes[0]
    checked = admission.normalize_admitted_checkpoint(payload(), PARTIAL)
    digest = admission.admitted_checkpoint_digest(checked, IDENTITY)
    assert json.loads(values[0]) == checked.wire()
    assert json.loads(values[1]) == metadata_wire(PARTIAL)
    assert values[2:] == (digest, 0, result.body, 200, NOW, DECODER)
    assert result.body == receipt_wire(checked, PARTIAL, digest)
    assert "current_admission=" not in sql and "lifecycle_state=" not in sql
    assert "listen_history" not in sql
    receipt = json.loads(result.body)
    assert receipt["verified_total_frames"] is None and receipt["observation_provenance"] == "decoded"
    assert not ({"duration_seconds", "song_complete", "coverage_percentage", "scrobbled"} & receipt.keys())


def test_latest_server_metadata_grows_without_rewriting_any_accepted_fields():
    row = stored_row(accepted=payload())
    before = deepcopy(row)
    grown = replace(PARTIAL, metadata_revision=19, observed_intervals=((0, 2 * RATE),))
    connection = Connection([*start_steps(row), *final_steps(),
                             Step("update integration.measured_listen_admission set current_admission="), session_step()])
    assert observe(connection, grown) == grown
    connection.done()
    sql, values = connection.writes[0]
    assert json.loads(values[0]) == metadata_wire(grown)
    assert values[1:] == ("open", None, None, DECODER)
    assert "accepted_" not in sql and "receipt_" not in sql
    assert row == before


def test_same_decoder_cannot_change_its_immutable_output_rate():
    changed = replace(PARTIAL, identity=replace(IDENTITY, sample_rate=16000), metadata_revision=8)
    connection = Connection(start_steps(stored_row()))
    evidence_error("admission_identity_changed", lambda: observe(connection, changed))
    no_ack(connection)


def test_successful_first_output_eos_can_create_a_verified_retired_instance():
    verified = replace(PARTIAL, extent_state="verified_complete", verified_total_frames=RATE,
                       extent_provenance=admission.VERIFIED_PROVENANCE)
    connection = Connection([*start_steps(), group_step(), *final_steps(),
                             Step("insert into integration.measured_listen_admission"), session_step()])
    assert observe(connection, verified, reason="eos") == verified
    connection.done()
    sql, values = connection.writes[0]
    assert values[12] == NOW and json.loads(values[13]) == metadata_wire(verified)
    assert values[14:] == ("retired", "eos", NOW)
    assert "accepted_checkpoint" not in sql and connection.exits == [None]


def test_open_instance_retirement_changes_only_server_lifecycle_and_preserves_client_receipt():
    row = stored_row(accepted=payload())
    original = deepcopy(row)
    retirement_time = NOW + timedelta(seconds=3)
    connection = Connection([*start_steps(row), *final_steps(),
                             Step("update integration.measured_listen_admission set current_admission="), session_step()])
    assert observe(connection, reason="cancelled", clock=lambda: retirement_time) == PARTIAL
    connection.done()
    sql, values = connection.writes[0]
    assert json.loads(values[0]) == metadata_wire(PARTIAL)
    assert values[1:] == ("retired", "cancelled", retirement_time, DECODER)
    assert "accepted_" not in sql and "receipt_" not in sql and row == original
    retired = {**row, "lifecycle_state": "retired", "retirement_reason": "cancelled", "retired_at": retirement_time}
    replay = Connection([*start_steps(retired), *final_steps()])
    observe(replay, reason="cancelled", clock=lambda: retirement_time + timedelta(seconds=4))
    replay.done()
    assert replay.writes == [] and retired["retired_at"] == retirement_time
    assert retired["receipt_body"] == original["receipt_body"]


@pytest.mark.parametrize("accepted", [False, True])
def test_metadata_regression_is_checked_against_latest_server_snapshot_even_without_client_evidence(accepted):
    latest = replace(PARTIAL, metadata_revision=19, observed_intervals=((0, 2 * RATE),))
    row = stored_row(latest, accepted=payload() if accepted else None, accepted_metadata=PARTIAL)
    connection = Connection(start_steps(row))
    evidence_error("metadata_revision_regressed", lambda: observe(connection, PARTIAL))
    no_ack(connection)


@pytest.mark.parametrize("verified", [False, True])
def test_exact_latest_replay_after_metadata_growth_returns_original_receipt_without_writes(verified):
    grown = replace(PARTIAL, metadata_revision=19, observed_intervals=((0, 2 * RATE),))
    reason = None
    if verified:
        grown = replace(grown, extent_state="verified_complete", verified_total_frames=2 * RATE,
                        extent_provenance=admission.VERIFIED_PROVENANCE)
        reason = "eos"
    row = stored_row(grown, accepted=payload(), accepted_metadata=PARTIAL, retirement_reason=reason)
    connection = Connection([*start_steps(row), *final_steps()])
    result = record(connection)
    connection.done()
    assert (result.kind, result.status, result.body) == ("replay", 200, row["receipt_body"])
    assert json.loads(result.body)["metadata_revision"] == 7
    assert json.loads(result.body)["verified_total_frames"] is None
    assert connection.writes == [] and connection.exits == [None]


def test_same_sequence_different_digest_conflicts_without_rewriting_receipt():
    row = stored_row(accepted=payload())
    connection = Connection(start_steps(row))
    evidence_error("sequence_conflict", lambda: record(connection, value=payload(
        histogram=[[0, 2 * RATE]], rendered_frames=2 * RATE)))
    no_ack(connection)


def test_older_sequence_returns_only_latest_status_without_fabricating_historic_receipt():
    row = stored_row(accepted=payload(checkpoint_sequence=1, finalized=True))
    connection = Connection([*start_steps(row), *final_steps()])
    result = record(connection)
    connection.done()
    assert (result.kind, result.status) == ("stale", 409)
    assert json.loads(result.body) == {"ok": False, "error": "stale_checkpoint", "latest_sequence": 1,
                                     "decoder_instance_id": DECODER}
    assert result.body != row["receipt_body"] and connection.writes == []


def test_new_checkpoint_uses_latest_observations_but_keeps_sequence_independent_of_revision():
    latest = replace(PARTIAL, metadata_revision=99, observed_intervals=((0, 2 * RATE),))
    row = stored_row(latest, accepted=payload(), accepted_metadata=PARTIAL)
    value = payload(checkpoint_sequence=1, histogram=[[0, RATE], [1, RATE]], rendered_frames=2 * RATE,
                    max_observed_frame=2 * RATE, coverage_intervals=[[0, 2 * RATE]])
    connection = Connection([*start_steps(row), *final_steps(),
                             Step("update integration.measured_listen_admission set accepted_checkpoint="), session_step()])
    result = record(connection, value=value)
    connection.done()
    receipt = json.loads(result.body)
    assert receipt["checkpoint_sequence"] == 1 and receipt["metadata_revision"] == 99
    assert json.loads(connection.writes[0][1][1]) == metadata_wire(latest)


def test_evidence_outside_latest_committed_ranges_cannot_expand_server_metadata():
    connection = Connection(start_steps(stored_row(accepted=payload())))
    evidence_error("coverage_outside_observation", lambda: record(connection, value=payload(
        checkpoint_sequence=1, histogram=[[0, RATE], [1, RATE]], rendered_frames=2 * RATE,
        max_observed_frame=2 * RATE, coverage_intervals=[[0, 2 * RATE]])))
    no_ack(connection)


@pytest.mark.parametrize("reason", ["eos", "cancelled", "replaced", "shutdown", "error", "source_changed"])
def test_retired_decoder_accepts_delayed_client_finalization_without_reopening(reason):
    row = stored_row(accepted=payload(), retirement_reason=reason)
    connection = Connection([*start_steps(row), *final_steps(),
                             Step("update integration.measured_listen_admission set accepted_checkpoint="), session_step()])
    result = record(connection, value=payload(checkpoint_sequence=1, finalized=True))
    connection.done()
    assert result.kind == "accept" and json.loads(result.body)["finalized"] is True
    assert "lifecycle_state" not in connection.writes[0][0]
    assert row["lifecycle_state"] == "retired"


@pytest.mark.parametrize("change", ["reopen", "grow", "reason"])
def test_retired_instance_cannot_reopen_add_observations_or_change_retirement_reason(change):
    row = stored_row(retirement_reason="cancelled")
    metadata = replace(PARTIAL, metadata_revision=8, observed_intervals=((0, 2 * RATE),)) if change == "grow" else PARTIAL
    reason = None if change == "reopen" else "error" if change == "reason" else "cancelled"
    connection = Connection(start_steps(row))
    persistence_error("decoder_retired", lambda: observe(connection, metadata, reason=reason))
    no_ack(connection)


def test_identical_retirement_retry_preserves_original_retirement_time_and_receipt():
    row = stored_row(accepted=payload(), retirement_reason="cancelled")
    connection = Connection([*start_steps(row), *final_steps()])
    assert observe(connection, reason="cancelled", clock=lambda: NOW + timedelta(minutes=5)) == PARTIAL
    connection.done()
    assert connection.writes == [] and connection.exits == [None]


def test_new_seek_decoder_shares_group_lock_but_never_overwrites_prior_instance():
    identity = replace(IDENTITY, decoder_instance_id=OTHER, sample_rate=16000)
    metadata = admission.AdmissionMetadata(identity, 0, ((32000, 48000),))
    connection = Connection([*start_steps(decoder=OTHER), group_step(count=1, first=TRACK["id"], last=TRACK["id"]),
                             *final_steps(), Step("insert into integration.measured_listen_admission"), session_step()])
    observe(connection, metadata)
    connection.done()
    assert len(connection.writes) == 1 and connection.writes[0][0].startswith("insert ")
    values = connection.writes[0][1]
    assert values[0] == OTHER and values[8:10] == (DEVICE, LISTEN) and values[11] == 16000
    assert json.loads(values[13])["observed_intervals"] == [[32000, 48000]]


def test_each_decoder_has_its_own_sequence_zero_receipt_and_digest():
    results = []
    for decoder in (DECODER, OTHER):
        metadata = replace(PARTIAL, identity=replace(IDENTITY, decoder_instance_id=decoder))
        connection = Connection([*start_steps(stored_row(metadata), decoder=decoder), *final_steps(),
                                 Step("update integration.measured_listen_admission set accepted_checkpoint="), session_step()])
        result = record(connection, decoder=decoder)
        connection.done()
        results.append(json.loads(result.body))
        assert connection.writes[0][1][-1] == decoder
    assert [value["checkpoint_sequence"] for value in results] == [0, 0]
    assert [value["decoder_instance_id"] for value in results] == [DECODER, OTHER]
    assert results[0]["digest"] != results[1]["digest"]


@pytest.mark.parametrize("device,session", [(OTHER, LISTEN), (DEVICE, OTHER)])
def test_client_cannot_select_an_instance_through_a_different_device_or_logical_session(device, session):
    connection = Connection(start_steps(device=device, session=session))
    persistence_error("admission_not_ready", lambda: record(connection, value=payload(device_id=device, session_id=session)))
    no_ack(connection)


@pytest.mark.parametrize("first,last", [(902, 902), (901, 902), (902, 901)])
def test_new_instance_rejects_changed_or_inconsistent_group_track_identity(first, last):
    connection = Connection([*start_steps(), group_step(count=1, first=first, last=last)])
    persistence_error("logical_session_track_changed", lambda: observe(connection))
    no_ack(connection)


def test_resource_limit_refuses_new_instance_without_eviction_or_data_rewrite():
    connection = Connection([*start_steps(), group_step(count=2, first=TRACK["id"], last=TRACK["id"])])
    persistence_error("admission_resource_limit", lambda: observe(connection, cap=2))
    no_ack(connection)


def test_existing_instance_can_replay_metadata_even_when_group_cap_is_full():
    connection = Connection([*start_steps(stored_row()), *final_steps()])
    assert observe(connection, cap=1) == PARTIAL
    connection.done()
    assert connection.writes == []
    assert not any("count(*)" in sql for sql, _ in connection.operations)


@pytest.mark.parametrize("operation", ["observation", "checkpoint"])
@pytest.mark.parametrize("denial", ["inactive", "disabled", "missing_session", "revoked_session", "membership", "media"])
def test_fresh_authority_denies_before_any_admission_lookup_or_write(operation, denial):
    steps = authority_steps(grants=GRANTS)
    end = 7
    if denial in {"inactive", "disabled"}:
        steps[2].rows[0].update({"is_active": False} if denial == "inactive" else {"disabled_at": NOW})
        end = 3
    elif denial == "missing_session":
        steps[3].rows = []
        end = 4
    elif denial == "revoked_session":
        steps[3].rows[0]["revoked_at"] = NOW
        end = 4
    elif denial == "membership":
        steps[5].rows = []
        end = 6
    else:
        steps[6].rows = [row for row in steps[6].rows if row["capability_key"] != "library.media.read"]
    connection = Connection(steps[:end])
    with pytest.raises(PrivateLibraryAuthorityError):
        observe(connection) if operation == "observation" else record(connection)
    no_ack(connection)
    assert not any("measured_listen_admission" in sql for sql, _ in connection.operations)


@pytest.mark.parametrize("operation", ["observation", "checkpoint"])
@pytest.mark.parametrize("wait_at", ["identity", "row", "final_source"])
def test_session_expiry_after_each_late_wait_exits_without_a_write_or_acknowledgement(operation, wait_at):
    clock = [NOW]
    expire = lambda: clock.__setitem__(0, NOW + timedelta(hours=2))
    steps = start_steps(stored_row())
    if wait_at == "identity":
        steps[7].after = expire
    elif wait_at == "row":
        steps[-1].after = expire
    steps.extend(final_steps(after_source=expire if wait_at == "final_source" else None))
    connection = Connection(steps)
    with pytest.raises(PrivateLibraryAuthorityError):
        observe(connection, clock=lambda: clock[0]) if operation == "observation" else record(connection, clock=lambda: clock[0])
    no_ack(connection)


@pytest.mark.parametrize("operation", ["observation", "checkpoint"])
@pytest.mark.parametrize("wait_at", ["identity", "row", "final_source"])
def test_request_cancellation_after_each_late_wait_exits_without_a_write_or_acknowledgement(operation, wait_at):
    invalidated = [False]
    cancel = lambda: invalidated.__setitem__(0, True)
    steps = start_steps(stored_row())
    if wait_at == "identity":
        steps[7].after = cancel
    elif wait_at == "row":
        steps[-1].after = cancel
    steps.extend(final_steps(after_source=cancel if wait_at == "final_source" else None))
    connection = Connection(steps)
    callback = lambda: invalidated[0]
    persistence_error("request_cancelled", lambda: observe(connection, cancelled=callback)
                      if operation == "observation" else record(connection, cancelled=callback))
    no_ack(connection)


@pytest.mark.parametrize("operation", ["observation", "checkpoint"])
def test_canonical_file_replacement_in_the_last_lookup_prevents_writing(operation):
    steps = [*start_steps(stored_row()), source_step({**TRACK, "file_id": 702})]
    connection = Connection(steps)
    persistence_error("source_unavailable", lambda: observe(connection) if operation == "observation" else record(connection), 403)
    no_ack(connection)


@pytest.mark.parametrize("field,value", [("live_library_id", None), ("live_track_id", None),
    ("live_file_id", None), ("original_track_id", 902), ("original_file_id", 702)])
def test_source_loss_or_identity_replacement_never_reuses_retained_evidence(field, value):
    row = stored_row(accepted=payload(), retirement_reason="cancelled", **{field: value})
    connection = Connection(start_steps(row))
    persistence_error("source_unavailable", lambda: record(connection), 403)
    no_ack(connection)


@pytest.mark.parametrize("operation", ["observation", "checkpoint"])
@pytest.mark.parametrize("fault_at", ["write", "commit"])
def test_write_or_commit_failure_propagates_without_a_success_result(operation, fault_at):
    fault = RuntimeError("Synthetic admission persistence failure")
    if operation == "observation":
        steps = [*start_steps(), group_step(), *final_steps(), Step("insert into integration.measured_listen_admission")]
    else:
        steps = [*start_steps(stored_row()), *final_steps(),
                 Step("update integration.measured_listen_admission set accepted_checkpoint=")]
    if fault_at == "write":
        steps[-1].error = fault
    else:
        steps.append(session_step())
    connection = Connection(steps, commit_error=fault if fault_at == "commit" else None)
    with pytest.raises(RuntimeError) as caught:
        observe(connection) if operation == "observation" else record(connection)
    assert caught.value is fault
    connection.done()
    assert connection.exits == [None if fault_at == "commit" else fault]
    assert connection.entered == 1


@pytest.mark.parametrize("operation", ["insert_observation", "update_observation", "checkpoint"])
def test_cancellation_during_the_last_write_escapes_the_transaction_without_an_acknowledgement(operation):
    invalidated = [False]
    cancel = lambda: invalidated.__setitem__(0, True)
    if operation == "insert_observation":
        metadata = PARTIAL
        steps = [*start_steps(), group_step(), *final_steps(),
                 Step("insert into integration.measured_listen_admission", after=cancel)]
    elif operation == "update_observation":
        metadata = replace(PARTIAL, metadata_revision=8, observed_intervals=((0, 2 * RATE),))
        steps = [*start_steps(stored_row()), *final_steps(),
                 Step("update integration.measured_listen_admission set current_admission=", after=cancel)]
    else:
        steps = [*start_steps(stored_row()), *final_steps(),
                 Step("update integration.measured_listen_admission set accepted_checkpoint=", after=cancel)]
    connection = Connection(steps)
    persistence_error("request_cancelled", lambda: record(connection, cancelled=lambda: invalidated[0])
        if operation == "checkpoint" else observe(connection, metadata, cancelled=lambda: invalidated[0]))
    connection.done()
    assert connection.entered == 1 and len(connection.writes) == 1
    assert len(connection.exits) == 1 and isinstance(connection.exits[0], postgres.AdmissionPersistenceError)
    # Exceptional exit requests rollback from the real connection context. This
    # scripted test does not simulate or claim that PostgreSQL rollback occurred.


@pytest.mark.parametrize("operation", ["observation", "checkpoint"])
def test_database_deadlock_propagates_without_success_or_an_unbounded_automatic_retry(operation):
    fault = RuntimeError("Synthetic shared-identity lock deadlock")
    fault.sqlstate = "40P01"
    waiting = lock_step()
    waiting.error = fault
    connection = Connection([*authority_steps(grants=GRANTS), waiting])
    with pytest.raises(RuntimeError) as caught:
        observe(connection) if operation == "observation" else record(connection)
    assert caught.value is fault
    no_ack(connection)
    # Error propagation alone does not prove common account/advisory ordering.
    # The companion's opt-in PostgreSQL contracts cover that separate property.


@pytest.mark.parametrize("field,value", [
    ("current_admission", []), ("current_admission", {}), ("current_admission", "{}"),
    ("accepted_checkpoint", []), ("accepted_admission", {}), ("accepted_digest", "0" * 64),
    ("accepted_sequence", True), ("accepted_sequence", 5), ("receipt_body", "{}"),
    ("receipt_status", True), ("receipt_status", 201), ("accepted_at", None),
    ("accepted_at", NOW.isoformat()), ("accepted_at", NOW - timedelta(seconds=1)),
    ("admitted_at", None), ("admitted_at", NOW.isoformat()), ("admitted_at", NOW.replace(tzinfo=None)),
    ("evidence_version", "rendered-pcm-v1"), ("sample_rate", True),
    ("lifecycle_state", "unknown"), ("retirement_reason", "cancelled"), ("retired_at", NOW),
])
def test_malformed_stored_state_is_rejected_as_service_data_error_before_ack(field, value):
    row = stored_row(accepted=payload(), **{field: value})
    connection = Connection(start_steps(row))
    persistence_error("stored_admission_invalid", lambda: record(connection), 503)
    no_ack(connection)


@pytest.mark.parametrize("retired_at", [NOW.isoformat(), NOW.replace(tzinfo=None), NOW - timedelta(seconds=1)])
def test_malformed_or_regressed_retirement_timestamp_is_rejected(retired_at):
    row = stored_row(accepted=payload(), retirement_reason="cancelled", retired_at=retired_at)
    connection = Connection(start_steps(row))
    persistence_error("stored_admission_invalid", lambda: record(connection), 503)
    no_ack(connection)


@pytest.mark.parametrize("operation", ["observation", "checkpoint"])
def test_clock_regression_cannot_backdate_new_observations_or_evidence_before_admission(operation):
    row = stored_row(admitted_at=NOW + timedelta(seconds=1))
    connection = Connection([*start_steps(row), *final_steps()])
    persistence_error("invalid_clock", lambda: observe(connection) if operation == "observation" else record(connection), 503)
    no_ack(connection)


@pytest.mark.parametrize("changes", [
    {"metadata_revision": True}, {"observed_intervals": [[0, True]]},
    {"observed_intervals": []},
    {"observed_intervals": [[0, 10], [10, RATE]]}, {"observed_intervals": [[1, RATE]]},
    {"extent_state": "observed_partial", "verified_total_frames": RATE},
    {"admission_limited": 1}, {"unexpected": "client supplied metadata"},
])
def test_json_object_shape_is_not_enough_to_trust_stored_metadata(changes):
    row = stored_row(accepted=payload())
    row["current_admission"].update(changes)
    connection = Connection(start_steps(row))
    persistence_error("stored_admission_invalid", lambda: record(connection), 503)
    no_ack(connection)


def test_accepted_snapshot_cannot_claim_evidence_was_admitted_before_first_observed_output():
    empty = replace(PARTIAL, metadata_revision=0, observed_intervals=())
    value = payload(histogram=[], rendered_frames=0, max_observed_frame=0, coverage_intervals=[])
    row = stored_row(accepted=value, accepted_metadata=empty)
    connection = Connection(start_steps(row))
    persistence_error("stored_admission_invalid", lambda: record(connection, value=value), 503)
    no_ack(connection)


def test_noncanonical_receipt_representation_is_not_silently_reformatted_on_replay():
    row = stored_row(accepted=payload())
    row["receipt_body"] = json.dumps(json.loads(row["receipt_body"]), indent=2)
    connection = Connection(start_steps(row))
    persistence_error("stored_admission_invalid", lambda: record(connection), 503)
    no_ack(connection)


@pytest.mark.parametrize("operation", ["observation", "checkpoint"])
def test_cancellation_fence_is_mandatory_before_opening_connection(operation):
    connection = Connection()
    persistence_error("cancellation_fence_required", lambda: observe(connection, cancelled=None)
                      if operation == "observation" else record(connection, cancelled=None), 400)
    assert connection.entered == 0 and connection.operations == []


def test_resource_cap_and_request_fence_have_no_silent_activation_defaults():
    connection = Connection()
    options = {"connect": lambda _url: connection, "clock": lambda: NOW}
    with pytest.raises(TypeError):
        postgres.record_observation(URL, context(), PARTIAL, PATH, cancelled=lambda: False, **options)
    with pytest.raises(TypeError):
        postgres.record_observation(URL, context(), PARTIAL, PATH, max_instances=8, **options)
    with pytest.raises(TypeError):
        postgres.record_checkpoint(URL, context(), DECODER, payload(), PATH, **options)
    assert connection.entered == 0 and connection.operations == []


@pytest.mark.parametrize("operation", ["observation", "checkpoint"])
def test_coarse_browse_denial_never_opens_a_connection(operation):
    connection = Connection()
    with pytest.raises(PrivateLibraryAuthorityError):
        observe(connection, actor=context(grants=())) if operation == "observation" else record(connection, actor=context(grants=()))
    assert connection.entered == 0 and connection.operations == []


@pytest.mark.parametrize("operation", ["observation", "checkpoint"])
def test_missing_current_file_denies_before_row_lookup_even_for_receipt_replay(operation):
    connection = Connection([*authority_steps(grants=GRANTS), lock_step(), source_step(None)])
    persistence_error("source_unavailable", lambda: observe(connection) if operation == "observation" else record(connection), 403)
    no_ack(connection)


@pytest.mark.parametrize("scope", [evidence.EvidenceScope(ACCOUNT + 1, LIBRARY, TRACK["id"]),
                                  evidence.EvidenceScope(ACCOUNT, LIBRARY + 1, TRACK["id"])])
def test_server_observation_identity_must_match_live_account_and_library(scope):
    metadata = replace(PARTIAL, identity=replace(IDENTITY, scope=scope))
    connection = Connection(authority_steps(grants=GRANTS))
    persistence_error("admission_scope_mismatch", lambda: observe(connection, metadata), 403)
    no_ack(connection)


def test_server_observation_canonical_track_must_match_the_locked_source():
    metadata = replace(PARTIAL, identity=replace(IDENTITY, scope=evidence.EvidenceScope(ACCOUNT, LIBRARY, 902)))
    connection = Connection([*authority_steps(grants=GRANTS), lock_step(), source_step()])
    persistence_error("admission_scope_mismatch", lambda: observe(connection, metadata), 403)
    no_ack(connection)


@pytest.mark.parametrize("cap", [None, True, 0, -1, 1.5])
def test_caller_must_choose_an_explicit_valid_resource_cap(cap):
    connection = Connection()
    with pytest.raises(evidence.EvidenceError):
        observe(connection, cap=cap)
    assert connection.entered == 0


def test_verified_extent_requires_a_successful_retirement_and_never_uses_seek_eos_as_total():
    metadata = replace(PARTIAL, extent_state="verified_complete", verified_total_frames=RATE,
                       extent_provenance=admission.VERIFIED_PROVENANCE)
    connection = Connection()
    persistence_error("invalid_retirement", lambda: observe(connection, metadata), 400)
    assert connection.entered == 0
    seek = replace(metadata, observed_intervals=((RATE, 2 * RATE),), verified_total_frames=2 * RATE)
    evidence_error("verified_extent_conflict", lambda: observe(connection, seek, reason="eos"))
    assert connection.entered == 0


def test_ordinary_measured_identity_and_signed_advisory_key_remain_byte_for_byte_compatible():
    identity = f"{ACCOUNT}:{LIBRARY}:{DEVICE}:{LISTEN}"
    assert ordinary.measured_identity(ACCOUNT, LIBRARY, DEVICE, LISTEN) == identity
    connection = Connection([lock_step()])
    ordinary.lock_measured_identity(connection, identity)
    connection.done()
    assert connection.entered == 0


def test_ordinary_track_lookup_keeps_original_select_and_does_not_add_admission_locks():
    expected = "select t.id,t.track_key from library.local_tracks t join library.local_track_files f on f.track_id=t.id where t.library_id=%s and f.private_path=%s"
    connection = Connection([Step(expected, [{"id": TRACK["id"], "track_key": TRACK["track_key"]}], (LIBRARY, PATH))])
    assert ordinary.resolve_measured_track(connection, LIBRARY, PATH) == {"id": TRACK["id"], "track_key": TRACK["track_key"]}
    connection.done()
    assert connection.operations[0][0] == expected
    assert "for share" not in connection.operations[0][0] and "file_id" not in connection.operations[0][0]


def test_ordinary_append_still_uses_its_own_unchanged_ledger_sql_and_identity():
    entry = {"measurement_version": ordinary.VERSION, "device_id": DEVICE, "session_id": LISTEN,
        "sequence": 1, "measured_listened_seconds": 12.5, "max_measured_contiguous_seconds": 11.0,
        "finalized": False, "path": PATH, "started_at": NOW.isoformat(),
        "source_provenance": {"kind": "local_playback", "provider": "album_haven"}}
    account_sql = ("with locked_accounts as ( select id from app.accounts where id in (%s, %s) "
                   "order by id for update ) select id from locked_accounts")
    connection = Connection([Step(account_sql, [{"id": ACCOUNT}], (ACCOUNT, ACCOUNT)),
        lock_step(), Step("select t.id,t.track_key from library.local_tracks t",
        [{"id": TRACK["id"], "track_key": TRACK["track_key"]}], (LIBRARY, PATH)),
        Step("select * from integration.listen_history", params=(ACCOUNT, LIBRARY, DEVICE, LISTEN, ordinary.VERSION),
             clauses=("for update",)), Step("insert into integration.listen_history")])
    result = ordinary.append_measured(SimpleNamespace(_connect_to_database=lambda: connection), entry,
                                      account_id=ACCOUNT, library_id=LIBRARY)
    connection.done()
    identity = f"{ACCOUNT}:{LIBRARY}:{DEVICE}:{LISTEN}"
    assert result["id"] == hashlib.sha256(identity.encode()).hexdigest()
    assert connection.writes[0][1][6] == identity
    assert connection.exits == [None] and connection.entered == 1
    assert all("measured_listen_admission" not in sql for sql, _ in connection.operations)
    assert connection.operations[0] == (account_sql, (ACCOUNT, ACCOUNT))
    assert "for share" not in connection.operations[2][0]


@pytest.mark.parametrize("operation", ["insert_observation", "update_observation", "checkpoint"])
@pytest.mark.parametrize("expires", [True, False])
def test_session_authority_is_rechecked_after_write_wait_without_replacing_admission_time(operation, expires):
    clock = [NOW]
    after_write = NOW + (timedelta(hours=2) if expires else timedelta(seconds=1))
    advance = lambda: clock.__setitem__(0, after_write)
    metadata = PARTIAL
    if operation == "insert_observation":
        steps = [*start_steps(), group_step(), *final_steps(),
                 Step("insert into integration.measured_listen_admission", after=advance), session_step()]
        timestamp_index = 12
    elif operation == "update_observation":
        metadata = replace(PARTIAL, metadata_revision=8, observed_intervals=((0, 2 * RATE),))
        steps = [*start_steps(stored_row()), *final_steps(),
                 Step("update integration.measured_listen_admission set current_admission=", after=advance), session_step()]
        timestamp_index = 3
    else:
        steps = [*start_steps(stored_row()), *final_steps(),
                 Step("update integration.measured_listen_admission set accepted_checkpoint=", after=advance), session_step()]
        timestamp_index = 6
    connection = Connection(steps)

    def operation_call():
        return (record(connection, clock=lambda: clock[0]) if operation == "checkpoint" else
                observe(connection, metadata, clock=lambda: clock[0],
                        reason="cancelled" if operation == "update_observation" else None))

    if expires:
        with pytest.raises(PrivateLibraryAuthorityError) as caught:
            operation_call()
        assert len(connection.exits) == 1 and isinstance(connection.exits[0], PermissionError)
    else:
        result = operation_call()
        assert connection.exits == [None]
        if operation == "checkpoint":
            assert result.kind == "accept"
        else:
            assert result == metadata
    connection.done()
    assert connection.entered == 1 and len(connection.writes) == 1
    assert connection.writes[0][1][timestamp_index] == NOW
    assert clock[0] == after_write
    # The last SQL is the real session fence, after the attempted write. An
    # exceptional exit requests rollback; this fake does not prove DB rollback.
    assert "app.account_sessions" in connection.operations[-1][0]
