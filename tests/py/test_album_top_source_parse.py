"""Pure offline evidence contracts; no implicit matching or HTML execution."""
from uuid import uuid4

import pytest

from music_app.services.album_top_source_parse import parse_source, source_command
from music_app.services.owned_album_tops import AlbumTopError, MAX_TOP_COMMAND_BYTES


def command():
    return dict(request_key=str(uuid4()), title='My Top', description='', kind='text',
                filename=None, content='2. Artist B - Album B\n1. Artist A - Album A')


def payload(**changes):
    value = command()
    value.update(changes)
    return value


def test_countdown_has_stable_source_rows_and_normalized_explicit_rank_only():
    normalized, digest = source_command(command())
    result = parse_source(normalized)
    assert result['state'] == 'review_required'
    assert result['ordered_row_refs'] == ['2', '1']
    assert [row['explicit_rank'] for row in result['rows']] == [2, 1]
    assert all(row['catalog_ref'] is None and row['match_state'] == 'unresolved'
               for row in result['rows'])
    assert source_command(normalized)[1] == digest
    assert normalized['content'].startswith('2.')


@pytest.mark.parametrize('content', ['A\nB', '1. A\n1. B', '2. B\n4. D',
    '1. A\nB', '0. A\n1. B', '99999. A', '1) A\n3) C'])
def test_ambiguous_order_never_guessed(content):
    result = parse_source(source_command(payload(content=content))[0])
    assert result['ordered_row_refs'] is None
    assert result['issues'] == ['order_requires_review']


def test_html_is_inert_unselected_candidate_evidence_with_original_source():
    raw = '<script>steal()</script><style>x{}</style><ol><li>2. B</li><li>1. A</li></ol>'
    raw += '<img src="https://private.invalid/a" onerror="attack()"><p>&lt;b&gt;C&lt;/b&gt;</p>'
    value, _ = source_command(payload(kind='pasted_html', content=raw))
    result = parse_source(value)
    assert value['content'] == raw
    assert result['ordered_row_refs'] is None
    assert result['issues'] == ['html_structure_requires_review']
    assert [row['raw_text'] for row in result['rows']] == ['2. B', '1. A', '<b>C</b>']
    assert all(row['catalog_ref'] is None for row in result['rows'])


@pytest.mark.parametrize('changes', [dict(kind='url'), dict(content='\ud800'),
    dict(content='a\x00b'), dict(content=' '), dict(filename='/tmp/private.html'),
    dict(kind='uploaded_html', filename='../source.html'),
    dict(kind='uploaded_html', filename='C:\\source.html'),
    dict(kind='uploaded_html', filename='a\n.html'),
    dict(request_key='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')])
def test_invalid_source_before_persistence(changes):
    with pytest.raises(AlbumTopError):
        source_command(payload(**changes))


def test_actual_filename_preserved_and_source_bytes_bounded():
    value, _ = source_command(payload(kind='uploaded_html', filename=' source.html '))
    assert value['filename'] == ' source.html '
    with pytest.raises(AlbumTopError) as error:
        source_command(payload(content='é' * MAX_TOP_COMMAND_BYTES))
    assert error.value.status_code == 413


def test_too_many_rows_retains_source_and_explicit_review_issue():
    value, _ = source_command(payload(content='A\n' * 5001))
    result = parse_source(value)
    assert result['rows'] == []
    assert result['issues'] == ['too_many_candidate_rows']
    assert len(value['content']) == 10002
