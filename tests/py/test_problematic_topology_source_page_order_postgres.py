"""Ordinary source pages must arrive in their authoritative receipt order."""

import json
import os
from pathlib import Path

import pytest

from music_app.services.problematic_projection_postgres import ProblematicProjectionStorageError
from tests.e2e.support import isolatedPostgres
from tests.py.test_problematic_projection_postgres import _main_search_claimed_v2, live_projection_database
from tests.py.test_problematic_topology_shared_work_postgres import _seed_shared_parent


@pytest.mark.parametrize("groups", [8, 16])
def test_live_ordinary_source_page_matches_authoritative_offer_order(live_projection_database, tmp_path, groups):
    db = live_projection_database
    _seed_shared_parent(db, tmp_path / "Shared", groups)
    worker, claim, build, now = _main_search_claimed_v2(db)
    page = worker.load_claimed_source_page(
        claim=claim, build=build, limit=32, child_limit=100, now=now,
    )
    assert len(page.chunks) == 2
    assert page.chunks[0].group_key == page.chunks[1].group_key
    with isolatedPostgres._connect(db.setup_url) as connection:
        offers = connection.execute(
            "select group_kind,group_identity,semantic_child_identity,fact_value "
            "from ops.problematic_projection_group_facts where job_id=%s and attempt=%s "
            "and revision=%s and projection_id='topology' and fact_kind='topology_source_offer' "
            'order by group_identity::bigint,group_kind collate "C",semantic_child_identity collate "C"',
            (claim.job_id, claim.attempt, build.revision),
        ).fetchall()
        returned = []
        for chunk in page.chunks:
            receipt = connection.execute(
                "select ops.problematic_projection_source_offer_key(%s,%s) as semantic_child_identity, "
                "encode(sha256(convert_to(ops.problematic_projection_source_digest_value(%s::jsonb)::text,"
                "'UTF8')),'hex') as fingerprint",
                (chunk.cursor[2], str(chunk.cursor[3]), json.dumps(chunk.rows, ensure_ascii=False)),
            ).fetchone()
            returned.append({"group_kind": chunk.group_key[0], "group_identity": str(chunk.group_key[1]),
                             "semantic_child_identity": receipt["semantic_child_identity"],
                             "fact_value": {"source_kind": chunk.cursor[0], "source_identity": str(chunk.cursor[1]),
                                            "child_kind": chunk.cursor[2], "child_identity": str(chunk.cursor[3]),
                                            "count": len(chunk.rows), "complete": chunk.complete,
                                            "fingerprint": receipt["fingerprint"]}})
    scope = os.environ.get("TOPOLOGY_NATIVE_SCOPE")
    if scope:
        Path(scope, f"ordinary-source-page-{groups}.json").write_text(
            json.dumps({"offers": offers, "returned": returned,
                        "payloads": [chunk.rows for chunk in page.chunks]}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    # Exercise the actual receipt boundary before an order assertion can mask it.
    for chunk in page.chunks:
        arguments = dict(claim=claim, build=build, group_key=chunk.group_key,
                         source_cursor=chunk.cursor, rows=chunk.rows, complete=chunk.complete, now=now)
        worker.stage_claimed_source_chunk(**arguments)
        worker.stage_claimed_source_chunk(**arguments)
        with pytest.raises(ProblematicProjectionStorageError) as rejected:
            worker.stage_claimed_source_chunk(**{**arguments, "complete": not chunk.complete})
        assert rejected.value.__cause__.sqlstate == "55000"
        assert "projection source page differs from authoritative cursor" in str(rejected.value.__cause__)
    assert returned == offers
