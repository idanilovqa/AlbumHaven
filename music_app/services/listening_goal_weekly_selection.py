"""Pure selection over an authorized snapshot; previews never advance history.

The caller persists allocation_cursor only when a weekly draw is committed.
Randomness is injected server-side; clients cannot choose a seed or source facts.
"""
from dataclasses import dataclass

from music_app.services.listening_goals_commands import GoalsError
from music_app.services.listening_goal_weekly_settings import matches_filter, manual_admission_allowed


@dataclass(frozen=True)
class WeeklyAlbum:
    catalog_ref: str | None
    title: str
    artist_display: str
    release_year: int | None = None
    genres: tuple[str, ...] = ()
    popularity: float | None = None
    cover_url: str | None = None
    inventory_ref: str | None = None
    inventory_album_id: int | None = None

    @property
    def candidate_ref(self):
        if self.catalog_ref is not None:return self.catalog_ref
        if self.inventory_ref is not None:return self.inventory_ref
        raise GoalsError('invalid_source_metadata',409)


@dataclass(frozen=True)
class WeeklySource:
    source: str
    top_ref: str | None
    title: str
    # Complete board order, including played albums, supplied by the server.
    albums: tuple[WeeklyAlbum, ...]
    completed_refs: frozenset[str] = frozenset()


@dataclass(frozen=True)
class WeeklyPick:
    album: WeeklyAlbum
    source: str
    top_ref: str | None
    suggested: bool
    objective: str


def nearly_finished(source):
    """Only approved threshold bands. Unsettled middle sizes receive no boost."""
    size = len(source.albums)
    if not size:
        return False
    completed = sum(a.candidate_ref in source.completed_refs for a in source.albums)
    if completed == size:
        return False
    threshold = 0.75 if size <= 20 else (0.90 if size >= 100 else None)
    return threshold is not None and completed / size >= threshold


def _draw(values, randbelow):
    index = randbelow(len(values))
    if type(index) is not int or not 0 <= index < len(values):
        raise GoalsError('invalid_random_source', 503)
    return values[index]


def _preference_score(album, filters):
    genres = [f for f in filters if f['kind'] == 'genre' and f['maximum'] > 0]
    dates = [f for f in filters if f['kind'] != 'genre' and f['maximum'] > 0]
    # Genre and date are dimensions; alternatives within a dimension are OR.
    return int(any(matches_filter(album, f) for f in genres)) + int(any(matches_filter(album, f) for f in dates))


def choose_weekly_suggestions(settings, sources, *, usual_genres, excluded_refs=frozenset(),
                              allocation_cursor=0, randbelow):
    """Return picks plus the next cursor, without mutating state or source membership."""
    if type(allocation_cursor) is not int or allocation_cursor < 0:
        raise GoalsError('invalid_allocation_cursor', 409)
    usual = frozenset(g.strip().casefold() for g in usual_genres)
    excluded = set(excluded_refs)
    excluded.update(ref for source in sources if source.source in settings['sources'] for ref in source.completed_refs)
    picks = []
    for slot in range(settings['suggestion_count']):
        eligible = []
        for board in sources:
            if board.source not in settings['sources']:
                continue
            unplayed = [(pos, album) for pos, album in enumerate(board.albums)
                        if album.candidate_ref not in board.completed_refs]
            # Truncate BEFORE excluding already selected IDs: never skip ahead.
            if board.source == 'playthroughs':
                unplayed = unplayed[:1]
            for position, album in unplayed:
                if album.candidate_ref not in excluded:
                    eligible.append((board, position, album))
        if not eligible:
            break
        objective = 'preferences'
        if settings['discover']:
            objective = 'playthrough' if (allocation_cursor + slot) % 2 == 0 else 'discovery'
        if objective == 'playthrough':
            pool = [row for row in eligible if row[0].source == 'playthroughs']
            # Missing playthrough opportunities should still discover, not stall.
            if not pool:
                objective = 'discovery'
        if objective == 'discovery':
            pool = [row for row in eligible if row[2].genres and usual and
                    not {g.strip().casefold() for g in row[2].genres}.intersection(usual)]
        if objective == 'preferences' or not pool:
            objective = 'preferences'
            pool = eligible
        # Discovery ignores BOTH genre and year settings. Preferences are soft:
        # best available dimension match naturally relaxes when exhausted.
        if objective != 'discovery' and settings['prefer_preferences'] and settings['filters']:
            best = max(_preference_score(row[2], settings['filters']) for row in pool)
            pool = [row for row in pool if _preference_score(row[2], settings['filters']) == best]
        # Choose source category first; default Tops/Playthroughs have equal odds
        # regardless of the number of boards in either category.
        category = _draw(sorted({row[0].source for row in pool}), randbelow)
        pool = [row for row in pool if row[0].source == category]
        preferred = settings['preferred_playthrough_refs']
        priority = [row for row in pool if row[0].source == 'playthroughs' and row[0].top_ref in preferred]
        if priority:
            pool = priority
        if settings['prefer_nearly_finished']:
            closing = [row for row in pool if nearly_finished(row[0])]
            if closing:
                pool = closing
        if settings['selection'] == 'popular':
            known = [row for row in pool if row[2].popularity is not None]
            if known:
                best = max(row[2].popularity for row in known)
                pool = [row for row in known if row[2].popularity == best]
        elif settings['selection'] == 'position' and category != 'library':
            best = min(row[1] for row in pool)
            pool = [row for row in pool if row[1] == best]
        # One album in several Tops must not multiply its chance within a source.
        unique = {}
        for row in pool:
            unique.setdefault(row[2].candidate_ref, row)
        board, _, album = _draw(list(unique.values()), randbelow)
        picks.append(WeeklyPick(album, board.source, board.top_ref, True, objective))
        excluded.add(album.candidate_ref)
    return tuple(picks), allocation_cursor + len(picks)


def preview_week(settings, sources, *, usual_genres, excluded_refs=frozenset(), allocation_cursor=0, randbelow):
    """Illustrative manual choices plus actual suggested candidates, not admissions."""
    suggestions, _ = choose_weekly_suggestions(settings, sources, usual_genres=usual_genres,
        excluded_refs=excluded_refs, allocation_cursor=allocation_cursor, randbelow=randbelow)
    excluded = set(excluded_refs) | {pick.album.candidate_ref for pick in suggestions}
    candidates = {}
    for board in sources:
        if board.source not in settings['sources']:
            continue
        for album in board.albums:
            if album.candidate_ref not in excluded and album.candidate_ref not in board.completed_refs:
                candidates.setdefault(album.candidate_ref, (album, board))
    # Make each configured dimension visible where possible without turning caps
    # into required quotas or admitting a manual album over any overlapping cap.
    ranked = sorted(candidates.values(), key=lambda row: -_preference_score(row[0], settings['filters']))
    manual = []
    remaining = list(ranked)
    for rule in settings['filters']:
        if rule['maximum'] == 0:
            continue
        chosen = next((row for row in remaining if matches_filter(row[0], rule)
                       and manual_admission_allowed(settings, [p.album for p in manual], row[0])), None)
        if chosen:
            album, board = chosen
            manual.append(WeeklyPick(album, board.source, board.top_ref, False, 'manual'))
            remaining.remove(chosen)
    for album, board in remaining:
        if manual_admission_allowed(settings, [p.album for p in manual], album):
            manual.append(WeeklyPick(album, board.source, board.top_ref, False, 'manual'))
    return tuple(manual) + suggestions
