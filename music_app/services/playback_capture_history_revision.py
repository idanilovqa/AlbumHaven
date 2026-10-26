"""Dormant account-wide capture cut revisions, owned by real mutation transactions.

No initializer/backfill, connection factory, cache or standalone reservation is
provided. An absent row over retained v2 checkpoints is deliberately unsupported.
The caller already owns the current account and genuine account/global budgets.
"""
from music_app.services.playback_capture import CaptureError, POSITION_PROTOCOL

HISTORY_REVISION_BYTES = 1024
_I64 = 9223372036854775807
_FIELDS = ('append_revision', 'invalidation_revision', 'proof_revision')


def _unavailable():
    raise CaptureError('capture_unavailable', 503)


def _valid_revision(row, account_id, account_budget_id=None):
    if (row is None or row['account_id'] != account_id
            or any(type(row[key]) is not int or not 0 <= row[key] <= _I64 for key in _FIELDS)
            or type(row['account_budget_id']) is not int or row['account_budget_id'] <= 0
            or row['reservation_bytes'] != HISTORY_REVISION_BYTES
            or (account_budget_id is not None and row['account_budget_id'] != account_budget_id)):
        _unavailable()
    cut = row['raw_checkpoint_cut']
    if ((cut is not None and (type(cut) is not int or not 1 <= cut <= _I64))
            or (row['append_revision'] == 0) != (cut is None)):
        _unavailable()
    return row


def _prepare_history_revision(connection, account):
    """Return (existing row or None, first-use charge) WITHOUT a second debit.

    Called only after the genuine account/global budgets are locked, before the
    writer's one aggregate _reserve. No older retained history is initialized by
    guessing a zero revision. Such an account needs a separately reviewed repair.
    """
    row = connection.execute('''select account_id,account_budget_id,append_revision,
            invalidation_revision,proof_revision,raw_checkpoint_cut,reservation_bytes
        from integration.playback_capture_history_revision
        where account_id=%s for update''', (account['account_id'],)).fetchone()
    if row is not None:
        return _valid_revision(row, account['account_id'], account['id']), 0
    retained = connection.execute('''select cp.id
        from integration.playback_capture_session p
        join integration.playback_capture_checkpoint cp on cp.session_id=p.id
        where p.account_id=%s and p.evidence_version=%s limit 1''',
        (account['account_id'], POSITION_PROTOCOL)).fetchone()
    if retained is not None:
        _unavailable()
    return None, HISTORY_REVISION_BYTES


def _insert_reserved_history_revision(connection, account):
    """Insert only after the enclosing writer reserved the combined charge.

    No ON CONFLICT: an unexpected concurrent row aborts the entire transaction,
    including the combined charge. The real authority account lock serializes
    supported first use; swallowing a conflict could debit this row twice.
    """
    row = connection.execute('''insert into integration.playback_capture_history_revision
        (account_id,account_budget_id,append_revision,invalidation_revision,
         proof_revision,raw_checkpoint_cut,reservation_bytes)
        values(%s,%s,0,0,0,null,1024)
        returning account_id,account_budget_id,append_revision,invalidation_revision,
                  proof_revision,raw_checkpoint_cut,reservation_bytes''',
        (account['account_id'], account['id'])).fetchone()
    return _valid_revision(row, account['account_id'], account['id'])


def _append_history_checkpoint(connection, account_id, checkpoint_id, *, has_loss):
    """One new real v2 checkpoint, including anchor/loss/terminal-only batches.

    Must be called in its insertion transaction, never for duplicate receipts.
    Arithmetic overflow aborts rather than wrapping/reusing an earlier cut.
    """
    if (type(checkpoint_id) is not int or not 1 <= checkpoint_id <= _I64
            or type(has_loss) is not bool):
        _unavailable()
    changed = connection.execute('''update integration.playback_capture_history_revision
        set append_revision=append_revision+1,
            invalidation_revision=invalidation_revision+%s,
            raw_checkpoint_cut=greatest(raw_checkpoint_cut,%s)
        where account_id=%s and append_revision<9223372036854775807
          and invalidation_revision<=9223372036854775807-%s
          and (raw_checkpoint_cut is null or raw_checkpoint_cut<%s)
          and exists(select 1 from integration.playback_capture_checkpoint cp
              join integration.playback_capture_session p on p.id=cp.session_id
              where cp.id=%s and p.account_id=%s and p.evidence_version=%s
                and not cp.evidence_redacted)
        returning account_id''',
        (int(has_loss), checkpoint_id, account_id, int(has_loss), checkpoint_id,
         checkpoint_id, account_id, POSITION_PROTOCOL)).fetchone()
    if changed is None:
        _unavailable()


def _advance_history_proof(connection, account_id):
    """Required same-transaction hook for future genuine proof mutators.

    Not called by H3: N22 sidecar mutation owners and a separately admitted
    compatibility owner are still absent. This helper is not their integration.
    """
    changed = connection.execute('''update integration.playback_capture_history_revision
        set proof_revision=proof_revision+1
        where account_id=%s and proof_revision<9223372036854775807
        returning account_id''', (account_id,)).fetchone()
    if changed is None:
        _unavailable()


def _read_history_revision(connection, account_id):
    """Read under genuine authority; lock through final transaction settlement.

    The share lock also orders supported destructive trigger invalidations. A
    missing row is unavailable; no read creates, reserves or backfills metadata.
    """
    row = connection.execute('''select h.account_id,h.account_budget_id,h.append_revision,
            h.invalidation_revision,h.proof_revision,h.raw_checkpoint_cut,h.reservation_bytes
        from integration.playback_capture_history_revision h
        join integration.playback_capture_budget b
          on b.id=h.account_budget_id and b.account_id=h.account_id and not b.is_global
        where h.account_id=%s for share of h,b''', (account_id,)).fetchone()
    return _valid_revision(row, account_id)
