"""Measured completion eligibility cannot borrow legacy playback counters."""
from contextlib import nullcontext
from unittest.mock import Mock

import pytest

from music_app.services import lastfm_sync_bridge as bridge
from music_app.services.measured_listen_history import MeasuredListenError
from tests.py.test_settings_measured_listen_ledger import measured


def complete(monkeypatch, **changes):
    entry = measured({'path': 'test.flac', 'track_id': 1}, **changes)
    stored = {}

    def append(_config, value, **_scope):
        stored.update(value, id='listen-1')
        return dict(stored)

    def update(_config, _id, value, **_scope):
        stored.update(value)
        return dict(stored)

    provider = Mock(return_value=None)
    monkeypatch.setattr(bridge, 'measured_provider_guard', lambda *args, **kwargs: nullcontext())
    result, code = bridge.record_playback_session_complete(
        {}, entry, account_id=1, library_id=1, lastfm_session=object(),
        user_timezone='UTC', normalize_playback_track_payload=lambda value: value,
        is_meaningful_listen_session=lambda value: True,
        append_listen_history_entry=append, update_listen_history_entry=update,
        scrobble_track=provider, log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )
    assert code == 200
    return result, provider


@pytest.mark.parametrize('duration,total,legacy,claimed,eligible', [
    (60, 31, 0, False, True),
    (60, 30, 0, False, True),
    (60, 29.999, 60, True, False),
    (60, 1, 60, True, False),
    (900, 300, 0, False, True),
    (900, 299.999, 900, True, False),
    (0, 300, 900, True, False),
])
def test_validated_measurement_alone_controls_provider_submission(
    monkeypatch, duration, total, legacy, claimed, eligible,
):
    result, provider = complete(
        monkeypatch, duration_seconds=duration, measured_listened_seconds=total,
        max_measured_contiguous_seconds=total, total_listened_seconds=legacy,
        max_contiguous_seconds=legacy, scrobble_eligible=claimed,
    )
    assert result['entry']['scrobble_eligible'] is eligible
    assert result['scrobble_attempted'] is eligible
    assert provider.call_count == int(eligible)


@pytest.mark.parametrize('value', ['31', True, -1, float('nan'), float('inf')])
def test_malformed_measurement_is_rejected_before_provider_guard(monkeypatch, value):
    with pytest.raises(MeasuredListenError, match='Invalid listen measurement'):
        complete(monkeypatch, measured_listened_seconds=value)
