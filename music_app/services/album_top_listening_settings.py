"""Account preference only. This module does not qualify listens or complete Tops."""
from dataclasses import dataclass
import re

DEFAULT_COMPLETED_TARGET = 5
# Largest exact JSON integer shared by Python, PostgreSQL bigint and native JS.
MAX_COMPLETED_TARGET = 9_007_199_254_740_991
MAX_REVISION = 9_223_372_036_854_775_807
_REVISION = re.compile(r'[1-9][0-9]{0,18}')


class ListeningSettingsError(ValueError):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


@dataclass(frozen=True)
class ListeningSettingsCommand:
    completed_target: int
    settings_revision: str

    def payload(self):
        return {'completed_target': self.completed_target, 'settings_revision': self.settings_revision}


def normalize_settings(payload):
    if type(payload) is not dict or set(payload) != {'completed_target', 'settings_revision'}:
        raise ListeningSettingsError('invalid_command')
    target, revision = payload['completed_target'], payload['settings_revision']
    if (type(target) is not int or not 1 <= target <= MAX_COMPLETED_TARGET
            or type(revision) is not str or _REVISION.fullmatch(revision) is None
            or int(revision) > MAX_REVISION):
        raise ListeningSettingsError('invalid_command')
    return ListeningSettingsCommand(target, revision)


def project_settings(row):
    if row is None:
        return {'completed_target': DEFAULT_COMPLETED_TARGET, 'settings_revision': '1',
                'preference_status': 'default'}
    command = normalize_settings({'completed_target': row['completed_target'],
                                  'settings_revision': str(row['revision'])})
    return {**command.payload(), 'preference_status': 'saved'}
