import io
from types import SimpleNamespace

import pytest
from PIL import Image

from music_app.services import cover_refresh_provider
from music_app.services.cover_provider_candidates import CoverCandidate


def test_repair_accepts_both_adequate_edges_even_when_candidate_has_less_total_area(tmp_path, monkeypatch):
    from music_app.services import cover_refresh_policy

    monkeypatch.setattr(cover_refresh_policy, "AUTOMATIC_COVER_REPAIR_MIN_EDGE", 2000)
    current = tmp_path / "cover.png"
    Image.new("RGB", (1999, 4000), "green").save(current)
    raw = io.BytesIO()
    Image.new("RGB", (2000, 2000), "blue").save(raw, format="PNG")
    candidate = CoverCandidate(source="apple", url="https://images.example/adequate.png",
        raw_bytes=raw.getvalue(), width=2000, height=2000, score=0.99,
        matched_artist="Artist", matched_album="Album")
    selected, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        tmp_path, "Artist", "Album", None, 2026, {".png", ".jpg"},
        SimpleNamespace(get=lambda *_args: None, set=lambda *_args: None), "Tests/1.0",
        selected_cover_path=str(current), cover_selection_origin="user", reject_if_user_controlled=True,
        search_remote_cover_func=lambda **_kwargs: (candidate, []),
        automatic_write_guard=lambda write_action, **_kwargs: write_action(),
    )
    assert downloaded is True
    assert detail["legacy_user_selection_replaced"] is True
    with Image.open(selected) as image:
        assert image.size == (2000, 2000)


@pytest.mark.parametrize("origin", ["automatic", "user"])
def test_adequate_selected_remote_artwork_skips_automatic_search(tmp_path, monkeypatch, origin):
    from music_app.services import cover_refresh_policy

    monkeypatch.setattr(cover_refresh_policy, "AUTOMATIC_COVER_REPAIR_MIN_EDGE", 2000)
    _selected, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        tmp_path, "Artist", "Album", None, 2026, {".png", ".jpg"},
        SimpleNamespace(get=lambda *_args: None, set=lambda *_args: None), "Tests/1.0",
        cover_selection_origin=origin, reject_if_user_controlled=True,
        selected_remote_cover_url="https://images.example/adequate.png",
        selected_remote_cover_width=2000, selected_remote_cover_height=2000,
        search_remote_cover_func=lambda **_kwargs: pytest.fail("adequate artwork must not query providers"),
    )
    assert downloaded is False
    assert detail["reason"] == "satisfactory_selected_remote_cover_present"


def test_repair_target_negative_cache_does_not_block_normal_target_after_restart(tmp_path, monkeypatch):
    from music_app.services import cover_refresh_policy

    folder = tmp_path / "Album"
    folder.mkdir()
    entries = {}
    cache = SimpleNamespace(get=entries.get, set=lambda key, value: entries.__setitem__(key, value))
    searches = []
    monkeypatch.setattr(cover_refresh_policy, "AUTOMATIC_COVER_REPAIR_MIN_EDGE", 2000)
    cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2026, {".png", ".jpg"}, cache, "Tests/1.0",
        search_remote_cover_func=lambda **kwargs: (searches.append(kwargs) or None, []),
    )
    assert len(searches) == 1
    assert next(iter(entries.values()))["missing"] is True

    monkeypatch.setattr(cover_refresh_policy, "AUTOMATIC_COVER_REPAIR_MIN_EDGE", 1200)
    raw = io.BytesIO()
    Image.new("RGB", (1600, 1600), "blue").save(raw, format="PNG")
    candidate = CoverCandidate(source="apple", url="https://images.example/normal.png",
        raw_bytes=raw.getvalue(), width=1600, height=1600, score=0.99,
        matched_artist="Artist", matched_album="Album")
    selected, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2026, {".png", ".jpg"}, cache, "Tests/1.0",
        search_remote_cover_func=lambda **kwargs: (searches.append(kwargs) or candidate, []),
        automatic_write_guard=lambda write_action, **_kwargs: write_action(),
    )
    assert len(searches) == 2
    assert downloaded is True
    assert detail["reason"] == "cover_written"
    with Image.open(selected) as image:
        assert image.size == (1600, 1600)


@pytest.mark.parametrize("explicit", [False, True])
def test_different_adequate_art_replaces_only_unconfirmed_legacy_user_cover(tmp_path, monkeypatch, explicit):
    folder = tmp_path / "Album"
    folder.mkdir()
    current = folder / "cover.png"
    Image.new("RGB", (640, 640), "green").save(current)
    original = current.read_bytes()
    raw = io.BytesIO()
    Image.new("RGB", (1600, 1600), "blue").save(raw, format="PNG")
    candidate = CoverCandidate(source="apple", url="https://images.example/new.png", raw_bytes=raw.getvalue(),
        width=1600, height=1600, score=0.99, matched_artist="Artist", matched_album="Album")
    monkeypatch.setattr(cover_refresh_provider, "images_are_visually_similar", lambda *_args: False)
    writes = []
    publications = []
    def guard(write_action, *, cover_selection_origin):
        writes.append((cover_selection_origin, getattr(write_action, "preserve_user_ownership", False)))
        return write_action()
    selected, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2026, {".png", ".jpg"},
        SimpleNamespace(get=lambda *_args: None, set=lambda *_args: None), "Tests/1.0",
        selected_cover_path=str(current), cover_selection_origin="user",
        cover_selection_provenance="explicit" if explicit else None, reject_if_user_controlled=True,
        automatic_write_guard=guard, search_remote_cover_func=lambda **_kwargs: (candidate, []),
        candidate_callback=lambda *args, **kwargs: publications.append((args, kwargs)),
    )
    if explicit:
        assert downloaded is False
        assert selected == current
        assert current.read_bytes() == original
        assert writes == []
        assert detail["reason"] == "user_controlled_improvement_available"
        assert publications
    else:
        assert downloaded is True
        assert selected is not None
        assert Image.open(selected).size == (1600, 1600)
        assert writes == [("automatic", False)]
        assert detail["reason"] == "cover_written"


@pytest.mark.parametrize("dimensions,searches", [((1999, 2000), 1), ((2000, 2000), 0), ((2000, 1999), 1)])
def test_one_off_repair_target_checks_both_local_edges(tmp_path, monkeypatch, dimensions, searches):
    from music_app.services import cover_refresh_policy

    monkeypatch.setattr(cover_refresh_policy, "AUTOMATIC_COVER_REPAIR_MIN_EDGE", 2000)
    folder = tmp_path / "Album"
    folder.mkdir()
    cover = folder / "cover.png"
    Image.new("RGB", dimensions, "green").save(cover)
    calls = []
    cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2026, {".png"},
        SimpleNamespace(get=lambda *_args: None, set=lambda *_args: None), "Tests/1.0",
        cover_selection_origin="user", reject_if_user_controlled=True,
        selected_cover_path=str(cover),
        search_remote_cover_func=lambda **kwargs: (calls.append(kwargs) or None, []),
    )
    assert len(calls) == searches


@pytest.mark.parametrize("dimensions,downloaded_expected", [((1999, 2000), False), ((2000, 2000), True), ((2000, 1999), False)])
def test_one_off_repair_target_validates_decoded_candidate_edges(tmp_path, monkeypatch, dimensions, downloaded_expected):
    from music_app.services import cover_refresh_policy

    monkeypatch.setattr(cover_refresh_policy, "AUTOMATIC_COVER_REPAIR_MIN_EDGE", 2000)
    folder = tmp_path / "Album"
    folder.mkdir()
    cover = folder / "cover.png"
    Image.new("RGB", (640, 640), "green").save(cover)
    original = cover.read_bytes()
    raw = io.BytesIO()
    Image.new("RGB", dimensions, "blue").save(raw, format="PNG")
    candidate = CoverCandidate(source="apple", url="https://images.example/claimed-2000.png",
        raw_bytes=raw.getvalue(), width=2000, height=2000, score=0.99, matched_artist="Artist", matched_album="Album")
    selected, downloaded, _detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2026, {".png", ".jpg"},
        SimpleNamespace(get=lambda *_args: None, set=lambda *_args: None), "Tests/1.0",
        cover_selection_origin="user", reject_if_user_controlled=True,
        selected_cover_path=str(cover), search_remote_cover_func=lambda **_kwargs: (candidate, []),
        automatic_write_guard=lambda write_action, **_kwargs: write_action(),
    )
    assert downloaded is downloaded_expected
    if downloaded:
        with Image.open(selected) as image:
            assert image.size == dimensions
    else:
        assert selected == cover
        assert cover.read_bytes() == original


def test_one_off_repair_target_keeps_explicit_1200_selection_satisfactory(tmp_path, monkeypatch):
    from music_app.services import cover_refresh_policy

    monkeypatch.setattr(cover_refresh_policy, "AUTOMATIC_COVER_REPAIR_MIN_EDGE", 2000)
    folder = tmp_path / "Album"
    folder.mkdir()
    cover = folder / "cover.png"
    Image.new("RGB", (1200, 1200), "green").save(cover)
    _selected, downloaded, _detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2026, {".png"},
        SimpleNamespace(get=lambda *_args: None, set=lambda *_args: None), "Tests/1.0",
        cover_selection_origin="user", cover_selection_provenance="explicit", reject_if_user_controlled=True,
        selected_cover_path=str(cover), search_remote_cover_func=lambda **_kwargs: pytest.fail("explicit selection ignored"),
    )
    assert downloaded is False
