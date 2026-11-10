"""Name and album evidence for MusicBrainz artist identity.

Names only *retrieve and compare* candidates. An artist is accepted only on
album evidence: a local album whose title agrees with one of the candidate's
release groups and whose year, track count, track titles or durations agree too.
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

# Letters NFKD does not decompose, and the Cyrillic and Greek alphabets, folded
# to Latin so "Cønstantine", "ЯRuGa" and "Μόρσο" compare with "Constantine",
# "YARuGA" and "Morso". Used only for comparison keys, never for display.
_FOLD = str.maketrans({
    "ø": "o", "æ": "ae", "œ": "oe", "ß": "ss", "đ": "d", "ł": "l", "þ": "th", "ð": "d", "ı": "i",
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z",
    "и": "i", "й": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
    "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh",
    "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya", "і": "i", "ї": "yi",
    "є": "ye", "ґ": "g",
    "α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i", "θ": "th", "ι": "i",
    "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "π": "p", "ρ": "r", "σ": "s",
    "ς": "s", "τ": "t", "υ": "y", "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o",
})
_ARTICLES = ("the", "a", "an", "die", "der", "das", "les", "le", "la", "el", "los", "las", "il")
_SEPARATORS = re.compile(r"\s*(?:&|\+|\band\b|\bund\b|\bet\b)\s*")
# Trailing edition words only: "Once Deluxe Edition" is "Once", "Special Forces" stays.
_EDITION_SUFFIX = re.compile(
    r"(?:\s+(?:\d+(?:th|st|nd|rd)?\s+anniversary|remaster(?:ed)?|deluxe|expanded|edition|reissue|"
    r"bonus\s+tracks?|special|limited|collector'?s?|version|\d{4}))+$"
)
_BRACKETS = re.compile(r"[\(\[\{「『【〈《]([^\)\]\}」』】〉》]*)[\)\]\}」』】〉》]")
_SUBTITLE_SEPARATORS = (":", " - ", " – ", " — ", "～", "〜")
_NUMBER_WORDS = {word: index for index, word in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen".split())}
_NUMBER_WORDS.update({word: 10 * index for index, word in enumerate(
    "twenty thirty forty fifty sixty seventy eighty ninety".split(), start=2)})
_SPACELESS = "#"  # folded keys hold only word characters and spaces
_CYRILLIC = re.compile(r"[\u0400-\u04ff]")
_LATIN = re.compile(r"[a-zA-Z]")


def fold(value: object) -> str:
    """Lower-case words of letters and digits: no accents, no punctuation, one script."""
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    # Accents go first, so accented Greek and Cyrillic letters reach the table too.
    text = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    text = text.translate(_FOLD)
    return " ".join(re.sub(r"[^\w]+|_", " ", text).split())


def _compact(text: str) -> str:
    return text.replace(" ", "")


def repaired(value: object) -> str | None:
    """A tag read with the wrong code page, repaired for comparison only (never written):
    UTF-8 read as Windows-1252 ("BjÃ¶rk"), or Latin-1 read as Windows-1251, which turns
    "Öröm" into a word mixing Latin and Cyrillic letters ("Цrцm")."""
    text = str(value or "")
    try:
        fixed = text.encode("cp1252").decode("utf-8")
        if fixed != text:
            return fixed
    except UnicodeError:
        pass
    words = text.split(" ")
    changed = False
    for position, word in enumerate(words):
        if _CYRILLIC.search(word) and _LATIN.search(word):
            try:
                words[position] = word.encode("cp1251").decode("latin-1")
                changed = True
            except UnicodeError:
                return None
    return " ".join(words) if changed else None


def _numbers_as_digits(text: str) -> str:
    """Folded English number words as digits: "up to thirty three" is "up to 33"."""
    out: list[str] = []
    for word in text.split():
        value = _NUMBER_WORDS.get(word)
        if value is not None and 0 < value < 10 and out and out[-1].isdigit() \
                and int(out[-1]) >= 20 and int(out[-1]) % 10 == 0:
            out[-1] = str(int(out[-1]) + value)
        else:
            out.append(str(value) if value is not None else word)
    return " ".join(out)


def name_keys(value: object) -> set[str]:
    """Comparison keys for an artist name: its folded form and its accepted variants.

    "The Blue Öyster Cult" also keys as "Blue Öyster Cult", "A & Z" as "A-Z",
    "Mystakidis, Dimitris" as "Dimitris Mystakidis", and "10cc / 10cc" as "10cc".
    """
    raw = str(value or "").strip()
    variants = {raw, repaired(raw) or raw}
    parts = [part for part in re.split(r"\s*(?:/|;)\s*", raw) if part]
    if len(parts) > 1 and len({fold(part) for part in parts}) == 1:
        variants.add(parts[0])
    for name in list(variants):
        if name.count(",") == 1:
            last, first = (part.strip() for part in name.split(","))
            if first and last:
                variants.add(f"{first} {last}")
    keys: set[str] = set()
    for name in variants:
        folded = fold(name)
        if not folded:
            continue
        for form in {folded, fold(_SEPARATORS.sub(" and ", name)), fold(_SEPARATORS.sub(" ", name))}:
            words = form.split()
            keys.add(_compact(form))
            if len(words) > 1 and words[0] in _ARTICLES:
                keys.add("".join(words[1:]))
            if len(words) > 1 and words[-1] in _ARTICLES:
                keys.add("".join(words[:-1]))
    keys.discard("")
    if not keys and raw:
        keys.add(raw.casefold())
    return keys


def candidate_name_keys(candidate: dict[str, object]) -> set[str]:
    keys = name_keys(candidate.get("canonical_name"))
    keys |= name_keys(candidate.get("sort_name"))
    for alias in candidate.get("aliases") or []:
        if isinstance(alias, dict):
            keys |= name_keys(alias.get("name"))
    return keys


def title_keys(title: object, artist_names: tuple[str, ...] = ()) -> set[str]:
    """Comparison keys for an album title.

    Brackets keep their words ("[REDACTED]") and also stand alone, as an original or
    alternative title does ("Jinsei Game (人生ゲイム)"); each side of a slash is a
    title of its own ("22 Strings/Cordes"); edition suffixes and subtitles are also
    tried without; a leading or trailing band name is dropped ("Agamemnon Part I &
    II" and "Part I & II") or read as its initials ("RTJ3"); number words read as
    digits ("Up to Thirty"); spacing is ignored ("Seim A New" and "Seim Anew").
    """
    raw = str(title or "")
    bases = {raw, repaired(raw) or raw}
    forms: set[str] = set()
    for base in bases:
        forms |= {base, _BRACKETS.sub(r" \1 ", base), _BRACKETS.sub(" ", base)}
        # A bracketed title, each side of a slash and each script of a bilingual title
        # ("차연 差延") also stand alone when they read as a title: "(Live)" never does.
        parts = [*_BRACKETS.findall(base), *re.split(r"\s*/\s*", _BRACKETS.sub(" ", base)),
                 *(" ".join(words) for words in _words_by_script(base).values())]
        forms |= {part for part in parts if _stands_alone(part)}
        for separator in _SUBTITLE_SEPARATORS:
            if separator in base:
                forms.add(base.split(separator, 1)[0])
    band_keys = [fold(name) for name in artist_names if fold(name)]
    keys: set[str] = set()
    for form in forms:
        folded = fold(form)
        for text in {folded, _EDITION_SUFFIX.sub("", folded)}:
            if not text:
                continue
            found = {text, _numbers_as_digits(text)}
            for band in band_keys:
                initials = "".join(word[0] for word in band.split()) if len(band.split()) > 1 else ""
                if text.startswith(band + " "):
                    found.add(text[len(band) + 1:])
                    if initials:
                        found.add(initials + text[len(band):])
                if text.endswith(" " + band):
                    found.add(text[:-len(band) - 1])
            # Spacing-free keys agree only exactly, never as a near spelling.
            keys |= found | {_SPACELESS + _compact(key) for key in found}
    keys.discard("")
    return keys


_AKA = re.compile(r"^\s*(?:aka|a\.k\.a\.?|also known as)\s*[:\-]?\s*", re.IGNORECASE)


def group_title_keys(group: dict[str, object], artist_names: tuple[str, ...] = ()) -> set[str]:
    """A release group's title keys, with the alternative title MusicBrainz keeps in its
    comment (Celeste's 'aka “Principe di un giorno”', Pražský výběr's "Straka v hrsti")."""
    keys = title_keys(group.get("title"), artist_names)
    comment = str(group.get("disambiguation") or "").strip()
    if comment:
        keys |= title_keys(_AKA.sub("", comment).strip("“”\"'«»„ "), artist_names)
    return keys


def _words_by_script(text: str) -> dict[str, list[str]]:
    """A title's words grouped by script, only when it mixes Latin, Cyrillic, Han, kana
    or Hangul words."""
    groups: dict[str, list[str]] = {}
    for word in text.split():
        script = ("hangul" if re.search(r"[가-힯]", word) else
                  "kana" if re.search(r"[぀-ヿ]", word) else
                  "han" if re.search(r"[㐀-鿿]", word) else
                  "cyrillic" if _CYRILLIC.search(word) else
                  "latin" if _LATIN.search(word) else None)
        if script:
            groups.setdefault(script, []).append(word)
    return groups if len(groups) > 1 else {}


def _stands_alone(part: str) -> bool:
    words = _EDITION_SUFFIX.sub("", fold(part)).split()
    return len(words) >= 2 or bool(words and _DENSE_SCRIPT.search(words[0]))


def _subtitle_keys(title: object) -> set[str]:
    """The words after a subtitle separator: part of a title, never the whole of it."""
    raw = str(title or "")
    return {fold(raw.split(separator, 1)[1]) for separator in _SUBTITLE_SEPARATORS if separator in raw} - {""}


def _within_typo_distance(a: str, b: str) -> bool:
    """One edit for 5 to 9 characters, two from 10, a swap counting once."""
    limit = 1 if 5 <= min(len(a), len(b)) <= 9 else 2 if min(len(a), len(b)) >= 10 else 0
    if not limit or abs(len(a) - len(b)) > limit:
        return False
    previous2, previous = None, list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        current = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] != b[j - 1]))
            if previous2 and i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                current[j] = min(current[j], previous2[j - 2] + 1)
        previous2, previous = previous, current
    return previous[-1] <= limit


# Words many titles share: never the distinctive word of a partial title ("The Grey
# Album" is not "The Black Album").
_GENERIC_TITLE_WORDS = frozenset(
    "album albums live best songs song music collection edition volume part hits greatest anthology "
    "sessions session demos demo remix remixes mixes version versions original soundtrack tracks".split())
_DENSE_SCRIPT = re.compile(r"[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u9fff\uac00-\ud7af]")


def _contained(a: str, b: str) -> bool:
    """All words of one title of two or more words inside the other (one word in a
    script written without spaces: "차연" in "차연 差延"), or most words shared with a
    distinctive one among them ("Keys to the Paradise" and "Keys to the Palace")."""
    small, large = sorted((set(a.split()), set(b.split())), key=len)
    dense_word = len(small) == 1 and len(next(iter(small))) >= 2 and _DENSE_SCRIPT.search(next(iter(small)))
    if small < large and (len(small) >= 2 or dense_word):
        return True
    shared = small & large
    return len(shared) >= 2 and len(shared) / len(small | large) >= 0.5 and any(
        len(word) >= 4 and word not in _GENERIC_TITLE_WORDS for word in shared)


def _key_agreement(local: set[str], remote: set[str]) -> str | None:
    if local & remote:
        return "exact"
    local = {key for key in local if not key.startswith(_SPACELESS)}
    remote = {key for key in remote if not key.startswith(_SPACELESS)}
    for a in local:
        for b in remote:
            # A near spelling only for titles of 8+ characters of about the same length.
            if min(len(a), len(b)) >= 8 and abs(len(a) - len(b)) <= max(len(a), len(b)) // 10 + 1:
                if SequenceMatcher(None, a, b).ratio() >= 0.9:
                    return "fuzzy"
    for a in local:
        for b in remote:
            if " " in a and " " in b and _within_typo_distance(a, b):
                return "typo"
    return None


def _agreement(local: set[str], local_title: object, remote: set[str], remote_title: object) -> str | None:
    agreement = _key_agreement(local, remote)
    if agreement:
        return agreement
    local = {key for key in local | _subtitle_keys(local_title) if not key.startswith(_SPACELESS)}
    remote = remote | _subtitle_keys(remote_title)
    return "partial" if local & remote or any(_contained(a, b) for a in local for b in remote) else None


def title_agreement(local_title: object, remote_title: object, artist_names: tuple[str, ...] = ()) -> str | None:
    """"exact" when keys agree; "fuzzy" for a near spelling of a title of 8+ characters;
    "typo" within a bounded edit distance; "partial" when one title holds the other's
    words or subtitle. Typo and partial titles count only with a matching tracklist."""
    return _agreement(title_keys(local_title, artist_names), local_title,
                      title_keys(remote_title, artist_names), remote_title)


# Best first; "tracks" is a release matched by its tracklist alone, with no title.
TITLE_RANK = {"exact": 0, "fuzzy": 1, "typo": 2, "partial": 3, "tracks": 4}


def ranked_title_matches(local_title: object, groups: list[tuple[dict, set[str]]],
                         artist_names: tuple[str, ...] = ()) -> list[tuple[dict, str]]:
    """Every release group agreeing with a local album, best first: an exact title before
    a near spelling, a typo or a partial one, and a group titled exactly like the album
    before one that only contains it (a "Workin', Relaxin', Steamin'" compilation)."""
    local = title_keys(local_title, artist_names)
    local_folded = fold(local_title)
    matches = [(group, agreement) for group, keys in groups
               if (agreement := _agreement(local, local_title, keys, group.get("title")))]
    return sorted(matches, key=lambda item: (TITLE_RANK[item[1]], fold(item[0].get("title")) != local_folded))


def _year(value: object) -> int | None:
    match = re.match(r"\s*(\d{4})", str(value or ""))
    return int(match.group(1)) if match else None


_EVIDENCE_SIGNALS = frozenset({"year", "track_count", "track_list", "durations"})


def _track_title_forms(title: object) -> set[str]:
    """A track title with and without its brackets and edition words ("Malawëlëkaahm
    (2020 remastered)"), and repaired when its tag was misread."""
    forms = set()
    for text in {str(title or ""), repaired(title) or ""}:
        for form in {text, _BRACKETS.sub(" ", text)}:
            folded = fold(form)
            forms |= {folded, _EDITION_SUFFIX.sub("", folded)}
    return forms - {""}


def album_signals(local_album: dict[str, object], remote: dict[str, object]) -> set[str]:
    """The evidence beyond the title that a local album and a remote release share.

    ``remote`` carries the release group's first-release date and, once fetched,
    the closest release's tracks (title, length in milliseconds). Two markers are
    not evidence: "lengths_unknown" when MusicBrainz has no lengths to compare, and
    "tracks_differ" when its fetched tracks agree on neither titles nor lengths.
    """
    signals: set[str] = set()
    local_year, remote_year = _year(local_album.get("year")), _year(remote.get("first_release_date"))
    if local_year and remote_year and abs(local_year - remote_year) <= 1:
        signals.add("year")
    local_tracks = [track for track in local_album.get("tracks") or [] if isinstance(track, dict)]
    remote_tracks = [track for track in remote.get("tracks") or [] if isinstance(track, dict)]
    remote_count = len(remote_tracks) or int(remote.get("track_count") or 0)
    if local_tracks and remote_count and abs(len(local_tracks) - remote_count) <= 1:
        signals.add("track_count")
    if local_tracks and remote_tracks:
        remote_by_title = {form: track for track in remote_tracks for form in _track_title_forms(track.get("title"))}
        local_forms = [_track_title_forms(track.get("title")) for track in local_tracks]
        local_titles = [forms for forms in local_forms if forms]
        shared = [forms for forms in local_titles if forms & remote_by_title.keys()]
        shorter = min(len(local_titles), len(remote_tracks))
        # Most local titles, or (MusicBrainz listing fewer tracks, Karma's cassette)
        # nearly all of the shorter list from four tracks.
        if local_titles and (len(shared) >= max(1, 0.6 * len(local_titles))
                             or (shorter >= 4 and len(shared) >= 0.9 * shorter)):
            signals.add("track_list")
        local_lengths = [float(track.get("duration_seconds") or 0) for track in local_tracks]
        remote_lengths = [float(track.get("length") or 0) / 1000 for track in remote_tracks]
        if all(local_lengths) and not all(remote_lengths):
            signals.add("lengths_unknown")
        elif all(local_lengths):
            if len(local_lengths) == len(remote_lengths):
                # Equal counts compare track by track: a matching total never hides a
                # 7:40 track against a 3:00 one. Nearly all within 3 s, none past 15 s.
                gaps = [abs(a - b) for a, b in zip(local_lengths, remote_lengths)]
                if sum(gap <= 3 for gap in gaps) >= 0.8 * len(gaps) and max(gaps) <= 15:
                    signals.add("durations")
            else:
                pairs = [(float(track.get("duration_seconds") or 0),
                          float(remote_by_title[next(iter(forms & remote_by_title.keys()))].get("length") or 0) / 1000)
                         for track, forms in zip(local_tracks, local_forms) if forms & remote_by_title.keys()]
                if len(pairs) >= 3 and all(abs(a - b) <= 3 for a, b in pairs) \
                        or abs(sum(local_lengths) - sum(remote_lengths)) <= 0.02 * sum(remote_lengths):
                    signals.add("durations")
        if not signals & {"track_list", "durations"}:
            signals.add("tracks_differ")
    return signals


def album_level(title: str | None, signals: set[str]) -> str | None:
    """"strong" (title plus two signals), "agree" (title plus one), "title" (title only).

    A typo, a partial title or a release matched by its tracks alone counts only with
    a matching tracklist, and an album whose fetched tracks differ in titles and
    lengths is no evidence at all."""
    if not title or "tracks_differ" in signals:
        # Matching is led by the tracks (owner, 2026-11-10): a release whose fetched tracks
        # differ in titles and lengths is not this album, whatever its title, year or count.
        return None
    evidence = signals & _EVIDENCE_SIGNALS
    if title in {"typo", "partial", "tracks"} and "track_list" not in evidence:
        return None
    if title == "tracks" and ("track_count" not in evidence or not signals & {"durations", "lengths_unknown"}):
        # Tracks alone, with no title to agree, need their count and lengths too.
        return None
    if len(evidence) >= 2:
        return "strong"
    if evidence:
        return "agree"
    # A near spelling is never evidence on its own.
    return "title" if title == "exact" else None


# MusicBrainz's special-purpose artists name no artist; never a match.
SPECIAL_PURPOSE_ARTISTS = frozenset({
    "89ad4ac3-39f7-470e-963a-56509c546377",  # Various Artists
    "125ec42a-7229-4250-afc5-e057484327fe",  # [unknown]
})
_COLLABORATION = re.compile(
    r"\s(?:&|and|und|et|y|и|with|feat\.?|ft\.?|featuring|vs\.?|x|meets|\+|-|–)\s|,\s|/|;|×|\s·\s", re.IGNORECASE)
_LEVEL_RANK = {"strong": 2, "agree": 1}


def name_relation(local_name: object, candidate: dict[str, object]) -> str:
    """How a candidate's name relates to the local name: "same", "spelling" (a near or
    reordered spelling), "contains" (one name inside the other), "collaboration" (the
    local name joins several artists and the candidate is only one of them) or "different"."""
    local_keys = name_keys(local_name)
    candidate_keys = candidate_name_keys(candidate)
    if local_keys & candidate_keys:
        return "same"
    local = fold(local_name)
    names = [fold(candidate.get("canonical_name"))] + [
        fold(alias.get("name")) for alias in candidate.get("aliases") or [] if isinstance(alias, dict)]
    names = [name for name in names if name]
    if any(sorted(name.split()) == sorted(local.split()) or SequenceMatcher(None, local, name).ratio() >= 0.85
           for name in names):
        return "spelling"
    if _COLLABORATION.search(str(local_name or "")):
        return "collaboration"
    if any(re.search(rf"\b{re.escape(name)}\b", local) or re.search(rf"\b{re.escape(local)}\b", name)
           for name in names if local):
        return "contains"
    return "different"


def album_rank(album: dict[str, object]) -> tuple[int, int, int]:
    """How strongly one album agrees: level, then how many signals, then track-level ones."""
    signals = set(album.get("signals") or ()) & _EVIDENCE_SIGNALS
    return (_LEVEL_RANK.get(str(album.get("level")), 0), len(signals),
            len(signals & {"track_list", "durations"}))


def assign_albums(candidates: list[dict[str, object]]) -> None:
    """Give each local album to the one candidate with strictly the strongest evidence on it.

    Two candidates agreeing equally on the same album prove neither: the album is
    shared and counts for no one. Sets ``assigned`` on every album entry.
    """
    album_count = max((len(candidate.get("albums") or []) for candidate in candidates), default=0)
    for index in range(album_count):
        entries = [candidate["albums"][index] for candidate in candidates
                   if index < len(candidate.get("albums") or [])]
        for entry in entries:
            entry["assigned"] = False
        agreeing = sorted((entry for entry in entries if _LEVEL_RANK.get(str(entry.get("level")), 0)),
                          key=album_rank, reverse=True)
        if agreeing and (len(agreeing) == 1 or album_rank(agreeing[0]) > album_rank(agreeing[1])):
            agreeing[0]["assigned"] = True


def contested_albums(candidates: list[dict[str, object]]) -> set[int]:
    """Albums on which more than one candidate agrees."""
    counts: dict[int, int] = {}
    for candidate in candidates:
        for index, album in enumerate(candidate.get("albums") or []):
            if _LEVEL_RANK.get(str(album.get("level")), 0):
                counts[index] = counts.get(index, 0) + 1
    return {index for index, count in counts.items() if count > 1}


def candidate_score(albums: list[dict[str, object]]) -> tuple[int, int, int]:
    """(score, agreeing albums, strong albums) over the albums assigned to a candidate."""
    held = [album for album in albums if album.get("assigned", True)]
    strong = sum(album.get("level") == "strong" for album in held)
    agreeing = sum(album.get("level") in {"strong", "agree"} for album in held)
    return 2 * strong + (agreeing - strong), agreeing, strong


# An album certainly belongs to a MusicBrainz artist when its title, track titles and
# track count agree with one of that artist's releases (owner decision, 2026-11-08).
_CERTAIN_SIGNALS = frozenset({"track_list", "track_count"})


def certain_albums(candidates: list[dict[str, object]]) -> dict[int, dict[str, object]]:
    """Local albums exactly one candidate certainly matches, by album index."""
    holders: dict[int, dict[str, dict[str, object]]] = {}
    for candidate in candidates:
        for index, album in enumerate(candidate.get("albums") or []):
            if album.get("level") == "strong" and _CERTAIN_SIGNALS <= set(album.get("signals") or ()):
                holders.setdefault(index, {})[str(candidate.get("mbid"))] = candidate
    return {index: next(iter(owners.values())) for index, owners in holders.items() if len(owners) == 1}


def decide(candidates: list[dict[str, object]], local_name: object = "") -> dict[str, object]:
    """Albums decide first: each album that certainly matches one artist takes it, with no
    margin. Certain albums of one artist match it under any name; certain albums of
    several artists split the local artist per album (Amarok). Without a certain album,
    or for a collaboration, the evidence rules below decide. ``certain`` maps each
    certain album's index to its artist."""
    candidates = [candidate for candidate in candidates
                  if str(candidate.get("mbid") or "").lower() not in SPECIAL_PURPOSE_ARTISTS]
    certain = certain_albums(candidates)
    if _COLLABORATION.search(str(local_name or "")) or any(candidate.get("joint_credit") for candidate in candidates):
        certain = {}
    decision = _decide_on_evidence(candidates, local_name)
    if not certain:
        return {**decision, "certain": certain}
    owners = list({str(owner["mbid"]): owner for owner in certain.values()}.values())
    if len(owners) == 1:
        return {"classification": "matched", "selected": owners[0],
                "candidates": decision.get("candidates") or owners, "certain": certain}
    return {"classification": "per_album", "candidates": owners, "certain": certain}


def _decide_on_evidence(candidates: list[dict[str, object]], local_name: object = "") -> dict[str, object]:
    """Accept one candidate only on decisive album evidence.

    Each candidate carries ``albums`` (its evidence per local album), and may carry
    ``name_agrees``, ``credit_agrees`` and ``sibling`` (an already matched local
    artist with this name). Albums go to the candidate with the strongest evidence
    on them. The winner holds a strong album, and the runner-up holds no album, or
    the winner holds twice its score with two more albums. The winner then needs
    its name, a credit or a sibling to agree; or two strong albums; or, for an
    artist with one local album, a strong album with its tracks confirmed and a
    name that is a spelling or a part of the local one. When no album agrees with
    anyone, a single matched sibling is accepted: its own albums proved it. A name
    alone never decides; a collaboration ("A & B") is never given to one of its artists.
    """
    candidates = [candidate for candidate in candidates
                  if str(candidate.get("mbid") or "").lower() not in SPECIAL_PURPOSE_ARTISTS]
    assign_albums(candidates)
    for candidate in candidates:
        candidate["evidence"] = candidate_score(candidate.get("albums") or [])
    ranked = sorted(candidates, key=lambda candidate: (candidate["evidence"], int(candidate.get("score") or 0)),
                    reverse=True)
    contenders = [candidate for candidate in ranked if candidate["evidence"][1] > 0]
    if contenders:
        winner = contenders[0]
        runner = contenders[1] if len(contenders) > 1 else None
        decisive = runner is None or (
            winner["evidence"][0] >= 2 * runner["evidence"][0]
            and winner["evidence"][1] - runner["evidence"][1] >= 2
        )
        if winner["evidence"][2] >= 1 and decisive:
            relation = name_relation(local_name, winner)
            if winner.get("joint_credit") and relation != "same":
                # MusicBrainz credits the album to several artists ("Petrucci & Rudess"):
                # the local artist is that collaboration, not this one member.
                relation = "collaboration"
            albums = winner.get("albums") or []
            tracks_confirmed = any(
                album.get("assigned", True) and album.get("level") == "strong"
                and set(album.get("signals") or ()) & {"track_list", "durations"} for album in albums)
            if (winner.get("name_agrees") or winner.get("credit_agrees") or winner.get("sibling")
                    or (relation != "collaboration" and (
                        winner["evidence"][2] >= 2
                        or (len(albums) == 1 and tracks_confirmed and relation in {"spelling", "contains"})))):
                return {"classification": "matched", "selected": winner, "candidates": ranked}
            return {"classification": "unconfirmed", "candidates": contenders[:3]}
        return {"classification": "ambiguous" if runner else "unconfirmed", "candidates": contenders}
    tied = [candidate for candidate in ranked
            if any(_LEVEL_RANK.get(str(album.get("level")), 0) for album in candidate.get("albums") or [])]
    if tied:
        # Albums several candidates agree on equally: the members of a joint credit
        # (a collaboration, offered for confirmation) or same-named artists.
        joint = all(candidate.get("joint_credit") for candidate in tied)
        return {"classification": "unconfirmed" if joint or len(tied) == 1 else "ambiguous",
                "candidates": tied[:3] if joint else tied}
    siblings ={str(candidate.get("mbid")): candidate for candidate in ranked if candidate.get("sibling")}
    if len(siblings) == 1:
        # The same artist under another tag spelling ("Chick_Corea"), already matched
        # on its albums, and no album here points anywhere else.
        return {"classification": "matched", "selected": next(iter(siblings.values())), "candidates": ranked,
                "sibling_only": True}
    named = [candidate for candidate in ranked if candidate.get("name_agrees")]
    if len(named) == 1:
        return {"classification": "unconfirmed", "candidates": named}
    if named:
        return {"classification": "ambiguous", "candidates": named}
    return {"classification": "not_found", "candidates": []}
