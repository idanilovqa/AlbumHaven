"""Closed unpublished Apply command. No write, replay or authority grant."""
from dataclasses import dataclass
import hashlib
import json
from . import foobar_account_prepare_gate as gate

VERSION = 'foobar_account_apply_command_v4'
DOMAIN = b'albumhaven.foobar.account.apply.command.v4\n'
MAX_BYTES = 1024
MAX_PHASE_BYTES = 5*MAX_BYTES+512
_KEYS = frozenset(('version','source_ref','generation','request_key','receipt_ref','decision_sha256','matching_library_id'))


class ApplyInvalid(ValueError):
    code = 'invalid_import_request'
    status_code = 400
    retryable = False

    def __init__(self):
        super().__init__('Import request is invalid.')


@dataclass(frozen=True, slots=True)
class FoobarApplyCommand:
    source_ref: str
    generation: int
    request_key: str
    receipt_ref: str
    decision_sha256: str
    matching_library_id: int | None


def validate_apply_command(command):
    try:
        if (type(command) is not FoobarApplyCommand
                or not gate._uuid(command.source_ref)
                or not gate._integer(command.generation,1,2147483647)
                or not gate._uuid(command.request_key)
                or not gate._uuid(command.receipt_ref)
                or not gate._hex(command.decision_sha256)
                or (command.matching_library_id is not None
                    and not gate._integer(command.matching_library_id,1,9223372036854775807))):
            raise ApplyInvalid()
    except ApplyInvalid:
        raise
    except Exception:
        raise ApplyInvalid() from None


def apply_command_from_mapping(value):
    # The actual route must bound and strictly decode its request body first.
    # Cardinality comes before set construction or any value copying.
    if (type(value) is not dict or len(value) != 7 or set(value) != _KEYS
            or type(value['version']) is not str or value['version'] != VERSION):
        raise ApplyInvalid()
    command = FoobarApplyCommand(value['source_ref'],value['generation'],value['request_key'],
                                 value['receipt_ref'],value['decision_sha256'],value['matching_library_id'])
    validate_apply_command(command)
    return command


def apply_command_bytes(command, *, account_id, library_id, session_id):
    """Bind original matching scope even when that library is no longer live."""
    validate_apply_command(command)
    if (type(library_id) is not type(command.matching_library_id)
            or library_id != command.matching_library_id
            or any(not gate._integer(v,1,9223372036854775807) for v in (account_id,session_id))):
        raise ApplyInvalid()
    value = (VERSION,account_id,command.matching_library_id,session_id,command.source_ref,command.generation,
             command.request_key,command.receipt_ref,command.decision_sha256)
    encoded = json.dumps(value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(encoded) > MAX_BYTES:
        raise ApplyInvalid()
    return encoded


def apply_command_digest(command, *, account_id, library_id, session_id):
    payload = apply_command_bytes(command,account_id=account_id,library_id=library_id,session_id=session_id)
    digest = hashlib.sha256()
    digest.update(DOMAIN)
    digest.update(payload)
    return digest.hexdigest()


def apply_command_to_mapping(command):
    """Retain original matching scope with the operation key across retries."""
    validate_apply_command(command)
    return {'version':VERSION,**{key:getattr(command,key) for key in (
        'source_ref','generation','request_key','receipt_ref','decision_sha256','matching_library_id')}}
