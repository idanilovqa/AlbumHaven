from __future__ import annotations

from copy import deepcopy
import importlib
import importlib.util

import pytest


@pytest.fixture
def suggestions():
    name = 'music_app.services.problem_suggestions'
    assert importlib.util.find_spec(name) is not None, 'approved proposal computation service must exist'
    return importlib.import_module(name)


def entry(**changes):
    return {
        'path': '/test-library/album/track.flac', 'mtime': 100.0, 'size': 4096,
        'title': 'a quiet song', 'artist': 'Artist', 'album_artist': 'Artist',
        'album': 'a quiet album', 'year': 2008, 'track_number': 4, 'disc_number': 1,
        **changes,
    }


def generate(service, value, **kwargs):
    return service.build_problem_suggestions(value['path'], value, **kwargs)


def test_unique_reversible_encoding_preserves_casing_and_never_mutates_source(suggestions):
    value = entry(artist='JosÃ©', title='a quiet song')
    before = deepcopy(value)
    proposals = generate(suggestions, value)
    artist = next(item for item in proposals if item['field'] == 'artist')
    assert artist['original'] == 'JosÃ©'
    assert artist['corrected'] == 'José'
    assert artist['updates'] == {'artist': 'José'}
    assert not any(item['field'] == 'title' for item in proposals)
    assert value == before


@pytest.mark.parametrize('text', ['Jos�', 'Jos??', '?', 'plain lower case'])
def test_lossy_or_valid_text_is_not_an_encoding_proposal(suggestions, text):
    assert not any(item['field'] == 'artist' for item in generate(suggestions, entry(artist=text)))


def test_explicit_canonical_alias_is_used_without_generic_title_casing(suggestions):
    proposals = generate(suggestions, entry(artist='the alias'), alias_to_canonical={'the alias': 'the CANONICAL'})
    assert any(item['updates'] == {'artist': 'the CANONICAL'} for item in proposals)


@pytest.mark.parametrize('source,target', [('Artist feat. Guest', 'Artist'), ('Alias', 'Artist & Guest')])
def test_collaboration_mapping_is_not_a_single_artist_proposal(suggestions, source, target):
    assert not any(item['field'] == 'artist' for item in generate(suggestions, entry(artist=source), alias_to_canonical={source: target}))


def test_single_disc_marker_is_one_coupled_album_and_disc_proposal(suggestions):
    proposals = generate(suggestions, entry(album='a quiet album (disc 2)', disc_number=None))
    proposal = next(item for item in proposals if item['field'] == 'album_disc_marker')
    assert proposal['updates'] == {'album': 'a quiet album', 'disc_number': 2}
    assert len([item for item in proposals if 'album' in item['updates'] or 'disc_number' in item['updates']]) == 1


@pytest.mark.parametrize('album,disc', [('a quiet album (disc 2)', 1), ('album disc 1 disc 2', None)])
def test_conflicting_or_multiple_disc_markers_have_no_proposal(suggestions, album, disc):
    assert not any(item['field'] == 'album_disc_marker' for item in generate(suggestions, entry(album=album, disc_number=disc)))


@pytest.mark.parametrize('field', ['year', 'track_number'])
def test_missing_numeric_tags_require_evidence_for_the_exact_track(suggestions, field):
    value = entry(**{field: None})
    assert not any(item['field'] == field for item in generate(suggestions, value))
    evidence = {'track_path': value['path'], 'source_id': 'verified-release-recording', 'values': {field: 2008 if field == 'year' else 4}}
    proposals = generate(suggestions, value, verified_metadata=evidence)
    assert any(item['updates'] == {field: evidence['values'][field]} for item in proposals)
    evidence['track_path'] = '/other-library/other-track.flac'
    assert not any(item['field'] == field for item in generate(suggestions, value, verified_metadata=evidence))


def test_missing_number_does_not_use_filename_position_or_album_year(suggestions):
    value = entry(path='/test-library/2008-album/04 title.flac', year=None, track_number=None)
    assert not any(item['field'] in {'year', 'track_number'} for item in generate(suggestions, value))


@pytest.mark.parametrize('field', ['artist', 'album_artist', 'title', 'album'])
def test_missing_text_has_no_fabricated_correction(suggestions, field):
    assert not any(item['field'] == field for item in generate(suggestions, entry(**{field: ''})))


def test_proposal_ids_are_stable_opaque_and_change_when_source_revision_changes(suggestions):
    value = entry(artist='JosÃ©')
    first = generate(suggestions, value)
    second = generate(suggestions, deepcopy(value))
    assert first == second
    proposal = next(item for item in first if item['field'] == 'artist')
    assert value['path'] not in proposal['id']
    assert 'Jos' not in proposal['id']
    changed = next(item for item in generate(suggestions, {**value, 'mtime': 101.0}) if item['field'] == 'artist')
    assert changed['id'] != proposal['id']
    assert changed['source_revision'] != proposal['source_revision']


def test_validation_recomputes_exact_current_updates(suggestions):
    value = entry(artist='JosÃ©')
    proposal = next(item for item in generate(suggestions, value) if item['field'] == 'artist')
    reads = []
    def read_metadata(path):
        reads.append(path)
        return deepcopy(value)
    result = suggestions.validate_problem_suggestions([proposal['id']], {value['path']: value}, read_metadata=read_metadata)
    assert result == {value['path']: {'artist': 'José'}}
    assert reads == [value['path']]


@pytest.mark.parametrize('change', [{'mtime': 101.0}, {'artist': 'Edited externally'}, {'size': 4097}])
def test_validation_rejects_stale_physical_source_before_write(suggestions, change):
    value = entry(artist='JosÃ©')
    proposal = next(item for item in generate(suggestions, value) if item['field'] == 'artist')
    with pytest.raises(ValueError):
        suggestions.validate_problem_suggestions([proposal['id']], {value['path']: value}, read_metadata=lambda path: {**value, **change})


def test_validation_rejects_unknown_or_foreign_proposal(suggestions):
    value = entry(artist='JosÃ©')
    proposal = next(item for item in generate(suggestions, value) if item['field'] == 'artist')
    for identifiers in [['unknown-proposal'], [proposal['id']]]:
        with pytest.raises(ValueError):
            suggestions.validate_problem_suggestions(identifiers, {}, read_metadata=lambda path: pytest.fail('foreign target must not be read'))


def test_multiple_reversible_plausible_candidates_are_not_resolved_by_enumeration_order(suggestions, monkeypatch):
    # Both candidates reverse to the same source under supported codecs.
    original = 'Ã©'
    candidates = ['é', original.encode('latin-1').decode('cp1251')]
    assert len(set(candidates)) == 2
    monkeypatch.setattr(suggestions, '_repair_text_candidates', lambda text: candidates)
    monkeypatch.setattr(suggestions, 'looks_like_mojibake', lambda text, **_options: text == original)
    monkeypatch.setattr(suggestions, '_text_readability_score', lambda text: 0 if text == original else 20)
    assert not any(item['field'] == 'artist' for item in generate(suggestions, entry(artist=original)))


@pytest.mark.parametrize('reason', [
    'Album name mismatch', 'Album artist mismatch', 'Year mismatch', 'Inconsistent year',
    'Missing cover art', 'Poor art quality', 'Duplicate files', 'Album not found',
    'Incomplete track order: Disc 1 missing 2', 'Library watcher overflow', 'Root unavailable',
])
def test_detection_alone_does_not_fabricate_a_tag_proposal(suggestions, reason):
    assert generate(suggestions, entry(problem_reasons=[reason])) == []


def test_verified_year_retains_full_date_instead_of_truncating_to_album_year(suggestions):
    value = entry(year=None)
    evidence = {'track_path': value['path'], 'source_id': 'verified-release', 'values': {'year': '2008-04-03'}}
    proposal = next(item for item in generate(suggestions, value, verified_metadata=evidence) if item['field'] == 'year')
    assert proposal['updates'] == {'year': '2008-04-03'}


def test_invalid_calendar_date_is_not_accepted_as_verified_year(suggestions):
    value = entry(year=None)
    evidence = {'track_path': value['path'], 'source_id': 'verified-release', 'values': {'year': '2008-99-99'}}
    assert not any(item['field'] == 'year' for item in generate(suggestions, value, verified_metadata=evidence))


def test_repeated_proposal_id_is_rejected_before_metadata_reads(suggestions):
    value = entry(album='album disc 2', disc_number=None)
    proposal = next(item for item in generate(suggestions, value) if item['field'] == 'album_disc_marker')
    with pytest.raises(ValueError):
        suggestions.validate_problem_suggestions([proposal['id'], proposal['id']], {value['path']: value}, read_metadata=lambda path: pytest.fail('duplicate selection must not read metadata'))


def test_reused_suggestion_payload_does_not_retain_previously_granted_actions(monkeypatch):
    from types import SimpleNamespace
    from music_app.routes import api_read_asgi_routes as routes

    grants = {'library.files.edit_tags': True, 'library.rules.manage': True}
    monkeypatch.setattr(routes, 'allowed_actions_for_request', lambda *_args: SimpleNamespace(as_payload=lambda: dict(grants)))
    payload = {'suggested_edits': [], 'allowed_actions': {}}
    routes._project_missing_album_actions_for_request(object(), payload)
    assert payload['allowed_actions']['library.files.edit_tags'] is True
    grants.clear()
    routes._project_missing_album_actions_for_request(object(), payload)
    assert not payload['allowed_actions'].get('library.files.edit_tags')
    assert not payload['allowed_actions'].get('library.rules.manage')


@pytest.mark.parametrize('payload,status,expected', [
    ({'ok': True, 'save_task_status': 'completed'}, 200, 'committed'),
    ({'ok': True}, 200, 'rejected'),
    ({'ok': True, 'save_task_status': 'pending'}, 200, 'recovery_pending'),
    ({'ok': False, 'proposal_status': 'stale'}, 409, 'stale'),
    ({'ok': False, 'edit_outcome': 'failed_rolled_back'}, 500, 'failed_rolled_back'),
    ({'ok': False, 'edit_outcome': 'recovery_pending'}, 500, 'recovery_pending'),
    ({'ok': False, 'save_task_status': 'failed'}, 500, 'recovery_pending'),
    ({'ok': False, 'error': 'denied'}, 403, 'rejected'),
])
def test_proposal_outcomes_report_only_authoritatively_committed_batch(payload, status, expected):
    from music_app.routes import api_wave_a_asgi_routes as routes

    original = dict(payload)
    result, actual_status = routes._with_problem_suggestion_outcomes((payload, status), ['proposal-a', 'proposal-b'])
    assert actual_status == status
    assert result['proposal_outcomes'] == [{'id': 'proposal-a', 'status': expected}, {'id': 'proposal-b', 'status': expected}]
    assert payload == original


@pytest.mark.parametrize('reverse_result', [(False, []), (True, []), (True, ['artist'])])
def test_incomplete_reverse_write_requires_recovery_instead_of_claiming_rollback(reverse_result):
    from types import SimpleNamespace
    from music_app.services.edit_workflows import _run_edit_jobs

    writes = []
    def worker(path, repairs):
        writes.append((path, dict(repairs)))
        if path == 'broken-track':
            raise RuntimeError('write failed')
        if repairs['title'] == 'Old title':
            return path, *reverse_result
        return path, True, ['title']

    changed, skipped, failure = _run_edit_jobs(
        album={'name': 'Album'},
        repair_jobs=[('good-track', {'title': 'Old title'}, {'title': 'New title'}), ('broken-track', {'title': 'Old title'}, {'title': 'New title'})],
        config={}, logger=SimpleNamespace(error=lambda *_args: None, exception=lambda *_args: None),
        apply_repairs_worker=worker, update_cache_entry_after_repairs=lambda *_args: pytest.fail('failure must not project a successful cache'),
        append_log_history=lambda *_args, **_kwargs: None, log_app_event=lambda *_args, **_kwargs: None,
        updated_file_cache={}, action_name='edit-tags', failure_prefix='Failed', edit_write_workers=1,
    )
    assert changed == skipped == []
    assert ('good-track', {'title': 'Old title'}) in writes
    assert failure['edit_outcome'] == 'recovery_pending'


@pytest.mark.parametrize('boundary', ['initial_detail', 'mutation_refresh'])
def test_alias_proposals_survive_initial_detail_and_mutation_refresh(boundary, monkeypatch):
    from music_app.services import library_browse_postgres as module
    from tests.py.test_library_browse_postgres import _normal_problematic_product_row

    row = _normal_problematic_product_row()
    row['file_entry']['artist'] = 'Approved Alias'
    alias_reads = []
    class Connection:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def execute(self, *_args): return None
    connection = Connection()
    repository = module.PostgresLibraryBrowseRepository({'ALBUM_HAVEN_APP_DATABASE_URL': 'postgresql://alias-test'}, connect=lambda *_args: connection)
    monkeypatch.setattr(type(repository), '_load_problematic_file_rows', lambda *_args, **_kwargs: [row])
    monkeypatch.setattr(type(repository), '_load_missing_album_rows', lambda *_args, **_kwargs: [])
    def aliases(_self, **kwargs):
        alias_reads.append(kwargs.get('connection'))
        return {'alias_to_canonical': {'Approved Alias': 'Canonical Artist'}}
    monkeypatch.setattr(type(repository), '_load_relation_alias_maps', aliases)
    if boundary == 'initial_detail':
        payload = repository._build_problematic_files_payload_uncached()['initial_detail']
        expected_connection = connection
    else:
        payload = repository.build_problematic_album_payload_by_track_paths({row['file_private_path']})
        expected_connection = None
    assert any(proposal['field'] == 'artist' and proposal['corrected'] == 'Canonical Artist' for proposal in payload['suggested_edits'])
    assert alias_reads == [expected_connection]
