"""Dormant artwork storage contracts against the admitted real PostgreSQL fixture.

These tests use the real owner/session/policy transactions, source-provenance
tables, resolver, descriptor acquisition, Pillow sanitizer and SQL functions.
No configuration module, fake connection, authority substitute or public-artwork
service is installed. Wrappers observe actual statements or perform explicit
between-transaction race mutations. The fixture's trusted teardown is synthetic
DB maintenance only; it is not a production retention or runtime-delete API.
"""
from contextlib import contextmanager
from dataclasses import asdict
from datetime import timedelta
import json
from pathlib import Path
from uuid import uuid4

from PIL import Image
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from tests.py.postgres_runtime_role_contract import assert_runtime_role

from music_app.services import album_top_artwork_preparation as preparation_module
from music_app.services.album_top_artwork_preparation import TopArtworkPreparationService
from music_app.services.owned_album_tops import ACCESS, BROWSE, ITEMS, MANAGE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.public_top_artwork_acquisition import capture_artwork, describe_artwork_source
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_album_top_collaboration_postgres import member, new_session, write


CONTEXT = "a" * 64
ARTWORK = "library.artwork.read"
ZERO = "00000000-0000-0000-0000-000000000000"
RELATIONS = (
    "album_top_artwork_preparations", "album_top_artwork_preparation_items",
    "album_top_artwork_assets", "album_top_artwork_budgets",
)
START_SIGNATURE = "app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb)"
CLAIM_SIGNATURE = "app.claim_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid)"
COMPLETE_SIGNATURE = "app.complete_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[])"


def png_file(path, number=0):
    """Write an actual small PNG. No encoded fixtures or forged CapturedArtwork."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with Image.new("RGB", (32, 24), (number % 256, number // 256, 73)) as image:
        image.save(path, format="PNG")
    return path


class ArtworkCase:
    def __init__(self, database, directory):
        self.db = database
        self.directory = directory
        self.metadata_path = directory / "metadata"
        self.artwork_path = directory / "artwork"
        self.metadata_path.mkdir()
        self.artwork_path.mkdir()
        self.service = TopArtworkPreparationService(database.service)
        self.source_refs = []
        self.album_ids = []
        self.cover_paths = []
        self.catalog_refs = []
        connect = database.service._connect
        @contextmanager
        def bounded(*args, **kwargs):
            with connect(*args, **kwargs) as connection:
                connection.execute("set local lock_timeout='5s'")
                connection.execute("set local statement_timeout='20s'")
                yield connection
        database.service._connect = bounded
        with database.connect() as connection:
            self.metadata_root = self.root(connection, self.metadata_path)
            self.artwork_root = self.root(connection, self.artwork_path)
            # Runtime still reloads grants from SQL; a Python CurrentActor is not
            # a substitute for either of these persisted permissions.
            for action in ("capability.view", ARTWORK):
                connection.execute("""insert into app.capabilities
                    (account_id,capability_key,scope_kind,scope_id)
                    values(%s,%s,'library',%s) on conflict do nothing""",
                    (database.owner.account_id, action, database.library))

    def root(self, connection, path):
        return connection.execute("""insert into library.library_roots(library_id,root_path,metadata)
            values(%s,%s,'{}') returning id""", (self.db.library, str(path))).fetchone()["id"]

    def build(self, count=6, *, same_pixels=False, excluded=()):
        """Seed actual local metadata provenance, then admit through its owner.

        The persisted source/track/file shape is the existing source-choice SQL
        fixture's contract. Preparation calls the production selection_source
        helper over those rows; no capture/seal/source assertion is mocked.
        """
        db = self.db
        with db.connect() as connection:
            artist = connection.execute("select artist_id from library.local_albums where id=%s",
                                        (db.album_ids[0],)).fetchone()["artist_id"]
            for number in range(count):
                if number < len(db.album_ids):
                    album = db.album_ids[number]
                else:
                    album = connection.execute("""insert into library.local_albums
                        (library_id,artist_id,album_key,title,release_year,metadata)
                        values(%s,%s,%s,%s,2000,'{}') returning id""",
                        (db.library, artist, f"artwork:{db.token}:{number}",
                         f"Artwork album {number}")).fetchone()["id"]
                    db.album_ids.append(album)
                cover = png_file(self.artwork_path / f"cover-{number}.png", 0 if same_pixels else number)
                connection.execute("update library.local_albums set cover_path=%s where id=%s",
                                   (str(cover), album))
                source = str(uuid4())
                container = self.metadata_path / f"album-{number}"
                connection.execute("""insert into library.album_metadata_sources
                    (ref,library_id,local_album_id,library_root_id,container_identity,path_flavor,
                     capture_builder_version,state,title,artist,year,title_origin,artist_origin)
                    values(%s,%s,%s,%s,%s,'posix',1,'active',%s,'Synthetic artist',2000,
                           'tag_metadata','tag_metadata')""",
                    (source, db.library, album, self.metadata_root, str(container), f"Artwork album {number}"))
                track = connection.execute("""insert into library.local_tracks
                    (library_id,artist_id,album_id,track_key,title,disc_number,track_number,
                     duration_seconds,title_origin,artist_origin)
                    values(%s,%s,%s,%s,'Real source row',1,1,180,'tag_metadata','tag_metadata') returning id""",
                    (db.library, artist, album, f"artwork:{db.token}:{number}:track")).fetchone()["id"]
                connection.execute("""insert into library.local_track_files
                    (track_id,library_root_id,private_path,content_signature,metadata_source_ref,metadata)
                    values(%s,%s,%s,'synthetic',%s,'{}')""",
                    (track, self.metadata_root, str(container / "01.flac"), source))
                self.album_ids.append(album)
                self.source_refs.append(source)
                self.cover_paths.append(cover)
        for album in self.album_ids:
            ref = db.service.admit_inventory_album(db.context(), album_id=album)["album_ref"]
            self.catalog_refs.append(ref)
            if ref not in db.album_refs:
                db.album_refs.append(ref)
        self.top, _ = db.create(refs=self.catalog_refs)
        rows = db.read(self.top)["items"]
        self.items = [{"item_ref": row["ref"], "album_ref": row["catalog_ref"],
                       "selected_local_album_id": album, "selected_source_ref": source,
                       "include_artwork": number not in excluded}
                      for number, (row, album, source) in enumerate(zip(rows, self.album_ids, self.source_refs))]
        self.payload = {"revision": self.top["revision"], "request_key": str(uuid4()), "items": self.items}
        return self

    def start(self, **options):
        return self.service.start(self.db.context(), **{
            "top_ref": self.top["top_ref"], "payload": self.payload, "context_ref": CONTEXT, **options})

    def advance(self, status, *, actor=None, **options):
        return self.service.advance(self.db.context(actor), **{
            "top_ref": self.top["top_ref"], "preparation_ref": status["preparation_ref"],
            "top_revision_value": self.top["revision"], "preparation_revision": status["preparation_revision"],
            "request_key": str(uuid4()), "context_ref": CONTEXT, **options})

    def read(self, status, *, actor=None, **options):
        return self.service.read(self.db.context(actor), **{
            "top_ref": self.top["top_ref"], "preparation_ref": status["preparation_ref"],
            "top_revision_value": self.top["revision"], "context_ref": CONTEXT, **options})

    def snapshot(self):
        with self.db.connect() as connection:
            return {name: connection.execute(f"select * from app.{name} where owner_account_id=%s order by 1,2",
                    (self.db.owner.account_id,)).fetchall() for name in RELATIONS}

    def durable(self):
        result = self.snapshot()
        # An explicit advance commits its claim before decoding. A rejected
        # completion may retain that expiring claim, but no pixels/proofs/counter
        # increments or preparation revision may survive the failed transaction.
        for row in result["album_top_artwork_preparations"]:
            for key in ("lease_ref", "lease_expires_at", "batch_request_key", "batch_from_revision", "batch_items"):
                row.pop(key)
        return result

    def publication_state(self):
        with self.db.connect() as connection:
            return {**self.db.snapshot(), **{name: connection.execute(
                f"select * from app.{name} where library_id=%s order by ref", (self.db.library,)).fetchall()
                for name in ("shared_links", "album_list_publications")}}

    def claim(self, status, *, key=None, lease=None):
        key, lease = key or str(uuid4()), lease or str(uuid4())
        with psycopg.connect(self.db.app_url, row_factory=dict_row) as connection:
            chosen = connection.execute("select app.claim_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s) as items",
                (status["preparation_ref"], self.db.owner.account_id, self.db.owner.session_id,
                 CONTEXT, int(status["preparation_revision"]), key, lease)).fetchone()["items"]
        return key, lease, chosen

    def results(self, chosen):
        results, pngs = [], []
        for item_ref in chosen:
            number = next(i for i, row in enumerate(self.items) if row["item_ref"] == str(item_ref))
            source = describe_artwork_source(library_id=self.db.library,
                local_album_id=self.album_ids[number], artwork_root_id=self.artwork_root,
                artwork_root_path=self.artwork_path, stored_cover_path=str(self.cover_paths[number]),
                resolved_cover_path=self.cover_paths[number])
            captured = capture_artwork(source)
            results.append({"item_ref": str(item_ref), "status": "ready", "asset_ref": str(uuid4()),
                "content_digest": captured.content_digest, "width": captured.width, "height": captured.height,
                "source_stamp": {**asdict(source), "relative_parts": list(source.relative_parts)},
                "acquisition_stamp": {"file": asdict(captured.file_observation),
                    "input_bytes": captured.input_bytes, "input_pixels": captured.input_pixels}})
            pngs.append(captured.png)
        return results, pngs

    def complete(self, status, key, lease, results, pngs):
        with psycopg.connect(self.db.app_url, row_factory=dict_row) as connection:
            connection.execute("select app.complete_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (status["preparation_ref"], self.db.owner.account_id, self.db.owner.session_id,
                 CONTEXT, int(status["preparation_revision"]), key, lease, Jsonb(results), pngs))


@pytest.fixture
def artwork(db, tmp_path):
    # The cleanup is registered before any preparation can commit. The existing
    # admitted URLs guard loopback, synthetic DB names and the matching DB pair.
    with db.connect() as connection:
        assert connection.execute("select rolsuper from pg_roles where rolname=current_user").fetchone()["rolsuper"] is False
    with psycopg.connect(db.app_url, row_factory=dict_row) as connection:
        assert_runtime_role(connection, db)
    try:
        yield ArtworkCase(db, tmp_path)
    finally:
        with db.connect() as connection:
            connection.execute("set local lock_timeout='5s'")
            connection.execute("set local statement_timeout='20s'")
            # Transactional DDL takes a table lock, so no other session sees an
            # unguarded interval. No ALL/USER trigger or replication-role bypass.
            connection.execute("alter table app.album_top_artwork_preparation_items disable trigger top_artwork_proof_immutable")
            connection.execute("alter table app.album_top_artwork_assets disable trigger top_artwork_asset_immutable")
            connection.execute("delete from app.album_top_artwork_preparation_items where owner_account_id=%s", (db.owner.account_id,))
            connection.execute("delete from app.album_top_artwork_preparations where owner_account_id=%s", (db.owner.account_id,))
            connection.execute("delete from app.album_top_artwork_assets where owner_account_id=%s", (db.owner.account_id,))
            connection.execute("delete from app.album_top_artwork_budgets where owner_account_id=%s", (db.owner.account_id,))
            connection.execute("alter table app.album_top_artwork_assets enable trigger top_artwork_asset_immutable")
            connection.execute("alter table app.album_top_artwork_preparation_items enable trigger top_artwork_proof_immutable")


def observe_owner_connection(case, monkeypatch, callback):
    """Observe actual execution without replacing SQL results or transactions."""
    connect = case.db.service._connect
    class Connection:
        def __init__(self, real):
            self.real = real
        def __getattr__(self, name):
            return getattr(self.real, name)
        def execute(self, sql, params=None):
            result = self.real.execute(sql, params)
            callback(" ".join(str(sql).lower().split()), params)
            return result
    @contextmanager
    def observed(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            yield Connection(connection)
    monkeypatch.setattr(case.db.service, "_connect", observed)


def deny_resource(kind, ref):
    return lambda context: PolicyEvaluationConstraints(request_origin_allowed=not (
        context.resource is not None and context.resource.resource_kind == kind
        and context.resource.resource_ref == str(ref)))


def test_start_and_status_do_not_decode_or_publish_and_advance_is_four_bounded(artwork, monkeypatch):
    case = artwork.build(6, excluded={5})
    before = case.publication_state()
    capture = case.service.capture
    calls = []
    def observed(source):
        calls.append(source.local_album_id)
        return capture(source)
    monkeypatch.setattr(case.service, "capture", observed)
    started = case.start()
    assert calls == [] and started["ready_count"] == 0 and started["included_count"] == 5
    assert [row["status"] for row in started["items"]] == ["pending"] * 5 + ["excluded"]
    retained = case.snapshot()
    assert case.read(started) == started and case.snapshot() == retained and calls == []
    first = case.advance(started)
    assert first["preparation_revision"] == "2" and first["state"] == "preparing"
    assert first["ready_count"] == 4 and calls == case.album_ids[:4]
    second = case.advance(first)
    assert second["state"] == "ready" and second["ready_count"] == 5
    assert calls == case.album_ids[:5] and case.publication_state() == before
    assert set(second) == {"preparation_ref", "preparation_revision", "top_revision", "state",
        "expires_at", "item_count", "included_count", "ready_count", "failed_count", "byte_length", "items", "next_position"}
    assert all(set(row) == {"item_ref", "album_ref", "position", "included", "status", "error_code",
        "asset_ref", "content_digest", "width", "height", "byte_length"} for row in second["items"])
    for private in (str(case.directory), "source_stamp", "acquisition_stamp", "selected_source_ref", "png", "public_url"):
        assert private not in json.dumps(second)


@pytest.mark.parametrize("count", [0, 2])
def test_empty_or_all_excluded_manifest_is_ready_without_acquisition(artwork, monkeypatch, count):
    case = artwork.build(count, excluded=range(count))
    def forbidden(source):
        raise AssertionError("Excluded artwork must not be acquired")
    monkeypatch.setattr(case.service, "capture", forbidden)
    started = case.start()
    assert started["state"] == "ready" and started["included_count"] == started["ready_count"] == 0
    before = case.snapshot()
    assert case.advance(started) == started and case.snapshot() == before


def test_all_250_images_complete_across_63_batches_and_three_bounded_pages(artwork, monkeypatch):
    case = artwork.build(250)
    capture, calls = case.service.capture, []
    def observed(source):
        calls.append(source.local_album_id)
        return capture(source)
    monkeypatch.setattr(case.service, "capture", observed)
    status = case.start()
    for batch in range(63):
        before = len(calls)
        status = case.advance(status)
        assert len(calls) - before == min(4, 250 - before)
        assert status["ready_count"] == min(4 * (batch + 1), 250)
        assert len(status["items"]) == 100
    assert status["state"] == "ready" and calls == case.album_ids
    retained = case.snapshot()
    pages, after = [], 0
    for unused in range(3):
        page = case.read(status, after=after)
        pages.append(page)
        if page["next_position"] is None:
            break
        after = page["next_position"]
    rows = [row for page in pages for row in page["items"]]
    assert [len(page["items"]) for page in pages] == [100, 100, 50]
    assert [row["item_ref"] for row in rows] == [row["item_ref"] for row in case.items]
    assert [row["position"] for row in rows] == list(range(1, 251))
    assert all(row["status"] == "ready" for row in rows)
    assert len({row["content_digest"] for row in rows}) == 250
    assert case.snapshot() == retained and calls == case.album_ids


def test_decoder_runs_after_claim_commit_without_an_open_owner_transaction(artwork, monkeypatch):
    case = artwork.build(2)
    connect, capture, active = case.db.service._connect, case.service.capture, []
    @contextmanager
    def observed(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            active.append(connection)
            try:
                yield connection
            finally:
                active.pop()
    monkeypatch.setattr(case.db.service, "_connect", observed)
    def captured(source):
        assert not active
        with case.db.connect() as connection:
            connection.execute("set local lock_timeout='500ms'")
            connection.execute("select ref from app.album_lists where ref=%s for update", (case.top["top_ref"],))
            row = connection.execute("select lease_ref from app.album_top_artwork_preparations where top_ref=%s for update",
                                     (case.top["top_ref"],)).fetchone()
            assert row["lease_ref"] is not None
        return capture(source)
    monkeypatch.setattr(case.service, "capture", captured)
    assert case.advance(case.start())["ready_count"] == 2


def test_process_gate_is_nonqueued_and_does_not_claim_when_both_slots_are_occupied(artwork):
    case = artwork.build(1)
    started = case.start()
    before = case.snapshot()
    gate = preparation_module._DECODE_REQUESTS
    assert gate.acquire(blocking=False)
    try:
        assert gate.acquire(blocking=False)
        try:
            assert_error(lambda: case.advance(started), "artwork_busy", 409)
            assert case.snapshot() == before
        finally:
            gate.release()
    finally:
        gate.release()
    assert case.advance(started)["state"] == "ready"


@pytest.mark.parametrize("options", [{"limit": 0}, {"limit": 101}, {"limit": True},
    {"after": -1}, {"after": 5001}, {"after": False}])
def test_status_page_bounds_are_strict_without_mutation(artwork, options):
    case = artwork.build(1)
    started = case.start()
    before = case.snapshot()
    assert_error(lambda: case.read(started, **options), "invalid_query", 422)
    assert case.snapshot() == before


@pytest.mark.parametrize("shape", ["omitted", "reordered", "substituted", "unresolved"])
def test_start_requires_the_exact_whole_saved_membership(artwork, shape):
    case = artwork.build(3)
    items = [dict(row) for row in case.items]
    if shape == "omitted": items.pop()
    elif shape == "reordered": items.reverse()
    elif shape == "substituted": items[-1]["item_ref"] = str(uuid4())
    else: items[-1]["item_ref"] = None
    before = case.snapshot()
    assert_error(lambda: case.start(payload={**case.payload, "items": items}),
                 "invalid_command" if shape == "unresolved" else "items_changed", 422 if shape == "unresolved" else 409)
    assert case.snapshot() == before


@pytest.mark.parametrize("change", ["remove_tail", "swap_tail"])
def test_status_checks_whole_membership_even_beyond_the_requested_page(artwork, change):
    case = artwork.build(6)
    started = case.start()
    # Deliberately mutate saved membership without changing revision as a
    # structural fault injection. A one-row response cannot hide tail drift.
    with case.db.connect() as connection:
        if change == "remove_tail":
            connection.execute("delete from app.album_list_items where ref=%s", (case.items[-1]["item_ref"],))
        else:
            connection.execute("update app.album_list_items set curator_position=100 where ref=%s", (case.items[-1]["item_ref"],))
            connection.execute("update app.album_list_items set curator_position=6 where ref=%s", (case.items[-2]["item_ref"],))
            connection.execute("update app.album_list_items set curator_position=5 where ref=%s", (case.items[-1]["item_ref"],))
    before = case.snapshot()
    assert_error(lambda: case.read(started, limit=1), "items_changed", 409)
    assert case.snapshot() == before


def test_real_saved_top_revision_invalidates_old_preparation_without_advancing_it(artwork):
    case = artwork.build(2)
    started = case.start()
    saved, _ = write(case.db, "save", case.top, title="A later saved title")
    before = case.snapshot()
    assert_error(lambda: case.read(started), "revision_conflict", 409)
    assert_error(lambda: case.advance(started), "revision_conflict", 409)
    assert_error(lambda: case.read(started, top_revision_value=saved["revision"]), "artwork_preparation_unavailable", 409)
    assert case.snapshot() == before


@pytest.mark.parametrize("action", [BROWSE, MANAGE, ITEMS, ACCESS])
def test_each_current_owner_action_is_required_for_start_read_and_advance(artwork, action):
    case = artwork.build(1)
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != action)
    before = case.snapshot()
    assert_error(lambda: case.start(constraints=constraints), "forbidden", 403)
    assert case.snapshot() == before
    started = case.start()
    before = case.snapshot()
    assert_error(lambda: case.read(started, constraints=constraints), "forbidden", 403)
    assert_error(lambda: case.advance(started, constraints=constraints), "forbidden", 403)
    assert case.snapshot() == before


@pytest.mark.parametrize("kind", ["source", "metadata_root", "artwork_root", "artwork_action"])
def test_source_and_actual_artwork_root_authority_are_independent(artwork, kind):
    case = artwork.build(2)
    started = case.start()
    if kind == "source":
        constraints = deny_resource("album_metadata_source", case.source_refs[0])
    elif kind == "artwork_action":
        constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != ARTWORK)
    else:
        constraints = deny_resource("library_root", case.metadata_root if kind == "metadata_root" else case.artwork_root)
    before = case.snapshot()
    assert_error(lambda: case.advance(started, constraints=constraints), "forbidden", 403)
    assert case.snapshot() == before
    ready = case.advance(started)
    with case.db.connect() as connection:
        row = connection.execute("select selected_library_root_id,source_stamp from app.album_top_artwork_preparation_items where item_ref=%s",
                                 (case.items[0]["item_ref"],)).fetchone()
    assert row["selected_library_root_id"] == case.metadata_root
    assert row["source_stamp"]["artwork_root_id"] == case.artwork_root != case.metadata_root
    assert_error(lambda: case.read(ready, constraints=constraints), "forbidden", 403)


def test_more_specific_artwork_root_deny_cannot_fall_back_to_allowed_parent(artwork):
    case = artwork.build(1)
    with case.db.connect() as connection:
        broad = case.root(connection, case.directory)
    started = case.start()
    assert broad != case.artwork_root
    assert_error(lambda: case.advance(started, constraints=deny_resource("library_root", case.artwork_root)), "forbidden", 403)
    assert not case.snapshot()["album_top_artwork_assets"]


@pytest.mark.parametrize("boundary", ["source", "session", "owner", "claim", "lease_expiry", "cover"])
def test_current_facts_changed_during_decode_prevent_any_completed_proof(artwork, monkeypatch, boundary):
    case = artwork.build(2)
    started = case.start()
    capture, changed = case.service.capture, []
    # Every wrapper returns the actual acquired PNG. Only a separate committed
    # fact changes while the owner transaction is deliberately closed.
    def captured(source):
        result = capture(source)
        if not changed:
            with case.db.connect() as connection:
                if boundary == "source":
                    connection.execute("update library.album_metadata_sources set state='invalid' where ref=%s", (case.source_refs[0],))
                elif boundary == "session":
                    connection.execute("update app.account_sessions set revoked_at=clock_timestamp() where id=%s", (case.db.owner.session_id,))
                elif boundary == "owner":
                    connection.execute("update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s", (case.db.owner.account_id,))
                elif boundary == "claim":
                    connection.execute("update app.album_top_artwork_preparations set lease_ref=%s where ref=%s", (str(uuid4()), started["preparation_ref"]))
                elif boundary == "lease_expiry":
                    connection.execute("update app.album_top_artwork_preparations set lease_expires_at=clock_timestamp()-interval '1 second' where ref=%s",
                                       (started["preparation_ref"],))
                else:
                    alternate = png_file(case.artwork_path / "replacement.png", 90)
                    connection.execute("update library.local_albums set cover_path=%s where id=%s", (str(alternate), source.local_album_id))
            changed.append(True)
        return result
    monkeypatch.setattr(case.service, "capture", captured)
    before = case.durable()
    expected = {"source": ("evidence_unavailable", 409), "session": ("forbidden", 403),
        "owner": ("forbidden", 403), "claim": ("artwork_preparation_unavailable", 409),
        "lease_expiry": ("artwork_preparation_unavailable", 409),
        "cover": ("artwork_source_changed", 409)}[boundary]
    assert_error(lambda: case.advance(started), *expected)
    assert changed == [True] and case.durable() == before


@pytest.mark.parametrize("denial", ["source", "artwork_root", "owner", "session"])
def test_final_fences_after_actual_completion_statement_rollback_pixels_and_budgets(artwork, monkeypatch, denial):
    case = artwork.build(2)
    started, completed = case.start(), []
    def checkpoint(statement, params):
        if statement.startswith("select app.complete_top_artwork_batch"):
            completed.append(True)
        # Advance the real authorization clock only after the last result query,
        # so this specifically exercises the owner's final session fence rather
        # than the preparation-expiry check performed earlier by _load.
        if denial == "session" and completed and statement.startswith("select i.item_ref,i.catalog_ref,i.position"):
            monkeypatch.setattr(case.db.service, "_clock", lambda: case.db.now + timedelta(hours=2))
    observe_owner_connection(case, monkeypatch, checkpoint)
    def constraints(context):
        resource = context.resource
        denied = bool(completed) and ((denial == "owner" and context.action == ACCESS)
            or (denial == "source" and resource is not None and resource.resource_kind == "album_metadata_source")
            or (denial == "artwork_root" and resource is not None and resource.resource_kind == "library_root"
                and resource.resource_ref == str(case.artwork_root)))
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    before = case.durable()
    assert_error(lambda: case.advance(started, constraints=constraints), "forbidden", 403)
    assert completed == [True] and case.durable() == before


def test_exact_lost_response_replay_neither_decodes_nor_increments_then_old_revision_rejects(artwork, monkeypatch):
    case = artwork.build(6)
    started, key = case.start(), str(uuid4())
    first = case.advance(started, request_key=key)
    before = case.snapshot()
    capture = case.service.capture
    def forbidden(source):
        raise AssertionError("An exact completed request must not decode again")
    monkeypatch.setattr(case.service, "capture", forbidden)
    assert case.advance(started, request_key=key) == first
    assert case.snapshot() == before
    for constraints in (deny_resource("album_metadata_source", case.source_refs[0]),
                        deny_resource("library_root", case.artwork_root)):
        assert_error(lambda: case.advance(started, request_key=key, constraints=constraints), "forbidden", 403)
    assert case.snapshot() == before
    monkeypatch.setattr(case.service, "capture", capture)
    second = case.advance(first)
    assert second["state"] == "ready"
    before = case.snapshot()
    assert_error(lambda: case.advance(started, request_key=key), "artwork_preparation_unavailable", 409)
    assert case.snapshot() == before


def test_start_recovery_conflict_and_new_explicit_start_keep_old_pixels_immutable(artwork):
    case = artwork.build(2)
    started = case.start()
    ready = case.advance(started)
    before = case.snapshot()
    assert case.start() == ready and case.snapshot() == before
    changed = [dict(row) for row in case.items]
    changed[0]["include_artwork"] = False
    assert_error(lambda: case.start(payload={**case.payload, "items": changed}), "request_key_conflict", 409)
    assert case.snapshot() == before
    fresh = case.start(payload={**case.payload, "request_key": str(uuid4()), "items": changed})
    assert fresh["preparation_ref"] != ready["preparation_ref"]
    assert case.snapshot()["album_top_artwork_assets"] == before["album_top_artwork_assets"]
    assert_error(lambda: case.read(ready), "artwork_preparation_unavailable", 409)


@pytest.mark.parametrize("scope", ["context", "session", "foreign_owner"])
def test_preparation_handles_are_bound_to_current_context_and_original_owner_session(artwork, scope):
    case = artwork.build(2)
    started = case.start()
    options = {"context_ref": "b" * 64} if scope == "context" else {
        "actor": new_session(case.db, case.db.owner) if scope == "session" else member(case.db)}
    before = case.snapshot()
    expected = ("top_unavailable", 404) if scope == "foreign_owner" else ("artwork_preparation_unavailable", 409)
    assert_error(lambda: case.read(started, **options), *expected)
    assert_error(lambda: case.advance(started, **options), *expected)
    assert case.snapshot() == before


def test_stale_lease_cannot_complete_after_reclaim_and_inflight_retry_is_busy(artwork):
    case = artwork.build(2)
    started = case.start()
    key, lease, chosen = case.claim(started)
    before = case.snapshot()
    assert_error(lambda: case.advance(started, request_key=key), "artwork_busy", 409)
    assert case.snapshot() == before
    results, pngs = case.results(chosen)
    with case.db.connect() as connection:
        connection.execute("update app.album_top_artwork_preparations set lease_expires_at=clock_timestamp()-interval '1 second' where ref=%s",
                           (started["preparation_ref"],))
    new_key, new_lease, again = case.claim(started)
    assert again == chosen and new_lease != lease
    before = case.snapshot()
    with pytest.raises(psycopg.Error) as rejected:
        case.complete(started, key, lease, results, pngs)
    assert (rejected.value.sqlstate, rejected.value.diag.constraint_name) == ("55000", "top_artwork_claim")
    assert case.snapshot() == before
    case.complete(started, new_key, new_lease, results, pngs)
    assert case.read(started)["state"] == "ready"


@pytest.mark.parametrize("operation", ["read", "advance", "start_replay"])
def test_expired_preparation_cannot_recover_or_extend_its_deadline(artwork, operation):
    case = artwork.build(1)
    started = case.start()
    with case.db.connect() as connection:
        # A single timestamp keeps the exact 60-minute CHECK meaningful.
        connection.execute("""with expired as (select clock_timestamp()-interval '1 minute' as cutoff)
            update app.album_top_artwork_preparations set created_at=expired.cutoff-interval '60 minutes',
                expires_at=expired.cutoff from expired where ref=%s""", (started["preparation_ref"],))
    before = case.snapshot()
    invoke = case.start if operation == "start_replay" else lambda: getattr(case, operation)(started)
    assert_error(invoke, "artwork_preparation_unavailable", 409)
    assert case.snapshot() == before


def test_pending_tail_is_not_starved_by_failed_front_items(artwork):
    case = artwork.build(6)
    for path in case.cover_paths[:4]:
        path.unlink()
    started = case.start()
    failed = case.advance(started)
    assert failed["failed_count"] == 4 and failed["ready_count"] == 0
    progressed = case.advance(failed)
    assert progressed["ready_count"] == 2
    assert all(row["status"] == "ready" for row in progressed["items"][4:])
    for index, path in enumerate(case.cover_paths[:4]):
        png_file(path, index)
    ready = case.advance(progressed)
    assert ready["state"] == "ready" and ready["ready_count"] == 6


def test_ready_capture_survives_source_file_byte_changes_but_not_selection_change(artwork):
    case = artwork.build(1)
    ready = case.advance(case.start())
    before = case.snapshot()
    png_file(case.cover_paths[0], 200)
    assert case.read(ready) == ready and case.snapshot() == before
    case.cover_paths[0].unlink()
    assert case.read(ready) == ready and case.snapshot() == before
    alternate = png_file(case.artwork_path / "explicit-new-selection.png", 7)
    with case.db.connect() as connection:
        connection.execute("update library.local_albums set cover_path=%s where id=%s", (str(alternate), case.album_ids[0]))
    assert_error(lambda: case.read(ready), "artwork_source_changed", 409)
    assert case.snapshot() == before


def test_dedup_is_within_top_and_retained_budgets_only_count_new_assets(artwork):
    case = artwork.build(6, same_pixels=True)
    first = case.advance(case.start())
    ready = case.advance(first)
    rows = case.snapshot()
    assets = rows["album_top_artwork_assets"]
    assert len(assets) == 1 and len({row["asset_ref"] for row in ready["items"]}) == 1
    byte_length = assets[0]["byte_length"]
    assert ready["byte_length"] == 6 * byte_length
    assert {(row["asset_count"], row["byte_count"]) for row in rows["album_top_artwork_budgets"]} == {(1, byte_length)}
    renewed = case.start(payload={**case.payload, "request_key": str(uuid4())})
    renewed = case.advance(case.advance(renewed))
    assert renewed["state"] == "ready"
    assert case.snapshot()["album_top_artwork_assets"] == assets
    assert case.snapshot()["album_top_artwork_budgets"] == rows["album_top_artwork_budgets"]
    other, _ = case.db.create(refs=case.catalog_refs[:1])
    item = case.db.read(other)["items"][0]
    payload = {"revision": other["revision"], "request_key": str(uuid4()), "items": [
        {**case.items[0], "item_ref": item["ref"], "album_ref": item["catalog_ref"]}]}
    other_start = case.start(top_ref=other["top_ref"], payload=payload)
    case.advance(other_start, top_ref=other["top_ref"], top_revision_value=other["revision"])
    final = case.snapshot()
    assert len(final["album_top_artwork_assets"]) == 2
    assert len({row["ref"] for row in final["album_top_artwork_assets"]}) == 2
    account = next(row for row in final["album_top_artwork_budgets"] if str(row["scope_ref"]) == ZERO)
    assert (account["asset_count"], account["byte_count"]) == (2, 2 * byte_length)


@pytest.mark.parametrize("scope,field,maximum", [
    ("top", "asset_count", 20000), ("account", "asset_count", 100000),
    ("top", "byte_count", 536870912), ("account", "byte_count", 4294967296),
])
def test_real_budget_limits_rollback_prior_assets_in_the_same_batch(artwork, scope, field, maximum):
    case = artwork.build(2)
    started = case.start()
    # Real output length is used even when testing a near-limit counter. These
    # trusted boundary fixtures do not masquerade as historical acquired assets.
    _, first_png = case.results([case.items[0]["item_ref"]])
    permitted = 1 if field == "asset_count" else len(first_png[0])
    with case.db.connect() as connection:
        connection.execute("insert into app.album_top_artwork_budgets(owner_account_id,scope_ref) values(%s,%s)",
                           (case.db.owner.account_id, ZERO))
        connection.execute("""insert into app.album_top_artwork_budgets(owner_account_id,scope_ref,top_ref,library_id)
            values(%s,%s,%s,%s)""", (case.db.owner.account_id, case.top["top_ref"], case.top["top_ref"], case.db.library))
        connection.execute(f"update app.album_top_artwork_budgets set {field}=%s where owner_account_id=%s and scope_ref=%s",
            (maximum - permitted, case.db.owner.account_id, case.top["top_ref"] if scope == "top" else ZERO))
    before = case.durable()
    assert_error(lambda: case.advance(started), "artwork_limit", 409)
    assert case.durable() == before
    assert not case.snapshot()["album_top_artwork_assets"]


def test_sql_completion_rejects_reordered_claim_results_without_counter_or_asset_leaks(artwork):
    case = artwork.build(2)
    started = case.start()
    key, lease, chosen = case.claim(started)
    results, pngs = case.results(chosen)
    before = case.snapshot()
    with pytest.raises(psycopg.Error) as rejected:
        case.complete(started, key, lease, list(reversed(results)), list(reversed(pngs)))
    assert (rejected.value.sqlstate, rejected.value.diag.constraint_name) == ("23514", "top_artwork_results")
    assert case.snapshot() == before


def test_runtime_grants_are_real_minimum_privileges_and_definers_have_fixed_search_path(artwork):
    case = artwork.build(1)
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as connection:
        runtime_role = assert_runtime_role(connection, case.db)
    with case.db.connect() as connection:
        assert connection.execute("select rolsuper from pg_roles where rolname=current_user").fetchone()["rolsuper"] is False
        for name in RELATIONS:
            relation = "app." + name
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
                row = connection.execute("""select has_table_privilege('album_haven_app',%s,%s) as runtime,
                    has_table_privilege(%s,%s,%s) as connected,
                    has_table_privilege('album_haven_readonly',%s,%s) as readonly""",
                    (relation, privilege, runtime_role, relation, privilege, relation, privilege)).fetchone()
                assert row == {"runtime": privilege == "SELECT", "connected": privilege == "SELECT", "readonly": False}, (relation, privilege)
            assert connection.execute("""select count(*) as n from pg_class c cross join lateral
                aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
                where c.oid=%s::regclass and a.grantee=0""", (relation,)).fetchone()["n"] == 0
        for signature in (START_SIGNATURE, CLAIM_SIGNATURE, COMPLETE_SIGNATURE):
            row = connection.execute("""select p.prosecdef,p.proconfig,r.rolsuper,
                has_function_privilege('album_haven_app',p.oid,'EXECUTE') as runtime,
                has_function_privilege(%s,p.oid,'EXECUTE') as connected,
                has_function_privilege('album_haven_readonly',p.oid,'EXECUTE') as readonly
                from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=%s::regprocedure""", (runtime_role, signature)).fetchone()
            assert row == {"prosecdef": True, "proconfig": ["search_path=pg_catalog"],
                           "rolsuper": False, "runtime": True, "connected": True, "readonly": False}
            assert connection.execute("""select count(*) as n from pg_proc p cross join lateral
                aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                where p.oid=%s::regprocedure and a.grantee=0""", (signature,)).fetchone()["n"] == 0
        for signature in ("app.guard_top_artwork_asset()", "app.guard_top_artwork_item()",
                          "app.lock_top_artwork_scope(uuid,bigint,bigint,bigint)"):
            for role in dict.fromkeys(('album_haven_app', runtime_role)):
                assert connection.execute("select has_function_privilege(%s,%s,'EXECUTE') as allowed",
                                          (role, signature)).fetchone()["allowed"] is False


@pytest.mark.parametrize("target,action", [("asset", "update"), ("asset", "delete"),
    ("proof", "update"), ("proof", "delete")])
def test_completed_assets_and_proofs_reject_even_trusted_writer_mutation(artwork, target, action):
    case = artwork.build(1)
    ready = case.advance(case.start())
    table = "app.album_top_artwork_assets" if target == "asset" else "app.album_top_artwork_preparation_items"
    predicate = "ref=%s" if target == "asset" else "preparation_ref=%s"
    value = ready["items"][0]["asset_ref"] if target == "asset" else ready["preparation_ref"]
    assignment = "width=width" if target == "asset" else "position=position"
    sql = f"delete from {table} where {predicate}" if action == "delete" else f"update {table} set {assignment} where {predicate}"
    before = case.snapshot()
    with pytest.raises(psycopg.Error) as rejected:
        with case.db.connect() as connection:
            connection.execute(sql, (value,))
    assert (rejected.value.sqlstate, rejected.value.diag.constraint_name) == (
        "55000", "top_artwork_asset_immutable" if target == "asset" else "top_artwork_proof_immutable")
    assert case.snapshot() == before


def test_runtime_cannot_directly_insert_update_delete_or_truncate_artwork_tables(artwork):
    case = artwork.build(1)
    case.advance(case.start())
    before = case.snapshot()
    for name in RELATIONS:
        for statement in (f"insert into app.{name} select * from app.{name} where false",
                          f"update app.{name} set owner_account_id=owner_account_id where false",
                          f"delete from app.{name} where false", f"truncate app.{name}"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with psycopg.connect(case.db.app_url) as connection:
                    connection.execute(statement)
    assert case.snapshot() == before


def test_ready_private_assets_add_no_public_chain_foreign_key_or_saved_pointer(artwork):
    case = artwork.build(1)
    before = case.publication_state()
    ready = case.advance(case.start())
    assert ready["state"] == "ready" and case.publication_state() == before
    with case.db.connect() as connection:
        # The only inbound asset reference belongs to private preparation items.
        referenced = connection.execute("""select conrelid::regclass::text as relation
            from pg_constraint where contype='f' and confrelid='app.album_top_artwork_assets'::regclass
            order by conrelid::regclass::text""").fetchall()
    assert referenced == [{"relation": "app.album_top_artwork_preparation_items"}]
    assert "publication" not in ready and "public_path" not in ready
    # Read actual route declarations without importing application composition.
    repository = Path(__file__).resolve().parents[2]
    for filename in ("owned_album_tops_asgi.py", "public_album_tops_asgi.py"):
        source = (repository / "music_app" / "routes" / filename).read_text(encoding="utf-8")
        assert "TopArtworkPreparationService" not in source
        assert "album_top_artwork_preparation" not in source
        assert "album_top_artwork_assets" not in source


def test_latest_completed_key_cannot_be_rebound_to_a_new_preparation_revision(artwork):
    case = artwork.build(6)
    started, key = case.start(), str(uuid4())
    first = case.advance(started, request_key=key)
    before = case.snapshot()
    assert_error(lambda: case.advance(first, request_key=key), "request_key_conflict", 409)
    assert case.snapshot() == before
    assert case.advance(started, request_key=key) == first
    assert case.snapshot() == before


def test_read_only_runtime_status_parent_lock_blocks_an_admitted_concurrent_claim(artwork, monkeypatch):
    case = artwork.build(1)
    started, observed = case.start(), []
    def checkpoint(statement, params):
        if not statement.startswith("select *,clock_timestamp() as checked_at from app.album_top_artwork_preparations"):
            return
        # The service's actual runtime transaction has only SELECT staging
        # grants. Its existing Top SHARE lock must also exclude direct admitted
        # write helpers, without a staging-row lock or expanded UPDATE grant.
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with psycopg.connect(case.db.app_url) as concurrent:
                concurrent.execute("set local lock_timeout='200ms'")
                concurrent.execute("select app.claim_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s)",
                    (started["preparation_ref"], case.db.owner.account_id, case.db.owner.session_id,
                     CONTEXT, int(started["preparation_revision"]), str(uuid4()), str(uuid4())))
        observed.append(True)
    before = case.snapshot()
    observe_owner_connection(case, monkeypatch, checkpoint)
    assert case.read(started) == started
    assert observed == [True] and case.snapshot() == before


@pytest.mark.parametrize("operation", ["claim", "complete"])
def test_direct_runtime_mutators_retain_the_parent_top_update_lock(operation, artwork):
    case = artwork.build(1)
    started = case.start()
    if operation == "complete":
        key, lease, chosen = case.claim(started)
        results, pngs = case.results(chosen)
    else:
        key, lease = str(uuid4()), str(uuid4())
    with psycopg.connect(case.db.app_url) as connection:
        connection.execute("set local lock_timeout='2s'")
        if operation == "claim":
            connection.execute("select app.claim_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s)",
                (started["preparation_ref"], case.db.owner.account_id, case.db.owner.session_id,
                 CONTEXT, int(started["preparation_revision"]), key, lease))
        else:
            connection.execute("select app.complete_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (started["preparation_ref"], case.db.owner.account_id, case.db.owner.session_id,
                 CONTEXT, int(started["preparation_revision"]), key, lease, Jsonb(results), pngs))
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with psycopg.connect(case.db.app_url) as concurrent:
                concurrent.execute("select ref from app.album_lists where ref=%s for share nowait", (case.top["top_ref"],))
    with psycopg.connect(case.db.app_url) as concurrent:
        assert concurrent.execute("select ref from app.album_lists where ref=%s for share nowait",
                                  (case.top["top_ref"],)).fetchone() is not None


def test_direct_runtime_claim_rejects_a_saved_top_revision_change(artwork):
    case = artwork.build(1)
    started = case.start()
    write(case.db, "save", case.top, title="A changed Top before claim")
    before = case.snapshot()
    with pytest.raises(psycopg.Error) as rejected:
        case.claim(started)
    assert (rejected.value.sqlstate, rejected.value.diag.constraint_name) == ("55000", "top_artwork_scope")
    assert case.snapshot() == before


def test_current_cover_selection_stays_locked_through_final_runtime_status(artwork, monkeypatch):
    case = artwork.build(1)
    ready, observed = case.advance(case.start()), []
    alternate = png_file(case.artwork_path / "after-status.png", 123)
    def checkpoint(statement, params):
        if not statement.startswith("select i.item_ref,i.catalog_ref,i.position"):
            return
        # cover_path is not part of the metadata generation. A late writer must
        # wait for this actual runtime read's retained selected-album SHARE lock.
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with psycopg.connect(case.db.app_url) as concurrent:
                concurrent.execute("set local lock_timeout='200ms'")
                concurrent.execute("update library.local_albums set cover_path=%s where id=%s",
                                   (str(alternate), case.album_ids[0]))
        observed.append(True)
    before = case.snapshot()
    observe_owner_connection(case, monkeypatch, checkpoint)
    assert case.read(ready) == ready and observed == [True]
    assert case.snapshot() == before
    with psycopg.connect(case.db.app_url) as concurrent:
        concurrent.execute("update library.local_albums set cover_path=%s where id=%s",
                           (str(alternate), case.album_ids[0]))
    assert_error(lambda: case.read(ready), "artwork_source_changed", 409)
