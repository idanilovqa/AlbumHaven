"""Independent conservative HTML evidence contracts; no network or matching."""
from copy import deepcopy

import pytest

from music_app.services.album_top_source_html import structural_rows
from music_app.services.album_top_source_parse import parse_source


def parsed(content, kind='pasted_html'):
    command = {'kind': kind, 'content': content}
    before = deepcopy(command)
    result = parse_source(command)
    assert command == before
    return result


def assert_accepted(content, texts, ranks, lines=None):
    result = parsed(content)
    assert result['parser_version'] == 2
    assert result['state'] == 'review_required'
    assert result['issues'] == []
    rows = result['rows']
    assert [row['raw_text'] for row in rows] == texts
    assert [row['explicit_rank'] for row in rows] == ranks
    assert [row['row_ref'] for row in rows] == [str(i) for i in range(1, len(rows) + 1)]
    assert result['ordered_row_refs'] == [str(i + 1) for i in sorted(
        range(len(ranks)), key=lambda i: ranks[i])]
    assert all(row['catalog_ref'] is None and row['match_state'] == 'unresolved'
               for row in rows)
    if lines is not None:
        assert [row['candidate_line'] for row in rows] == lines
    return result


def test_single_ordered_list_preserves_appearance_and_unresolved_evidence():
    assert_accepted('<ol>\n<li>Artist A - Album A</li>\n<li>Artist B - Album B</li>\n</ol>',
                    ['Artist A - Album A', 'Artist B - Album B'], [1, 2], [2, 3])


def test_reversed_default_and_explicit_values_sort_only_the_reference_order():
    assert_accepted('<ol reversed><li>B</li><li>A</li></ol>', ['B', 'A'], [2, 1])
    assert_accepted('<ol start="2"><li>B</li><li value="1">A</li></ol>',
                    ['B', 'A'], [2, 1])
    assert_accepted('<ol reversed start="2"><li>B</li><li>A</li></ol>',
                    ['B', 'A'], [2, 1])


def test_wrappers_inline_entities_and_inert_content_do_not_supply_rows():
    content = ('<html><head><title>Not an album</title></head><body><section>'
               '<script>steal()</script><style>li{display:none}</style>'
               '<template><ol><li>Fake</li></ol></template><noscript>Fake</noscript>'
               '<ol><li><strong>A &amp; B</strong> - <em>C</em></li></ol>'
               '</section></body></html>')
    assert_accepted(content, ['A & B - C'], [1])


def test_complete_ranked_table_joins_cells_without_identity_guessing():
    content = ('<table>\n<thead><tr><th>Rank</th><th>Artist</th><th>Album</th></tr></thead>\n'
               '<tbody>\n<tr><td>2)</td><td>Artist B</td><td>Album B</td></tr>\n'
               '<tr><td>1.</td><td>Artist A</td><td>Album A</td></tr>\n</tbody></table>')
    assert_accepted(content, ['Artist B Album B', 'Artist A Album A'], [2, 1], [4, 5])


def test_direct_table_rows_and_harmless_inline_formatting():
    assert_accepted('<div><table><tr><td><b>1</b></td><td><i>Unknown Album</i></td>'
                    '</tr></table></div>', ['Unknown Album'], [1])


@pytest.mark.parametrize('content', [
    '<ol><li>A</li></ol><ol><li>B</li></ol>',
    '<ol><li>A</li></ol><table><tr><td>1</td><td>B</td></tr></table>',
    '<h1>A different list</h1><ol><li>A</li></ol>',
    '<ol><li>A</li></ol>Trailing evidence',
    'Leading evidence<ol><li>A</li></ol>',
    '<ol><li>A<ul><li>B</li></ul></li></ol>',
    '<ol><li>A<ol><li>B</li></ol></li></ol>',
    '<ol><li><table><tr><td>1</td><td>A</td></tr></table></li></ol>',
    '<ol><li>A</ol>',
    '<ol><li>A</li>',
    '<ol><li>A<li>B</li></ol>',
    '<ol><div><li>A</li></div></ol>',
    '<ol>Other text<li>A</li></ol>',
    '<ol><li> </li></ol>',
    '<ol></ol>',
    '<ul><li>1. A</li></ul>',
    '<ol type="A"><li>A</li></ol>',
    '<ol start="two"><li>A</li></ol>',
    '<ol start="0"><li>A</li></ol>',
    '<ol start="2"><li>A</li></ol>',
    '<ol start="1" START="1"><li>A</li></ol>',
    '<ol reversed reversed><li>A</li></ol>',
    '<ol><li value="1" value="1">A</li></ol>',
    '<ol><li value="x">A</li></ol>',
    '<ol><li value="0">A</li></ol>',
    '<ol><li value="1">A</li><li value="1">B</li></ol>',
    '<ol><li>A</li><li value="3">B</li></ol>',
    '<ol><li>2. A</li><li>1. B</li></ol>',
    '<table><tr><td>1</td></tr></table>',
    '<table><tr><td>1</td><td> </td></tr></table>',
    '<table><tr><td>0</td><td>A</td></tr></table>',
    '<table><tr><td>1st</td><td>A</td></tr></table>',
    '<table><tr><td>Rank 1</td><td>A</td></tr></table>',
    '<table><tr><td>1</td><td>A</td></tr><tr><td>1</td><td>B</td></tr></table>',
    '<table><tr><td>1</td><td>A</td></tr><tr><td>3</td><td>B</td></tr></table>',
    '<table><tr><td>1</td><td>A</td></table>',
    '<table><tr><td>1</td><td>A</td></tr>',
    '<table><tbody><tr><td>1</td><td>A</td></tr></tbody><tbody>'
    '<tr><td>2</td><td>B</td></tr></tbody></table>',
    '<table><tr><td rowspan="2">1</td><td>A</td></tr></table>',
    '<table><tr><td>1</td><td colspan="1">A</td></tr></table>',
    '<table><tr><td>1</td><td><ol><li>A</li></ol></td></tr></table>',
    '<table><caption>Competing evidence</caption><tr><td>1</td><td>A</td></tr></table>',
])
def test_ambiguous_or_incomplete_structures_require_review(content):
    assert structural_rows(content, 5000) is None
    result = parsed(content)
    assert result['parser_version'] == 1
    assert result['state'] == 'review_required'
    assert result['ordered_row_refs'] is None
    assert 'html_structure_requires_review' in result['issues']
    assert all(row['catalog_ref'] is None and row['match_state'] == 'unresolved'
               for row in result['rows'])


def test_exact_row_bound_never_accepts_a_truncated_structural_list():
    content = '<ol><li>A</li><li>B</li></ol>'
    assert structural_rows(content, 1) is None
    rows = structural_rows(content, 2)
    assert len(rows) == 2
    assert [row['explicit_rank'] for row in rows] == [1, 2]


@pytest.mark.parametrize('kind', ['pasted_html', 'uploaded_html', 'url'])
def test_all_html_evidence_kinds_use_the_same_structural_contract(kind):
    result = parsed('<ol><li>A</li></ol>', kind)
    assert result['parser_version'] == 2
    assert result['issues'] == []
    assert result['rows'][0]['catalog_ref'] is None
    assert result['rows'][0]['match_state'] == 'unresolved'


def test_plain_text_contract_is_unchanged_even_when_text_looks_like_html():
    result = parsed('<ol><li>A</li></ol>', 'text')
    assert result['parser_version'] == 1
    assert result['ordered_row_refs'] is None
    assert result['issues'] == ['order_requires_review']
    assert result['rows'][0]['raw_text'] == '<ol><li>A</li></ol>'


def test_matching_visible_rank_is_preserved_as_private_raw_text():
    assert_accepted('<ol reversed><li>2. Artist B - Album B</li>'
                    '<li>1) Artist A - Album A</li></ol>',
                    ['2. Artist B - Album B', '1) Artist A - Album A'], [2, 1])


def test_markup_urls_and_identity_looking_strings_never_admit_catalog_identity():
    content = ('<ol><li><a href="http://127.0.0.1/private" onclick="steal()">'
               'catalog:123 &lt;script&gt;unsafe&lt;/script&gt;</a></li></ol>')
    result = assert_accepted(content, ['catalog:123 <script>unsafe</script>'], [1])
    assert set(result['rows'][0]) == {
        'row_ref', 'candidate_line', 'raw_text', 'explicit_rank',
        'catalog_ref', 'match_state'}


def test_deep_and_excessive_markup_fails_closed_without_partial_rows():
    content = '<div>' * 64 + '<ol><li>A</li></ol>' + '</div>' * 64
    assert structural_rows(content, 5000) is None
    content = '<div></div>' * 20000 + '<ol><li>A</li></ol>'
    assert structural_rows(content, 5000) is None


@pytest.mark.parametrize('content', [
    '<ol><li><b>A</li></b></ol>',
    '<ol><li>A</li></ol></div>',
    '<div><ol><li>A</li></ol>',
    '<ol><li>A</li></ol><p>1. Another candidate</p>',
    '<table><thead><tr><th>Rank</th><th>Album</th></tr></thead></table>',
    '<table><thead><tr><td>1</td><td>A</td></tr></thead></table>',
])
def test_balancing_and_header_only_evidence_do_not_create_a_complete_list(content):
    assert structural_rows(content, 5000) is None
    result = parsed(content)
    assert result['parser_version'] == 1
    assert result['ordered_row_refs'] is None
    assert 'html_structure_requires_review' in result['issues']
