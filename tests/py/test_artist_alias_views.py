from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from music_app.services import artist_alias_views


def test_enrich_casefold_artist_alias_views_skips_rebuild_without_explicit_config(monkeypatch):
    albums = [
        SimpleNamespace(album_artist="Mono", artists=["Mono"]),
        SimpleNamespace(album_artist="MONO", artists=["MONO"]),
    ]

    def fail_rebuild(*_args, **_kwargs):
        raise AssertionError("alias rebuild requires explicit config")

    monkeypatch.setattr(artist_alias_views, "build_artist_alias_views", fail_rebuild)

    alias_to_canonical, canonical_to_aliases = artist_alias_views.enrich_casefold_artist_alias_views(
        albums,
        {},
        {},
        allow_rebuild_alias_views=True,
        config=None,
    )

    assert alias_to_canonical["MONO"] == "Mono"
    assert set(canonical_to_aliases["Mono"]) == {"Mono", "MONO"}


def test_enrich_casefold_artist_alias_views_uses_explicit_config_for_rebuild(monkeypatch):
    albums = [SimpleNamespace(album_artist="Mono", artists=["Mono"])]
    config = {"MUSIC_DIR": Path("C:/Explicit/Music")}
    root_config_calls: list[object] = []
    rebuild_calls: list[tuple[list[object], Path]] = []

    def fake_get_primary_music_root(target_config):
        root_config_calls.append(target_config)
        return target_config["MUSIC_DIR"]

    def fake_build_artist_alias_views(target_albums, music_root):
        rebuild_calls.append((list(target_albums), music_root))
        return {
            "canonical_to_aliases": {"Mono": ["Mono", "MONO"]},
        }

    monkeypatch.setattr(artist_alias_views, "get_primary_music_root", fake_get_primary_music_root)
    monkeypatch.setattr(artist_alias_views, "build_artist_alias_views", fake_build_artist_alias_views)

    alias_to_canonical, canonical_to_aliases = artist_alias_views.enrich_casefold_artist_alias_views(
        albums,
        {},
        {},
        allow_rebuild_alias_views=True,
        config=config,
    )

    assert root_config_calls == [config]
    assert rebuild_calls == [(albums, config["MUSIC_DIR"])]
    assert alias_to_canonical["MONO"] == "Mono"
    assert set(canonical_to_aliases["Mono"]) == {"Mono", "MONO"}
