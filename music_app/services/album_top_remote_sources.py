"""Typed remote Top facts and pending selectors; never membership authority.

No provider I/O, Goals read, catalog mapping or publication admission occurs here.
Database callers must retain the existing Top/current-library authority locks.
"""
from dataclasses import dataclass
import hashlib
import json
import re

from music_app.services.owned_album_tops import AlbumTopError, top_uuid, top_revision
from music_app.services.remote_album_evidence import (
    ReleaseGroupEvidence, RemoteAlbumEvidenceError, canonical_release_group_id,
    validate_release_group_evidence,
)

_HEX = re.compile(r'[0-9a-f]{64}\Z', re.ASCII)
_ZERO = '00000000-0000-0000-0000-000000000000'


def _ref(value):
    ref = top_uuid(value)
    if ref == _ZERO:
        raise AlbumTopError('invalid_command')
    return ref


def remote_context_ref(value):
    if type(value) is not str or _HEX.fullmatch(value) is None:
        raise AlbumTopError('invalid_command')
    return value


@dataclass(frozen=True, slots=True)
class RemoteTopDestination:
    kind: str
    ref: str
    revision: str | None

    def payload(self):
        if self.kind == 'create':
            return {'kind': 'create', 'draft_ref': self.ref}
        return {'kind': 'top', 'top_ref': self.ref, 'revision': self.revision}


def normalize_remote_destination(value):
    if type(value) is not dict:
        raise AlbumTopError('invalid_command')
    if set(value) == {'kind', 'draft_ref'} and value['kind'] == 'create':
        return RemoteTopDestination('create', _ref(value['draft_ref']), None)
    if set(value) == {'kind', 'top_ref', 'revision'} and value['kind'] == 'top':
        return RemoteTopDestination('top', _ref(value['top_ref']), top_revision(value['revision']))
    raise AlbumTopError('invalid_command')


@dataclass(frozen=True, slots=True)
class RemoteTopAcquisitionCommand:
    request_key: str
    destination: RemoteTopDestination
    release_group_id: str

    def payload(self):
        return {'request_key': self.request_key, 'destination': self.destination.payload(),
                'release_group_id': self.release_group_id}

    @property
    def digest(self):
        # Original session/context/library/owner bindings are additional exact
        # SQL columns, not omitted authorization hidden in this fact identity.
        value = ['top-remote-acquisition-v1', self.destination.payload(), self.release_group_id]
        return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
            separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def normalize_remote_acquisition(value):
    if type(value) is not dict or set(value) != {'request_key', 'destination', 'release_group_id'}:
        raise AlbumTopError('invalid_command')
    try:
        identity = canonical_release_group_id(value['release_group_id'])
    except RemoteAlbumEvidenceError as error:
        raise AlbumTopError(error.code) from None
    return RemoteTopAcquisitionCommand(_ref(value['request_key']),
        normalize_remote_destination(value['destination']), identity)


def normalize_pending_remote_selector(value):
    if (type(value) is not dict or set(value) != {'kind', 'acquisition_ref', 'evidence_version'}
            or value['kind'] != 'remote_acquisition'):
        raise AlbumTopError('invalid_command')
    return {'kind': 'remote_acquisition', 'acquisition_ref': _ref(value['acquisition_ref']),
            'evidence_version': remote_context_ref(value['evidence_version'])}


def evidence_from_row(row):
    """Validate immutable stored facts, without recreating provider JSON."""
    try:
        if row['provider'] != 'musicbrainz' or row['entity_kind'] != 'release-group':
            raise RemoteAlbumEvidenceError('invalid_provider_metadata')
        return validate_release_group_evidence(ReleaseGroupEvidence(
            row['external_id'], row['title'], row['artist_display'],
            row['first_release_date'], row['primary_type'], row['evidence_version']))
    except (KeyError, TypeError, RemoteAlbumEvidenceError):
        raise AlbumTopError('remote_evidence_unavailable', 409) from None


def project_remote_summary(facts):
    """Unavailable track metadata is distinct from a known empty track list."""
    try:
        facts = validate_release_group_evidence(facts)
    except RemoteAlbumEvidenceError:
        raise AlbumTopError('remote_evidence_unavailable', 409) from None
    return {'source_kind': 'remote_summary', 'provider': 'musicbrainz',
        'entity_kind': 'release-group', 'release_group_id': facts.release_group_id,
        'title': facts.title, 'artist_display': facts.artist_display,
        'first_release_date': facts.first_release_date, 'primary_type': facts.primary_type,
        'metadata_coverage': 'album_summary_only', 'track_metadata_status': 'unavailable',
        'track_count': None}
