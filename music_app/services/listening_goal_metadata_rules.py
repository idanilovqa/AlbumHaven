"""Pure, versioned Goals metadata rules; no I/O or inferred unknown evidence.

`broad_parents` unions only the exact aliases below. Unknown is an empty set,
not the explicit `other` parent. `popularity_proxy` is a cached count proxy,
not a normalized popularity score: rows have track_ref/provider/entity_ref/count.
`usual_genres` requires five distinct albums with mapped genre evidence.
"""
from collections import Counter
from collections.abc import Iterable, Mapping
from math import ceil, isfinite
from statistics import median
from unicodedata import normalize

RULES_VERSION = 'goals-exact-genre-aliases-v1'
POPULARITY_VERSION = 'goals-cached-count-median-half-tracks-v1'
TASTE_VERSION = 'goals-five-album-80pct-incidences-ties-v1'

# Deliberately explicit. Do not add substring matching, slash splitting, or an
# unknown-to-other fallback: those silently change admission/discovery meaning.
_PARENT_ALIASES = {
    'progressive rock': ('progressive rock', 'prog rock', 'prog-rock'),
    'metal': ('metal', 'heavy metal', 'progressive metal', 'prog metal',
              'prog-metal', 'death metal', 'black metal', 'thrash metal',
              'power metal', 'doom metal', 'symphonic metal'),
    'world/folk': ('world/folk', 'world / folk', 'world', 'world music', 'folk',
                   'folk music', 'traditional folk'),
    'rock': ('rock', 'hard rock', 'alternative rock', 'indie rock',
             'psychedelic rock', 'classic rock'),
    'jazz': ('jazz',), 'classical': ('classical', 'classical music'),
    'pop': ('pop', 'pop music'), 'electronic': ('electronic', 'electronica'),
    'hip-hop': ('hip-hop', 'hip hop', 'rap'),
    'r&b': ('r&b', 'r & b', 'rhythm and blues'),
    'blues': ('blues',), 'country': ('country', 'country music'),
    'punk': ('punk', 'punk rock'), 'reggae': ('reggae',),
    'soul': ('soul',), 'funk': ('funk',), 'soundtrack': ('soundtrack', 'soundtracks'),
    'other': ('other',),
}


def normalize_genre_label(value: str) -> str:
    """Normalize Unicode compatibility, case and whitespace, never semantics."""
    if not isinstance(value, str):
        raise TypeError('Genre labels must be strings')
    return ' '.join(normalize('NFKC', value).casefold().split())


_ALIASES = {normalize_genre_label(alias): parent
            for parent, aliases in _PARENT_ALIASES.items() for alias in aliases}
BROAD_PARENTS = frozenset(_PARENT_ALIASES)


def broad_parents(labels: Iterable[str]) -> frozenset[str]:
    """Return the multi-parent union; a single label is accepted as one label."""
    if isinstance(labels, str):
        labels = (labels,)
    return frozenset(parent for label in labels
                     if (parent := _ALIASES.get(normalize_genre_label(label))))


def popularity_proxy(track_refs: Iterable[str], observations: Iterable[Mapping]) -> float | int | None:
    """Median distinct provider-entity counts with >= half the tracks covered.

    Only nonnegative integer counts qualify (bool is not a count). Repeated
    provider/entity rows contribute once to the median; conflicting counts drop
    that entity entirely. Coverage uses distinct known track IDs attached to
    surviving entities, not row count. Unknown or invalid rows never add coverage.
    The loader owns observation freshness/provenance and readable-track scope.
    """
    tracks = {ref for ref in track_refs if isinstance(ref, str) and ref}
    if not tracks:
        return None
    entities: dict[tuple[str, str], tuple[int, set[str]]] = {}
    conflicts = set()
    for row in observations:
        if not isinstance(row, Mapping):
            continue
        track, provider, entity, count = (row.get(key) for key in
                                          ('track_ref', 'provider', 'entity_ref', 'count'))
        if (not isinstance(track, str) or track not in tracks
                or not isinstance(provider, str) or not provider.strip()
                or not isinstance(entity, str) or not entity.strip()
                or type(count) is not int or count < 0):
            continue
        key = (provider.strip().casefold(), entity.strip())
        if key in conflicts:
            continue
        prior = entities.get(key)
        if prior and prior[0] != count:
            conflicts.add(key)
            entities.pop(key)
        elif prior:
            prior[1].add(track)
        else:
            entities[key] = (count, {track})
    covered = set().union(*(value[1] for value in entities.values()))
    if len(covered) * 2 < len(tracks):
        return None
    # Contract counts are integers; guard an unrepresentable even-count midpoint
    # instead of turning a corrupt extreme cache value into Infinity or crashing.
    try:
        result = median(value[0] for value in entities.values())
        return result if isfinite(result) else None
    except (OverflowError, ValueError):
        return None


def usual_genres(album_parents: Mapping[str, Iterable[str]], *,
                 minimum_albums: int = 5, coverage: float = 0.8) -> frozenset[str] | None:
    """Smallest frequency-ranked parent set covering the incidence threshold.

    Count each known parent once per distinct album, retain the entire tie group
    at the cutoff, and exclude unmapped albums from the minimum evidence check.
    None means insufficient evidence; it must not mean every genre is unfamiliar.
    Callers own the qualifying album/listening-event evidence scope.
    """
    if type(minimum_albums) is not int or minimum_albums < 5:
        raise ValueError('At least five albums are required')
    if isinstance(coverage, bool) or not isinstance(coverage, (int, float)) or not 0 < coverage <= 1:
        raise ValueError('Coverage must be in (0, 1]')
    evidence = [broad_parents(parents) for album, parents in album_parents.items()
                if isinstance(album, str) and album]
    evidence = [parents for parents in evidence if parents]
    if len(evidence) < minimum_albums:
        return None
    counts = Counter(parent for parents in evidence for parent in parents)
    target = ceil(sum(counts.values()) * coverage)
    selected, accumulated = set(), 0
    for frequency in sorted(set(counts.values()), reverse=True):
        tied = {parent for parent, count in counts.items() if count == frequency}
        selected.update(tied)
        accumulated += frequency * len(tied)
        if accumulated >= target:
            break
    return frozenset(selected)
