"""The country a Discogs profile states as an artist's origin (owner 2026-11-22).

Only the first sentence counts, and only when it opens by describing the artist:
"<band, project, singer...> from <country>" or "<nationality> <band, project, singer...>".
A wrong country is worse than none, so anything less clear gives none.
"""
from __future__ import annotations

import re

from music_app.services.country_names import COUNTRY_NAMES

# Not countries, or names shared with a place elsewhere ("Atlanta, Georgia", "New Jersey").
_NOT_READ = frozenset({"XE", "XW", "GE", "JE"})
_COUNTRIES = {name: code for code, name in COUNTRY_NAMES.items() if code not in _NOT_READ}
_COUNTRIES.update({
    "USA": "US", "US": "US", "United States of America": "US",
    "UK": "GB", "Great Britain": "GB", "England": "GB", "Scotland": "GB", "Wales": "GB",
    "Northern Ireland": "GB", "Czech Republic": "CZ", "USSR": "SU",
})
_NATIONALITIES = {
    "American": "US", "Argentine": "AR", "Argentinian": "AR", "Australian": "AU", "Austrian": "AT",
    "Belarusian": "BY", "Belgian": "BE", "Brazilian": "BR", "British": "GB", "Bulgarian": "BG",
    "Canadian": "CA", "Chilean": "CL", "Chinese": "CN", "Colombian": "CO", "Croatian": "HR",
    "Cuban": "CU", "Czech": "CZ", "Danish": "DK", "Dutch": "NL", "Egyptian": "EG", "English": "GB",
    "Estonian": "EE", "Faroese": "FO", "Finnish": "FI", "French": "FR", "German": "DE", "Greek": "GR",
    "Hungarian": "HU", "Icelandic": "IS", "Indian": "IN", "Indonesian": "ID", "Iranian": "IR",
    "Irish": "IE", "Israeli": "IL", "Italian": "IT", "Jamaican": "JM", "Japanese": "JP",
    "Latvian": "LV", "Lithuanian": "LT", "Mexican": "MX", "New Zealand": "NZ", "Norwegian": "NO",
    "Peruvian": "PE", "Polish": "PL", "Portuguese": "PT", "Romanian": "RO", "Russian": "RU",
    "Scottish": "GB", "Serbian": "RS", "Slovak": "SK", "Slovenian": "SI", "South African": "ZA",
    "South Korean": "KR", "Soviet": "SU", "Spanish": "ES", "Swedish": "SE", "Swiss": "CH",
    "Turkish": "TR", "Ukrainian": "UA", "Venezuelan": "VE", "Welsh": "GB",
}


def _whole_names(names) -> str:
    """One of ``names`` as whole words, the longest first."""
    return rf"(?<![\w-])(?:{'|'.join(map(re.escape, sorted(names, key=len, reverse=True)))})(?![\w-])"


_COUNTRY = re.compile(_whole_names(_COUNTRIES))
_NATIONALITY = re.compile(_whole_names(_NATIONALITIES))
_ARTIST = (r"(?:singer[- ]songwriter|songwriter|singer|band|project|group|duo|trio|quartet|quintet|sextet"
           r"|ensemble|collective|orchestra|choir|outfit|musician|artist|rapper|composer|producer"
           r"|guitarist|pianist|drummer)")
# Words that make the noun after them someone other than the profile's artist.
_OTHER_SUBJECT = (r"(?:of|for|with|by|from|in|to|at|on|as|not|see|there|this|that|other|another|like|than"
                  r"|similar|is|was|are|were|be|ex|ex-[\w-]+|former|member|influenced|inspired|signed)")
_SUBJECT = re.compile(
    rf"(?:(?:an?|the) )?(?P<description>(?:(?!{_OTHER_SUBJECT}\b)[\w'&/+-]+,? ){{0,6}}?)"
    rf"{_ARTIST}\b(?: (?:and|&) {_ARTIST}\b)?",
    re.IGNORECASE,
)
_ORIGIN = re.compile(r",? (?:from|based in|formed in|hailing from) ")
_MARKUP = re.compile(r"\[/?[bius]\]", re.IGNORECASE)
_SENTENCE_END = re.compile(r"[.!?](?:\s|$)|[\r\n]")


def profile_origin_country(profile: object) -> str | None:
    """The ISO code of the one country of origin the profile states, or None."""
    if not isinstance(profile, str):
        return None
    text = _MARKUP.sub("", profile).strip().replace("U.S.A.", "USA").replace("U.S.", "US").replace("U.K.", "UK")
    sentence = _SENTENCE_END.split(text, maxsplit=1)[0]
    subject = _SUBJECT.match(sentence)
    if not subject:
        return None
    description = subject["description"]
    codes = set()
    if _NATIONALITY.match(description):
        codes = {_NATIONALITIES[found[0]] for found in _NATIONALITY.finditer(description)}
    if origin := _ORIGIN.match(sentence, subject.end()):
        stated = sentence[origin.end():]
        named = {_COUNTRIES[found[0]] for found in _COUNTRY.finditer(stated)}
        if named and not _opens_with_country(stated):
            return None
        codes |= named
    return next(iter(codes)) if len(codes) == 1 else None


def _opens_with_country(stated: str) -> bool:
    """Whether ``stated`` opens "[place, ]country", so the country is not a passing mention."""
    parts = stated.split(",", 4)
    for index, part in enumerate(parts):
        part = part.strip().removeprefix("the ").removeprefix("The ")
        if found := _COUNTRY.match(part):
            following = " ".join([part[found.end():], *parts[index + 1:]]).lstrip()
            if following.startswith(("and ", "or ", "&", "/")):
                return False
            # A capital after it makes a town of it ("Mexico City", "Lebanon, Tennessee"),
            # unless a country follows ("Northern Ireland, United Kingdom").
            return not following[:1].isupper() or bool(_COUNTRY.match(following))
        if not part[:1].isupper() or re.search(r" and | or |[&/]", part) or len(part.split()) > 4:
            return False
    return False
