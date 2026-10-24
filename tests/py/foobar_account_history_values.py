"""Authored-only fixtures using the actual parser/evidence/display codecs.

No product module or test was imported, compiled, collected or executed while
this file was authored. Payloads are synthetic, not user library or account data.
"""
from hashlib import sha256
from music_app.services import foobar_snapshot_parser as parser
from music_app.services import foobar_source_evidence as evidence
from music_app.services import foobar_source_display as display
from music_app.services import foobar_account_history_projection as codec

SOURCE = '11111111-1111-4111-8111-111111111111'
OTHER_SOURCE = '44444444-4444-4444-8444-444444444444'
OBS = '22222222-2222-4222-8222-222222222222'
FIRST = '2026-01-01T00:00:00Z'
LAST = '2026-01-02T00:00:00Z'


def digest(value):
    return sha256(value).hexdigest()


def payload(**cells):
    values = dict(path='/synthetic.flac', artist='Synthetic artist', title='Synthetic title', album='Synthetic album')
    values.update(cells)
    values = {name: str(value) for name, value in values.items() if value is not None}
    return ('\t'.join(values) + '\n' + '\t'.join(values.values()) + '\n').encode('utf-8')


def materialize(*, raw=None, **cells):
    raw = payload(**cells) if raw is None else raw
    parsed = parser.parse_foobar_snapshot(raw, mapping_name=evidence.PARSER_VERSION)
    assert parsed.status == 'parsed' and len(parsed.rows) == 1
    fields = evidence.fields_from_row(parsed.rows[0], upload_sha256=parsed.source_sha256)
    return evidence.encode_evidence(fields), display.encode_display(fields)


def projection(*, revision=1, raw=None, **cells):
    effective, labels = materialize(raw=raw, **cells)
    return codec.build_account_history_projection(effective_evidence_bytes=effective,
        display_bytes=labels, source_revision=revision)


def bound_row(value):
    """Literal storage projection, not a substitute for production validation."""
    body = codec.encode_account_history_projection(value)
    def last_present(family):
        return family.aggregate_remainder is None or family.aggregate_remainder > 0 or family.total == 0
    return dict(source_revision=value.source_revision, projection_bytes=body,
        projection_sha256=digest(body), effective_evidence_sha256=value.effective_evidence_sha256,
        display_sha256=value.display_sha256, standard_first=value.standard.first_sort_key,
        standard_last=value.standard.grouped_sort_key, enhanced_first=value.enhanced.first_sort_key,
        enhanced_last=value.enhanced.grouped_sort_key,
        standard_last_present=last_present(value.standard), enhanced_last_present=last_present(value.enhanced),
        current_revision=value.source_revision, current_effective_sha256=value.effective_evidence_sha256,
        current_display_sha256=value.display_sha256)
