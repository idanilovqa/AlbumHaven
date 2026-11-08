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
_BRACKETS = re.compile(r"[\(\[\{]([^\)\]\}]*)[\)\]\}]")


def fold(value: object) -> str:
    """Lower-case words of letters and digits: no accents, no punctuation, one script."""
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    # Accents go first, so accented Greek and Cyrillic letters reach the table too.
    text = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    text = text.translate(_FOLD)
    return " ".join(re.sub(r"[^\w]+|_", " ", text).split())


def _compact(text: str) -> str:
    return text.replace(" ", "")


def name_keys(value: object) -> set[str]:
    """Comparison keys for an artist name: its folded form and its accepted variants.

    "The Blue Öyster Cult" also keys as "Blue Öyster Cult", "A & Z" as "A-Z",
    "Mystakidis, Dimitris" as "Dimitris Mystakidis", and "10cc / 10cc" as "10cc".
    """
    raw = str(value or "").strip()
    variants = {raw}
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

    Brackets keep their words ("[REDACTED]"), edition suffixes and subtitles are
    also tried without, and a leading or trailing band name is dropped
    ("Agamemnon Part I & II" and "Part I & II").
    """
    raw = str(title or "")
    forms = {raw, _BRACKETS.sub(r" \1 ", raw), _BRACKETS.sub(" ", raw)}
    for separator in (":", " - ", " – ", " — "):
        if separator in raw:
            forms.add(raw.split(separator, 1)[0])
    band_keys = [fold(name) for name in artist_names if fold(name)]
    keys: set[str] = set()
    for form in forms:
        folded = fold(form)
        for text in {folded, _EDITION_SUFFIX.sub("", folded)}:
            if not text:
                continue
            keys.add(text)
            for band in band_keys:
                if text.startswith(band + " "):
                    keys.add(text[len(band) + 1:])
                if text.endswith(" " + band):
                    keys.add(text[:-len(band) - 1])
    keys.discard("")
    return keys


def _key_agreement(local: set[str], remote: set[str]) -> str | None:
    if local & remote:
        return "exact"
    for a in local:
        for b in remote:
            # A near spelling only for titles of 8+ characters of about the same length.
            if min(len(a), len(b)) >= 8 and abs(len(a) - len(b)) <= max(len(a), len(b)) // 10 + 1:
                if SequenceMatcher(None, a, b).ratio() >= 0.9:
                    return "fuzzy"
    return None


def title_agreement(local_title: object, remote_title: object, artist_names: tuple[str, ...] = ()) -> str | None:
    """"exact" when keys agree; "fuzzy" for a near spelling of a title of 8+ characters."""
    return _key_agreement(title_keys(local_title, artist_names), title_keys(remote_title, artist_names))


def best_title_match(local_title: object, groups: list[tuple[dict, set[str]]],
                     artist_names: tuple[str, ...] = ()) -> tuple[dict | None, str | None]:
    """The release group agreeing best with a local album, from groups whose title
    keys were computed once: an exact title wins over a near spelling."""
    local = title_keys(local_title, artist_names)
    for group, keys in groups:
        if local & keys:
            return group, "exact"
    for group, keys in groups:
        if _key_agreement(local, keys):
            return group, "fuzzy"
    return None, None


def _year(value: object) -> int | None:
    match = re.match(r"\s*(\d{4})", str(value or ""))
    return int(match.group(1)) if match else None


def album_signals(local_album: dict[str, object], remote: dict[str, object]) -> set[str]:
    """The evidence beyond the title that a local album and a remote release share.

    ``remote`` carries the release group's first-release date and, once fetched,
    the closest release's tracks (title, length in milliseconds).
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
        remote_titles = {fold(track.get("title")) for track in remote_tracks} - {""}
        local_titles = [fold(track.get("title")) for track in local_tracks if fold(track.get("title"))]
        if local_titles and sum(title in remote_titles for title in local_titles) >= max(1, 0.6 * len(local_titles)):
            signals.add("track_list")
        local_lengths = [float(track.get("duration_seconds") or 0) for track in local_tracks]
        remote_lengths = [float(track.get("length") or 0) / 1000 for track in remote_tracks]
        if all(local_lengths) and all(remote_lengths):
            if len(local_lengths) == len(remote_lengths) and all(
                abs(a - b) <= 3 for a, b in zip(local_lengths, remote_lengths)
            ):
                signals.add("durations")
            elif abs(sum(local_lengths) - sum(remote_lengths)) <= 0.02 * sum(remote_lengths):
                signals.add("durations")
    return signals


def album_level(title: str | None, signals: set[str]) -> str | None:
    """"strong" (title plus two signals), "agree" (title plus one), "title" (title only)."""
    if not title:
        return None
    if len(signals) >= 2:
        return "strong"
    if signals:
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
    signals = set(album.get("signals") or ())
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


def decide(candidates: list[dict[str, object]], local_name: object = "") -> dict[str, object]:
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
