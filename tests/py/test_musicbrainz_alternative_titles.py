"""Alternative album titles from the matched MusicBrainz release (Delivery 2, S4, item I)."""
from __future__ import annotations

from music_app.services.library_browse_postgres import _alternative_album_titles


def test_alternative_titles_are_other_names_not_respellings_or_edition_suffixes():
    assert _alternative_album_titles("Wurdah Ïtah", ("Tristan et Iseult", "Wurdah Itah")) == ["Tristan et Iseult"]
    assert _alternative_album_titles("Place To Be", ("Place to Be", "Place to Be")) == []
    assert _alternative_album_titles("Aces & Eights (Live)", ("Aces & Eights", None)) == []
    assert _alternative_album_titles("Asian Cafe", ("Asian Café",)) == []
    assert _alternative_album_titles("Тихие игры", ("Tikhie igry", "Tikhie Igry")) == ["Tikhie igry"]
    assert _alternative_album_titles("", ("Anything",)) == []
