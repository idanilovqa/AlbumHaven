from pathlib import Path

import pytest

from music_app.routes.api_loop_helpers import resolve_loop_creation_source
from music_app.services.loops import build_loop_item


def resolve(payload, loops):
    return resolve_loop_creation_source(
        payload, config={}, get_loop=lambda config, key: loops.get(key),
        resolve_loop_media_path=lambda config, key: Path('owned-loops') / f'{key}.mp3',
        normalize_music_file_path=lambda raw: Path('owned-song.flac') if raw else None,
        file_cache={},
    )


def test_direct_song_range_keeps_original_source_coordinates():
    result, error = resolve({'source_path': 'owned-song.flac', 'start_seconds': 61.25, 'end_seconds': 75.5}, {})
    assert error is None
    assert (result.get('original_start_seconds'), result.get('original_end_seconds')) == (61.25, 75.5)


def test_nested_range_adds_persisted_original_offset_not_parent_local_start():
    parent = {'id': 'parent', 'start_seconds': 3, 'end_seconds': 13,
              'original_start_seconds': 63, 'original_end_seconds': 73, 'parent_loop_id': 'deleted-ancestor'}
    result, error = resolve({'source_loop_id': 'parent', 'start_seconds': 2.5, 'end_seconds': 6.75}, {'parent': parent})
    assert error is None
    assert (result.get('original_start_seconds'), result.get('original_end_seconds')) == (65.5, 69.75)


def test_historical_ancestor_chain_accumulates_each_media_offset_once():
    loops = {'root': {'id': 'root', 'start_seconds': 60, 'end_seconds': 100, 'parent_loop_id': ''},
             'parent': {'id': 'parent', 'start_seconds': 3, 'end_seconds': 13, 'parent_loop_id': 'root'}}
    result, error = resolve({'source_loop_id': 'parent', 'start_seconds': 2.5, 'end_seconds': 6.75}, loops)
    assert error is None
    assert (result.get('original_start_seconds'), result.get('original_end_seconds')) == (65.5, 69.75)


@pytest.mark.parametrize('loops', [
    {},
    {'parent': {'id': 'parent', 'start_seconds': 3, 'end_seconds': 13, 'parent_loop_id': 'missing'}},
    {'parent': {'id': 'parent', 'start_seconds': 3, 'end_seconds': 13, 'parent_loop_id': 'parent'}},
    {'parent': {'id': 'parent', 'start_seconds': 3, 'end_seconds': 13, 'parent_loop_id': 'other'},
     'other': {'id': 'other', 'start_seconds': 2, 'end_seconds': 20, 'parent_loop_id': 'parent'}},
])
def test_missing_or_cyclic_parent_never_falls_back_to_an_unrelated_song(loops):
    result, error = resolve({'source_loop_id': 'parent', 'source_path': 'owned-song.flac', 'start_seconds': 1, 'end_seconds': 2}, loops)
    assert result is None
    assert error is not None
    assert error[1] in (400, 409)


def test_saved_item_retains_local_media_window_and_persists_original_window():
    item = build_loop_item(loop_id='child', name='Nested chorus', path=Path('child.mp3'),
                           source_path=Path('parent.mp3'), start_seconds=2.5, end_seconds=6.75,
                           parent_loop_id='parent', original_start_seconds=65.5, original_end_seconds=69.75)
    assert (item['start_seconds'], item['end_seconds'], item['duration_seconds']) == (2.5, 6.75, 4.25)
    assert (item['original_start_seconds'], item['original_end_seconds']) == (65.5, 69.75)

@pytest.mark.parametrize('start,end', [(-1,2),(float('nan'),2),(1,float('nan')),(float('-inf'),2),(1,float('inf'))])
def test_create_range_rejects_negative_or_nonfinite_coordinates(start,end):
    from music_app.routes.api_loop_helpers import validate_loop_create_payload
    result,error=validate_loop_create_payload({'name':'Invalid range','start_seconds':start,'end_seconds':end})
    assert result is None and error is not None and error[1]==400

@pytest.mark.parametrize('parent', [
    {'id':'parent','start_seconds':2,'end_seconds':12,'original_start_seconds':62,'original_end_seconds':99},
    {'id':'parent','start_seconds':2,'end_seconds':12,'parent_loop_id':'root'},
])
def test_inconsistent_anchor_or_out_of_parent_history_has_no_original_window(parent):
    from music_app.services.loops import resolve_loop_original_window
    root={'id':'root','start_seconds':60,'end_seconds':65}
    assert resolve_loop_original_window(parent,lambda key:root if key=='root' else None) is None

@pytest.mark.parametrize('start,end', [(0,11),(9,12),(-1,2)])
def test_nested_creation_rejects_range_outside_saved_parent_media(start,end):
    parent={'id':'parent','start_seconds':60,'end_seconds':70}
    result,error=resolve({'source_loop_id':'parent','start_seconds':start,'end_seconds':end},{'parent':parent})
    assert result is None and error is not None and error[1] in (400,409)