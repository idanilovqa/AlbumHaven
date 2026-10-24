"""Account-self authority digest for the explicit no-library prepared protocol.

A digest is continuity evidence, never account authentication or permission.
The genuine outer account/session transaction remains the authority owner.
"""
import hashlib
import json

from .foobar_account_authority import account_foobar_context, require_account_foobar
from .foobar_source_postgres import SourceUnavailable
from .track_preferences_postgres import _foobar_taste_connection
from .foobar_source_evidence import _json_size

VERSION = 'foobar_account_authority_v1'
DOMAIN = b'albumhaven.foobar.account.authority.v1\n'
CONTROL_BYTES = 8192
MAX_BYTES = 4194304


def _value(context, track_ids):
    if context.library_id is not None or type(track_ids) is not tuple or track_ids:
        raise SourceUnavailable()
    live = account_foobar_context(context)
    labels = (live.deployment_mode, live.client_surface_class, live.request_origin.origin_type)
    if any(type(v) is not str or not 1 <= len(v) <= 128
           or any(ord(c) < 32 or ord(c) > 126 for c in v) for v in labels):
        raise SourceUnavailable()
    return (VERSION, live.actor.account_id, live.actor.session_id, None, *labels)


def authority_snapshot_phase_bytes(live_context, *, track_ids):
    if live_context.library_id is not None:
        from . import foobar_authority_snapshot as native
        return native.authority_snapshot_phase_bytes(live_context, track_ids=track_ids)
    value = _value(live_context, track_ids)
    size = _json_size(value)
    phase = 7*size + CONTROL_BYTES
    if phase > MAX_BYTES:
        raise SourceUnavailable()
    return phase


def authority_snapshot_on_connection(connection, live_context, *, track_ids, constraints=None):
    if live_context.library_id is not None:
        from . import foobar_authority_snapshot as native
        return native.authority_snapshot_on_connection(connection, live_context, track_ids=track_ids, constraints=constraints)
    try:
        _foobar_taste_connection(connection)
        authority_snapshot_phase_bytes(live_context, track_ids=track_ids)
        require_account_foobar(live_context, constraints)
        value = _value(live_context, track_ids)
        payload = json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')
        digest = hashlib.sha256(DOMAIN + payload).hexdigest()
        require_account_foobar(live_context, constraints)
        return digest, ()
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
