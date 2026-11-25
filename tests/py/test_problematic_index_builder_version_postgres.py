"""Owner (2026-11-24, DUP-COPY-FOLDERS): opening a Problematic Files entry shows every problem type the list
and its filter gave it, as an album label or in the per-track table.

A deployed index built before the strict multi-album folder rule (2026-11-24) still listed "Mixed album
metadata in one folder" for folders the rule no longer calls mixed, while the detail, built on request by
the current rules, had no such label. The index records the builder version that wrote its items; the
deploy step must rebuild items written by an older builder. Synthetic layout on a throwaway database only."""
import json

from tests.e2e.support import isolatedPostgres
from tests.py.test_copy_folder_duplicates_postgres import _seed_copy_folder_library
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401
from tests.py.test_problematic_albums import _indexed_problematic_items, _ready_problematic_index

MIXED = "Mixed album metadata in one folder"
# The builder version the deployed index was written by before the strict multi-album rule.
PRE_STRICT_RULE_BUILDER = "1"


def _detail_reasons(detail):
    return {row["reason"] for row in detail.get("album_problem_rows") or []} | {
        reason for row in detail.get("track_problem_rows") or [] for reason in row.get("reasons") or []
    }


def test_live_the_deploy_step_rebuilds_items_an_older_builder_wrote(watcher_repair_inventory):
    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    _seed_copy_folder_library(fixture)
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(database_url)
    problematic_index.wait_for_background_work()
    # The deployed index as the earlier builder wrote it: the copies' entry also listed the folder as mixed.
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        stored = connection.execute("select item_key, item from library.problematic_index_items").fetchall()
        assert stored, "the copy folder lists entries"
        for row in stored:
            item = dict(row["item"])
            item["problem_reasons"] = [*(item.get("problem_reasons") or []), MIXED]
            connection.execute(
                "update library.problematic_index_items set item = %s::jsonb where item_key = %s",
                (json.dumps(item), row["item_key"]),
            )
        connection.execute("update library.problematic_index_state set builder_version = %s",
                           (PRE_STRICT_RULE_BUILDER,))

    repository = PostgresLibraryBrowseRepository({**fixture.config, problematic_index.ENABLED_KEY: "1"})
    problematic_index.prepare_for_serving(repository)

    listed = _indexed_problematic_items(database_url, limit=50)
    assert listed
    for item in listed:
        detail = repository.build_problematic_file_detail_payload(item["key"])
        assert detail is not None, f"{item['name']}: a listed entry opens"
        assert set(item["problem_reasons"]) == _detail_reasons(detail), (
            f"{item['name']}: the list and the opened entry show the same problem types"
        )
