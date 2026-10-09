"""Bounded suggestions are metadata hints; only explicit, proven choices are local."""
from uuid import uuid4
import pytest

from music_app.services.owned_playlists import PlaylistError
from music_app.services import playlist_local_matches as matches


def body(**changes):
    return {'source': {'kind': 'playlist', 'ref': str(uuid4()), 'revision': '7'},
            'entry_ref': str(uuid4()), **changes}


@pytest.mark.parametrize('change', [
    {'query': 'arbitrary search'}, {'source': {'kind': 'library','ref':str(uuid4()),'revision':'7'}},
    {'source': {'kind':'playlist','ref':str(uuid4()),'revision':'07'}},
    {'entry_ref': 'inventory-track:1:2'}, {'actor_scope': {}},
])
def test_match_request_is_strict_and_never_accepts_search_or_scope_overrides(change):
    with pytest.raises(PlaylistError, match='invalid_command'):
        matches.normalize_request(body(**change))


def test_accept_requires_both_opaque_receipts():
    request=body(review_ref=str(uuid4()),candidate_ref=str(uuid4()))
    assert matches.normalize_request(request,accept=True)==request
    for key in ('review_ref','candidate_ref'):
        with pytest.raises(PlaylistError):matches.normalize_request({k:v for k,v in request.items() if k!=key},accept=True)


def test_suggestions_normalize_edition_features_unicode_and_reject_other_artists():
    original={'title':'Ａ Song (Remastered 2020)','artist':'The Artist'}
    rows=[{'original_local_track_id':i,'title':title,'artist':artist} for i,title,artist in [
        (1,'A Song','the artist'),(2,'A Song feat. Guest','THE-ARTIST'),
        (3,'A Song','Another Artist'),(4,'Unrelated','The Artist')]]
    assert [row['original_local_track_id'] for row in matches.rank_candidates(original,rows)]==[1,2]


def test_suggestion_similarity_threshold_and_tie_break_are_deterministic():
    original={'title':'abcdefghij','artist':'Artist'}
    rows=[{'original_local_track_id':i,'title':title,'artist':'Artist'}
          for i,title in [(20,'abcdefghij'),(3,'abcdefghij'),(4,'abcdefghiX'),(5,'abcdefghXY')]]
    assert [row['original_local_track_id'] for row in matches.rank_candidates(original,rows)]==[20,3,4]


@pytest.mark.parametrize('title',['','a'*257])
def test_empty_or_excessive_metadata_cannot_trigger_similarity_work(title):
    assert matches.rank_candidates({'title':title,'artist':'Artist'},[{'original_local_track_id':1,'title':title,'artist':'Artist'}])==[]


def test_missing_save_locks_original_and_choice_inventory_together(monkeypatch):
    from music_app.services import playlist_missing_sources as missing
    from music_app.services import playlist_creation_sources_postgres as inventory
    from tests.py.owned_playlist_testing import Connection, Step, context
    from tests.py.test_playlist_activity_source_contract import MissingOwner, PLAYLIST
    entry=str(uuid4());source={'ref':str(uuid4()),'origin_descriptor':{'playlist_ref':PLAYLIST,'playlist_revision':'7'}}
    original={'ref':entry,'source_row_ref':str(uuid4()),'original_local_track_id':9,
        'evidence_digest':'digest','source_lineage':{}}
    receipt={'entry_ref':entry,'chosen_track_id':2}
    connection=Connection([Step('from app.playlist_creation_entries',[original]),
        Step('from app.playlist_local_match_receipts',[receipt],clauses=('order by entry_ref for share',))])
    observed=[]
    def rows(connection,library,ids,**kwargs):
        observed.append((set(ids),kwargs));return {}
    monkeypatch.setattr(inventory,'inventory_rows',rows)
    monkeypatch.setattr(missing,'_missing_rows',lambda *args,**kwargs:[original])
    result,_,_=missing.validated_selection(MissingOwner(connection),connection,context(),source,[entry],
        constraints=None,extra_track_ids=[4])
    assert result==[original] and observed==[({2,4,9},{'lock':True,'config':{'synthetic':True}})]
    connection.done()
