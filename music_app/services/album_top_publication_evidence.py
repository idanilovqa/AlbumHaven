"""Bounded exact-source capture and append-only catalog presentation admission."""
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import PurePosixPath, PureWindowsPath
from uuid import uuid4

from psycopg.types.json import Jsonb

from music_app.services.album_top_publication_authority import require_source_browse
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.public_album_metadata import project_public_album_metadata, PublicMetadataError

CAPTURE_VERSION = 1
MAX_TRACKS = 5000
MAX_SOURCE_FILES = 10000
MAX_TOTAL_TRACKS = 100000
MAX_METADATA_BYTES = 32 * 1024 * 1024


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def source_barrier(connection, library_id):
    # Before the clock: TRUNCATE must wait on table access, not hold a table
    # needed by a capture which already owns the clock it is invalidating.
    connection.execute("""lock table library.album_metadata_sources, library.catalog_album_links,
        library.local_albums, library.local_artists, library.local_tracks,
        library.local_track_files, library.library_roots in access share mode""")
    # Runtime has no clock UPDATE privilege. The fixed-table definer grants
    # only lock acquisition; read current evidence after that lock has returned.
    connection.execute("select library.lock_public_metadata_source(%s)", (library_id,)).fetchone()
    row = connection.execute("""select generation from library.public_metadata_source_state
        where library_id=%s""", (library_id,)).fetchone()
    if row is None:
        raise AlbumTopError("evidence_unavailable", 409)
    return row["generation"]


def _path_type(flavor):
    if flavor == "posix":
        return PurePosixPath
    if flavor == "windows":
        return PureWindowsPath
    raise AlbumTopError("evidence_unavailable", 409)


def _container(path, flavor):
    if type(path) is not str or not path or "\x00" in path:
        raise AlbumTopError("evidence_unavailable", 409)
    # The inventory producer records its semantics. The serving host cannot
    # reinterpret that identity, including POSIX literal backslashes.
    parsed = _path_type(flavor)(path)
    if not parsed.is_absolute() or ".." in parsed.parts:
        raise AlbumTopError("evidence_unavailable", 409)
    return str(parsed.parent)


def _duration(value):
    if value is None:
        return None
    if type(value) not in (Decimal, int):
        raise AlbumTopError("evidence_unavailable", 409)
    try:
        milliseconds = Decimal(value) * 1000
        if (not milliseconds.is_finite() or milliseconds != milliseconds.to_integral_value()
                or not 0 <= milliseconds <= 2147483647):
            raise ValueError("Invalid duration")
        return int(milliseconds)
    except (InvalidOperation, ValueError):
        raise AlbumTopError("evidence_unavailable", 409) from None


def selection_source(connection, context, item, constraints):
    if "selected_source_ref" not in item:
        raise AlbumTopError("evidence_unavailable", 409)
    source = connection.execute("""select s.ref,s.library_id,s.local_album_id,s.library_root_id,
        s.container_identity,s.path_flavor,s.capture_builder_version,s.state,s.title,s.artist,s.year,
        s.title_origin,s.artist_origin,r.is_active,
        case when octet_length(r.root_path)<=8192 then r.root_path end as root_path
        from library.album_metadata_sources s
        join library.local_albums a on a.id=s.local_album_id and a.library_id=s.library_id
        join library.library_roots r on r.id=s.library_root_id and r.library_id=s.library_id
        join library.catalog_album_links c on c.local_album_id=s.local_album_id and c.library_id=s.library_id
        where s.ref=%s and s.library_id=%s and s.local_album_id=%s and c.catalog_ref=%s""",
        (item["selected_source_ref"], context.library_id, item["selected_local_album_id"], item["album_ref"])).fetchone()
    if (source is None or source["state"] != "active" or source["capture_builder_version"] != CAPTURE_VERSION
            or source["is_active"] is not True or source["root_path"] is None):
        raise AlbumTopError("evidence_unavailable", 409)
    path_type = _path_type(source["path_flavor"])
    container, root = path_type(source["container_identity"]), path_type(source["root_path"])
    if (not container.is_absolute() or not root.is_absolute() or ".." in container.parts
            or ".." in root.parts or not container.is_relative_to(root)
            or str(container) != source["container_identity"]):
        raise AlbumTopError("evidence_unavailable", 409)
    scope = {"selected_local_album_id": source["local_album_id"],
             "selected_source_ref": str(source["ref"]), "selected_library_root_id": source["library_root_id"]}
    require_source_browse(context, scope, constraints)
    return source, scope


def _source_files(connection, source):
    """Association is evidence to verify, never the physical membership filter.

    Both indexed branches stop at an overflow sentinel. Deduplicate and bound
    IDs before reading labels; unrelated root files cannot add projection work.
    Literal, server-validated flavor matches the expression-index predicate.
    """
    _path_type(source["path_flavor"])
    parent = ("library.public_metadata_container(private_path,'windows')"
              if source["path_flavor"] == "windows" else
              "library.public_metadata_container(private_path,'posix')")
    return connection.execute("""with candidate_ids as materialized (
        select id from (
          (select id from library.local_track_files where metadata_source_ref=%s
           order by id limit %s)
          union
          (select id from library.local_track_files where library_root_id=%s
           and """ + parent + """ is not null
           and pg_catalog.md5(""" + parent + """)=pg_catalog.md5(%s)
           and """ + parent + """ collate "C"=%s collate "C"
           order by id limit %s)
        ) candidates limit %s
      ) select f.id,
        case when octet_length(f.private_path)<=16384 then f.private_path end as private_path,
        f.metadata_source_ref,f.library_root_id,f.scan_cache_stale,
        t.id as track_id,t.library_id,t.album_id,
        case when length(t.title)<=1000 then t.title end as title,t.title_origin,t.artist_origin,
        t.disc_number,t.track_number,t.duration_seconds,
        case when length(ar.name)<=1000 then ar.name end as artist
        from candidate_ids c join library.local_track_files f on f.id=c.id
        join library.local_tracks t on t.id=f.track_id
        left join library.local_artists ar on ar.id=t.artist_id and ar.library_id=t.library_id
        order by t.id,f.id""",
        (source["ref"], MAX_SOURCE_FILES + 1, source["library_root_id"],
         source["container_identity"], source["container_identity"],
         MAX_SOURCE_FILES + 1, MAX_SOURCE_FILES + 1)).fetchall()


def capture(connection, context, *, top, items, constraints=None):
    generation = source_barrier(connection, context.library_id)
    captured, total_tracks, total_bytes = [], 0, 0
    try:
        for item in items:
            source, scope = selection_source(connection, context, item, constraints)
            if source["title_origin"] != "tag_metadata" or source["artist_origin"] != "tag_metadata":
                raise AlbumTopError("evidence_unavailable", 409)
            # Row and byte budgets are enforced before immutable inserts. File
            # multiplicity is bounded independently of logical track identity.
            files = _source_files(connection, source)
            if not files or len(files) > MAX_SOURCE_FILES:
                raise AlbumTopError("evidence_unavailable", 409)
            logical = {}
            for row in files:
                if (row["metadata_source_ref"] != source["ref"]
                        or row["library_id"] != context.library_id or row["album_id"] != source["local_album_id"]
                        or row["library_root_id"] != source["library_root_id"] or row["scan_cache_stale"] is not False
                        or _container(row["private_path"], source["path_flavor"]) != source["container_identity"]
                        or row["title_origin"] != "tag_metadata" or row["artist_origin"] != "tag_metadata"
                        or type(row["disc_number"]) is not int or row["disc_number"] <= 0
                        or type(row["track_number"]) is not int or row["track_number"] <= 0):
                    raise AlbumTopError("evidence_unavailable", 409)
                logical[row["track_id"]] = row
            if len(logical) > MAX_TRACKS:
                raise AlbumTopError("evidence_unavailable", 409)
            ordered = sorted(logical.values(), key=lambda row: (row["disc_number"], row["track_number"]))
            if len({(row["disc_number"], row["track_number"]) for row in ordered}) != len(ordered):
                raise AlbumTopError("evidence_unavailable", 409)
            tracks = [{"position": position, "title": row["title"], "artist_display": row["artist"],
                       "duration_ms": _duration(row["duration_seconds"])} for position, row in enumerate(ordered, 1)]
            revision = str(generation)
            positive = project_public_album_metadata({"ref": item["album_ref"], "title": source["title"],
                "artist_display": source["artist"], "release_year": source["year"]}, context=context,
                selected_local_album_id=source["local_album_id"], expected_evidence_revision=revision,
                edition_evidence=[{"catalog_ref": item["album_ref"], "library_id": context.library_id,
                    "local_album_id": source["local_album_id"], "evidence_revision": revision, "tracks": tracks}],
                constraints=constraints)
            total_tracks += len(tracks)
            total_bytes += len(canonical(positive))
            if total_tracks > MAX_TOTAL_TRACKS or total_bytes > MAX_METADATA_BYTES:
                raise AlbumTopError("evidence_unavailable", 409)
            # Include private identities in evidence only, never presentation.
            evidence_digest = digest([CAPTURE_VERSION, context.library_id, scope, item["album_ref"],
                source["path_flavor"], source["container_identity"], [row["track_id"] for row in ordered], positive])
            captured.append({"item": item, "source": scope, "metadata": positive,
                             "evidence_digest": evidence_digest})
    except PublicMetadataError as error:
        raise AlbumTopError("forbidden" if error.code == "forbidden" else "evidence_unavailable",
                            403 if error.code == "forbidden" else 409) from None
    reviewed = digest([CAPTURE_VERSION, context.library_id, str(top["ref"]), str(top["revision"]),
                       generation, [[row["item"], row["evidence_digest"]] for row in captured]])
    return {"generation": generation, "evidence_revision": reviewed, "items": captured}


def admit_presentation(connection, library_id, generation, captured):
    source, metadata = captured["source"], captured["metadata"]
    metadata_digest = digest(metadata)
    existing = connection.execute("""select s.presentation_ref from library.album_presentation_seals s
        join library.album_presentation_evidence e using
            (presentation_ref,library_id,selected_source_ref,capture_builder_version,evidence_digest)
        join catalog.album_presentation_versions p on p.ref=s.presentation_ref
        where s.library_id=%s and s.selected_source_ref=%s and s.capture_builder_version=%s
          and s.evidence_digest=%s and s.sealed_at is not null and s.seal_contract_version=1
          and p.catalog_ref=%s and p.metadata_digest=%s""",
        (library_id, source["selected_source_ref"], CAPTURE_VERSION, captured["evidence_digest"],
         metadata["album_ref"], metadata_digest)).fetchone()
    if existing:
        return str(existing["presentation_ref"])
    ref = str(uuid4())
    # Freeze the approved structure before writing. The same generated IDs are
    # used by INSERT and the SQL comparison; never reconstruct approval by reread.
    header = [ref, metadata["album_ref"], 1, metadata["title"], metadata["artist"],
              metadata["year"], metadata_digest]
    selected = [library_id, source["selected_local_album_id"], str(source["selected_source_ref"]),
                source["selected_library_root_id"], generation, CAPTURE_VERSION, captured["evidence_digest"]]
    tracks = [[str(uuid4()), track["position"], track["title"], track["artist"], track["duration_ms"]]
              for track in metadata["tracks"]]
    expected = ["album-presentation-seal-v1", header, selected, tracks]
    connection.execute("""insert into catalog.album_presentation_versions
        (ref,catalog_ref,contract_version,title,artist,year,metadata_digest) values(%s,%s,%s,%s,%s,%s,%s)""",
        header)
    # One bounded statement per edition, not one round trip per track.
    connection.execute("""insert into catalog.album_presentation_tracks(ref,presentation_ref,position,title,artist,duration_ms)
        select r,%s,p,t,a,d from unnest(%s::uuid[],%s::integer[],%s::text[],%s::text[],%s::integer[]) as x(r,p,t,a,d)""",
        (ref, [t[0] for t in tracks], [t[1] for t in tracks], [t[2] for t in tracks],
         [t[3] for t in tracks], [t[4] for t in tracks]))
    connection.execute("""insert into library.album_presentation_evidence
        (presentation_ref,library_id,selected_local_album_id,selected_source_ref,selected_library_root_id,
         captured_generation,capture_builder_version,evidence_digest) values(%s,%s,%s,%s,%s,%s,%s,%s)""",
        [ref, *selected])
    connection.execute("select library.seal_album_presentation(%s,%s,%s)",
                       (ref, len(tracks), Jsonb(expected)))
    return ref
