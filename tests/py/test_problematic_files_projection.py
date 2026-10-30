from __future__ import annotations

import inspect
import json
from copy import deepcopy

import pytest


def _row(*, year: object, title: str, path: str, track_number: int | None = 1):
    base_key = "ДДТ::Студийные записи::Deluxe".lower()
    return {
        "album_id": 71,
        "album_key": "persisted-ddt-studio",
        "album_title": "Студийные записи",
        "album_release_year": None,
        "album_edition": "Deluxe",
        "album_cover_path": None,
        "album_metadata": {
            "album_artist": "ДДТ",
            "artists": ["ДДТ"],
            "edition": "Deluxe",
        },
        "artist_name": "ДДТ",
        "track_id": year,
        "track_key": f"track-{year}",
        "track_title": title,
        "track_number": track_number,
        "disc_number": 1,
        "duration_seconds": 180,
        "file_private_path": path,
        "file_entry": {
            "path": path,
            "album": "Студийные записи",
            "album_artist": "ДДТ",
            "artist": "ДДТ",
            "title": title,
            "year": year,
            "track_number": track_number,
            "disc_number": 1,
        },
        "ignored_repair_keys": [],
        "separate_release_keys": [base_key],
        "duplicate_file_count": 1,
    }


def _persist_semantic_facts(accumulator, entries):
    """Mirror the fact table's semantic upsert and repository read order."""
    persisted = {}
    for stage_id, fact_kind, fact_value in accumulator.consume(entries):
        key = (
            str(fact_value["projection_id"]),
            fact_kind,
            str(fact_value["semantic_child_identity"]),
        )
        previous = persisted.get(key)
        if previous is not None and fact_kind == "duplicate_root":
            fact_value = {
                **fact_value,
                "primary": bool(
                    previous[2].get("primary") or fact_value.get("primary")
                ),
            }
        persisted[key] = (
            min(stage_id, previous[0]) if previous is not None else stage_id,
            fact_kind,
            fact_value,
        )
    return [persisted[key] for key in sorted(persisted)]


def test_persisted_sort_keys_are_utf8_bounded_without_truncating_raw_summary():
    from music_app.services.problematic_files_projection import (
        _persisted_problematic_item,
    )

    title = "é" * 3_000
    artist = "Ж" * 5_000
    album_key = "key-" + ("한" * 4_500)
    item = _persisted_problematic_item(
        {
            "projection_id": "normal-item",
            "name": title,
            "album_artist": artist,
            "year": "2026",
            "key": album_key,
            "problem_reasons": ["Missing cover art"],
        }
    )

    assert len(item["sort_title"].encode("utf-8")) <= 512
    assert len(item["sort_artist"].encode("utf-8")) <= 512
    assert len(item["sort_album_key"].encode("utf-8")) <= 512
    assert item["summary"]["name"] == title
    assert item["summary"]["album_artist"] == artist
    assert item["summary"]["key"] == album_key


def test_persisted_sort_contract_preserves_normal_order_and_breaks_long_prefix_ties():
    from music_app.services.problematic_files_projection import (
        _persisted_problematic_item,
    )

    ordinary = _persisted_problematic_item(
        {
            "projection_id": "ordinary",
            "name": "Beta",
            "album_artist": "Artist",
            "year": "2026",
            "key": "Album-Key",
            "problem_reasons": ["Missing cover art"],
        }
    )
    assert (
        ordinary["sort_title"],
        ordinary["sort_artist"],
        ordinary["sort_year"],
        ordinary["sort_album_key"],
    ) == ("beta", "artist", "2026", "album-key")

    shared_prefix = "a" * 512
    left = _persisted_problematic_item(
        {
            "projection_id": "item-a",
            "name": shared_prefix + "z",
            "problem_reasons": ["Missing cover art"],
        }
    )
    right = _persisted_problematic_item(
        {
            "projection_id": "item-b",
            "name": shared_prefix + "b",
            "problem_reasons": ["Missing cover art"],
        }
    )
    assert left["sort_title"] == right["sort_title"] == shared_prefix
    assert (left["sort_title"], left["item_key"]) < (
        right["sort_title"],
        right["item_key"],
    )


@pytest.mark.parametrize("inventory_status", ["active", "missing"])
def test_oversized_loose_projection_locator_uses_stable_bounded_hash(
    inventory_status,
):
    from music_app.services.problematic_files_projection import (
        problematic_projection_id,
    )

    row = {
        "album_id": None,
        "album_key": "opaque-" + ("한" * 4_500),
        "inventory_status": inventory_status,
    }
    projection_id = problematic_projection_id(row)

    assert projection_id.startswith("h1:")
    assert len(projection_id.encode("utf-8")) <= 256
    assert projection_id == problematic_projection_id(dict(row))
    assert problematic_projection_id(
        {"album_id": None, "album_key": "short", "inventory_status": inventory_status}
    ).startswith("h1:") is False


def test_oversized_split_year_projection_locator_uses_stable_bounded_hash():
    from music_app.services.problematic_files_projection import (
        problematic_projection_id,
    )

    long_year = "year-" + ("Ж" * 4_500)
    row = {
        "album_id": 71,
        "album_title": "Split release",
        "artist_name": "Artist",
        "file_entry": {"year": long_year},
        "separate_release_member": True,
    }

    projection_id = problematic_projection_id(row)

    assert projection_id.startswith("h1:")
    assert len(projection_id.encode("utf-8")) <= 256
    assert projection_id == problematic_projection_id(dict(row))
    assert not problematic_projection_id(
        {**row, "file_entry": {"year": "2026"}}
    ).startswith("h1:")


def _project_with_persisted_ignored_repairs(row, repair_keys):
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        _ProblematicItemReducer,
    )

    seed_facts = _persist_semantic_facts(
        ProblematicGroupAccumulator(), ((1, row),)
    )
    projection_id = next(
        payload["projection_id"]
        for _stage_id, fact_kind, payload in seed_facts
        if fact_kind == "row"
    )
    entries = [(1, row)]
    entries.extend(
        (
            stage_id,
            {
                "projection_id": projection_id,
                "source_child_kind": "ignored_repair",
                "ignored_repair_key": repair_key,
            },
        )
        for stage_id, repair_key in enumerate(repair_keys, start=2)
    )
    facts = _persist_semantic_facts(ProblematicGroupAccumulator(), entries)
    reducer = _ProblematicItemReducer(str(projection_id))
    for _stage_id, fact_kind, payload in facts:
        reducer.consume(fact_kind, payload)
    return reducer.finish()


def _relevant_ignore_keys_before(
    target_key, *, minimum_count, minimum_encoded_bytes, value_size
):
    from music_app.services.problematic_files_projection import (
        _problematic_ignored_repair_identity,
    )

    path = target_key.split("::", 1)[0]
    target_identity = _problematic_ignored_repair_identity(target_key)
    keys = []
    encoded_bytes = 0
    candidate_index = 0
    while len(keys) < minimum_count or encoded_bytes <= minimum_encoded_bytes:
        candidate = (
            f"{path}::problem-file::{candidate_index:06d}-"
            f"{'x' * value_size}"
        )
        candidate_index += 1
        if _problematic_ignored_repair_identity(candidate) >= target_identity:
            continue
        keys.append(candidate)
        encoded_bytes += len(
            json.dumps(candidate, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            )
        ) + 1
    return keys


def _persisted_summary_contract(item, eager_summary):
    expected = deepcopy(eager_summary)
    for compatibility_field in ("file_types", "search_text", "track_paths"):
        expected.pop(compatibility_field, None)
    assert item["summary"] == expected
    assert item["reasons"] == expected["problem_reasons"]
    assert item["item_key"] == expected["projection_id"]


def test_persisted_search_facts_use_reader_nfkc_casefold_whitespace_normalization():
    from music_app.services.problematic_files_projection import (
        _normalized_problematic_search_chunks,
        normalized_problematic_search_text,
    )
    from music_app.services.problematic_projection_postgres import _normalize_cursor_scope

    raw = "ＡＬＰＨＡ\t  Beta"
    persisted_fact = _normalized_problematic_search_chunks(raw)[0]
    persisted_item = normalized_problematic_search_text({"name": raw})
    reader = _normalize_cursor_scope(
        library_id=1,
        revision="00000000-0000-0000-0000-000000000001",
        query=raw,
        reasons=(),
        sort="default",
    )[2]

    assert persisted_fact == persisted_item == reader == "alpha beta"
    assert sum(
        reader in document
        for document in (
            persisted_item,
            normalized_problematic_search_text({"name": "Alpha Gamma"}),
        )
    ) == 1


def test_normalized_search_query_enforces_utf8_boundary_after_nfkc():
    from music_app.services.problematic_files_projection import (
        normalize_problematic_search_query,
    )
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionCursorError,
        _normalize_cursor_scope,
    )

    assert normalize_problematic_search_query("x" * 4096) == "x" * 4096
    assert normalize_problematic_search_query("\uff21" * 4096) == "a" * 4096
    assert _normalize_cursor_scope(
        library_id=1,
        revision="00000000-0000-0000-0000-000000000001",
        query="x" * 4096,
        reasons=(),
        sort="album",
    )[2] == "x" * 4096

    with pytest.raises(ValueError, match="query exceeds 4096 bytes"):
        normalize_problematic_search_query("x" * 4097)
    with pytest.raises(ValueError, match="query exceeds 4096 bytes"):
        normalize_problematic_search_query("\ufdfa" * 125)
    with pytest.raises(
        ProblematicProjectionCursorError,
        match="invalid projection cursor scope",
    ):
        _normalize_cursor_scope(
            library_id=1,
            revision="revision",
            query="x" * 4097,
            reasons=(),
            sort="album",
        )


@pytest.mark.parametrize(
    ("fact_kind", "left", "right"),
    (
        ("featured_artist", "Ａｂｂａ", "Abba"),
        ("album_value", "Ａｌｂｕｍ", "Album"),
        ("artist_value", "Ａｒｔｉｓｔ", "Artist"),
    ),
)
def test_semantic_fact_identities_nfkc_before_casefold(fact_kind, left, right):
    from music_app.services.problematic_files_projection import ProblematicGroupAccumulator

    if fact_kind == "featured_artist":
        entries = [
            (
                index,
                {
                    "projection_id": "projection",
                    "source_child_kind": "featured_artist",
                    "featured_artist_name": value,
                },
            )
            for index, value in enumerate((left, right), 1)
        ]
    else:
        entries = [
            (
                index,
                {
                    "projection_id": "projection",
                    "file_private_path": f"D:/Music/{index}.flac",
                    "file_entry": {
                        "album": value if fact_kind == "album_value" else "Album",
                        "album_artist": value if fact_kind == "artist_value" else "Artist",
                        "title": f"Track {index}",
                        "year": "2000",
                        "track_number": index,
                        "disc_number": 1,
                    },
                },
            )
            for index, value in enumerate((left, right), 1)
        ]

    facts = list(ProblematicGroupAccumulator().consume(entries))
    identities = {
        fact_value["semantic_child_identity"]
        for _stage_id, emitted_kind, fact_value in facts
        if emitted_kind == fact_kind
    }

    assert len(identities) == 1


def test_pure_projector_preserves_split_unicode_identity_reasons_and_summary_parity():
    from music_app.services.problematic_files_projection import project_problematic_files

    rows = [
        _row(
            year=1988,
            title="Песня первая",
            path=r"D:\Музыка\ДДТ\Студийные записи\1988\01.flac",
        ),
        _row(
            year=1999,
            title="",
            path=r"D:\Музыка\ДДТ\Студийные записи\1999\02.ogg",
            track_number=None,
        ),
    ]

    projected = project_problematic_files(rows)
    assert [item["key"] for item in projected] == [
        "ддт::студийные записи::deluxe::year::1988",
        "ддт::студийные записи::deluxe::year::1999",
    ]
    assert [item["year"] for item in projected] == [1988, 1999]
    assert [item["edition"] for item in projected] == ["Deluxe", "Deluxe"]
    assert projected[0]["album_artist"] == "ДДТ"
    assert projected[0]["file_types"] == ["FLAC"]
    assert projected[1]["file_types"] == ["OGG"]
    assert "Missing cover art" in projected[0]["problem_reasons"]
    assert "Missing track title" in projected[1]["problem_reasons"]
    assert "Missing track number" in projected[1]["problem_reasons"]
    assert projected[0]["search_text"] == "Песня первая"
    assert projected[1]["search_text"] == ""


def test_incremental_accumulator_crash_resume_is_byte_equivalent_and_exactly_once():
    import json

    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    rows = [
        _row(
            year=1988,
            title=f"Песня {index}",
            path=rf"D:\Музыка\ДДТ\Студийные записи\1988\{index:04d}.flac",
            track_number=index,
        )
        for index in range(1, 2051)
    ]
    split = 1000

    uninterrupted = ProblematicGroupAccumulator()
    uninterrupted_facts = _persist_semantic_facts(
        uninterrupted,
        ((index, row) for index, row in enumerate(rows, 1)),
    )
    uninterrupted_items = tuple(uninterrupted.finalize(iter(uninterrupted_facts)))

    interrupted = ProblematicGroupAccumulator()
    persisted_facts = _persist_semantic_facts(
        interrupted,
        ((index, row) for index, row in enumerate(rows[:split], 1)),
    )
    checkpoint = interrupted.checkpoint()
    assert checkpoint.after_stage_id == split
    assert checkpoint.row_count == split
    assert not any(isinstance(value, (dict, list, tuple, set)) for value in vars(checkpoint).values())

    resumed = ProblematicGroupAccumulator.from_checkpoint(checkpoint)
    persisted_facts.extend(
        _persist_semantic_facts(
            resumed,
            (
                (index, row)
                for index, row in enumerate(rows[split:], split + 1)
            ),
        )
    )
    persisted_facts = sorted(
        {
            (
                fact[2]["projection_id"],
                fact[1],
                fact[2]["semantic_child_identity"],
            ): fact
            for fact in persisted_facts
        }.values(),
        key=lambda fact: (
            fact[2]["projection_id"],
            fact[1],
            fact[2]["semantic_child_identity"],
        ),
    )
    resumed_items = tuple(resumed.finalize(iter(persisted_facts)))

    canonical = lambda items: json.dumps(
        [dict(item) for item in items],
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    assert canonical(resumed_items) == canonical(uninterrupted_items)
    assert len(resumed_items) == len({item["key"] for item in resumed_items})


def test_incremental_finalizer_yields_before_consuming_the_next_item_group():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    first_rows = [
        _row(
            year=1988,
            title=f"First {index}",
            path=rf"D:\Music\First\{index:04d}.flac",
            track_number=index,
        )
        for index in range(1, 1002)
    ]
    second_rows = []
    for index in range(1, 1002):
        row = _row(
            year=1999,
            title=f"Second {index}",
            path=rf"D:\Music\Second\{index:04d}.flac",
            track_number=index,
        )
        row.update(album_id=9002, album_key="second", album_title="Second")
        second_rows.append(row)

    accumulator = ProblematicGroupAccumulator()
    facts = _persist_semantic_facts(
        accumulator,
        (
            (stage_id, row)
            for stage_id, row in enumerate((*first_rows, *second_rows), 1)
        ),
    )

    class CountedFacts:
        def __init__(self, values):
            self.values = values
            self.consumed = 0

        def __iter__(self):
            for value in self.values:
                self.consumed += 1
                yield value

    counted = CountedFacts(facts)
    projected = iter(accumulator.finalize(counted))

    first = next(projected)
    first_projection_id = facts[0][2]["projection_id"]
    first_group_fact_count = sum(
        fact[2]["projection_id"] == first_projection_id for fact in facts
    )
    assert first["key"]
    assert counted.consumed == first_group_fact_count + 1


def _stale_incremental_accumulator_streams_bounded_facts_and_compact_huge_album():
    import json
    import tracemalloc

    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    class CountedRows:
        def __init__(self, count):
            self.count = count
            self.consumed = 0

        def __iter__(self):
            for index in range(1, self.count + 1):
                self.consumed += 1
                yield index, _row(
                    year=1988,
                    title=f"{index:05d}-" + ("x" * 2048),
                    path=rf"D:\Music\Huge\{index:05d}.flac",
                    track_number=index,
                )

    row_count = 10_000
    counted = CountedRows(row_count)
    accumulator = ProblematicGroupAccumulator()
    facts = iter(accumulator.consume(counted))

    consumed_before_first = counted.consumed
    first_fact = next(facts)
    consumed_after_first = counted.consumed
    first_fact_bytes = len(
        json.dumps(first_fact[2], ensure_ascii=False).encode("utf-8")
    )

    remaining_facts = list(facts)
    assert counted.consumed == row_count
    assert len(remaining_facts) + 1 == row_count
    assert all(
        len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) <= 65_536
        for _stage_id, fact_kind, payload in remaining_facts
        if fact_kind == "track"
    )
    checkpoint = accumulator.checkpoint()
    assert checkpoint.after_stage_id == row_count
    assert checkpoint.row_count == row_count
    assert not any(
        isinstance(value, (dict, list, tuple, set))
        for value in vars(checkpoint).values()
    )

    streaming_rows = CountedRows(row_count)
    streaming_accumulator = ProblematicGroupAccumulator()
    tracemalloc.start()
    summaries = list(
        streaming_accumulator.finalize(streaming_accumulator.consume(streaming_rows))
    )
    _current_bytes, peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    summary_bytes = len(
        json.dumps(dict(summaries[0]), ensure_ascii=False).encode("utf-8")
    )
    violations = {
        "consumed_before_first": consumed_before_first,
        "consumed_after_first": consumed_after_first,
        "first_fact_kind": first_fact[1],
        "first_fact_bytes": first_fact_bytes,
        "summary_count": len(summaries),
        "summary_has_track_paths": "track_paths" in summaries[0],
        "summary_has_search_text": "search_text" in summaries[0],
        "summary_bytes": summary_bytes,
        "peak_bytes": peak_bytes,
    }
    assert violations == {
        "consumed_before_first": 0,
        "consumed_after_first": 1,
        "first_fact_kind": "track",
        "first_fact_bytes": first_fact_bytes,
        "summary_count": 1,
        "summary_has_track_paths": False,
        "summary_has_search_text": False,
        "summary_bytes": summary_bytes,
        "peak_bytes": peak_bytes,
    }, f"METRICS={violations!r}"
    assert streaming_rows.consumed == row_count
    assert first_fact_bytes <= 65_536
    assert summary_bytes <= 65_536
    assert peak_bytes <= 12 * 1024 * 1024


def test_huge_group_relational_reduction_bounds_search_document_deterministically():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    rows = [
        _row(
            year=1988,
            title=f"{index:04d}-" + ("title" * 500),
            path=rf"D:\Music\Huge\{'path' * 500}\{index:04d}.flac",
            track_number=index,
        )
        for index in range(1, 257)
    ]
    accumulator = ProblematicGroupAccumulator()
    raw_facts = tuple(accumulator.consume(enumerate(rows, 1)))

    def relationally_reduce(facts):
        conflict_rows = {
            (
                str(payload["projection_id"]),
                fact_kind,
                str(payload["semantic_child_identity"]),
            ): (stage_id, fact_kind, payload)
            for stage_id, fact_kind, payload in facts
        }
        return sorted(
            conflict_rows.values(),
            key=lambda fact: (
                str(fact[2]["projection_id"]),
                fact[1],
                str(fact[2]["semantic_child_identity"]),
            ),
        )

    forward = list(accumulator.finalize(relationally_reduce(raw_facts)))
    replayed = list(accumulator.finalize(relationally_reduce(reversed(raw_facts))))

    assert replayed == forward
    assert len(forward) == 1
    assert len(forward[0]["search_text"].encode("utf-8")) <= 32_768


def test_incremental_accumulator_emits_normalized_semantic_facts():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    row = _row(
        year=1988,
        title="First",
        path=r"D:\Music\First\01.flac",
        track_number=1,
    )
    companion = dict(row)
    companion.update(
        source_child_kind="duplicate_companion",
        companion_file_id=202,
        companion_private_path=r"E:\Music\First\01.flac",
        companion_library_root_id=9,
        companion_root_category="main",
    )

    facts = list(ProblematicGroupAccumulator().consume(((1, row), (2, companion))))
    kinds = {fact_kind for _stage_id, fact_kind, _payload in facts}

    assert {
        "row",
        "album_value",
        "artist_value",
        "raw_year",
        "valid_year",
        "track_number",
        "duplicate_companion",
    } <= kinds
    assert all(payload.get("projection_id") for _, _, payload in facts)
    assert all(payload.get("semantic_child_identity") for _, _, payload in facts)
    assert sum(fact_kind == "row" for _, fact_kind, _ in facts) == 1


def test_incremental_reducer_has_no_unbounded_identity_sets_or_sparse_range():
    from music_app.services import problematic_files_projection as projection

    reducer_source = inspect.getsource(projection._ProblematicItemReducer)

    assert "self.paths" not in reducer_source
    assert "track_numbers_by_disc" not in reducer_source
    assert "self.featured_artist_names" not in reducer_source
    assert "self.ignored_repair_keys" not in reducer_source
    assert "range(1, max(" not in reducer_source


def test_incremental_featured_and_ignored_facts_preserve_canonical_summary():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        project_problematic_files,
    )

    row = _row(
        year=1988,
        title="",
        path=r"D:\Music\Featured\01.flac",
        track_number=1,
    )
    row["artist_name"] = ""
    repair_key = f'{row["file_private_path"]}::title'
    expected_row = deepcopy(row)
    expected_row["artist_name"] = "Guest A, Guest B"
    expected_row["ignored_repair_keys"] = [repair_key]
    featured_a = {
        **row,
        "source_child_kind": "featured_artist",
        "featured_artist_name": "Guest A",
    }
    featured_b = {
        **row,
        "source_child_kind": "featured_artist",
        "featured_artist_name": "Guest B",
    }
    ignored = {
        **row,
        "source_child_kind": "ignored_repair",
        "ignored_repair_key": repair_key,
    }
    accumulator = ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(((1, row), (2, featured_a), (3, featured_b), (4, ignored))),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )
    actual = list(accumulator.finalize(facts))[0]
    expected = project_problematic_files((expected_row,))[0]

    _persisted_summary_contract(actual, expected)


def test_incremental_sparse_gap_uses_one_bounded_compact_reason():
    from music_app.services import problematic_files_projection as projection

    first = _row(
        year=1988,
        title="First",
        path=r"D:\Music\First\01.flac",
        track_number=1,
    )
    last = _row(
        year=1988,
        title="Last",
        path=r"D:\Music\First\99.flac",
        track_number=99,
    )
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(((1, first), (2, last))),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )
    projected = list(accumulator.finalize(facts))
    assert projected[0]["problem_reasons"][-1] == (
        "Incomplete track order: Disc 1 missing 97 tracks: 2-98"
    )
    assert "range(" not in inspect.getsource(projection._ProblematicItemReducer)


def test_incremental_sparse_gaps_match_one_canonical_eager_reason():
    from music_app.services import problematic_files_projection as projection

    rows = [
        _row(
            year=1988,
            title=f"Track {number}",
            path=rf"D:\Music\First\{number:02d}.flac",
            track_number=number,
        )
        for number in (1, 3, 5)
    ]
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(enumerate(rows, 1)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    eager = projection.project_problematic_files(rows)
    incremental = list(accumulator.finalize(facts))

    expected = ["Incomplete track order: Disc 1 missing 2, 4"]
    assert [
        reason
        for reason in incremental[0]["problem_reasons"]
        if reason.startswith("Incomplete track order:")
    ] == expected
    assert [
        reason
        for reason in eager[0]["problem_reasons"]
        if reason.startswith("Incomplete track order:")
    ] == expected


@pytest.mark.parametrize(
    ("last_track_number", "expected_issue", "expected_reason"),
    (
        (
            12,
            {
                "disc_number": 1,
                "missing_track_ranges": ((2, 11),),
                "missing_track_count": 10,
            },
            "Incomplete track order: Disc 1 missing 10 tracks: 2-11",
        ),
        (
            13,
            {
                "disc_number": 1,
                "missing_track_ranges": ((2, 12),),
                "missing_track_count": 11,
            },
            "Incomplete track order: Disc 1 missing 11 tracks: 2-12",
        ),
    ),
)
def test_track_order_gap_encoding_compacts_contiguous_runs_of_three_or_more(
    monkeypatch,
    last_track_number,
    expected_issue,
    expected_reason,
):
    from music_app.services import problematic_files_projection as projection

    rows = [
        _row(
            year=1988,
            title=f"Track {track_number}",
            path=rf"D:\Music\First\{track_number:02d}.flac",
            track_number=track_number,
        )
        for track_number in (1, last_track_number)
    ]
    album = {
        "tracks": [
            {
                "path": row["file_entry"]["path"],
                "track_number": row["track_number"],
                "disc_number": row["disc_number"],
            }
            for row in rows
        ],
        "_file_entries": [row["file_entry"] for row in rows],
    }

    assert projection._track_order_issues(album) == [expected_issue]
    eager_reasons = [
        reason
        for reason in projection.project_problematic_files(rows)[0]["problem_reasons"]
        if reason.startswith("Incomplete track order:")
    ]

    captured_durable_issues = []
    original_reason = projection._track_order_issue_reason

    def capture_durable_issue(issue):
        captured_durable_issues.append(dict(issue))
        return original_reason(issue)

    monkeypatch.setattr(projection, "_track_order_issue_reason", capture_durable_issue)
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(enumerate(rows, 1)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )
    durable_reasons = [
        reason
        for reason in list(accumulator.finalize(facts))[0]["problem_reasons"]
        if reason.startswith("Incomplete track order:")
    ]

    assert captured_durable_issues == [expected_issue]
    assert eager_reasons == durable_reasons == [expected_reason]


def test_dynamic_reason_facts_keep_exact_display_and_canonical_category_identity():
    from music_app.services import problematic_files_projection as projection

    rows = [
        _row(
            year=1988,
            title=f"Track {number}",
            path=rf"D:\Music\First\{number:02d}.flac",
            track_number=number,
        )
        for number in (1, 3, 12)
    ]
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(enumerate(rows, 1)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )
    item = list(accumulator.finalize(facts))[0]
    incomplete = [
        fact for fact in item.reason_facts
        if fact.display_reason.startswith("Incomplete track order:")
    ]

    assert [fact.display_reason for fact in incomplete] == [
        "Incomplete track order: Disc 1 missing 2, 8 tracks: 4-11"
    ]
    assert {fact.category_reason for fact in incomplete} == {
        "Incomplete track order"
    }


@pytest.mark.parametrize(
    ("track_number", "expected_problem"),
    (
        (None, "Missing track number"),
        ("", "Missing track number"),
        ("   ", "Missing track number"),
        (99, None),
        (100, "Invalid track number"),
        (10**12, "Invalid track number"),
        (True, "Invalid track number"),
        (False, "Invalid track number"),
        (1.5, "Invalid track number"),
        (-1.5, "Invalid track number"),
    ),
)
def test_track_number_problem_uses_the_owner_approved_boundary(
    track_number,
    expected_problem,
):
    from music_app.services import problematic_files_projection as projection

    assert projection._track_number_problem(track_number) == expected_problem


@pytest.mark.parametrize("track_number", (float("inf"), float("-inf"), float("nan")))
def test_non_finite_track_number_is_invalid_without_crashing_order_projection(
    track_number,
):
    from music_app.services import problematic_files_projection as projection

    row = _row(
        year=1988,
        title="Non-finite",
        path=r"D:\Music\First\non-finite.flac",
        track_number=track_number,
    )

    reasons = projection.project_problematic_files((row,))[0]["problem_reasons"]

    assert "Invalid track number" in reasons
    assert not any(
        reason.startswith("Incomplete track order:") for reason in reasons
    )


@pytest.mark.parametrize("track_number", (True, False, 1.5, -1.5))
def test_non_integral_track_number_is_invalid_with_eager_durable_parity(
    track_number,
):
    from music_app.services import problematic_files_projection as projection

    row = _row(
        year=1988,
        title="Non-integral",
        path=r"D:\Music\First\non-integral.flac",
        track_number=track_number,
    )
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(((1, row),)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    eager = projection.project_problematic_files((row,))[0]
    durable = list(accumulator.finalize(facts))[0]

    for item in (eager, durable):
        assert "Invalid track number" in item["problem_reasons"]
        assert not any(
            reason.startswith("Incomplete track order:")
            for reason in item["problem_reasons"]
        )
    assert eager["problem_reasons"] == durable["problem_reasons"]


def test_invalid_late_track_is_not_skipped_or_expanded_as_missing_order():
    from music_app.services import problematic_files_projection as projection

    rows = [
        _row(
            year=1988,
            title="First",
            path=r"D:\Music\First\01.flac",
            track_number=1,
        ),
        _row(
            year=1988,
            title="Invalid",
            path=r"D:\Music\First\100.flac",
            track_number=100,
        ),
    ]
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(enumerate(rows, 1)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    eager = projection.project_problematic_files(rows)[0]
    incremental = list(accumulator.finalize(facts))[0]

    for item in (eager, incremental):
        assert "Invalid track number" in item["problem_reasons"]
        assert not any(
            reason.startswith("Incomplete track order:")
            for reason in item["problem_reasons"]
        )


def test_explicit_invalid_track_number_does_not_fall_back_to_filename_order():
    from music_app.services import problematic_files_projection as projection

    row = _row(
        year=1988,
        title="Invalid explicit number",
        path=r"D:\Music\First\99.flac",
        track_number=100,
    )
    row["track_number"] = 100
    row["file_entry"]["track_number"] = 100
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(((1, row),)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    eager = projection.project_problematic_files((row,))[0]
    durable = list(accumulator.finalize(facts))[0]

    for item in (eager, durable):
        assert "Invalid track number" in item["problem_reasons"]
        assert not any(
            reason.startswith("Incomplete track order:")
            for reason in item["problem_reasons"]
        )
    assert eager["problem_reasons"] == durable["problem_reasons"]


def test_missing_track_numbers_use_filename_order_with_eager_durable_parity():
    from music_app.services import problematic_files_projection as projection

    first = _row(
        year=1988,
        title="Missing explicit number",
        path=r"D:\Music\First\01.flac",
        track_number=None,
    )
    third = _row(
        year=1988,
        title="Blank explicit number",
        path=r"D:\Music\First\03.flac",
        track_number=None,
    )
    third["track_number"] = ""
    third["file_entry"]["track_number"] = ""
    rows = (first, third)
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(enumerate(rows, 1)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    eager = projection.project_problematic_files(rows)[0]
    durable = list(accumulator.finalize(facts))[0]

    for item in (eager, durable):
        assert "Incomplete track order: Disc 1 missing 2" in item["problem_reasons"]
    assert eager["problem_reasons"] == durable["problem_reasons"]


def test_canonical_track_number_wins_over_conflicting_raw_payload():
    from music_app.services import problematic_files_projection as projection

    first = _row(
        year=1988,
        title="First",
        path=r"D:\Music\First\01.flac",
        track_number=1,
    )
    conflict = _row(
        year=1988,
        title="Normalized third",
        path=r"D:\Music\First\03.flac",
        track_number=2,
    )
    conflict["file_entry"] = {
        **conflict["file_entry"],
        "track_number": 3,
    }
    rows = (first, conflict)
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(enumerate(rows, 1)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    eager = projection.project_problematic_files(rows)[0]
    durable = list(accumulator.finalize(facts))[0]
    for item in (eager, durable):
        assert not any(
            reason.startswith("Incomplete track order:")
            for reason in item["problem_reasons"]
        )
    assert eager["problem_reasons"] == durable["problem_reasons"]


def test_invalid_raw_track_number_is_reported_without_overriding_canonical_order():
    from music_app.services import problematic_files_projection as projection

    first = _row(
        year=1988,
        title="First",
        path=r"D:\Music\First\01.flac",
        track_number=1,
    )
    second = _row(
        year=1988,
        title="Second",
        path=r"D:\Music\First\02.flac",
        track_number=2,
    )
    second["file_entry"] = {**second["file_entry"], "track_number": 100}

    item = projection.project_problematic_files((first, second))[0]

    assert "Invalid track number" in item["problem_reasons"]
    assert not any(
        reason.startswith("Incomplete track order:")
        for reason in item["problem_reasons"]
    )


def test_projected_track_disc_number_wins_over_conflicting_file_entry_disc():
    from music_app.services import problematic_files_projection as projection

    first = _row(
        year=1988,
        title="Disc 1 Track 1",
        path=r"D:\Music\First\Disc 1\01.flac",
        track_number=1,
    )
    third = _row(
        year=1988,
        title="Disc 1 Track 3",
        path=r"D:\Music\First\Disc 1\03.flac",
        track_number=3,
    )
    third["disc_number"] = 1
    third["file_entry"] = {
        **third["file_entry"],
        "disc_number": 2,
    }
    rows = (first, third)
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(enumerate(rows, 1)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    eager = projection.project_problematic_files(rows)[0]
    durable = list(accumulator.finalize(facts))[0]
    expected_reasons = ["Incomplete track order: Disc 1 missing 2"]

    for item in (eager, durable):
        order_reasons = [
            reason
            for reason in item["problem_reasons"]
            if reason.startswith("Incomplete track order:")
        ]
        assert order_reasons == expected_reasons
    assert eager["problem_reasons"] == durable["problem_reasons"]


def test_track_order_gaps_are_inferred_independently_per_disc():
    from music_app.services import problematic_files_projection as projection

    rows = [
        _row(
            year=1988,
            title=f"Disc {disc} Track {number}",
            path=rf"D:\Music\First\Disc {disc}\{number:02d}.flac",
            track_number=number,
        )
        for disc, number in ((1, 1), (1, 3), (2, 1), (2, 2))
    ]
    for row, (disc, _number) in zip(rows, ((1, 1), (1, 3), (2, 1), (2, 2))):
        row["disc_number"] = disc
        row["file_entry"]["disc_number"] = disc

    eager_reasons = projection.project_problematic_files(rows)[0]["problem_reasons"]
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(enumerate(rows, 1)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )
    incremental_reasons = list(accumulator.finalize(facts))[0]["problem_reasons"]

    for reasons in (eager_reasons, incremental_reasons):
        assert "Incomplete track order: Disc 1 missing 2" in reasons
        assert not any("Disc 2 missing" in reason for reason in reasons)


def test_incremental_finalizer_emits_the_persisted_item_contract():
    from music_app.services import problematic_files_projection as projection

    row = _row(
        year=1988,
        title="First",
        path=r"D:\Music\First\01.flac",
        track_number=1,
    )
    accumulator = projection.ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(((1, row),)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    item = list(accumulator.finalize(facts))[0]

    assert item["item_key"]
    assert item["sort_title"]
    assert item["sort_artist"]
    assert item["sort_year"] == "1988"
    assert item["sort_album_key"]
    assert item["search_text"]
    assert item["reasons"] == item["summary"]["problem_reasons"]
    assert item["summary"]["projection_id"]


def test_incremental_companion_fact_matches_duplicate_projection_parity():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        project_problematic_files,
    )

    row = _row(
        year=1988,
        title="Duplicate",
        path=r"D:\Music\First\01.flac",
        track_number=1,
    )
    expected_row = deepcopy(row)
    expected_row["duplicate_candidate"] = True
    expected_companion = deepcopy(expected_row)
    expected_companion.update(
        album_id=72,
        album_key="companion",
        track_key="companion-track",
        file_private_path=r"E:\Music\First\01.flac",
        separate_release_keys=[],
    )
    expected_companion["file_entry"] = {
        **expected_companion["file_entry"],
        "path": expected_companion["file_private_path"],
    }
    companion = dict(row)
    companion.update(
        source_child_kind="duplicate_companion",
        companion_file_id=202,
        companion_private_path=r"E:\Music\First\01.flac",
        companion_library_root_id=9,
        companion_root_category="main",
    )
    accumulator = ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(((1, row), (2, companion))),
        key=lambda fact: (
            str(fact[2].get("projection_id") or ""),
            fact[1],
            str(fact[2].get("semantic_child_identity") or ""),
        ),
    )

    actual = list(accumulator.finalize(facts))[0]
    expected = [
        item
        for item in project_problematic_files((expected_row, expected_companion))
        if item["key"] == actual["key"]
    ][0]
    actual_topology = {
        field: actual["summary"].pop(field)
        for field in (
            "duplicate_companion_count",
            "duplicate_sources",
            "root_provenance",
            "duplicate_topology",
        )
    }
    expected.pop("duplicate_sources", None)
    expected.pop("root_provenance", None)

    _persisted_summary_contract(actual, expected)
    assert actual_topology["duplicate_companion_count"] == 1
    assert actual_topology["duplicate_topology"]["companion_count"] == 1
    assert actual_topology["duplicate_sources"]


def test_incremental_duplicate_candidate_remains_provisional_without_companion():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    row = _row(
        year=1988,
        title="Candidate only",
        path=r"D:\Music\Candidate\01.flac",
        track_number=1,
    )
    row["duplicate_candidate"] = True
    accumulator = ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(((1, row),)),
        key=lambda fact: (
            str(fact[2].get("projection_id") or ""),
            fact[1],
            str(fact[2].get("semantic_child_identity") or ""),
        ),
    )

    item = list(accumulator.finalize(facts))[0]

    assert "Duplicate files" not in item["reasons"]


def test_incremental_duplicate_track_keys_are_adjacent_and_detected():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    first = _row(
        year=1988,
        title="First copy",
        path=r"D:\Music\Duplicate\01.flac",
        track_number=None,
    )
    second = deepcopy(first)
    second.update(
        track_id=2,
        track_key=" track-1988 ",
        track_title="Second copy",
        file_private_path=r"E:\Music\Duplicate\01.flac",
        source_child_identity="2",
    )
    second["file_entry"] = {
        **second["file_entry"],
        "path": second["file_private_path"],
        "title": second["track_title"],
    }
    first["source_child_identity"] = "1"
    accumulator = ProblematicGroupAccumulator()

    facts = _persist_semantic_facts(accumulator, enumerate((first, second), 1))
    track_key_facts = [fact for fact in facts if fact[1] == "track_key"]
    item = list(accumulator.finalize(facts))[0]

    assert len(track_key_facts) == 2
    assert track_key_facts[0][2]["semantic_child_identity"] != track_key_facts[1][2][
        "semantic_child_identity"
    ]
    assert track_key_facts[0][2]["semantic_child_identity"].split(":", 1)[0] == (
        track_key_facts[1][2]["semantic_child_identity"].split(":", 1)[0]
    )
    assert {
        fact[2]["grouped_track_identity"] for fact in track_key_facts
    } == {"track-1988"}
    assert "Duplicate files" in item["reasons"]
    assert "duplicate_topology" not in item["summary"]


def test_incremental_empty_track_keys_do_not_create_duplicate_facts():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    rows = [
        _row(
            year=1988,
            title=f"Track {index}",
            path=rf"D:\Music\Empty\0{index}.flac",
            track_number=None,
        )
        for index in (1, 2)
    ]
    rows[0]["track_key"] = ""
    rows[1]["track_key"] = "   "
    accumulator = ProblematicGroupAccumulator()

    facts = _persist_semantic_facts(accumulator, enumerate(rows, 1))
    item = list(accumulator.finalize(facts))[0]

    assert all(fact_kind != "track_key" for _stage_id, fact_kind, _fact in facts)
    assert "Duplicate files" not in item["reasons"]


def test_incremental_companion_fact_retains_topology_and_root_provenance():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    row = _row(
        year=1988,
        title="Duplicate",
        path=r"D:\Music\First\01.flac",
        track_number=1,
    )
    companion = dict(row)
    companion.update(
        source_child_kind="duplicate_companion",
        companion_file_id=202,
        companion_private_path=r"E:\Music\First\01.flac",
        companion_library_root_id=9,
        companion_root_category="archive",
    )

    companion_fact = next(
        fact
        for fact in ProblematicGroupAccumulator().consume(((1, companion),))
        if fact[1] == "duplicate_companion"
    )

    assert companion_fact[2]["companion_file_id"] == 202
    assert companion_fact[2]["companion_private_path"] == r"E:\Music\First\01.flac"
    assert companion_fact[2]["companion_library_root_id"] == 9
    assert companion_fact[2]["companion_root_category"] == "archive"


def test_incremental_finalized_item_retains_bounded_duplicate_topology():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    row = _row(
        year=1988,
        title="Duplicate",
        path=r"D:\Music\First\01.flac",
        track_number=1,
    )
    row.update(file_library_root_id=3, file_library_root_category="main")
    companions = []
    for stage_id, file_id, root_id, category in (
        (2, 202, 9, "archive"),
        (3, 203, 12, "main"),
    ):
        companions.append(
            (
                stage_id,
                {
                    **row,
                    "source_child_kind": "duplicate_companion",
                    "companion_file_id": file_id,
                    "companion_private_path": rf"E:\Music\First\{file_id}.flac",
                    "companion_library_root_id": root_id,
                    "companion_root_category": category,
                },
            )
        )
    accumulator = ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(((1, row), *companions)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    summary = list(accumulator.finalize(facts))[0]["summary"]

    assert summary["duplicate_companion_count"] == 2
    assert summary["root_provenance"]["root_ids"] == ["3", "9", "12"]
    assert summary["duplicate_sources"]
    assert len(summary["duplicate_sources"]) <= 3


def test_incremental_projection_matches_cross_row_reasons_and_interleaved_identities():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        project_problematic_files,
    )

    def album_row(
        *, album_id, album_key, year, title, path, track_number, cover_path=None,
        split_release=False,
    ):
        row = _row(
            year=year,
            title=title,
            path=path,
            track_number=track_number,
        )
        row.update(
            album_id=album_id,
            album_key=album_key,
            album_release_year=1988,
            album_cover_path=cover_path,
        )
        if not split_release:
            row["separate_release_keys"] = []
        return row

    first_rows = [
        album_row(
            album_id=71,
            album_key="first",
            year=1988,
            title="First one",
            path=r"D:\Music\First\01.flac",
            track_number=1,
            split_release=True,
        ),
        album_row(
            album_id=71,
            album_key="first",
            year=1999,
            title="First one 1999",
            path=r"D:\Music\First\1999-01.flac",
            track_number=1,
            split_release=True,
        ),
        album_row(
            album_id=71,
            album_key="first",
            year=1999,
            title="First three",
            path=r"D:\Music\First\03.flac",
            track_number=3,
            split_release=True,
        ),
        album_row(
            album_id=71,
            album_key="first",
            year=1999,
            title="First duplicate three",
            path=r"D:\Music\First\03-copy.flac",
            track_number=3,
            split_release=True,
        ),
    ]
    second_rows = [
        album_row(
            album_id=72,
            album_key="second",
            year=1988,
            title="Second one",
            path=r"D:\Music\Second\01.flac",
            track_number=1,
            cover_path=r"D:\Music\Second\cover.jpg",
        ),
        album_row(
            album_id=72,
            album_key="second",
            year=1988,
            title="",
            path=r"D:\Music\Second\02.flac",
            track_number=2,
            cover_path=r"D:\Music\Second\cover.jpg",
        ),
    ]
    loose = album_row(
        album_id=None,
        album_key="loose-source::orphan",
        year=1988,
        title="",
        path=r"D:\Music\Loose\orphan.flac",
        track_number=None,
    )
    loose.update(
        album_title="Loose files",
        album_release_year=None,
        local_album_membership_problem="Outside album folder",
    )
    loose["file_entry"]["local_album_membership_problem"] = (
        "Outside album folder"
    )
    loose["file_entry"]["album"] = "Loose files"
    first_rows[2]["file_entry"]["album"] = "Different album"
    rows = [
        first_rows[0],
        second_rows[0],
        loose,
        first_rows[1],
        second_rows[1],
        first_rows[2],
        first_rows[3],
    ]

    expected = project_problematic_files(rows)
    expected_by_key = {item["key"]: item for item in expected}
    assert len(expected_by_key) == 4
    split_1988 = next(
        item for item in expected if item["key"].endswith("::year::1988")
    )
    split_1999 = next(
        item for item in expected if item["key"].endswith("::year::1999")
    )
    assert split_1988["track_count"] == 1
    assert split_1999["track_count"] == 3
    assert "Incomplete track order: Disc 1 missing 2" in split_1999[
        "problem_reasons"
    ]
    assert "Album name mismatch" in split_1999["problem_reasons"]
    assert expected_by_key["second"]["track_count"] == 2
    assert "Missing track title" in expected_by_key["second"]["problem_reasons"]
    loose_expected = next(
        item for key, item in expected_by_key.items() if key.startswith("loose-source::")
    )
    assert "Duplicate files" not in loose_expected["problem_reasons"]

    accumulator = ProblematicGroupAccumulator()
    facts = _persist_semantic_facts(accumulator, enumerate(rows, 1))
    projection_ids = [str(payload.get("projection_id") or "") for _, _, payload in facts]
    actual = list(accumulator.finalize(facts))

    assert all(projection_ids)
    assert len(set(projection_ids)) == 4
    assert {item["key"] for item in actual} == set(expected_by_key)
    for item in actual:
        _persisted_summary_contract(item, expected_by_key[item["key"]])


def test_incremental_reducer_does_not_infer_gap_from_later_problem_row():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        project_problematic_files,
    )

    rows = [
        _row(
            year=1988,
            title="Healthy first",
            path=r"D:\Music\Second\01.flac",
            track_number=1,
        ),
        _row(
            year=1988,
            title="",
            path=r"D:\Music\Second\02.flac",
            track_number=2,
        ),
    ]
    for index, row in enumerate(rows, 1):
        row.update(
            album_id=72,
            album_key="second",
            track_key=f"second-track-{index}",
            album_cover_path=r"D:\Music\Second\cover.jpg",
            separate_release_keys=[],
        )

    expected = project_problematic_files(rows)
    accumulator = ProblematicGroupAccumulator()
    facts = _persist_semantic_facts(accumulator, enumerate(rows, 1))
    actual = list(accumulator.finalize(facts))

    assert len(actual) == 1
    _persisted_summary_contract(actual[0], expected[0])
    assert actual[0]["track_count"] == 2
    assert "Missing track title" in actual[0]["problem_reasons"]
    assert not any(
        reason.startswith("Incomplete track order:")
        for reason in actual[0]["problem_reasons"]
    )


def test_incremental_projection_keeps_search_facts_outside_bounded_summary():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        project_problematic_files,
    )

    row = _row(
        year=1988,
        title="Compatibility title",
        path=r"D:\Music\Compatibility\01.flac",
        track_number=1,
    )
    legacy = project_problematic_files([row])[0]
    assert legacy["file_types"] == ["FLAC"]
    assert legacy["search_text"] == "Compatibility title"
    assert legacy["track_paths"] == [r"D:\Music\Compatibility\01.flac"]

    accumulator = ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume([(1, row)]),
        key=lambda fact: (
            str(fact[2].get("projection_id") or ""),
            fact[1],
            str(fact[2].get("semantic_child_identity") or ""),
        ),
    )
    incremental = list(accumulator.finalize(facts))[0]
    assert "file_types" not in incremental
    assert "track_paths" not in incremental
    assert "search_text" not in incremental["summary"]
    assert "track_paths" not in incremental["summary"]
    for field in (
        "search_fact_count",
        "search_fact_digest",
        "search_facts_truncated",
        "track_path_fact_count",
        "track_path_fact_digest",
        "track_path_facts_truncated",
        "search_document_count",
        "search_document_digest",
        "search_document_truncated",
    ):
        assert field in incremental
        assert field not in incremental["summary"]
    assert "compatibility title" in incremental["search_text"]
    assert r"d:\music\compatibility\01.flac" in incremental["search_text"]

    missing = dict(row)
    missing.update(
        album_id=None,
        album_key="missing-album::71",
        inventory_status="missing",
        missing_since="2026-10-01T00:00:00Z",
        file_private_path="",
    )
    missing_summary = project_problematic_files([missing])[0]
    assert missing_summary["track_paths"] == []


def test_incremental_projection_emits_exact_normalized_relational_search_facts():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    first = _row(
        year=1988,
        title="Café opener",
        path=r"D:\Music\Café\01.flac",
    )
    equivalent = _row(
        year=1988,
        title="Cafe\u0301 opener",
        path="D:\\Music\\Cafe\u0301\\01.flac",
    )
    equivalent.update(track_id=2, track_key="track-2")
    tail = _row(
        year=1988,
        title="Needle tail title",
        path=r"D:\Music\Needle\99.flac",
    )
    tail.update(track_id=99, track_key="track-99")

    facts = list(
        ProblematicGroupAccumulator().consume(
            enumerate((first, equivalent, tail), 1)
        )
    )
    raw_facts = [
        (kind, payload)
        for _stage_id, kind, payload in facts
        if kind in {"track_title", "private_path"}
    ]

    search_facts = [
        (kind, payload)
        for _stage_id, kind, payload in facts
        if kind in {"track_title_search", "private_path_search"}
    ]

    assert len(raw_facts) == 6
    assert len(search_facts) == 6
    assert all("normalized_text" not in payload for _, payload in raw_facts)
    for kind, payload in search_facts:
        assert payload["normalized_text"]
        assert len(payload["normalized_text"].encode("utf-8")) <= 32_768
        assert payload["semantic_child_identity"]
        assert kind in {"track_title_search", "private_path_search"}
    title_facts = [
        payload for kind, payload in search_facts if kind == "track_title_search"
    ]
    path_facts = [
        payload for kind, payload in search_facts if kind == "private_path_search"
    ]
    assert title_facts[0]["normalized_text"] == "café opener"
    assert title_facts[1]["normalized_text"] == "café opener"
    assert title_facts[0]["semantic_child_identity"] == title_facts[1][
        "semantic_child_identity"
    ]
    assert path_facts[0]["normalized_text"] == r"d:\music\café\01.flac"
    assert path_facts[1]["normalized_text"] == r"d:\music\café\01.flac"
    assert path_facts[0]["semantic_child_identity"] == path_facts[1][
        "semantic_child_identity"
    ]
    assert title_facts[-1]["normalized_text"] == "needle tail title"
    assert path_facts[-1]["normalized_text"] == r"d:\music\needle\99.flac"


def test_incremental_projection_chunks_nfkc_expansion_without_duplicating_raw_text():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        normalize_problematic_text,
    )

    raw_title = "START-" + ("\ufdfa" * 2000) + "-TAIL"
    row = _row(
        year=1988,
        title=raw_title,
        path="C:\\" + ("\ufdfa" * 2000) + "\\TAIL.flac",
    )

    facts = list(ProblematicGroupAccumulator().consume([(1, row)]))
    title_fact = next(payload for _, kind, payload in facts if kind == "track_title")
    path_fact = next(payload for _, kind, payload in facts if kind == "private_path")
    title_chunks = [
        payload["normalized_text"]
        for _, kind, payload in facts
        if kind == "track_title_search"
    ]
    path_chunks = [
        payload["normalized_text"]
        for _, kind, payload in facts
        if kind == "private_path_search"
    ]

    assert title_fact == {
        "title": raw_title,
        "projection_id": title_fact["projection_id"],
        "semantic_child_identity": title_fact["semantic_child_identity"],
    }
    assert path_fact == {
        "path": row["file_private_path"],
        "projection_id": path_fact["projection_id"],
        "semantic_child_identity": path_fact["semantic_child_identity"],
    }
    assert len(title_chunks) > 1
    assert len(path_chunks) > 1
    assert all(0 < len(chunk.encode("utf-8")) <= 32_768 for chunk in title_chunks)
    assert all(0 < len(chunk.encode("utf-8")) <= 32_768 for chunk in path_chunks)
    assert all(
        len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) <= 65_536
        for _, _, payload in facts
    )

    normalized_title = normalize_problematic_text(raw_title)
    normalized_title_bytes = normalized_title.encode("utf-8")
    first_boundary = len(title_chunks[0].encode("utf-8"))
    start_query = normalized_title_bytes[:4096].decode("utf-8", errors="ignore")
    crossing_query = normalized_title_bytes[
        first_boundary - 2048 : first_boundary + 2048
    ].decode("utf-8", errors="ignore")
    tail_query = normalized_title_bytes[-4096:].decode("utf-8", errors="ignore")
    title_queries = (start_query, crossing_query, tail_query)
    assert all(len(query.encode("utf-8")) <= 4096 for query in title_queries)
    assert all(any(query in chunk for chunk in title_chunks) for query in title_queries)
    assert all(raw_title not in chunk for chunk in title_chunks)

    normalized_path = normalize_problematic_text(row["file_private_path"])
    normalized_path_bytes = normalized_path.encode("utf-8")
    path_boundary = len(path_chunks[0].encode("utf-8"))
    path_queries = (
        normalized_path_bytes[:4096].decode("utf-8", errors="ignore"),
        normalized_path_bytes[
            path_boundary - 2048 : path_boundary + 2048
        ].decode("utf-8", errors="ignore"),
        normalized_path_bytes[-4096:].decode("utf-8", errors="ignore"),
    )
    assert all(len(query.encode("utf-8")) <= 4096 for query in path_queries)
    assert all(any(query in chunk for chunk in path_chunks) for query in path_queries)
    assert all(row["file_private_path"] not in chunk for chunk in path_chunks)


def test_incremental_projection_chunks_cover_complete_album_search_fields():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        normalize_problematic_text,
    )

    row = _row(year=1988, title="Track", path=r"C:\Album\01.flac")
    raw_title = "ALBUM-START-" + ("\ufdfa" * 2_000) + "-ALBUM-TAIL"
    raw_artist = "ARTIST-START-" + ("\ufdfa" * 2_000) + "-ARTIST-TAIL"
    raw_key = "KEY-START-" + ("\ufdfa" * 2_000) + "-KEY-TAIL"
    row.update(
        album_title=raw_title,
        album_key=raw_key,
        artist_name=raw_artist,
        album_metadata={"album_artist": raw_artist},
    )
    row["file_entry"] = {
        **row["file_entry"],
        "album": raw_title,
        "album_artist": raw_artist,
    }

    facts = list(ProblematicGroupAccumulator().consume([(1, row)]))

    for fact_kind, raw_value in (
        ("album_title_search", raw_title),
        ("album_artist_search", raw_artist),
        ("album_key_search", raw_key),
    ):
        chunks = [
            payload["normalized_text"]
            for _, kind, payload in facts
            if kind == fact_kind
        ]
        normalized = normalize_problematic_text(raw_value)
        assert len(chunks) > 1
        assert all(0 < len(chunk.encode("utf-8")) <= 32768 for chunk in chunks)
        assert normalized[:64] in chunks[0]
        assert normalized[-64:] in chunks[-1]
        boundary = len(chunks[0].encode("utf-8"))
        boundary_query = normalized.encode("utf-8")[
            boundary - 2_048 : boundary + 2_048
        ].decode("utf-8")
        assert any(boundary_query in chunk for chunk in chunks)


def test_incremental_search_chunks_are_deterministic_across_replay():
    from music_app.services.problematic_files_projection import ProblematicGroupAccumulator

    row = _row(
        year=1988,
        title="Replay-" + ("\ufdfa" * 2000) + "-Tail",
        path="C:\\Replay\\" + ("\ufdfa" * 2000) + "\\Tail.flac",
    )

    once = _persist_semantic_facts(ProblematicGroupAccumulator(), [(1, row)])
    replayed = _persist_semantic_facts(ProblematicGroupAccumulator(), [(1, row)])

    assert replayed == once


def test_duplicate_root_topology_deduplicates_beyond_the_retained_sample():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    row = _row(
        year=1988,
        title="Duplicate",
        path=r"D:\Music\First\01.flac",
        track_number=1,
    )
    row.update(file_library_root_id=100, file_library_root_category="main")
    companions = []
    for stage_id, root_id in enumerate((*range(1, 18), 17), 2):
        companions.append(
            (
                stage_id,
                {
                    **row,
                    "source_child_kind": "duplicate_companion",
                    "companion_file_id": 200 + stage_id,
                    "companion_private_path": rf"E:\Music\First\{stage_id}.flac",
                    "companion_library_root_id": root_id,
                    "companion_root_category": "main",
                },
            )
        )
    accumulator = ProblematicGroupAccumulator()
    raw_facts = list(accumulator.consume(((1, row), *companions)))
    root_facts = [fact for fact in raw_facts if fact[1] == "duplicate_root"]

    assert len({fact[2]["semantic_child_identity"] for fact in root_facts}) == 18

    persisted_accumulator = ProblematicGroupAccumulator()
    facts = _persist_semantic_facts(
        persisted_accumulator,
        ((1, row), *companions),
    )
    summary = list(persisted_accumulator.finalize(facts))[0]["summary"]

    assert summary["duplicate_topology"]["root_count"] == 18


def test_incremental_reducer_preserves_later_ordinary_row_reasons_in_order():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        project_problematic_files,
    )

    rows = [
        _row(
            year=1988,
            title="First",
            path=r"D:\Music\Parity\01.flac",
            track_number=1,
        ),
        _row(
            year=1988,
            title="Second",
            path=r"D:\Music\Parity\02.flac",
            track_number=2,
        ),
        _row(
            year=1988,
            title="ÐŸÐµÑÐ½Ñ",
            path=r"D:\Music\Parity\03.flac",
            track_number=3,
        ),
    ]
    for index, row in enumerate(rows, 1):
        row.update(
            album_id=88,
            album_key="reason-parity",
            track_key=f"reason-track-{index}",
            separate_release_keys=[],
        )
    rows[1].update(
        file_size=0,
        file_mixed_album_folder=True,
        local_album_membership_problem="Outside album folder",
    )
    rows[1]["file_entry"]["album"] = "Different album"
    rows[1]["file_entry"]["year"] = "not-a-year"
    rows[2]["file_text_mojibake_candidate"] = True

    expected = project_problematic_files(rows)
    expected_reasons = expected[0]["problem_reasons"]
    for reason in (
        "Empty audio file",
        "Mixed album metadata in one folder",
        "Outside album folder",
        "Album name mismatch",
    ):
        assert reason in expected_reasons
    assert any("encoding" in reason.casefold() for reason in expected_reasons)

    accumulator = ProblematicGroupAccumulator()
    facts = _persist_semantic_facts(accumulator, enumerate(rows, 1))
    actual = list(accumulator.finalize(facts))
    _persisted_summary_contract(actual[0], expected[0])


def test_projection_id_normalizes_unknown_split_year_case():
    import base64
    import json

    from music_app.services.problematic_files_projection import problematic_projection_id

    upper = _row(
        year="UNKNOWN",
        title="Upper",
        path=r"D:\Music\Unknown\upper.flac",
        track_number=1,
    )
    lower = _row(
        year="unknown",
        title="Lower",
        path=r"D:\Music\Unknown\lower.flac",
        track_number=2,
    )
    upper_id = problematic_projection_id(upper)
    lower_id = problematic_projection_id(lower)

    assert upper_id == lower_id
    padded = upper_id + ("=" * (-len(upper_id) % 4))
    assert json.loads(base64.urlsafe_b64decode(padded)) == [
        1,
        "album",
        71,
        "unknown",
    ]


def test_split_release_unknown_year_has_stable_normalized_identity():
    from music_app.services import library_browse_postgres as production
    from music_app.services.problematic_files_projection import project_problematic_albums

    row = _row(
        year="UNKNOWN",
        title="Неизвестный год",
        path=r"D:\Музыка\ДДТ\Студийные записи\UNKNOWN\01.flac",
    )
    expected_key = "ддт::студийные записи::deluxe::year::unknown"

    owner_album = project_problematic_albums([row])[0]
    production_album = production._problematic_album_projection_payloads([row])[0]

    assert owner_album["key"] == expected_key
    assert owner_album["album_ref"] == expected_key
    assert owner_album["year"] == "UNKNOWN"
    assert production_album["key"] == expected_key
    assert production_album["album_ref"] == expected_key
    assert production_album["year"] == "UNKNOWN"


def test_pure_projector_filter_facets_and_stable_sort_fields():
    from music_app.services.problematic_files_projection import (
        problematic_filter_matches,
        normalized_problematic_search_text,
        problematic_reason_facets,
        problematic_sort_key,
        project_problematic_files,
    )

    items = project_problematic_files([
        _row(
            year=1999,
            title="Последняя осень",
            path=r"D:\Музыка\ДДТ\Студийные записи\1999\01.flac",
        ),
        _row(
            year=1988,
            title="Что такое осень",
            path=r"D:\Музыка\ДДТ\Студийные записи\1988\01.flac",
        ),
    ])

    assert [problematic_sort_key(item, album_id=71) for item in items] == [
        (
            "студийные записи",
            "ддт",
            "1988",
            "ддт::студийные записи::deluxe::year::1988",
            71,
        ),
        (
            "студийные записи",
            "ддт",
            "1999",
            "ддт::студийные записи::deluxe::year::1999",
            71,
        ),
    ]
    assert problematic_filter_matches(items[0], "что такое осень")
    assert not problematic_filter_matches(items[0], "последняя осень")
    assert "что такое осень" in normalized_problematic_search_text(items[0])
    assert "ддт" in normalized_problematic_search_text(items[0])
    assert problematic_reason_facets(items) == [
        {"reason": "Missing cover art", "count": 2},
    ]


def test_pure_projector_has_no_database_route_or_process_global_dependency():
    from music_app.services import problematic_files_projection as projection

    source = inspect.getsource(projection)
    forbidden = (
        "library_browse_postgres",
        "psycopg",
        "music_app.routes",
        "threading",
        "multiprocessing",
        "subprocess",
        "os.environ",
    )
    assert not [name for name in forbidden if name in source]


def test_pure_projector_matches_complete_projection_semantics():
    from music_app.services.problematic_files_projection import (
        project_problematic_albums,
        project_problematic_files,
    )

    physical = _row(
        year=1988,
        title="Песня первая",
        path=r"D:\Музыка\ДДТ\Студийные записи\1988\01.flac",
    )
    physical["file_size"] = 0
    physical["file_mixed_album_folder"] = True
    physical["album_metadata"].update({
        "remote_cover_url": "https://covers.example/album.jpg",
        "remote_cover_thumbnail_url": "https://covers.example/thumb.jpg",
        "remote_cover_source": "musicbrainz",
        "remote_cover_source_label": "MusicBrainz",
        "remote_cover_album_url": "https://musicbrainz.org/release/example",
        "remote_cover_width": 1200,
        "remote_cover_height": 1200,
    })

    ignored = _row(
        year=1999,
        title="",
        path=r"D:\Музыка\ДДТ\Студийные записи\1999\03.flac",
        track_number=3,
    )
    ignored["ignored_repair_keys"] = [f'{ignored["file_private_path"]}::title']

    overridden = _row(
        year=2001,
        title="Исключённая",
        path=r"D:\Музыка\ДДТ\Студийные записи\2001\01.flac",
    )
    overridden["file_entry"]["exception_type"] = "Non-album rarity"
    overridden["exception_override_present"] = True
    overridden["exception_type"] = ""

    excluded = _row(
        year=2002,
        title="Исключённая сканером",
        path=r"D:\Музыка\ДДТ\Студийные записи\2002\01.flac",
    )
    excluded["file_entry"]["exception_type"] = "Non-album rarity"

    duplicate = _row(
        year=2003,
        title="Дубликат",
        path=r"D:\Музыка\ДДТ\Студийные записи\2003\01.flac",
    )
    duplicate["duplicate_file_count"] = 2
    duplicate["duplicate_candidate"] = True
    duplicate_copy = deepcopy(duplicate)
    duplicate_copy["file_private_path"] = (
        r"E:\Музыка\ДДТ\Студийные записи\2003\01.flac"
    )
    duplicate_copy["file_entry"]["path"] = duplicate_copy["file_private_path"]

    rows = [physical, ignored, overridden, excluded, duplicate, duplicate_copy]
    albums_by_year = {
        album["year"]: album for album in project_problematic_albums(rows)
    }
    projected = project_problematic_files(rows)
    by_year = {item["year"]: item for item in projected}
    assert set(by_year) == {1988, 1999, 2001, 2002, 2003}
    assert albums_by_year[2001]["tracks"][0]["exception_type"] == ""
    assert albums_by_year[2002]["tracks"][0]["exception_type"] == "Non-album rarity"
    assert by_year[1988]["problem_reasons"][:3] == [
        "Missing cover art",
        "Empty audio file",
        "Mixed album metadata in one folder",
    ]
    assert by_year[1988]["remote_cover_url"] == "https://covers.example/album.jpg"
    assert by_year[1988]["remote_cover_width"] == 1200
    assert "Missing track title" not in by_year[1999]["problem_reasons"]
    assert "Duplicate files" in by_year[2003]["problem_reasons"]


def test_explicit_exception_clear_without_problem_or_repair_is_not_projected():
    from music_app.services.problematic_files_projection import (
        project_problematic_files,
    )

    healthy = _row(
        year=2004,
        title="Healthy track",
        path=r"D:\Music\Healthy\01.flac",
    )
    healthy["file_entry"]["exception_type"] = "Non-album rarity"
    healthy["album_cover_path"] = r"D:\Music\Healthy\cover.jpg"
    healthy["exception_override_present"] = True
    healthy["exception_type"] = ""

    assert project_problematic_files((healthy,)) == []


def test_summary_preserves_missing_inventory_contract():
    from music_app.services.problematic_files_projection import build_problematic_summary

    summary = build_problematic_summary(
        {
            "key": "missing-album",
            "name": "Missing Album",
            "album_artist": "Missing Artist",
            "inventory_status": "missing",
            "missing_since": "2026-10-01T00:00:00Z",
            "tracks": [{"path": r"D:\Music\missing.flac", "title": "Missing"}],
        },
        reasons=["Missing files"],
        repair_preview={"has_repairs": False},
    )

    assert summary["inventory_status"] == "missing"
    assert summary["missing_since"] == "2026-10-01T00:00:00Z"
    assert summary["track_paths"] == []
    assert summary["tracks"] == []


def test_pure_projector_matches_reason_order_and_track_order():
    from music_app.services.problematic_files_projection import project_problematic_files

    first = _row(
        year=1988,
        title="Первая",
        path=r"D:\Музыка\ДДТ\Студийные записи\1988\01.flac",
        track_number=1,
    )
    third = deepcopy(first)
    third.update({
        "track_id": 3,
        "track_key": "track-3",
        "track_title": "Третья",
        "track_number": 3,
        "file_private_path": r"D:\Музыка\ДДТ\Студийные записи\1988\03.flac",
    })
    third["file_entry"] = {
        **third["file_entry"],
        "path": third["file_private_path"],
        "title": "Третья",
        "track_number": 3,
    }

    projected = project_problematic_files([third, first])
    assert projected[0]["problem_reasons"] == [
        "Missing cover art",
        "Incomplete track order: Disc 1 missing 2",
    ]


def test_production_uses_the_pure_projector_owner():
    from music_app.services import library_browse_postgres as production
    from music_app.services import problematic_files_projection as projection

    row = _row(
        year=1988,
        title="Песня первая",
        path=r"D:\Музыка\ДДТ\Студийные записи\1988\01.flac",
    )
    expected_identity = "ддт::студийные записи::deluxe::year::1988"
    expected_reasons = ["Missing cover art"]

    owner_album = projection.project_problematic_albums([row])[0]
    production_album = production._problematic_album_projection_payloads([row])[0]
    owner_summary = projection.problematic_album_summary_payload(owner_album)
    production_summary = production._problematic_album_summary_payload(production_album)

    assert owner_album["key"] == expected_identity
    assert production_album["key"] == expected_identity
    assert owner_summary["key"] == expected_identity
    assert production_summary["key"] == expected_identity
    assert owner_summary["problem_reasons"] == expected_reasons
    assert production_summary["problem_reasons"] == expected_reasons


def test_reason_identity_codes_are_owned_by_pure_projection():
    from music_app.services import library_browse_postgres as production
    from music_app.services import problematic_files_projection as projection

    expected_codes = {
        "Empty audio file": "empty-audio-file",
        "Missing album": "missing-album",
        "Missing cover art": "missing-cover-art",
        "Poor art quality": "poor-art-quality",
        "Duplicate files": "duplicate-files",
        "Year mismatch": "year-mismatch",
        "Encoding problem": "encoding-problem",
    }

    for reason, code in expected_codes.items():
        assert projection._problem_reason_identity_code(reason) == code
        assert projection._decoded_problem_reason_identity(code) == reason
        assert production._problem_reason_identity_code(reason) == code
        assert production._decoded_problem_reason_identity(code) == reason

    assert production._PROBLEM_REASON_IDENTITY_CODES is projection._PROBLEM_REASON_IDENTITY_CODES
    assert production._PROBLEM_REASON_BY_IDENTITY_CODE is projection._PROBLEM_REASON_BY_IDENTITY_CODE


def test_unknown_reason_identity_round_trips_through_owned_codec():
    from music_app.services import library_browse_postgres as production
    from music_app.services import problematic_files_projection as projection

    reason = "Unexpected embedded cuesheet marker"
    code = projection._problem_reason_identity_code(f"  {reason}  ")

    assert code == "reason-b64-VW5leHBlY3RlZCBlbWJlZGRlZCBjdWVzaGVldCBtYXJrZXI"
    assert projection._decoded_problem_reason_identity(code) == reason
    assert production._problem_reason_identity_code(reason) == code
    assert production._decoded_problem_reason_identity(code) == reason


def test_legacy_reader_reuses_public_text_reason_cache_owner():
    from music_app.services import library_browse_postgres as production
    from music_app.services import problematic_files_projection as projection

    source = inspect.getsource(production)

    assert "def _cached_problematic_text_reason(" not in source
    assert (
        production._cached_problematic_text_reason
        is projection.cached_problematic_text_reason
    )


def test_incremental_reducer_does_not_lose_late_ignored_repair_semantics():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        _ProblematicItemReducer,
        _problematic_ignored_repair_identity,
    )

    row = _row(
        year=1988,
        title="",
        path=r"D:\Music\Ignored\01.flac",
        track_number=1,
    )
    facts = list(ProblematicGroupAccumulator().consume(((1, row),)))
    row_fact = next(payload for _, kind, payload in facts if kind == "row")
    row_fact["ignored_repair_keys"] = [f'{row["file_private_path"]}::title']
    reducer = _ProblematicItemReducer(str(row_fact["projection_id"]))
    for index in sorted(
        range(2_000),
            key=lambda candidate: _problematic_ignored_repair_identity(
                f"D:\\Music\\Ignored\\filler-{candidate:04d}.flac::title"
            ),
    ):
        reducer.consume(
            "ignored_repair",
            {"repair_key": f"D:\\Music\\Ignored\\filler-{index:04d}.flac::title"},
        )
    reducer.consume("row", row_fact)

    assert reducer.finish() is not None


def test_incremental_reducer_keeps_featured_artist_presence_after_fact_overflow():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        _ProblematicItemReducer,
    )

    row = _row(
        year=1988,
        title="Track",
        path=r"D:\Music\Featured\01.flac",
        track_number=1,
    )
    row["artist_name"] = ""
    facts = list(ProblematicGroupAccumulator().consume(((1, row),)))
    row_fact = next(payload for _, kind, payload in facts if kind == "row")
    reducer = _ProblematicItemReducer(str(row_fact["projection_id"]))
    reducer.consume("featured_artist", {"name": "G" * 70_000})
    reducer.consume("row", row_fact)

    assert reducer.finish() is not None


def test_incremental_reducer_compacts_more_than_64_incomplete_discs():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    rows = []
    for disc_number in range(1, 66):
        row = _row(
            year=1988,
            title=f"Disc {disc_number}",
            path=rf"D:\Music\Many Discs\{disc_number:02d}-02.flac",
            track_number=2,
        )
        row.update(
            track_id=disc_number,
            track_key=f"track-{disc_number}",
            disc_number=disc_number,
        )
        rows.append(row)
    accumulator = ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(enumerate(rows, 1)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    projected = list(accumulator.finalize(facts))[0]
    summary = projected.item["summary"]

    assert len(summary["problem_reasons"]) <= 64
    assert summary["issue_count"] == len(tuple(projected.reason_facts))


def test_reason_facts_preserve_65_exact_disc_reasons_with_bounded_display():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    rows = []
    for disc_number in range(1, 66):
        row = _row(
            year=1988,
            title=f"Disc {disc_number}",
            path=rf"D:\Music\Many Discs\{disc_number:02d}-02.flac",
            track_number=2,
        )
        row.update(
            track_id=disc_number,
            track_key=f"track-{disc_number}",
            disc_number=disc_number,
        )
        row["file_entry"] = {
            **row["file_entry"],
            "disc_number": disc_number,
        }
        rows.append(row)

    accumulator = ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(enumerate(rows, 1)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    projected = tuple(accumulator.finalize(facts))

    assert len(projected) == 1
    expected_reasons = [
        "Missing cover art",
        *(
            f"Incomplete track order: Disc {disc_number} missing 1"
            for disc_number in range(1, 66)
        ),
    ]
    assert projected[0].item["reasons"] == expected_reasons[:64]
    exact = tuple(projected[0].reason_facts)
    assert [fact.display_reason for fact in exact] == expected_reasons
    assert [fact.normalized_reason for fact in exact] == [
        "missing cover art",
        *("incomplete track order" for _ in range(65)),
    ]
    assert {fact.item_key for fact in exact} == {projected[0].item["item_key"]}
    assert projected[0].item["summary"]["issue_count"] == len(exact)
    assert tuple(projected[0].reason_facts) == ()


@pytest.mark.parametrize("source_child_kind", ("featured_artist", "ignored_repair"))
def test_high_cardinality_display_facts_do_not_fail_projection(source_child_kind):
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    row = _row(
        year=1988,
        title="",
        path=r"D:\Music\High Cardinality\01.flac",
        track_number=1,
    )
    child_key = (
        "featured_artist_name"
        if source_child_kind == "featured_artist"
        else "ignored_repair_key"
    )
    entries = [(1, row)]
    entries.extend(
        (
            index,
            {
                "projection_id": "::".join(
                    ("ддт", "студийные записи", "deluxe", "year", "1988")
                ),
                "source_child_kind": source_child_kind,
                child_key: f"{index:04d}-{'x' * 96}",
            },
        )
        for index in range(2, 1002)
    )
    accumulator = ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(entries),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )

    projected = tuple(accumulator.finalize(facts))

    assert len(projected) == 1
    assert projected[0].item["summary"]["issue_count"] == len(
        tuple(projected[0].reason_facts)
    )


def test_retained_bytes_stop_growing_after_bounded_fact_values_truncates():
    from music_app.services.problematic_files_projection import _BoundedFactValues

    values = _BoundedFactValues()
    values.add("retained")
    retained_bytes = values.retained_bytes

    values.add("x" * 70_000)
    values.add("still-not-retained")

    assert values.truncated is True
    assert values.retained_bytes == retained_bytes


def _projected_item_for_reason_stream_lifecycle():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    row = _row(
        year=1988,
        title="Track",
        path=r"D:\Music\Lifecycle\02.flac",
        track_number=2,
    )
    accumulator = ProblematicGroupAccumulator()
    facts = sorted(
        accumulator.consume(((1, row),)),
        key=lambda fact: (
            str(fact[2]["projection_id"]),
            fact[1],
            str(fact[2]["semantic_child_identity"]),
        ),
    )
    return tuple(accumulator.finalize(facts))[0]


def test_projected_item_remains_mapping_compatible_until_handler_migration():
    import json
    from collections.abc import Mapping

    projected = _projected_item_for_reason_stream_lifecycle()

    assert isinstance(projected, Mapping)
    assert dict(projected) == projected.item
    assert json.loads(json.dumps(dict(projected))) == projected.item
    assert projected["item_key"] == projected.item["item_key"]
    projected.close()


def test_reason_stream_closes_after_full_consumption():
    projected = _projected_item_for_reason_stream_lifecycle()

    assert projected.closed is False
    assert tuple(projected.reason_facts)
    assert projected.closed is True


def test_reason_stream_close_owns_partial_consumption():
    projected = _projected_item_for_reason_stream_lifecycle()
    reason_facts = iter(projected.reason_facts)

    next(reason_facts)
    projected.close()

    assert projected.closed is True
    assert tuple(reason_facts) == ()


def test_reason_stream_context_owns_unconsumed_stream():
    projected = _projected_item_for_reason_stream_lifecycle()

    with projected as entered:
        assert entered is projected
        assert projected.closed is False

    assert projected.closed is True
    assert tuple(projected.reason_facts) == ()


def test_projected_item_equality_ignores_one_pass_reason_stream_state():
    left = _projected_item_for_reason_stream_lifecycle()
    right = _projected_item_for_reason_stream_lifecycle()

    assert left == right
    tuple(left.reason_facts)
    assert left == right
    right.close()


def test_reason_stream_close_retries_after_iterator_close_failure():
    from music_app.services.problematic_files_projection import (
        _ProblematicReasonFactStream,
    )

    owner_calls = []

    class RetryableCloseIterator:
        def __init__(self):
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            raise StopIteration

        def close(self):
            self.close_calls += 1
            if self.close_calls == 1:
                raise RuntimeError("iterator close failed")

    values = RetryableCloseIterator()
    stream = _ProblematicReasonFactStream(values, lambda: owner_calls.append("closed"))

    with pytest.raises(RuntimeError, match="iterator close failed"):
        stream.close()

    assert owner_calls == ["closed"]
    assert stream.closed is False

    stream.close()

    assert values.close_calls == 2
    assert owner_calls == ["closed", "closed"]
    assert stream.closed is True


def test_reason_stream_iteration_preserves_original_error_when_cleanup_fails():
    from music_app.services.problematic_files_projection import (
        _ProblematicReasonFactStream,
    )

    owner_calls = []

    class FailingIterator:
        def __iter__(self):
            return self

        def __next__(self):
            raise ValueError("iteration failed")

        def close(self):
            raise RuntimeError("iterator close failed")

    def close_owner():
        owner_calls.append("closed")
        raise OSError("owner close failed")

    stream = _ProblematicReasonFactStream(FailingIterator(), close_owner)

    with pytest.raises(ValueError, match="iteration failed"):
        next(stream)

    assert owner_calls == ["closed"]
    assert stream.closed is False


def test_ignored_repair_after_display_truncation_remains_ignored():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        _ProblematicItemReducer,
        _problematic_ignored_repair_identity,
    )

    row = _row(
        year=1988,
        title="",
        path=r"D:\Music\Ignored\01.flac",
        track_number=1,
    )
    facts = list(ProblematicGroupAccumulator().consume(((1, row),)))
    row_fact = next(payload for _, kind, payload in facts if kind == "row")
    row_fact["ignored_repair_keys"] = [f'{row["file_private_path"]}::title']
    reducer = _ProblematicItemReducer(str(row_fact["projection_id"]))
    for index in sorted(
        range(2_000),
            key=lambda candidate: _problematic_ignored_repair_identity(
                f"D:\\Music\\Other\\filler-{candidate:04d}.flac::title"
            ),
    ):
        reducer.consume(
            "ignored_repair",
            {"repair_key": f"D:\\Music\\Other\\filler-{index:04d}.flac::title"},
        )
    reducer.consume("row", row_fact)

    projected = reducer.finish()

    assert projected is not None
    assert "Missing track title" not in projected.item["reasons"]
    projected.close()


def test_more_than_300_relevant_ignores_preserve_late_target_exactly():
    row = _row(
        year=1988,
        title="",
        path=r"D:\Music\Ignored\Overflow\01.flac",
        track_number=1,
    )
    target_key = f'{row["file_private_path"]}::title'
    filler_keys = _relevant_ignore_keys_before(
        target_key,
        minimum_count=301,
        minimum_encoded_bytes=65_536,
        value_size=220,
    )

    projected = _project_with_persisted_ignored_repairs(
        row,
        (*reversed(filler_keys), filler_keys[0], target_key, target_key),
    )

    assert len(filler_keys) > 300
    assert sum(
        len(json.dumps(key, ensure_ascii=False).encode("utf-8")) + 1
        for key in filler_keys
    ) > 65_536
    assert projected is not None
    assert "Missing track title" not in projected.item["reasons"]
    assert "Missing cover art" in projected.item["reasons"]
    projected.close()


def test_sixty_kilobyte_relevant_ignore_does_not_hide_following_target():
    from music_app.services.problematic_files_projection import (
        _problematic_ignored_repair_identity,
    )

    row = _row(
        year=1988,
        title="",
        path=r"D:\Music\Ignored\Large\01.flac",
        track_number=1,
    )
    target_key = f'{row["file_private_path"]}::title'
    large_key = _relevant_ignore_keys_before(
        target_key,
        minimum_count=1,
        minimum_encoded_bytes=60_000,
        value_size=60_000,
    )[0]
    bridge_key = _relevant_ignore_keys_before(
        target_key,
        minimum_count=1,
        minimum_encoded_bytes=6_000,
        value_size=6_000,
    )[0]

    projected = _project_with_persisted_ignored_repairs(
        row,
        (target_key, bridge_key, large_key),
    )

    assert 60_000 <= len(large_key.encode("utf-8")) < 65_536
    assert (
        _problematic_ignored_repair_identity(large_key)
        < _problematic_ignored_repair_identity(target_key)
    )
    assert projected is not None
    assert "Missing track title" not in projected.item["reasons"]
    projected.close()


def test_persisted_ignore_order_and_duplicates_preserve_current_semantics():
    row = _row(
        year="not-a-year",
        title="",
        path=r"D:\Music\Ignored\Parity\01.flac",
        track_number=1,
    )
    target_key = f'{row["file_private_path"]}::title'

    projected = _project_with_persisted_ignored_repairs(
        row,
        (target_key, f'{row["file_private_path"]}::genre', target_key),
    )

    assert projected is not None
    assert "Missing track title" not in projected.item["reasons"]
    assert "Invalid year" in projected.item["reasons"]
    projected.close()


def test_legacy_persisted_ignored_repairs_accept_old_identity_order():
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        _ProblematicItemReducer,
        _problematic_fact_identity,
        _problematic_ignored_repair_identity,
    )

    repair_keys = ("0066.flac::title", "0005.flac::title")
    assert list(repair_keys) == sorted(
        repair_keys,
        key=lambda repair_key: _problematic_fact_identity(
            "ignored_repair", repair_key
        ),
    )
    assert list(reversed(repair_keys)) == sorted(
        repair_keys,
        key=_problematic_ignored_repair_identity,
    )

    row = _row(
        year=1988,
        title="",
        path="0066.flac",
        track_number=1,
    )
    seed_facts = tuple(ProblematicGroupAccumulator().consume(((1, row),)))
    projection_id = next(
        payload["projection_id"]
        for _stage_id, fact_kind, payload in seed_facts
        if fact_kind == "row"
    )
    reducer = _ProblematicItemReducer(str(projection_id))
    for repair_key in repair_keys:
        reducer.consume("ignored_repair", {"repair_key": repair_key})
    for _stage_id, fact_kind, payload in seed_facts:
        reducer.consume(fact_kind, payload)

    projected = reducer.finish()
    assert projected is not None
    assert "Missing track title" not in projected.item["reasons"]
    projected.close()


def _tracked_projection_spools(monkeypatch):
    from music_app.services import problematic_files_projection as projection

    real_spooled_temporary_file = projection.tempfile.SpooledTemporaryFile
    opened = []

    def tracked_spooled_temporary_file(*args, **kwargs):
        spool = real_spooled_temporary_file(*args, **kwargs)
        opened.append(spool)
        return spool

    monkeypatch.setattr(
        projection.tempfile,
        "SpooledTemporaryFile",
        tracked_spooled_temporary_file,
    )
    return projection, opened


def test_reducer_closes_all_owned_spools_after_full_consumption(monkeypatch):
    _projection, opened = _tracked_projection_spools(monkeypatch)
    row = _row(
        year=1988,
        title="",
        path=r"D:\Music\Ignored\Cleanup\Full.flac",
        track_number=1,
    )
    projected = _project_with_persisted_ignored_repairs(
        row, (f'{row["file_private_path"]}::title',)
    )

    assert projected is not None
    tuple(projected.reason_facts)

    assert len(opened) == 4
    assert all(spool.closed for spool in opened)


def test_reducer_close_owns_all_spools_after_partial_consumption(monkeypatch):
    _projection, opened = _tracked_projection_spools(monkeypatch)
    row = _row(
        year=1988,
        title="",
        path=r"D:\Music\Ignored\Cleanup\Partial.flac",
        track_number=2,
    )
    projected = _project_with_persisted_ignored_repairs(
        row, (f'{row["file_private_path"]}::title',)
    )

    assert projected is not None
    reasons = iter(projected.reason_facts)
    next(reasons)
    projected.close()

    assert len(opened) == 4
    assert all(spool.closed for spool in opened)


def test_reducer_closes_all_owned_spools_when_row_projection_fails(monkeypatch):
    projection, opened = _tracked_projection_spools(monkeypatch)
    row = _row(
        year=1988,
        title="",
        path=r"D:\Music\Ignored\Cleanup\Error.flac",
        track_number=1,
    )
    facts = tuple(projection.ProblematicGroupAccumulator().consume(((1, row),)))
    row_fact = next(payload for _, kind, payload in facts if kind == "row")
    reducer = projection._ProblematicItemReducer(str(row_fact["projection_id"]))
    reducer.consume(
        "ignored_repair", {"repair_key": f'{row["file_private_path"]}::title'}
    )

    def fail_projection(_rows):
        raise RuntimeError("projection failed")

    monkeypatch.setattr(projection, "project_problematic_files", fail_projection)

    with pytest.raises(RuntimeError, match="projection failed"):
        reducer.consume("row", row_fact)

    assert len(opened) == 3
    assert all(spool.closed for spool in opened)


def test_finalize_closes_active_reducer_when_fact_iteration_fails(monkeypatch):
    projection, opened = _tracked_projection_spools(monkeypatch)

    def failing_facts():
        yield (
            1,
            "ignored_repair",
            {
                "projection_id": "projection-cleanup-error",
                "semantic_child_identity": "a",
                "repair_key": r"D:\Music\Ignored\Cleanup\Error.flac::title",
            },
        )
        raise RuntimeError("fact iteration failed")

    projected = projection.ProblematicGroupAccumulator().finalize(failing_facts())

    with pytest.raises(RuntimeError, match="fact iteration failed"):
        tuple(projected)

    assert len(opened) == 3
    assert all(spool.closed for spool in opened)


def test_legacy_row_ignores_merge_into_fixed_hash_spool(monkeypatch):
    projection, opened = _tracked_projection_spools(monkeypatch)
    row = _row(
        year=1988,
        title="",
        path=r"D:\Music\Ignored\Legacy\01.flac",
        track_number=1,
    )
    row_fact = next(
        payload
        for _stage_id, kind, payload in projection.ProblematicGroupAccumulator().consume(
            ((1, row),)
        )
        if kind == "row"
    )
    row_fact["ignored_repair_keys"] = [
        *(f"D:\\Music\\Other\\legacy-{index:04d}.flac::title" for index in range(300)),
        f'{row["file_private_path"]}::title',
    ]
    reducer = projection._ProblematicItemReducer(str(row_fact["projection_id"]))
    reducer.consume("row", row_fact)

    projected = reducer.finish()

    assert projected is not None
    assert "Missing track title" not in projected.item["reasons"]
    projected.close()
    assert len(opened) == 4
    assert all(spool.closed for spool in opened)
def test_legacy_and_hashed_ignored_repair_facts_can_interleave():
    from music_app.services.problematic_files_projection import (
        _SpooledIgnoredRepairMembership,
        _problematic_ignored_repair_identity,
    )

    legacy_key = "0066.flac::title"
    hashed_key = "0005.flac::title"
    assert _problematic_ignored_repair_identity(hashed_key) < (
        _problematic_ignored_repair_identity(legacy_key)
    )

    membership = _SpooledIgnoredRepairMembership()
    try:
        membership.add(legacy_key)
        membership.add_identity(
            _problematic_ignored_repair_identity(hashed_key)
        )

        assert legacy_key in membership
        assert hashed_key in membership
    finally:
        membership.close()


def test_legacy_ignored_repair_ingestion_defers_spool_merge(monkeypatch):
    from music_app.services import problematic_files_projection as projection

    opened = []
    real_spooled_file = projection.tempfile.SpooledTemporaryFile

    def tracked_spooled_file(*args, **kwargs):
        spool = real_spooled_file(*args, **kwargs)
        opened.append(spool)
        return spool

    monkeypatch.setattr(
        projection.tempfile,
        "SpooledTemporaryFile",
        tracked_spooled_file,
    )
    membership = projection._SpooledIgnoredRepairMembership()
    try:
        membership.add("0000.flac::title")
        ingestion_spool_count = len(opened)
        for index in range(1, 2_000):
            membership.add(f"{index:04d}.flac::title")

        assert len(opened) == ingestion_spool_count
        assert membership
        assert "0000.flac::title" in membership
    finally:
        membership.close()


def test_legacy_ignored_repair_external_merge_uses_bounded_disk_runs(
    monkeypatch,
):
    from music_app.services import problematic_files_projection as projection

    fan_in = 2
    monkeypatch.setattr(projection, "_PROBLEMATIC_FACT_MERGE_FAN_IN", fan_in)
    monkeypatch.setattr(
        projection,
        "_MAX_REDUCER_FACT_BYTES",
        projection._PROBLEMATIC_FACT_RECORD_BYTES * 2,
    )

    active_handles = 0
    max_active_handles = 0
    opened_paths = []
    real_open_run = projection._open_problematic_identity_run

    class TrackedRun:
        def __init__(self, owner):
            self._owner = owner

        def __enter__(self):
            nonlocal active_handles, max_active_handles
            entered = self._owner.__enter__()
            active_handles += 1
            max_active_handles = max(max_active_handles, active_handles)
            return entered

        def __exit__(self, *args):
            nonlocal active_handles
            try:
                return self._owner.__exit__(*args)
            finally:
                active_handles -= 1

    def tracked_open_run(path, mode):
        opened_paths.append(path)
        return TrackedRun(real_open_run(path, mode))

    monkeypatch.setattr(
        projection,
        "_open_problematic_identity_run",
        tracked_open_run,
    )

    membership = projection._SpooledIgnoredRepairMembership()
    try:
        for index in range(40):
            membership.add(f"{index:04d}.flac::title")

        assert "0000.flac::title" in membership
        assert opened_paths
        assert all(
            path.parent.name.startswith("album-haven-problematic-identities-")
            for path in opened_paths
        )
        assert max_active_handles == fan_in + 1
        assert active_handles == 0
    finally:
        membership.close()
