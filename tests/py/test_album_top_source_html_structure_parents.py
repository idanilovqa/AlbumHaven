"""Balanced markup still requires legal structural parents, not browser repair."""
import pytest

from music_app.services.album_top_source_html import structural_rows
from music_app.services.album_top_source_parse import parse_source


@pytest.mark.parametrize('illegal_child', [
    '<li>Injected</li>',
    '<td>Injected</td>',
    '<th>Injected</th>',
    '<tr>Injected</tr>',
    '<thead>Injected</thead>',
    '<tbody>Injected</tbody>',
    '<tfoot>Injected</tfoot>',
    '<caption>Injected</caption>',
    '<colgroup>Injected</colgroup>',
])
@pytest.mark.parametrize('container', ['list-item', 'table-cell', 'inline-wrapper'])
def test_structural_children_cannot_be_flattened_into_candidate_text(illegal_child, container):
    if container == 'list-item':
        content = '<ol><li>Album ' + illegal_child + '</li></ol>'
    elif container == 'table-cell':
        content = '<table><tr><td>1</td><td>Album ' + illegal_child + '</td></tr></table>'
    else:
        content = '<ol><li><span>Album ' + illegal_child + '</span></li></ol>'
    assert structural_rows(content, 5000) is None
    result = parse_source({'kind': 'pasted_html', 'content': content})
    assert result['parser_version'] == 1
    assert result['ordered_row_refs'] is None
    assert 'html_structure_requires_review' in result['issues']
    assert all(row['catalog_ref'] is None and row['match_state'] == 'unresolved'
               for row in result['rows'])


@pytest.mark.parametrize('content', [
    '<ol><li><span><b>Artist</b> - <em>Album</em></span></li></ol>',
    '<table><tr><td><span><b>1</b></span></td>'
    '<td><span><b>Artist</b> - <em>Album</em></span></td></tr></table>',
])
def test_nested_inline_formatting_keeps_legal_structural_parents(content):
    rows = structural_rows(content, 5000)
    assert len(rows) == 1
    assert rows[0]['raw_text'] == 'Artist - Album'
    assert rows[0]['explicit_rank'] == 1
    result = parse_source({'kind': 'pasted_html', 'content': content})
    assert result['parser_version'] == 2
    assert result['issues'] == []
    assert result['ordered_row_refs'] == ['1']
    assert result['rows'][0]['catalog_ref'] is None
    assert result['rows'][0]['match_state'] == 'unresolved'


@pytest.mark.parametrize('content', [
    '<table><td>1</td><td>A</td></table>',
    '<table><tbody><td>1</td><td>A</td></tbody></table>',
    '<table><thead><th>Rank</th></thead><tr><td>1</td><td>A</td></tr></table>',
    '<ol><tr><td>1</td><td>A</td></tr></ol>',
    '<div><li>Outside</li><ol><li>A</li></ol></div>',
    '<div><tbody></tbody><ol><li>A</li></ol></div>',
    '<table><tr><td>1</td><td>A</td><tbody></tbody></tr></table>',
    '<table><tbody><thead></thead><tr><td>1</td><td>A</td></tr></tbody></table>',
])
def test_misplaced_structural_parents_require_review_even_when_balanced(content):
    assert structural_rows(content, 5000) is None
    result = parse_source({'kind': 'pasted_html', 'content': content})
    assert result['parser_version'] == 1
    assert result['ordered_row_refs'] is None
    assert 'html_structure_requires_review' in result['issues']
