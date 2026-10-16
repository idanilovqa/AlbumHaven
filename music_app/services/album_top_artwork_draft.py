"""Typed, local pending artwork selections; no working membership mutations."""
from music_app.services.owned_album_tops import (
    AlbumTopError, MAX_TOP_ITEMS, top_uuid, top_revision,
    _draft_item_selections, normalize_top_publication_preview,
)


def _identity(value):
    result = top_uuid(value)
    if result == '00000000-0000-0000-0000-000000000000':
        raise AlbumTopError('invalid_command')
    return result


def normalize(payload):
    if type(payload) is not dict or set(payload) != {
            'revision', 'request_key', 'request_generation', 'draft_ref', 'draft_revision', 'rows'}:
        raise AlbumTopError('invalid_command')
    generation = payload['request_generation']
    if type(generation) is not int or not 1 <= generation <= 253402300799:
        raise AlbumTopError('invalid_command')
    rows = payload['rows']
    if type(rows) is not list or len(rows) > MAX_TOP_ITEMS:
        raise AlbumTopError('invalid_command')
    refs, choices, selections = [], [], []
    for row in rows:
        if type(row) is not dict or set(row) != {'row_ref', 'selection', 'include_artwork'}:
            raise AlbumTopError('invalid_command')
        if type(row['include_artwork']) is not bool:
            raise AlbumTopError('invalid_command')
        refs.append(_identity(row['row_ref']))
        choices.append(row['include_artwork'])
        selections.append(row['selection'])
    if len(set(refs)) != len(refs):
        raise AlbumTopError('invalid_command')
    selections = _draft_item_selections(selections)
    if any(row['kind'] not in {'existing', 'new_local'} or row['source']['kind'] != 'local'
           for row in selections):
        raise AlbumTopError('invalid_command')
    items = [{'item_ref': row.get('item_ref'), 'album_ref': row['album_ref'],
              'selected_local_album_id': row['source']['selected_local_album_id'],
              'selected_source_ref': row['source']['selected_source_ref']} for row in selections]
    draft = normalize_top_publication_preview({'revision': payload['revision'], 'items': items})
    return {'draft': draft, 'row_refs': refs, 'choices': choices,
            'request_key': _identity(payload['request_key']), 'request_generation': generation,
            'draft_ref': _identity(payload['draft_ref']), 'draft_revision': top_revision(payload['draft_revision'])}


def manifest_row(row_ref, item, position, included, scope):
    # The temporary row identity never occupies the saved item_ref field.
    return {'row_ref': row_ref, 'row_kind': 'existing' if item['item_ref'] is not None else 'new_local',
            'saved_item_ref': item['item_ref'], 'catalog_ref': item['album_ref'], 'position': position,
            **scope, 'included': included}
