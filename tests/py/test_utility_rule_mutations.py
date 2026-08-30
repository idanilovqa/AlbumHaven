from __future__ import annotations

from music_app.services.utility_rule_mutations import (
    create_version_exception,
    mark_manual_version_link,
    revert_rule_key,
    unmark_manual_version_link,
    validate_manual_version_link_keys,
)


def test_version_exception_mutations_normalize_validate_and_persist_sets():
    config = {"DATA_DIR": "unused"}
    saved: list[set[str]] = []

    keys, error = create_version_exception(
        config,
        " album-1 ",
        load_keys=lambda cfg: {"album-2"},
        save_keys=lambda cfg, values: saved.append(set(values)),
    )
    assert error == ""
    assert keys == {"album-1", "album-2"}
    assert saved == [{"album-1", "album-2"}]

    keys, error = revert_rule_key(
        config,
        " album-2 ",
        missing_error="Missing album key",
        load_keys=lambda cfg: {"album-1", "album-2"},
        save_keys=lambda cfg, values: saved.append(set(values)),
    )
    assert error == ""
    assert keys == {"album-1"}
    assert saved[-1] == {"album-1"}

    keys, error = create_version_exception(
        config,
        " ",
        load_keys=lambda cfg: {"album-1"},
        save_keys=lambda cfg, values: saved.append(set(values)),
    )
    assert keys == set()
    assert error == "Missing album key"
    assert saved[-1] == {"album-1"}


def test_manual_version_link_mutations_persist_and_report_missing():
    config = {"DATA_DIR": "unused"}
    saved: list[dict[str, str]] = []

    links, error = mark_manual_version_link(
        config,
        " child ",
        " parent ",
        load_links=lambda cfg: {"sibling": "parent"},
        save_links=lambda cfg, values: saved.append(dict(values)),
    )
    assert error == ""
    assert links == {"sibling": "parent", "child": "parent"}
    assert saved == [{"sibling": "parent", "child": "parent"}]

    links, error = mark_manual_version_link(
        config,
        "child",
        "child",
        load_links=lambda cfg: {},
        save_links=lambda cfg, values: saved.append(dict(values)),
    )
    assert links == {}
    assert error == "Album cannot be marked as a version of itself"
    assert saved == [{"sibling": "parent", "child": "parent"}]

    links, error = unmark_manual_version_link(
        config,
        "child",
        load_links=lambda cfg: {"child": "parent"},
        save_links=lambda cfg, values: saved.append(dict(values)),
    )
    assert error == ""
    assert links == {}
    assert saved[-1] == {}

    links, error = unmark_manual_version_link(
        config,
        "missing",
        load_links=lambda cfg: {"child": "parent"},
        save_links=lambda cfg, values: saved.append(dict(values)),
    )
    assert error == "Album is not marked as a version"
    assert links == {"child": "parent"}
    assert saved[-1] == {}


def test_manual_version_key_validation_normalizes_without_persisting():
    assert validate_manual_version_link_keys(" child ", " parent ") == (
        "child",
        "parent",
        "",
    )
    assert validate_manual_version_link_keys("", "parent") == (
        "",
        "",
        "Missing album key",
    )
    assert validate_manual_version_link_keys("child", "child") == (
        "child",
        "child",
        "Album cannot be marked as a version of itself",
    )
