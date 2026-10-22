"""Additive fixture utilities; never replace a production SQL result.

All mutation uses the existing guarded, disposable SearchDatabase fixture's
uniquely owned records. Import this through tests.py after root admission.
"""
from contextlib import contextmanager
import json
from uuid import uuid4

from tests.py.test_global_private_search_postgres import connect


class ConsumptionTrace:
    """Observe actual driver fetches, including repeatedly fetched identities.

    Connection.execute is the native read owner's existing driver boundary.
    The proxy forwards the identical query/arguments and returns the original
    rows unchanged. Counts use returned column descriptions, never SQL LIMIT,
    rowcount, policy-decision counts, or unique-ID counts.
    """
    def __init__(self):
        self.fetches = []
        self.statements = []

    @staticmethod
    def description(cursor):
        names = tuple(column.name for column in (cursor.description or ()))
        kind = ("track" if "track_id" in names else
                "album" if "album_id" in names else
                "artist" if "artist_id" in names else "authority_or_metadata")
        return kind, names

    def completed(self, cursor, query):
        kind, names = self.description(cursor)
        self.statements.append((kind, cursor.rowcount, names, str(query)))

    def received(self, cursor, method, rows):
        kind, names = self.description(cursor)
        self.fetches.append((kind, method, len(rows), names))

    def count(self, kind):
        return sum(size for actual, _method, size, _names in self.fetches if actual == kind)

    def assert_bounded(self, db, *, result_limit=100, sidebar=True):
        assert self.count("track") > 0, "No native Track-result fetch was observed"
        assert self.count("track") <= 101, self.fetches
        # libpq can buffer an executed result set even if Python consumes only
        # its first row. Retain both independent observations so replacing a
        # fetchall with fetchone cannot conceal repeated full SQL rowsets.
        returned = sum(max(size, 0) for kind, size, _names, _sql in self.statements if kind == "track")
        assert returned <= 101, self.statements
        # The other explicit candidate budgets are independent of the shared
        # witness budget. Re-resolution may add one outer scalar identity read.
        assert self.count("album") <= result_limit + 2, self.fetches
        assert self.count("artist") <= (52 if sidebar else 1), self.fetches
        examined = {ref for action, kind, ref in db.decisions
                    if action == "library.browse.read" and kind == "track"}
        assert len(examined) <= 100


class _ObservedCursor:
    def __init__(self, cursor, trace):
        self._cursor, self._trace = cursor, trace
        self._iterator = None

    def __getattr__(self, name):
        return getattr(self._cursor, name)

    def fetchone(self, *args, **kwargs):
        row = self._cursor.fetchone(*args, **kwargs)
        self._trace.received(self._cursor, "fetchone", [] if row is None else [row])
        return row

    def fetchmany(self, *args, **kwargs):
        rows = self._cursor.fetchmany(*args, **kwargs)
        self._trace.received(self._cursor, "fetchmany", rows)
        return rows

    def fetchall(self, *args, **kwargs):
        rows = self._cursor.fetchall(*args, **kwargs)
        self._trace.received(self._cursor, "fetchall", rows)
        return rows

    def __iter__(self):
        return self

    def __next__(self):
        if self._iterator is None:
            self._iterator = iter(self._cursor)
        row = next(self._iterator)
        self._trace.received(self._cursor, "iteration", [row])
        return row

    def __enter__(self):
        self._cursor.__enter__()
        return self

    def __exit__(self, *args):
        return self._cursor.__exit__(*args)


@contextmanager
def observe_consumption(monkeypatch):
    import psycopg
    trace = ConsumptionTrace()
    original = psycopg.Connection.execute

    def execute(connection, query, params=None, *args, **kwargs):
        cursor = original(connection, query, params, *args, **kwargs)
        trace.completed(cursor, query)
        return _ObservedCursor(cursor, trace)

    # Nested patch scope ensures setup/cleanup, source-owner comparison queries,
    # and later requests cannot inflate or hide this request's observed reads.
    with monkeypatch.context() as patch:
        patch.setattr(psycopg.Connection, "execute", execute)
        yield trace


def bulk_tracks(db, album, count, *, title="Budget Witness", tier="loved"):
    """Efficient pre-request fixture generation, not runtime dataset trimming."""
    parent = db.albums[album]
    token = uuid4().hex
    root = db.roots[parent["library"]]
    with connect(db.setup) as connection:
        rows = connection.execute("""insert into library.local_tracks
            (library_id,artist_id,album_id,track_key,title,disc_number,track_number,duration_seconds)
            select %s,%s,%s,'track:' || %s || ':' || n::text,
                   %s || ' ' || lpad(n::text,4,'0'),1,n,181
            from generate_series(1,%s) n returning id,track_key,title""",
            (parent["library"], parent["artist"], album, token, title, count)).fetchall()
        for row in rows:
            path = db.root_paths[root] + "/" + token + "/" + str(row["id"]) + ".flac"
            db.tracks[row["id"]] = {"library": parent["library"], "album": album,
                "title": row["title"], "key": row["track_key"], "path": path}
        connection.execute("""insert into library.local_track_files
            (track_id,library_root_id,private_path,content_signature)
            select id,%s,%s || '/' || id::text || '.flac','synthetic-global-review'
            from unnest(%s::bigint[]) id""",
            (root, db.root_paths[root] + "/" + token, [row["id"] for row in rows]))
        if tier is not None:
            connection.execute("""insert into app.track_preferences
                (account_id,library_id,track_id,track_key,love_tier)
                select %s,library_id,id,track_key,%s from library.local_tracks
                where library_id=%s and id=any(%s::bigint[])""",
                (db.account, tier, parent["library"], [row["id"] for row in rows]))
    return sorted(row["id"] for row in rows)


def build_native_alias_projection(db):
    """Build aliases from real owned inventory using the existing native owner.

    This scoped fixture query projects the documented builder row contract;
    it deliberately does not use the legacy bootstrap-owner lookup or modify
    app.bootstrap_owners. No custom alias map or invented readiness version.
    """
    from music_app.services.cache import serialize_relation_views
    from music_app.services.relation_projection_postgres import (
        build_relation_views_from_postgres_rows, build_ready_relation_projection_metadata,
        relation_projection_stale_reason, relation_source_fingerprint,
    )
    with connect(db.setup) as connection:
        rows = connection.execute("""select a.id as album_id,
            ar.id as owner_artist_id, ar.name as owner_artist_name,
            coalesce(nullif(a.metadata->>'album_artist',''),ar.name) as album_artist,
            false as album_is_compilation, null::bigint as member_artist_id,
            null::text as member_artist_name, null::text as featured_kind,
            false as member_artist_is_album_wide_track_artist,
            ''::text as relation_evidence_kind, f.id as track_file_id,
            r.id as library_root_id,r.root_path,f.relative_path,f.private_path
            from library.local_albums a
            join library.local_artists ar on ar.id=a.artist_id
            join library.local_tracks t on t.album_id=a.id and t.library_id=a.library_id
            join library.local_track_files f on f.track_id=t.id and f.scan_cache_stale is false
            join library.library_roots r on r.id=f.library_root_id and r.library_id=a.library_id
            where a.library_id=%s order by a.id,f.id""", (db.library,)).fetchall()
        views = serialize_relation_views(build_relation_views_from_postgres_rows({}, rows))
        fingerprint = relation_source_fingerprint(rows)
        scan_cache = {"relation_views": views, "relation_projection":
            build_ready_relation_projection_metadata(fingerprint,
                reason="isolated_review_fixture", duration_ms=0, source_row_count=len(rows))}
        assert relation_projection_stale_reason(scan_cache) == ""
        connection.execute("""update library.libraries set metadata=jsonb_set(
            metadata,'{scan_cache}',%s::jsonb) where id=%s""", (json.dumps(scan_cache), db.library))
    return views


def place_alias_evidence(db, album, canonical, *, container="Native Family/Native Artist"):
    """Normal album metadata and file locations consumed by the native builder."""
    with connect(db.setup) as connection:
        connection.execute("""update library.local_albums set metadata=
            jsonb_set(metadata,'{album_artist}',%s::jsonb) where id=%s and library_id=%s""",
            (json.dumps(canonical), album, db.library))
        for track, value in db.tracks.items():
            if value["album"] != album:
                continue
            relative = container + "/Album " + str(album) + "/" + str(track) + ".flac"
            path = db.root_paths[db.roots[db.library]] + "/" + relative
            connection.execute("""update library.local_track_files set
                private_path=%s,relative_path=%s where track_id=%s""", (path, relative, track))
            value["path"] = path
