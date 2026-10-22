"""Applied filter contract validation; no new defaults or preference authority."""
from uuid import uuid4
import pytest
from music_app.services.playlist_filter_preferences import DEFAULT_FILTERS, applied_filters, filter_command
from music_app.services.owned_playlists import PlaylistError


def test_exact_existing_defaults_clear_saved_state():
    command = filter_command(str(uuid4()), dict(revision="1", request_key=str(uuid4()), filters=dict(DEFAULT_FILTERS)))
    assert command.data == {"revision": "1", "filters": None}
    assert applied_filters(DEFAULT_FILTERS) == DEFAULT_FILTERS


@pytest.mark.parametrize("patch", [
    {"unknown": True}, {"query": "x" * 201}, {"style": " rock "}, {"style": "x\n"},
    {"query": "\x00"}, {"availability": "remote"}, {"love": "favorite"},
    {"frequency": "popular"}, {"frequencyMode": "exclude"}, {"includeUnknown": 1},
    {"addedWithinDays": True}, {"addedWithinDays": 2}, {"minDuration": -1},
    {"minDuration": float("inf")}, {"minDuration": float("nan")},
    {"minDuration": True}, {"minDurationExclusive": True},
    {"minDuration": 300, "maxDuration": 100},
    {"minDuration": 10 ** 400}, {"query": "\U0001f600" * 101},
    {"style": "\U0001f600" * 51}, {"style": "\ufeffRock"},
    {"query": "\ud800"}, {"style": "\udfff"},
])
def test_malformed_or_non_normalized_state_is_rejected(patch):
    with pytest.raises(PlaylistError, match="invalid_command"):
        applied_filters({**DEFAULT_FILTERS, **patch})


def test_existing_applied_choices_are_preserved_without_fact_inference():
    value = {**DEFAULT_FILTERS, "query": "Song", "love": "obsessed", "style": "Rock",
        "minDuration": 180, "maxDuration": 300, "addedWithinDays": 7,
        "frequency": "forgotten", "frequencyMode": "exclude", "includeUnknown": False}
    assert applied_filters(value) == value
    assert applied_filters(value) is not value


def test_utf16_boundaries_and_ecmascript_trim_contract():
    for patch in ({"query": "\U0001f600" * 100}, {"style": "\U0001f600" * 50},
                  {"style": "\u0085Rock\u0085"}):
        value = {**DEFAULT_FILTERS, **patch}
        assert applied_filters(value) == value


@pytest.mark.parametrize("field,value", [("revision", "1\n"), ("request_key", str(uuid4()) + "\n")])
def test_command_identity_is_strict(field, value):
    payload = dict(revision="1", request_key=str(uuid4()), filters=None)
    payload[field] = value
    with pytest.raises(PlaylistError):
        filter_command(str(uuid4()), payload)
