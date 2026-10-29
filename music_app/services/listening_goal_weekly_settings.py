"""Canonical weekly settings and hard manual admission caps.

Suggestion preferences are intentionally separate from manual admission limits.
No source reference or browser preview confers album access.
"""
from dataclasses import dataclass
import hashlib
import json

from music_app.services.listening_goals_commands import GoalsError, revision, uuid_ref

MAX_WEEKLY_ALBUMS = 7
FILTER_KINDS = frozenset(('genre', 'newer', 'older', 'decade', 'year'))
SOURCES = ('tops', 'playthroughs', 'library')
_FIELDS = frozenset(('manual_count', 'suggestion_count', 'filters', 'sources',
    'prefer_preferences', 'discover', 'selection', 'prefer_nearly_finished',
    'preferred_playthrough_refs'))


def default_weekly_settings():
    return dict(manual_count=5, suggestion_count=1, filters=[], sources=['tops', 'playthroughs'],
        prefer_preferences=True, discover=False, selection='random',
        prefer_nearly_finished=False, preferred_playthrough_refs=[])


def _integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise GoalsError('invalid_weekly_settings')
    return value


def normalize_weekly_settings(value):
    if type(value) is not dict or set(value) != _FIELDS:
        raise GoalsError('invalid_weekly_settings')
    manual = _integer(value['manual_count'], 0, MAX_WEEKLY_ALBUMS)
    suggestions = _integer(value['suggestion_count'], 0, MAX_WEEKLY_ALBUMS)
    if not 1 <= manual + suggestions <= MAX_WEEKLY_ALBUMS:
        raise GoalsError('invalid_weekly_settings')
    for key in ('prefer_preferences', 'discover', 'prefer_nearly_finished'):
        if type(value[key]) is not bool:
            raise GoalsError('invalid_weekly_settings')
    if type(value['selection']) is not str or value['selection'] not in ('popular', 'random', 'position'):
        raise GoalsError('invalid_weekly_settings')
    sources = value['sources']
    if (type(sources) is not list or any(type(s) is not str or s not in SOURCES for s in sources)
            or len(set(sources)) != len(sources) or (suggestions and not sources)):
        raise GoalsError('invalid_weekly_settings')
    refs = value['preferred_playthrough_refs']
    if type(refs) is not list or len(refs) > 100:
        raise GoalsError('invalid_weekly_settings')
    refs = sorted(uuid_ref(ref) for ref in refs)
    if len(set(refs)) != len(refs):
        raise GoalsError('invalid_weekly_settings')
    filters = value['filters']
    if type(filters) is not list or len(filters) > 30:
        raise GoalsError('invalid_weekly_settings')
    normalized, seen = [], set()
    for item in filters:
        if type(item) is not dict or set(item) != {'kind', 'value', 'maximum'}:
            raise GoalsError('invalid_weekly_settings')
        kind, target = item['kind'], item['value']
        if type(kind) is not str or kind not in FILTER_KINDS:
            raise GoalsError('invalid_weekly_settings')
        if kind == 'genre':
            if type(target) is not str or not target.strip() or len(target) > 120:
                raise GoalsError('invalid_weekly_settings')
            target = target.strip().casefold()
        else:
            target = _integer(target, 1, 9999)
            if kind == 'decade' and (target % 10 or target > 9990):
                raise GoalsError('invalid_weekly_settings')
        maximum = _integer(item['maximum'], 0, manual)
        if (kind, target) in seen:
            raise GoalsError('invalid_weekly_settings')
        seen.add((kind, target))
        normalized.append(dict(kind=kind, value=target, maximum=maximum))
    return {**value, 'filters': normalized, 'sources': [s for s in SOURCES if s in sources],
            'preferred_playthrough_refs': refs}


@dataclass(frozen=True)
class WeeklySettingsCommand:
    request_key: str
    settings_revision: str
    settings: dict

    def payload(self):
        return dict(request_key=self.request_key, settings_revision=self.settings_revision,
                    settings=self.settings)

    @property
    def digest(self):
        return hashlib.sha256(json.dumps({'action': 'weekly_settings', **self.payload()},
            sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def normalize_weekly_settings_command(payload):
    if type(payload) is not dict or set(payload) != {'request_key', 'settings_revision', 'settings'}:
        raise GoalsError('invalid_command')
    return WeeklySettingsCommand(uuid_ref(payload['request_key']), revision(payload['settings_revision']),
                                 normalize_weekly_settings(payload['settings']))


def matches_filter(album, rule):
    """Album facts must come from the authorized server snapshot, never the client."""
    kind, value = rule['kind'], rule['value']
    if kind == 'genre':
        return value in {genre.strip().casefold() for genre in album.genres}
    year = album.release_year
    if year is None:
        return False
    return {'newer': year >= value, 'older': year <= value,
            'year': year == value, 'decade': value <= year <= value + 9}[kind]


def manual_admission_allowed(settings, current, candidate):
    """Each matching cap applies independently; caps are maxima, never quotas."""
    if len(current) >= settings['manual_count'] or any(a.candidate_ref == candidate.candidate_ref for a in current):
        return False
    for rule in settings['filters']:
        if matches_filter(candidate, rule) and sum(matches_filter(album, rule) for album in current) >= rule['maximum']:
            return False
    return True
