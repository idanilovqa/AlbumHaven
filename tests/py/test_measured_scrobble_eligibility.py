"""Measured completion eligibility cannot borrow legacy playback counters."""
from contextlib import nullcontext
import math
from unittest.mock import Mock

import pytest

from music_app.services import lastfm_sync_bridge as bridge, listen_history
from music_app.services.lastfm_listen_sync import (
    build_playback_complete_entry, playback_scrobble_threshold_seconds,
)
from music_app.services.measured_listen_history import MeasuredListenError
from tests.py.test_settings_measured_listen_ledger import measured


def complete(monkeypatch, meaningful=lambda value: True, **changes):
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
        is_meaningful_listen_session=meaningful,
        append_listen_history_entry=append, update_listen_history_entry=update,
        scrobble_track=provider, log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )
    assert code == 200
    return result, provider


@pytest.mark.parametrize('duration,total,legacy,claimed,eligible', [
    (60, 31, 0, False, True),
    (30.5, 15.25, 0, False, True),
    (30, 30, 30, True, False),
    (14, 14, 14, True, False),
    (8, 8, 8, True, False),
    (60, 30, 0, False, True),
    (60, 29.999, 60, True, False),
    (60, 1, 60, True, False),
    (900, 240, 0, False, True),
    (900, 239.999, 900, True, False),
    (400, 200, 0, False, True),
    (400, 199.999, 400, True, False),
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


@pytest.mark.parametrize('duration,threshold', [
    (0, 0.0), (8, math.inf), (14, math.inf), (30, math.inf), (30.5, 15.25), (240, 120.0),
    (479, 239.5), (480, 240.0), (600, 240.0), (1200, 240.0),
])
def test_last_fm_never_scrobbles_a_track_of_thirty_seconds_or_less(duration, threshold):
    assert playback_scrobble_threshold_seconds(duration) == threshold


def test_legacy_completion_of_a_short_track_heard_in_full_is_not_scrobble_eligible():
    entry = build_playback_complete_entry({
        'duration_seconds': 30, 'total_listened_seconds': 30, 'max_contiguous_seconds': 30,
        'scrobble_eligible': True,
    })

    assert entry['scrobble_eligible'] is False


@pytest.mark.parametrize('duration', [8, 14, 30])
def test_short_track_heard_in_full_is_recorded_and_never_sent_to_last_fm(monkeypatch, duration):
    result, provider = complete(
        monkeypatch, meaningful=listen_history.is_meaningful_listen_session, finalized=True,
        duration_seconds=duration, measured_listened_seconds=duration,
        max_measured_contiguous_seconds=duration, scrobble_eligible=True,
    )

    assert result['entry'] is not None
    assert result['entry']['scrobble_eligible'] is False
    assert result['scrobble_attempted'] is False
    provider.assert_not_called()
