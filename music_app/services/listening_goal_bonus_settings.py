"""Account-owned bonus preferences. Source UUIDs are intentions, not authority."""
from dataclasses import dataclass
import hashlib
import json

from music_app.services.listening_goals_commands import GoalsError, revision, uuid_ref


PREFERRED_TOP_WEIGHT = 3
NORMAL_TOP_WEIGHT = 1
SELECTION_ALGORITHM = 'active-top-weighted-v1'
MAX_SOURCE_TOPS = 100
_FIELDS = {'request_key', 'settings_revision', 'enabled', 'source_mode',
           'selected_top_refs', 'preferred_top_refs', 'album_mode', 'unfinished_policy'}


@dataclass(frozen=True)
class BonusSettingsCommand:
    request_key: str
    settings_revision: str
    enabled: bool
    source_mode: str
    selected_top_refs: tuple[str, ...]
    preferred_top_refs: tuple[str, ...]
    album_mode: str
    unfinished_policy: str

    def payload(self):
        return {'request_key': self.request_key, 'settings_revision': self.settings_revision,
                **self.values()}

    def values(self):
        return {'enabled': self.enabled, 'source_mode': self.source_mode,
                'selected_top_refs': list(self.selected_top_refs),
                'preferred_top_refs': list(self.preferred_top_refs),
                'album_mode': self.album_mode, 'unfinished_policy': self.unfinished_policy}

    @property
    def digest(self):
        return hashlib.sha256(json.dumps({'action': 'bonus_settings', **self.payload()},
            sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def _refs(value):
    if type(value) is not list or len(value) > MAX_SOURCE_TOPS:
        raise GoalsError('invalid_command')
    refs = tuple(sorted(uuid_ref(item) for item in value))
    if len(set(refs)) != len(refs):
        raise GoalsError('invalid_command')
    return refs


def normalize_bonus_settings(payload):
    if type(payload) is not dict or set(payload) != _FIELDS:
        raise GoalsError('invalid_command')
    if (type(payload['enabled']) is not bool
            or type(payload['source_mode']) is not str or payload['source_mode'] not in {'all_active', 'selected'}
            or type(payload['album_mode']) is not str or payload['album_mode'] not in {'next', 'random'}
            or type(payload['unfinished_policy']) is not str or payload['unfinished_policy'] not in {'carry', 'larger_period'}):
        raise GoalsError('invalid_command')
    selected, preferred = _refs(payload['selected_top_refs']), _refs(payload['preferred_top_refs'])
    if (payload['source_mode'] == 'all_active' and selected
            or payload['source_mode'] == 'selected' and not set(preferred).issubset(selected)):
        raise GoalsError('invalid_command')
    return BonusSettingsCommand(uuid_ref(payload['request_key']), revision(payload['settings_revision']),
        payload['enabled'], payload['source_mode'], selected, preferred,
        payload['album_mode'], payload['unfinished_policy'])


def default_bonus_settings():
    # A new detached value for every read; disabled until explicit opt-in.
    return {'enabled': False, 'source_mode': 'all_active', 'selected_top_refs': [],
            'preferred_top_refs': [], 'album_mode': 'random', 'unfinished_policy': 'carry'}


def project_bonus_settings(row):
    values = default_bonus_settings() if row is None else {
        'enabled': row['enabled'], 'source_mode': row['source_mode'],
        'selected_top_refs': [str(ref) for ref in row['selected_top_refs']],
        'preferred_top_refs': [str(ref) for ref in row['preferred_top_refs']],
        'album_mode': row['album_mode'], 'unfinished_policy': row['unfinished_policy']}
    return {'settings_revision': str(row['revision']) if row else '1', **values,
            'selection_algorithm': SELECTION_ALGORITHM,
            'normal_top_weight': NORMAL_TOP_WEIGHT, 'preferred_top_weight': PREFERRED_TOP_WEIGHT}
