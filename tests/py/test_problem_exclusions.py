from __future__ import annotations

import pytest


def _canonical_album_item(
    *,
    row_key: str,
    album_key: str,
    legacy_row_keys: list[str] | None = None,
) -> dict[str, object]:
    return {
        "row_key": row_key,
        "scope": "album",
        "path": "",
        "filename": "",
        "field": "problem-album",
        "album": "?",
        "artist": "Neal Morse",
        "year": "2005",
        "problem_reason": "Undecoded characters",
        "album_group_key": "Neal Morse :: ?",
        "album_key": album_key,
        "legacy_row_keys": list(legacy_row_keys or []),
    }


def _canonical_file_item(*, row_key: str, path: str) -> dict[str, object]:
    return {
        "row_key": row_key,
        "scope": "file",
        "path": path,
        "filename": "01 - The Temple.mp3",
        "field": "problem-file",
        "album": "?",
        "artist": "Neal Morse",
        "year": "2005",
        "problem_reason": "Missing year",
        "album_group_key": "Neal Morse :: ?",
        "album_key": "neal morse::?",
        "legacy_row_keys": [],
    }


def test_parse_problem_exclusion_items_accepts_canonical_album_and_file_rows():
    from music_app.services.problem_exclusions import (
        ProblemExclusionItem,
        parse_problem_exclusion_items,
    )

    album_row_key = "neal morse::?::problem-album::undecoded-characters"
    track_path = "C:/Music/Neal Morse/?/01 - The Temple.mp3"
    file_row_key = f"{track_path}::problem-file::missing-year"

    items = parse_problem_exclusion_items({
        "items": [
            {
                "row_key": album_row_key,
                "scope": "album",
                "album_key": "neal morse::?",
            },
            {
                "row_key": file_row_key,
                "scope": "file",
                "path": track_path,
            },
        ],
    })

    assert list(items) == [
        ProblemExclusionItem(
            row_key=album_row_key,
            scope="album",
            album_key="neal morse::?",
        ),
        ProblemExclusionItem(
            row_key=file_row_key,
            scope="file",
            path=track_path,
        ),
    ]


@pytest.mark.parametrize(
    "payload",
    (
        {},
        {"items": []},
        {"items": "not-a-list"},
        {"items": [{"row_key": "", "scope": "album", "album_key": "album"}]},
        {
            "items": [
                {"row_key": "same", "scope": "album", "album_key": "album"},
                {"row_key": "same", "scope": "album", "album_key": "album"},
            ],
        },
    ),
)
def test_parse_problem_exclusion_items_rejects_empty_or_duplicate_items(payload):
    from music_app.services.problem_exclusions import parse_problem_exclusion_items

    with pytest.raises(ValueError):
        parse_problem_exclusion_items(payload)


@pytest.mark.parametrize(
    "field,value",
    (
        ("album", {"name": "?"}),
        ("selected_rows", []),
        ("changes", {}),
        ("confirmed", True),
        ("separate_release_keys", []),
    ),
)
def test_parse_problem_exclusion_items_rejects_tag_edit_fields(field, value):
    from music_app.services.problem_exclusions import parse_problem_exclusion_items

    with pytest.raises(ValueError):
        parse_problem_exclusion_items({
            "items": [{
                "row_key": "album::problem-album::missing-year",
                "scope": "album",
                "album_key": "album",
            }],
            field: value,
        })


@pytest.mark.parametrize(
    "item",
    (
        {
            "row_key": "album::problem-album::missing-year",
            "scope": "album",
        },
        {
            "row_key": "album::problem-album::missing-year",
            "scope": "file",
            "path": "C:/Music/track.mp3",
        },
        {
            "row_key": "C:/Music/track.mp3::problem-file::missing-year",
            "scope": "file",
        },
        {
            "row_key": "C:/Music/track.mp3::problem-file::missing-year",
            "scope": "album",
            "album_key": "album",
        },
    ),
)
def test_parse_problem_exclusion_items_rejects_scope_identity_mismatch(item):
    from music_app.services.problem_exclusions import parse_problem_exclusion_items

    with pytest.raises(ValueError):
        parse_problem_exclusion_items({"items": [item]})


def test_create_problem_exclusions_validates_durable_album_key_separately_from_projected_identity(
    monkeypatch,
):
    from music_app.services import problem_exclusions as module

    durable_album_key = "product artist::studio records"
    projected_identity = f"{durable_album_key}::year::1988"
    row_key = f"{projected_identity}::problem-album::undecoded-characters"
    canonical_item = _canonical_album_item(
        row_key=row_key,
        album_key=durable_album_key,
    )
    mutations: list[dict[str, object]] = []

    monkeypatch.setattr(
        module,
        "create_ignored_repair_keys",
        lambda _config, row_keys, **kwargs: mutations.append({
            "row_keys": set(row_keys),
            **kwargs,
        }),
    )

    result = module.create_problem_exclusions(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app"},
        {
            "items": [{
                "row_key": row_key,
                "scope": "album",
                "album_key": durable_album_key,
            }],
        },
        resolve_items=lambda items: (
            [canonical_item]
            if {
                (item.row_key, item.album_key, item.path)
                for item in items
            } == {(row_key, durable_album_key, "")}
            else []
        ),
    )

    assert result.applied_items == [
        {
            key: value
            for key, value in canonical_item.items()
            if key not in {"album_key", "legacy_row_keys"}
        }
    ]
    assert mutations == [{
        "row_keys": {row_key},
        "album_keys_by_repair_key": {row_key: durable_album_key},
        "remove_row_keys": set(),
    }]


@pytest.mark.parametrize(
    "resolved_items",
    (
        [],
        [_canonical_album_item(
            row_key="other::problem-album::undecoded-characters",
            album_key="neal morse::?",
        )],
        [_canonical_album_item(
            row_key="neal morse::?::problem-album::undecoded-characters",
            album_key="different-durable-album",
        )],
    ),
)
def test_create_problem_exclusions_rejects_unknown_stale_or_wrong_owner_rows(
    monkeypatch,
    resolved_items,
):
    from music_app.services import problem_exclusions as module

    row_key = "neal morse::?::problem-album::undecoded-characters"
    monkeypatch.setattr(
        module,
        "create_ignored_repair_keys",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("invalid identities must not be persisted")
        ),
    )

    with pytest.raises(ValueError):
        module.create_problem_exclusions(
            {},
            {
                "items": [{
                    "row_key": row_key,
                    "scope": "album",
                    "album_key": "neal morse::?",
                }],
            },
            resolve_items=lambda _items: list(resolved_items),
        )


def test_create_problem_exclusions_applies_mixed_batch_once_and_returns_full_canonical_rows(
    monkeypatch,
):
    from music_app.services import problem_exclusions as module

    durable_album_key = "neal morse::?"
    album_row_key = f"{durable_album_key}::problem-album::undecoded-characters"
    track_path = "C:/Music/Neal Morse/?/01 - The Temple.mp3"
    file_row_key = f"{track_path}::problem-file::missing-year"
    legacy_keys = [f"{track_path}::album"]
    canonical_items = [
        _canonical_album_item(
            row_key=album_row_key,
            album_key=durable_album_key,
            legacy_row_keys=legacy_keys,
        ),
        _canonical_file_item(row_key=file_row_key, path=track_path),
    ]
    mutations: list[dict[str, object]] = []

    def create_keys(_config, row_keys, **kwargs):
        mutations.append({"row_keys": set(row_keys), **kwargs})

    monkeypatch.setattr(module, "create_ignored_repair_keys", create_keys)

    result = module.create_problem_exclusions(
        {},
        {
            "items": [
                {
                    "row_key": album_row_key,
                    "scope": "album",
                    "album_key": durable_album_key,
                },
                {
                    "row_key": file_row_key,
                    "scope": "file",
                    "path": track_path,
                },
            ],
        },
        resolve_items=lambda items: (
            list(canonical_items)
            if {
                (item.row_key, item.album_key, item.path)
                for item in items
            } == {
                (album_row_key, durable_album_key, ""),
                (file_row_key, "", track_path),
            }
            else []
        ),
    )

    assert mutations == [{
        "row_keys": {album_row_key, file_row_key},
        "album_keys_by_repair_key": {album_row_key: durable_album_key},
        "remove_row_keys": set(legacy_keys),
    }]
    assert result.removed_legacy_row_keys == legacy_keys
    assert result.applied_items == [
        {
            key: value
            for key, value in item.items()
            if key not in {"album_key", "legacy_row_keys"}
        }
        for item in canonical_items
    ]
    assert all({
        "row_key",
        "scope",
        "path",
        "filename",
        "field",
        "album",
        "artist",
        "year",
        "problem_reason",
        "album_group_key",
    }.issubset(item) for item in result.applied_items)
