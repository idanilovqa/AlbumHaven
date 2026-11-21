"""Bounded exact signature references, collision safety and resource ownership."""

import json

import pytest

from music_app.services import problematic_files_projection as projection
from tests.py.test_problematic_files_projection import _tracked_projection_spools
from tests.py.test_problematic_files_projection import _assert_topology_unit_matches_main, _persist_semantic_facts
from tests.py.test_problematic_topology_unit3_semantics import _group, _assert_source_groups
from music_app.models.library import Track
from music_app.services.library import _duplicate_track_group_card_identity, _equivalent_duplicate_track_groups


class _CollidingDigest:
    def update(self, _value):
        pass

    def hexdigest(self):
        return "0" * 64


@pytest.mark.parametrize("branch", ["global-exact", "local-exact-only"])
def test_exact_qualification_finishes_without_signature_work(monkeypatch, branch):
    rows = [*_group("P", 1), *_group("Q", 3)]
    if branch == "local-exact-only":
        rows += _group("P", 91, album="Foreign P", tokens=((1, "Foreign", 180),),
                       original_key="foreign-p", album_id=72)

    def unexpected(*_args, **_kwargs):
        raise AssertionError("an already qualified album must not prepare signatures")

    monkeypatch.setattr(projection, "_problematic_signature_digest", unexpected)
    monkeypatch.setattr(projection._ProblematicSignatureStore, "token", unexpected)
    monkeypatch.setattr(projection._ProblematicSignatureStore, "write_refs", unexpected)
    _assert_source_groups(rows, ["P", "Q"])
    _assert_topology_unit_matches_main(rows)


def test_scalar_token_comparisons_share_the_existing_stop_quantum():
    primary = RuntimeError("stop at the aggregate comparison quantum")

    def stop():
        raise primary

    with projection._ProblematicSignatureStore(projection._problematic_topology_work(stop)) as store:
        for _index in range(99):
            assert store.compare_tokens((1, 1, 0, 0, 180), (1, 2, 0, 0, 180)) < 0
        with pytest.raises(RuntimeError) as caught:
            store.compare_tokens((1, 1, 0, 0, 180), (1, 2, 0, 0, 180))
        assert caught.value is primary
        assert store._file is None


def test_normalized_signature_expansion_does_not_add_a_content_limit():
    from music_app.services.library import _normalized_duplicate_card_text

    title = "\ufdfa" * 2000
    assert len(title.encode("utf-8")) < projection._MAX_REDUCER_FACT_BYTES
    assert len(_normalized_duplicate_card_text(title).encode("utf-8")) > projection._MAX_REDUCER_FACT_BYTES
    tokens = ((1, title, 180), (2, "Closing", 240))
    rows = [*_group("P", 1, tokens=tokens), *_group("Q", 3, album="Cafe", tokens=tokens)]
    facts = _persist_semantic_facts(projection.ProblematicGroupAccumulator(), enumerate(rows, 1))
    assert max(len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
               for _stage, _kind, value in facts) < projection._MAX_REDUCER_FACT_BYTES
    _assert_source_groups(rows, ["P", "Q"])
    _assert_topology_unit_matches_main(rows)


@pytest.mark.parametrize("field", ["album", "album_artist", "edition"])
def test_normalized_card_expansion_uses_compact_metadata_references(field, monkeypatch):
    from music_app.services.library import _normalized_duplicate_card_text

    raw = {name: "\ufdfa" * (1000 if name == field else 700)
           for name in ("album", "album_artist", "edition")}
    normalized = {name: _normalized_duplicate_card_text(value) for name, value in raw.items()}
    assert all(len(value.encode("utf-8")) < projection._MAX_REDUCER_FACT_BYTES
               for value in normalized.values())
    assert sum(len(value.encode("utf-8")) for value in normalized.values()) > projection._MAX_REDUCER_FACT_BYTES
    card = [normalized["album_artist"], normalized["album"], 1988, normalized["edition"], ""]
    assert len(json.dumps((("owner", *card[:3]), {"card": card}), ensure_ascii=False).encode("utf-8")) > projection._MAX_REDUCER_FACT_BYTES
    rows = [*_group("P", 1), *_group("Q", 3, album="Cafe")]
    for row in rows:
        row["file_entry"].update(raw)
        if "/P/" in row["file_private_path"].replace("\\", "/"):
            row["file_entry"]["album"] = "The " + raw["album"]
    assert all(len(json.dumps(row, ensure_ascii=False).encode("utf-8")) < projection._MAX_REDUCER_FACT_BYTES
               for row in rows)
    facts = _persist_semantic_facts(projection.ProblematicGroupAccumulator(), enumerate(rows, 1))
    assert max(len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
               for _stage, _kind, value in facts) < projection._MAX_REDUCER_FACT_BYTES
    sizes = []
    add = projection._ProblematicSortedSearchValues.add

    def measured(self, key, value):
        sizes.append(len(json.dumps((key, value), ensure_ascii=False).encode("utf-8")))
        return add(self, key, value)

    monkeypatch.setattr(projection._ProblematicSortedSearchValues, "add", measured)
    _assert_source_groups(rows, ["P", "Q"])
    _assert_topology_unit_matches_main(rows)
    assert sizes and max(sizes) <= projection._MAX_REDUCER_FACT_BYTES


@pytest.mark.parametrize("field", ["album", "album_artist", "edition"])
def test_private_compact_card_stream_accepts_expanded_scalar_beyond_fact_budget(field, monkeypatch):
    """Private/domain proof only: this expanded scalar is not a persisted-fact fixture."""
    from music_app.services.library import _normalized_duplicate_card_text
    from tests.py.test_problematic_topology_unit3_semantics import _domain_tracks

    raw = "\ufdfa" * 2000
    assert len(_normalized_duplicate_card_text(raw).encode("utf-8")) > projection._MAX_REDUCER_FACT_BYTES
    rows = [*_group("P", 1), *_group("Q", 3)]
    for row in rows:
        row["file_entry"][field] = raw
    groups = [_domain_tracks(rows[:2]), _domain_tracks(rows[2:])]
    assert _equivalent_duplicate_track_groups(*groups) is True
    sizes = []
    add = projection._ProblematicSortedSearchValues.add

    def measured(self, key, value):
        sizes.append(len(json.dumps((key, value), ensure_ascii=False).encode("utf-8")))
        return add(self, key, value)

    monkeypatch.setattr(projection._ProblematicSortedSearchValues, "add", measured)
    tokens = tuple((track.disc_number or 1, track.track_number,
                    _normalized_duplicate_card_text(track.title), track.duration_seconds)
                   for track in groups[0])
    with projection._ProblematicSignatureStore(lambda *_args, **_kw: None) as store:
        candidates = [_candidate(store, container, tokens) for container in ("P", "Q")]
        for candidate, group in zip(candidates, groups):
            candidate["card"] = list(_duplicate_track_group_card_identity(group))
            candidate["card"][1] = candidate["card"][1].removeprefix("the ")
        result = list(projection._problematic_equivalent_witnesses(
            iter(candidates), store, work=lambda *_args, **_kw: None,
        ))
        assert {(row["container"], row["witness"]) for row in result} == {("P", "Q"), ("Q", "P")}
    assert sizes and max(sizes) <= projection._MAX_REDUCER_FACT_BYTES


def _candidate(store, container, tokens, *, edition="", date=""):
    return {"album": "owner", "container": container,
            "card": ["artist", "album", 1988, edition, date],
            "signature": store.write(iter(tokens))}


@pytest.mark.parametrize("specs", [
    (("", "2000-01-01"), ("EP", "2001-01-01"), ("Single", "2000-01-01")),
    (("EP", "2000-01-01"), ("", ""), ("Single", "2001-01-01")),
    (("Deluxe", "2000-01-01"), ("Deluxe", ""), ("Deluxe", "2001-01-01")),
    (("Deluxe", "2000-01-01"), ("Deluxe", "2000-01-01"), ("Deluxe", "2001-01-01")),
    (("EP", "2000-01-01"),),
], ids=["same-other-edition-date", "blank-edition-bridge", "blank-date-bridge", "same-date-only", "no-self-witness"])
def test_bounded_witnesses_match_actual_domain_edition_and_date_pairs(specs):
    from music_app.services.library import _normalized_duplicate_card_text

    tokens = ((1, "Opening", 180), (2, "Closing", 240))
    groups = [[Track(path=f"/witness/C{index}/{number}.flac", title=title,
                     album="Album", album_artist="Artist", artist="Artist", year=1988,
                     disc_number=1, track_number=number, duration_seconds=duration,
                     edition=edition, release_date=date) for number, title, duration in tokens]
              for index, (edition, date) in enumerate(specs)]
    expected_pairs = {(f"C{left}", f"C{right}") for left in range(len(groups))
                      for right in range(len(groups)) if left != right
                      and _equivalent_duplicate_track_groups(groups[left], groups[right])}
    signature_tokens = tuple((1, number, _normalized_duplicate_card_text(title), duration)
                             for number, title, duration in tokens)
    with projection._ProblematicSignatureStore(lambda *_args, **_kw: None) as store:
        candidates = [_candidate(store, f"C{index}", signature_tokens, edition=edition.lower(), date=date)
                      for index, (edition, date) in enumerate(specs)]
        result = list(projection._problematic_equivalent_witnesses(
            iter(candidates), store, work=lambda *_args, **_kw: None,
        ))
        assert {row["container"] for row in result} == {left for left, _right in expected_pairs}
        assert all((row["container"], row["witness"]) in expected_pairs for row in result)


@pytest.mark.parametrize("equal", [False, True], ids=["different-tail", "equal-tail"])
def test_signature_digest_collision_replays_exact_shared_prefix(monkeypatch, equal):
    monkeypatch.setattr(projection, "_problematic_signature_digest", _CollidingDigest)
    monkeypatch.setattr(projection, "_MAX_REDUCER_FACT_BYTES", 512)
    prefix = tuple((1, number, "Common token " + "x" * 80, 180) for number in range(1, 33))
    left = (*prefix, (1, 33, "Final token", 181))
    right = (*prefix, (1, 33, "Final token", 181 if equal else 182))
    charged = []
    with projection._ProblematicSignatureStore(lambda size=0, **_kw: charged.append(size)) as store:
        first, second = _candidate(store, "P", left), _candidate(store, "Q", right)
        assert first["signature"]["digest"] == second["signature"]["digest"]
        assert first["signature"]["count"] == second["signature"]["count"] == 33
        assert first["signature"]["offset"] != second["signature"]["offset"]
        assert set(first["signature"]) == {"offset", "length", "count", "digest"}
        assert first["signature"]["length"] > projection._MAX_REDUCER_FACT_BYTES
        result = list(projection._problematic_equivalent_witnesses(
            iter((first, second)), store, work=lambda *_args, **_kw: None,
        ))
        assert {(row["container"], row["witness"]) for row in result} == ({("P", "Q"), ("Q", "P")} if equal else set())
        assert sum(charged) > first["signature"]["length"] + second["signature"]["length"]
    assert store._file.closed


def test_signature_reference_sort_spills_without_pairwise_container_comparison(monkeypatch):
    monkeypatch.setattr(projection, "_problematic_signature_digest", _CollidingDigest)
    monkeypatch.setattr(projection, "_MAX_REDUCER_FACT_BYTES", 512)
    monkeypatch.setattr(projection, "_PROBLEMATIC_FACT_MERGE_FAN_IN", 2)
    _module, opened = _tracked_projection_spools(monkeypatch)
    comparisons = []
    signature_offsets = set()
    count = 32
    with projection._ProblematicSignatureStore(lambda *_args, **_kw: None) as store:
        compare = store.compare

        def counted(left, right):
            if left["offset"] in signature_offsets and right["offset"] in signature_offsets:
                comparisons.append(True)
            return compare(left, right)

        monkeypatch.setattr(store, "compare", counted)
        candidates = [_candidate(store, f"C{index:02d}", (
            (1, 1, "Opening", 180), (1, 2, f"Pair {index // 2:02d}", 240),
        )) for index in reversed(range(count))]
        signature_offsets.update(candidate["signature"]["offset"] for candidate in candidates)
        result = list(projection._problematic_equivalent_witnesses(
            iter(candidates), store, work=lambda *_args, **_kw: None,
        ))
        assert {row["container"] for row in result} == {f"C{index:02d}" for index in range(count)}
        assert all(int(row["container"][1:]) // 2 == int(row["witness"][1:]) // 2
                   and row["container"] != row["witness"] for row in result)
        assert len(comparisons) <= 4 * count * count.bit_length()
    assert opened and all(owner.closed for owner in opened)
    assert store._file.closed


def test_signature_comparison_cancellation_preserves_primary_and_closes_spills(monkeypatch):
    monkeypatch.setattr(projection, "_problematic_signature_digest", _CollidingDigest)
    monkeypatch.setattr(projection, "_MAX_REDUCER_FACT_BYTES", 512)
    _module, opened = _tracked_projection_spools(monkeypatch)
    primary = RuntimeError("stop during exact signature comparison")
    comparing = False
    signature_phase = []

    def work(size=0, **_kw):
        if comparing and size:
            raise primary

    with pytest.raises(RuntimeError) as caught:
        with projection._ProblematicSignatureStore(work) as store:
            first = _candidate(store, "P", ((1, 1, "Opening", 180), (1, 2, "Closing", 240)))
            second = _candidate(store, "Q", ((1, 1, "Opening", 180), (1, 2, "Closing", 241)))
            compare = store.compare

            def interrupted(left, right):
                nonlocal comparing
                offsets = {first["signature"]["offset"], second["signature"]["offset"]}
                if left["offset"] in offsets and right["offset"] in offsets:
                    comparing = True
                    signature_phase.append(True)
                return compare(left, right)

            monkeypatch.setattr(store, "compare", interrupted)
            list(projection._problematic_equivalent_witnesses(
                iter((first, second)), store, work=work,
            ))
    assert caught.value is primary
    assert signature_phase == [True]
    assert store._file.closed
    assert opened and all(owner.closed for owner in opened)
