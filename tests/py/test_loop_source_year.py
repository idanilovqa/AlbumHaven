"""Saved loop years come only from their authorized source album."""
import pytest
from tests.py.test_loop_reorder import scoped_store, scope_args
from music_app.services.loops import project_loop_for_client


def attach_album(store, scope, year):
    with store["connect"]() as connection:
        album = connection.execute(
            "insert into library.local_albums(library_id,album_key,title,release_year) values(%s,%s,%s,%s) returning id",
            (scope["library_id"], "source-album", "Source Album", year),
        ).fetchone()["id"]
        connection.execute("update library.local_tracks set album_id=%s where id=%s", (album, scope["track_id"]))
    return album


def forge_year(store):
    with store["connect"]() as connection:
        connection.execute(
            "update app.saved_loops set metadata=jsonb_set(metadata,'{source_payload,year}','9999'::jsonb) where account_id=%s and library_id=%s",
            tuple(scope_args(store["own"]).values()),
        )


def test_known_source_year_overrides_metadata_across_nested_and_order_snapshots(scoped_store):
    store = scoped_store
    args = scope_args(store["own"])
    attach_album(store, store["own"], 2026)
    forge_year(store)
    child = store["adapter"].add_scoped_loop(**args, item={
        "id": "nested", "parent_loop_id": "a", "start_seconds": 1,
        "end_seconds": 3, "name": "Nested", "path": "owned-output", "year": 1777,
    })
    assert project_loop_for_client(child)["year"] == 2026
    rows = store["adapter"].load_scoped_loops(**args)
    assert all(project_loop_for_client(row)["year"] == 2026 for row in rows if row["song_key"])
    assert "year" not in next(row for row in rows if not row["song_key"])
    snapshot = store["adapter"].reorder_scoped_loops(
        **args, song_key=store["own"]["song_key"], expected_revision=1,
        ordered_ids=["a", "b", "nested"],
    )
    assert all(row["year"] == 2026 for row in snapshot["loops"])
    removed, remaining = store["adapter"].delete_scoped_loop(**args, loop_id="nested")
    assert removed and all(row["year"] == 2026 for row in remaining if row["song_key"])


@pytest.mark.parametrize("year", [None, 0, -1])
def test_unknown_source_year_is_omitted_despite_forged_saved_metadata(scoped_store, year):
    store = scoped_store
    attach_album(store, store["own"], year)
    forge_year(store)
    assert all("year" not in project_loop_for_client(row)
               for row in store["adapter"].load_scoped_loops(**scope_args(store["own"])))


def test_foreign_album_cannot_supply_year_for_owned_track(scoped_store):
    store = scoped_store
    foreign_album = attach_album(store, store["other_actor"], 1984)
    with store["connect"]() as connection:
        connection.execute("update library.local_tracks set album_id=%s where id=%s",
                           (foreign_album, store["own"]["track_id"]))
    forge_year(store)
    assert all("year" not in project_loop_for_client(row)
               for row in store["adapter"].load_scoped_loops(**scope_args(store["own"])))
