"""Read-only reconciliation after a settled account import attempt.

This is not a worker, a retry loop or a rollback classifier. The caller retains
the original command/upload and exclusive operation slot, waits for the actual
first owner to finish, and allows at most one further native-chain invocation.
A timeout with a still-running worker MUST NOT enter this helper. Generic
SourceUnavailable never proves rollback. Every failure here forbids retry.
"""
from dataclasses import dataclass
from datetime import date
from enum import Enum

from . import foobar_account_prepare_gate as gate
from . import foobar_account_apply_command as apply_command
from . import foobar_account_import_prepare as prepare
from . import foobar_account_import_status as status
from . import foobar_account_source_postgres as source
from .foobar_account_authority import current_foobar_account_transaction, require_account_foobar
from .foobar_account_source_postgres import SourceUnavailable, SourceStale

_CONTROLS = 65536
_KEY_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j)
select k.operation,encode(k.command_sha256,'hex') command_sha256,
 k.original_receipt_ref::text original_receipt_ref,k.receipt_ref::text receipt_ref,
 k.state,k.created_at,k.retired_at,k.retired_reason,clock_timestamp() observed_at
from integration.foobar_import_request_keys_v2 k cross join f
where (k.account_id,k.source_ref,k.generation,k.request_key)=
 ((j->>0)::bigint,(j->>2)::uuid,(j->>3)::bigint,(j->>4)::uuid)
"""
_KEY_FIELDS = frozenset(('operation','command_sha256','original_receipt_ref',
    'receipt_ref','state','created_at','retired_at','retired_reason','observed_at'))


class RetryDisposition(Enum):
    RETRY_SAME_IDENTITY = 'retry_same_identity'
    REPLAY_SAME_IDENTITY = 'replay_same_identity'


@dataclass(frozen=True, slots=True)
class FoobarAttemptReconciliation:
    """Permission to re-enter the real chain, never a fabricated success."""
    disposition: RetryDisposition
    receipt_ref: str | None


def reconcile_foobar_attempt(database_url, context, *, operation, command, constraints=None):
    """Reconcile original account/session/source/request identity, without writes.

    Call only after the native operation has settled and before its second and
    final invocation. The second invocation must use the identical full command,
    matching_library_id, request key and original bounded upload, and perform
    fresh native authority checks. No permission or known-rollback flag is
    accepted from external input. READY is never returned as successful Apply.
    """
    if type(operation) is not str or operation not in ('prepare','apply'):
        raise gate.PrepareInvalid()
    validator = (gate.validate_prepare_command if operation == 'prepare'
                 else apply_command.validate_apply_command)
    validator(command)
    digest_owner = (gate.prepare_command_digest if operation == 'prepare'
                    else apply_command.apply_command_digest)
    try:
        prepare._private(_CONTROLS + gate.PREPARE_GATE_BYTES)
        checked = prepare._checked_constraints(constraints)
        deadline = prepare._Deadline()
        receipt_ref = None
        found = False
        with current_foobar_account_transaction(database_url, context,
                constraints=checked) as (raw, live, now):
            connection = prepare._Connection(raw, deadline)
            require_account_foobar(live, checked)
            prepare._utc(now)
            digest = digest_owner(command, account_id=live.actor.account_id,
                library_id=command.matching_library_id, session_id=live.actor.session_id)
            scope = (live.actor.account_id, None, command.source_ref,
                     command.generation, command.request_key)
            lock_frame = status._frame((live.actor.account_id, None, live.actor.session_id,
                                      command.source_ref, command.generation, command.request_key))
            stream = gate._stream_result(source._query(
                connection, gate._LOCK_SQL, lock_frame, maximum=1))
            del lock_frame
            if stream['observed_at'] < now:
                raise SourceUnavailable()
            earlier = status._clock(connection, scope, generation=command.generation,
                                    earlier=stream['observed_at'])
            rows = source._query(connection, _KEY_SQL, status._frame(scope), maximum=1)
            if rows:
                if len(rows) != 1 or type(rows[0]) is not dict or set(rows[0]) != _KEY_FIELDS:
                    raise SourceUnavailable()
                row = rows[0]
                prepare._utc(row['observed_at'])
                prepare._utc(row['created_at'])
                if (row['observed_at'] < earlier or row['created_at'] > row['observed_at']
                        or not gate._hex(row['command_sha256'])
                        or not gate._uuid(row['original_receipt_ref'])
                        or row['operation'] not in ('prepare','apply')
                        or row['state'] not in ('active','tombstone')):
                    raise SourceUnavailable()
                if (row['operation'] != operation or row['command_sha256'] != digest
                        or row['state'] != 'active'):
                    raise SourceStale()
                if (row['receipt_ref'] != row['original_receipt_ref']
                        or row['retired_at'] is not None or row['retired_reason'] is not None):
                    raise SourceUnavailable()
                receipt_ref = row['receipt_ref']
                if operation == 'apply' and receipt_ref != command.receipt_ref:
                    raise SourceStale()
                earlier = row['observed_at']
                found = True
            elif operation == 'prepare':
                # No durable key under the source lock. Only the still-current
                # original generation/revision can receive the identical retry.
                if (command.generation != stream['current_generation']
                        or command.expected_revision != stream['revision']
                        or command.generation != (earlier.date()-date(1970,1,1)).days):
                    raise SourceStale()
            else:
                receipt_ref = command.receipt_ref
                # An absent Apply key is not enough: validate its genuine READY
                # receipt, original keys, session and expiry under this lock.
                receipt_scope = scope[:4] + (receipt_ref,)
                scalar = status._scalar(connection, receipt_scope,
                    session_id=live.actor.session_id, earlier=earlier)
                _, earlier = status._keys(connection, receipt_scope, scalar)
                if (scalar['state'] != 'ready'
                        or scalar['decision_sha256'] != command.decision_sha256
                        or scalar['prepare_key'] == command.request_key):
                    raise SourceStale()
            del rows, stream
            status._clock(connection, scope, generation=command.generation, earlier=earlier)
            require_account_foobar(live, checked)
            deadline.check()
        deadline.check()
        if receipt_ref is not None:
            # Full genuine codec/hash/key recovery, never merely scalar trust.
            # The next real invocation repeats locks and permissions; this
            # read-only gap cannot bypass its current-state admission.
            recovered = status.read_foobar_import_status(database_url, context,
                source_ref=command.source_ref, generation=command.generation,
                receipt_ref=receipt_ref, constraints=checked)
            if operation == 'prepare':
                if (recovered.prepare_key != command.request_key
                        or recovered.prepare_command_sha256 != digest
                        or recovered.state not in ('ready','committed')
                        or (recovered.state == 'ready'
                            and recovered.original_prepare_command != command)):
                    raise SourceStale()
            elif found:
                if (recovered.state != 'committed'
                        or recovered.apply_key != command.request_key
                        or recovered.apply_command_sha256 != digest
                        or recovered.decision_sha256 != command.decision_sha256):
                    raise SourceStale()
            else:
                original = recovered.original_prepare_command
                if (recovered.state != 'ready' or original is None
                        or recovered.apply_key is not None
                        or recovered.decision_sha256 != command.decision_sha256
                        or original.matching_library_id != command.matching_library_id
                        or recovered.prepare_key == command.request_key):
                    raise SourceStale()
            del recovered
        return FoobarAttemptReconciliation(
            RetryDisposition.REPLAY_SAME_IDENTITY if found
            else RetryDisposition.RETRY_SAME_IDENTITY, receipt_ref)
    except (SourceUnavailable, SourceStale):
        raise
    except Exception:
        raise SourceUnavailable() from None
