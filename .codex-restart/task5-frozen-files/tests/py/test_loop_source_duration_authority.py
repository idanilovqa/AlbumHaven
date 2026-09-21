from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from music_app.routes import api_wave_b_asgi_routes as wave
from music_app.services import current_actor_asgi, loops


@pytest.mark.parametrize('requested,precise,expected_status,expected_end', [
    (14.076, 14.076, 200, 14.076),
    (14.2, 14.076, 400, None),
    (14.0765, 14.076, 200, 14.076),
    (14.0771, 14.076, 400, None),
    (14.0, float('nan'), 400, None),
    (14.0, float('inf'), 400, None),
    (14.0, None, 400, None),
    (14.0, 0.0, 400, None),
])
def test_direct_creation_probes_precise_authorized_source_before_encoding(
    tmp_path, monkeypatch, requested, precise, expected_status, expected_end,
):
    source = tmp_path / 'owned.mp3'
    source.write_bytes(b'owned-source-placeholder')
    output = tmp_path / 'saved.mp3'
    calls = []
    stored = []
    actor = SimpleNamespace(account_id=7, current_library_id=9, is_authenticated=True,
        library_relationships=(SimpleNamespace(library_id=9, membership_role='owner', is_primary_owner=True),))
    async def actor_for_request(_request): return actor
    monkeypatch.setattr(current_actor_asgi, 'current_actor_from_request', actor_for_request)
    monkeypatch.setattr(wave, 'current_actor_from_request', actor_for_request, raising=False)
    config = {'DATA_DIR': tmp_path}
    monkeypatch.setattr(wave, '_app_config', lambda _request: config)
    monkeypatch.setattr(wave, '_library_state', lambda _request: {'file_cache': {str(source): {'duration_seconds': 14}}})
    monkeypatch.setattr(wave, '_app_logger', lambda _request: None)
    # Source resolution is the separate exact actor/library boundary covered in
    # test_loop_scope_boundaries; this fixture returns only its authorized path.
    monkeypatch.setattr(wave, 'resolve_loop_creation_source', lambda *_args, **_kwargs: ({
        'source_path': source, 'artist': 'Artist', 'album': 'Album', 'title': 'Track',
        'cover_path': '', 'parent_loop_id': '', 'original_start_seconds': 0,
        'original_end_seconds': requested, 'song_key': 'track:11',
    }, None))
    def probe(path):
        assert path == source
        calls.append(('probe', path))
        return precise
    monkeypatch.setattr(loops, 'probe_loop_source_duration', probe, raising=False)
    monkeypatch.setattr(wave, 'probe_loop_source_duration', probe, raising=False)
    def encode(_config, path, start, end, _identity, **_scope):
        calls.append(('encode', end))
        output.write_bytes(b'encoded')
        return output
    monkeypatch.setattr(wave, 'create_loop_file', encode)
    monkeypatch.setattr(wave, 'add_loop', lambda _config, item, **_scope: stored.append(item))
    monkeypatch.setattr(wave, 'load_loops', lambda _config, **_scope: stored)
    monkeypatch.setattr(wave, 'log_app_event', lambda *_args, **_kwargs: None)
    payload = {'name': 'Precise source', 'source_path': str(source), 'start_seconds': 0,
               'end_seconds': requested, 'duration_seconds': 9999, 'account_id': 99, 'library_id': 88}
    async def read_json(): return payload
    request = SimpleNamespace(json=read_json, state=SimpleNamespace(), app=SimpleNamespace(state=SimpleNamespace(config=config)))
    response = asyncio.run(wave.create_saved_loop(request))
    assert response.status_code == expected_status
    assert calls and calls[0][0] == 'probe', 'Probe must precede encoding; client/display duration is not exact authority'
    if expected_end is None:
        assert [kind for kind, _ in calls] == ['probe']
        assert stored == [] and not output.exists()
    else:
        assert calls[1] == ('encode', expected_end)
        assert stored[0]['end_seconds'] == pytest.approx(expected_end)
        assert stored[0]['original_end_seconds'] == pytest.approx(expected_end)
        assert json.loads(response.body)['loop']['original_end_seconds'] == pytest.approx(expected_end)
