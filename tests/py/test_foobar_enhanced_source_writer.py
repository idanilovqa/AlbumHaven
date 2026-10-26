"""Authored only: real codec/writer decisions and SQL shape, not SQL execution.

Controlled scalar SQL results exercise genuine postcheck logic; these assertions
do not simulate or claim PostgreSQL evaluation of the generated comparator.
"""
from dataclasses import replace
from hashlib import sha256
import json
import struct

import pytest

from music_app.services import foobar_account_source_postgres as writer
from music_app.services import foobar_enhanced_source_evidence as codec
from music_app.services import foobar_enhanced_entry_readiness as readiness
from music_app.services import foobar_account_history_readiness as history_readiness
from music_app.services import foobar_account_history_postgres as history_reader
from test_foobar_account_source_writer_boundary import SOURCE, OBS, existing, current, item


def enhanced(local=(9, 9, 2), cached=(), *, artifact='a'*64, ordinal=0):
    raw=struct.pack('<IIIi',1,len(local),len(cached),0)+b''.join(
        struct.pack('<Q',tick) for tick in (*local,*cached))
    incoming=codec.EnhancedIncomingEvidence(-7,'parsed',None,raw,len(raw),
        ('C:\\Music\\source.flac',),artifact,ordinal)
    encoded=codec.encode_enhanced_incoming(incoming)
    merged=codec.merge_enhanced_evidence(encoded)
    return writer.SourceWrite(OBS,codec.encode_enhanced_identity(-7),None,None,None,
        merged.effective_bytes,codec.encode_enhanced_display(codec.build_enhanced_display(incoming)),encoded)


def test_same_enhanced_snapshot_other_artifact_origin_retains_original_revision_and_digest():
    old=existing(enhanced())
    new=replace(old,incoming_evidence_bytes=enhanced(artifact='b'*64,ordinal=8).incoming_evidence_bytes)
    assert old.incoming_evidence_bytes!=new.incoming_evidence_bytes
    assert json.loads(old.incoming_evidence_bytes)[:8]==json.loads(new.incoming_evidence_bytes)[:8]
    digest=sha256(old.incoming_evidence_bytes).hexdigest()
    row=current(new,same=True,exact=False,raw_digest=digest)
    assert writer._check_current([row],(new,),incoming_digests=(digest,))==(False,)
    writer._check_current([row],(new,),incoming_digests=(digest,),
        postcheck=True,changed=(False,),revision=7)
    with pytest.raises(writer.SourceStale):
        writer._check_current([dict(row,incoming_evidence_sha256=sha256(new.incoming_evidence_bytes).hexdigest())],
            (new,),incoming_digests=(digest,),postcheck=True,changed=(False,),revision=7)


@pytest.mark.parametrize('local,cached',[((9,2),()),((2,9,9),()),((9,9,2),(4,))])
def test_changed_vector_same_identity_requires_new_revision_exact_postimage(local,cached):
    old=existing(enhanced())
    new=replace(enhanced(local,cached),previous_revision=7,
        previous_evidence_sha256=old.previous_evidence_sha256,
        previous_display_sha256=old.previous_display_sha256)
    assert new.identity_bytes==old.identity_bytes
    assert json.loads(old.incoming_evidence_bytes)[:8]!=json.loads(new.incoming_evidence_bytes)[:8]
    digest=sha256(old.incoming_evidence_bytes).hexdigest()
    row=current(new,same=False,exact=False,raw_digest=digest)
    assert writer._check_current([row],(new,),incoming_digests=(digest,))==(True,)
    post=dict(row,current_revision=8,same_bytes=True,incoming_exact=True,
        evidence_sha256=sha256(new.evidence_bytes).hexdigest(),
        display_sha256=sha256(new.display_bytes).hexdigest(),
        incoming_evidence_sha256=sha256(new.incoming_evidence_bytes).hexdigest())
    writer._check_current([post],(new,),incoming_digests=(digest,),postcheck=True,changed=(True,),revision=7)
    for invalid in (None,0,1,'true'):
        with pytest.raises(writer.SourceUnavailable):
            writer._check_current([dict(post,same_bytes=invalid)],(new,),incoming_digests=(digest,),
                postcheck=True,changed=(True,),revision=7)


def test_typed_comparator_is_shared_by_append_and_postcheck_and_null_fails_closed():
    fragment=writer._incoming_same_sql('old_raw','new_raw','actual_kind')
    assert "actual_kind='store_key'" in fragment
    assert "actual_kind in ('path','occurrence')" in fragment
    assert 'generate_series(0,7)' in fragment and 'generate_series(0,26)' in fragment
    assert fragment.count('coalesce(')==2
    assert 'old_raw is null or new_raw is null then false' in fragment
    assert "else false end)" in fragment
    for sql in (writer._current_sql(),writer._insert_revisions_sql()):
        assert "i.identity_kind='store_key'" in sql
        assert 'generate_series(0,7)' in sql
        assert sql.count('%b')==1
    for field in range(4):
        assert f'p.old_doc->2->n->{field}=p.new_doc->2->n->{field}' in fragment
    assert '->n->4' not in fragment


def test_tiny_enhanced_writer_fits_unchanged_private_cap_and_mixed_batches_reject():
    value=enhanced()
    phase,size,_,_=writer.source_write_phase_bytes((value,),account_id=1,
        source_ref=SOURCE,generation=1,expected_revision=0)
    assert size==len(writer._frame((value,),1,SOURCE,1,0))
    assert phase<=writer.MAX_PHASE_BYTES==4194304
    with pytest.raises(writer.SourceUnavailable):
        writer.source_write_phase_bytes((value,replace(item(),observation_ref=SOURCE)),
            account_id=1,source_ref=SOURCE,generation=1,expected_revision=0)


def test_actual_retained_vector_growth_does_not_reserve_whole_dataset_for_small_records():
    phases=[]
    for count in (1,32,32766):
        value=enhanced(local=(9,)*count)
        phase,_,_,_=writer.source_write_phase_bytes((value,),account_id=1,
            source_ref=SOURCE,generation=1,expected_revision=0)
        phases.append(phase)
    assert phases[0]<phases[1]<phases[2]
    assert phases[1]<=4194304<phases[2]
    # A decoded maximum need not fit composed persistence; never truncate it.


def test_readiness_preserves_compound_grouping_literal_case_and_exact_bounded_shape():
    sql=readiness._SQL
    compound=sql.split('case when e.preserve_grouping then',1)[1].split('else lower(',1)[0]
    assert 'pg_catalog.pg_get_expr(c.conbin,c.conrelid)' in compound
    assert 'lower(' not in compound and 'regexp_replace' not in compound
    assert "'source_ordinal>=0andsource_ordinal<=32765'" in sql
    assert 'i.indisprimary=e.is_primary and i.indisunique=e.is_primary' in sql
    assert "'account_id,source_ref,observation_ref,source_revision,source_ordinal'" in sql
    assert 'AND (((local_entry_count IS NULL) AND (local_vector_sha256 IS NULL)) OR (' in sql
    assert "evidence_kind = ''enhanced_store''::text" in sql
    assert 'c.convalidated and c.condeferrable and c.condeferred' in sql
    main=history_readiness._SCHEMA_SQL
    assert 'pg_catalog.pg_get_expr(i.indpred,i.indrelid)=e.predicate' in main
    assert "lower(regexp_replace(pg_catalog.pg_get_expr(i.indpred" not in main
    assert "identity_kind = ANY (ARRAY[''path''::text, ''occurrence''::text, ''store_key''::text])" in main
    for family in ('standard','enhanced'):
        for kind in ('first_boundary','unknown_dates_bucket','grouped_aggregate'):
            # Genuine query owner, not a copied query builder. Each arm must
            # exclude timestamp-vector headers before ordering and LIMIT.
            assert kind in history_reader._RANK
            arm=history_reader._arm_sql(family,kind,None)
            assert "p.evidence_kind='tsv_snapshot'" in arm
            assert arm.index("p.evidence_kind='tsv_snapshot'")<arm.index('order by')


@pytest.mark.parametrize('ready,write',[(False,True),(None,True),(True,None),(True,False)])
def test_missing_partial_or_wrong_typed_entry_readiness_is_unavailable_and_closes_cursor(ready,write):
    class Cursor:
        closed=False
        def fetchmany(self,count):
            assert count==2
            return [dict(entries_ready=ready,entries_writer_ready=write)]
        def close(self):
            self.closed=True
    class Connection:
        cursor=Cursor()
        def execute(self,sql):
            assert sql==readiness._SQL
            return self.cursor
    connection=Connection()
    with pytest.raises(writer.SourceUnavailable):
        readiness.require_enhanced_entries_on_connection(connection,for_write=True)
    assert connection.cursor.closed
