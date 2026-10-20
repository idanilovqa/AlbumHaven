"""Independent R3 fixtures. Authoring this file does not execute any fixture.

Only normal migrated MixDatabase rows and public service entry points are used.
Expected envelopes/digests are computed here, never by the implementation under
test. Provider doubles replace only the exact network acquisition boundary.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
import json
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb
from music_app.services.current_actor import CapabilityGrant
from music_app.services import musicbrainz_http as http
from music_app.services import lastfm_track_popularity as popularity
from music_app.services import library_mix_inventory_postgres as inventory
from music_app.services import playlist_creation_sources_postgres as sources
from music_app.services.owned_playlists import PlaylistError
from test_sample_playlist_sources_live import manual_source

KEY = "musicbrainz_artist_country_v1"
REFRESH = "library.refresh"
ABSENT = object()
TRIM = "".join(chr(i) for i in (*range(9, 14), *range(28, 33), 0x85, 0xa0,
    0x1680, *range(0x2000, 0x200b), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000))


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
        ensure_ascii=False, allow_nan=False).encode("utf-8")


def digest(value):
    return sha256(encoded(value)).hexdigest()


def primary_row(db, index=0):
    with db.connect() as con:
        return dict(con.execute("""select ar.* from library.local_tracks t
            join library.local_albums a on a.id=t.album_id and a.library_id=t.library_id
            join library.local_artists ar on ar.id=a.artist_id and ar.library_id=t.library_id
            where t.library_id=%s and t.id=%s""", (db.library, db.tracks[index])).fetchone())


def identity_document(db, index=0):
    row = primary_row(db, index)
    return {"domain": "sample-country-local-identity-v1", "library_id": str(db.library),
        "local_artist_id": str(row["id"]), "canonical_artist_mbid": db.artist_mbids[index // 3],
        "row_mbid": str(row["mbid"]) if row["mbid"] is not None else None,
        "row_assertion_state": row["mbid_assertion_state"],
        "row_evidence_source": row["evidence_source"]}


def envelope(db, value=ABSENT, index=0, *, revision=None):
    identity = identity_document(db, index)
    return envelope_for_identity(identity, value, revision=revision)


def envelope_for_identity(identity, value=ABSENT, *, revision=None):
    field = {"presence": "absent" if value is ABSENT else "null" if value is None else "string",
        "value": None if value is ABSENT else value}
    token = value.strip(TRIM) if type(value) is str else ""
    return {"version": 1, "envelope_revision": revision or str(uuid4()), "provider": "musicbrainz",
        "entity_kind": "artist", "library_id": identity["library_id"],
        "local_artist_id": identity["local_artist_id"],
        "canonical_artist_mbid": identity["canonical_artist_mbid"],
        "identity_basis_digest": digest(identity), "state": "known" if token else "unknown",
        "country_token": token or None, "unknown_reason": None if token else "provider_omitted_country",
        "country_field": field, "captured_at": "2026-10-01T00:00:00.000001Z",
        "evidence_policy": "musicbrainz-artist-v1",
        "evidence_digest": digest({"domain": "sample-country-provider-evidence-v1",
            "evidence_policy": "musicbrainz-artist-v1", "requested_mbid": identity["canonical_artist_mbid"],
            "returned_mbid": identity["canonical_artist_mbid"], "country_field": field})}


def set_country(db, value=ABSENT, index=0):
    artist = primary_row(db, index)["id"]
    with db.connect() as con:
        if value is ABSENT:
            con.execute("update library.local_artists set metadata=metadata-%s where library_id=%s and id=%s",
                (KEY, db.library, artist))
        else:
            con.execute("update library.local_artists set metadata=metadata||%s where library_id=%s and id=%s",
                (Jsonb({KEY: value}), db.library, artist))


def country(db, index=0):
    row = primary_row(db, index)
    return deepcopy(row["metadata"].get(KEY, ABSENT))


def set_genre(db, value=ABSENT, indexes=(0,)):
    with db.connect() as con:
        for index in indexes:
            if value is ABSENT:
                con.execute("""update library.local_track_files set metadata=metadata#-
                    '{scan_cache,file_entry,genre}' where track_id=%s""", (db.tracks[index],))
            else:
                con.execute("""update library.local_track_files set metadata=jsonb_set(
                    metadata,'{scan_cache,file_entry,genre}',%s) where track_id=%s""",
                    (Jsonb(value), db.tracks[index]))


def add_copy(db, index=0, *, genre=ABSENT, stale=False, root=None):
    with db.connect() as con:
        original = con.execute("select * from library.local_track_files where track_id=%s order by id limit 1",
            (db.tracks[index],)).fetchone()
        metadata = deepcopy(original["metadata"])
        if genre is not ABSENT:
            metadata["scan_cache"]["file_entry"]["genre"] = genre
        return con.execute("""insert into library.local_track_files
            (track_id,library_root_id,private_path,content_signature,metadata,scan_cache_stale)
            values(%s,%s,%s,%s,%s,%s) returning id""",
            (db.tracks[index], root or original["library_root_id"],
             original["private_path"] + "." + uuid4().hex, original["content_signature"],
             Jsonb(metadata), stale)).fetchone()["id"]


def grant_refresh(db):
    with db.connect() as con:
        con.execute("""insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
            values(%s,%s,'library',%s)""", (db.owner.account_id, REFRESH, db.library))
    db.owner = replace(db.owner, capability_grants=(*db.owner.capability_grants,
        CapabilityGrant(REFRESH, "library", db.library)))


def selector(parent):
    return {"playlist_ref": parent["playlist_id"], "revision": parent["revision"]}


def target(db, index=0):
    return {"track_ref": f"inventory-track:{db.library}:{db.tracks[index]}",
        "primary_artist_ref": "musicbrainz-artist:" + db.artist_mbids[index // 3]}


def discover(db, parent, facets=("styles", "countries"), method="most_listened", **kwargs):
    value = db.service.read_sample_facets(db.context(), selector(parent), method, list(facets),
        kwargs.pop("constraints", None), **kwargs)
    assert set(value) == {"status", "data"} and value["status"] == "ready"
    assert set(value["data"]) == {"selection_method", "facets", "allowed_actions"}
    assert value["data"]["selection_method"] == method
    return value["data"]


def enrich(db, parent, targets=None, method="most_listened", constraints=None, should_cancel=None):
    value = db.service.enrich_sample_country_metadata(db.context(), selector(parent), method,
        targets or [target(db)], constraints, should_cancel or (lambda: False))
    assert set(value) == {"status", "data"} and value["status"] == "ready"
    assert set(value["data"]) == {"selection_method", "results"}
    assert value["data"]["selection_method"] == method
    for result in value["data"]["results"]:
        assert set(result) == {"track_ref", "primary_artist_ref", "status"}
    return value["data"]["results"]


def acquisition(monkeypatch, callback=None):
    calls = []
    def other_provider(*args, **kwargs):
        pytest.fail("Country acquisition left the exact strict artist boundary")
    monkeypatch.setattr(http, "get_json", other_provider)
    monkeypatch.setattr(popularity, "fetch_track_popularity", other_provider)
    monkeypatch.setattr(popularity, "get_lastfm_track_info", other_provider)
    def fetch(mbid, user_agent, *, timeout=15.0, should_cancel=None):
        calls.append((mbid, user_agent, timeout, should_cancel))
        if callback:
            return callback(mbid, len(calls), should_cancel)
        return {"id": mbid, "country": "GB"}, {"status": "network", "cache_hit": False,
            "attempt": 1, "evidence_policy": "musicbrainz-artist-v1"}
    monkeypatch.setattr(http, "get_artist_json", fetch)
    return calls


def forbid_provider(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Non-explicit Sample operation attempted provider acquisition")
    monkeypatch.setattr(http, "get_artist_json", forbidden)
    monkeypatch.setattr(http, "get_json", forbidden)
    monkeypatch.setattr(popularity, "fetch_track_popularity", forbidden)
    monkeypatch.setattr(popularity, "get_lastfm_track_info", forbidden)


def strict_result(mbid, country_value=ABSENT, **metadata):
    return ({"id": mbid, **({} if country_value is ABSENT else {"country": country_value})},
        {"status": "network", "cache_hit": False, "attempt": 1,
            "evidence_policy": "musicbrainz-artist-v1", **metadata})


def generic_evidence(db, indexes=(0,)):
    with db.connect() as con:
        rows = inventory.read_inventory(con, db.library, track_ids=[db.tracks[i] for i in indexes])
    return [(row["original_local_track_id"], deepcopy(row["file_tags"]),
        inventory.inventory_revision(row), inventory.normalize_cached_inventory_row(row),
        sources.entry_evidence(sources._plain(row))) for row in rows]


@contextmanager
def transaction_spy(monkeypatch, db):
    active, visited = [], []
    original = db.service._authorized
    @contextmanager
    def observed(*args, **kwargs):
        with original(*args, **kwargs) as value:
            active.append(value[0]); visited.append(value[0])
            try:
                yield value
            finally:
                active.pop()
    monkeypatch.setattr(db.service, "_authorized", observed)
    yield active, visited


@contextmanager
def sql_probe(monkeypatch, db, *, before=None, after=None):
    """Forward SQL and observe real result allocations, not just Python iteration.

    Client cursor pgresult.ntuples records the entire transferred result even
    when product code subsequently consumes it one row at a time. Named server
    cursors retain their actual fetch request and result-page sizes instead.
    """
    log = []
    original = db.service._connect
    def begin(real, query, params, cursor=None):
        event = {"sql": " ".join(str(query).lower().split()), "params": deepcopy(params),
            "connection": real, "fetches": [], "rows": [], "result_pages": [],
            "fetch_requests": [], "server_cursor": bool(getattr(cursor, "name", None)),
            "columns": [], "_last_result": None}
        log.append(event)
        if before:
            before(real, event)
        return event
    def result_page(cursor, event):
        result = getattr(cursor, "pgresult", None)
        if result is not None and result is not event["_last_result"]:
            event["_last_result"] = result
            event["result_pages"].append(result.ntuples)
        if cursor.description:
            event["columns"] = [column.name for column in cursor.description]
    def consumed(cursor, event, values):
        result_page(cursor, event)
        event["fetches"].append(len(values))
        event["rows"].extend(deepcopy(values))
    class Cursor:
        def __init__(self, real, event=None, connection=None):
            self.real, self.event, self.connection = real, event, connection
        def __getattr__(self, name):
            return getattr(self.real, name)
        def __setattr__(self, name, value):
            if name in {"real", "event", "connection"}:
                object.__setattr__(self, name, value)
            else:
                setattr(self.real, name, value)
        def execute(self, query, params=None, *args, **kwargs):
            self.event = begin(self.connection, query, params, self.real)
            self.real.execute(query, params, *args, **kwargs)
            result_page(self.real, self.event)
            if after:
                after(self.connection, self.event)
            return self
        def fetchone(self):
            self.event["fetch_requests"].append(1)
            value = self.real.fetchone()
            consumed(self.real, self.event, [] if value is None else [value])
            return value
        def fetchmany(self, *args, **kwargs):
            self.event["fetch_requests"].append(args[0] if args else kwargs.get("size", self.real.arraysize))
            value = self.real.fetchmany(*args, **kwargs)
            consumed(self.real, self.event, value)
            return value
        def fetchall(self):
            self.event["fetch_requests"].append("all")
            value = self.real.fetchall()
            consumed(self.real, self.event, value)
            return value
        def __iter__(self):
            self.event["fetch_requests"].append(getattr(self.real, "itersize", "client_iterator"))
            for row in self.real:
                consumed(self.real, self.event, [row])
                yield row
        def __enter__(self):
            self.real.__enter__()
            return self
        def __exit__(self, *args):
            return self.real.__exit__(*args)
    class Connection:
        def __init__(self, real):
            self.real = real
        def __getattr__(self, name):
            return getattr(self.real, name)
        def cursor(self, *args, **kwargs):
            return Cursor(self.real.cursor(*args, **kwargs), connection=self.real)
        def execute(self, query, params=None, *args, **kwargs):
            event = begin(self.real, query, params)
            cursor = self.real.execute(query, params, *args, **kwargs)
            result_page(cursor, event)
            if after:
                after(self.real, event)
            return Cursor(cursor, event)
        def __enter__(self):
            self.real.__enter__()
            return self
        def __exit__(self, *args):
            return self.real.__exit__(*args)
    monkeypatch.setattr(db.service, "_connect", lambda *a, **k: Connection(original(*a, **k)))
    yield log
