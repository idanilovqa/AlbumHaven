"""Unit3 canonical equivalent witnesses and branch-specific root provenance."""

from pathlib import Path

import pytest

from music_app.services.problematic_files_projection import _duplicate_sources_from_rows
from music_app.models.library import Track
from music_app.services.library import _equivalent_duplicate_track_groups
from music_app.services.library_roots import build_root_provenance_payload, summarize_root_provenance_payloads
from tests.py.test_problematic_files_projection import (
    _assert_topology_unit_matches_main,
    _topology_unit_main_records,
    _topology_unit_row,
)


_OWN = "unit3-owned"
_BASE = Path("D:/Music/Unit3")
_TOKENS = ((1, "Opening song", 180), (2, "Closing song", 240))


def _group(folder, first_id, *, album="The Café", edition="", date="", tokens=_TOKENS,
           root="1", category="main_library_roots", year=1988, split=False,
           original_key=_OWN, album_id=71):
    rows = []
    for index, (number, title, duration) in enumerate(tokens):
        row = _topology_unit_row(
            str(_BASE / folder / f"{first_id + index}.flac"), first_id + index,
            original_key=original_key, album_id=album_id, number=number,
            duration=duration, year=year, split=split,
        )
        row.update(track_title=title, file_library_root_id=root, file_library_root_category=category)
        row["file_entry"].update(album=album, title=title, edition=edition, release_date=date)
        rows.append(row)
    return rows


def _sources(rows, *, deferred=False):
    return _duplicate_sources_from_rows(rows, defer_source_payloads=deferred)[_OWN]


def _domain_tracks(rows):
    return [Track(path=row["file_private_path"], title=row["track_title"],
                  album=row["file_entry"]["album"], album_artist=row["file_entry"]["album_artist"],
                  artist=row["file_entry"]["artist"], year=row["file_entry"]["year"],
                  disc_number=row["disc_number"], track_number=row["track_number"],
                  duration_seconds=row["duration_seconds"], edition=row["file_entry"]["edition"],
                  release_date=row["file_entry"]["release_date"]) for row in rows]


def _assert_source_groups(rows, folders):
    result = _sources(rows)
    assert result["has_duplicate_files"] is bool(folders)
    sources = result["duplicate_sources"]
    assert [source["folder_path"] for source in sources] == [str(_BASE / folder) for folder in folders]
    for source in sources:
        own = [row for row in rows if row["album_key"] == _OWN
               and str(Path(row["file_private_path"]).parent) == source["folder_path"]]
        assert [track["track_ref"] for track in source["tracks"]] == [
            row["track_key"] for row in sorted(own, key=lambda row: (
                row["disc_number"], row["track_number"], row["track_title"].casefold(),
            ))
        ]
        assert source["track_count"] == len(own)
        assert source["total_duration_seconds"] == sum(row["duration_seconds"] for row in own)
    return result


def _assert_projected_provenance(rows):
    expected, actual = _assert_topology_unit_matches_main(rows)
    for identity, record in expected.items():
        assert actual[identity].get("root_provenance") == record["summary"].get("root_provenance")
    return expected, actual


def test_equivalent_group_can_use_an_already_local_exact_qualified_witness():
    rows = [*_group("P", 1), *_group("Q", 3), *_group("R", 5, album="Cafe")]
    rows += _group("P", 91, album="Foreign P", tokens=_TOKENS[:1],
                   original_key="foreign-p", album_id=72)
    rows += _group("Q", 92, album="Foreign Q", tokens=_TOKENS[:1],
                   original_key="foreign-q", album_id=73)
    result = _assert_source_groups(rows, ["P", "Q", "R"])
    assert result["root_provenance"] is None
    deferred = _sources(rows, deferred=True)
    assert deferred["_duplicate_source_years"] == [{1988}, {1988}, {1988}]
    assert deferred["_duplicate_source_materializer"]() == result["duplicate_sources"]
    _assert_projected_provenance(rows)


@pytest.mark.parametrize("case", ["edition-and-date", "blank-edition-bridge", "blank-date-bridge"])
def test_equivalent_edition_and_date_witnesses_remain_pairwise(case):
    if case == "edition-and-date":
        specs = (("", "2000-01-01"), ("EP", "2001-01-01"), ("Single", "2000-01-01"))
        wanted, incompatible = ["P", "Q", "R"], (0, 1)
    elif case == "blank-edition-bridge":
        specs = (("EP", "2000-01-01"), ("", "2000-01-01"), ("Single", "2000-01-01"))
        wanted, incompatible = ["P", "Q", "R"], (0, 2)
    else:
        specs = (("Deluxe", "2000-01-01"), ("Deluxe", ""), ("Deluxe", "2001-01-01"))
        wanted, incompatible = ["P", "Q", "R"], (0, 2)
    groups = [_group(folder, 1 + index * 2, album=title, edition=edition, date=date)
              for index, (folder, title, (edition, date)) in enumerate(zip(
                  ("P", "Q", "R"), ("The Café", "Cafe", "Café!"), specs,
              ))]
    left, right = (groups[index] for index in incompatible)
    assert _equivalent_duplicate_track_groups(_domain_tracks(left), _domain_tracks(right)) is False
    # PF deliberately prepares no per-file release_date; domain callers above do.
    assert _sources(left + right)["has_duplicate_files"] is (case != "blank-edition-bridge")
    rows = [row for group in groups for row in group]
    _assert_source_groups(rows, wanted)
    _assert_projected_provenance(rows)


@pytest.mark.parametrize("tracks,duplicate", [(1, False), (2, True)], ids=["one-track", "two-tracks"])
def test_equivalent_signature_requires_two_tracks_without_changing_local_exact_rule(tracks, duplicate):
    rows = [*_group("P", 1, tokens=_TOKENS[:tracks]),
            *_group("Q", 3, album="Cafe", tokens=_TOKENS[:tracks])]
    _assert_source_groups(rows, ["P", "Q"] if duplicate else [])
    expected = _topology_unit_main_records(rows)
    assert len(expected) == 1
    assert ("Duplicate files" in next(iter(expected.values()))["summary"]["problem_reasons"]) is duplicate
    _assert_projected_provenance(rows)


def test_equivalent_signature_compares_exact_token_multiplicity():
    first, second = _TOKENS
    assert set((first, first, second)) == set((first, second, second))
    rows = [*_group("P", 1, tokens=(first, first, second)),
            *_group("Q", 4, album="Cafe", tokens=(first, second, second))]
    _assert_source_groups(rows, [])
    _assert_projected_provenance(rows)


@pytest.mark.parametrize("same_tail", [False, True], ids=["different-tail", "equal-tail"])
def test_equivalent_signature_compares_after_a_shared_token_prefix(same_tail):
    prefix = tuple((number, f"Common prefix track {number}", 180) for number in range(1, 9))
    left = (*prefix, (9, "Final token", 181))
    right = (*prefix, (9, "Final token", 181 if same_tail else 182))
    assert left[:-1] == right[:-1] and (left[-1] == right[-1]) is same_tail
    rows = [*_group("P", 1, tokens=left), *_group("Q", 20, album="Cafe", tokens=right)]
    _assert_source_groups(rows, ["P", "Q"] if same_tail else [])
    _assert_projected_provenance(rows)


@pytest.mark.parametrize("split", [False, True], ids=["unsplit-majority", "split-year-map"])
def test_exact_link_provenance_keeps_split_below_majority_category_and_source_years(split):
    own = [*_group("P", 1, album="Topology Album", tokens=(*_TOKENS, (3, "Third song", 200)), split=split),
           *_group("S", 4, album="Other Year", year=1999,
                   tokens=((4, "Other-year song", 180),), split=split)]
    companion = _group("Q", 10, album="Topology Album", edition="Archive", tokens=_TOKENS[:1],
                       root="9", category="new_arrivals_roots",
                       original_key="unit3-companion", album_id=72)
    rows = [*own, *companion]
    canonical = _sources(rows)
    main = summarize_root_provenance_payloads([build_root_provenance_payload("1", "main_library_roots")])
    both = summarize_root_provenance_payloads([
        build_root_provenance_payload("1", "main_library_roots"),
        build_root_provenance_payload("9", "new_arrivals_roots"),
    ])
    assert canonical["has_duplicate_files"] is True
    assert canonical["root_provenance"] == main
    assert canonical["_root_provenance_by_year"] == {1988: both, 1999: main}
    assert [source["folder_path"] for source in canonical["duplicate_sources"]] == [str(_BASE / "P"), str(_BASE / "Q")]
    assert [[track["track_ref"] for track in source["tracks"]] for source in canonical["duplicate_sources"]] == [
        ["topology-track-1", "topology-track-2", "topology-track-3"], ["topology-track-10"],
    ]
    deferred = _sources(rows, deferred=True)
    assert deferred["_duplicate_source_years"] == [{1988}, {1988}]
    assert deferred["_duplicate_source_materializer"]() == canonical["duplicate_sources"]
    expected = _topology_unit_main_records(rows)
    owned = [record for record in expected.values() if record["summary"]["key"] == _OWN
             or record["summary"]["key"].startswith("topology artist::topology album::year::")]
    assert len(owned) == (2 if split else 1)
    for record in owned:
        summary, detail = record["summary"], record["detail"]
        if split and int(summary["year"]) == 1999:
            assert "Duplicate files" not in summary["problem_reasons"]
            assert detail.get("duplicate_sources", []) == []
            assert detail["root_provenance"] == main
        else:
            assert "Duplicate files" in summary["problem_reasons"]
            assert detail["duplicate_sources"] == canonical["duplicate_sources"]
            assert detail["root_provenance"] == (both if split else main)
        assert "root_provenance" not in summary
    _assert_projected_provenance(rows)


def test_fallback_provenance_stays_transient_none_despite_persisted_metadata():
    rows = [*_group("P", 1), *_group("Q", 3)]
    rows += _group("P", 91, album="Foreign P", tokens=_TOKENS[:1],
                   original_key="foreign-p", album_id=72)
    for row in rows:
        if row["album_key"] == _OWN:
            row["album_metadata"]["root_provenance"] = {"root_ids": ["persisted-sentinel"]}
    result = _assert_source_groups(rows, ["P", "Q"])
    assert result["root_provenance"] is None
    expected, actual = _assert_projected_provenance(rows)
    owned = next(record for record in expected.values() if record["summary"]["key"] == _OWN)
    assert owned["transient_root_provenance"] is None
    assert actual[owned["summary"]["projection_id"]].get("root_provenance") is None
    assert all("persisted-sentinel" not in str(source) for source in result["duplicate_sources"])
