"""The country a Discogs profile states as the artist's origin (owner answer Q3, 2026-11-22)."""
from __future__ import annotations

import pytest

from music_app.services.discogs_profile_country import profile_origin_country


@pytest.mark.parametrize("profile,country", [
    ("An art rock project from Poland led by Jan Kowalski.", "PL"),
    ("Progressive folk rock band from Spain.", "ES"),
    ("Heavy metal band from Tampa, Florida, United States.", "US"),
    ("Black metal band from the Netherlands, formed in 1998.", "NL"),
    ("Rock group formed in Saint Petersburg, Russia.", "RU"),
    ("Jazz trio based in Japan", "JP"),
    ("Singer hailing from South Korea.", "KR"),
    ("Polish progressive rock band formed in 1999.", "PL"),
    ("British heavy metal band, formed in London.", "GB"),
    ("An American singer and songwriter.", "US"),
    ("Doom duo from the UK.", "GB"),
    ("[b]Symphonic metal band[/b] from Finland.", "FI"),
    ("Ska band from the U.S.A.", "US"),
    ("Band from Niger.", "NE"),
    ("Band from Nigeria.", "NG"),
    ("Band from Papua New Guinea.", "PG"),
    ("Band from Northern Ireland, United Kingdom.", "GB"),
])
def test_a_statement_of_origin_gives_the_country(profile, country):
    assert profile_origin_country(profile) == country


@pytest.mark.parametrize("profile", [
    "Progressive band that toured in Germany.",
    "Band influenced by bands from Sweden.",
    "Band inspired by a group from Sweden.",
    "Metal band signed to a label from Japan.",
    "Not to be confused with the band from Spain.",
    "For the band from Spain, see Example (2).",
    "There is also a band from Spain of this name.",
    "Band similar to the Polish progressive rock band Example.",
    "Session player for a band from Italy.",
    "Drummer, ex-member of a band from Norway.",
    "Progressive rock band. They moved to France in 2004.",
    "Band formed in 1999. Originally a duo from Canada.",
    "Band from Poland and Germany.",
    "Polish and German progressive rock band.",
    "German band from Poland.",
    "Japanese-influenced rock band.",
    "Band playing Irish folk music.",
    "Irish folk music specialists.",
    "Band from Paris, Texas.",
    "Band from Atlanta, Georgia.",
    "Band from Lebanon, Tennessee.",
    "Band from San Marino, California.",
    "Band from Mexico, MO.",
    "Band from Somewhere.",
    "French horn player.",
    "Latin American music ensemble.",
    "",
    None,
])
def test_a_country_that_is_only_mentioned_gives_none(profile):
    assert profile_origin_country(profile) is None
