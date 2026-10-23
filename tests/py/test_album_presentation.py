from music_app.services.album_display_metadata import album_display_title, album_display_year


def test_album_display_title_normalizes_season_soundtrack_punctuation() -> None:
    assert (
        album_display_title("Lost, Season 3: Original Television Soundtrack")
        == "Lost: Season 3 (Original Television Soundtrack)"
    )
    assert (
        album_display_title("Lost: The Final Season: Original Television Soundtrack")
        == "Lost: The Final Season (Original Television Soundtrack)"
    )
    assert album_display_title("Example - Season 2: OST") == "Example: Season 2 (OST)"
    assert album_display_title("Four Seasons") == "Four Seasons"


def test_album_display_year_keeps_full_date_for_data_but_returns_year_for_chrome() -> None:
    source = {"year": "2024-10-04", "release_date": "2024-10-04"}

    assert album_display_year(source) == "2024"
    assert source["release_date"] == "2024-10-04"
