"""Approved Settings A/B preference validation; persistence is verified separately."""

import pytest

from music_app.services.appearance_preferences_postgres import (
    expand_appearance_preferences,
    normalize_appearance_preferences,
)
from tests.py.test_account_appearance_asgi import AGGREGATE_APPEARANCE


def aggregate_write(**changes):
    return {
        **{key: value for key, value in AGGREGATE_APPEARANCE.items()
           if key not in {"revision", "player_recent_sets"}},
        **changes,
    }


def test_existing_account_without_style_reads_approved_capsule_default():
    result = expand_appearance_preferences(AGGREGATE_APPEARANCE)
    assert result["loop_control_style"] == "capsule"
    assert result["revision"] == AGGREGATE_APPEARANCE["revision"]


@pytest.mark.parametrize("style", ["capsule", "companion"])
def test_style_survives_aggregate_write_validation_and_read_expansion(style):
    normalized = normalize_appearance_preferences(aggregate_write(loop_control_style=style))
    assert normalized["loop_control_style"] == style
    expanded = expand_appearance_preferences({
        **normalized, "revision": 8, "player_recent_sets": [],
    })
    assert expanded["loop_control_style"] == style
    assert expanded["interaction_overrides"] == normalized["interaction_overrides"]


@pytest.mark.parametrize("style", [None, "", "A", "B", "Capsule", "unknown", 1, True, {}])
def test_invalid_style_is_rejected_without_normalizing_to_another_choice(style):
    with pytest.raises(ValueError):
        normalize_appearance_preferences(aggregate_write(loop_control_style=style))


def test_omitted_style_remains_omitted_in_write_to_preserve_existing_account_choice():
    assert "loop_control_style" not in normalize_appearance_preferences(aggregate_write())
