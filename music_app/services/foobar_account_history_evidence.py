"""Strict current typed Foobar projection binding, never an authority grant."""
import hashlib

from . import foobar_account_history_projection_writer as snapshots
from . import foobar_enhanced_entry_projection as entries
from .foobar_account_source_postgres import SourceUnavailable

EXTRA_KEYS = frozenset(('evidence_kind', 'local_entry_count', 'local_vector_sha256'))


def decode_current_projection(row, *, expected_revision=None):
    if type(row) is not dict or set(row) != snapshots._BINDING_KEYS | EXTRA_KEYS:
        raise SourceUnavailable()
    kind = row['evidence_kind']
    if kind == 'tsv_snapshot':
        if row['local_entry_count'] is not None or row['local_vector_sha256'] is not None:
            raise SourceUnavailable()
        return kind, snapshots.decode_bound_projection(
            {key: value for key, value in row.items() if key not in EXTRA_KEYS},
            expected_revision=expected_revision)
    if kind != 'enhanced_store':
        raise SourceUnavailable()
    payload = row['projection_bytes']
    if type(payload) is not bytes or not 1 <= len(payload) <= entries.MAX_HEADER_BYTES:
        raise SourceUnavailable()
    if hashlib.sha256(payload).hexdigest() != row['projection_sha256']:
        raise SourceUnavailable()
    try:
        header = entries.decode_enhanced_history_header(payload)
    except entries.EnhancedProjectionInvalid:
        raise SourceUnavailable() from None
    if (type(row['source_revision']) is not int or type(row['current_revision']) is not int
            or row['source_revision'] != row['current_revision']
            or header.source_revision != row['source_revision']
            or expected_revision is not None and row['source_revision'] != expected_revision
            or header.effective_evidence_sha256 != row['effective_evidence_sha256']
            or header.display_sha256 != row['display_sha256']
            or row['effective_evidence_sha256'] != row['current_effective_sha256']
            or row['display_sha256'] != row['current_display_sha256']
            or type(row['local_entry_count']) is not type(header.local_entry_count)
            or row['local_entry_count'] != header.local_entry_count
            or row['local_vector_sha256'] != header.local_vector_sha256
            or row['standard_first'] is not None or row['enhanced_first'] is not None
            or type(row['standard_last']) is not int or row['standard_last'] != entries.UNKNOWN_TIME
            or type(row['enhanced_last']) is not int or row['enhanced_last'] != entries.UNKNOWN_TIME
            or row['standard_last_present'] is not False or row['enhanced_last_present'] is not False):
        raise SourceUnavailable()
    return kind, header


def has_positive_local_evidence(kind, projection, *, count_family):
    """True/False for available evidence, None for unavailable or contradictory evidence.

    No lifetime count, timestamp dedupe or Full inference."""
    if count_family not in ('standard', 'enhanced'):
        raise SourceUnavailable()
    if kind == 'enhanced_store' and type(projection) is entries.EnhancedHistoryHeader:
        return None if projection.local_entry_count is None else projection.local_entry_count > 0
    if kind == 'tsv_snapshot' and type(projection) is snapshots.codec.AccountHistoryProjection:
        family = getattr(projection, count_family)
        return (family.total > 0 if family.status == 'ready' and family.count_state == 'valid' else None)
    raise SourceUnavailable()
