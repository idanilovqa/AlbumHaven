from __future__ import annotations

from collections import Counter, defaultdict

from music_app.services.library_roots import get_primary_music_root
from music_app.services.relations import build_artist_alias_views
from music_app.services.utils import repair_display_text


def artist_casefold_key(value: object) -> str:
    text = repair_display_text(str(value or "")) or str(value or "")
    return " ".join(text.strip().split()).casefold()


def prefer_group_artist_name(left: str, right: str) -> str:
    left_text = str(left or "").strip()
    right_text = str(right or "").strip()
    if not left_text:
        return right_text
    if not right_text:
        return left_text
    return min(
        [left_text, right_text],
        key=lambda value: (
            len(value),
            sum(1 for char in value if not char.isalnum() and not char.isspace()),
            value.casefold(),
        ),
    )


def _choose_casefold_canonical_artist(names: set[str], counts: Counter[str]) -> str:
    return max(
        names,
        key=lambda value: (
            int(counts.get(value, 0)),
            -sum(1 for char in value if char.isupper()),
            -len(value),
            value.casefold(),
        ),
    )


def _merge_alias_cluster(
    canonical: str,
    aliases: set[str] | list[str] | tuple[str, ...],
    enriched_alias_to_canonical: dict[str, str],
    enriched_canonical_to_aliases: dict[str, set[str]],
) -> None:
    canonical_text = str(canonical or "").strip()
    if not canonical_text:
        return

    merged_aliases = {
        str(alias or "").strip()
        for alias in aliases or []
        if str(alias or "").strip()
    }
    merged_aliases.add(canonical_text)
    existing_canonical_candidates: set[str] = set()

    pending = list(merged_aliases)
    seen_pending: set[str] = set()
    while pending:
        alias_text = str(pending.pop() or "").strip()
        if not alias_text or alias_text in seen_pending:
            continue
        seen_pending.add(alias_text)
        existing_canonical = str(
            enriched_alias_to_canonical.get(alias_text, alias_text) or ""
        ).strip()
        if existing_canonical and existing_canonical not in merged_aliases:
            existing_canonical_candidates.add(existing_canonical)
            merged_aliases.add(existing_canonical)
            pending.append(existing_canonical)
        if existing_canonical:
            for existing_alias in enriched_canonical_to_aliases.pop(existing_canonical, set()):
                existing_alias_text = str(existing_alias or "").strip()
                if existing_alias_text and existing_alias_text not in merged_aliases:
                    merged_aliases.add(existing_alias_text)
                    pending.append(existing_alias_text)

    for candidate in existing_canonical_candidates:
        candidate_text = str(candidate or "").strip()
        if candidate_text and candidate_text in merged_aliases:
            canonical_text = prefer_group_artist_name(canonical_text, candidate_text)

    for alias_text in merged_aliases:
        enriched_alias_to_canonical[alias_text] = canonical_text
        enriched_canonical_to_aliases[canonical_text].add(alias_text)
    enriched_canonical_to_aliases[canonical_text].add(canonical_text)


def enrich_casefold_artist_alias_views(
    albums,
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
    *,
    allow_rebuild_alias_views: bool = True,
    config: object = None,
) -> tuple[dict[str, str], dict[str, list[str]]]:
    enriched_alias_to_canonical = {
        str(alias or "").strip(): str(canonical or "").strip()
        for alias, canonical in (alias_to_canonical or {}).items()
        if str(alias or "").strip()
    }
    enriched_canonical_to_aliases: dict[str, set[str]] = defaultdict(set)
    for canonical, aliases in (canonical_to_aliases or {}).items():
        canonical_text = str(canonical or "").strip()
        if not canonical_text:
            continue
        enriched_canonical_to_aliases[canonical_text].add(canonical_text)
        for alias in aliases or []:
            alias_text = str(alias or "").strip()
            if alias_text:
                enriched_canonical_to_aliases[canonical_text].add(alias_text)

    has_persisted_alias_views = bool(enriched_alias_to_canonical) or bool(
        enriched_canonical_to_aliases
    )
    if allow_rebuild_alias_views and not has_persisted_alias_views and config is not None:
        rebuilt_alias_views = build_artist_alias_views(
            list(albums or []),
            get_primary_music_root(config),
        )
        for canonical, aliases in (
            rebuilt_alias_views.get("canonical_to_aliases", {}) or {}
        ).items():
            _merge_alias_cluster(
                str(canonical or "").strip(),
                set(aliases or []),
                enriched_alias_to_canonical,
                enriched_canonical_to_aliases,
            )

    counts: Counter[str] = Counter()
    casefold_buckets: dict[str, set[str]] = defaultdict(set)
    for album in albums or []:
        raw_names = [str(getattr(album, "album_artist", "") or "").strip()]
        raw_names.extend(
            str(member or "").strip() for member in (getattr(album, "artists", []) or [])
        )
        for raw_name in raw_names:
            if not raw_name:
                continue
            counts[raw_name] += 1
            casefold_key = artist_casefold_key(raw_name)
            if casefold_key:
                casefold_buckets[casefold_key].add(raw_name)

    for names in casefold_buckets.values():
        if len(names) < 2:
            continue
        canonical = _choose_casefold_canonical_artist(names, counts)
        _merge_alias_cluster(
            canonical,
            names,
            enriched_alias_to_canonical,
            enriched_canonical_to_aliases,
        )

    return (
        enriched_alias_to_canonical,
        {
            artist: sorted(list(aliases), key=lambda value: value.casefold())
            for artist, aliases in enriched_canonical_to_aliases.items()
        },
    )
