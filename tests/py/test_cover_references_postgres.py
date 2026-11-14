"""Opaque cover references against an explicitly isolated, migrated Postgres library."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from threading import Barrier

import psycopg
import pytest
from PIL import Image

from music_app.services.cover_references import REFERENCE_PATTERN, CoverReferenceStore
from music_app.services.current_actor import CapabilityGrant, LibraryRelationship
from tests.e2e.support import isolatedPostgres
from tests.py.asgi_testing import create_test_asgi_app, run_asgi_request
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (fixture)
from tests.py.test_playback_native_postgres import playback_inventory  # noqa: F401 (fixture)

BACKFILL = Path(__file__).resolve().parents[2] / "migrations" / "postgres" / "0201_backfill_cover_references.sql"


def connect(url, **_kwargs):
    return isolatedPostgres._connect(url)


def store_for(fixture, **config):
    return CoverReferenceStore({**fixture.config, **config}, connect=connect)


def library_id(fixture) -> int:
    return fixture.actor.current_library_id


def image(path: Path, color=(40, 90, 160)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (64, 64), color).save(path, format="JPEG")
    return path


def test_a_reference_is_minted_once_and_survives_restart_and_re_registration(playback_inventory):
    fixture = playback_inventory
    cover, candidate = (str(Path(fixture.paths[0]).parent / name) for name in ("cover.jpg", "back.jpg"))
    first = store_for(fixture).references_for(library_id(fixture), {cover: "cover", candidate: "candidate"})

    assert set(first) == {cover, candidate}
    assert all(REFERENCE_PATTERN.fullmatch(reference) for reference in first.values())
    assert first[cover] != first[candidate]
    # A restarted process (empty caches) and a rescan that names the files again keep them.
    restarted = store_for(fixture)
    assert restarted.references_for(library_id(fixture), {cover: "cover", candidate: "candidate"}) == first
    assert restarted.resolve(library_id(fixture), first[cover]) == (cover, "cover")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows = connection.execute(
            "select count(*) as count from library.cover_references where private_path = any(%s)", ([cover, candidate],)
        ).fetchone()
    assert rows["count"] == 2


def test_a_candidate_widens_to_a_cover_and_never_narrows_back(playback_inventory):
    fixture = playback_inventory
    path = str(Path(fixture.paths[0]).parent / "Art" / "front.jpg")
    store = store_for(fixture)
    reference = store.references_for(library_id(fixture), {path: "candidate"})[path]
    assert store.resolve(library_id(fixture), reference) == (path, "candidate")

    assert store.references_for(library_id(fixture), {path: "cover"}) == {path: reference}
    assert store_for(fixture).references_for(library_id(fixture), {path: "candidate"}) == {path: reference}
    assert store_for(fixture).resolve(library_id(fixture), reference) == (path, "cover")


def test_references_do_not_cross_libraries_and_malformed_ones_never_reach_the_database(playback_inventory):
    fixture = playback_inventory
    path = str(Path(fixture.paths[0]).parent / "cover.jpg")
    store = store_for(fixture)
    reference = store.references_for(library_id(fixture), {path: "cover"})[path]

    assert store.resolve(library_id(fixture) + 100_000, reference) is None
    assert store_for(fixture).resolve(library_id(fixture) + 100_000, reference) is None
    assert store.paths_for(library_id(fixture) + 100_000, {reference}) == {}
    for malformed in ("", "short", "../../etc/passwd/0000000", reference + "x", "a" * 21 + "!"):
        assert store.resolve(library_id(fixture), malformed) is None


def test_a_browse_only_instance_names_only_stored_covers_and_never_writes(playback_inventory):
    fixture = playback_inventory
    stored, unknown = (str(Path(fixture.paths[0]).parent / name) for name in ("cover.jpg", "unnamed.jpg"))
    reference = store_for(fixture).references_for(library_id(fixture), {stored: "cover"})[stored]
    browse_only = store_for(fixture, SHARED_LIBRARY_BROWSE_ONLY=True)

    assert browse_only.references_for(library_id(fixture), {stored: "cover", unknown: "cover"}) == {stored: reference}
    assert browse_only.is_named_cover(library_id(fixture), stored) is True
    assert browse_only.is_named_cover(library_id(fixture), unknown) is False
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute(
            "select 1 from library.cover_references where private_path = %s", (unknown,)
        ).fetchone() is None


def test_concurrent_first_uses_of_one_file_share_one_reference(playback_inventory):
    fixture = playback_inventory
    path = str(Path(fixture.paths[0]).parent / "concurrent.jpg")
    barrier = Barrier(6)

    def name():
        barrier.wait(timeout=10)
        return store_for(fixture).references_for(library_id(fixture), {path: "cover"})[path]

    with ThreadPoolExecutor(max_workers=6) as pool:
        references = set(pool.map(lambda _index: name(), range(6)))

    assert len(references) == 1


def test_the_runtime_role_cannot_delete_or_re_point_a_reference(playback_inventory):
    fixture = playback_inventory
    path = str(Path(fixture.paths[0]).parent / "cover.jpg")
    reference = store_for(fixture).references_for(library_id(fixture), {path: "cover"})[path]

    for statement in (
        "delete from library.cover_references where reference = %s",
        "update library.cover_references set private_path = 'C:/elsewhere.jpg' where reference = %s",
        "update library.cover_references set library_id = library_id + 1 where reference = %s",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with isolatedPostgres._connect(fixture.runtime_url) as connection:
                connection.execute(statement, (reference,))


def test_backfill_names_stored_covers_without_touching_any_cover_or_provenance_column(playback_inventory):
    fixture = playback_inventory
    folder = Path(fixture.paths[0]).parent
    explicit, inherited = str(folder / "cover.jpg"), str(folder / "inherited.jpg")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        album = connection.execute(
            "select id from library.local_albums where library_id = %s order by id limit 1", (library_id(fixture),)
        ).fetchone()
        connection.execute(
            """update library.local_albums set cover_path = %s, metadata = metadata || jsonb_build_object(
                 'cover_selection_origin', 'automatic', 'cover_selection_provenance', 'unknown',
                 'remote_cover_url', null) where id = %s""",
            (explicit, album["id"]),
        )
        connection.execute(
            """update library.local_tracks set metadata = metadata || jsonb_build_object('cover_path', %s::text)
               where album_id = %s""",
            (inherited, album["id"]),
        )
        before = connection.execute(
            """select (select jsonb_agg(to_jsonb(a) order by a.id) from library.local_albums a) as albums,
                      (select jsonb_agg(to_jsonb(t) order by t.id) from library.local_tracks t) as tracks,
                      (select jsonb_agg(to_jsonb(f) order by f.id) from library.local_track_files f) as files"""
        ).fetchone()

    for _run in range(2):
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            connection.execute(BACKFILL.read_text(encoding="utf-8"))

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        after = connection.execute(
            """select (select jsonb_agg(to_jsonb(a) order by a.id) from library.local_albums a) as albums,
                      (select jsonb_agg(to_jsonb(t) order by t.id) from library.local_tracks t) as tracks,
                      (select jsonb_agg(to_jsonb(f) order by f.id) from library.local_track_files f) as files"""
        ).fetchone()
        named = connection.execute(
            "select private_path, kind from library.cover_references where library_id = %s order by private_path",
            (library_id(fixture),),
        ).fetchall()
    assert after == before
    assert [(row["private_path"], row["kind"]) for row in named] == sorted([(explicit, "cover"), (inherited, "cover")])


@pytest.fixture
def cover_app(playback_inventory, tmp_path, monkeypatch):
    fixture = playback_inventory
    asgi_app = create_test_asgi_app(tmp_path, monkeypatch)
    asgi_app.state.config.update(fixture.config)
    asgi_app.state.config["MUSIC_DIR"] = fixture.config["MUSIC_DIR"]
    asgi_app.state.cover_reference_store = store_for(fixture)
    folder = Path(fixture.paths[0]).parent
    cover, candidate = image(folder / "cover.jpg"), image(folder / "Art" / "back.jpg", (200, 40, 40))
    references = asgi_app.state.cover_reference_store.references_for(
        library_id(fixture), {str(cover): "cover", str(candidate): "candidate"}
    )
    return asgi_app, fixture, references[str(cover)], references[str(candidate)], cover


def as_actor(asgi_app, actor):
    asgi_app.state.current_actor_resolver = type("Resolver", (), {"resolve": lambda _self, _token: actor})()


def member(fixture, *actions):
    library = library_id(fixture)
    return replace(
        fixture.actor, account_id=fixture.actor.account_id + 50_000, is_bootstrap_owner=False,
        library_relationships=(LibraryRelationship(library, "member", False),),
        capability_grants=tuple(CapabilityGrant(action, "library", library) for action in actions),
    )


def test_the_owner_opens_covers_and_candidates_by_reference_with_private_caching(cover_app):
    asgi_app, fixture, cover_reference, candidate_reference, cover = cover_app
    as_actor(asgi_app, fixture.actor)

    status, headers, body = run_asgi_request(asgi_app, "GET", f"/cover/{cover_reference}", query={"v": "r1"})
    assert status == 200 and body == cover.read_bytes()
    assert headers["cache-control"] == "private, max-age=31536000, immutable"
    status, headers, _body = run_asgi_request(asgi_app, "GET", f"/cover/{cover_reference}")
    assert status == 200 and headers["cache-control"] == "private, max-age=300"
    status, _headers, _body = run_asgi_request(asgi_app, "GET", f"/cover/{candidate_reference}")
    assert status == 200


def test_a_listener_sees_covers_but_not_lookup_candidates_and_a_viewer_gets_only_pixels(cover_app):
    asgi_app, fixture, cover_reference, candidate_reference, cover = cover_app
    as_actor(asgi_app, member(fixture, "library.artwork.read", "library.media.read"))

    assert run_asgi_request(asgi_app, "GET", f"/cover/{cover_reference}")[0] == 200
    assert run_asgi_request(asgi_app, "GET", f"/cover/{candidate_reference}")[0] == 404

    as_actor(asgi_app, member(fixture, "library.artwork.read"))
    status, headers, body = run_asgi_request(asgi_app, "GET", f"/cover/{cover_reference}")
    assert status == 200 and headers["content-type"] == "image/png" and body != cover.read_bytes()
    assert headers["cache-control"] == "private, no-store"


def test_unknown_foreign_and_unnamed_requests_are_the_same_pathless_404(cover_app, tmp_path):
    asgi_app, fixture, cover_reference, _candidate, _cover = cover_app
    stranger = replace(member(fixture, "library.artwork.read", "library.media.read"),
                       current_library_id=library_id(fixture) + 100_000,
                       library_relationships=(LibraryRelationship(library_id(fixture) + 100_000, "member", False),))
    audio = fixture.paths[0]

    responses = []
    as_actor(asgi_app, stranger)
    responses.append(run_asgi_request(asgi_app, "GET", f"/cover/{cover_reference}"))
    as_actor(asgi_app, fixture.actor)
    responses.append(run_asgi_request(asgi_app, "GET", "/cover/UnknownReference000000"))
    responses.append(run_asgi_request(asgi_app, "GET", "/cover/unavailable"))
    # Today's arbitrary in-root read is closed: an audio file was never named as a cover.
    responses.append(run_asgi_request(asgi_app, "GET", "/cover", query={"path": audio}))

    for status, _headers, body in responses:
        assert status == 404
        assert b"Music" not in body and str(tmp_path).encode() not in body


def test_the_legacy_route_still_serves_a_named_cover_until_it_is_retired(cover_app):
    asgi_app, fixture, _reference, _candidate, cover = cover_app
    as_actor(asgi_app, fixture.actor)

    status, headers, body = run_asgi_request(asgi_app, "GET", "/cover", query={"path": str(cover)})

    assert status == 200 and body == cover.read_bytes()
    assert headers["cache-control"] == "private, max-age=300"
