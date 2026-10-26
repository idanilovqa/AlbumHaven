"""Authored only: genuine serializer rejects impossible evidence tuples."""
import pytest
from music_app.routes import foobar_account_import_asgi as route
from music_app.services import foobar_account_track_evidence as reader
from tests.py.foobar_account_history_native_testing import SOURCE, OBS


def serialize(kind,state,count,status,reason):
    item=reader.TrackEvidenceItem(SOURCE,'2026-10-23T00:00:00.000000Z',OBS,1,1,
        kind,state,count,status,reason)
    return route._track_evidence_wire(reader.TrackEvidencePage(21,'standard',(item,),None),
        reader.TrackEvidenceRequest(21,'standard'))


@pytest.mark.parametrize('kind,state,count,status,reason',[
    ('enhanced_store','valid',0,'ready',None),
    ('enhanced_store','valid',32766,'ready',None),
    ('enhanced_store','unavailable',None,'unavailable','local_timestamp_vector_unavailable'),
    ('tsv_snapshot','valid',0,'ready',None),
    ('tsv_snapshot','valid',9223372036854775807,'ready',None),
    ('tsv_snapshot','invalid',None,'needs_reconciliation','invalid_count'),
    ('tsv_snapshot','absent',None,'unavailable','count_unavailable'),
    ('tsv_snapshot','empty',None,'unavailable','count_unavailable'),
    ('tsv_snapshot','unavailable',None,'unavailable','count_unavailable'),
    ('tsv_snapshot','valid',0,'needs_reconciliation','zero_count_with_boundaries'),
    ('tsv_snapshot','valid',1,'needs_reconciliation','single_count_boundary_conflict'),
    ('tsv_snapshot','valid',1,'needs_reconciliation','boundary_order_conflict'),
    ('tsv_snapshot','valid',2,'needs_reconciliation','boundary_order_conflict'),
])
def test_exact_genuine_count_status_reason_tuples_serialize(kind,state,count,status,reason):
    result=serialize(kind,state,count,status,reason)['items'][0]
    assert result['count']==(None if count is None else str(count))
    assert (result['status'],result['reason'])==(status,reason)


@pytest.mark.parametrize('kind,state,count,status,reason',[
    ('enhanced_store','valid',1,'unavailable','invalid_count'),
    ('enhanced_store','unavailable',None,'needs_reconciliation','invalid_count'),
    ('enhanced_store','valid',32767,'ready',None),
    ('enhanced_store','invalid',None,'needs_reconciliation','invalid_count'),
    ('enhanced_store','valid',1,'needs_reconciliation','single_count_boundary_conflict'),
    ('enhanced_store','unavailable',None,'unavailable','count_unavailable'),
    ('tsv_snapshot','valid',None,'ready',None),
    ('tsv_snapshot','valid',1,'unavailable','count_unavailable'),
    ('tsv_snapshot','invalid',None,'unavailable','invalid_count'),
    ('tsv_snapshot','absent',None,'needs_reconciliation','count_unavailable'),
    ('tsv_snapshot','empty',None,'unavailable',None),
    ('tsv_snapshot','valid',1,'ready','invalid_count'),
    ('tsv_snapshot','valid',1,'needs_reconciliation','zero_count_with_boundaries'),
    ('tsv_snapshot','valid',0,'needs_reconciliation','boundary_order_conflict'),
    ('tsv_snapshot','valid',2,'needs_reconciliation','single_count_boundary_conflict'),
    ('tsv_snapshot','valid',2,'needs_reconciliation','arbitrary_reason'),
])
def test_impossible_tuples_fail_actual_route_serializer(kind,state,count,status,reason):
    with pytest.raises(route.SourceUnavailable):serialize(kind,state,count,status,reason)
