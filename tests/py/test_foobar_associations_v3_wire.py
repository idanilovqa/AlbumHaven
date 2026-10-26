"""Real v4 codecs/DTO projectors; authored-only, no codec execution here."""
from dataclasses import replace
from datetime import datetime,timezone
import hashlib
import json
from uuid import UUID
import pytest
from music_app.services import foobar_account_import_terminal as terminal
from music_app.services import foobar_account_prepared_envelope as envelope
from music_app.services import foobar_account_import_status as status
from music_app.routes import foobar_account_import_asgi as route
from tests.py.foobar_account_associations_v3_testing import install,prepare,prepared,p,a,SOURCE,GEN


def maximal_terminal():
    # Maximum legal widths simultaneously: partition all100 into both, each
    # native write count100 and association writes100. Counter digit sum15.
    return (terminal.VERSION,'a'*64,*(SOURCE,)*4,*('b'*64,)*5,
        terminal.MAX_BIGINT-1,terminal.MAX_BIGINT,100000,99901,100001,
        0,0,0,100,100,100,100,2147483647)


def test_actual_maximum_valid_terminal_is_exactly669_and_roundtrips():
    value=maximal_terminal(); payload=terminal.encode_foobar_terminal(value)
    assert len(payload)==669==terminal.MAX_WIRE_BYTES
    assert terminal.decode_foobar_terminal(payload,expected_header=value[:16]+(value[23],))==value
    assert route._terminal(payload)==value
    # Partition enumeration proves no valid six old counters + association
    # counter can use more decimal bytes. Native counts cannot exceed taste sum.
    maximum=0
    for unchanged in range(101):
        for source_only in range(101-unchanged):
            for taste_only in range(101-unchanged-source_only):
                both=100-unchanged-source_only-taste_only
                taste=taste_only+both
                maximum=max(maximum,sum(len(str(v)) for v in (
                    unchanged,source_only,taste_only,both,taste,taste,100)))
    assert maximum==15


@pytest.mark.parametrize('kind',['old_tag','v3_tag','missing_counter','too_many_associations','wrong_revision'])
def test_terminal_v2_or_malformed_v3_rejected(kind):
    value=list(maximal_terminal())
    if kind=='old_tag': value[0]='foobar_acct_end_v2'
    elif kind=='v3_tag': value[0]='foobar_acct_v3'
    elif kind=='missing_counter': del value[22]
    elif kind=='too_many_associations': value[22]=101
    else: value[12]=value[11]
    with pytest.raises(terminal.FoobarTerminalUnavailable):
        terminal.encode_foobar_terminal(tuple(value))


def test_explicit_v4_prepare_ten_fields_and_apply_seven_fields_reject_v2(monkeypatch):
    db=install(monkeypatch); cmd,receipt=prepare(db)
    mapped=p.gate.prepare_command_to_mapping(cmd)
    assert len(mapped)==10 and mapped['version']=='foobar_account_prepare_command_v4'
    assert p.gate.prepare_command_from_mapping(route._command_json(json.dumps(mapped).encode()))==cmd
    for invalid in ({k:v for k,v in mapped.items() if k!='version'},dict(mapped,version='foobar_account_prepare_command_v2'),dict(mapped,version='foobar_account_prepare_command_v3')):
        with pytest.raises(p.gate.PrepareInvalid): p.gate.prepare_command_from_mapping(invalid)
    apply_cmd=a.apply_command.FoobarApplyCommand(SOURCE,GEN,SOURCE,receipt.receipt_ref,receipt.decision_sha256,7)
    mapped=a.apply_command.apply_command_to_mapping(apply_cmd)
    assert len(mapped)==7 and mapped['version']=='foobar_account_apply_command_v4'
    assert a.apply_command.apply_command_from_mapping(mapped)==apply_cmd
    with pytest.raises(a.apply_command.ApplyInvalid):
        a.apply_command.apply_command_from_mapping(dict(mapped,version='foobar_account_apply_command_v2'))
    with pytest.raises(a.apply_command.ApplyInvalid):
        a.apply_command.apply_command_from_mapping(dict(mapped,version='foobar_account_apply_command_v3'))


def test_v3_five_member_envelope_rejects_old_root_even_with_recomputed_hash(monkeypatch):
    db=install(monkeypatch); cmd,receipt=prepare(db); value=prepared(db)
    header=envelope._freeze(value[1])
    for bad in (value[:4],['foobar_account_prepared_v2',*value[1:]],['foobar_account_prepared_v3',*value[1:]]):
        payload=json.dumps(bad,ensure_ascii=True,separators=(',',':')).encode('ascii')
        sha,decision=envelope._digests(payload)
        with pytest.raises(p.SourceUnavailable):
            envelope.decode_prepared_envelope(payload,original_command=cmd,expected_header=header,
                prepared_sha256=sha,decision_sha256=decision)


def test_max_width_real_ready_dto_response_exceeds_old_cap_but_fits12288(monkeypatch):
    db=install(monkeypatch); cmd,receipt=prepare(db)
    # Real DTO projector boundary only. This is not a manufactured durable
    # receipt or an authority fixture. All maximum field types pass real owners.
    maximum=p.gate._MAX
    cmd=replace(cmd,generation=2147483647,expected_revision=maximum,
        offset=99900,matching_library_id=maximum)
    review=tuple((99901+i,str(UUID(int=i+1)),'availability_lost',False) for i in range(100))
    ready=status.FoobarReceiptStatus(source_ref=SOURCE,generation=cmd.generation,
        receipt_ref=receipt.receipt_ref,state='ready',original_session_id=maximum,
        prepare_key=cmd.request_key,prepare_command_sha256='a'*64,apply_key=None,
        apply_command_sha256=None,prepared_sha256='b'*64,decision_sha256='c'*64,
        expires_at=datetime(9999,12,31,23,59,59,999999,tzinfo=timezone.utc),
        original_prepare_command=cmd,terminal_bytes=None,terminal_outcome=None,
        association_review=review)
    projected=route._receipt_wire('status',ready)
    response=route._response({'protocol':route.PROTOCOL,'operation':'status','result':projected})
    assert response.status_code==200 and len(response.body)==8476
    assert 8192<8476<=12288==route.MAX_RESPONSE_BYTES
    assert len(json.loads(response.body)['result']['association_review'])==100
    with pytest.raises(p.SourceUnavailable): route._response({'value':'x'*12288})


@pytest.mark.parametrize('review',[
    ((1,SOURCE,'saved',1),),((1,SOURCE,'explicit_detach',True),),
    ((1,SOURCE,'availability_lost',True),),((2,SOURCE,'saved',True),),
    ((1,SOURCE,'unknown',False),),((1,SOURCE,'saved',True),(2,SOURCE,'saved',True)),
])
def test_real_review_projection_rejects_forged_scalar_or_ordering(review):
    with pytest.raises(p.SourceUnavailable):
        route._association_review(review,committed=False,start=1)
