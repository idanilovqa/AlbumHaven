"""Canonical own-address identity seeds, including overlapping path winners."""

from copy import deepcopy
import json
import os

import pytest

from music_app.services.library import _track_album_container
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.problematic_files_projection import _duplicate_sources_from_rows
from music_app.services.problematic_projection_postgres import PostgresProblematicProjectionRepository
from tests.e2e.support import isolatedPostgres
from tests.py.test_problematic_files_projection import _topology_unit_main_records, _topology_unit_row
from tests.py.test_problematic_projection_postgres import _main_search_claimed_v2, live_projection_database
from tests.py.test_problematic_topology_closure_postgres import _run_topology_worker


def _overlap_rows(case, *, native_aliases=False):
    base = "C:/TopologyDerived"
    foreign_base = base.lower() if native_aliases else base

    def row(path, identity, key, title, artist, album_id, root_id, number=1):
        value = _topology_unit_row(path, identity, original_key=key, title=title,
                                   artist=artist, album_id=album_id, number=number)
        value["file_library_root_id"] = str(root_id)
        return value

    rows = [row(f"{base}/P/one.flac", 1, "a-owner", "Origin A", "Artist A", 71, 1),
            row(f"{base}/P/two.flac", 2, "a-owner", "Origin A", "Artist A", 71, 1, 2)]
    if case == "candidate-only":
        rows.extend([
            row(f"{base}/Q/three.flac", 3, "b-candidate", "Origin A", "Artist A", 72, 1),
            row(f"{foreign_base}/q/three.flac" if native_aliases else f"{base}/Q/three.flac",
                4, "z-winner", "Unrelated C", "Artist C", 73, 2),
            row(f"{foreign_base}/R/four.flac", 5, "z-winner", "Unrelated C", "Artist C", 73, 2),
        ])
    else:
        rows.extend([
            row(f"{foreign_base}/p/one.flac" if native_aliases else f"{base}/P/one.flac",
                3, "z-winner", "Winner B", "Artist B", 72, 2),
            row(f"{foreign_base}/p/two.flac" if native_aliases else f"{base}/P/two.flac",
                4, "z-winner", "Winner B", "Artist B", 72, 2, 2),
            row(f"{foreign_base}/Q/three.flac", 5, "z-winner", "Winner B", "Artist B", 72, 2),
        ])
        if case == "earlier-foreign-path":
            rows.append(row(f"{foreign_base}/00-before/early.flac", 6,
                            "z-winner", "Winner B", "Artist B", 72, 2))
    return rows


@pytest.mark.parametrize("case", ["derived-own", "earlier-foreign-path", "candidate-only"])
def test_canonical_global_path_winner_controls_only_original_own_identity(case):
    rows = _overlap_rows(case)
    topology = _duplicate_sources_from_rows(rows)
    owner = topology["a-owner"]
    assert owner["has_duplicate_files"] is (case == "derived-own")
    if case == "derived-own":
        sources = owner["duplicate_sources"]
        assert len(sources) == 2
        references = [track["track_ref"] for source in sources for track in source["tracks"]]
        assert set(references) == {"topology-track-3", "topology-track-4", "topology-track-5"}
        assert len(references) == 3
    else:
        assert owner["duplicate_sources"] == []
        if case == "candidate-only":
            assert topology["b-candidate"]["has_duplicate_files"] is True
    replayed = rows + [deepcopy(row) for row in rows if row["album_key"] == "a-owner"] * 3
    assert _duplicate_sources_from_rows(replayed)["a-owner"]["duplicate_sources"] == owner["duplicate_sources"]


def _seed_native_overlap(db, rows):
    with isolatedPostgres._connect(db.setup_url) as connection:
        roots = {}
        for identity, path in (("1", "C:/TopologyDerived"), ("2", "c:/topologyderived")):
            roots[identity] = connection.execute(
                "insert into library.library_roots(library_id,root_path,root_kind,is_active) "
                "values(%s,%s,'main',true) returning id", (db.library_id, path),
            ).fetchone()["id"]
        albums = {}
        for value in rows:
            key = value["album_key"]
            if key not in albums:
                artist = connection.execute(
                    "insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id",
                    (db.library_id, f"derived-{key}", value["artist_name"]),
                ).fetchone()["id"]
                album = connection.execute(
                    "insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata) "
                    "values(%s,%s,%s,%s,1988,%s::jsonb) returning id",
                    (db.library_id, artist, key, value["album_title"], json.dumps(value["album_metadata"])),
                ).fetchone()["id"]
                albums[key] = (artist, album)
            artist, album = albums[key]
            track = connection.execute(
                "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,track_number) "
                "values(%s,%s,%s,%s,%s,%s) returning id",
                (db.library_id, album, artist, value["track_key"], value["track_title"], value["track_number"]),
            ).fetchone()["id"]
            connection.execute(
                "insert into library.local_track_files(track_id,library_root_id,private_path,metadata) "
                "values(%s,%s,%s,%s::jsonb)",
                (track, roots[value["file_library_root_id"]], value["file_private_path"],
                 json.dumps({"scan_cache": {"file_entry": value["file_entry"]}})),
            )
        assert connection.execute(
            "select count(*) as count,count(distinct private_path) as literal_paths "
            "from library.local_track_files",
        ).fetchone() == {"count": len(rows), "literal_paths": len(rows)}
    return albums["a-owner"][1]


@pytest.mark.skipif(
    os.path.normcase("C:/Alias") != os.path.normcase("c:/alias"),
    reason="native case aliases overlap only under the canonical Windows normcase policy",
)
@pytest.mark.parametrize("case", ["derived-own", "earlier-foreign-path", "candidate-only"])
def test_live_own_address_global_identity_seed_matches_native_canonical_oracle(
    live_projection_database, monkeypatch, case,
):
    from music_app.services.jobs.models import JobState

    db = live_projection_database
    rows = _overlap_rows(case, native_aliases=True)
    assert len({row["file_private_path"] for row in rows}) == len(rows)
    assert len({os.path.normcase(row["file_private_path"]) for row in rows}) < len(rows)
    owner_id = _seed_native_overlap(db, rows)
    browse = PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url})
    native_rows = browse._load_problematic_file_rows(candidate_summary=False)
    assert len(native_rows) == len(rows)
    assert all(not row.get("local_album_membership_problem") for row in native_rows)
    canonical = _duplicate_sources_from_rows(native_rows)
    assert canonical["a-owner"]["has_duplicate_files"] is (case == "derived-own")
    if case == "derived-own":
        assert len(canonical["a-owner"]["duplicate_sources"]) == 2
    expected = next(record for record in _topology_unit_main_records(native_rows).values()
                    if record["summary"]["key"] == "a-owner")
    assert ("Duplicate files" in expected["summary"]["problem_reasons"]) is (case == "derived-own")

    worker, claim, build, _now = _main_search_claimed_v2(db)
    complete = worker.complete_claimed_source_group
    snapshots = []

    def capture_first_owner(**kwargs):
        if kwargs["group_key"] == ("album", owner_id):
            with isolatedPostgres._connect(db.setup_url) as connection:
                definitions = connection.execute(
                    "select group_kind,group_identity,fact_value->'key' as key "
                    "from ops.problematic_projection_group_facts where job_id=%s and attempt=%s "
                    "and revision=%s and fact_kind='topology_definition' order by group_kind,group_identity",
                    (claim.job_id, claim.attempt, build.revision),
                ).fetchall()
                references = connection.execute(
                    "select fact_value from ops.problematic_projection_group_facts "
                    "where job_id=%s and attempt=%s and revision=%s and group_kind='album' "
                    "and group_identity=%s and fact_kind='topology_reference'",
                    (claim.job_id, claim.attempt, build.revision, str(owner_id)),
                ).fetchall()
                ranks = connection.execute(
                    "select group_identity,fact_value from ops.problematic_projection_group_facts "
                    "where job_id=%s and attempt=%s and revision=%s "
                    "and group_kind='topology_address' and fact_kind='topology_own_rank_result'",
                    (claim.job_id, claim.attempt, build.revision),
                ).fetchall()
                rank_certificates = connection.execute(
                    "select count(*) as count from ops.problematic_projection_source_staging "
                    "where job_id=%s and attempt=%s and revision=%s "
                    "and source_kind='topology_certificate' and group_identity like 'rank:%%'",
                    (claim.job_id, claim.attempt, build.revision),
                ).fetchone()["count"]
                snapshots.append((definitions, references, ranks, rank_certificates))
        return complete(**kwargs)

    monkeypatch.setattr(worker, "complete_claimed_source_group", capture_first_owner)
    outcome = _run_topology_worker(worker, claim)
    assert outcome.next_state is JobState.SUCCEEDED
    page = PostgresProblematicProjectionRepository(database_url=db.app_url).read_page(
        library_id=db.library_id, limit=200,
    )
    actual = next(item for item in page.items if item["key"] == "a-owner")
    assert actual["problem_reasons"] == expected["summary"]["problem_reasons"]
    assert actual.get("root_provenance") == expected["summary"].get("root_provenance")
    detail = browse.build_problematic_file_detail_payload(
        projection_id=expected["summary"]["projection_id"],
    )
    assert detail is not None
    assert detail.get("duplicate_sources", []) == expected["detail"].get("duplicate_sources", [])
    assert detail.get("root_provenance") == expected["detail"].get("root_provenance")
    with isolatedPostgres._connect(db.setup_url) as connection:
        document = connection.execute(
            "select normalized_text from ops.problematic_projection_search_facts where library_id=%s "
            "and revision=%s and item_key=%s and fact_kind='main_search' order by semantic_child_identity",
            (db.library_id, build.revision, expected["summary"]["projection_id"]),
        ).fetchall()
    assert [row["normalized_text"] for row in document] == [expected["document"]]
    assert len(snapshots) == 1
    definitions, references, ranks, rank_certificates = snapshots[0]
    rank_nodes = [row["group_identity"] for row in definitions
                  if row["group_kind"] == "topology_address" and row["key"] == ["rank", "z-winner"]]
    assert len(rank_nodes) == 1
    rank = [row["fact_value"] for row in ranks if row["group_identity"] == rank_nodes[0]]
    foreign_paths = [row["file_private_path"] for row in native_rows if row["album_key"] == "z-winner"]
    assert len(rank) == 1
    assert rank[0]["rank"] == list(min((path.casefold(), path, "z-winner") for path in foreign_paths))
    assert rank[0]["input_count"] == len(foreign_paths)
    assert rank_certificates == 0
    wanted = ["identity", "artist b", "winner b", 1988] if case == "derived-own" else ["identity", "artist a", "origin a", 1988]
    nodes = [row["group_identity"] for row in definitions
             if row["group_kind"] == "topology_identity" and row["key"] == wanted]
    assert len(nodes) == 1
    assert sum(row["fact_value"].get("node_kind") == "topology_identity"
               and row["fact_value"].get("node_identity") == nodes[0] for row in references) == 1
    if case != "derived-own":
        forbidden = ["identity", "artist c", "unrelated c", 1988] if case == "candidate-only" else ["identity", "artist b", "winner b", 1988]
        assert not any(row["key"] == forbidden for row in definitions)
    addresses = [row["key"] for row in definitions if row["group_kind"] == "topology_address"]
    if case == "earlier-foreign-path":
        earlier = os.path.normcase(_track_album_container(rows[-1]["file_private_path"]))
        assert ["address", earlier] not in addresses
    if case == "candidate-only":
        q = os.path.normcase(_track_album_container(rows[2]["file_private_path"]))
        r = os.path.normcase(_track_album_container(rows[-1]["file_private_path"]))
        assert ["address", q] in addresses
        assert ["address", r] not in addresses
