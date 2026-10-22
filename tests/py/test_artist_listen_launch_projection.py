"""Contract-first fixed Top projector orchestration; no scripted SQL authority claim."""
from copy import deepcopy
from dataclasses import replace
import pytest
from music_app.services import library_browse_postgres as browse
from music_app.services import private_library_authority as authority
from music_app.services import admin_member_mutation_postgres as sessions
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_artist_loved_browse_projection import (
    io, copied_payload, connection, Step, row, receipt, context, LIBRARY, ROOT, NAME, REF, NOW, aliases)

BROWSE = 'library.browse.read'
CREATE = 'library.album_tops.create'
LOVED_CREATE = 'library.playlists.create'


def launch(identity=ROOT, reference=REF):
    return {'context_ref': reference, 'artist_ref': NAME,
            'artist_scope': {'root_artist_id': str(identity), 'mode': 'artist'}}


def project(con, copied, memo, found, *, supplied=None, constraints=None, reference=REF):
    return browse.project_artist_listen_through_browse_launches(con,
        context=supplied or context(grants=(BROWSE, CREATE)), constraints=constraints,
        context_ref=reference, receipts=found, payload=copied, copy_memo=memo, clock=lambda: NOW)


def test_exact_group_page_bigint_projection_stays_staged_and_family_starts_off(io):
    original, copied, memo, found = copied_payload()
    before = deepcopy(copied)
    con = connection([Step('id=any', [row()], (LIBRARY, [ROOT]), clauses=('order by id', 'for share'))])
    staged = project(con, copied, memo, iter(found))
    assert original == before and copied == before
    assert len(staged) == 2
    assert staged[0][0] is copied['artist_groups'][0] is copied['primary_artist_groups'][0]
    assert staged[1][0] is copied['artist_page']
    assert all(item[1:] == ('artist_listen_through_launch', launch()) for item in staged)
    assert len(io.session_calls) == 1
    assert io.session_calls[0][1]['actor_session_id'] == context().actor.session_id
    con.done()


@pytest.mark.parametrize('case', ['equal_unreceipted', 'missing_memo', 'renamed', 'foreign_library', 'sidebar', 'forged_payload_id'])
def test_only_exact_producer_identity_can_launch(io, case):
    original, copied, memo, found = copied_payload()
    found = found[:1]
    if case == 'equal_unreceipted': found = [receipt(deepcopy(original['artist_groups'][0]))]
    elif case == 'missing_memo': memo = {}
    elif case == 'renamed': copied['artist_groups'][0]['artist'] = 'Other'
    elif case == 'foreign_library': found = [replace(found[0], inventory_library_id=LIBRARY + 1)]
    elif case == 'sidebar': copied = {'artists_sidebar': copied['artist_groups']}
    else:
        found = []
        copied['artist_groups'][0]['root_artist_id'] = ROOT
        copied['artist_groups'][0]['artist_listen_through_launch'] = launch()
    con = connection()
    assert project(con, copied, memo, found) == []
    con.done()


@pytest.mark.parametrize('rows', [[], [row(ROOT + 1)], [dict(row(), artist_key='wrong')], [dict(row(), name='Other')]])
def test_deleted_recreated_or_renamed_root_never_rebinds(io, rows):
    _, copied, memo, found = copied_payload()
    con = connection([Step('id=any', rows)])
    assert project(con, copied, memo, found) == []
    con.done()


@pytest.mark.parametrize('state', [
    {**aliases(), 'projection_stale_reason': 'stale'},
    {'alias_to_canonical': {'Alias': NAME, ' alias ': 'Other'}, 'canonical_to_aliases': {NAME: ['Alias']}},
    {'alias_to_canonical': {'Alias': 'Other'}, 'canonical_to_aliases': {NAME: ['Alias']}},
])
def test_alias_change_or_conflict_suppresses_top_launch(io, monkeypatch, state):
    monkeypatch.setattr(browse, 'load_current_library_relation_alias_maps', lambda *a: state)
    _, copied, memo, found = copied_payload()
    con = connection([Step('id=any', [row()])])
    assert project(con, copied, memo, found) == []
    con.done()


def test_loved_policy_denial_does_not_gate_top_projection(io):
    _, copied, memo, found = copied_payload()
    seen = []
    def constraints(ctx):
        seen.append(ctx.action)
        return PolicyEvaluationConstraints(request_origin_allowed=ctx.action != LOVED_CREATE)
    con = connection([Step('id=any', [row()])])
    assert len(project(con, copied, memo, found, constraints=constraints)) == 2
    assert CREATE in seen and LOVED_CREATE not in seen
    con.done()


def test_top_create_denial_rejects_before_root_query_even_when_loved_is_allowed(io):
    _, copied, memo, found = copied_payload()
    con = connection()
    with pytest.raises(authority.PrivateLibraryAuthorityError):
        project(con, copied, memo, found, constraints=lambda ctx:
            PolicyEvaluationConstraints(request_origin_allowed=ctx.action != CREATE))
    con.done()


def test_final_root_policy_recheck_removes_staged_candidates(io):
    _, copied, memo, found = copied_payload()
    calls = []
    def constraints(ctx):
        if ctx.resource is not None: calls.append(ctx.resource.resource_ref)
        return PolicyEvaluationConstraints(request_origin_allowed=len(calls) <= 2)
    assert project(connection([Step('id=any', [row()])]), copied, memo, found, constraints=constraints) == []
    assert calls == [str(ROOT)] * 4


def test_final_global_top_create_recheck_rejects_after_root_wait(io):
    _, copied, memo, found = copied_payload()
    calls = []
    def constraints(ctx):
        if ctx.action == CREATE: calls.append(True)
        return PolicyEvaluationConstraints(request_origin_allowed=len(calls) < 2)
    with pytest.raises(authority.PrivateLibraryAuthorityError):
        project(connection([Step('id=any', [row()])]), copied, memo, found, constraints=constraints)
    assert calls == [True, True]


def test_final_session_failure_exposes_no_staged_fields(io, monkeypatch):
    original, copied, memo, found = copied_payload()
    def expired(*args, **kwargs): raise authority.PrivateLibraryAuthorityError('expired')
    monkeypatch.setattr(sessions, 'lock_current_actor_session', expired)
    with pytest.raises(authority.PrivateLibraryAuthorityError):
        project(connection([Step('id=any', [row()])]), copied, memo, found)
    assert copied == original


@pytest.mark.parametrize('library', [True, 0, -1, 2**63, LIBRARY + 1])
def test_invalid_or_changed_caller_library_fails_before_root_access(io, library):
    _, copied, memo, found = copied_payload()
    con = connection()
    with pytest.raises((authority.PrivateLibraryAuthorityError, ValueError)):
        project(con, copied, memo, found, supplied=replace(context(grants=(BROWSE, CREATE)), library_id=library))
    con.done()


@pytest.mark.parametrize('reference', [None, '', 'A' * 64, REF + '\n'])
def test_missing_or_noncanonical_context_stamp_has_no_launch(io, reference):
    _, copied, memo, found = copied_payload()
    con = connection()
    assert project(con, copied, memo, found, reference=reference) == []
    con.done()


def test_projector_requires_caller_transaction(io):
    _, copied, memo, found = copied_payload()
    con = connection(); con.autocommit = True
    with pytest.raises(ValueError): project(con, copied, memo, found)
    con.done()


@pytest.mark.parametrize('producer_library', [LIBRARY, LIBRARY + 1])
def test_actual_producer_receipt_only_launches_in_original_caller_library(io, producer_library):
    group = {'artist': NAME, 'albums': [], 'root_artist_id': 17}
    original = {'artist_groups': [group]}
    found = []
    capture = connection([Step('app.bootstrap_owners', [{'library_id': producer_library}]),
        Step('artist_key=any', [row()])])
    browse._capture_artist_loved_browse_roots(capture,
        targets=[(group, 'group', NAME, 'Alias')], collector=found)
    capture.done(); assert len(found) == 1
    memo = {}; copied = deepcopy(original, memo)
    con = connection([Step('id=any', [row()])] if producer_library == LIBRARY else [])
    staged = project(con, copied, memo, found)
    assert len(staged) == (1 if producer_library == LIBRARY else 0)
    if staged: assert staged[0][2] == launch()
    assert copied == original; con.done()
