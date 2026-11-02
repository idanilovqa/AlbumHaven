import pytest

from music_app.services.view_search import normalize_search_text, search_term_matches_field


@pytest.mark.parametrize("query", [
    "Scan Artist", "Scan Owner", "Scan Release", "Dont Stop", "Canonical Artist",
])
def test_absolute_path_drive_and_short_directories_do_not_match_unrelated_query(query):
    field = normalize_search_text(
        r"D:\a\AlbumHaven\AlbumHaven\.tmp\pytest-8480-08a3e743"
        r"\test_global_loose_track_search1\Music\Generic\Other\unrelated.flac"
    )
    assert not search_term_matches_field(normalize_search_text(query), field)


@pytest.mark.parametrize("query,field", [
    ("a", "A"), ("d", "D"), ("artist", "Scan Artist"),
    ("scan artist", "Artist"), ("mornng", "Morning"),
])
def test_path_token_guard_preserves_exact_short_names_prefixes_and_typos(query, field):
    assert search_term_matches_field(normalize_search_text(query), normalize_search_text(field))
