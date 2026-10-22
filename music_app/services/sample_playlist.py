"""Pure Sample selection over one caller-admitted, captured source.

Canonical, primary-group and facet facts come from trusted source owners. This
module grants no authority, reads no storage, and creates no receipt or recipe.
The caller must retain Random's supplied permutation with its unchanged source.
"""
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal
from math import isfinite

from music_app.services.popularity_snapshots import (
    CachedPopularity, LocalTrackEvidence, select_local_popular_tracks,
)


@dataclass(frozen=True, slots=True)
class SampleCandidate:
    track_id: int
    canonical_recording_id: str | None
    recording_evidence: str | None
    album_ref: str | None
    primary_artist_ref: str | None
    source_position: int
    disc_number: int | None
    track_number: int | None
    duration_seconds: int | float | Decimal | None
    styles: frozenset[str] | None
    countries: frozenset[str] | None
    popularity_track: LocalTrackEvidence | None = None
    popularity: CachedPopularity | None = None


@dataclass(frozen=True, slots=True)
class SampleOptions:
    selection_basis: str
    songs_per_group: int
    unknown_facets: str
    selection_method: str = "most_listened"
    length: str | None = None
    styles: frozenset[str] | None = None
    countries: frozenset[str] | None = None


@dataclass(frozen=True, slots=True)
class SampleSelection:
    track_ids: tuple[int, ...]
    diagnostics: tuple[tuple[int, str], ...]
    group_counts: tuple[tuple[str, int], ...]
    random_order: tuple[int, ...] | None


_LENGTH_LIMITS = {"up_to_3": 240, "up_to_5": 360,
                  "up_to_8": 540, "up_to_10": 660, "over_10": 660}


def _nonblank(value):
    return isinstance(value, str) and bool(value.strip())


def _integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def _facets(value, *, restricted=False):
    if value is not None and (type(value) is not frozenset
            or restricted and not value
            or any(not _nonblank(item) for item in value)):
        raise ValueError("Expected immutable normalized facet identities")


def _validate_options(options):
    if (not isinstance(options, SampleOptions)
            or options.selection_basis not in ("per_album", "per_artist")
            or type(options.songs_per_group) is not int or options.songs_per_group < 1
            or options.unknown_facets not in ("include", "exclude")
            or options.selection_method not in ("most_listened", "random")
            or options.length is not None and (not isinstance(options.length, str)
                or options.length not in _LENGTH_LIMITS)):
        raise ValueError("Invalid Sample options")
    _facets(options.styles, restricted=True)
    _facets(options.countries, restricted=True)


def _candidate_facts(candidate):
    """Validate only selection facts; Random must never observe cache fields."""
    if not isinstance(candidate, SampleCandidate):
        raise ValueError("Expected a normalized Sample candidate")
    if not _integer(candidate.track_id, 1, 2**63 - 1):
        raise ValueError("Expected a positive local track identity")
    if candidate.canonical_recording_id is None:
        if candidate.recording_evidence is not None:
            raise ValueError("Canonical evidence requires its identity")
    elif (not _nonblank(candidate.canonical_recording_id)
            or not _nonblank(candidate.recording_evidence)):
        raise ValueError("Canonical identity requires resolved evidence")
    for group in (candidate.album_ref, candidate.primary_artist_ref):
        if group is not None and not _nonblank(group):
            raise ValueError("Group identity must be nonblank or missing")
    if not _integer(candidate.source_position, 0, 2**63 - 1):
        raise ValueError("Expected a stable source position")
    for position in (candidate.disc_number, candidate.track_number):
        if position is not None and not _integer(position, 1, 2**31 - 1):
            raise ValueError("Expected a positive track position or unknown")
    duration = candidate.duration_seconds
    if duration is not None:
        if type(duration) not in (int, float, Decimal):
            raise ValueError("Expected a finite nonnegative duration or unknown")
        finite = duration.is_finite() if type(duration) is Decimal else (
            isfinite(duration) if type(duration) is float else True)
        if not finite or duration < 0:
            raise ValueError("Expected a finite nonnegative duration or unknown")
    _facets(candidate.styles)
    _facets(candidate.countries)
    return (candidate.track_id, candidate.canonical_recording_id,
            candidate.recording_evidence, candidate.album_ref,
            candidate.primary_artist_ref, candidate.source_position,
            candidate.disc_number, candidate.track_number, duration,
            candidate.styles, candidate.countries)


def _source_order(candidate):
    return (candidate.source_position,
            candidate.disc_number is None, candidate.disc_number or 0,
            candidate.track_number is None, candidate.track_number or 0,
            candidate.track_id)


def _filter_reasons(candidate, options):
    reasons = []
    if options.length is not None:
        if candidate.duration_seconds is None:
            if options.unknown_facets == "exclude":
                reasons.append("unknown_length")
        else:
            below = candidate.duration_seconds < _LENGTH_LIMITS[options.length]
            if below == (options.length == "over_10"):
                reasons.append("length_filtered")
    for name, selected, values in (("style", options.styles, candidate.styles),
                                   ("country", options.countries, candidate.countries)):
        if selected is None:
            continue
        if values is None:
            reasons.append("unknown_" + name)
        elif not values.intersection(selected):
            reasons.append(name + "_filtered")
    return reasons


def _prepare_candidates(candidates, options):
    """Shared validation/filter/source ordering; no popularity observation."""
    _validate_options(options)
    if not isinstance(candidates, Iterable):
        raise ValueError("Expected a captured candidate iterable")
    by_id, facts, repeats = {}, {}, {}
    for candidate in candidates:
        values = _candidate_facts(candidate)
        identity = candidate.track_id
        if identity in facts:
            if facts[identity] != values:
                raise ValueError("Conflicting local track facts")
            repeats.setdefault(identity, []).append(candidate)
        else:
            by_id[identity], facts[identity] = candidate, values
    ordered = sorted(by_id.values(), key=_source_order)
    groups = {item.track_id: (item.album_ref if options.selection_basis == "per_album"
                             else item.primary_artist_ref) for item in ordered}
    group_order = tuple(dict.fromkeys(groups[item.track_id] for item in ordered
                                     if groups[item.track_id] is not None))
    eligible, diagnostics = [], []
    for candidate in ordered:
        reasons = _filter_reasons(candidate, options)
        if not reasons:
            if candidate.canonical_recording_id is None:
                reasons.append("missing_canonical_recording")
            if groups[candidate.track_id] is None:
                reasons.append("missing_group_identity")
        if reasons:
            diagnostics.extend((candidate.track_id, reason) for reason in reasons)
        else:
            eligible.append(candidate)

    return by_id, repeats, groups, group_order, eligible, diagnostics


def _random_representatives(eligible, diagnostics):
    representatives, recordings = {}, set()
    for candidate in eligible:
        if candidate.canonical_recording_id in recordings:
            diagnostics.append((candidate.track_id, "duplicate_canonical_recording"))
        else:
            recordings.add(candidate.canonical_recording_id)
            representatives[candidate.track_id] = candidate
    return representatives


def random_representative_ids(candidates, options):
    """Authoritative pre-quota Random IDs, using exactly the evaluator's owner."""
    _validate_options(options)
    if options.selection_method != "random":
        raise ValueError("Random representatives require Random options")
    _by_id, _repeats, _groups, _order, eligible, diagnostics = _prepare_candidates(candidates, options)
    return tuple(_random_representatives(eligible, diagnostics))


def evaluate_sample_playlist(
    candidates: Iterable[SampleCandidate], options: SampleOptions, *,
    random_order: tuple[int, ...] | None = None,
) -> SampleSelection:
    """Filter, choose the canonical source copy, order, then cap each group.

The source owner supplies primary album artist, or primary track artist for
compilations; featured guests never produce quota groups. Unknown-facet policy
and quota are required inputs, not product defaults. No output is truncated.
"""
    _validate_options(options)
    if not isinstance(candidates, Iterable):
        raise ValueError("Expected a captured candidate iterable")
    if options.selection_method == "most_listened" and random_order is not None:
        raise ValueError("Most listened does not accept a Random permutation")
    by_id, repeats, groups, group_order, eligible, diagnostics = _prepare_candidates(candidates, options)

    if options.selection_method == "random":
        representatives = _random_representatives(eligible, diagnostics)
        if (type(random_order) is not tuple
                or any(not _integer(identity, 1, 2**63 - 1) for identity in random_order)
                or len(random_order) != len(representatives)
                or set(random_order) != set(representatives)):
            raise ValueError("Random requires an exact captured representative permutation")
        selected, counts = [], Counter()
        for identity in random_order:
            group = groups[identity]
            if counts[group] < options.songs_per_group:
                selected.append(identity)
                counts[group] += 1
            else:
                diagnostics.append((identity, "quota_exceeded"))
        track_ids = tuple(selected)
    else:
        mapped = {}
        for candidate in eligible:
            track, snapshot = candidate.popularity_track, candidate.popularity
            if any((other.popularity_track, other.popularity) != (track, snapshot)
                   for other in repeats.get(candidate.track_id, ())):
                raise ValueError("Conflicting local track popularity facts")
            if track is None:
                diagnostics.append((candidate.track_id, "missing_provider_mapping"))
                continue
            if (not isinstance(track, LocalTrackEvidence)
                    or track.track_id != candidate.track_id
                    or track.canonical_recording_id != candidate.canonical_recording_id):
                raise ValueError("Popularity mapping must bind this local recording")
            mapped[candidate.track_id] = candidate
        tracks = tuple(item.popularity_track for item in mapped.values())
        full_limit = max(1, len(tracks))
        selector_inputs = dict(
            is_local_readable=lambda track: True,
            matches_filter=lambda track: True,
            read_snapshot=lambda track: mapped[track.track_id].popularity,
            group_identity=lambda track: groups[track.track_id],
            tie_breaker=lambda track: _source_order(mapped[track.track_id]),
            limit=full_limit,
        )
        # Both calls keep every original eligible row: reducing to winners could
        # erase the provider-conflict evidence the shared owner must evaluate.
        uncapped = select_local_popular_tracks(
            tracks, max_per_group=full_limit, **selector_inputs)
        capped = select_local_popular_tracks(
            tracks, max_per_group=options.songs_per_group, **selector_inputs)
        diagnostics.extend(uncapped.diagnostics)
        rejected = {identity for identity, _reason in uncapped.diagnostics}
        representatives = {track.track_id for track in uncapped.tracks}
        recordings = {track.canonical_recording_id for track in uncapped.tracks}
        non_duplicates = representatives | rejected
        for candidate in mapped.values():
            if (candidate.track_id not in non_duplicates
                    and candidate.canonical_recording_id in recordings):
                diagnostics.append((candidate.track_id, "duplicate_canonical_recording"))
        track_ids = tuple(track.track_id for track in capped.tracks)
        diagnostics.extend((identity, "quota_exceeded")
                           for identity in representatives - set(track_ids))

    counts = Counter(groups[identity] for identity in track_ids)
    return SampleSelection(
        track_ids,
        tuple(sorted(diagnostics, key=lambda item: (_source_order(by_id[item[0]]), item[1]))),
        tuple((group, counts[group]) for group in group_order),
        random_order,
    )
