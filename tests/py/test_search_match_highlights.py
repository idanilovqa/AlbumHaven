from __future__ import annotations

import pytest

from music_app.services.view_search import (
    build_search_highlights,
    collect_search_highlight_texts,
    search_match_ranges,
    search_terms_match_fields,
    normalize_search_text,
    split_search_terms,
)


def _marked(text: str, query: str) -> str:
    out, last = [], 0
    for start, end in search_match_ranges(query, text):
        out.append(text[last:start] + "[" + text[start:end] + "]")
        last = end
    return "".join(out) + text[last:]


@pytest.mark.parametrize(
    ("query", "text", "expected"),
    [
        # Search is literal (owner 2026-11-18): "alas" is never singularised to "ala".
        ("alas", "Alas de Sal", "[Alas] de Sal"),
        ("alas", "Edu Falaschi", "Edu F[alas]chi"),
        ("ALAS", "Galasphere 347", "G[alas]phere 347"),
        ("alas", "Wache, Wala! Wala! Erwach!", "Wache, Wala! Wala! Erwach!"),
        # A close-spelling match highlights the whole word it matched. Pending the owner's decision whether
        # literal search also removes close-spelling matches; this case goes with that rule.
        ("metalica", "Metallica", "[Metallica]"),
        # The full query and its separated parts each highlight where they match.
        ("river - love", "River of Endless Love", "[River] of Endless [Love]"),
        ("dont", "Don't Stop", "[Don't] Stop"),
        ("ddt", "ДДТ", "ДДТ"),
        ("", "Alas", "Alas"),
        ("alas", "", ""),
    ],
)
def test_search_match_ranges_mark_the_matched_characters(query, text, expected):
    assert _marked(text, query) == expected


def test_ranges_agree_with_the_search_matcher():
    cases = [
        ("alas", "Wache, Wala! Wala! Erwach!"),
        ("alas", "Alas de Sal"),
        ("metalica", "Metallica"),
        ("dragonland", "A-ha"),
        ("la", "Ala"),
    ]
    for query, text in cases:
        matched = search_terms_match_fields(split_search_terms(query), [normalize_search_text(text)])
        assert bool(search_match_ranges(query, text)) == matched, (query, text)


def test_ranges_are_code_point_offsets_into_the_original_text():
    text = "Ŝtar 🎵 Ālap!"
    (start, end), = search_match_ranges("ālap", text)
    assert text[start:end] == "Ālap"


def test_decomposed_accents_keep_their_marks_inside_the_range():
    text = "Cafe\u0301 Society"
    assert _marked(text, "café") == "[Cafe\u0301] Society"


def test_build_search_highlights_dedupes_and_omits_unmatched_texts():
    highlights = build_search_highlights("sal", ["Alas de Sal", "Alas de Sal", "Argovia", None, ""])
    assert highlights == {"Alas de Sal": [[8, 11]]}
    assert build_search_highlights("", ["Alas de Sal"]) == {}


def test_collect_search_highlight_texts_reads_only_display_fields():
    payload = {
        "artists_sidebar": [{"artist": "Alas", "artist_display": "Alas", "count": 1}],
        "primary_artist_groups": [
            {"albums": [{"name": "Pinta Tu Aldea", "display_artist": "Alas", "cover_ref": "alas-ref"}]},
        ],
        "custom_collections": [{"name": "Road trip", "count": 2}],
        "path": "D:/Music/alas.mp3",
    }
    texts = set(collect_search_highlight_texts(payload))
    assert {"Alas", "Pinta Tu Aldea", "Road trip"} <= texts
    assert "alas-ref" not in texts
    assert "D:/Music/alas.mp3" not in texts


def test_highlight_work_is_bounded_by_the_response_texts(monkeypatch):
    from music_app.services import view_search

    calls = []
    real = view_search.search_match_ranges
    monkeypatch.setattr(view_search, "search_match_ranges", lambda query, text: calls.append(text) or real(query, text))
    payload = {"albums": [{"name": f"Album {index % 50}", "display_artist": "Sal"} for index in range(10_000)]}

    texts = view_search.collect_search_highlight_texts(payload)
    highlights = view_search.build_search_highlights("sal", texts)

    assert len(texts) == view_search._SEARCH_HIGHLIGHT_TEXT_LIMIT
    assert len(calls) == 51
    assert highlights == {"Sal": [[0, 3]]}
