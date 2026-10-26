"""Bounded current-value authority snapshot, not an authority grant or receipt.

Only the genuine locked current_library_transaction caller may supply context.
Native authority/runtime owners remain separate from this private phase.
"""
import hashlib
import json

from .current_actor import CurrentActor, CapabilityGrant, LibraryRelationship
from .policy import PolicyContext, RequestOrigin
from .foobar_import_policy import evaluate_foobar_track_policy
from .foobar_source_evidence import _json_size
from .foobar_source_postgres import SourceUnavailable, _authority
from .track_preferences_postgres import _foobar_taste_connection, _foobar_taste_context

VERSION = 'foobar_authority_v1'
DOMAIN = b'albumhaven.foobar.authority.v1\n'
MAX_BYTES = 4_194_304
CONTROL_BYTES = 8192
_MAX = 9223372036854775807


def _integer(value):
    return type(value) is int and 1 <= value <= _MAX


def _text(value):
    return (type(value) is str and 1 <= len(value) <= 128
            and all(32 <= ord(character) <= 126 for character in value))


def _fixed(context, track_ids):
    _foobar_taste_context(context)
    actor = context.actor
    if (type(context) is not PolicyContext or type(actor) is not CurrentActor
            or type(context.request_origin) is not RequestOrigin
            or type(actor.is_bootstrap_owner) is not bool
            or type(actor.library_relationships) is not tuple
            or len(actor.library_relationships) != 1
            or type(actor.capability_grants) is not tuple
            or not all(_text(value) for value in (
                context.deployment_mode,context.client_surface_class,context.request_origin.origin_type))
            or type(track_ids) is not tuple or len(track_ids) > 100):
        raise SourceUnavailable()
    relationship = actor.library_relationships[0]
    if (type(relationship) is not LibraryRelationship
            or type(relationship.library_id) is not int
            or relationship.library_id != context.library_id
            or not _text(relationship.membership_role)
            or type(relationship.is_primary_owner) is not bool):
        raise SourceUnavailable()
    previous = 0
    for track_id in track_ids:
        if not _integer(track_id) or track_id <= previous:
            raise SourceUnavailable()
        previous = track_id


def _sizes(context, track_ids):
    """No normalized grant/target/root collection or encoded text allocated."""
    _fixed(context,track_ids)
    actor = context.actor
    relation = actor.library_relationships[0]
    grants = 2
    for index, grant in enumerate(actor.capability_grants):
        if (type(grant) is not CapabilityGrant or not _text(grant.capability_key)
                or type(grant.scope_kind) is not str
                or grant.scope_kind not in ('global','library','account')
                or (grant.scope_id is not None if grant.scope_kind == 'global'
                    else not _integer(grant.scope_id))):
            raise SourceUnavailable()
        grants += int(index > 0)+4+_json_size(grant.capability_key)+_json_size(grant.scope_kind)+_json_size(grant.scope_id)
        if 7*grants+CONTROL_BYTES > MAX_BYTES:
            raise SourceUnavailable()
    ids = 2+max(0,len(track_ids)-1)+sum(_json_size(value) for value in track_ids)
    # false is the longer legitimate value for EACH independently evaluated bit.
    targets = 2+max(0,len(track_ids)-1)+sum(4+_json_size(value)+10 for value in track_ids)
    member = 3+_json_size(relation.membership_role)+_json_size(relation.is_primary_owner)
    preimage = (12+_json_size(VERSION)+_json_size(actor.account_id)+_json_size(actor.session_id)
                +_json_size(context.library_id)+_json_size(actor.is_bootstrap_owner)+member
                +_json_size(context.deployment_mode)+_json_size(context.client_surface_class)
                +_json_size(context.request_origin.origin_type)+grants+targets)
    phase = 7*preimage+2*ids+CONTROL_BYTES
    if phase > MAX_BYTES:
        raise SourceUnavailable()
    return preimage,phase


def authority_snapshot_phase_bytes(live_context, *, track_ids):
    """Owner phase only. Caller adds all its other actual live representations."""
    try:
        return _sizes(live_context,track_ids)[1]
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None


def _value(context, track_ids, constraints):
    # Caller MUST admit _sizes before this helper. Native grant order is retained.
    actor = context.actor
    relation = actor.library_relationships[0]
    grants = tuple((grant.capability_key,grant.scope_kind,grant.scope_id)
                   for grant in actor.capability_grants)
    policy_rows = []
    for track_id in track_ids:
        policy = evaluate_foobar_track_policy(context,track_id=track_id,constraints=constraints)
        policy_rows.append((track_id,policy.browse_allowed,policy.taste_allowed))
        del policy
    policies = tuple(policy_rows)
    del policy_rows
    value = (VERSION,actor.account_id,actor.session_id,context.library_id,actor.is_bootstrap_owner,
             (relation.membership_role,relation.is_primary_owner),context.deployment_mode,
             context.client_surface_class,context.request_origin.origin_type,grants,policies)
    del grants,policies
    return value


def authority_snapshot_on_connection(connection, live_context, *, track_ids, constraints=None):
    """Return (digest64, tuple((track_id,browse_allowed,taste_allowed),...)).

    No SQL/locks are acquired here. The native owner must already hold the real
    account/session/membership/grant locks. No historical event/ABA claim.
    """
    try:
        _foobar_taste_connection(connection)
        preimage_bytes,_ = _sizes(live_context,track_ids)
        _authority(live_context,constraints)
        value = _value(live_context,track_ids,constraints)
        if _json_size(value) > preimage_bytes:
            raise SourceUnavailable()
        payload = json.dumps(value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
        if len(payload) > preimage_bytes:
            raise SourceUnavailable()
        digest = hashlib.sha256()
        digest.update(DOMAIN)
        digest.update(payload)
        digest_hex = digest.hexdigest()
        policies = value[10]
        del payload,value,digest
        # Recheck whole-scope policy after resolver calls; never grant by digest.
        _authority(live_context,constraints)
        return digest_hex,policies
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
