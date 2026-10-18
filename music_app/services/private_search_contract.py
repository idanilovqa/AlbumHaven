"""Protected Search contracts for own Love and authorized listener history."""
from dataclasses import dataclass
import re

from music_app.services.auth_tokens import normalize_login_identifier
from music_app.services.gallery_display import normalize_gallery_display_mode, normalize_gallery_scale_percent
from music_app.services.gallery_scope import normalize_gallery_scope, normalize_visible_categories


class PrivateSearchError(ValueError):
    def __init__(self, code='invalid_private_search_request', status_code=400, location=None):
        super().__init__('Invalid search request.' if status_code == 400 else 'Search is unavailable.')
        self.code, self.status_code, self.location = code, status_code, location


@dataclass(frozen=True)
class ListenerHistoryCriteria:
    """The unchanged raw history reader's selector."""
    username: str

    def __post_init__(self):
        try:
            object.__setattr__(self, 'username', normalize_login_identifier(self.username))
        except ValueError:
            raise PrivateSearchError() from None

    def as_payload(self):
        return {'subject': {'kind': 'username', 'username': self.username},
                'predicate_domain': 'tracks', 'history': {'period': 'all'}}


def normalize_listener_history_query(query):
    """Normalize only @handle or @handle :tracks listened:all.

    This independent foundation deliberately does not widen live Search
    admission. The history reader must supply event policy and bounded paging
    before normalize_private_search_request can delegate here.
    """
    if (not isinstance(query, str) or not query.strip() or len(query) > 200 or '\0' in query
            or any('\ud800' <= ch <= '\udfff' for ch in query)):
        raise PrivateSearchError()
    username, selectors = None, {}
    for match in re.finditer(r'\S+', query):
        word = match.group()
        token = word.casefold()
        location = {'start': match.start(), 'end': match.end()}
        if word.startswith('@') and username is None:
            try:
                # Use the account username owner, including its ASCII/case
                # contract. Casefolded Unicode is not a username alias.
                username = normalize_login_identifier(word[1:])
            except ValueError:
                raise PrivateSearchError(location=location) from None
        elif token in {':tracks', 'listened:all'} and token not in selectors:
            selectors[token] = location
        else:
            raise PrivateSearchError('unsupported_private_search_combination', location=location)
    if username is None or selectors and set(selectors) != {':tracks', 'listened:all'}:
        location = next(iter(selectors.values()), None)
        raise PrivateSearchError('unsupported_private_search_combination', location=location)
    return ListenerHistoryCriteria(username)


@dataclass(frozen=True)
class OwnLoveCriteria:
    include: tuple[str, ...]
    exclude: tuple[str, ...]

    def as_payload(self):
        return {'subject': 'self', 'predicate_domain': 'tracks',
                'love': {'include': list(self.include), 'exclude': list(self.exclude)},
                'name_scopes': ['artists', 'albums', 'tracks']}

    def tiers(self):
        def expanded(values):
            return {tier for value in values for tier in
                    (('loved', 'obsessed') if value == 'loved' else ('obsessed',))}
        return tuple(sorted((expanded(self.include) if self.include else {'off', 'loved', 'obsessed'})
                            - expanded(self.exclude)))


@dataclass(frozen=True)
class PrivateSearchRequest:
    query: str
    criteria: OwnLoveCriteria
    presentation: str
    limit: int
    artist: str | None
    all_artists: bool
    omit_sidebar: bool
    cursor: str | None
    sidebar_cursor: str | None
    detail_album_ref: str | None
    gallery_scope: str
    categories: tuple[str, ...]
    gallery_display: str
    gallery_scale: int
    sidebar_only: bool = False

    def visibility_scope(self):
        return [self.gallery_scope, list(self.categories)]


def is_personal_search_expression(query):
    """Admission classification only; normalization is the single syntax owner."""
    return isinstance(query, str) and any(':' in word or word.lstrip('-').startswith('@')
                                         for word in query.split())


def is_private_search_request(params):
    """One API/bootstrap classifier, subordinate to existing surface owners."""
    surface = str(params.get('surface') or '')
    # Match the existing dispatchers exactly: Playlist historically casefolds
    # without stripping; Tops strips and casefolds. Padded Playlist personal
    # input must reach the protected normalizer and fail before fallback.
    if surface.casefold() == 'playlists' or surface.strip().casefold() == 'album_tops':
        return False
    return (any(is_personal_search_expression(value) for value in params.getlist('q'))
            or any(str(key).startswith('search_') for key in params))


def normalize_own_love_query(query):
    if (not isinstance(query, str) or not query.strip() or len(query) > 200 or '\0' in query
            or any('\ud800' <= ch <= '\udfff' for ch in query)):
        raise PrivateSearchError()
    include, exclude = set(), set()
    for match in re.finditer(r'\S+', query):
        word = match.group()
        location = {'start': match.start(), 'end': match.end()}
        negated = word.startswith('-')
        token = word[1:] if negated else word
        token = token.casefold()
        if token in (':loved', 'love:loved', ':obsessed', 'love:obsessed'):
            (exclude if negated else include).add(token.rsplit(':', 1)[1])
        elif any(char in word for char in ('"', "'", '\\', '\0')) or token in (':', 'love:'):
            raise PrivateSearchError(location=location)
        else:
            raise PrivateSearchError('unsupported_private_search_combination', location=location)
    if not include and not exclude:
        raise PrivateSearchError()
    return OwnLoveCriteria(tuple(value for value in ('loved', 'obsessed') if value in include),
                           tuple(value for value in ('loved', 'obsessed') if value in exclude))


def normalize_private_search_request(params):
    if any(word.startswith('@') for word in str(params.get('q', '')).split()):
        return _normalize_listener_search_request(params)
    allowed = {'surface', 'q', 'payload_tier', 'artist', 'all_artists', 'omit_sidebar',
               'search_presentation', 'search_page_size', 'search_cursor', 'search_sidebar_cursor',
               'search_detail_album_ref', 'search_sidebar_only', 'gallery_scope', 'gallery_display', 'gallery_display_mode',
               'gallery_scale_percent', 'category'}
    pairs = list(params.multi_items())
    if len(pairs) > 48 or set(params) - allowed:
        raise PrivateSearchError()
    counts = {}
    for key, value in pairs:
        counts[key] = counts.get(key, 0) + 1
        if key != 'category' and counts[key] > 1:
            raise PrivateSearchError()
        if not isinstance(value, str) or '\0' in value or any('\ud800' <= ch <= '\udfff' for ch in value):
            raise PrivateSearchError()
    if counts.get('category', 0) > 32 or params.get('surface', 'albums') != 'albums':
        raise PrivateSearchError()
    if params.get('payload_tier', 'full') != 'full':
        raise PrivateSearchError()
    sidebar_only = 'search_sidebar_only' in params
    if sidebar_only:
        if (params['search_sidebar_only'] != '1'
                or not {'surface', 'q', 'search_presentation', 'search_sidebar_cursor'} <= set(params)
                or set(params) & {'search_cursor', 'search_detail_album_ref', 'omit_sidebar', 'search_page_size', 'payload_tier'}
                or ('artist' in params) == ('all_artists' in params)
                or ('all_artists' in params and params['all_artists'] != '1')):
            raise PrivateSearchError()
    query = params.get('q', '')
    criteria = normalize_own_love_query(query)
    size = params.get('search_page_size', '50')
    if not re.fullmatch(r'[0-9]{1,3}', size) or not 1 <= int(size) <= 100:
        raise PrivateSearchError()
    presentation = params.get('search_presentation', 'albums')
    if presentation not in {'albums', 'tracks'}:
        raise PrivateSearchError()
    for key in ('all_artists', 'omit_sidebar'):
        if params.get(key, '0') not in {'0', '1'}:
            raise PrivateSearchError()
    scope = params.get('gallery_scope', 'all')
    if scope not in {'all', 'new_arrivals'}:
        raise PrivateSearchError()
    for key in ('gallery_display', 'gallery_display_mode'):
        if key in params and params[key] not in {'cards', 'covers', 'list'}:
            raise PrivateSearchError()
    if ('gallery_display' in params and 'gallery_display_mode' in params
            and params['gallery_display'] != params['gallery_display_mode']):
        raise PrivateSearchError()
    scale = params.get('gallery_scale_percent', '100')
    if not re.fullmatch(r'[0-9]{2,3}', scale) or not 80 <= int(scale) <= 140:
        raise PrivateSearchError()
    category_values = params.getlist('category')
    if any(len(value) > 100 for value in category_values):
        raise PrivateSearchError()
    artist = params.get('artist')
    if artist is not None and (not artist.strip() or len(artist) > 1000):
        raise PrivateSearchError()
    artist = artist.strip() if artist is not None else None
    if artist and params.get('all_artists') == '1':
        raise PrivateSearchError()
    detail = params.get('search_detail_album_ref')
    if detail is not None:
        if not re.fullmatch(r'inventory-album:[1-9][0-9]{0,18}:[1-9][0-9]{0,18}', detail):
            raise PrivateSearchError()
        if set(params) & {'artist', 'all_artists', 'search_sidebar_cursor', 'search_presentation', 'omit_sidebar'}:
            raise PrivateSearchError()
        presentation = 'album_detail'
    for key in ('search_cursor', 'search_sidebar_cursor'):
        if key in params and (not params[key] or len(params[key]) > 4096):
            raise PrivateSearchError()
    normalized_scope = normalize_gallery_scope(scope)
    return PrivateSearchRequest(query, criteria, presentation, int(size), artist,
        params.get('all_artists') == '1', params.get('omit_sidebar') == '1',
        params.get('search_cursor'), params.get('search_sidebar_cursor'), detail,
        normalized_scope, tuple(sorted(normalize_visible_categories(category_values, normalized_scope))),
        normalize_gallery_display_mode(params.get('gallery_display') or params.get('gallery_display_mode')),
        normalize_gallery_scale_percent(scale), sidebar_only=sidebar_only)


@dataclass(frozen=True)
class ListenerSearchCriteria:
    username: str
    love_include: tuple[str, ...] = ()
    love_exclude: tuple[str, ...] = ()

    def __post_init__(self):
        object.__setattr__(self, 'username', ListenerHistoryCriteria(self.username).username)
        for values in (self.love_include, self.love_exclude):
            if type(values) is not tuple or values != tuple(
                    value for value in ('loved', 'obsessed') if value in values):
                raise PrivateSearchError()

    @property
    def filtered(self):
        return bool(self.love_include or self.love_exclude)

    def tiers(self):
        return OwnLoveCriteria(self.love_include, self.love_exclude).tiers()

    def as_payload(self):
        return {**ListenerHistoryCriteria(self.username).as_payload(),
                'love': {'include': list(self.love_include), 'exclude': list(self.love_exclude)}}


@dataclass(frozen=True)
class ListenerSearchRequest:
    query: str
    criteria: ListenerSearchCriteria
    presentation: str = 'tracks'
    limit: int = 100
    cursor: str | None = None


def normalize_listener_search_query(query):
    """Fixed tracks/all history plus the existing Love vocabulary, not a DSL."""
    if (not isinstance(query, str) or not query.strip() or len(query) > 200 or '\0' in query
            or any('\ud800' <= ch <= '\udfff' for ch in query)):
        raise PrivateSearchError()
    username, selectors, include, exclude = None, set(), set(), set()
    for match in re.finditer(r'\S+', query):
        word = match.group()
        location = {'start': match.start(), 'end': match.end()}
        if word.startswith('@'):
            try:
                current = normalize_login_identifier(word[1:])
            except ValueError:
                raise PrivateSearchError(location=location) from None
            if username is not None and current != username:
                raise PrivateSearchError('unsupported_private_search_combination', location=location)
            username = current
            continue
        token = word.casefold()
        if token in {':tracks', 'listened:all'}:
            if token in selectors:
                raise PrivateSearchError('unsupported_private_search_combination', location=location)
            selectors.add(token)
            continue
        try:
            love = normalize_own_love_query(word)
        except PrivateSearchError as error:
            raise PrivateSearchError(error.code, error.status_code, location) from None
        include.update(love.include)
        exclude.update(love.exclude)
    if username is None:
        raise PrivateSearchError('unsupported_private_search_combination')
    return ListenerSearchCriteria(username,
        tuple(value for value in ('loved', 'obsessed') if value in include),
        tuple(value for value in ('loved', 'obsessed') if value in exclude))


def _normalize_listener_search_request(params):
    allowed = {'surface', 'q', 'search_presentation', 'search_page_size', 'search_cursor'}
    pairs = list(params.multi_items())
    if (set(params) - allowed or len(pairs) != len(set(params))
            or any(not isinstance(value, str) or '\0' in value
                   or any('\ud800' <= ch <= '\udfff' for ch in value) for _, value in pairs)
            or params.get('surface', 'albums') != 'albums'
            or params.get('search_presentation', 'tracks') != 'tracks'):
        raise PrivateSearchError()
    size = params.get('search_page_size', '100')
    if not re.fullmatch(r'[0-9]{1,3}', size) or not 1 <= int(size) <= 100:
        raise PrivateSearchError()
    cursor = params.get('search_cursor')
    if cursor is not None and (not cursor or len(cursor) > 4096):
        raise PrivateSearchError()
    query = params.get('q', '')
    return ListenerSearchRequest(query, normalize_listener_search_query(query), 'tracks', int(size), cursor)
