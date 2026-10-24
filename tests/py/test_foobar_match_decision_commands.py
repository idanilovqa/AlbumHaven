"""AUTHORED ONLY. Actual closed command owner; no parallel protocol implementation."""
import json

import pytest
from music_app.services import foobar_account_match_decisions as matches
from music_app.routes import foobar_account_import_asgi as route

SOURCE='11111111-1111-4111-8111-111111111111'
OBS='66666666-6666-4666-8666-666666666666'
OP='77777777-7777-4777-8777-777777777777'
DECISION='88888888-8888-4888-8888-888888888888'


def mapping(**changes):
    value=dict(version='foobar_account_match_decision_v1',source_ref=SOURCE,
        observation_ref=OBS,operation_ref=OP,action='match',library_id=7,
        original_track_id=21,expected_decision_ref=None,expected_match_version=None)
    value.update(changes)
    return value


@pytest.mark.parametrize('action,target',[('match',21),('rematch',22),('detach',None)])
def test_real_command_json_roundtrip_retains_exact_identity_and_expected_pair(action,target):
    value=mapping(action=action,original_track_id=target,
        expected_decision_ref=DECISION,expected_match_version=4)
    command=matches.command_from_mapping(route._command_json(json.dumps(value).encode()))
    assert matches.command_to_mapping(command)==value
    assert command.operation_ref==OP and command.source_ref==SOURCE
    assert command.expected_decision_ref==DECISION and command.expected_match_version==4


@pytest.mark.parametrize('changes',[
    {'version':'foobar_account_match_decision_v0'},
    {'action':'overwrite'}, {'library_id':None}, {'library_id':True}, {'library_id':0},
    {'original_track_id':False}, {'original_track_id':0}, {'original_track_id':None},
    {'action':'detach','original_track_id':21},
    {'expected_decision_ref':DECISION,'expected_match_version':None},
    {'expected_decision_ref':None,'expected_match_version':1},
    {'expected_decision_ref':DECISION,'expected_match_version':True},
    {'expected_decision_ref':DECISION,'expected_match_version':0},
    {'source_ref':'not-a-uuid'}, {'operation_ref':OBS+'extra'},
])
def test_real_command_owner_rejects_semantic_or_scalar_malformed_input(changes):
    with pytest.raises(ValueError):
        matches.command_from_mapping(mapping(**changes))


@pytest.mark.parametrize('missing',tuple(mapping()))
def test_command_requires_every_explicit_field(missing):
    value=mapping(); del value[missing]
    with pytest.raises(ValueError):
        matches.command_from_mapping(value)


def test_command_rejects_extra_fields_duplicate_keys_and_excess_bytes():
    with pytest.raises(ValueError):
        matches.command_from_mapping(mapping(trusted=True))
    raw=json.dumps(mapping(),separators=(',',':')).encode()
    duplicate=raw[:-1]+b',"operation_ref":"'+OP.encode()+b'"}'
    with pytest.raises(route._Invalid):
        route._command_json(duplicate)
    with pytest.raises(route._Invalid):
        route._command_json(raw+b' '*2049)
