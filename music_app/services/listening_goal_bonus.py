"""Pure weekly bonus commands and Top-first weighted selection.

Pools are already-authorized server snapshots; they are never client evidence.
"""
from dataclasses import dataclass
import hashlib
import json
from zoneinfo import available_timezones

from music_app.services.listening_goals import _zone, GoalsDomainError
from music_app.services.listening_goals_commands import GoalsError, uuid_ref, revision
from music_app.services.listening_goal_bonus_settings import NORMAL_TOP_WEIGHT, PREFERRED_TOP_WEIGHT


@dataclass(frozen=True)
class BonusDrawCommand:
    request_key: str
    revision: str
    settings_revision: str
    expected_cycle_id: str | None
    timezone_name: str

    def payload(self):
        return {name: getattr(self, name) for name in (
            'request_key', 'revision', 'settings_revision', 'expected_cycle_id', 'timezone_name')}

    @property
    def digest(self):
        return hashlib.sha256(json.dumps({'action': 'bonus_draw', **self.payload()},
            sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def normalize_bonus_draw(payload):
    if type(payload) is not dict or set(payload) != {
            'request_key', 'revision', 'settings_revision', 'expected_cycle_id', 'timezone_name'}:
        raise GoalsError('invalid_command')
    try:
        _zone(payload['timezone_name'], available_timezones(), 'invalid_command')
    except GoalsDomainError as error:
        raise GoalsError(error.code) from error
    return BonusDrawCommand(uuid_ref(payload['request_key']), revision(payload['revision']),
        revision(payload['settings_revision']),
        None if payload['expected_cycle_id'] is None else uuid_ref(payload['expected_cycle_id']),
        payload['timezone_name'])


@dataclass(frozen=True)
class BonusPool:
    top_ref: str
    preferred: bool
    catalog_refs: tuple[str, ...]


def choose_bonus(pools, *, album_mode, randbelow):
    """Choose once: weighted Top, then ordered-first or uniform eligible album."""
    if type(pools) is not tuple or len(pools) > 1000 or album_mode not in ('next', 'random'):
        raise GoalsError('invalid_source_pool', 409)
    seen, eligible = set(), []
    for pool in pools:
        if not isinstance(pool, BonusPool) or type(pool.preferred) is not bool or type(pool.catalog_refs) is not tuple:
            raise GoalsError('invalid_source_pool', 409)
        uuid_ref(pool.top_ref)
        if pool.top_ref in seen or len(pool.catalog_refs) > 5000:
            raise GoalsError('invalid_source_pool', 409)
        for ref in pool.catalog_refs:
            uuid_ref(ref)
        if len(set(pool.catalog_refs)) != len(pool.catalog_refs):
            raise GoalsError('invalid_source_pool', 409)
        seen.add(pool.top_ref)
        if pool.catalog_refs:
            eligible.append(pool)
    if not eligible:
        return None
    def draw(bound):
        value = randbelow(bound)
        if type(value) is not int or not 0 <= value < bound:
            raise GoalsError('invalid_random_source', 503)
        return value
    # Stable source order makes algorithm boundaries reproducible in tests.
    eligible.sort(key=lambda pool: pool.top_ref)
    ticket = draw(sum(PREFERRED_TOP_WEIGHT if pool.preferred else NORMAL_TOP_WEIGHT for pool in eligible))
    for pool in eligible:
        weight = PREFERRED_TOP_WEIGHT if pool.preferred else NORMAL_TOP_WEIGHT
        if ticket < weight:
            index = 0 if album_mode == 'next' else draw(len(pool.catalog_refs))
            return pool.top_ref, pool.catalog_refs[index]
        ticket -= weight
    raise RuntimeError('Invalid weighted selection state')
