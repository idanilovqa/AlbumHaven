"""Pure delegation contract only; real SQL coverage lives in favorite suites."""
from music_app.services import subject_home_taste


def test_album_taste_requires_explicit_subject_and_library(monkeypatch):
    connection = object()
    calls = []
    def seam(con, *, account_id, library_id, album_ids):
        calls.append((con, account_id, library_id, album_ids))
        return {23: {'rating': 8, 'favorite': False, 'taste_state': 'available',
                     'account_id': account_id, 'preference_revision': 7}}
    monkeypatch.setattr(subject_home_taste, 'load_album_preferences_on_connection', seam)
    assert subject_home_taste.load_subject_album_taste(connection, account_id=17, library_id=29, album_ids=[23,23]) == {
        23: {'rating': 8, 'favorite': False, 'taste_state': 'available'}}
    assert calls == [(connection,17,29,[23])]


def test_missing_subject_taste_is_not_replaced_by_viewer_or_tag_facts(monkeypatch):
    calls = []
    def seam(con, **scope):
        calls.append(scope)
        return {}
    monkeypatch.setattr(subject_home_taste, 'load_album_preferences_on_connection', seam)
    assert subject_home_taste.load_subject_album_taste(object(), account_id=17, library_id=29, album_ids=[23]) == {}
    assert calls == [{'account_id':17,'library_id':29,'album_ids':[23]}]
    assert subject_home_taste.UNKNOWN_ALBUM == {'rating':None,'favorite':None,'taste_state':'unavailable'}
