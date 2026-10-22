"""Fixed current owner reads for explicit native artwork consent.

No independent transaction factory, preparation writes, file access or public
projection. Retained choices describe the active publication, not working rows.
"""
import re

from music_app.services import album_top_publication as publication
from music_app.services import album_top_publication_sources as sources
from music_app.services.album_top_artwork_review import _json_size
from music_app.services.album_top_publication_authority import (
    publication_owner_eligibility, require_source_browse,
)
from music_app.services.owned_album_tops import (
    AlbumTopError, BROWSE, MANAGE, ITEMS, ACCESS, top_uuid,
)
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import require_private_action

_ACTIONS = (BROWSE, MANAGE, ITEMS, ACCESS)
_CONTEXT = re.compile(r'[0-9a-f]{64}\Z', re.ASCII)
_MAX_RESPONSE = 2 * 1024 * 1024


def _identity(top_ref, context_ref):
    ref = top_uuid(top_ref)
    if ref == '00000000-0000-0000-0000-000000000000' or type(context_ref) is not str or not _CONTEXT.fullmatch(context_ref):
        raise AlbumTopError('invalid_command')
    return ref


def _unavailable():
    raise AlbumTopError('publication_unavailable', 503)


def _retained_choices(connection, top, publication_ref):
    header = connection.execute('''select l.row_count,l.included_count,
        (select count(*) from app.album_list_publication_items i
          where i.publication_ref=l.publication_ref) as published_count
        from app.album_top_artwork_publication_lineage l where l.publication_ref=%s
          and l.top_ref=%s and l.library_id=%s and l.owner_account_id=%s''',
        (publication_ref, top['ref'], top['library_id'], top['owner_account_id'])).fetchone()
    if (header is None or type(header['row_count']) is not int
            or not 0 <= header['row_count'] <= 5000
            or header['published_count'] != header['row_count']
            or type(header['included_count']) is not int
            or not 0 <= header['included_count'] <= header['row_count']):
        _unavailable()
    # Compact immutable identity only. Never join current working membership:
    # later legitimate working edits must not masquerade as retained corruption.
    rows = connection.execute('''select m.item_ref,m.catalog_ref,m.local_album_id,
        m.metadata_source_ref,m.metadata_root_id,m.artwork_root_id,m.included,m.curator_position,
        ((m.top_ref,m.library_id,m.owner_account_id)=(%s,%s,%s)
          and (m.item_ref,m.catalog_ref,m.presentation_ref,m.original_position,m.curator_position,m.top_ref,m.library_id)
            =(i.item_ref,i.catalog_ref,i.presentation_ref,i.original_position,i.curator_position,i.top_ref,i.library_id)
          and h.catalog_ref=m.catalog_ref and h.contract_version=1
          and (e.library_id,e.selected_local_album_id,e.selected_source_ref,e.selected_library_root_id,e.capture_builder_version)
            =(m.library_id,m.local_album_id,m.metadata_source_ref,m.metadata_root_id,1)
          and s.sealed_at is not null and s.seal_contract_version=1
          and (s.library_id,s.selected_source_ref,s.capture_builder_version,s.evidence_digest)
            =(e.library_id,e.selected_source_ref,e.capture_builder_version,e.evidence_digest)
          and ((m.included and m.artwork_root_id>0 and m.asset_ref is not null and m.proof_value_digest is not null)
            or (not m.included and m.artwork_root_id is null and m.asset_ref is null and m.proof_value_digest is null))) as valid
        from app.album_top_artwork_publication_rows m
        left join app.album_list_publication_items i on i.publication_ref=m.publication_ref and i.item_ref=m.item_ref
        left join catalog.album_presentation_versions h on h.ref=m.presentation_ref
        left join library.album_presentation_evidence e on e.presentation_ref=m.presentation_ref
        left join library.album_presentation_seals s on s.presentation_ref=m.presentation_ref
        where m.publication_ref=%s order by m.curator_position limit 5001''',
        (top['ref'], top['library_id'], top['owner_account_id'], publication_ref)).fetchall()
    if len(rows) != header['row_count']:
        _unavailable()
    choices, metadata, artwork, seen_items, seen_albums = [], [], [], set(), set()
    for position, row in enumerate(rows, 1):
        if (row['valid'] is not True or row['curator_position'] != position
                or type(row['included']) is not bool
                or type(row['local_album_id']) is not int or row['local_album_id'] <= 0
                or type(row['metadata_root_id']) is not int or row['metadata_root_id'] <= 0):
            _unavailable()
        item, album, source = (str(row[key]) for key in ('item_ref', 'catalog_ref', 'metadata_source_ref'))
        if item in seen_items or album in seen_albums:
            _unavailable()
        seen_items.add(item)
        seen_albums.add(album)
        choices.append({'item_ref': item, 'album_ref': album,
            'selected_local_album_id': row['local_album_id'], 'selected_source_ref': source,
            'position': position, 'included': row['included']})
        metadata.append({'selected_local_album_id': row['local_album_id'],
            'selected_source_ref': source, 'selected_library_root_id': row['metadata_root_id']})
        if row['included']:
            artwork.append({'selected_local_album_id': row['local_album_id'],
                            'artwork_root_id': row['artwork_root_id']})
    if len(artwork) != header['included_count']:
        _unavailable()
    return choices, metadata, artwork


class TopArtworkOwnerService:
    def __init__(self, owner):
        self.owner = owner

    def read_state(self, context, *, top_ref, context_ref, constraints=None):
        ref = _identity(top_ref, context_ref)
        with self.owner._authorized(context, constraints) as (connection, live, _):
            top = self.owner._top(connection, live, ref)
            self.owner._require(live, _ACTIONS, constraints, top, owner_only=True)
            projection = publication.saved_projection(self.owner, connection, live, top, constraints)
            version, choices, metadata, artwork = None, [], [], []
            if projection['state'] == 'enabled':
                version = publication.publication_version(connection, top, projection['publication_ref'])
                if version == 2:
                    choices, metadata, artwork = _retained_choices(connection, top, projection['publication_ref'])
            result = {'version': 1, 'top_ref': ref, 'revision': str(top['revision']),
                'publication': projection, 'publication_contract_version': version,
                'prior_choices': choices, 'request_generation': 253402300799}
            # Charge the largest legal timestamp before final policy/clock.
            _json_size(result, _MAX_RESPONSE)
            # Finish blocking issuance I/O before the complete final policy fence.
            issued = connection.execute('select floor(extract(epoch from clock_timestamp()))::bigint as issued').fetchone()['issued']
            if type(issued) is not int or not 1 <= issued <= 253402300799:
                _unavailable()
            result['request_generation'] = issued
            if version == 2:
                publication_owner_eligibility(connection, top=top, config=self.owner._config,
                    sources=metadata, artwork_sources=artwork, constraints=constraints)
                for source in metadata:
                    require_source_browse(live, source, constraints)
                for source in artwork:
                    require_private_action(live, 'library.artwork.read',
                        resource=ResourceScope('album', str(source['selected_local_album_id'])), constraints=constraints)
                    require_private_action(live, BROWSE,
                        resource=ResourceScope('library_root', str(source['artwork_root_id'])), constraints=constraints)
            self.owner._require(live, _ACTIONS, constraints, top, owner_only=True)
            return result

    def read_sources(self, context, *, top_ref, payload, context_ref, cursor_secret, constraints=None):
        _identity(top_ref, context_ref)
        values = sources.validate_draft_request(top_ref=top_ref, payload=payload, context_ref=context_ref)
        with self.owner._authorized(context, constraints) as (connection, live, _):
            return sources.read_draft_sources(self.owner, connection, live,
                cursor_secret=cursor_secret, constraints=constraints, **values)
