"""Account/client presentation contracts; no live database required for validation."""
import pytest
from music_app.services.client_layout_preferences import default_preferences, normalize_changes, normalize_profile, PostgresClientLayoutPreferences
from music_app.services.recent_albums import PostgresRecentAlbums


def test_mobile_defaults_are_independent_from_desktop():
    mobile = default_preferences('mobile')
    desktop = default_preferences('web_desktop')
    assert mobile['galleryDisplayPreferences']['defaultGalleryDisplayMode'] == 'list'
    assert mobile['albumOpenMode'] == 'page'
    mobile['gallerySources']['hoard'] = False
    assert desktop['gallerySources']['hoard'] is True
    assert default_preferences('mobile')['gallerySources']['hoard'] is True


@pytest.mark.parametrize('changes', [
    {}, {'capabilities': ['admin']}, {'mobileGridColumns': True}, {'mobileGridColumns': 4},
    {'galleryDisplayPreferences': {'defaultGalleryDisplayMode': 'list'}},
    {'gallerySources': {'main_library': True, 'new_arrivals': True, 'hoard': 1}},
    {'combineSimilarArtists': {'Northlight': 'true'}},
    {'playerAppearance': {'seekbarMode': 'waveform', 'waveformFillColor': 'url(bad)', 'waveformEdgeColor': '#ffffff'}},
])
def test_invalid_or_authorization_shaped_changes_are_rejected(changes):
    with pytest.raises(ValueError):
        normalize_changes(changes)


def test_valid_changes_are_partial_preference_families():
    assert normalize_changes({'mobileGridColumns': 3}) == {'mobileGridColumns': 3}
    with pytest.raises(ValueError):
        normalize_profile('other-account')


class Connection:
    def __init__(self, rows):
        self.rows, self.calls = rows, []
    def __enter__(self):
        return self
    def __exit__(self, *_):
        pass
    def execute(self, sql, params):
        self.calls.append((sql, params))
        return self
    def fetchall(self):
        return self.rows


def test_loading_preferences_requires_and_queries_exact_account():
    connection = Connection([{'client_profile': 'mobile', 'preferences': {'mobileGridColumns': 3}}])
    repository = PostgresClientLayoutPreferences({'ALBUM_HAVEN_APP_DATABASE_URL': 'test'}, connect=lambda _: connection)
    result = repository.load_profiles(account_id=17)
    assert connection.calls[0][1] == (17,)
    assert result['mobile']['mobileGridColumns'] == 3
    assert result['web_desktop']['mobileGridColumns'] == 2
    with pytest.raises(ValueError):
        repository.load_profiles(account_id=None)


def test_recent_albums_query_scopes_account_and_library_and_bounds_work():
    connection = Connection([])
    repository = PostgresRecentAlbums({'ALBUM_HAVEN_APP_DATABASE_URL': 'test'}, connect=lambda _: connection)
    assert repository.load(account_id=17, library_id=23) == []
    sql, parameters = connection.calls[0]
    assert parameters == (17, 23, 24, 23)
    assert 'h.account_id = %s and h.library_id = %s' in sql
    with pytest.raises(ValueError):
        repository.load(account_id=17, library_id=23, limit=10000)
