"""Closed commands and presentation facts for private Recommended By collections."""
from dataclasses import dataclass
import hashlib
import json
import re
import unicodedata
from uuid import UUID

MAX_RECOMMENDERS = 100
MAX_ITEMS = 5000
_RESOURCE = re.compile(r'inventory-(track|album):([1-9][0-9]{0,18}):([1-9][0-9]{0,18})\Z', re.ASCII)


class RecommendationError(Exception):
    def __init__(self, code, status_code=422):
        self.code, self.status_code = code, status_code
        super().__init__(code)


def uuid_ref(value):
    if type(value) is not str or len(value) != 36:
        raise RecommendationError('invalid_command')
    try:
        result = str(UUID(value))
    except ValueError:
        raise RecommendationError('invalid_command') from None
    if result != value:
        raise RecommendationError('invalid_command')
    return result


def person_name(value):
    if type(value) is not str:
        raise RecommendationError('recommender_required')
    value = unicodedata.normalize('NFC', value.strip())
    if not 1 <= len(value) <= 100 or any(unicodedata.category(c).startswith('C') for c in value):
        raise RecommendationError('invalid_recommender')
    return value


@dataclass(frozen=True)
class RecommendationCommand:
    request_key: str
    kind: str
    library_id: int | None
    resource_id: int | None
    recipient_ref: str | None = None
    recommender_ref: str | None = None
    recommender_name: str | None = None
    catalog_ref: str | None = None
    source_top_ref: str | None = None
    source_item_ref: str | None = None
    source_revision: int | None = None
    source_playlist_ref: str | None = None

    @property
    def digest(self):
        data = {key: value for key, value in self.__dict__.items() if key != 'request_key'}
        # Preserve existing inventory/album operation digests across this extension.
        if self.source_playlist_ref is None:
            del data['source_playlist_ref']
        return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False,
                                        separators=(',', ':')).encode()).hexdigest()


def command(payload, *, manual=False):
    expected = {'request_key', 'kind', 'resource_ref', 'recommender' if manual else 'recipient_account_ref'}
    if type(payload) is not dict or payload.get('kind') not in ('track', 'album'):
        raise RecommendationError('invalid_command')
    resource = payload.get('resource_ref')
    catalog = type(resource) is str and resource.startswith('catalog-album:')
    playlist_item = type(resource) is str and resource.startswith('playlist-item:')
    if set(payload) != expected | ({'source'} if catalog or playlist_item else set()):
        raise RecommendationError('invalid_command')
    catalog_ref = top = item = revision = library_id = resource_id = playlist = None
    if catalog or playlist_item:
        if payload['kind'] != ('album' if catalog else 'track'):
            raise RecommendationError('invalid_resource')
        source = payload['source']
        fields = {'top_ref', 'item_ref', 'revision'} if catalog else {'playlist_ref', 'revision'}
        if type(source) is not dict or set(source) != fields:
            raise RecommendationError('invalid_source')
        if catalog:
            catalog_ref = uuid_ref(resource.removeprefix('catalog-album:'))
            top, item = uuid_ref(source['top_ref']), uuid_ref(source['item_ref'])
        else:
            item = uuid_ref(resource.removeprefix('playlist-item:'))
            playlist = uuid_ref(source['playlist_ref'])
        text = source['revision']
        if type(text) is not str or not re.fullmatch(r'[1-9][0-9]{0,18}', text, re.ASCII) or int(text) > 9223372036854775807:
            raise RecommendationError('invalid_source')
        revision = int(text)
    else:
        match = _RESOURCE.fullmatch(resource) if type(resource) is str else None
        if not match or match[1] != payload['kind'] or max(int(match[2]), int(match[3])) > 9223372036854775807:
            raise RecommendationError('invalid_resource')
        library_id, resource_id = int(match[2]), int(match[3])
    recipient = ref = name = None
    if manual:
        by = payload['recommender']
        if type(by) is not dict:
            raise RecommendationError('recommender_required')
        if set(by) == {'name'}:
            name = person_name(by['name'])
        elif set(by) == {'account_ref'}:
            ref = uuid_ref(by['account_ref'])
        else:
            raise RecommendationError('invalid_recommender')
    else:
        recipient = uuid_ref(payload['recipient_account_ref'])
    return RecommendationCommand(uuid_ref(payload['request_key']), payload['kind'], library_id,
        resource_id, recipient, ref, name, catalog_ref, top, item, revision, playlist)


def attribution_key(*, account_ref=None, name=None):
    if account_ref is not None:
        return 'account:' + uuid_ref(account_ref)
    return 'person:' + hashlib.sha256(person_name(name).casefold().encode()).hexdigest()


def compact_label(recommenders):
    count = len(recommenders)
    if not count:
        return ''
    return 'Recommended by: ' + (recommenders[0]['display_name'] if count == 1 else 'a few' if count < 4 else 'many')
