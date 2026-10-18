"""Strict local album taste values. Identity and serialization are not authority."""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import re
from types import MappingProxyType

BROWSE = 'library.browse.read'
MANAGE = 'library.album_preferences.manage'
MAX_ALBUM_IDS = 1000
_PROGRESS_KEYS = frozenset({'to_listen', 'is_relisten', 'can_toggle_to_listen'})
_REF = re.compile(r'inventory-album:([1-9][0-9]*):([1-9][0-9]*)', re.ASCII)


class AlbumPreferenceError(ValueError):
    def __init__(self, code: str, status: int = 400):
        self.code = code
        self.status = status
        super().__init__(code)


def positive_id(value: object) -> int:
    if type(value) is not int or not 0 < value <= 9223372036854775807:
        raise AlbumPreferenceError('invalid_album_identity')
    return value


def normalize_album_preference_patch(patch: object) -> dict[str, object]:
    if not isinstance(patch, Mapping) or not patch or set(patch) - {'rating', 'favorite'}:
        raise AlbumPreferenceError('invalid_album_preference_patch')
    result = dict(patch)
    if 'rating' in result and result['rating'] is not None and (
            type(result['rating']) is not int or not 1 <= result['rating'] <= 10):
        raise AlbumPreferenceError('invalid_album_rating')
    if 'favorite' in result and type(result['favorite']) is not bool:
        raise AlbumPreferenceError('invalid_album_favorite')
    return result


@dataclass(frozen=True)
class AlbumPreferenceCommand:
    library_id: int
    album_id: int
    expected_revision: int
    patch: Mapping[str, object]


def parse_album_preference_command(payload: object, *, library_id: int) -> AlbumPreferenceCommand:
    """Caller enforces 4096-byte JSON limit and rejects duplicate JSON keys."""
    positive_id(library_id)
    if not isinstance(payload, Mapping) or set(payload) != {'album_ref', 'expected_revision', 'patch'}:
        raise AlbumPreferenceError('invalid_album_preference_command')
    ref = payload['album_ref']
    match = _REF.fullmatch(ref) if isinstance(ref, str) and len(ref) <= 80 else None
    if match is None or positive_id(int(match[1])) != library_id:
        raise AlbumPreferenceError('invalid_album_identity')
    album_id = positive_id(int(match[2]))
    revision = payload['expected_revision']
    if type(revision) is not int or not 0 <= revision <= 9223372036854775807:
        raise AlbumPreferenceError('invalid_preference_revision')
    return AlbumPreferenceCommand(library_id, album_id, revision,
                                  MappingProxyType(normalize_album_preference_patch(payload['patch'])))


def validated_progress_fields(value: object = None) -> dict[str, bool]:
    """Input must already have independent actor/library/generation/context proof.

    Validation is deliberately not a provenance check. Never pass legacy overlay
    dictionaries, generic defaults or cached path matches as this explicit input.
    """
    if value is None:
        return {}
    if not isinstance(value, Mapping) or set(value) - _PROGRESS_KEYS or any(
            type(v) is not bool for v in value.values()):
        raise AlbumPreferenceError('invalid_verified_progress')
    return dict(value)


def serialize_own_album_preference(preference: Mapping | None, *, library_id: int,
        context_ref: str, can_edit: bool = False, verified_progress: Mapping | None = None,
        expected_account_id: int | None = None, expected_album_id: int | None = None) -> dict:
    """The sole own taste wire mapper; caller supplies final live authority."""
    positive_id(library_id)
    if not isinstance(context_ref, str) or not context_ref or type(can_edit) is not bool:
        raise AlbumPreferenceError('invalid_preference_context')
    for expected in (expected_account_id, expected_album_id):
        if expected is not None:
            positive_id(expected)
    result = {'album_ref': None, 'context_ref': context_ref, 'rating': None,
              'is_favorite': None, 'favorite_override': None, 'favorite_source': None,
              'taste_state': 'unavailable', 'preference_revision': None,
              'can_edit': False, 'allowed_actions': {'can_manage_album_preferences': False}}
    if preference is not None:
        if not isinstance(preference, Mapping) or preference.get('taste_state') != 'available':
            raise AlbumPreferenceError('invalid_album_preference_state')
        album_id = positive_id(preference.get('album_id'))
        if positive_id(preference.get('library_id')) != library_id:
            raise AlbumPreferenceError('invalid_album_identity')
        if (expected_album_id is not None and album_id != expected_album_id
                or expected_account_id is not None
                and positive_id(preference.get('account_id')) != expected_account_id):
            raise AlbumPreferenceError('invalid_album_identity')
        rating, favorite, override, revision = (preference.get(k) for k in
            ('rating', 'favorite', 'favorite_override', 'preference_revision'))
        normalize_album_preference_patch({'rating': rating, 'favorite': favorite})
        if (override is not None and type(override) is not bool
                or favorite is not (override if override is not None else False)
                or preference.get('favorite_source') != ('personal' if override is not None else None)
                or type(revision) is not int or not 0 <= revision <= 9223372036854775807
                or revision == 0 and (rating is not None or override is not None)):
            raise AlbumPreferenceError('invalid_album_preference_state')
        result.update(album_ref=f'inventory-album:{library_id}:{album_id}', rating=rating,
                      is_favorite=favorite, favorite_override=override,
                      favorite_source=preference.get('favorite_source'), taste_state='available',
                      preference_revision=revision, can_edit=can_edit,
                      allowed_actions={'can_manage_album_preferences': can_edit})
    result.update(validated_progress_fields(verified_progress))
    return result
