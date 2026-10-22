"""Dormant full private review and exact one-PNG SQL collaborators.

The shared phase owner supplies a complete, freshly authorized S snapshot and
owns every transaction, outside probe and final authority/expiry/session fence.
Only explicit review captures metadata. A witness authenticates that observation;
it never substitutes for the current full snapshot or grants access by itself.
"""
from datetime import datetime
from uuid import UUID
import hashlib

from music_app.services import album_top_artwork_draft as artwork_draft
from music_app.services import album_top_publication_evidence as evidence
from music_app.services.owned_album_tops import AlbumTopError, top_uuid
from music_app.services.social_cursors import encode_social_cursor, decode_social_cursor

_MAX_INT = 9223372036854775807
_MAX_ITEMS = 5000
_MAX_BINDING = 4 * 1024 * 1024
_MAX_SUMMARY = 36 * 1024 * 1024
_MAX_WITNESS = 5120
_MAX_TOKEN = 4096
_MAX_PNG = 327680
_MAX_IMAGES = 128 * 1024 * 1024
_PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
_ASSET_DOMAIN = 'private-top-artwork-asset-manifest-v1'
_REVIEW_DOMAIN = 'private-top-artwork-review-v1'
_WITNESS_DOMAIN = 'private-top-artwork-reviewed-metadata-v1'
_WITNESS_KEYS = frozenset(('witness_version', 'metadata_generation',
    'metadata_evidence_revision', 'asset_manifest_digest', 'review_digest', 'token'))
_IMAGE_KEYS = ('asset_ref', 'content_digest', 'width', 'height', 'byte_length')
_LEASE_KEYS = ('lease_ref', 'lease_expires_at', 'batch_request_key',
               'batch_from_revision', 'batch_items')


def _unavailable():
    raise AlbumTopError('artwork_preparation_unavailable', 409)


def _invalid_review():
    raise AlbumTopError('invalid_or_stale_review', 409)


def _limit():
    raise AlbumTopError('artwork_validation_limit', 409)


def _hex(value):
    return (type(value) is str and len(value) == 64
            and all(char in '0123456789abcdef' for char in value))


def _integer(value, low=1, high=_MAX_INT):
    if type(value) is not int or not low <= value <= high:
        _unavailable()
    return value


def _decimal(value, *, zero=False):
    if (type(value) is not str or not 1 <= len(value) <= 19
            or any(char not in '0123456789' for char in value)
            or len(value) > 1 and value[0] == '0'
            or not (0 if zero else 1) <= int(value) <= _MAX_INT):
        _unavailable()
    return value


def _uuid(value):
    if type(value) is UUID:
        value = str(value)
    if type(value) is not str or len(value) != 36:
        _unavailable()
    try:
        top_uuid(value)
    except AlbumTopError:
        _unavailable()
    if value == '00000000-0000-0000-0000-000000000000':
        _unavailable()
    return value


def _json_size(value, limit):
    """Exact existing canonical UTF-8 size, without encoding an oversized value.

    Account for escaping, delimiters and keys before retention or aggregate
    encoding. Scalar length and integer width checks precede scalar work. Only
    the fixed primitive shapes built here are accepted; no arbitrary objects.
    """
    remaining = limit

    def charge(count):
        nonlocal remaining
        remaining -= count
        if remaining < 0:
            _limit()

    def visit(item, depth):
        if depth > 8:
            _limit()
        if item is None:
            charge(4)
        elif type(item) is bool:
            charge(4 if item else 5)
        elif type(item) is int:
            if item.bit_length() > 64:
                _limit()
            charge(len(str(item)))
        elif type(item) is str:
            if len(item) > remaining:
                _limit()
            charge(2)
            for char in item:
                point = ord(char)
                if char in ('"', '\\', '\b', '\f', '\n', '\r', '\t'):
                    charge(2)
                elif point < 32:
                    charge(6)
                elif point < 128:
                    charge(1)
                elif point < 2048:
                    charge(2)
                elif 0xD800 <= point <= 0xDFFF:
                    _limit()
                else:
                    charge(3 if point <= 0xFFFF else 4)
        elif type(item) in (list, tuple):
            if len(item) > _MAX_ITEMS:
                _limit()
            charge(2 + max(0, len(item) - 1))
            for child in item:
                visit(child, depth + 1)
        elif type(item) is dict:
            if len(item) > 32:
                _limit()
            charge(2 + max(0, len(item) - 1) + len(item))
            for key, child in item.items():
                if type(key) is not str or len(key) > 64:
                    _limit()
                visit(key, depth + 1)
                visit(child, depth + 1)
        else:
            _limit()

    visit(value, 0)
    return limit - remaining


def require_ready(snapshot, preparation_revision):
    """No implicit advance, recovery, refresh, lease or mutable admission."""
    revision = _decimal(preparation_revision)
    header, rows = snapshot['header'], snapshot['rows']
    if (header['state'] != 'ready' or header['revision'] != int(revision)
            or any(header[key] is not None for key in _LEASE_KEYS)
            or type(rows) is not list or len(rows) > _MAX_ITEMS
            or type(header['item_count']) is not int or header['item_count'] != len(rows)):
        _unavailable()
    refs = set()
    included = 0
    for position, row in enumerate(rows, 1):
        row_ref = _uuid(row['row_ref'])
        if (row_ref in refs or type(row['position']) is not int or row['position'] != position
                or type(row['included']) is not bool or row['error_code'] is not None):
            _unavailable()
        refs.add(row_ref)
        if row['included']:
            included += 1
            if (row['status'] != 'ready' or not _hex(row['proof_digest'])
                    or not _hex(row['acquisition_digest'])):
                _unavailable()
        elif (row['status'] != 'excluded'
                or any(row[key] is not None for key in (*_IMAGE_KEYS, 'proof_digest', 'acquisition_digest'))):
            _unavailable()
    if (type(snapshot['included_count']) is not int or snapshot['included_count'] != included):
        _unavailable()


def _identity(snapshot, kind):
    header = snapshot['header']
    if kind not in ('saved', 'draft') or snapshot['kind'] != kind or header['preparation_kind'] != kind:
        _unavailable()
    if not _hex(header['context_ref']) or not _hex(snapshot['digest']):
        _unavailable()
    expires = header['expires_at']
    if type(expires) is not datetime or expires.tzinfo is None or expires.utcoffset() is None:
        _unavailable()
    draft_ref, draft_revision, baseline = None, None, None
    if kind == 'draft':
        draft_ref = _uuid(header['draft_ref'])
        draft_revision = str(_integer(header['draft_revision']))
        baseline = header['baseline_digest']
        if not _hex(baseline):
            _unavailable()
    elif any(header[key] is not None for key in ('draft_ref', 'draft_revision', 'baseline_digest')):
        _unavailable()
    return [str(_integer(header['library_id'])), str(_integer(header['owner_account_id'])),
        str(_integer(header['original_session_id'])), header['context_ref'], _uuid(header['top_ref']),
        str(_integer(header['top_revision'])), _uuid(header['ref']), str(_integer(header['revision'])),
        str(_integer(header['request_generation'], high=253402300799)), expires.isoformat(),
        draft_ref, draft_revision, baseline]


def _asset_fields(row):
    return [_uuid(row['asset_ref']), row['content_digest'],
        _integer(row['width'], high=256), _integer(row['height'], high=256),
        _integer(row['byte_length'], high=_MAX_PNG), 1, 'image/png',
        row['proof_digest'], row['acquisition_digest']]


def _compact(snapshot, *, kind, metadata_evidence_revision):
    require_ready(snapshot, str(_integer(snapshot['header']['revision'])))
    identity = _identity(snapshot, kind)
    _integer(snapshot['metadata_generation'], low=0)
    if not _hex(metadata_evidence_revision):
        _unavailable()
    # Freeze the full tuple, including rows, under the original review domain.
    # The fixed-size asset digest slot is charged before any row is retained.
    prefix = [_REVIEW_DOMAIN, 1, kind, *identity, snapshot['digest'], metadata_evidence_revision]
    used = _json_size([*prefix, '0' * 64, []], _MAX_BINDING)
    rows, total = [], 0
    for row in snapshot['rows']:
        saved_ref = _uuid(row['saved_item_ref']) if row['saved_item_ref'] is not None else None
        if ((kind == 'saved' and saved_ref != _uuid(row['row_ref']))
                or row['row_kind'] not in ('existing', 'new_local')
                or (row['row_kind'] == 'existing') != (saved_ref is not None)):
            _unavailable()
        image = [None] * 9
        if row['included']:
            if not _hex(row['content_digest']):
                _unavailable()
            image = _asset_fields(row)
            total += row['byte_length']
            if total > _MAX_IMAGES:
                _limit()
        compact = [_uuid(row['row_ref']), saved_ref, _uuid(row['catalog_ref']),
                   row['position'], row['included'], *image]
        used += _json_size(compact, _MAX_BINDING - used) + (1 if rows else 0)
        if used > _MAX_BINDING:
            _limit()
        rows.append(compact)
    asset_value = [_ASSET_DOMAIN, 1, rows]
    _json_size(asset_value, _MAX_BINDING)
    asset_digest = evidence.digest(asset_value)
    review_value = [*prefix, asset_digest, rows]
    # All variable rows and the complete envelope have already been charged.
    review_digest = evidence.digest(review_value)
    return asset_digest, review_digest, total


def _check_asset_header(asset, row):
    if (asset is None or _uuid(asset['ref']) != _uuid(row['asset_ref'])
            or type(asset['sanitizer_contract']) is not int or asset['sanitizer_contract'] != 1
            or asset['mime_type'] != 'image/png' or not _hex(asset['content_digest'])
            or asset['content_digest'] != row['content_digest']):
        _unavailable()
    for key, maximum in (('width', 256), ('height', 256), ('byte_length', _MAX_PNG)):
        if _integer(asset[key], high=maximum) != _integer(row[key], high=maximum):
            _unavailable()


def _capture_asset_headers(connection, snapshot):
    header = snapshot['header']
    included = [row for row in snapshot['rows'] if row['included']]
    for offset in range(0, len(included), 100):
        page = included[offset:offset + 100]
        # Dedup only the query keys. Each logical row retains its byte charge.
        wanted = sorted({_uuid(row['asset_ref']) for row in page})
        fetched = connection.execute('''select ref,sanitizer_contract,mime_type,
            content_digest,width,height,byte_length from app.album_top_artwork_assets
            where ref=any(%s::uuid[]) and top_ref=%s and library_id=%s and owner_account_id=%s
            order by ref limit 101''',
            (wanted, header['top_ref'], header['library_id'], header['owner_account_id'])).fetchall()
        if len(fetched) != len(wanted):
            _unavailable()
        by_ref = {}
        for asset in fetched:
            ref = _uuid(asset['ref'])
            if ref not in wanted or ref in by_ref:
                _unavailable()
            by_ref[ref] = asset
        for row in page:
            _check_asset_header(by_ref.get(_uuid(row['asset_ref'])), row)


def _summary(row, captured):
    # source_item is the sole selected-source conversion, preserving actual None.
    if captured['item'] != artwork_draft.source_item(row):
        _unavailable()
    metadata = captured['metadata']
    if _uuid(metadata['album_ref']) != _uuid(row['catalog_ref']):
        _unavailable()
    for key in ('title', 'artist'):
        if type(metadata[key]) is not str or not 1 <= len(metadata[key]) <= 1000:
            _unavailable()
    year = metadata['year']
    if year is not None:
        _integer(year, high=9999)
    if type(metadata['tracks']) is not list or not 1 <= len(metadata['tracks']) <= 5000:
        _unavailable()
    return {'row_ref': _uuid(row['row_ref']),
        'saved_item_ref': _uuid(row['saved_item_ref']) if row['saved_item_ref'] is not None else None,
        'album_ref': _uuid(row['catalog_ref']), 'position': row['position'],
        'title': metadata['title'], 'artist': metadata['artist'], 'year': year,
        'track_count': len(metadata['tracks']), 'included': row['included'],
        'artwork_ref': _uuid(row['asset_ref']) if row['included'] else None,
        'width': row['width'] if row['included'] else None,
        'height': row['height'] if row['included'] else None}


def _response_header(snapshot, state, kind):
    header = snapshot['header']
    result = {'contract_version': 1, 'kind': kind, 'top_ref': _uuid(header['top_ref']),
        'top_revision': str(_integer(header['top_revision'])), 'preparation_ref': _uuid(header['ref']),
        'preparation_revision': str(_integer(header['revision'])),
        'expires_at': header['expires_at'].isoformat(), 'review_digest': state['review_digest'],
        'metadata_evidence_revision': state['metadata_evidence_revision'],
        'item_count': header['item_count'], 'included_count': snapshot['included_count'],
        'total_image_bytes': state['total_image_bytes']}
    if kind == 'draft':
        result.update(draft_ref=_uuid(header['draft_ref']),
                      draft_revision=str(_integer(header['draft_revision'])))
    return result


def capture_review(connection, live, top, snapshot, *, kind, constraints):
    """First phase only: one existing collector plus scoped immutable headers."""
    require_ready(snapshot, str(_integer(snapshot['header']['revision'])))
    _identity(snapshot, kind)
    generation = _integer(snapshot['metadata_generation'], low=0)
    captured = evidence.capture_artwork_review(connection, live, top=top,
        items=[artwork_draft.source_item(row) for row in snapshot['rows']], constraints=constraints)
    try:
        if (type(captured['generation']) is not int or captured['generation'] != generation
                or type(captured['items']) is not list or len(captured['items']) != len(snapshot['rows'])
                or not _hex(captured['evidence_revision'])):
            _unavailable()
        _capture_asset_headers(connection, snapshot)
        asset_digest, review_digest, total = _compact(snapshot, kind=kind,
            metadata_evidence_revision=captured['evidence_revision'])
        state = {'kind': kind, 'snapshot_digest': snapshot['digest'],
            'metadata_generation': generation, 'metadata_evidence_revision': captured['evidence_revision'],
            'asset_manifest_digest': asset_digest, 'review_digest': review_digest,
            'included_count': snapshot['included_count'], 'total_image_bytes': total, 'items': []}
        # Charge the exact pending response envelope before retaining summaries.
        # The witness does not exist until the fresh comparison. Its one bounded
        # transient and exact replacement delta are charged by finish_review.
        envelope = {**_response_header(snapshot, state, kind), 'items': [], 'review_witness': None}
        used = _json_size(envelope, _MAX_SUMMARY)
        for row, item in zip(snapshot['rows'], captured['items']):
            summary = _summary(row, item)
            used += _json_size(summary, _MAX_SUMMARY - used) + (1 if state['items'] else 0)
            if used > _MAX_SUMMARY:
                _limit()
            state['items'].append(summary)
        return state
    finally:
        # No positive metadata/track arrays or source/file/proof copies leave.
        captured = None


def require_key(cursor_secret):
    """Fail before capture when existing server-owned cursor configuration fails."""
    try:
        if type(cursor_secret) is not str or len(cursor_secret.encode('utf-8')) < 32:
            raise ValueError
    except (ValueError, UnicodeError):
        raise AlbumTopError('review_key_unavailable', 503) from None
    return cursor_secret


def _scope(snapshot, *, kind, metadata_evidence_revision, asset_manifest_digest, review_digest):
    return [_WITNESS_DOMAIN, 1, kind, *_identity(snapshot, kind), snapshot['digest'],
            metadata_evidence_revision, asset_manifest_digest, review_digest]


def normalize_witness(value):
    """One bounded sanitized failure for the complete untrusted witness shape."""
    if type(value) is not dict or len(value) != len(_WITNESS_KEYS) or set(value) != _WITNESS_KEYS:
        _invalid_review()
    if type(value['witness_version']) is not int or value['witness_version'] != 1:
        _invalid_review()
    try:
        _decimal(value['metadata_generation'], zero=True)
    except AlbumTopError:
        _invalid_review()
    if any(not _hex(value[key]) for key in ('metadata_evidence_revision', 'asset_manifest_digest', 'review_digest')):
        _invalid_review()
    token = value['token']
    if type(token) is not str or not 1 <= len(token) <= _MAX_TOKEN or not token.isascii():
        _invalid_review()
    try:
        _json_size(value, _MAX_WITNESS)
    except AlbumTopError:
        _invalid_review()
    return dict(value)


def _review_response(snapshot, state, *, kind, cursor_secret):
    """Fixed bounded B response builder; caller serializes its whole envelope."""
    secret = require_key(cursor_secret)
    asset_digest, review_digest, total = _compact(snapshot, kind=kind,
        metadata_evidence_revision=state['metadata_evidence_revision'])
    if (state['kind'] != kind or state['snapshot_digest'] != snapshot['digest']
            or state['metadata_generation'] != snapshot['metadata_generation']
            or state['asset_manifest_digest'] != asset_digest or state['review_digest'] != review_digest
            or state['total_image_bytes'] != total or state['included_count'] != snapshot['included_count']
            or len(state['items']) != len(snapshot['rows'])):
        _invalid_review()
    response = {**_response_header(snapshot, state, kind), 'items': state['items'], 'review_witness': None}
    pending_size = _json_size(response, _MAX_SUMMARY)
    scope = _scope(snapshot, kind=kind, metadata_evidence_revision=state['metadata_evidence_revision'],
        asset_manifest_digest=asset_digest, review_digest=review_digest)
    # Validate the bounded scope before the unchanged existing cursor encoder.
    _json_size(scope, _MAX_WITNESS)
    try:
        token = encode_social_cursor(snapshot['metadata_generation'] + 1, secret=secret, scope=scope)
    except RuntimeError:
        raise AlbumTopError('review_key_unavailable', 503) from None
    witness = normalize_witness({'witness_version': 1,
        'metadata_generation': str(snapshot['metadata_generation']),
        'metadata_evidence_revision': state['metadata_evidence_revision'],
        'asset_manifest_digest': asset_digest, 'review_digest': review_digest, 'token': token})
    witness_size = _json_size(witness, _MAX_WITNESS)
    if pending_size - 4 + witness_size > _MAX_SUMMARY:
        _limit()
    response['review_witness'] = witness
    return response


def finish_review(snapshot, state, *, kind, cursor_secret):
    """Fresh second-phase comparison (or the explicit no-image first phase)."""
    response = _review_response(snapshot, state, kind=kind, cursor_secret=cursor_secret)
    # Fixed approved primitives only. Encoding is bounded before allocation.
    evidence.canonical(response)
    return response


def verify_witness(snapshot, witness, *, kind, cursor_secret):
    """Authenticate past metadata, then compare fresh complete server bindings."""
    secret = require_key(cursor_secret)
    witness = normalize_witness(witness)
    scope = _scope(snapshot, kind=kind,
        metadata_evidence_revision=witness['metadata_evidence_revision'],
        asset_manifest_digest=witness['asset_manifest_digest'], review_digest=witness['review_digest'])
    try:
        position = decode_social_cursor(witness['token'], secret=secret, scope=scope)
    except RuntimeError:
        raise AlbumTopError('review_key_unavailable', 503) from None
    except ValueError:
        _invalid_review()
    generation = _integer(snapshot['metadata_generation'], low=0)
    if position != generation + 1 or witness['metadata_generation'] != str(generation):
        _invalid_review()
    asset_digest, review_digest, _ = _compact(snapshot, kind=kind,
        metadata_evidence_revision=witness['metadata_evidence_revision'])
    if asset_digest != witness['asset_manifest_digest'] or review_digest != witness['review_digest']:
        _invalid_review()


_INTENT_DOMAIN = 'private-top-artwork-publication-intent-v1'
_INTENT_KEYS = frozenset(('version', 'action', 'link_state', 'link_revision', 'intent_digest', 'token'))
_MAX_INTENT = 6144
_MAX_PUBLICATION_INPUT = 12288


def publication_header(title, description):
    from music_app.services.owned_album_tops import _text
    title, description = _text(title, 100, title=True), _text(description, 1000)
    if any(ord(char) < 32 or ord(char) == 127 for char in title + description):
        raise AlbumTopError('invalid_command')
    return {'title': title, 'description': description}


def publication_link(link):
    if link is None:
        return {'link_state': 'no_link', 'link_revision': None}
    if link['state'] not in ('enabled', 'revoked'):
        _unavailable()
    return {'link_state': link['state'], 'link_revision': str(_integer(link['link_revision']))}


def normalize_publication_intent(value):
    if type(value) is not dict or set(value) != _INTENT_KEYS:
        _invalid_review()
    if type(value['version']) is not int or value['version'] != 1:
        _invalid_review()
    if (type(value['action']) is not str or value['action'] not in ('save', 'enable_external')
            or type(value['link_state']) is not str or value['link_state'] not in ('no_link', 'enabled', 'revoked')):
        _invalid_review()
    try:
        if value['link_state'] == 'no_link':
            if value['link_revision'] is not None:
                _invalid_review()
        else:
            _decimal(value['link_revision'])
        if value['action'] == 'save' and value['link_state'] != 'enabled':
            _invalid_review()
        if not _hex(value['intent_digest']):
            _invalid_review()
        token = value['token']
        if type(token) is not str or not 1 <= len(token) <= _MAX_TOKEN or not token.isascii():
            _invalid_review()
        _json_size(value, _MAX_INTENT)
    except AlbumTopError:
        _invalid_review()
    return dict(value)


def normalize_publication_descriptor(value):
    """Bound request shape only; crypto/key/preparation access follows replay."""
    from music_app.services.owned_album_tops import top_revision
    common = {'version', 'kind', 'preparation_ref', 'preparation_revision',
              'context_ref', 'review_witness', 'publication_intent'}
    if type(value) is not dict or type(value.get('kind')) is not str or value['kind'] not in ('saved', 'draft'):
        raise AlbumTopError('invalid_command')
    expected = common | ({'draft_ref', 'draft_revision'} if value['kind'] == 'draft' else set())
    if (set(value) != expected or type(value['version']) is not int or value['version'] != 2
            or not _hex(value['context_ref'])):
        raise AlbumTopError('invalid_command')
    # The complete envelope is charged before decoding either opaque token.
    _json_size(value, _MAX_PUBLICATION_INPUT)
    result = {'version': 2, 'kind': value['kind'], 'preparation_ref': _uuid(value['preparation_ref']),
              'preparation_revision': top_revision(value['preparation_revision']),
              'context_ref': value['context_ref'], 'review_witness': normalize_witness(value['review_witness']),
              'publication_intent': normalize_publication_intent(value['publication_intent'])}
    if value['kind'] == 'draft':
        result.update(draft_ref=_uuid(value['draft_ref']), draft_revision=top_revision(value['draft_revision']))
    return result


def _publication_scope(snapshot, witness, *, kind, header, action, link):
    if action not in ('save', 'enable_external') or action == 'save' and link['link_state'] != 'enabled':
        _invalid_review()
    return [_INTENT_DOMAIN, 1, kind, *_identity(snapshot, kind), snapshot['digest'],
            witness['metadata_generation'], witness['metadata_evidence_revision'],
            witness['asset_manifest_digest'], witness['review_digest'],
            header['title'], header['description'], action, link['link_state'], link['link_revision']]


def finish_publication_review(snapshot, state, *, kind, cursor_secret, header, action, link):
    response = _review_response(snapshot, state, kind=kind, cursor_secret=cursor_secret)
    scope = _publication_scope(snapshot, response['review_witness'], kind=kind,
                               header=header, action=action, link=link)
    _json_size(scope, _MAX_INTENT)
    digest = evidence.digest(scope)
    try:
        # Commit to the complete bounded scope through its digest. Encoding a
        # 1000-character Unicode description directly in the cursor's ASCII
        # JSON could exceed the unchanged 4096-byte token contract.
        token = encode_social_cursor(snapshot['metadata_generation'] + 1,
            secret=require_key(cursor_secret), scope=[_INTENT_DOMAIN, 1, digest])
    except RuntimeError:
        raise AlbumTopError('review_key_unavailable', 503) from None
    intent = normalize_publication_intent({'version': 1, 'action': action, **link,
                                          'intent_digest': digest, 'token': token})
    response.update(proposed_header=dict(header), publication_intent=intent)
    _json_size(response, _MAX_SUMMARY)
    evidence.canonical(response)
    return response


def verify_publication_intent(snapshot, descriptor, *, cursor_secret, header, action, link):
    kind = descriptor['kind']
    verify_witness(snapshot, descriptor['review_witness'], kind=kind, cursor_secret=cursor_secret)
    intent = normalize_publication_intent(descriptor['publication_intent'])
    scope = _publication_scope(snapshot, descriptor['review_witness'], kind=kind,
                               header=header, action=action, link=link)
    _json_size(scope, _MAX_INTENT)
    digest = evidence.digest(scope)
    if (intent['action'] != action or any(intent[key] != link[key] for key in link)
            or intent['intent_digest'] != digest):
        _invalid_review()
    try:
        position = decode_social_cursor(intent['token'], secret=require_key(cursor_secret),
                                        scope=[_INTENT_DOMAIN, 1, digest])
    except RuntimeError:
        raise AlbumTopError('review_key_unavailable', 503) from None
    except ValueError:
        _invalid_review()
    if position != snapshot['metadata_generation'] + 1:
        _invalid_review()


# Four fixed queries deliberately separate HEAD from GET: no bytea body appears
# in either HEAD projection, and no caller can choose a table or SQL fragment.
_SAVED_HEAD = '''select a.ref,a.sanitizer_contract,a.mime_type,a.content_digest,
    a.width,a.height,a.byte_length,octet_length(a.png) as stored_length
    from app.album_top_artwork_preparation_items i
    join app.album_top_artwork_assets a on a.ref=i.asset_ref and a.top_ref=i.top_ref
      and a.library_id=i.library_id and a.owner_account_id=i.owner_account_id
    where i.preparation_ref=%s and i.item_ref=%s and i.preparation_kind='saved'
      and i.top_ref=%s and i.library_id=%s and i.owner_account_id=%s
      and i.included is true and i.status='ready' and i.asset_ref=%s'''
_SAVED_GET = '''select a.ref,a.sanitizer_contract,a.mime_type,a.content_digest,
    a.width,a.height,a.byte_length,octet_length(a.png) as stored_length,
    case when octet_length(a.png) between 1 and 327680 then a.png end as png
    from app.album_top_artwork_preparation_items i
    join app.album_top_artwork_assets a on a.ref=i.asset_ref and a.top_ref=i.top_ref
      and a.library_id=i.library_id and a.owner_account_id=i.owner_account_id
    where i.preparation_ref=%s and i.item_ref=%s and i.preparation_kind='saved'
      and i.top_ref=%s and i.library_id=%s and i.owner_account_id=%s
      and i.included is true and i.status='ready' and i.asset_ref=%s'''
_DRAFT_HEAD = '''select a.ref,a.sanitizer_contract,a.mime_type,a.content_digest,
    a.width,a.height,a.byte_length,octet_length(a.png) as stored_length
    from app.album_top_artwork_draft_items i
    join app.album_top_artwork_assets a on a.ref=i.asset_ref and a.top_ref=i.top_ref
      and a.library_id=i.library_id and a.owner_account_id=i.owner_account_id
    where i.preparation_ref=%s and i.row_ref=%s and i.preparation_kind='draft'
      and i.top_ref=%s and i.library_id=%s and i.owner_account_id=%s
      and i.included is true and i.status='ready' and i.asset_ref=%s'''
_DRAFT_GET = '''select a.ref,a.sanitizer_contract,a.mime_type,a.content_digest,
    a.width,a.height,a.byte_length,octet_length(a.png) as stored_length,
    case when octet_length(a.png) between 1 and 327680 then a.png end as png
    from app.album_top_artwork_draft_items i
    join app.album_top_artwork_assets a on a.ref=i.asset_ref and a.top_ref=i.top_ref
      and a.library_id=i.library_id and a.owner_account_id=i.owner_account_id
    where i.preparation_ref=%s and i.row_ref=%s and i.preparation_kind='draft'
      and i.top_ref=%s and i.library_id=%s and i.owner_account_id=%s
      and i.included is true and i.status='ready' and i.asset_ref=%s'''


def read_png(connection, snapshot, *, kind, row_ref, asset_ref, head_only):
    """Last response SQL only; caller must verify witness and finish fences."""
    _identity(snapshot, kind)
    if type(head_only) is not bool:
        raise AlbumTopError('invalid_command')
    row_ref, asset_ref = _uuid(row_ref), _uuid(asset_ref)
    selected = next((row for row in snapshot['rows'] if _uuid(row['row_ref']) == row_ref), None)
    if (selected is None or selected['included'] is not True or selected['status'] != 'ready'
            or _uuid(selected['asset_ref']) != asset_ref):
        _unavailable()
    sql = ((_SAVED_HEAD if head_only else _SAVED_GET) if kind == 'saved'
           else (_DRAFT_HEAD if head_only else _DRAFT_GET))
    header = snapshot['header']
    asset = connection.execute(sql, (header['ref'], row_ref, header['top_ref'],
        header['library_id'], header['owner_account_id'], asset_ref)).fetchone()
    body = None
    try:
        _check_asset_header(asset, selected)
        if _integer(asset['stored_length'], high=_MAX_PNG) != selected['byte_length']:
            _unavailable()
        if head_only:
            body = b''
        else:
            body = asset['png']
            if (type(body) is not bytes or len(body) != selected['byte_length']
                    or not body.startswith(_PNG_SIGNATURE)
                    or hashlib.sha256(body).hexdigest() != selected['content_digest']):
                _unavailable()
        return {'content_type': 'image/png', 'content_length': selected['byte_length'], 'body': body,
            'cache_control': 'private, no-store', 'x_content_type_options': 'nosniff',
            'referrer_policy': 'no-referrer'}
    finally:
        body, asset = None, None
