from copy import deepcopy
import pytest
from music_app.services.client_layout_preferences import default_preferences, normalize_changes


def test_thin_mobile_default_does_not_modify_desktop_or_shared_defaults():
    phone = default_preferences('mobile')
    assert phone['playerAppearance']['seekbarMode'] == 'thin'
    assert default_preferences('web_desktop')['playerAppearance']['seekbarMode'] == 'default'
    phone['playerAppearance']['seekbarMode'] = 'waveform'
    assert default_preferences('mobile')['playerAppearance']['seekbarMode'] == 'thin'


@pytest.mark.parametrize('mode', ['thin', 'default', 'waveform'])
def test_seekbar_modes_round_trip_without_changing_the_other_player_fields(mode):
    candidate = deepcopy(default_preferences('mobile')['playerAppearance'])
    candidate['seekbarMode'] = mode
    assert normalize_changes({'playerAppearance': candidate}) == {'playerAppearance': candidate}


def test_unknown_seekbar_mode_is_rejected():
    candidate = default_preferences('mobile')['playerAppearance']
    candidate['seekbarMode'] = 'javascript:alert(1)'
    with pytest.raises(ValueError):
        normalize_changes({'playerAppearance': candidate})
