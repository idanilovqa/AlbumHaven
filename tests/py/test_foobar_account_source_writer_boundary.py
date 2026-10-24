"""Independent synthetic/pure and source-shape contracts, authored NOT EXECUTED.

No successful connection/authority doubles. SQL strings are inspected, never sent.
These contracts do not establish native PostgreSQL or coordinated Apply behavior.
"""
import inspect
import json
import re
from dataclasses import replace

import pytest

from music_app.services import foobar_account_source_postgres as writer
from music_app.services import foobar_source_evidence as evidence
from music_app.services import foobar_source_display as display
from music_app.services import foobar_snapshot_parser as parser

SOURCE = '11111111-1111-4111-8111-111111111111'
OBS = '22222222-2222-4222-8222-222222222222'


def fields(payload):
    parsed = parser.parse_foobar_snapshot(payload, mapping_name=evidence.PARSER_VERSION)
    assert parsed.status == 'parsed' and len(parsed.rows) == 1
    return evidence.fields_from_row(parsed.rows[0], upload_sha256=parsed.source_sha256), parsed


def item(payload=b'path\ttitle\n/a\tSynthetic\n'):
    values, parsed = fields(payload)
    encoded = evidence.encode_evidence(values)
    return writer.SourceWrite(OBS, evidence.source_identity(values,
        upload_sha256=parsed.source_sha256, ordinal=1, identity_conflict=False),
        None, None, None, encoded, display.encode_display(values), encoded)


def existing(value, revision=7):
    return replace(value, previous_revision=revision,
        previous_evidence_sha256=evidence.evidence_digest(value.evidence_bytes),
        previous_display_sha256=evidence.evidence_digest(value.display_bytes))


def current(value, *, same, exact, raw_digest):
    return dict(ordinal=1, matching_count=1, observation_ref=value.observation_ref,
        current_revision=value.previous_revision,
        evidence_sha256=value.previous_evidence_sha256,
        display_sha256=value.previous_display_sha256,
        incoming_evidence_sha256=raw_digest, incoming_exact=exact, same_bytes=same)


@pytest.mark.parametrize('account', [1, 9223372036854775807])
@pytest.mark.parametrize('revision', [0, 9223372036854775807])
@pytest.mark.parametrize('generation', [1, 2147483647])
def test_five_member_frame_exact_at_scope_extremes(account, revision, generation):
    value = item(b'path\ttitle\n/a\t\xc3\xa9\\\x0b\n')
    phase, size, base, result = writer.source_write_phase_bytes((value,),
        account_id=account, source_ref=SOURCE, generation=generation, expected_revision=revision)
    wire = writer._frame((value,), account, SOURCE, generation, revision)
    document = json.loads(wire)
    assert len(document) == 5
    assert document[:4] == [account, SOURCE, generation, revision]
    assert document[4] == [[OBS, 'path', value.identity_bytes.hex(), None, None, None,
        value.evidence_bytes.hex(), value.display_bytes.hex(), value.incoming_evidence_bytes.hex()]]
    assert size == len(wire)
    assert phase >= base + 6 * size + 4 + 2 * result


def test_max_batch_and_existing_revision_frame_sizes_are_exact():
    values = tuple(replace(item(('path\ttitle\n/p%d\tSynthetic\n' % n).encode()),
        observation_ref='00000000-0000-4000-8000-%012d' % (n + 1)) for n in range(100))
    values = tuple(existing(value, writer.MAX_REVISION) for value in values)
    _, size, _, _ = writer.source_write_phase_bytes(values, account_id=1,
        source_ref=SOURCE, generation=1, expected_revision=writer.MAX_REVISION)
    assert size == len(writer._frame(values, 1, SOURCE, 1, writer.MAX_REVISION))
    with pytest.raises(writer.SourceUnavailable):
        writer.source_write_phase_bytes(values + (item(),), account_id=1,
            source_ref=SOURCE, generation=1, expected_revision=writer.MAX_REVISION)


@pytest.mark.parametrize('account', [True, False, None, '1', 0, -1, 9223372036854775808])
def test_account_scalar_rejects_coercion(account):
    with pytest.raises(writer.SourceUnavailable):
        writer.source_write_phase_bytes((item(),), account_id=account,
            source_ref=SOURCE, generation=1, expected_revision=0)


def test_library_not_accepted_as_an_ownership_parameter():
    assert 'library_id' not in inspect.signature(writer.source_write_phase_bytes).parameters
    assert 'library_id' not in inspect.signature(writer._frame).parameters
    assert 'library_id' not in inspect.signature(writer.write_foobar_source_on_connection).parameters
    with pytest.raises(TypeError):
        writer.source_write_phase_bytes((item(),), account_id=1, library_id=2,
            source_ref=SOURCE, generation=1, expected_revision=0)


def test_sql_indices_and_every_table_reference_are_account_v2_only():
    prefix = writer._prefix()
    for expected in ('(j->>0)::bigint account_id', '(j->>1)::uuid source_ref',
                     '(j->>2)::bigint generation', '(j->>3)::bigint revision',
                     'jsonb_array_elements(j->4)'):
        assert expected in prefix
    statements = [writer._stream_sql(), writer._stream_sql(touch=True),
        writer._cardinality_sql(), writer._candidates_sql(), writer._current_incoming_sql(),
        writer._current_sql(), writer._insert_observations_sql(),
        writer._insert_revisions_sql(), writer._advance_pointers_sql()]
    tables = set()
    for sql in statements:
        assert sql.count('%b') == 1
        assert 'library' not in sql.lower()
        tables.update(re.findall(r'integration\.([a-z_0-9]+)', sql))
        assert 'account_id' in sql and 'source_ref' in sql
    assert tables == {'foobar_import_streams_v2', 'foobar_import_observations_v2',
                      'foobar_import_revisions_v2'}
    assert '(s.account_id,s.source_ref)=(f.account_id,f.source_ref)' in statements[0]
    assert '(o.account_id,o.source_ref)=(f.account_id,f.source_ref)' in statements[2]
    assert '(r.account_id,r.source_ref,r.observation_ref,r.source_revision)' in statements[-1]
    assert '(f.account_id,f.source_ref,i.observation_ref,i.previous_revision)' in statements[-1]


def test_native_guard_authority_and_admission_order_are_retained():
    body = inspect.getsource(writer.write_foobar_source_on_connection)
    ordered = ['_foobar_taste_connection(connection)', 'account_foobar_context(live_context)',
        'source_write_phase_bytes(', 'evidence.decode_evidence(', '_frame(',
        'with connection.transaction():', '_authority(live_context, constraints)',
        '_stream_sql()', '_stream_sql(touch=True)', '_cardinality_sql()',
        'source_comparison_phase_bytes(', '_current_incoming_sql()',
        '_validate_current_incoming(', '_current_sql()', '_check_current(',
        '_insert_observations_sql()', '_insert_revisions_sql()', '_advance_pointers_sql()']
    positions = [body.index(token) for token in ordered]
    assert positions == sorted(positions)
    assert body.count('_authority(live_context, constraints)') == 2
    assert body.rindex('_authority(live_context, constraints)') > body.index('postcheck=True')
    assert body.rindex('_stream_sql(touch=True)') > body.index('postcheck=True')
    assert 'require_account_foobar(context, constraints)' in inspect.getsource(writer._authority)
    assert '_foobar_taste_context' not in inspect.getsource(writer)
    for forbidden in ('connection.commit(', 'pooled_connection(', 'database_url', 'library.browse.read'):
        assert forbidden not in body
    assert 'set revision=' not in writer._stream_sql(touch=True).lower()
    assert 'for update of s' in writer._stream_sql()


@pytest.mark.parametrize('isolation', ['serializable', 'repeatable read', 'READ COMMITTED', None])
def test_stream_rejects_non_exact_read_committed(isolation):
    with pytest.raises(writer.SourceUnavailable):
        writer._stream([dict(revision=7, current_generation=2, retired_through=0,
            isolation=isolation)], 1, 7)


def test_stream_distinguishes_staleness_and_invalid_native_scalars():
    row = dict(revision=7, current_generation=2, retired_through=1, isolation='read committed')
    writer._stream([row], 2, 7)
    for generation, revision in ((1, 7), (3, 7), (2, 6)):
        with pytest.raises(writer.SourceStale):
            writer._stream([row], generation, revision)
    with pytest.raises(writer.SourceUnavailable):
        writer._stream([dict(row, revision=True)], 2, 1)


def test_raw_only_change_requires_append_and_exact_raw_postimage():
    old, _ = fields(b'path\tplay_count\n/a\t12\n')
    incoming, _ = fields(b'path\tplay_count\n/a\tN/A\n')
    effective = evidence.merge_fields(old, incoming)
    assert effective == old
    value = existing(item(b'path\tplay_count\n/a\t12\n'))
    value = replace(value, incoming_evidence_bytes=evidence.encode_evidence(incoming))
    old_digest = evidence.evidence_digest(evidence.encode_evidence(old))
    row = current(value, same=False, exact=False, raw_digest=old_digest)
    assert writer._check_current([row], (value,), incoming_digests=(old_digest,)) == (True,)
    post = dict(row, current_revision=8, same_bytes=True, incoming_exact=True,
        incoming_evidence_sha256=evidence.evidence_digest(value.incoming_evidence_bytes))
    writer._check_current([post], (value,), incoming_digests=(old_digest,),
        postcheck=True, changed=(True,), revision=7)
    with pytest.raises(writer.SourceStale):
        writer._check_current([dict(post, incoming_exact=False)], (value,),
            incoming_digests=(old_digest,), postcheck=True, changed=(True,), revision=7)


def test_origin_only_repeat_preserves_stored_raw_digest():
    old, _ = fields(b'path\tplay_count\tunknown\n/a\tN/A\tone\n')
    incoming, _ = fields(b'path\tplay_count\tunknown\n/a\tN/A\ttwo\n')
    assert evidence.same_observation(old, incoming)
    assert evidence.encode_evidence(old) != evidence.encode_evidence(incoming)
    value = existing(item(b'path\tplay_count\tunknown\n/a\tN/A\tone\n'))
    value = replace(value, incoming_evidence_bytes=evidence.encode_evidence(incoming))
    digest = evidence.evidence_digest(evidence.encode_evidence(old))
    row = current(value, same=True, exact=False, raw_digest=digest)
    assert writer._check_current([row], (value,), incoming_digests=(digest,)) == (False,)
    writer._check_current([row], (value,), incoming_digests=(digest,),
        postcheck=True, changed=(False,), revision=7)
    with pytest.raises(writer.SourceStale):
        writer._check_current([dict(row, incoming_evidence_sha256=
            evidence.evidence_digest(value.incoming_evidence_bytes))], (value,),
            incoming_digests=(digest,), postcheck=True, changed=(False,), revision=7)


def test_sql_semantic_raw_comparison_ignores_only_origin_and_retains_exact_identity():
    sql = writer._incoming_same_sql('old_raw', 'new_raw', 'actual_kind')
    assert 'generate_series(0,26)' in sql and 'old_raw is null or new_raw is null then false' in sql
    assert "actual_kind in ('path','occurrence')" in sql
    for index in range(4):
        assert 'p.old_doc->2->n->%d=p.new_doc->2->n->%d' % (index, index) in sql
    assert '->n->4' not in sql
    assert 'c.identity_bytes=i.identity_bytes' in writer._current_sql()
    assert 'c.identity_bytes=i.identity_bytes' in writer._current_incoming_sql()
    assert 'or not ' in writer._insert_revisions_sql()
    assert 'r.incoming_evidence_bytes=i.incoming_evidence_bytes' in writer._advance_pointers_sql()


def test_stored_raw_requires_exact_identity_and_digest_before_semantic_sql():
    value = existing(item())
    raw = value.incoming_evidence_bytes
    row = dict(ordinal=1, matching_count=1, observation_ref=OBS, current_revision=7,
        incoming_evidence_sha256=evidence.evidence_digest(raw), incoming_evidence_bytes=raw)
    assert writer._validate_current_incoming([row], (value,)) == (row['incoming_evidence_sha256'],)
    for mutation in (dict(incoming_evidence_sha256='0' * 64),
                     dict(incoming_evidence_bytes=raw + b' '),
                     dict(matching_count=2), dict(ordinal=True)):
        with pytest.raises(writer.SourceUnavailable):
            writer._validate_current_incoming([dict(row, **mutation)], (value,))
    other = item(b'path\ttitle\n/other\tSynthetic\n').incoming_evidence_bytes
    with pytest.raises(writer.SourceUnavailable):
        writer._validate_current_incoming([dict(row, incoming_evidence_bytes=other,
            incoming_evidence_sha256=evidence.evidence_digest(other))], (value,))
    with pytest.raises(writer.SourceStale):
        writer._validate_current_incoming([dict(row, current_revision=6)], (value,))


def test_legacy_unknown_raw_never_becomes_semantic_noop():
    value = existing(item())
    row = dict(ordinal=1, matching_count=1, observation_ref=OBS, current_revision=7,
        incoming_evidence_sha256=None, incoming_evidence_bytes=None)
    assert writer._validate_current_incoming([row], (value,)) == (None,)
    decision = current(value, same=False, exact=None, raw_digest=None)
    assert writer._check_current([decision], (value,), incoming_digests=(None,)) == (True,)
    with pytest.raises(writer.SourceUnavailable):
        writer._check_current([dict(decision, same_bytes=True)], (value,), incoming_digests=(None,))


def test_candidate_revision_join_uses_available_scope_not_unprojected_lateral_columns():
    sql = writer._candidates_sql()
    # Lateral alias o only exports these three columns. Referencing account_id
    # or source_ref on it would be invalid SQL, despite correct ownership intent.
    assert 'select o.observation_ref,o.identity_bytes,o.current_revision' in sql
    tail = sql.split(') o left join integration.foobar_import_revisions_v2 r', 1)[1]
    assert '(r.account_id,r.source_ref,r.observation_ref,r.source_revision)' in tail
    assert '=(f.account_id,f.source_ref,o.observation_ref,o.current_revision)' in tail
    assert 'o.account_id' not in tail and 'o.source_ref' not in tail
