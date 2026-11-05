from __future__ import annotations

from collections.abc import Callable
from contextlib import ExitStack, nullcontext
from datetime import datetime, timezone
import logging
from pathlib import Path
from time import perf_counter
from typing import Any, Protocol

from config import PERSISTENCE_BACKEND_POSTGRES
from music_app.services.album_local_cover_integrity import (
    inferred_local_cover_belongs_to_track,
)
from music_app.services.album_ratings_postgres import PostgresAlbumRatingsService
from music_app.services.artist_credits import track_artist_credit_members
from music_app.services.artist_family_postgres import (
    replace_artist_family_projection_in_transaction,
)
from music_app.services.cache import (
    _AUTHORITATIVE_COVER_FIELDS,
    deserialize_file_entry,
    deserialize_relation_views,
    serialize_file_entry,
    serialize_relation_views,
)
from music_app.services.library import (
    _is_various_artist,
    album_separate_release_key,
    build_albums_from_file_cache,
    safe_int,
    split_album_artist_members,
)
from music_app.services.library_inventory_postgres import local_inventory_identity_key
from music_app.services.library_roots import build_root_provenance_payload, summarize_root_provenance_payloads
from music_app.services.metadata import normalize_exception_value
from music_app.services.music_identity_matching import same_artist_credit_spelling
from music_app.services.non_album_view_payloads import infer_blank_album_membership
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.relation_projection_postgres import (
    RELATION_PROJECTION_BUILDER_VERSION,
    RELATION_PROJECTION_METADATA_KEY,
    TargetedRelationPatchUnsupported,
    _load_relation_projection_sql,
    _relation_projection_scan_cache_from_row,
    artist_search_projection_stale_reason,
    build_ready_relation_projection_metadata,
    build_relation_views_from_postgres_rows,
    inventory_publication_advisory_lock_sql as _inventory_publication_advisory_lock_sql,
    load_relation_source_rows_sql,
    patch_artist_search_projection_in_transaction,
    patch_structural_relation_views,
    relation_projection_advisory_lock_sql,
    relation_projection_structure_complete,
    relation_projection_stale_reason,
    relation_source_fingerprint,
    replace_artist_search_projection_in_transaction,
)

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - keeps migration and diagnostic imports available.
    psycopg = None
    dict_row = None
    Jsonb = None


ScanCacheSnapshot = tuple[dict[str, dict[str, object]], float, dict[str, object], float, str | None]
_LOGGER = logging.getLogger(__name__)
_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_SOURCE = "runtime_scan_cache"
_SYNCHRONIZED_FEATURED_ARTIST_SOURCES = [
    _SOURCE,
    "repair_featured_artist_backfill",
]
_PIPELINE_BATCH_SIZE = 1_000
_MISSING_STRUCTURAL_VALUE = object()
_ALBUM_COVER_AUTHORITY_FIELDS = (
    "cover_selection_origin", "cover_selection_provenance", "local_cover_width", "local_cover_height",
    "remote_cover_url", "remote_cover_thumbnail_url", "remote_cover_source",
    "remote_cover_source_label", "remote_cover_album_url",
    "remote_cover_width", "remote_cover_height",
)
_ALBUM_COVER_METADATA_FIELDS = (
    "cover_revision", "cover_selection_repair_previous", *_ALBUM_COVER_AUTHORITY_FIELDS,
)
_TARGETED_INVENTORY_EDIT_FIELDS = frozenset(
    {"title", "genre", "track_number", "disc_number", "total_discs", "disc_subtitle", "album_type", "album_rating"}
)
_TARGETED_MEDIA_EDIT_FIELDS = _TARGETED_INVENTORY_EDIT_FIELDS | {
    "album", "artist", "album_artist", "year", "edition",
}
_TARGETED_TAG_EDIT_FIELDS = _TARGETED_MEDIA_EDIT_FIELDS | {"exception_type", "custom_collection_name"}
TARGETED_TAG_EDIT_FIELDS = _TARGETED_TAG_EDIT_FIELDS


class ScanCachePublicationSuperseded(RuntimeError):
    """Raised when a newer inventory mutation makes a prepared scan stale."""


class ScanCacheInventorySuperseded(ScanCachePublicationSuperseded):
    """A watcher or tag edit published files while the full scan was prepared."""


class StructuralTagEditDestinationConflict(RuntimeError):
    """Raised when a structural tag edit would collide with another album."""


class ScanCacheAdapter(Protocol):
    backend: str

    def load_snapshot(self, cache_path: Path, root_identity: object) -> ScanCacheSnapshot:
        ...

    def save_snapshot(
        self,
        cache_path: Path,
        file_cache: dict[str, dict[str, object]],
        root_identity: object,
        last_scan: float,
        *,
        relation_views: dict[str, object] | None = None,
        relations_last_built: float | None = None,
        separate_release_keys: set[str] | None = None,
        seed_missing_album_ratings: bool = False,
        album_rating_seed_guard: Callable[[Callable[[], object]], object] | None = None,
        publication_commit_guard: Callable[[Callable[[], object]], object] | None = None,
        before_commit: Callable[[Any], object] | None = None,
        expected_cover_mutation_revision: int | None = None,
        expected_inventory_mutation_revision: int | None = None,
        rebuild_relation_projection: bool = False,
        observed_library_root_ids: set[str] | None = None,
    ) -> dict[str, object] | None:
        ...

    def load_cover_mutation_revision(self) -> int:
        ...

    def load_inventory_mutation_revision(self) -> int:
        ...

    def persist_targeted_inventory_mutation(
        self,
        *,
        root_id: str,
        active_file_entries: dict[str, dict[str, object]],
        deleted_paths: tuple[str, ...] = (),
        deleted_subtrees: tuple[str, ...] = (),
        moves: tuple[dict[str, object], ...] = (),
        publication_guard: Callable | None = None,
    ) -> dict[str, object]:
        ...

    def persist_cover_selection(
        self,
        *,
        track_paths: set[str],
        selected_cover_path: Path | None,
        cover_revision: str | None = None,
        remote_cover_url: str | None = None,
        remote_cover_thumbnail_url: str | None = None,
        remote_cover_source: str | None = None,
        remote_cover_source_label: str | None = None,
        remote_cover_album_url: str | None = None,
        remote_cover_width: int | None = None,
        remote_cover_height: int | None = None,
        cover_selection_origin: str | None = None,
        explicit_selection: bool = False,
        reject_if_explicit_selection: bool = False,
        local_cover_width: int | None = None,
        local_cover_height: int | None = None,
        reject_if_user_controlled: bool = False,
        clear_selection: bool = False,
        expected_cover_selection_origin: str | None = None,
        expected_cover_revision: str | None = None,
        expected_cover_state: tuple[str | None, str | None] | None = None,
        expected_inventory_mutation_revision: int | None = None,
        commit_guard: Callable[[Callable[[], object]], object] | None = None,
    ) -> dict[str, object]:
        ...

    def persist_structural_tag_edit(
        self,
        *,
        changed_paths: set[str],
        previous_file_entries: dict[str, dict[str, object]],
        updated_file_entries: dict[str, dict[str, object]],
        changed_field_names: set[str],
        commit_guard: Callable[[Callable[[], object]], object] | None = None,
        before_commit: Callable[[Any], object] | None = None,
        rebuild_relation_projection: bool = False,
    ) -> dict[str, object]:
        ...

    def validate_structural_tag_edit(
        self,
        *,
        changed_paths: set[str],
        previous_file_entries: dict[str, dict[str, object]],
        updated_file_entries: dict[str, dict[str, object]],
        changed_field_names: set[str],
    ) -> None:
        ...


_METADATA_REPAIR_LEASE_KEY = "album-haven:file-metadata-repair"


class MetadataRepairLease:
    def __init__(self, connection: Any) -> None:
        self._connection = connection

    def release(self) -> None:
        connection, self._connection = self._connection, None
        if connection is None:
            return
        try:
            connection.execute(
                "select pg_advisory_unlock(hashtextextended(%(key)s, 0))",
                {"key": _METADATA_REPAIR_LEASE_KEY},
            )
        finally:
            connection.close()


class PostgresScanCacheAdapter:
    backend = PERSISTENCE_BACKEND_POSTGRES

    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
        build_albums: Callable[[dict[str, dict[str, object]], set[str] | None], list[object]] = build_albums_from_file_cache,
    ) -> None:
        self._config = config
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect
        self._build_albums = build_albums

    def load_last_scan(self, root_identity: object) -> float:
        with self._connect_to_database() as connection:
            row = _first_row(connection.execute(_load_scan_snapshot_sql(metadata_only=True)))
        payload = _row_mapping(row) if row is not None else {}
        if str(payload.get("library_root_identity") or "") != str(root_identity):
            return 0.0
        return _float_or_zero(payload.get("last_scan"))

    def try_acquire_metadata_repair_lease(self) -> "MetadataRepairLease | None":
        """Hold a database-wide session lock so one instance repairs at a time.

        Several app instances may share one library database. The lease lives on
        its own connection until released (or until that process exits), so a
        second instance sees it as held and skips its own repair scan.
        """
        connection = self._connect_to_database()
        try:
            if hasattr(connection, "autocommit"):
                connection.autocommit = True
            row = _first_row(connection.execute(
                "select pg_try_advisory_lock(hashtextextended(%(key)s, 0)) as acquired",
                {"key": _METADATA_REPAIR_LEASE_KEY},
            ))
            if row is not None and bool(_row_mapping(row).get("acquired")):
                return MetadataRepairLease(connection)
        except Exception:
            connection.close()
            raise
        connection.close()
        return None

    def has_outdated_file_metadata(self) -> bool:
        """True when an active file entry was read by an older metadata reader."""
        from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION

        with self._connect_to_database() as connection:
            row = _first_row(connection.execute(
                """
                select exists (
                  select 1
                  from library.local_track_files
                  where scan_cache_stale is false
                    and scan_file_entry_is_object is true
                    and metadata #> '{scan_cache,file_entry}' ? 'path'
                    and (
                      coalesce(metadata #>> '{scan_cache,file_entry,metadata_schema_version}', '')
                        <> %(schema_version)s
                      or not (metadata #> '{scan_cache,file_entry}' ? 'release_date')
                    )
                ) as outdated
                """,
                {"schema_version": str(FILE_METADATA_SCHEMA_VERSION)},
            ))
        return bool(_row_mapping(row).get("outdated")) if row is not None else False

    def load_snapshot(self, cache_path: Path, root_identity: object) -> ScanCacheSnapshot:
        try:
            return self.load_snapshot_strict(cache_path, root_identity)
        except Exception as exc:
            return {}, 0.0, {}, 0.0, f"Could not read Postgres scan cache: {exc}"

    def load_cover_mutation_revision(self) -> int:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            return _load_cover_mutation_revision(connection)

    def load_cover_selections(self, album_ids: set[int]) -> dict[int, dict[str, object]]:
        if not album_ids:
            return {}
        with self._connect_to_database() as connection:
            rows = connection.execute(_load_cover_selections_sql(), {
                "album_ids": sorted(album_ids), "source": _SOURCE,
            }).fetchall()
        return {
            int(payload["album_id"]): {
                "selected_cover_path": str(payload.get("cover_path") or "").strip() or None,
                "cover_selection_origin": str(payload.get("cover_selection_origin") or "").strip() or None,
                **({"cover_selection_provenance": "explicit"} if payload.get("cover_selection_provenance") == "explicit" else {}),
                **({"cover_revision": payload["cover_revision"]} if payload.get("cover_revision") else {}),
                **({key: payload[key] for key in ("remote_cover_url", "remote_cover_width", "remote_cover_height") if payload.get(key) is not None} if payload.get("remote_cover_url") else {}),
            }
            for row in rows
            if (payload := _row_mapping(row))
        }

    def load_inventory_mutation_revision(self) -> int:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            return _load_inventory_mutation_revision(connection)

    def load_inventory_published_since(self, since_epoch: float) -> tuple[dict[str, dict[str, object]], set[str]]:
        """Files another publication wrote or removed after a full scan started."""
        with self._connect_to_database() as connection:
            rows = connection.execute(
                """
                select files.private_path, files.scan_cache_stale,
                  files.metadata #> '{scan_cache,file_entry}' as file_entry
                from library.local_track_files files
                join library.library_roots roots on roots.id = files.library_root_id and roots.is_active
                join library.libraries libraries on libraries.id = roots.library_id
                join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
                where owners.owner_key = 'local-bootstrap-owner' and libraries.name = 'Local Library'
                  and libraries.library_kind = 'local'
                  and files.last_seen_at >= to_timestamp(%(since)s)
                """,
                {"since": float(since_epoch)},
            ).fetchall()
        published: dict[str, dict[str, object]] = {}
        removed: set[str] = set()
        for row in rows:
            payload = _row_mapping(row)
            path = str(payload["private_path"])
            entry = payload.get("file_entry")
            if payload.get("scan_cache_stale") or not isinstance(entry, dict):
                removed.add(path)
                continue
            try:
                published[path] = {**deserialize_file_entry(entry), "path": path}
            except Exception:
                published[path] = {**entry, "path": path}
        return published, removed

    def load_file_entries(self, paths, *, include_siblings=False):
        """Read only selected files, optionally including their album containers."""
        with self._connect_to_database() as connection:
            return _load_selected_file_entries(connection, paths, include_siblings=include_siblings)

    def load_targeted_subtree_track_paths(
        self, subtrees_by_root: dict[str, set[str]],
    ) -> tuple[str, ...]:
        """Resolve source reservation keys, including retained stale members."""
        subtrees = [
            {"root_id": root_id, "path": path}
            for root_id, paths in subtrees_by_root.items()
            for path in sorted(paths)
        ]
        if not subtrees:
            return ()
        with self._connect_to_database() as connection:
            rows = connection.execute(
                _load_targeted_subtree_track_paths_sql(),
                {"subtrees": _jsonb(subtrees), "source": _SOURCE},
            ).fetchall()
        return tuple(str(_row_mapping(row)["private_path"]) for row in rows)

    def persist_targeted_inventory_mutation(
        self,
        *,
        root_id: str,
        active_file_entries: dict[str, dict[str, object]],
        deleted_paths: tuple[str, ...] = (),
        deleted_subtrees: tuple[str, ...] = (),
        moves: tuple[dict[str, object], ...] = (),
        publication_guard: Callable | None = None,
    ) -> dict[str, object]:
        normalized_root_id = str(root_id or "").strip()
        if not normalized_root_id:
            raise ValueError("Targeted inventory mutation requires a root id.")
        file_cache = _without_nul_file_entries({
            str(path): dict(entry)
            for path, entry in active_file_entries.items()
            if str(path).strip() and isinstance(entry, dict)
        })
        incoming_track_paths = set(file_cache)
        stale_by_root: dict[str, dict[str, set[str]]] = {
            normalized_root_id: {
                "paths": {str(path) for path in deleted_paths if str(path)},
                "subtrees": {
                    str(path) for path in deleted_subtrees if str(path)
                },
            }
        }
        active_paths_by_root: dict[str, set[str]] = {}
        for path, entry in file_cache.items():
            active_root_id = str(
                entry.get("library_root_id") or normalized_root_id
            ).strip()
            active_paths_by_root.setdefault(active_root_id, set()).add(path)
        for move in moves:
            source_root_id = str(
                move.get("source_root_id") or normalized_root_id
            ).strip()
            source_path = str(move.get("source_path") or "").strip()
            if not source_root_id or not source_path:
                continue
            target = stale_by_root.setdefault(
                source_root_id,
                {"paths": set(), "subtrees": set()},
            )
            target["subtrees" if move.get("is_directory") else "paths"].add(
                source_path
            )

        with self._connect_to_database() as connection, ExitStack() as publication_stack:
            connection.execute(_inventory_publication_advisory_lock_sql())
            connection.execute(relation_projection_advisory_lock_sql())
            _ensure_bootstrap_context(connection)
            from music_app.services.gallery_projection_postgres import gallery_projection_context
            gallery_context_before = gallery_projection_context(connection)
            if any(target["paths"] or target["subtrees"] for target in stale_by_root.values()):
                from music_app.services.library_watch_health import guard_destructive_library_publication

                affected_roots = set(stale_by_root) | set(active_paths_by_root)
                affected_roots.update(
                    str(move.get("destination_root_id") or normalized_root_id)
                    for move in moves
                )
                publication_stack.enter_context(
                    (publication_guard or guard_destructive_library_publication)(connection, sorted(affected_roots))
                )
            separate_release_keys = _load_separate_release_keys(connection)
            context_seed_paths = set(file_cache)
            stale_context_paths: set[str] = set()
            for stale_targets in stale_by_root.values():
                context_seed_paths.update(stale_targets["paths"])
                stale_context_paths.update(stale_targets["paths"])
            stale_subtrees = [
                {"root_id": stale_root_id, "subtree": subtree}
                for stale_root_id, stale_targets in stale_by_root.items()
                for subtree in sorted(stale_targets["subtrees"])
            ]
            if stale_subtrees:
                stale_subtree_paths = {
                    str(_row_mapping(row).get("private_path") or "")
                    for row in connection.execute(
                        _load_targeted_subtree_track_paths_sql(),
                        {"subtrees": _jsonb(stale_subtrees), "source": _SOURCE},
                    ).fetchall()
                }
                stale_subtree_paths.discard("")
                context_seed_paths.update(stale_subtree_paths)
                stale_context_paths.update(stale_subtree_paths)
                context_seed_paths.discard("")
            existing_memberships = [
                _row_mapping(row)
                for row in connection.execute(
                    _load_targeted_album_memberships_sql(),
                    {"active_paths": sorted(context_seed_paths)},
                ).fetchall()
            ]
            prior_album_ids = {int(row['album_id'] or 0) for row in existing_memberships if 'album_id' in row}
            existing_track_paths = {
                str(row.get("private_path") or "").strip()
                for row in existing_memberships
                if str(row.get("private_path") or "").strip()
            }
            move_destination_paths: set[str] = set()
            for move in moves:
                destination_path = str(move.get("destination_path") or "").strip()
                if not destination_path:
                    continue
                if move.get("is_directory"):
                    destination = Path(destination_path)
                    move_destination_paths.update(
                        path
                        for path in incoming_track_paths
                        if Path(path) == destination
                        or Path(path).is_relative_to(destination)
                    )
                else:
                    move_destination_paths.add(destination_path)
            new_track_paths = sorted(
                incoming_track_paths - existing_track_paths - move_destination_paths,
                key=str.casefold,
            )
            # A watcher batch is not a complete physical album. Compare against
            # its persisted source siblings before classifying partial copies.
            from music_app.services.album_local_membership import physical_album_root, physical_album_root_sql

            incoming_album_identities = sorted(
                {
                    "\x1f".join(
                        " ".join(str(value or "").lower().split())
                        for value in (artist, album)
                    )
                    for artist, album in (
                        *(
                            (
                                entry.get("album_artist") or entry.get("artist"),
                                entry.get("album"),
                            )
                            for entry in file_cache.values()
                        ),
                        *(
                            (
                                row.get("album_artist") or row.get("artist_key"),
                                row.get("album_title"),
                            )
                            for row in existing_memberships
                        ),
                    )
                    if artist and album
                }
            )
            incoming_containers = sorted(
                {
                    physical_album_root(path)
                    for path in (
                        *(entry.get("path") for entry in file_cache.values()),
                        *(row.get("private_path") for row in existing_memberships),
                    )
                    if path
                }
            )
            context_sql = _load_file_entries_sql().replace(
                "order by library.local_track_files.private_path;",
                "and (concat_ws(E'\\x1f', "
                "regexp_replace(lower(btrim(coalesce(library.local_track_files.scan_file_album_artist, ''))), '[[:space:]]+', ' ', 'g'), "
                "regexp_replace(lower(btrim(coalesce(library.local_track_files.scan_file_album, ''))), '[[:space:]]+', ' ', 'g')) "
                "= any(%(album_identities)s::text[]) "
                f"or {physical_album_root_sql('library.local_track_files.private_path')} = any(%(physical_roots)s::text[])) "
                "order by library.local_track_files.private_path;",
            )
            membership_context = {}
            for raw_row in connection.execute(context_sql, {
                "source": _SOURCE, "album_identities": incoming_album_identities,
                "physical_roots": [value.replace('\\', '/') for value in incoming_containers],
            }).fetchall():
                context_row = _row_mapping(raw_row)
                context_entry = context_row.get("file_entry") or _fallback_file_entry(context_row)
                if isinstance(context_entry, dict) and context_entry.get("path"):
                    membership_context[str(context_entry["path"])] = dict(context_entry)
            file_cache = _restore_structurally_inherited_covers(
                file_cache,
                membership_context,
            )
            incoming_entries = dict(file_cache)
            file_cache = {**membership_context, **file_cache}
            existing_memberships = [
                _row_mapping(row)
                for row in connection.execute(
                    _load_targeted_album_memberships_sql(),
                    {"active_paths": sorted(file_cache)},
                ).fetchall()
            ]
            prior_album_ids.update(int(row['album_id'] or 0) for row in existing_memberships if 'album_id' in row)
            file_cache = {
                path: entry
                for path, entry in file_cache.items()
                if path not in stale_context_paths or path in incoming_track_paths
            }
            albums = self._build_albums(
                _file_cache_with_inferred_blank_album_memberships(file_cache),
                separate_release_keys,
            )
            (
                artist_rows,
                album_rows,
                featured_artist_rows,
                track_rows,
                track_file_rows,
            ) = _inventory_rows_from_albums(
                file_cache,
                albums,
            )
            album_memberships = [row for row in existing_memberships if row.get('album_key')]
            _remap_targeted_album_identity_rows(
                album_rows=album_rows,
                featured_artist_rows=featured_artist_rows,
                track_rows=track_rows,
                existing_memberships=album_memberships,
                separate_release_keys=separate_release_keys,
                preferred_paths=_targeted_preferred_paths(
                    incoming_entries=incoming_entries,
                    context_entries=membership_context,
                    existing_memberships=album_memberships,
                ),
                excluded_paths=stale_context_paths,
            )
            _follow_existing_year_split_album_keys(
                connection,
                album_rows=album_rows,
                featured_artist_rows=featured_artist_rows,
                track_rows=track_rows,
            )
            _execute_semantic_local_album_key_adoptions(connection, album_rows)
            affected_album_keys = {
                str(row.get("album_key") or "").strip()
                for row in (*album_rows, *existing_memberships)
                if str(row.get("album_key") or "").strip()
            }
            _execute_pipeline_batches(
                connection, _upsert_local_artist_sql(preserve_existing_identity=True), artist_rows,
            )
            identity_conflicts = _withhold_semantic_identity_conflicts(
                connection,
                album_rows=album_rows,
                featured_artist_rows=featured_artist_rows,
                track_rows=track_rows,
                track_file_rows=track_file_rows,
                separate_release_keys=separate_release_keys,
            )
            if identity_conflicts:
                withheld_album_keys = {entry["album_key"] for entry in identity_conflicts}
                affected_album_keys.difference_update(withheld_album_keys)
            _execute_pipeline_batches(
                connection,
                _upsert_local_album_sql(preserve_existing_cover_authority=True),
                album_rows,
            )
            _execute_pipeline_batches(
                connection,
                _upsert_local_album_featured_artist_sql(),
                featured_artist_rows,
            )
            _execute_set_based_batches(connection, _upsert_local_track_sql(), track_rows)
            _execute_set_based_batches(
                connection,
                _upsert_local_track_file_sql(),
                track_file_rows,
            )
            inventory_changed = bool(file_cache)
            for stale_root_id, stale_targets in sorted(stale_by_root.items()):
                paths = sorted(stale_targets["paths"])
                subtrees = sorted(stale_targets["subtrees"])
                if not paths and not subtrees:
                    continue
                stale_rows = connection.execute(
                    _mark_targeted_track_files_stale_sql(),
                    {
                        "root_id": stale_root_id,
                        "deleted_paths": paths,
                        "deleted_subtrees": subtrees,
                        "active_paths": sorted(
                            active_paths_by_root.get(stale_root_id, ())
                        ),
                        "source": _SOURCE,
                    },
                ).fetchall()
                inventory_changed = inventory_changed or bool(stale_rows)
                affected_album_keys.update(
                    str(_row_mapping(row).get("affected_album_key") or "").strip()
                    for row in stale_rows
                    if str(
                        _row_mapping(row).get("affected_album_key") or ""
                    ).strip()
                )
            retired = connection.execute(
                _retire_placeholder_albums_sql(), {"album_ids": sorted(prior_album_ids - {0})},
            ).fetchall()
            inventory_changed = inventory_changed or bool(retired)
            affected_album_keys.update(str(_row_mapping(row)["album_key"]) for row in retired)
            if not inventory_changed:
                return {
                    "inventory_mutation_revision": 0,
                    "affected_album_keys": [],
                    "new_track_paths": new_track_paths,
                    **({"identity_conflicts": identity_conflicts} if identity_conflicts else {}),
                }
            # A logical album can span different containers and configured
            # roots. Replace scan-owned credits using all its retained active
            # members, not just the paths selected by this watcher event.
            synchronized_featured_album_keys = []
            if affected_album_keys:
                complete_rows = connection.execute(
                    _load_file_entries_sql(targeted_albums=True),
                    {"source": _SOURCE, "album_keys": sorted(affected_album_keys)},
                ).fetchall()
                files_by_album: dict[str, dict[str, dict[str, object]]] = {}
                owner_keys: dict[str, str] = {}
                for raw_row in complete_rows:
                    row = _row_mapping(raw_row)
                    file_entry = _targeted_surviving_file_entry(row)
                    if file_entry is None:
                        continue
                    files_by_album.setdefault(str(row["album_key"]), {})[str(row["private_path"])] = file_entry
                    owner_keys[str(row["album_key"])] = str(row.get("album_owner_key") or "")
                # Entirely missing albums retain their historical credits.
                # A deletion that leaves active members reconciles those members.
                synchronized_featured_album_keys = sorted(files_by_album)
                featured_artist_rows = []
                aggregate_rows = []
                for album_key, complete_cache in files_by_album.items():
                    complete_albums = self._build_albums(
                        _file_cache_with_inferred_blank_album_memberships(complete_cache), separate_release_keys,
                    )
                    complete_artists, complete_album_rows, complete_featured, _, _ = _inventory_rows_from_albums(complete_cache, complete_albums)
                    _execute_pipeline_batches(
                    connection, _upsert_local_artist_sql(preserve_existing_identity=True), complete_artists,
                )
                    member_names = _deduped_artist_names([
                        name for album in complete_albums
                        for name in (getattr(album, "artists", []) or [])
                    ])
                    artist_names = {row["artist_key"]: row["name"] for row in complete_artists}
                    featured_names = _deduped_artist_names([
                        artist_names[row["artist_key"]]
                        for row in complete_featured
                        if row["artist_key"] != owner_keys[album_key]
                        and row["artist_key"] in artist_names
                    ])
                    cover_row = next(
                        (row for row in complete_album_rows if row["cover_path"]),
                        complete_album_rows[0] if complete_album_rows else {},
                    )
                    cover_metadata = _jsonb_compatible(cover_row.get("metadata") or {})
                    aggregate_rows.append({
                        "album_key": album_key,
                        "release_year": next((row["release_year"] for row in complete_album_rows if row.get("release_year") is not None), None),
                        "cover_path": cover_row.get("cover_path"),
                        "cover_metadata": _jsonb({
                            field: cover_metadata.get(field)
                            for field in _ALBUM_COVER_METADATA_FIELDS
                            if field != "cover_selection_repair_previous" or field in cover_metadata
                        }),
                        "metadata": _jsonb({
                            "artists": member_names,
                            "featured_artists": featured_names,
                            "is_compilation": any(bool(getattr(album, "is_compilation", False)) for album in complete_albums),
                            "root_provenance": summarize_root_provenance_payloads([
                                build_root_provenance_payload(entry.get("library_root_id"), entry.get("library_root_category"))
                                for entry in complete_cache.values()
                            ]),
                        }),
                    })
                    for featured_row in complete_featured:
                        featured_row["album_key"] = album_key
                        if featured_row["featured_kind"] == "owner" and owner_keys[album_key]:
                            featured_row["artist_key"] = owner_keys[album_key]
                    featured_artist_rows.extend(complete_featured)
                _execute_pipeline_batches(connection, _update_targeted_album_aggregate_sql(), aggregate_rows)
                _execute_pipeline_batches(connection, _upsert_local_album_featured_artist_sql(), featured_artist_rows)
            connection.execute(
                _synchronize_targeted_local_album_featured_artists_sql(),
                {
                    "affected_album_keys": synchronized_featured_album_keys,
                    "current_featured_rows": _jsonb(
                        [
                            {
                                "album_key": row["album_key"],
                                "artist_key": row["artist_key"],
                                "featured_kind": row["featured_kind"],
                            }
                            for row in featured_artist_rows
                        ]
                    ),
                    "synchronized_sources": _SYNCHRONIZED_FEATURED_ARTIST_SOURCES,
                },
            )
            revision_row = _first_row(
                connection.execute(_increment_inventory_mutation_revision_sql())
            )
            revision = int(
                _row_mapping(revision_row).get("inventory_mutation_revision") or 0
            )
            from music_app.services.scoped_relation_projection import publish_affected_relation_projection
            publish_affected_relation_projection(
                connection, album_keys=affected_album_keys,
                album_ids=prior_album_ids,
                track_paths=context_seed_paths | set(file_cache), reason="targeted_reconciliation",
                config=self._config,
                expected_gallery_generation=(gallery_context_before or {}).get("generation"),
            )
            connection.commit()
        return {
            "inventory_mutation_revision": revision,
            "affected_album_keys": sorted(affected_album_keys),
            "new_track_paths": new_track_paths,
            **({"identity_conflicts": identity_conflicts} if identity_conflicts else {}),
        }

    def load_snapshot_strict(self, cache_path: Path, root_identity: object) -> ScanCacheSnapshot:
        del cache_path
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            snapshot_row = _first_row(connection.execute(_load_scan_snapshot_sql()))
            snapshot_payload = _row_mapping(snapshot_row).get("scan_cache") if snapshot_row is not None else None
            if not isinstance(snapshot_payload, dict):
                return {}, 0.0, {}, 0.0, None
            if str(snapshot_payload.get("library_root_identity") or "") != str(root_identity):
                return {}, 0.0, {}, 0.0, None
            file_rows = list(connection.execute(_load_file_entries_sql(), {"source": _SOURCE}).fetchall())

        file_cache: dict[str, dict[str, object]] = {}
        for row in file_rows:
            row_payload = _row_mapping(row)
            file_entry = row_payload.get("file_entry")
            if not isinstance(file_entry, dict):
                file_entry = _fallback_file_entry(row_payload)
            if not isinstance(file_entry, dict):
                continue
            path = str(row_payload.get("private_path") or file_entry.get("path") or "").strip()
            if not path:
                continue
            try:
                hydrated_entry = deserialize_file_entry(file_entry)
            except Exception:
                hydrated_entry = dict(file_entry)
            hydrated_entry["path"] = path
            if type(row_payload.get("album_is_compilation")) is bool:
                hydrated_entry["is_compilation"] = row_payload[
                    "album_is_compilation"
                ]
            cover_selection_origin = str(
                row_payload.get("cover_selection_origin") or ""
            ).strip().casefold()
            hydrated_entry["cover_selection_origin"] = (
                cover_selection_origin
                if cover_selection_origin in {"user", "automatic"}
                else None
            )
            hydrated_entry["cover_selection_provenance"] = (
                "explicit" if row_payload.get("cover_selection_provenance") == "explicit" else None
            )
            hydrated_entry["album_id"] = row_payload.get("album_id")
            file_cache[path] = hydrated_entry

        relation_views = deserialize_relation_views(snapshot_payload.get("relation_views"))
        return (
            file_cache,
            _float_or_zero(snapshot_payload.get("last_scan")),
            relation_views,
            _float_or_zero(snapshot_payload.get("relations_last_built")),
            None,
        )

    def persist_cover_selection(
        self,
        *,
        track_paths: set[str],
        selected_cover_path: Path | None,
        cover_revision: str | None = None,
        remote_cover_url: str | None = None,
        remote_cover_thumbnail_url: str | None = None,
        remote_cover_source: str | None = None,
        remote_cover_source_label: str | None = None,
        remote_cover_album_url: str | None = None,
        remote_cover_width: int | None = None,
        remote_cover_height: int | None = None,
        cover_selection_origin: str | None = None,
        explicit_selection: bool = False,
        reject_if_explicit_selection: bool = False,
        local_cover_width: int | None = None,
        local_cover_height: int | None = None,
        reject_if_user_controlled: bool = False,
        clear_selection: bool = False,
        expected_cover_selection_origin: str | None = None,
        expected_cover_revision: str | None = None,
        expected_cover_state: tuple[str | None, str | None] | None = None,
        expected_inventory_mutation_revision: int | None = None,
        commit_guard: Callable[[Callable[[], object]], object] | None = None,
    ) -> dict[str, object]:
        normalized_track_paths = sorted(
            {str(path or "").strip() for path in track_paths if str(path or "").strip()}
        )
        if not normalized_track_paths:
            raise ValueError("Cover selection requires at least one track path.")
        normalized_origin = str(cover_selection_origin or "").strip().casefold() or None
        if normalized_origin is not None and normalized_origin not in {"user", "automatic"}:
            raise ValueError("cover_selection_origin must be 'user' or 'automatic'.")
        if explicit_selection and normalized_origin != "user":
            raise ValueError("Explicit cover selection requires user ownership.")
        if reject_if_user_controlled and normalized_origin != "automatic":
            raise ValueError("Only automatic cover persistence may reject user-controlled albums.")
        normalized_expected_origin = str(
            expected_cover_selection_origin or ""
        ).strip().casefold() or None
        normalized_expected_revision = str(expected_cover_revision or "").strip() or None
        if normalized_expected_origin is not None and normalized_expected_origin not in {
            "user",
            "automatic",
        }:
            raise ValueError("expected_cover_selection_origin must be 'user' or 'automatic'.")
        if expected_cover_state is not None:
            if expected_cover_selection_origin is not None or expected_cover_revision is not None:
                raise ValueError("Explicit expected cover state cannot be combined with legacy expected fields.")
            if (
                not isinstance(expected_cover_state, tuple)
                or len(expected_cover_state) != 2
                or any(value is not None and not isinstance(value, str) for value in expected_cover_state)
            ):
                raise ValueError("Explicit expected cover state requires a pair of nullable strings.")
            normalized_expected_origin = (expected_cover_state[0] or "").strip().casefold()
            normalized_expected_revision = (expected_cover_state[1] or "").strip()
            if normalized_expected_origin not in {"", "user", "automatic"}:
                raise ValueError("Expected cover selection origin must be empty, 'user' or 'automatic'.")
        elif (normalized_expected_origin is None) != (normalized_expected_revision is None):
            raise ValueError(
                "Expected cover state requires both selection origin and cover revision."
            )
        if reject_if_explicit_selection and expected_cover_state is None and normalized_expected_origin is None:
            raise ValueError("Rejecting explicit selections requires an expected cover state.")
        has_local_dimensions = local_cover_width is not None or local_cover_height is not None
        if has_local_dimensions and (
            type(local_cover_width) is not int or type(local_cover_height) is not int
            or local_cover_width <= 0 or local_cover_height <= 0
            or selected_cover_path is None or clear_selection
        ):
            raise ValueError("Local cover dimensions require a selected local image and two positive integers.")
        resolved_cover_path = Path(selected_cover_path) if selected_cover_path is not None else None
        normalized_remote_url = str(remote_cover_url or "").strip() or None
        if clear_selection and (resolved_cover_path is not None or normalized_remote_url is not None):
            raise ValueError("Clearing a cover selection cannot include a replacement cover.")
        if resolved_cover_path is None and normalized_remote_url is None and not clear_selection:
            raise ValueError("Cover selection requires a local path or linked remote URL.")
        if resolved_cover_path is not None and normalized_remote_url is not None:
            raise ValueError("Cover selection cannot persist local and linked remote covers together.")
        if resolved_cover_path is not None and not cover_revision:
            from music_app.services.cover_workflow import cover_revision_for_path

            cover_revision = cover_revision_for_path(resolved_cover_path)
        linked_remote = normalized_remote_url is not None
        remote_params = (
            {
                "remote_cover_url": normalized_remote_url,
                "remote_cover_thumbnail_url": str(remote_cover_thumbnail_url or "").strip() or normalized_remote_url,
                "remote_cover_source": str(remote_cover_source or "").strip() or None,
                "remote_cover_source_label": str(remote_cover_source_label or "").strip() or None,
                "remote_cover_album_url": str(remote_cover_album_url or "").strip() or None,
                "remote_cover_width": int(remote_cover_width) if remote_cover_width is not None else None,
                "remote_cover_height": int(remote_cover_height) if remote_cover_height is not None else None,
            }
            if linked_remote
            else {}
        )
        with self._connect_to_database() as connection:
            connection.execute(_inventory_publication_advisory_lock_sql())
            _ensure_bootstrap_context(connection)
            if (
                expected_inventory_mutation_revision is not None
                and _load_inventory_mutation_revision(connection)
                != int(expected_inventory_mutation_revision)
            ):
                raise ScanCachePublicationSuperseded(
                    "Inventory changed while cover selection was prepared."
                )
            expected_cover_state_guard = expected_cover_state is not None or normalized_expected_origin is not None
            if not reject_if_user_controlled and not expected_cover_state_guard:
                connection.execute(_increment_cover_mutation_revision_sql())
            result_row = _first_row(
                connection.execute(
                    _persist_local_cover_selection_sql(
                        include_origin=normalized_origin is not None,
                        include_linked_remote=linked_remote,
                        include_expected_cover_state=expected_cover_state_guard,
                        include_clear_selection=clear_selection,
                        include_explicit_selection=explicit_selection,
                        include_reject_explicit_selection=reject_if_explicit_selection,
                        include_local_dimensions=has_local_dimensions,
                    ),
                    {
                        "track_paths": normalized_track_paths,
                        "selected_cover_path": str(resolved_cover_path) if resolved_cover_path else None,
                        "cover_revision": str(cover_revision) if cover_revision else None,
                        **({"local_cover_width": local_cover_width, "local_cover_height": local_cover_height} if has_local_dimensions else {}),
                        **remote_params,
                        **(
                            {
                                "expected_cover_selection_origin": normalized_expected_origin,
                                "expected_cover_revision": normalized_expected_revision,
                            }
                            if expected_cover_state_guard
                            else {}
                        ),
                        **(
                            {
                                "cover_selection_origin": normalized_origin,
                                "reject_if_user_controlled": bool(reject_if_user_controlled),
                            }
                            if normalized_origin is not None
                            else {}
                        ),
                    },
                )
            )
            result = _row_mapping(result_row)
            input_path_count = int(result.get("input_path_count") or 0)
            resolved_path_count = int(result.get("resolved_path_count") or 0)
            selected_album_count = int(result.get("selected_album_count") or 0)
            album_track_file_count = int(result.get("album_track_file_count") or 0)
            album_rows_updated = int(result.get("album_rows_updated") or 0)
            track_file_rows_updated = int(result.get("track_file_rows_updated") or 0)
            blocked_by_user_selection = bool(result.get("blocked_by_user_selection"))
            blocked_by_expected_cover_state = bool(
                result.get("blocked_by_expected_cover_state")
            )
            if blocked_by_user_selection:
                # A guarded automatic cover write must never run when the
                # persisted user-selection check rejected this transaction.
                connection.commit()
                return {
                    "album_rows_updated": 0,
                    "track_file_rows_updated": 0,
                    "blocked_by_user_selection": True,
                }
            if blocked_by_expected_cover_state:
                connection.commit()
                return {
                    "album_rows_updated": 0,
                    "track_file_rows_updated": 0,
                    "blocked_by_expected_cover_state": True,
                }
            if reject_if_user_controlled or expected_cover_state_guard:
                connection.execute(_increment_cover_mutation_revision_sql())
            if (
                input_path_count != len(normalized_track_paths)
                or resolved_path_count != input_path_count
                or selected_album_count != 1
                or album_rows_updated != 1
                or album_track_file_count < resolved_path_count
                or track_file_rows_updated != album_track_file_count
            ):
                raise RuntimeError(
                    "Targeted cover persistence did not update the complete selected album inventory."
                    f" expected_path_count={len(normalized_track_paths)}"
                    f" input_path_count={input_path_count}"
                    f" resolved_path_count={resolved_path_count}"
                    f" selected_album_count={selected_album_count}"
                    f" album_track_file_count={album_track_file_count}"
                    f" album_rows_updated={album_rows_updated}"
                    f" track_file_rows_updated={track_file_rows_updated}"
                )
            if commit_guard is not None:
                commit_guard(connection.commit)
        return {
            "album_rows_updated": album_rows_updated,
            "track_file_rows_updated": track_file_rows_updated,
        }

    def _persist_blank_album_tag_edit(
        self,
        *,
        normalized_paths: list[str],
        previous_entries: dict[str, dict[str, object]],
        updated_file_entries: dict[str, dict[str, object]],
        commit_guard: Callable[[Callable[[], object]], object] | None,
        before_commit: Callable[[Any], object] | None,
        rebuild_relation_projection: bool,
        delta_fields_by_path=None,
        identity_repairs_by_path=None,
    ) -> dict[str, object]:
        source_album_name = str(next(iter(previous_entries.values())).get("album") or "").strip()
        sibling_entries = self.load_file_entries(normalized_paths, include_siblings=True)
        inference_entries = {**sibling_entries, **updated_file_entries}
        retained_memberships = {
            path: infer_blank_album_membership(
                updated_file_entries[path],
                inference_entries.values(),
            )
            for path in normalized_paths
        }
        retain_album_membership = bool(source_album_name) and all(
            str(inferred or "").casefold() == source_album_name.casefold()
            for inferred in retained_memberships.values()
        )
        delta_fields = delta_fields_by_path or _structural_changed_fields(previous_entries, updated_file_entries)
        identity_repairs = identity_repairs_by_path or {}
        input_rows = [
            {
                "private_path": path,
                "file_entry": {
                    **_structural_file_entry_delta(
                        previous_entries[path],
                        updated_file_entries[path],
                        required_fields=delta_fields[path],
                    ),
                    **identity_repairs.get(path, {}),
                    # Album membership can be detached either by clearing TALB
                    # or by applying a non-album exception. Persist the current
                    # Album value explicitly so the scan-cache metadata remains
                    # accurate while local_tracks.album_id is null.
                    "album": str(
                        updated_file_entries[path].get("album") or ""
                    ),
                },
            }
            for path in normalized_paths
        ]
        with self._connect_to_database() as connection:
            connection.execute(_inventory_publication_advisory_lock_sql())
            connection.execute(relation_projection_advisory_lock_sql())
            _ensure_bootstrap_context(connection)
            from music_app.services.gallery_projection_postgres import gallery_projection_context
            gallery_context_before = gallery_projection_context(connection)
            result = _row_mapping(_first_row(connection.execute(
                _persist_blank_album_tag_edit_sql(),
                {
                    "changed_paths": normalized_paths,
                    "input_rows": _jsonb(input_rows),
                    "retain_album_membership": retain_album_membership,
                    "source": _SOURCE,
                },
            )))
            input_path_count = int(result.get("input_path_count") or 0)
            resolved_path_count = int(result.get("resolved_path_count") or 0)
            source_album_count = int(result.get("source_album_count") or 0)
            source_album_track_file_count = int(result.get("source_album_track_file_count") or 0)
            track_rows_updated = int(result.get("track_rows_updated") or 0)
            track_file_rows_updated = int(result.get("track_file_rows_updated") or 0)
            inventory_mutation_revision = int(result.get("inventory_mutation_revision") or 0)
            destination_album_id = int(result.get("destination_album_id") or result.get("source_album_id") or 0)
            if input_path_count != len(normalized_paths) or resolved_path_count != input_path_count:
                raise RuntimeError("Structural tag persistence must resolve every changed path.")
            if source_album_count > 1 or (
                source_album_count == 1
                and source_album_track_file_count < input_path_count
            ):
                raise RuntimeError("Structural tag persistence requires one source album.")
            if (
                track_rows_updated != int(result.get("resolved_track_count") or input_path_count)
                or track_file_rows_updated != input_path_count
                or inventory_mutation_revision < 1
            ):
                raise RuntimeError("Targeted blank Album persistence did not update the selected inventory.")
            inventory_mutation_revision = max(inventory_mutation_revision,
                _persist_additional_track_tags(connection, self._build_albums, normalized_paths,
                    previous_entries, updated_file_entries, delta_fields))
            committed_relation_state = (
                _patch_structural_relation_projection(
                    connection,
                    config=self._config,
                    expected_gallery_generation=(gallery_context_before or {}).get("generation"),
                    affected_album_ids=(int(result.get("source_album_id") or 0), destination_album_id),
                    previous_entries=previous_entries,
                    updated_entries={
                        path: updated_file_entries[path]
                        for path in normalized_paths
                    },
                    source_album_vacated=(
                        source_album_count == 1
                        and source_album_track_file_count == input_path_count
                    ),
                )
                if rebuild_relation_projection
                else None
            )
            if before_commit is not None:
                before_commit(connection)
            if commit_guard is not None:
                commit_guard(connection.commit)

        persistence_result: dict[str, object] = {
            "album_rows_updated": 0,
            "destination_album_id": destination_album_id,
            "track_rows_updated": track_rows_updated,
            "track_file_rows_updated": track_file_rows_updated,
            "inventory_mutation_revision": inventory_mutation_revision,
            "retained_album_membership": retain_album_membership,
        }
        if committed_relation_state is not None:
            persistence_result.update(committed_relation_state)
        return persistence_result

    def _persist_detached_album_restore(
        self,
        *,
        normalized_paths: list[str],
        previous_entries: dict[str, dict[str, object]],
        updated_entries: dict[str, dict[str, object]],
        commit_guard: Callable[[Callable[[], object]], object] | None,
        before_commit: Callable[[Any], object] | None,
        rebuild_relation_projection: bool,
        delta_fields_by_path=None,
        identity_repairs_by_path=None,
    ) -> dict[str, object]:
        destination_album = _structural_destination_album_projection(
            self._build_albums,
            updated_entries,
            frozenset({"album"}),
        )
        destination_album_key = str(
            getattr(destination_album, "key", "") or ""
        ).strip()
        if not destination_album_key:
            raise RuntimeError(
                "Structural tag persistence could not derive the destination album key."
            )
        (
            artist_rows,
            album_rows,
            featured_artist_rows,
            _track_rows,
            _track_file_rows,
        ) = _inventory_rows_from_albums(
            updated_entries,
            [destination_album],
        )
        delta_fields = delta_fields_by_path or _structural_changed_fields(previous_entries, updated_entries)
        identity_repairs = identity_repairs_by_path or {}
        input_rows = [
            {
                "private_path": path,
                "file_entry": {**_structural_file_entry_delta(
                    previous_entries[path],
                    updated_entries[path],
                    required_fields=delta_fields[path],
                ), **identity_repairs.get(path, {})},
            }
            for path in normalized_paths
        ]
        if len(album_rows) != 1 or len(input_rows) != len(normalized_paths):
            raise RuntimeError(
                "Detached Album restoration did not project the complete selected inventory."
            )

        committed_relation_state: dict[str, object] | None = None
        with self._connect_to_database() as connection:
            connection.execute(_inventory_publication_advisory_lock_sql())
            connection.execute(relation_projection_advisory_lock_sql())
            _ensure_bootstrap_context(connection)
            from music_app.services.gallery_projection_postgres import gallery_projection_context
            gallery_context_before = gallery_projection_context(connection)
            for row in artist_rows:
                connection.execute(_upsert_local_artist_sql(preserve_existing_identity=True), row)
            _execute_semantic_local_album_key_adoptions(connection, album_rows)
            for row in album_rows:
                connection.execute(_upsert_local_album_sql(), row)
            for row in featured_artist_rows:
                connection.execute(_upsert_local_album_featured_artist_sql(), row)
            result = _row_mapping(_first_row(connection.execute(
                _finalize_detached_album_restore_sql(),
                {
                    "changed_paths": normalized_paths,
                    "input_rows": _jsonb(input_rows),
                    "destination_album_key": destination_album_key,
                    "source": _SOURCE,
                },
            )))
            input_path_count = int(result.get("input_path_count") or 0)
            resolved_path_count = int(result.get("resolved_path_count") or 0)
            destination_album_count = int(
                result.get("destination_album_count") or 0
            )
            track_rows_updated = int(result.get("track_rows_updated") or 0)
            track_file_rows_updated = int(
                result.get("track_file_rows_updated") or 0
            )
            inventory_mutation_revision = int(
                result.get("inventory_mutation_revision") or 0
            )
            destination_album_id = int(result.get("destination_album_id") or 0)
            if (
                input_path_count != len(normalized_paths)
                or resolved_path_count != input_path_count
                or destination_album_count != 1
                or track_rows_updated != int(result.get("resolved_track_count") or input_path_count)
                or track_file_rows_updated != input_path_count
                or inventory_mutation_revision < 1
                or destination_album_id < 1
            ):
                raise RuntimeError(
                    "Detached Album restoration did not update the complete album inventory."
                )
            _execute_semantic_local_album_reconciliation(
                connection,
                target_album_ids=(destination_album_id,),
            )
            inventory_mutation_revision = max(inventory_mutation_revision,
                _persist_additional_track_tags(connection, self._build_albums, normalized_paths,
                    previous_entries, updated_entries, delta_fields))
            committed_relation_state = (
                _patch_structural_relation_projection(
                    connection,
                    config=self._config,
                    expected_gallery_generation=(gallery_context_before or {}).get("generation"),
                    affected_album_ids=(int(result.get("source_album_id") or 0), destination_album_id),
                    previous_entries=previous_entries,
                    updated_entries=updated_entries,
                    source_album_vacated=False,
                )
                if rebuild_relation_projection
                else None
            )
            if before_commit is not None:
                before_commit(connection)
            if commit_guard is not None:
                commit_guard(connection.commit)

        persistence_result: dict[str, object] = {
            "album_rows_updated": 1,
            "destination_album_id": destination_album_id,
            "track_rows_updated": track_rows_updated,
            "track_file_rows_updated": track_file_rows_updated,
            "inventory_mutation_revision": inventory_mutation_revision,
            "retained_album_membership": False,
        }
        if committed_relation_state is not None:
            persistence_result.update(committed_relation_state)
        return persistence_result

    def persist_structural_tag_edit(self, *, changed_paths, previous_file_entries,
            updated_file_entries, changed_field_names, commit_guard=None,
            before_commit=None, rebuild_relation_projection=False):
        result = self._persist_structural_tag_edit_transaction(changed_paths=changed_paths,
            previous_file_entries=previous_file_entries, updated_file_entries=updated_file_entries,
            changed_field_names=changed_field_names, commit_guard=commit_guard,
            before_commit=before_commit, rebuild_relation_projection=rebuild_relation_projection)
        try:
            from music_app.services.gallery_projection_postgres import schedule_gallery_projection_refresh
            schedule_gallery_projection_refresh(self._config, connect=self._connect, incremental_membership=True)
        except Exception:
            _LOGGER.exception("Unable to schedule scoped gallery refresh after tag edit")
        return result

    def _persist_structural_tag_edit_transaction(self, *, changed_paths, previous_file_entries,
            updated_file_entries, changed_field_names, commit_guard=None,
            before_commit=None, rebuild_relation_projection=False):
        previous_file_entries = {path: dict(previous_file_entries[path]) for path in changed_paths
                                 if isinstance(previous_file_entries.get(path), dict)}
        updated_file_entries = {path: dict(updated_file_entries[path]) for path in changed_paths
                                if isinstance(updated_file_entries.get(path), dict)}
        with self._connect_to_database() as connection:
            connection.execute(_inventory_publication_advisory_lock_sql())
            _partition_edited_physical_copies(connection, changed_paths, previous_file_entries,
                                             updated_file_entries, apply=True)
            groups, source_ids, source_keys, delta_fields, identity_repairs = _structural_tag_edit_groups(
                connection, changed_paths, previous_file_entries, updated_file_entries, changed_field_names)
            scoped = PostgresScanCacheAdapter(self._config, connect=lambda _url: nullcontext(connection),
                                             build_albums=self._build_albums)
            if len(groups) <= 1:
                return scoped._persist_structural_tag_edit_group(
                    changed_paths=changed_paths, previous_file_entries=previous_file_entries,
                    updated_file_entries=updated_file_entries, changed_field_names=changed_field_names,
                    commit_guard=commit_guard, before_commit=before_commit,
                    rebuild_relation_projection=rebuild_relation_projection, delta_fields_by_path=delta_fields,
                    identity_repairs_by_path=identity_repairs)
            from music_app.services.gallery_projection_postgres import gallery_projection_context
            connection.execute(relation_projection_advisory_lock_sql())
            baseline = gallery_projection_context(connection)
            base_revision = int(_row_mapping(_first_row(connection.execute(
                _load_inventory_mutation_revision_sql()))).get("inventory_mutation_revision") or 0)
            results = []
            inherited_destination_ids = set()
            for paths in groups:
                group_fields = set(changed_field_names) & set().union(*(delta_fields[path] for path in paths))
                result = scoped._persist_structural_tag_edit_group(
                    changed_paths=set(paths),
                    previous_file_entries={path: previous_file_entries[path] for path in paths},
                    updated_file_entries={path: updated_file_entries[path] for path in paths},
                    changed_field_names=group_fields, commit_guard=lambda _commit: None,
                    rebuild_relation_projection=False, rebind_cover_lookup_tasks=False,
                    pending_file_entries=updated_file_entries, delta_fields_by_path=delta_fields,
                    unchanged_group=not group_fields, identity_repairs_by_path=identity_repairs)
                results.append(result)
                if result.get("cover_inherited_from_structural_edit") and result.get("inserted_destination_album"):
                    inherited_destination_ids.add(int(result["destination_album_id"]))
            affected_ids = source_ids | {int(result[field]) for result in results
                for field in ("source_album_id", "destination_album_id") if result.get(field)}
            selected_paths = {str(Path(value)) for path in changed_paths
                              for value in (path, str(updated_file_entries[path].get("path") or path))}
            selected_paths.update(str(value) for path in changed_paths
                                  for value in (path, updated_file_entries[path].get("path") or path))
            retained = connection.execute("""
                with affected as (
                  select unnest(%(album_ids)s::bigint[]) as album_id
                  union select tracks.album_id from library.local_track_files files
                    join library.local_tracks tracks on tracks.id=files.track_id
                    where files.private_path=any(%(paths)s::text[])
                )
                select files.private_path, albums.id as album_id, albums.album_key
                from affected join library.local_albums albums on albums.id=affected.album_id
                join library.local_tracks tracks on tracks.album_id=albums.id
                join library.local_track_files files on files.track_id=tracks.id
                where files.scan_cache_stale is false
            """, {"album_ids": sorted(affected_ids), "paths": sorted(selected_paths)}).fetchall()
            affected_ids.update(int(row["album_id"]) for row in retained)
            destination_ids = {int(row["album_id"]) for row in retained
                               if str(Path(row["private_path"])) in selected_paths}
            inherited_members = {str(Path(row["private_path"])) for row in retained
                                 if int(row["album_id"]) in inherited_destination_ids}
            inherited_paths = {path for path in changed_paths if str(Path(path)) in inherited_members}
            if inherited_paths:
                connection.execute(_synchronize_album_cover_file_entries_sql(by_album_ids=True), {
                    "album_ids": sorted(inherited_destination_ids),
                    "active_paths": sorted(inherited_paths),
                    "cover_inherited_from_structural_edit": True,
                })
            combined = {field: sum(int(result.get(field) or 0) for result in results)
                        for field in ("album_rows_updated", "track_rows_updated", "track_file_rows_updated")}
            combined.update(
                inventory_mutation_revision=max(int(result.get("inventory_mutation_revision") or 0) for result in results),
                source_album_ids=sorted(value for value in source_ids if value > 0),
                destination_album_ids=sorted(destination_ids),
                affected_album_ids=sorted(value for value in affected_ids if value > 0),
                affected_album_keys=sorted(source_keys | {str(row["album_key"]) for row in retained}),
                affected_track_paths=sorted({str(row["private_path"]) for row in retained}),
                separate_release_keys=sorted({str(result["separate_release_key"]) for result in results if result.get("separate_release_key")}),
                cover_inherited_paths=sorted(inherited_paths),
                relation_patch_base_revision=base_revision,
            )
            if len(destination_ids) == 1:
                combined["destination_album_id"] = next(iter(destination_ids))
            if rebuild_relation_projection:
                combined.update(_patch_structural_relation_projection(connection, config=self._config,
                    previous_entries=previous_file_entries, updated_entries=updated_file_entries,
                    source_album_vacated=False, affected_album_ids=affected_ids,
                    expected_gallery_generation=(baseline or {}).get("generation")))
            if before_commit is not None:
                before_commit(connection)
            if commit_guard is not None:
                commit_guard(connection.commit)
            return combined

    def _persist_structural_tag_edit_group(
        self,
        *,
        changed_paths: set[str],
        previous_file_entries: dict[str, dict[str, object]],
        updated_file_entries: dict[str, dict[str, object]],
        changed_field_names: set[str],
        commit_guard: Callable[[Callable[[], object]], object] | None = None,
        before_commit: Callable[[Any], object] | None = None,
        rebuild_relation_projection: bool = False,
        rebind_cover_lookup_tasks: bool = True,
        pending_file_entries: dict[str, dict[str, object]] | None = None,
        delta_fields_by_path=None,
        unchanged_group: bool = False,
        identity_repairs_by_path=None,
    ) -> dict[str, object]:
        normalized_paths = sorted(
            {str(path or "").strip() for path in changed_paths if str(path or "").strip()}
        )
        if not normalized_paths:
            raise ValueError("Structural tag persistence requires at least one changed path.")
        normalized_changed_fields = frozenset(changed_field_names)
        targeted_inventory_edit = unchanged_group or (bool(normalized_changed_fields) and (
            normalized_changed_fields <= _TARGETED_INVENTORY_EDIT_FIELDS
        ))
        if (not normalized_changed_fields and not unchanged_group) or not normalized_changed_fields <= _TARGETED_TAG_EDIT_FIELDS:
            raise ValueError(
                "Targeted tag persistence requires a supported album/artist identity "
                "edit or a non-identity inventory edit."
            )

        previous_entries = {
            path: dict(previous_file_entries[path])
            for path in normalized_paths
            if isinstance(previous_file_entries.get(path), dict)
        }
        updated_entries = {
            path: dict(updated_file_entries[path])
            for path in normalized_paths
            if isinstance(updated_file_entries.get(path), dict)
        }
        if len(previous_entries) != len(normalized_paths) or len(updated_entries) != len(normalized_paths):
            raise RuntimeError("Structural tag persistence must resolve every changed path in memory.")
        delta_fields = delta_fields_by_path or _structural_changed_fields(previous_entries, updated_entries)
        identity_repairs = identity_repairs_by_path or {}

        detached_media_edit = normalized_changed_fields <= _TARGETED_MEDIA_EDIT_FIELDS and all(
            not str(entry.get("album") or "").strip() or normalize_exception_value(entry.get("exception_type"))
            for entry in (*previous_entries.values(), *updated_entries.values())
        )
        targeted_inventory_edit = targeted_inventory_edit or detached_media_edit
        if targeted_inventory_edit:
            input_rows = [
                {
                    "private_path": path,
                    "track_artist_key": _key(updated_entries[path].get("artist") or updated_entries[path].get("album_artist") or "Unknown Artist"),
                    "track_artist_name": str(updated_entries[path].get("artist") or updated_entries[path].get("album_artist") or "Unknown Artist"),
                    "file_entry": {**_structural_file_entry_delta(
                        previous_entries[path],
                        updated_entries[path],
                        required_fields=delta_fields[path],
                    ), **identity_repairs.get(path, {})},
                }
                for path in normalized_paths
            ]
            with self._connect_to_database() as connection:
                connection.execute(_inventory_publication_advisory_lock_sql())
                _ensure_bootstrap_context(connection)
                if rebuild_relation_projection:
                    connection.execute(relation_projection_advisory_lock_sql())
                    from music_app.services.gallery_projection_postgres import gallery_projection_context
                    gallery_context_before = gallery_projection_context(connection)
                result = _row_mapping(
                    _first_row(
                        connection.execute(
                            _persist_targeted_inventory_tag_edit_sql(),
                            {
                                "changed_paths": normalized_paths,
                                "input_rows": _jsonb(input_rows),
                                "updates_track_artist": detached_media_edit and bool(normalized_changed_fields & {"artist", "album_artist"}),
                                "source": _SOURCE,
                            },
                        )
                    )
                )
                input_path_count = int(result.get("input_path_count") or 0)
                resolved_path_count = int(result.get("resolved_path_count") or 0)
                track_rows_updated = int(result.get("track_rows_updated") or 0)
                track_file_rows_updated = int(
                    result.get("track_file_rows_updated") or 0
                )
                inventory_mutation_revision = int(
                    result.get("inventory_mutation_revision") or 0
                )
                if (
                    input_path_count != len(normalized_paths)
                    or resolved_path_count != input_path_count
                    or track_rows_updated != int(result.get("resolved_track_count") or input_path_count)
                    or track_file_rows_updated != input_path_count
                    or inventory_mutation_revision < 1
                ):
                    raise RuntimeError(
                        "Targeted inventory tag persistence did not update every selected file."
                    )
                _refresh_edited_album_metadata(connection, self._build_albums,
                    [str(entry.get("path") or path) for path, entry in updated_entries.items()], normalized_changed_fields)
                committed_relation_state = _patch_structural_relation_projection(
                    connection, config=self._config, previous_entries=previous_entries,
                    updated_entries=updated_entries, source_album_vacated=False,
                    expected_gallery_generation=(gallery_context_before or {}).get('generation'),
                ) if rebuild_relation_projection else {}
                if before_commit is not None:
                    before_commit(connection)
                if commit_guard is not None:
                    commit_guard(connection.commit)

            return {
                "album_rows_updated": 0,
                "track_rows_updated": track_rows_updated,
                "track_file_rows_updated": track_file_rows_updated,
                "inventory_mutation_revision": inventory_mutation_revision,
                **committed_relation_state,
            }

        previous_album_names = {
            str(entry.get("album") or "").strip()
            for entry in previous_entries.values()
        }
        destination_album_names = {
            str(entry.get("album") or "").strip()
            for entry in updated_entries.values()
        }
        exception_only_edit = bool(normalized_changed_fields & {"exception_type", "custom_collection_name"})
        updated_exception_states = {
            bool(normalize_exception_value(entry.get("exception_type")))
            for entry in updated_entries.values()
        }
        if exception_only_edit and len(updated_exception_states) != 1:
            raise RuntimeError(
                "Targeted exception persistence requires one membership state."
            )
        applies_non_album_exception = exception_only_edit and bool(
            next(iter(updated_exception_states), False)
        )
        clears_non_album_exception = exception_only_edit and not bool(
            next(iter(updated_exception_states), False)
        )
        keeps_exception_detached_album = (
            "album" in normalized_changed_fields
            and all(
                normalize_exception_value(entry.get("exception_type"))
                for entry in (updated_entries if "exception_type" in normalized_changed_fields else previous_entries).values()
            )
        )
        if (
            "album" in normalized_changed_fields
            and destination_album_names == {""}
        ) or keeps_exception_detached_album or applies_non_album_exception or (
            clears_non_album_exception and destination_album_names == {""}
        ):
            return self._persist_blank_album_tag_edit(
                normalized_paths=normalized_paths,
                previous_entries=previous_entries,
                updated_file_entries={**(pending_file_entries or {}), **updated_file_entries},
                commit_guard=commit_guard,
                before_commit=before_commit,
                rebuild_relation_projection=rebuild_relation_projection,
                delta_fields_by_path=delta_fields,
                identity_repairs_by_path=identity_repairs,
            )
        if (
            (
                "album" in normalized_changed_fields
                and previous_album_names == {""}
            )
            or clears_non_album_exception
        ) and len(destination_album_names) == 1 and bool(
            next(iter(destination_album_names), "")
        ):
            return self._persist_detached_album_restore(
                normalized_paths=normalized_paths,
                previous_entries=previous_entries,
                updated_entries=updated_entries,
                commit_guard=commit_guard,
                before_commit=before_commit,
                rebuild_relation_projection=rebuild_relation_projection,
                delta_fields_by_path=delta_fields,
                identity_repairs_by_path=identity_repairs,
            )
        if len(destination_album_names) != 1 or not next(iter(destination_album_names), ""):
            raise RuntimeError("Structural tag persistence requires one destination album.")

        updates_release_year = "year" in normalized_changed_fields
        input_rows = [
            {
                "private_path": path,
                "track_artist_key": _key(
                    updated_entries[path].get("artist")
                    or updated_entries[path].get("album_artist")
                    or "Unknown Artist"
                ),
                "track_artist_name": str(
                    updated_entries[path].get("artist")
                    or updated_entries[path].get("album_artist")
                    or "Unknown Artist"
                ).strip(),
                "file_entry": {**_structural_file_entry_delta(
                    previous_entries[path],
                    updated_entries[path],
                    required_fields=delta_fields[path],
                ), **identity_repairs.get(path, {})},
            }
            for path in normalized_paths
        ]
        with self._connect_to_database() as connection:
            connection.execute(_inventory_publication_advisory_lock_sql())
            connection.execute(relation_projection_advisory_lock_sql())
            _ensure_bootstrap_context(connection)
            from music_app.services.gallery_projection_postgres import gallery_projection_context
            gallery_context_before = gallery_projection_context(connection)
            active_separate_release_keys = _load_separate_release_keys(connection)
            destination_album = _structural_destination_album_projection(
                self._build_albums,
                updated_entries,
                normalized_changed_fields,
                active_separate_release_keys,
            )
            destination_album_key = str(
                getattr(destination_album, "key", "") or ""
            ).strip()
            if not destination_album_key:
                raise RuntimeError(
                    "Structural tag persistence could not derive the destination album key."
                )
            destination_release_year = safe_int(
                getattr(destination_album, "year", None)
            )
            destination_release_date = (
                str(
                    getattr(destination_album, "release_date", None) or ""
                ).strip()
                or (
                    str(destination_release_year)
                    if destination_release_year is not None
                    else ""
                )
            )
            destination_separate_release_key = (
                album_separate_release_key(
                    str(
                        getattr(destination_album, "album_artist", "") or ""
                    ),
                    str(getattr(destination_album, "name", "") or ""),
                    getattr(destination_album, "edition", None),
                )
                if updates_release_year
                else ""
            )
            destination_is_explicit_separate = (
                destination_separate_release_key
                in active_separate_release_keys
            )
            destination_artists, destination_albums, destination_credits, _, _ = (
                _inventory_rows_from_albums(
                    updated_entries, [destination_album], include_track_inventory=False,
                )
            )
            destination_metadata = _jsonb_compatible(destination_albums[0]["metadata"])
            result_row = _first_row(
                connection.execute(
                    _persist_structural_album_tag_edit_sql(
                        updates_release_year=updates_release_year,
                    ),
                    {
                        "changed_paths": normalized_paths,
                        "input_rows": _jsonb(input_rows),
                        "destination_album_key": destination_album_key,
                        "destination_artist_key": _key(destination_album.album_artist),
                        "destination_artist_name": destination_album.album_artist,
                        "destination_artist_metadata": _jsonb({
                            field: destination_metadata[field]
                            for field in ("album_artist", "artists", "is_compilation", "featured_artists", "edition")
                            if field != "edition" or "edition" in normalized_changed_fields
                        }),
                        "destination_album_title": str(
                            getattr(destination_album, "name", "") or "Unknown Album"
                        ),
                        "destination_release_year": destination_release_year,
                        "destination_release_date": destination_release_date,
                        "destination_edition": str(
                            getattr(destination_album, "edition", None) or ""
                        ).strip(),
                        "destination_separate_release_key": (
                            destination_separate_release_key
                        ),
                        "updates_release_year": updates_release_year,
                        "destination_is_explicit_separate": (
                            destination_is_explicit_separate
                        ),
                        "source": _SOURCE,
                    },
                )
            )
            result = _row_mapping(result_row)
            input_path_count = int(result.get("input_path_count") or 0)
            resolved_path_count = int(result.get("resolved_path_count") or 0)
            source_album_count = int(result.get("source_album_count") or 0)
            source_album_track_file_count = int(
                result.get("source_album_track_file_count") or 0
            )
            destination_conflict_count = int(
                result.get("destination_conflict_count") or 0
            )
            destination_album_count = int(result.get("destination_album_count") or 0)
            album_rows_updated = int(result.get("album_rows_updated") or 0)
            track_rows_updated = int(result.get("track_rows_updated") or 0)
            track_file_rows_updated = int(result.get("track_file_rows_updated") or 0)
            inventory_mutation_revision = int(
                result.get("inventory_mutation_revision") or 0
            )
            source_album_id = int(result.get("source_album_id") or 0)
            source_album_key = str(result.get("source_album_key") or "").strip()
            destination_album_id = int(result.get("destination_album_id") or 0)
            persisted_separate_release_key = str(
                result.get("separate_release_key") or ""
            ).strip()

            if resolved_path_count != input_path_count:
                raise RuntimeError("Structural tag persistence must resolve every changed path.")
            if source_album_count != 1:
                raise RuntimeError("Structural tag persistence requires one source album.")
            if source_album_track_file_count < input_path_count:
                raise RuntimeError(
                    "Structural tag persistence selected more files than exist in the source album."
                )
            if input_path_count != len(normalized_paths):
                raise RuntimeError("Structural tag persistence must resolve every changed path.")
            if destination_conflict_count:
                raise StructuralTagEditDestinationConflict(
                    "Structural tag persistence rejected the edit because the destination album already exists."
                )
            if (
                destination_album_count != 1
                or album_rows_updated != 1
                or track_rows_updated != int(result.get("resolved_track_count") or input_path_count)
                or track_file_rows_updated != input_path_count
                or inventory_mutation_revision < 1
                or destination_album_id < 1
            ):
                raise RuntimeError(
                    "Targeted structural tag persistence did not update the complete album inventory."
                )
            if result.get("inserted_destination_album"):
                for row in destination_artists:
                    connection.execute(_upsert_local_artist_sql(preserve_existing_identity=True), row)
                for row in destination_credits:
                    connection.execute(_upsert_local_album_featured_artist_sql(), row)
            if (
                rebind_cover_lookup_tasks and source_album_id
                and source_album_track_file_count == input_path_count
            ):
                connection.execute(
                    _rebind_cover_lookup_tasks_after_structural_edit_sql(),
                    {
                        "source_album_id": source_album_id,
                        "source_album_key": source_album_key,
                        "destination_album_id": destination_album_id,
                        "destination_album_key": destination_album_key,
                        "destination_album_title": str(
                            getattr(destination_album, "name", "")
                            or "Unknown Album"
                        ),
                        "destination_artist_name": destination_album.album_artist,
                        "destination_release_year": destination_release_year,
                    },
                )
            _execute_semantic_local_album_reconciliation(
                connection,
                target_album_ids=(destination_album_id,),
                allow_same_year_separate_release_merge=(
                    normalized_changed_fields == frozenset({"album"})
                ),
            )
            _refresh_edited_album_metadata(connection, self._build_albums,
                [str(entry.get("path") or path) for path, entry in updated_entries.items()], normalized_changed_fields)
            # Staying in the same album must preserve distinct disc/track covers.
            cover_album_ids = [destination_album_id] if destination_album_id and destination_album_id != source_album_id else []
            if cover_album_ids:
                connection.execute(
                    _synchronize_album_cover_file_entries_sql(by_album_ids=True),
                    {
                        "album_ids": cover_album_ids,
                        "active_paths": sorted(normalized_paths),
                        "cover_inherited_from_structural_edit": (
                            input_path_count < source_album_track_file_count
                        ),
                    },
                )
            committed_relation_state = (
                _patch_structural_relation_projection(
                    connection,
                    config=self._config,
                    expected_gallery_generation=(gallery_context_before or {}).get("generation"),
                    affected_album_ids=(int(result.get("source_album_id") or 0), destination_album_id),
                    previous_entries=previous_entries,
                    updated_entries=updated_entries,
                    source_album_vacated=(
                        source_album_track_file_count == input_path_count
                    ),
                )
                if rebuild_relation_projection
                else None
            )
            if before_commit is not None:
                before_commit(connection)
            if commit_guard is not None:
                commit_guard(connection.commit)

        persistence_result: dict[str, object] = {
            "album_rows_updated": album_rows_updated,
            "destination_album_id": destination_album_id,
            "inserted_destination_album": bool(result.get("inserted_destination_album")),
            "destination_album_key": destination_album_key,
            "destination_artist_name": destination_album.album_artist,
            "track_rows_updated": track_rows_updated,
            "track_file_rows_updated": track_file_rows_updated,
            "inventory_mutation_revision": inventory_mutation_revision,
            "cover_inherited_from_structural_edit": (
                input_path_count < source_album_track_file_count
            ),
        }
        if committed_relation_state is not None:
            persistence_result.update(committed_relation_state)
        if source_album_id:
            persistence_result["source_album_id"] = source_album_id
        if persisted_separate_release_key:
            persistence_result["separate_release_key"] = (
                persisted_separate_release_key
            )
        return persistence_result

    def validate_structural_tag_edit(self, *, changed_paths, previous_file_entries,
            updated_file_entries, changed_field_names):
        previous_file_entries = {path: dict(previous_file_entries[path]) for path in changed_paths
                                 if isinstance(previous_file_entries.get(path), dict)}
        updated_file_entries = {path: dict(updated_file_entries[path]) for path in changed_paths
                                if isinstance(updated_file_entries.get(path), dict)}
        from music_app.services.scoped_relation_projection import tag_edit_baseline_ready
        with self._connect_to_database() as connection:
            if not tag_edit_baseline_ready(self._config, connect=lambda _url: nullcontext(connection),
                                           track_paths=changed_paths):
                from music_app.services.gallery_projection_postgres import schedule_gallery_projection_refresh
                schedule_gallery_projection_refresh(self._config, incremental_membership=True)
                raise RuntimeError("Library changes are still being reconciled. Retry this edit when library preparation finishes.")
            connection.execute(_inventory_publication_advisory_lock_sql())
            _partition_edited_physical_copies(connection, changed_paths, previous_file_entries,
                                             updated_file_entries, apply=False)
            groups, _, _, delta_fields, _ = _structural_tag_edit_groups(connection, changed_paths,
                previous_file_entries, updated_file_entries, changed_field_names)
            scoped = PostgresScanCacheAdapter(self._config, connect=lambda _url: nullcontext(connection),
                                             build_albums=self._build_albums)
            for paths in groups:
                group_fields = (set(changed_field_names) & set().union(*(delta_fields[path] for path in paths))
                                if len(groups) > 1 else changed_field_names)
                scoped._validate_structural_tag_edit_group(changed_paths=set(paths),
                    previous_file_entries={path: previous_file_entries[path] for path in paths if path in previous_file_entries},
                    updated_file_entries={path: updated_file_entries[path] for path in paths if path in updated_file_entries},
                    changed_field_names=group_fields, unchanged_group=len(groups) > 1 and not group_fields)

    def _validate_structural_tag_edit_group(
        self,
        *,
        changed_paths: set[str],
        previous_file_entries: dict[str, dict[str, object]],
        updated_file_entries: dict[str, dict[str, object]],
        changed_field_names: set[str],
        unchanged_group: bool = False,
    ) -> None:
        normalized_paths = sorted(
            {str(path or "").strip() for path in changed_paths if str(path or "").strip()}
        )
        normalized_changed_fields = frozenset(changed_field_names)
        targeted_inventory_edit = unchanged_group or (bool(normalized_changed_fields) and (
            normalized_changed_fields <= _TARGETED_INVENTORY_EDIT_FIELDS
        ))
        if (
            not normalized_paths
            or (
                (not normalized_changed_fields and not unchanged_group) or not normalized_changed_fields <= _TARGETED_TAG_EDIT_FIELDS
            )
        ):
            raise ValueError(
                "Targeted tag prevalidation requires a supported album/artist identity "
                "edit or a non-identity inventory edit."
            )
        previous_entries = {
            path: dict(previous_file_entries[path])
            for path in normalized_paths
            if isinstance(previous_file_entries.get(path), dict)
        }
        updated_entries = {
            path: dict(updated_file_entries[path])
            for path in normalized_paths
            if isinstance(updated_file_entries.get(path), dict)
        }
        if (
            len(previous_entries) != len(normalized_paths)
            or len(updated_entries) != len(normalized_paths)
        ):
            raise RuntimeError(
                "Structural tag persistence must resolve every changed path in memory."
            )
        if targeted_inventory_edit or (
            normalized_changed_fields <= _TARGETED_MEDIA_EDIT_FIELDS and all(
                not str(entry.get("album") or "").strip() or normalize_exception_value(entry.get("exception_type"))
                for entry in (*previous_entries.values(), *updated_entries.values())
            )
        ):
            return
        destination_album_names = {
            str(entry.get("album") or "").strip()
            for entry in updated_entries.values()
        }
        previous_album_names = {
            str(entry.get("album") or "").strip()
            for entry in previous_entries.values()
        }
        exception_only_edit = bool(normalized_changed_fields & {"exception_type", "custom_collection_name"})
        updated_exception_states = {
            bool(normalize_exception_value(entry.get("exception_type")))
            for entry in updated_entries.values()
        }
        if exception_only_edit and len(updated_exception_states) != 1:
            raise RuntimeError(
                "Targeted exception persistence requires one membership state."
            )
        applies_non_album_exception = exception_only_edit and bool(
            next(iter(updated_exception_states), False)
        )
        clears_non_album_exception = exception_only_edit and not bool(
            next(iter(updated_exception_states), False)
        )
        keeps_exception_detached_album = (
            "album" in normalized_changed_fields
            and all(
                normalize_exception_value(entry.get("exception_type"))
                for entry in (updated_entries if "exception_type" in normalized_changed_fields else previous_entries).values()
            )
        )
        restores_blank_album = (
            "album" in normalized_changed_fields
            and previous_album_names == {""}
            and destination_album_names != {""}
        )
        uses_blank_album_persistence = (
            (
                "album" in normalized_changed_fields
                and destination_album_names == {""}
            )
            or restores_blank_album
            or keeps_exception_detached_album
            or applies_non_album_exception
            or (
                clears_non_album_exception
                and destination_album_names == {""}
            )
        )
        if uses_blank_album_persistence:
            with self._connect_to_database() as connection:
                connection.execute(_inventory_publication_advisory_lock_sql())
                _ensure_bootstrap_context(connection)
                result = _row_mapping(_first_row(connection.execute(
                    _validate_blank_album_tag_edit_sql(),
                    {"changed_paths": normalized_paths},
                )))
            input_path_count = int(result.get("input_path_count") or 0)
            resolved_path_count = int(result.get("resolved_path_count") or 0)
            source_album_count = int(result.get("source_album_count") or 0)
            source_album_track_file_count = int(result.get("source_album_track_file_count") or 0)
            if input_path_count != len(normalized_paths) or resolved_path_count != input_path_count:
                raise RuntimeError("Structural tag persistence must resolve every changed path.")
            if not restores_blank_album and (
                source_album_count > 1
                or (
                    source_album_count == 1
                    and source_album_track_file_count < input_path_count
                )
            ):
                raise RuntimeError("Structural tag persistence requires one source album.")
            return
        destination_album = _structural_destination_album_projection(
            self._build_albums,
            updated_entries,
            normalized_changed_fields,
        )
        destination_album_key = str(
            getattr(destination_album, "key", "") or ""
        ).strip()
        if not destination_album_key:
            raise RuntimeError(
                "Structural tag persistence could not derive the destination album key."
            )

        with self._connect_to_database() as connection:
            connection.execute(_inventory_publication_advisory_lock_sql())
            _ensure_bootstrap_context(connection)
            result = _row_mapping(
                _first_row(
                    connection.execute(
                        _validate_structural_album_tag_edit_sql(),
                        {
                            "changed_paths": normalized_paths,
                            "destination_album_key": destination_album_key,
                        },
                    )
                )
            )
        input_path_count = int(result.get("input_path_count") or 0)
        resolved_path_count = int(result.get("resolved_path_count") or 0)
        source_album_count = int(result.get("source_album_count") or 0)
        source_album_track_file_count = int(
            result.get("source_album_track_file_count") or 0
        )
        destination_conflict_count = int(
            result.get("destination_conflict_count") or 0
        )
        if input_path_count != len(normalized_paths) or resolved_path_count != input_path_count:
            raise RuntimeError(
                "Structural tag persistence must resolve every changed path."
            )
        restores_detached_album = (
            (
                "album" in normalized_changed_fields
                and previous_album_names == {""}
            )
            or clears_non_album_exception
        )
        if source_album_count != 1 and not (
            restores_detached_album and source_album_count == 0
        ):
            raise RuntimeError(
                "Structural tag persistence requires one source album."
            )
        if (
            source_album_track_file_count < input_path_count
            and not (restores_detached_album and source_album_count == 0)
        ):
            raise RuntimeError(
                "Structural tag persistence selected more files than exist in the source album."
            )
        if destination_conflict_count:
            raise StructuralTagEditDestinationConflict(
                "Structural tag persistence rejected the edit because the destination album already exists."
            )

    def save_snapshot(
        self,
        cache_path: Path,
        file_cache: dict[str, dict[str, object]],
        root_identity: object,
        last_scan: float,
        *,
        relation_views: dict[str, object] | None = None,
        relations_last_built: float | None = None,
        separate_release_keys: set[str] | None = None,
        seed_missing_album_ratings: bool = False,
        album_rating_seed_guard: Callable[[Callable[[], object]], object] | None = None,
        publication_commit_guard: Callable[[Callable[[], object]], object] | None = None,
        before_commit: Callable[[Any], object] | None = None,
        expected_cover_mutation_revision: int | None = None,
        expected_inventory_mutation_revision: int | None = None,
        rebuild_relation_projection: bool = False,
        observed_library_root_ids: set[str] | None = None,
    ) -> dict[str, object] | None:
        publication_started_at = perf_counter()
        del cache_path
        file_cache = _without_nul_file_entries(file_cache)
        committed_relation_state: dict[str, object] | None = None
        repaired_cover_entries: dict[str, dict[str, object]] = {}
        with self._connect_to_database() as connection:
            prepared_cover_mutation_revision = expected_cover_mutation_revision
            prepared_inventory_mutation_revision = expected_inventory_mutation_revision
            if (
                prepared_cover_mutation_revision is None
                or prepared_inventory_mutation_revision is None
            ):
                supports_autocommit = hasattr(connection, "autocommit")
                previous_autocommit = (
                    bool(connection.autocommit) if supports_autocommit else False
                )
                if supports_autocommit:
                    connection.autocommit = True
                try:
                    _ensure_bootstrap_context(connection)
                    if prepared_cover_mutation_revision is None:
                        prepared_cover_mutation_revision = _load_cover_mutation_revision(
                            connection
                        )
                    if prepared_inventory_mutation_revision is None:
                        prepared_inventory_mutation_revision = _load_inventory_mutation_revision(
                            connection
                        )
                finally:
                    if supports_autocommit:
                        connection.autocommit = previous_autocommit
            effective_separate_release_keys = (
                _load_separate_release_keys(connection)
                if separate_release_keys is None
                else {
                    str(key).strip()
                    for key in separate_release_keys
                    if str(key).strip()
                }
            )
            albums = self._build_albums(
                _file_cache_with_inferred_blank_album_memberships(file_cache),
                effective_separate_release_keys,
            )
            artist_rows, album_rows, featured_artist_rows, track_rows, track_file_rows = _inventory_rows_from_albums(
                file_cache,
                albums,
            )
            current_private_paths = [
                str(row["private_path"])
                for row in track_file_rows
                if str(row.get("private_path") or "")
            ]
            connection.execute(_inventory_publication_advisory_lock_sql())
            connection.execute(relation_projection_advisory_lock_sql())
            _ensure_bootstrap_context(connection)
            if _load_cover_mutation_revision(connection) != prepared_cover_mutation_revision:
                raise ScanCachePublicationSuperseded(
                    "Cover selection changed while the scan snapshot was being prepared."
                )
            if (
                _load_inventory_mutation_revision(connection)
                != prepared_inventory_mutation_revision
            ):
                raise ScanCacheInventorySuperseded(
                    "Inventory changed through a structural tag edit while the scan snapshot was being prepared."
                )
            from music_app.services.scoped_relation_projection import pending_scan_baseline, record_pending_scan_receipt
            pending_baseline = pending_scan_baseline(connection) if not rebuild_relation_projection else None
            existing_snapshot = _load_existing_scan_snapshot(connection, root_identity)
            existing_relation_views_payload = serialize_relation_views(
                existing_snapshot.get("relation_views")
            )
            relation_views_payload = existing_relation_views_payload
            resolved_relations_last_built = existing_snapshot.get(
                "relations_last_built"
            )
            snapshot_payload = {
                "source": _SOURCE,
                "library_root_identity": str(root_identity),
                "last_scan": float(last_scan or 0.0),
                "relations_last_built": _float_or_zero(resolved_relations_last_built),
                "relation_views": relation_views_payload,
                "written_at": datetime.now(timezone.utc).isoformat(),
            }
            _execute_pipeline_batches(
                connection,
                _upsert_local_artist_sql(),
                artist_rows,
            )
            _execute_semantic_local_album_key_adoptions(
                connection,
                album_rows,
            )
            _withhold_semantic_identity_conflicts(
                connection,
                album_rows=album_rows,
                featured_artist_rows=featured_artist_rows,
                track_rows=track_rows,
                track_file_rows=track_file_rows,
                separate_release_keys=set(separate_release_keys or set()),
            )
            _execute_pipeline_batches(
                connection,
                _upsert_local_album_sql(),
                album_rows,
            )
            _execute_pipeline_batches(
                connection,
                _upsert_local_album_featured_artist_sql(),
                featured_artist_rows,
            )
            connection.execute(
                _synchronize_local_album_featured_artists_sql(),
                {
                    "current_featured_rows": _jsonb(
                        [
                            {
                                "album_key": row["album_key"],
                                "artist_key": row["artist_key"],
                                "featured_kind": row["featured_kind"],
                            }
                            for row in featured_artist_rows
                        ]
                    ),
                    "synchronized_sources": _SYNCHRONIZED_FEATURED_ARTIST_SOURCES,
                },
            )
            _execute_set_based_batches(
                connection,
                _upsert_local_track_sql(),
                track_rows,
            )
            _execute_set_based_batches(
                connection,
                _upsert_local_track_file_sql(),
                track_file_rows,
            )
            repaired_album_keys = sorted({
                str(getattr(album, "key", "")) for album in albums
                if getattr(album, "cover_selection_repair_previous", None)
            })
            if repaired_album_keys:
                repaired_cover_entries = {
                    str(payload["private_path"]): _row_mapping(payload.get("file_entry"))
                    for row in connection.execute(
                        _synchronize_album_cover_file_entries_sql(),
                        {"album_keys": repaired_album_keys},
                    ).fetchall()
                    if (payload := _row_mapping(row)).get("private_path")
                }
            connection.execute(
                _mark_stale_track_files_sql(),
                {
                    "current_paths": current_private_paths,
                    "current_path_count": len(current_private_paths),
                    "source": _SOURCE,
                    "observed_root_ids": sorted(observed_library_root_ids or set()),
                    "stale_metadata": _jsonb(
                        {
                            "scan_cache": {
                                "source": _SOURCE,
                                "stale": True,
                                "stale_marked_at": datetime.now(timezone.utc).isoformat(),
                            }
                        }
                    ),
                },
            )
            connection.execute(_retire_placeholder_albums_sql(), {"album_ids": None})
            relation_source_rows = list(
                connection.execute(load_relation_source_rows_sql()).fetchall()
            )
            source_fingerprint = relation_source_fingerprint(relation_source_rows)
            if rebuild_relation_projection:
                relation_views = build_relation_views_from_postgres_rows(
                    self._config,
                    relation_source_rows,
                )
                if not relation_projection_structure_complete(relation_views):
                    raise RuntimeError(
                        "Relation projection builder returned an incomplete projection."
                    )
                relations_last_built = datetime.now(timezone.utc).timestamp()
                relation_views_payload = serialize_relation_views(relation_views)
                resolved_relations_last_built = relations_last_built
            existing_projection_metadata = existing_snapshot.get(RELATION_PROJECTION_METADATA_KEY)
            projection_metadata = (
                dict(existing_projection_metadata)
                if isinstance(existing_projection_metadata, dict)
                else {}
            )
            if rebuild_relation_projection:
                projection_metadata = build_ready_relation_projection_metadata(
                    source_fingerprint,
                    reason="queued_cache_update",
                    duration_ms=(perf_counter() - publication_started_at) * 1000,
                    source_row_count=len(relation_source_rows),
                )
                replace_artist_family_projection_in_transaction(
                    connection,
                    relation_views_payload,
                    relations_last_built=_float_or_zero(
                        resolved_relations_last_built
                    ),
                )
                replace_artist_search_projection_in_transaction(
                    connection,
                    relation_views_payload,
                    metadata=projection_metadata,
                    relations_last_built=_float_or_zero(
                        resolved_relations_last_built
                    ),
                )
                committed_relation_state = {
                    "relation_views": deserialize_relation_views(
                        relation_views_payload
                    ),
                    "relations_last_built": _float_or_zero(
                        resolved_relations_last_built
                    ),
                }
            elif (
                relation_projection_structure_complete(
                    existing_relation_views_payload
                )
                and str(projection_metadata.get("status") or "") == "ready"
                and str(projection_metadata.get("builder_version") or "")
                == RELATION_PROJECTION_BUILDER_VERSION
                and str(projection_metadata.get("built_from_fingerprint") or "")
                == source_fingerprint
            ):
                projection_metadata["source_fingerprint"] = source_fingerprint
            else:
                projection_metadata.update(
                    {
                        "status": "stale",
                        "source_fingerprint": source_fingerprint,
                        "rebuild_reason": "scan_inventory_changed",
                    }
                )
            snapshot_payload["relation_views"] = relation_views_payload
            snapshot_payload["relations_last_built"] = _float_or_zero(
                resolved_relations_last_built
            )
            snapshot_payload[RELATION_PROJECTION_METADATA_KEY] = projection_metadata
            shared_snapshot_payload = snapshot_payload
            if projection_metadata.get('status') == 'stale' and pending_baseline is not None:
                shared_snapshot_payload = {**snapshot_payload, 'relation_views': pending_baseline['legacy_views']}
            if projection_metadata.get('status') == 'ready':
                from music_app.services.scoped_relation_projection import replace_scoped_relation_projection
                legacy_views = replace_scoped_relation_projection(
                    connection, relation_source_rows, deserialize_relation_views(relation_views_payload),
                    metadata=projection_metadata, relations_last_built=resolved_relations_last_built,
                )
                shared_snapshot_payload = {**snapshot_payload, 'relation_views': legacy_views}
            connection.execute(_save_scan_snapshot_sql(), {"scan_cache": _jsonb(shared_snapshot_payload)})
            if projection_metadata.get('status') == 'ready':
                from music_app.services.gallery_projection_postgres import finish_full_relation_publication
                finish_full_relation_publication(connection, self._config, deserialize_relation_views(relation_views_payload))
            def prepare_publication_commit():
                if before_commit is not None:
                    before_commit(connection)
                record_pending_scan_receipt(connection, pending_baseline, projection_metadata)

            if seed_missing_album_ratings:
                if album_rating_seed_guard is None:
                    raise RuntimeError(
                        "Scan rating seeding requires a current-generation guard."
                    )
                def seed_and_commit_publication() -> None:
                    PostgresAlbumRatingsService(
                        self._config
                    ).seed_missing_album_ratings_in_transaction(
                        connection,
                        _tag_album_rating_candidates(albums),
                        source="file_tag_scan",
                    )
                    prepare_publication_commit()
                    connection.commit()

                album_rating_seed_guard(seed_and_commit_publication)
            elif publication_commit_guard is not None:
                prepare_publication_commit()
                publication_commit_guard(connection.commit)
            else:
                prepare_publication_commit()
        if repaired_cover_entries:
            committed_relation_state = dict(committed_relation_state or {})
            committed_relation_state["repaired_cover_entries"] = repaired_cover_entries
        return committed_relation_state

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres scan_cache persistence.")
        return self._connect(self._database_url)


def is_scan_cache_postgres_available(config: dict[str, object] | None) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


def select_scan_cache_adapter(config: dict[str, object]) -> ScanCacheAdapter:
    selection = select_runtime_persistence_adapter("scan_cache", config)
    if selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
        raise RuntimeError(
            f"scan_cache runtime persistence selected {selection.effective_backend}; "
            "Phase 6 runtime scan-cache persistence is Postgres-only."
        )
    return PostgresScanCacheAdapter(config)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres scan_cache persistence.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _without_nul_file_entries(file_cache: dict) -> dict:
    """Postgres text rejects NUL; one malformed tag must not block a whole root."""
    from music_app.services.metadata import without_nul_characters

    return {
        path: without_nul_characters(entry) if isinstance(entry, dict) else entry
        for path, entry in (file_cache or {}).items()
    }


def _jsonb(value: object) -> object:
    from music_app.services.metadata import without_nul_characters

    # Postgres jsonb rejects NUL; one malformed value must not abort a root.
    value = without_nul_characters(value)
    if Jsonb is None:
        return value
    return Jsonb(value)


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, dict):
        return row
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _first_row(cursor: object) -> object | None:
    fetchone = getattr(cursor, "fetchone", None)
    if callable(fetchone):
        return fetchone()
    fetchall = getattr(cursor, "fetchall", None)
    rows = list(fetchall()) if callable(fetchall) else []
    return rows[0] if rows else None


def _ensure_bootstrap_context(connection: Any) -> None:
    cursor = connection.execute(_bootstrap_context_ready_sql())
    if _first_row(cursor) is None:
        raise RuntimeError("Postgres scan_cache requires the bootstrap local owner/library context.")


def _execute_pipeline_batches(
    connection: Any,
    sql: str,
    rows: list[dict[str, object]],
) -> None:
    for batch_start in range(0, len(rows), _PIPELINE_BATCH_SIZE):
        batch_end = min(batch_start + _PIPELINE_BATCH_SIZE, len(rows))
        with connection.pipeline():
            for row_index in range(batch_start, batch_end):
                connection.execute(sql, rows[row_index])


def _execute_set_based_batches(
    connection: Any,
    sql: str,
    rows: list[dict[str, object]],
) -> None:
    for batch_start in range(0, len(rows), _PIPELINE_BATCH_SIZE):
        batch_end = min(batch_start + _PIPELINE_BATCH_SIZE, len(rows))
        batch = [
            _jsonb_compatible(row)
            for row in rows[batch_start:batch_end]
        ]
        connection.execute(sql, {"rows": _jsonb(batch)})


def _jsonb_compatible(value: object) -> object:
    if Jsonb is not None and isinstance(value, Jsonb):
        return _jsonb_compatible(value.obj)
    if isinstance(value, dict):
        return {
            str(key): _jsonb_compatible(nested_value)
            for key, nested_value in value.items()
        }
    if isinstance(value, list):
        return [_jsonb_compatible(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return value


_SEMANTIC_IDENTITY_CONFLICTS_SQL = """
    with bootstrap_context as (
      select library.libraries.id as library_id
      from app.bootstrap_owners
      join library.libraries
        on library.libraries.owner_account_id = app.bootstrap_owners.account_id
       and library.libraries.name = 'Local Library'
       and library.libraries.library_kind = 'local'
      where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
      limit 1
    ), incoming as (
      select *
      from jsonb_to_recordset(%(incoming_albums)s::jsonb) as incoming(
        album_key text, artist_key text, title text, release_year integer, edition text
      )
    )
    select incoming.album_key, existing.album_key as existing_album_key
    from incoming
    join bootstrap_context on true
    join library.local_artists as artists
      on artists.library_id = bootstrap_context.library_id
     and artists.artist_key = incoming.artist_key
    join library.local_albums as existing
      on existing.library_id = bootstrap_context.library_id
     and existing.artist_id = artists.id
     and lower(btrim(existing.title)) = lower(btrim(incoming.title))
     and existing.release_year is not distinct from incoming.release_year
     and lower(btrim(coalesce(existing.metadata ->> 'edition', '')))
         = lower(btrim(coalesce(incoming.edition, '')))
     and existing.semantic_identity_discriminator = ''
     and existing.album_key <> incoming.album_key
    where nullif(btrim(incoming.title), '') is not null
"""


def _withhold_semantic_identity_conflicts(
    connection: Any,
    *,
    album_rows: list[dict[str, object]],
    featured_artist_rows: list[dict[str, object]],
    track_rows: list[dict[str, object]],
    track_file_rows: list[dict[str, object]],
    separate_release_keys: set[str],
) -> list[dict[str, object]]:
    """Keep one album's identity collision from rolling back a whole publication.

    Two different album keys may resolve to the same semantic identity (artist,
    title, year, edition). The unique index then rejects the upsert and aborts
    every other album in the same root. Albums that would collide are withheld
    from this publication: their existing rows stay exactly as they are, nothing
    is merged or re-owned, and the conflicts are returned for diagnostics.
    """
    def identity(row: dict[str, object]) -> tuple[object, ...]:
        metadata = _jsonb_compatible(row.get("metadata"))
        edition = metadata.get("edition") if isinstance(metadata, dict) else None
        return (
            row.get("artist_key"),
            " ".join(str(row.get("title") or "").casefold().split()),
            safe_int(row.get("release_year")),
            str(edition or "").strip().casefold(),
        )

    def is_separate_release(row: dict[str, object]) -> bool:
        metadata = _jsonb_compatible(row.get("metadata"))
        owner = (metadata.get("album_artist") if isinstance(metadata, dict) else None) or ""
        edition = metadata.get("edition") if isinstance(metadata, dict) else None
        return album_separate_release_key(str(owner), str(row.get("title") or ""), str(edition or "")) in separate_release_keys

    candidates = [
        row for row in album_rows
        if row.get("artist_key") and str(row.get("title") or "").strip() and not is_separate_release(row)
    ]
    conflicts: dict[str, dict[str, object]] = {}
    keys_by_identity: dict[tuple[object, ...], set[str]] = {}
    for row in candidates:
        keys_by_identity.setdefault(identity(row), set()).add(str(row.get("album_key") or ""))
    for row in candidates:
        if len(keys_by_identity[identity(row)]) > 1:
            conflicts[str(row["album_key"])] = {
                "album_key": str(row["album_key"]), "title": row.get("title"),
                "release_year": row.get("release_year"),
                "conflicting_album_keys": sorted(keys_by_identity[identity(row)] - {str(row["album_key"])}),
            }
    if candidates:
        incoming = []
        for row in candidates:
            metadata = _jsonb_compatible(row.get("metadata"))
            incoming.append({
                "album_key": row.get("album_key"), "artist_key": row.get("artist_key"),
                "title": row.get("title"), "release_year": safe_int(row.get("release_year")),
                "edition": metadata.get("edition") if isinstance(metadata, dict) else None,
            })
        for raw in connection.execute(
            _SEMANTIC_IDENTITY_CONFLICTS_SQL, {"incoming_albums": _jsonb(incoming)},
        ).fetchall():
            found = _row_mapping(raw)
            album_key = str(found.get("album_key") or "")
            existing_key = str(found.get("existing_album_key") or "")
            row = next((item for item in candidates if str(item.get("album_key")) == album_key), {})
            entry = conflicts.setdefault(album_key, {
                "album_key": album_key, "title": row.get("title"),
                "release_year": row.get("release_year"), "conflicting_album_keys": [],
            })
            if existing_key and existing_key not in entry["conflicting_album_keys"]:
                entry["conflicting_album_keys"] = sorted({*entry["conflicting_album_keys"], existing_key})
    if not conflicts:
        return []
    withheld_keys = set(conflicts)
    withheld_track_keys = {
        str(row.get("track_key") or "") for row in track_rows if str(row.get("album_key") or "") in withheld_keys
    }
    withheld_paths = sorted(
        str(row.get("private_path") or "") for row in track_file_rows
        if str(row.get("track_key") or "") in withheld_track_keys
    )
    album_rows[:] = [row for row in album_rows if str(row.get("album_key") or "") not in withheld_keys]
    featured_artist_rows[:] = [
        row for row in featured_artist_rows if str(row.get("album_key") or "") not in withheld_keys
    ]
    track_rows[:] = [row for row in track_rows if str(row.get("album_key") or "") not in withheld_keys]
    track_file_rows[:] = [
        row for row in track_file_rows if str(row.get("track_key") or "") not in withheld_track_keys
    ]
    _LOGGER.warning(
        "Withheld %s album(s) whose semantic identity collides with another album key; "
        "their existing rows are unchanged: %s",
        len(conflicts),
        [
            {key: entry[key] for key in ("album_key", "title", "release_year", "conflicting_album_keys")}
            for entry in conflicts.values()
        ],
    )
    return [
        {**entry, "withheld_track_file_count": len(withheld_paths)} for entry in conflicts.values()
    ]


def _execute_semantic_local_album_key_adoptions(
    connection: Any,
    album_rows: list[dict[str, object]],
) -> None:
    incoming_albums = []
    for album_row in album_rows:
        metadata = _jsonb_compatible(album_row.get("metadata"))
        incoming_albums.append(
            {
                "artist_key": album_row.get("artist_key"),
                "album_key": album_row.get("album_key"),
                "title": album_row.get("title"),
                "release_year": album_row.get("release_year"),
                "edition": (
                    metadata.get("edition")
                    if isinstance(metadata, dict)
                    else None
                ),
            }
        )
    if not incoming_albums:
        return

    for statement in _semantic_local_album_key_adoption_sql():
        if "%(incoming_albums)s" in statement:
            connection.execute(
                statement,
                {"incoming_albums": _jsonb(incoming_albums)},
            )
            adoption_row = _first_row(
                connection.execute(
                    """
                    select exists (
                      select 1
                      from pg_temp.semantic_album_key_adoptions
                    ) as has_adoptions
                    """
                )
            )
            if not bool(_row_mapping(adoption_row).get("has_adoptions")):
                connection.execute(
                    "drop table if exists pg_temp.semantic_album_key_adoptions"
                )
                return
        else:
            connection.execute(statement)


def _semantic_local_album_key_adoption_sql() -> tuple[str, ...]:
    sql = """
        drop table if exists pg_temp.semantic_album_key_adoptions;

        create temporary table semantic_album_key_adoptions (
          album_id bigint primary key,
          library_id bigint not null,
          previous_album_key text not null,
          canonical_album_key text not null,
          unique (library_id, canonical_album_key)
        ) on commit drop;

        with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id =
               app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        incoming_albums as materialized (
          select
            incoming.artist_key,
            incoming.album_key,
            incoming.title,
            incoming.release_year,
            incoming.edition
          from jsonb_to_recordset(%(incoming_albums)s::jsonb) as incoming(
            artist_key text,
            album_key text,
            title text,
            release_year integer,
            edition text
          )
          where nullif(btrim(incoming.album_key), '') is not null
            and nullif(btrim(incoming.title), '') is not null
        )
        insert into pg_temp.semantic_album_key_adoptions (
          album_id,
          library_id,
          previous_album_key,
          canonical_album_key
        )
        select
          albums.id,
          albums.library_id,
          albums.album_key,
          incoming_albums.album_key
        from bootstrap_context
        join library.local_artists as artists
          on artists.library_id = bootstrap_context.library_id
        join incoming_albums
          on incoming_albums.artist_key = artists.artist_key
        join library.local_albums as albums
          on albums.library_id = bootstrap_context.library_id
         and albums.artist_id = artists.id
         and lower(btrim(albums.title)) =
             lower(btrim(incoming_albums.title))
         and albums.release_year is not distinct from
             incoming_albums.release_year
         and lower(
               btrim(coalesce(albums.metadata ->> 'edition', ''))
             ) = lower(btrim(coalesce(incoming_albums.edition, '')))
         and albums.semantic_identity_discriminator = ''
         and albums.album_key <> incoming_albums.album_key
        where not exists (
          select 1
          from library.local_albums as canonical_key_owner
          where canonical_key_owner.library_id = albums.library_id
            and canonical_key_owner.album_key = incoming_albums.album_key
        )
        order by albums.id
        for update of albums;

        insert into library.ignored_versions (
          library_id,
          version_key,
          created_at,
          metadata
        )
        select
          ignored.library_id,
          adoptions.canonical_album_key,
          ignored.created_at,
          ignored.metadata
        from pg_temp.semantic_album_key_adoptions as adoptions
        join library.ignored_versions as ignored
          on ignored.library_id = adoptions.library_id
         and ignored.version_key = adoptions.previous_album_key
        on conflict (library_id, version_key) do update
        set
          created_at = least(
            library.ignored_versions.created_at,
            excluded.created_at
          ),
          metadata = excluded.metadata || library.ignored_versions.metadata;

        delete from library.ignored_versions
        using pg_temp.semantic_album_key_adoptions as adoptions
        where library.ignored_versions.library_id = adoptions.library_id
          and library.ignored_versions.version_key =
              adoptions.previous_album_key;

        insert into library.manual_versions (
          library_id,
          child_key,
          parent_key,
          created_at,
          updated_at,
          metadata
        )
        select distinct on (
          mapped_version.library_id,
          mapped_version.child_key
        )
          mapped_version.library_id,
          mapped_version.child_key,
          mapped_version.parent_key,
          mapped_version.created_at,
          mapped_version.updated_at,
          mapped_version.metadata
        from (
          select
            versions.library_id,
            coalesce(
              child_adoption.canonical_album_key,
              versions.child_key
            ) as child_key,
            coalesce(
              parent_adoption.canonical_album_key,
              versions.parent_key
            ) as parent_key,
            versions.child_key as original_child_key,
            versions.created_at,
            versions.updated_at,
            versions.metadata
          from library.manual_versions as versions
          left join pg_temp.semantic_album_key_adoptions as child_adoption
            on child_adoption.library_id = versions.library_id
           and child_adoption.previous_album_key = versions.child_key
          left join pg_temp.semantic_album_key_adoptions as parent_adoption
            on parent_adoption.library_id = versions.library_id
           and parent_adoption.previous_album_key = versions.parent_key
          where child_adoption.album_id is not null
             or parent_adoption.album_id is not null
        ) as mapped_version
        where mapped_version.child_key <> mapped_version.parent_key
        order by
          mapped_version.library_id,
          mapped_version.child_key,
          (
            mapped_version.original_child_key =
            mapped_version.child_key
          ) desc,
          mapped_version.updated_at desc
        on conflict (library_id, child_key) do update
        set
          parent_key = excluded.parent_key,
          created_at = least(
            library.manual_versions.created_at,
            excluded.created_at
          ),
          updated_at = greatest(
            library.manual_versions.updated_at,
            excluded.updated_at
          ),
          metadata = excluded.metadata || library.manual_versions.metadata;

        delete from library.manual_versions
        using pg_temp.semantic_album_key_adoptions as adoptions
        where library.manual_versions.library_id = adoptions.library_id
          and (
            library.manual_versions.child_key =
              adoptions.previous_album_key
            or library.manual_versions.parent_key =
              adoptions.previous_album_key
          );

        update library.local_mbid_assertions as assertions
        set target_key = adoptions.canonical_album_key
        from pg_temp.semantic_album_key_adoptions as adoptions
        where assertions.album_id = adoptions.album_id
          and assertions.target_kind = 'album';

        update ops.cover_lookup_tasks as tasks
        set album_key = adoptions.canonical_album_key,
            metadata = jsonb_set(
              coalesce(tasks.metadata, '{}'::jsonb),
              '{source_payload}',
              coalesce(tasks.metadata -> 'source_payload', '{}'::jsonb)
                || jsonb_build_object(
                     'album_payload',
                     coalesce(
                       tasks.metadata #> '{source_payload,album_payload}',
                       '{}'::jsonb
                     ) || jsonb_build_object(
                       'id', adoptions.album_id,
                       'album_id', adoptions.album_id,
                       'key', adoptions.canonical_album_key
                     )
                   ),
              true
            )
        from pg_temp.semantic_album_key_adoptions as adoptions
        where tasks.library_id = adoptions.library_id
          and tasks.album_key = adoptions.previous_album_key;

        with updated_album_ratings as (
          update app.album_ratings as ratings
          set
            album_key = adoptions.canonical_album_key,
            updated_at = now()
          from pg_temp.semantic_album_key_adoptions as adoptions
          where ratings.library_id = adoptions.library_id
            and ratings.album_key = adoptions.previous_album_key
          returning ratings.id
        )
        update library.local_albums as albums
        set album_key = adoptions.canonical_album_key
        from pg_temp.semantic_album_key_adoptions as adoptions
        where albums.id = adoptions.album_id;

        drop table if exists pg_temp.semantic_album_key_adoptions;
    """
    return tuple(
        statement.strip()
        for statement in sql.split(";")
        if statement.strip()
    )


def _structural_changed_fields(previous, updated):
    return {path: {field for field in _TARGETED_TAG_EDIT_FIELDS
                   if field in updated[path] and entry.get(field) != updated[path].get(field)}
            for path, entry in previous.items()}


def _structural_file_entry_delta(
    previous_entry: dict[str, object],
    updated_entry: dict[str, object],
    *, required_fields=(),
) -> dict[str, object]:
    """Return request-owned changes; cover state has its own owner."""
    delta: dict[str, object] = {}
    for key in set(previous_entry) | set(updated_entry):
        if key in _AUTHORITATIVE_COVER_FIELDS:
            continue
        if key not in required_fields and previous_entry.get(key, _MISSING_STRUCTURAL_VALUE) == updated_entry.get(
            key,
            _MISSING_STRUCTURAL_VALUE,
        ):
            continue
        if key in updated_entry:
            delta[str(key)] = _jsonb_compatible(updated_entry[key])
    if 'artist' in updated_entry and ({'artist', 'album_artist', 'artists'} & delta.keys()):
        members = updated_entry.get('artists')
        if isinstance(members, (list, tuple)) and (
            previous_entry.get('artist') == updated_entry.get('artist')
            or previous_entry.get('artists') != members
        ):
            delta['artists'] = _deduped_artist_names(list(members))
        else:
            delta['artists'] = track_artist_credit_members(updated_entry.get('artist'), updated_entry.get('album_artist'))
    return delta


def _file_cache_with_inferred_blank_album_memberships(
    file_cache: dict[str, dict[str, object]],
) -> dict[str, dict[str, object]]:
    """Project inferred membership while preserving raw blank file metadata."""
    entries = [entry for entry in file_cache.values() if isinstance(entry, dict)]
    projected = dict(file_cache)
    for cache_key, entry in file_cache.items():
        if not isinstance(entry, dict) or str(entry.get("album") or "").strip():
            continue
        inferred_album = infer_blank_album_membership(entry, entries)
        if inferred_album:
            projected[cache_key] = {**entry, "album": inferred_album}
    return projected


def _load_selected_file_entries(connection, paths, *, include_siblings=False):
    from music_app.services.non_album_view_payloads import _album_container, _DISC_FOLDER_RE

    selected = sorted({value for path in paths for value in (str(path), str(Path(path)))})
    if not selected:
        return {}
    containers = []
    if include_siblings:
        for path in selected:
            container = _album_container(path)
            if container is not None:
                containers.append({"path": path, "container": str(container)})
    # Match 0088's physical-parent index; unrelated descendants never supply metadata.
    parent_sql = """regexp_replace(case when library.local_path_style(files.private_path) = 'windows'
      then replace(library.local_path_key(files.private_path), chr(92), '/')
      else library.local_path_key(files.private_path) end, '/[^/]*$', '')"""
    rows = connection.execute(f"""
        with selected_files as (
          select files.* from library.local_track_files files where files.private_path=any(%(paths)s::text[])
          union
          select files.* from (
            select distinct seed.library_root_id,
              rtrim(case when library.local_path_style(request.container)='windows'
                then replace(library.local_path_key(request.container),chr(92),'/')
                else library.local_path_key(request.container) end, '/') as parent
            from jsonb_to_recordset(%(containers)s::jsonb) as request(path text,container text)
            join library.local_track_files seed on seed.private_path=request.path
          ) bounds join library.local_track_files files on files.library_root_id=bounds.library_root_id
            and files.scan_cache_stale is false
            and ({parent_sql}=bounds.parent or (
              {parent_sql}>=bounds.parent || '/' and {parent_sql}<bounds.parent || '0'
              and substring({parent_sql} from length(bounds.parent)+2) !~ '/'
              and substring({parent_sql} from length(bounds.parent)+2) ~* %(disc_pattern)s))
        )
        select files.private_path, files.metadata #> '{{scan_cache,file_entry}}' as file_entry
        from selected_files files
        join library.local_tracks tracks on tracks.id=files.track_id
        join library.libraries libraries on libraries.id=tracks.library_id
        join app.bootstrap_owners owners on owners.account_id=libraries.owner_account_id
        join library.library_roots roots on roots.id=files.library_root_id
          and roots.library_id=tracks.library_id and roots.is_active
        where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
          and libraries.library_kind='local' and files.scan_cache_stale is false
          and files.metadata #>> '{{scan_cache,source}}'=%(source)s
    """, {"paths": selected, "containers": _jsonb(containers), "disc_pattern": _DISC_FOLDER_RE.pattern,
          "source": _SOURCE}).fetchall()
    entries = {}
    for row in rows:
        payload = _row_mapping(row)
        entry = payload.get("file_entry")
        if isinstance(entry, dict):
            path = str(payload["private_path"])
            try:
                hydrated = deserialize_file_entry(entry)
            except Exception:
                hydrated = dict(entry)
            entries[path] = {**hydrated, "path": path}
    return entries


def _partition_edited_physical_copies(connection, paths, previous, updated, *, apply):
    """Split file ownership before editing only part of a shared logical track."""
    if any(path not in previous or path not in updated for path in paths):
        return  # The existing structural validation owns incomplete requests.
    selected = {str(Path(path)) for path in paths}
    changed = {str(Path(path)) for path, fields in _structural_changed_fields(previous, updated).items() if fields}
    if not changed:
        return
    rows = connection.execute("""select tracks.id as track_id,tracks.library_id,tracks.track_key,
        files.private_path from library.local_tracks tracks
        join library.local_track_files files on files.track_id=tracks.id
        join library.libraries libraries on libraries.id=tracks.library_id
        join app.bootstrap_owners owners on owners.account_id=libraries.owner_account_id
        where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
          and libraries.library_kind='local' and tracks.id in (
            select selected.track_id from library.local_track_files selected
            where selected.private_path=any(%s::text[]))
        order by tracks.id,files.id""" + (' for update of tracks,files' if apply else ''),
        (sorted({variant for path in paths for variant in (path, str(Path(path)))}),)).fetchall()
    tracks = {}
    for row in rows:
        track = tracks.setdefault(row['track_id'], {**row, 'paths': []})
        track['paths'].append(row['private_path'])
    for track_id, track in tracks.items():
        edited = [path for path in track['paths'] if str(Path(path)) in selected]
        retained = [path for path in track['paths'] if str(Path(path)) not in selected]
        if not edited or not retained or not any(str(Path(path)) in changed for path in edited):
            continue
        # Keep the original identity with its canonical physical path. Historic
        # non-path identities stay with the untouched partition; both resulting
        # keys use the scanner's existing private-path identity contract.
        keep, clone = (edited, retained) if str(Path(track['track_key'])) in selected else (retained, edited)
        keep_key = next((path for path in keep if str(Path(path)) == str(Path(track['track_key']))), min(keep))
        clone_key = min(clone)
        collision = _first_row(connection.execute("""select id from library.local_tracks
            where library_id=%s and track_key=any(%s::text[]) and id<>%s limit 1""",
            (track['library_id'], [keep_key, clone_key], track_id)))
        if collision is not None:
            raise StructuralTagEditDestinationConflict(
                'A physical copy has a conflicting stored track identity. Reconcile that copy before editing its tags.')
        if not apply:
            continue
        connection.execute('update library.local_tracks set track_key=%s where id=%s', (keep_key, track_id))
        cloned = _first_row(connection.execute("""insert into library.local_tracks
            (library_id,album_id,artist_id,track_key,title,disc_number,track_number,duration_seconds,
             mbid,mbid_assertion_state,mbid_assertion_migration_run_id,mbid_assertion_scan_run_ref,
             evidence_source,evidence_confidence,first_seen_at,last_seen_at,metadata)
            select library_id,album_id,artist_id,%s,title,disc_number,track_number,duration_seconds,
             mbid,mbid_assertion_state,mbid_assertion_migration_run_id,mbid_assertion_scan_run_ref,
             evidence_source,evidence_confidence,first_seen_at,last_seen_at,metadata
            from library.local_tracks where id=%s returning id""", (clone_key, track_id)))
        if not cloned:
            raise RuntimeError('The shared track changed before its physical copies could be separated.')
        new_track_id = cloned['id']
        rebound = connection.execute("""update library.local_track_files set track_id=%s
            where track_id=%s and private_path=any(%s::text[])""", (new_track_id, track_id, clone))
        if rebound.rowcount != len(clone):
            raise RuntimeError('Physical copy ownership changed during tag reconciliation.')
        # These user-owned records are keyed by the physical path. Preserve
        # keys/payloads/provenance exactly; do not duplicate user actions.
        for table in ('library.exception_overrides', 'app.track_preferences',
                      'integration.listen_history', 'integration.pending_scrobbles',
                      'integration.lastfm_loved_tracks'):
            connection.execute(f"""update {table} set track_id=%s where library_id=%s
                and track_key=any(%s::text[]) and (track_id=%s or track_id is null)""",
                (new_track_id, track['library_id'], clone, track_id))
        connection.execute("""update library.local_mbid_assertions set track_id=%s
            where library_id=%s and target_kind='track' and target_key=any(%s::text[])
              and (track_id=%s or track_id is null)""",
            (new_track_id, track['library_id'], clone, track_id))
        # Match the saved-loop writer's order: membership revision, then loops.
        connection.execute("""select account_id from app.saved_loop_orders
            where library_id=%s and track_id=%s order by account_id for update""",
            (track['library_id'], track_id)).fetchall()
        moved_loops = connection.execute("""with recursive proven_loops as (
            select id,account_id,library_id,loop_private_path from app.saved_loops
            where library_id=%s and source_private_path=any(%s::text[])
              and (track_id=%s or track_id is null)
            union
            select child.id,child.account_id,child.library_id,child.loop_private_path
            from app.saved_loops child join proven_loops parent on child.parent_loop_id=parent.id
              and child.account_id is not distinct from parent.account_id
              and child.library_id=parent.library_id
            where (child.track_id=%s or child.track_id is null)
              and (nullif(child.source_private_path,'') is null
                   or child.source_private_path=parent.loop_private_path)
        ) update app.saved_loops saved set track_id=%s from proven_loops proven
          where saved.id=proven.id returning saved.account_id""",
            (track['library_id'], clone, track_id, track_id, new_track_id)).fetchall()
        # Ordering revisions describe membership, not user actions. Invalidate
        # stale reorder requests on both partitions without changing loop data.
        for account_id in sorted({row['account_id'] for row in moved_loops if row['account_id'] is not None}):
            connection.execute("""update app.saved_loop_orders set revision=revision+1
                where account_id=%s and library_id=%s and track_id=%s""",
                (account_id, track['library_id'], track_id))
            connection.execute("""insert into app.saved_loop_orders(account_id,library_id,track_id,revision)
                values(%s,%s,%s,1) on conflict(account_id,library_id,track_id)
                do update set revision=app.saved_loop_orders.revision+1""",
                (account_id, track['library_id'], new_track_id))


def _structural_tag_edit_groups(connection, paths, previous, updated, fields):
    if not fields or not set(fields) <= _TARGETED_TAG_EDIT_FIELDS:
        raise ValueError("Targeted tag persistence requires supported edit fields.")
    paths = sorted(paths)
    if not paths or any(path not in previous or path not in updated for path in paths):
        return [paths], set(), set(), {}, {}
    rows = connection.execute("""
        select files.private_path, tracks.id as track_id, tracks.album_id,
          tracks.metadata as track_metadata,
          albums.album_key, owner.name as album_owner
        from library.local_track_files files
        join library.local_tracks tracks on tracks.id=files.track_id
        join library.libraries libraries on libraries.id=tracks.library_id
        join app.bootstrap_owners owners on owners.account_id=libraries.owner_account_id
        left join library.local_albums albums on albums.id=tracks.album_id
        left join library.local_artists owner on owner.id=albums.artist_id
        where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
          and libraries.library_kind='local' and files.private_path=any(%s::text[])
    """, (sorted({value for path in paths for value in (path, str(Path(path)))}),)).fetchall()
    by_path = {str(Path(row["private_path"])): row for row in rows}
    delta_fields = _structural_changed_fields(previous, updated)
    track_fields = {}
    for path in paths:
        row = by_path.get(str(Path(path)))
        if row is not None:
            track_fields.setdefault(row['track_id'], set()).update(delta_fields[path])
    inventory_only = fields <= _TARGETED_INVENTORY_EDIT_FIELDS or (
        fields <= _TARGETED_MEDIA_EDIT_FIELDS and all(
            not str(entry.get("album") or "").strip() or normalize_exception_value(entry.get("exception_type"))
            for entry in (*previous.values(), *updated.values())
        )
    )
    def destination_identity(path):
        new = updated[path]
        persisted = by_path.get(str(Path(path)), {})
        if inventory_only:
            return (persisted.get("album_id"),)
        owner = new.get("album_artist") or persisted.get("album_owner") or new.get("artist")
        return (persisted.get("album_id"), _key(new.get("album")), _key(owner),
                str(new.get("year") or "") if "year" in fields else None,
                _key(new.get("edition")), normalize_exception_value(new.get("exception_type")))
    desired_by_track = {}
    identity_repairs = {}
    for path in paths:
        row = by_path.get(str(Path(path)))
        if row is None:
            continue
        track_id = row["track_id"]
        delta_fields[path] = track_fields[track_id]
        desired = (destination_identity(path),
                   tuple(str(updated[path].get(field) or "") for field in sorted(delta_fields[path])))
        identity_metadata = _structural_file_entry_delta(
            previous[path], updated[path], required_fields={'artist', 'artists', 'album_artist', 'album'})
        if delta_fields[path]:
            stored_metadata = row.get('track_metadata') or {}
            identity_repairs[path] = {
                key: identity_metadata[key] for key in ('artist', 'artists', 'album_artist', 'album')
                if key in identity_metadata and key in stored_metadata
                and stored_metadata[key] != identity_metadata[key]
            }
        desired += (tuple((field, repr(identity_metadata[field])) for field in
                          ('artist', 'artists', 'album_artist', 'album') if field in identity_metadata),)
        if delta_fields[path] & {"artist", "album_artist"}:
            desired += (_key(updated[path].get("artist") or updated[path].get("album_artist") or "Unknown Artist"),)
        if track_id in desired_by_track and desired_by_track[track_id] != desired:
            raise StructuralTagEditDestinationConflict("Selected physical copies share one track but request different tags. Give those copies matching tags before saving together.")
        desired_by_track[track_id] = desired
    source_ids = {int(row.get("album_id") or 0) for row in rows}
    source_keys = {str(row["album_key"]) for row in rows if row.get("album_key")}
    if inventory_only:
        return [paths], source_ids, source_keys, delta_fields, identity_repairs
    groups = {}
    for path in paths:
        groups.setdefault(destination_identity(path), []).append(path)
    return list(groups.values()), source_ids, source_keys, delta_fields, identity_repairs


def _persist_additional_track_tags(connection, build_albums, paths, previous, updated, delta_fields):
    changed = {field for path in paths for field in _TARGETED_MEDIA_EDIT_FIELDS - {"album"}
               if previous[path].get(field) != updated[path].get(field)}
    if not changed:
        return 0
    rows = [{"private_path": path,
             "track_artist_key": _key(updated[path].get("artist") or updated[path].get("album_artist") or "Unknown Artist"),
             "track_artist_name": str(updated[path].get("artist") or updated[path].get("album_artist") or "Unknown Artist"),
             "file_entry": _structural_file_entry_delta(previous[path], updated[path], required_fields=delta_fields[path])}
            for path in paths]
    result = _row_mapping(_first_row(connection.execute(_persist_targeted_inventory_tag_edit_sql(), {
        "changed_paths": paths, "input_rows": _jsonb(rows), "source": _SOURCE,
        "updates_track_artist": bool(changed & {"artist", "album_artist"}),
    })))
    if (any(int(result.get(field) or 0) != len(paths) for field in (
        "resolved_path_count", "track_file_rows_updated",
    )) or int(result.get("track_rows_updated") or 0) != int(result.get("resolved_track_count") or len(paths))):
        raise RuntimeError("Combined tag persistence did not update every selected track.")
    _refresh_edited_album_metadata(connection, build_albums, paths, changed)
    return int(result.get("inventory_mutation_revision") or 0)


def _refresh_edited_album_metadata(connection, build_albums, paths, changed_fields):
    fields = set()
    if "album_type" in changed_fields:
        fields.add("release_type")
    if "album_rating" in changed_fields:
        fields.update(("tag_album_rating", "tag_album_rating_source"))
    if not fields:
        return
    keys = [row["album_key"] for row in connection.execute("""
        select distinct albums.album_key
        from library.local_track_files files
        join library.local_tracks tracks on tracks.id = files.track_id
        join library.local_albums albums on albums.id = tracks.album_id
        where files.private_path = any(%s::text[])
    """, (sorted({value for path in paths for value in (path, str(Path(path)))}),)).fetchall()]
    if not keys:
        return
    grouped = {}
    for raw in connection.execute(_load_file_entries_sql(targeted_albums=True), {
        "source": _SOURCE, "album_keys": keys,
    }).fetchall():
        row = _row_mapping(raw)
        entry = _targeted_surviving_file_entry(row)
        if entry is not None:
            grouped.setdefault(row["album_key"], {})[row["private_path"]] = entry
    if set(keys) != set(grouped):
        raise RuntimeError("Edited album metadata requires active retained tracks.")
    for key, entries in grouped.items():
        albums = build_albums(entries, set())
        if not albums:
            raise RuntimeError("Edited album metadata could not be projected from its retained tracks.")
        _, rows, _, _, _ = _inventory_rows_from_albums(entries, albums, include_track_inventory=False)
        metadata = _jsonb_compatible(rows[0]["metadata"])
        connection.execute("""
            update library.local_albums set metadata = coalesce(metadata, '{}'::jsonb) || %s::jsonb
            where album_key = %s and library_id = (
                select libraries.id from library.libraries libraries
                join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
                where owners.owner_key = 'local-bootstrap-owner'
                  and libraries.name = 'Local Library' and libraries.library_kind = 'local'
            )
        """, (_jsonb({field: metadata.get(field) for field in fields}), key))


def _structural_destination_album_projection(
    build_albums: Callable[
        [dict[str, dict[str, object]], set[str] | None],
        list[object],
    ],
    updated_entries: dict[str, dict[str, object]],
    changed_field_names: frozenset[str],
    separate_release_keys: set[str] | None = None,
) -> object:
    active_separate_release_keys = {
        str(key).strip()
        for key in (separate_release_keys or set())
        if str(key).strip()
    }
    projection_entries = {
        path: {
            key: value
            for key, value in entry.items()
            if key != "exception_type"
        }
        for path, entry in updated_entries.items()
    }
    identity_fields = changed_field_names & {"artist", "album_artist", "album", "year", "edition"}
    if identity_fields == {"artist"}:
        for entry in projection_entries.values():
            entry["artist"] = entry.get("album_artist") or entry.get("artist")
    destination_albums = build_albums(
        projection_entries,
        (
            set()
            if "year" in changed_field_names
            else active_separate_release_keys
        ),
    )
    if len(destination_albums) != 1:
        raise RuntimeError(
            "Structural tag persistence requires one destination album projection."
        )
    destination_album = destination_albums[0]
    if "year" in changed_field_names:
        base_destination_key = str(
            getattr(destination_album, "key", "") or ""
        ).strip()
        if not base_destination_key:
            raise RuntimeError(
                "Structural tag persistence could not derive the destination album key."
            )
        destination_albums = build_albums(
            projection_entries,
            active_separate_release_keys | {base_destination_key},
        )
        if len(destination_albums) != 1:
            raise RuntimeError(
                "Structural tag persistence requires one destination album projection."
            )
        destination_album = destination_albums[0]
    return destination_album


def _structural_entry_artist_names(
    entries: dict[str, dict[str, object]],
) -> set[str]:
    return {
        artist_name
        for entry in entries.values()
        for artist_name in (
            str(entry.get("album_artist") or "").strip(),
            str(entry.get("artist") or "").strip(),
        )
        if artist_name
    }


def _orphaned_structural_source_artists(
    connection: Any,
    artist_names: set[str],
) -> list[str]:
    normalized_names = sorted(
        {
            str(name or "").strip()
            for name in artist_names
            if str(name or "").strip()
        }
    )
    if not normalized_names:
        return []
    rows = connection.execute(
        """
        with source_artist_names as (
          select unnest(%(artist_names)s::text[]) as artist_name
        )
        select source.artist_name
        from source_artist_names source
        where not exists (
          select 1
          from library.local_artists artist
          where lower(btrim(artist.name)) = lower(btrim(source.artist_name))
            and (
              exists (
                select 1 from library.local_albums album
                where album.artist_id = artist.id
              )
              or exists (
                select 1 from library.local_tracks track
                where track.artist_id = artist.id
              )
              or exists (
                select 1 from library.local_album_featured_artists featured
                where featured.artist_id = artist.id
              )
            )
        )
        order by lower(source.artist_name), source.artist_name
        """,
        {"artist_names": normalized_names},
    ).fetchall()
    orphaned = []
    for row in rows:
        row_mapping = _row_mapping(row)
        artist_name = str(row_mapping.get("artist_name") or row[0]).strip()
        if artist_name:
            orphaned.append(artist_name)
    return orphaned


def _patch_structural_relation_projection(
    connection: Any,
    *,
    previous_entries: dict[str, dict[str, object]],
    updated_entries: dict[str, dict[str, object]],
    source_album_vacated: bool,
    reason: str = "structural_tag_edit",
    config: dict[str, object] | None = None,
    expected_gallery_generation: int | None = None,
    affected_album_ids=(),
) -> dict[str, object]:
    from music_app.services.scoped_relation_projection import publish_affected_relation_projection

    del source_album_vacated
    album_ids = {
        int(entry["album_id"])
        for entry in (*previous_entries.values(), *updated_entries.values())
        if entry.get("album_id")
    }
    return publish_affected_relation_projection(
        connection, album_ids=album_ids | {int(value) for value in affected_album_ids if value is not None},
        track_paths=set(previous_entries) | set(updated_entries), reason=reason, config=config,
        expected_gallery_generation=expected_gallery_generation,
    )


def _commit_structural_relation_projection(
    connection: Any,
    config: dict[str, object],
    *,
    reason: str = "structural_tag_edit",
) -> dict[str, object]:
    snapshot_row = _first_row(connection.execute(_load_scan_snapshot_sql()))
    loaded_snapshot = (
        _row_mapping(snapshot_row).get("scan_cache")
        if snapshot_row is not None
        else None
    )
    next_scan_cache = dict(loaded_snapshot) if isinstance(loaded_snapshot, dict) else {}
    relation_source_rows = list(connection.execute(load_relation_source_rows_sql()).fetchall())
    source_fingerprint = relation_source_fingerprint(relation_source_rows)
    projection_metadata = next_scan_cache.get(RELATION_PROJECTION_METADATA_KEY)
    # Inventory publication marks relations stale before this transaction checks
    # whether any relation inputs actually changed. Validate a ready candidate
    # against the freshly loaded source before restoring that status.
    was_stale = (
        isinstance(projection_metadata, dict)
        and projection_metadata.get("status") == "stale"
    )
    if was_stale:
        next_scan_cache[RELATION_PROJECTION_METADATA_KEY] = {
            **projection_metadata,
            "status": "ready",
        }
    current_projection = _relation_projection_scan_cache_from_row(
        _first_row(connection.execute(_load_relation_projection_sql())))
    proven_current = current_projection.get('normalized_relation_ready') is True
    if proven_current:
        next_scan_cache['relation_views'] = current_projection['relation_views']
    if (
        proven_current
        and not relation_projection_stale_reason(next_scan_cache)
        and next_scan_cache[RELATION_PROJECTION_METADATA_KEY]["built_from_fingerprint"]
        == source_fingerprint
    ):
        from music_app.services.scoped_relation_projection import replace_scoped_relation_projection
        legacy_views = replace_scoped_relation_projection(
            connection, relation_source_rows, deserialize_relation_views(next_scan_cache['relation_views']),
            metadata=next_scan_cache[RELATION_PROJECTION_METADATA_KEY],
            relations_last_built=_float_or_zero(next_scan_cache.get('relations_last_built')),
        )
        if was_stale or next_scan_cache['relation_views'] != legacy_views:
            connection.execute(_save_scan_snapshot_sql(), {"scan_cache": _jsonb({**next_scan_cache, 'relation_views': legacy_views})})
        from music_app.services.gallery_projection_postgres import finish_full_relation_publication
        finish_full_relation_publication(connection, config, deserialize_relation_views(next_scan_cache['relation_views']))
        persisted_projection = _relation_projection_scan_cache_from_row(
            _first_row(connection.execute(_load_relation_projection_sql()))
        )
        if artist_search_projection_stale_reason(persisted_projection):
            replace_artist_search_projection_in_transaction(
                connection,
                next_scan_cache["relation_views"],
                metadata=next_scan_cache[RELATION_PROJECTION_METADATA_KEY],
                relations_last_built=_float_or_zero(next_scan_cache.get("relations_last_built")),
            )
        return {
            "relation_views": deserialize_relation_views(next_scan_cache["relation_views"]),
            "relations_last_built": _float_or_zero(next_scan_cache.get("relations_last_built")),
        }
    relation_views = build_relation_views_from_postgres_rows(config, relation_source_rows)
    if not relation_projection_structure_complete(relation_views):
        raise RuntimeError("Relation projection builder returned an incomplete projection.")
    relations_last_built = datetime.now(timezone.utc).timestamp()
    relation_views_payload = serialize_relation_views(relation_views)
    projection_metadata = build_ready_relation_projection_metadata(
        source_fingerprint,
        reason=reason,
        duration_ms=0.0,
        source_row_count=len(relation_source_rows),
    )
    replace_artist_family_projection_in_transaction(
        connection,
        relation_views_payload,
        relations_last_built=relations_last_built,
    )
    replace_artist_search_projection_in_transaction(
        connection,
        relation_views_payload,
        metadata=projection_metadata,
        relations_last_built=relations_last_built,
    )
    next_scan_cache["relation_views"] = relation_views_payload
    next_scan_cache["relations_last_built"] = relations_last_built
    next_scan_cache[RELATION_PROJECTION_METADATA_KEY] = projection_metadata
    from music_app.services.scoped_relation_projection import replace_scoped_relation_projection
    legacy_views = replace_scoped_relation_projection(
        connection, relation_source_rows, relation_views, metadata=projection_metadata,
        relations_last_built=relations_last_built)
    connection.execute(_save_scan_snapshot_sql(), {"scan_cache": _jsonb({**next_scan_cache, 'relation_views': legacy_views})})
    from music_app.services.gallery_projection_postgres import finish_full_relation_publication
    finish_full_relation_publication(connection, config, relation_views)
    return {
        "relation_views": deserialize_relation_views(relation_views_payload),
        "relations_last_built": relations_last_built,
    }


def _load_existing_scan_snapshot(connection: Any, root_identity: object) -> dict[str, object]:
    snapshot_row = _first_row(connection.execute(_load_scan_snapshot_sql()))
    snapshot_payload = _row_mapping(snapshot_row).get("scan_cache") if snapshot_row is not None else None
    if not isinstance(snapshot_payload, dict):
        return {}
    if str(snapshot_payload.get("library_root_identity") or "") != str(root_identity):
        return {}
    return snapshot_payload


def _load_cover_mutation_revision(connection: Any) -> int:
    row = _first_row(connection.execute(_load_cover_mutation_revision_sql()))
    value = _row_mapping(row).get("cover_mutation_revision") if row is not None else 0
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _load_inventory_mutation_revision(connection: Any) -> int:
    row = _first_row(connection.execute(_load_inventory_mutation_revision_sql()))
    value = (
        _row_mapping(row).get("inventory_mutation_revision")
        if row is not None
        else 0
    )
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _float_or_zero(value: object) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _text_or_none(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def _key(value: object) -> str:
    return local_inventory_identity_key(value)


def _valid_tag_album_rating(value: object) -> int | None:
    return value if type(value) is int and 1 <= value <= 10 else None


def _tag_album_rating_candidates(albums: list[object]) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    for album in albums:
        album_key = str(getattr(album, "key", "") or "").strip()
        rating = _valid_tag_album_rating(getattr(album, "album_rating", None))
        if album_key and rating is not None:
            candidates.append(
                {"album_key": album_key, "tag_album_rating": rating}
            )
    return candidates


def _raw_tag_album_rating_from_file_entries(
    album: object,
    file_entries_by_path: dict[str, dict[str, object]],
) -> object:
    matched_file_entry = False
    for track in getattr(album, "tracks", []) or []:
        track_path = str(getattr(track, "path", "") or "").strip()
        file_entry = file_entries_by_path.get(track_path)
        if not isinstance(file_entry, dict):
            continue
        matched_file_entry = True
        raw_rating = file_entry.get("album_rating")
        if raw_rating is not None:
            return raw_rating
    if matched_file_entry:
        return None
    return _valid_tag_album_rating(getattr(album, "album_rating", None))


def _album_cover_authority_metadata(album: object) -> dict[str, object]:
    metadata = {
        field: value
        for field in _ALBUM_COVER_AUTHORITY_FIELDS
        if (value := getattr(album, field, None)) is not None
    }
    if previous := getattr(album, "cover_selection_repair_previous", None):
        metadata["cover_selection_repair_previous"] = previous
    return metadata


def _targeted_preferred_paths(
    *,
    incoming_entries: dict[str, dict[str, object]],
    context_entries: dict[str, dict[str, object]],
    existing_memberships: list[dict[str, object]],
) -> set[str]:
    def structural_identity(entry: dict[str, object]) -> tuple[str, int | None]:
        return (
            album_separate_release_key(
                entry.get("album_artist") or entry.get("artist"),
                entry.get("album"),
                entry.get("edition"),
            ),
            safe_int(entry.get("year")),
        )

    existing_paths = {
        str(row.get("private_path") or "")
        for row in existing_memberships
        if row.get("private_path")
    }
    identities_by_release: dict[str, set[tuple[str, int | None]]] = {}
    for path in existing_paths:
        context_entry = context_entries.get(path)
        if context_entry is not None:
            identity = structural_identity(context_entry)
            identities_by_release.setdefault(identity[0], set()).add(identity)

    preferred_paths: set[str] = set()
    for path, incoming_entry in incoming_entries.items():
        context_entry = context_entries.get(path)
        context_identity = (
            structural_identity(context_entry)
            if context_entry is not None
            else None
        )
        if (
            path in existing_paths
            and context_identity is not None
            and len(identities_by_release.get(context_identity[0], set())) == 1
            and structural_identity(incoming_entry) != context_identity
        ):
            preferred_paths.add(path)
    return preferred_paths


def _follow_existing_year_split_album_keys(
    connection: Any,
    *,
    album_rows: list[dict[str, object]],
    featured_artist_rows: list[dict[str, object]],
    track_rows: list[dict[str, object]],
) -> None:
    """Use the year-qualified key a full scan already created for this album.

    A full scan splits one artist/title across years into ``<key>::year::<Y>``.
    A watcher batch that only sees one year builds the bare ``<key>``; when the
    bare row belongs to another year, upserting it would rewrite that album's
    year onto the identity the year-qualified row already holds.
    """
    candidates = {
        str(row.get("album_key") or ""): f"{row.get('album_key')}::year::{safe_int(row.get('release_year'))}"
        for row in album_rows
        if "::year::" not in str(row.get("album_key") or "")
        and safe_int(row.get("release_year")) is not None
    }
    if not candidates:
        return
    existing = {
        str(_row_mapping(row).get("album_key"))
        for row in connection.execute(
            "select album_key from library.local_albums where album_key = any(%(keys)s::text[])",
            {"keys": sorted(candidates.values())},
        ).fetchall()
    }
    remaps = {bare: qualified for bare, qualified in candidates.items() if qualified in existing}
    if not remaps:
        return
    for rows in (album_rows, featured_artist_rows, track_rows):
        for row in rows:
            key = str(row.get("album_key") or "")
            if key in remaps:
                row["album_key"] = remaps[key]


def _remap_targeted_album_identity_rows(
    *,
    album_rows: list[dict[str, object]],
    featured_artist_rows: list[dict[str, object]],
    track_rows: list[dict[str, object]],
    existing_memberships: list[dict[str, object]],
    separate_release_keys: set[str],
    preferred_paths: set[str] | None = None,
    excluded_paths: set[str] | None = None,
) -> None:
    """Keep established album keys when watcher context still names that album."""
    automatic_year_groups: dict[str, list[dict[str, object]]] = {}
    for album_row in album_rows:
        artist_key = str(album_row.get("artist_key") or "").strip()
        title = str(album_row.get("title") or "").strip()
        metadata = _jsonb_compatible(album_row.get("metadata") or {})
        edition = str(metadata.get("edition") or "").strip()
        release_key = album_separate_release_key(artist_key, title, edition)
        album_key = str(album_row.get("album_key") or "").strip()
        if album_key.startswith(f"{release_key}::year::"):
            automatic_year_groups.setdefault(release_key, []).append(album_row)

    existing_authorities: dict[
        str, set[tuple[str, str, int | None, str | None]]
    ] = {}
    for membership in existing_memberships:
        release_date = str(membership.get("release_date") or "").strip()
        album_key = str(membership.get("album_key") or "").strip()
        if not album_key:
            continue
        release_key = album_separate_release_key(
            str(membership.get("artist_key") or "").strip(),
            str(membership.get("album_title") or "").strip(),
            str(membership.get("edition") or "").strip(),
        )
        existing_authorities.setdefault(release_key, set()).add(
            (
                str(membership.get("private_path") or ""),
                album_key,
                safe_int(membership.get("release_year")),
                release_date or None,
            )
        )

    generated_key_by_path = {
        str(track_row.get("track_key") or ""): str(
            track_row.get("album_key") or ""
        ).strip()
        for track_row in track_rows
        if track_row.get("track_key")
    }
    existing_key_by_path = {
        str(membership.get("private_path") or ""): str(
            membership.get("album_key") or ""
        ).strip()
        for membership in existing_memberships
        if membership.get("private_path")
    }

    automatic_year_remaps: dict[str, str] = {}
    collapsed_album_row_ids: set[int] = set()
    automatic_year_split_keys: set[str] = set()
    existing_paths = {
        str(membership.get("private_path") or "")
        for membership in existing_memberships
        if membership.get("private_path")
    }
    for release_key, grouped_rows in automatic_year_groups.items():
        if release_key in separate_release_keys or len(grouped_rows) < 2:
            continue
        grouped_keys = {
            str(row.get("album_key") or "").strip() for row in grouped_rows
        }
        grouped_track_paths = {
            str(track_row.get("track_key") or "")
            for track_row in track_rows
            if str(track_row.get("album_key") or "").strip() in grouped_keys
        }
        if not grouped_track_paths or not grouped_track_paths.issubset(existing_paths):
            automatic_year_split_keys.update(grouped_keys)
            continue
        deliberately_changed_paths = {
            path
            for path in (preferred_paths or set())
            if path not in (excluded_paths or set())
            and generated_key_by_path.get(path) in grouped_keys
            and existing_key_by_path.get(path)
            and generated_key_by_path[path] != existing_key_by_path[path]
        }
        if deliberately_changed_paths:
            automatic_year_split_keys.update(grouped_keys)
            continue
        authorities = {
            (album_key, release_year, release_date)
            for path, album_key, release_year, release_date in existing_authorities.get(
                release_key, set()
            )
            if path in grouped_track_paths and release_date is not None
        }
        if len(authorities) > 1:
            continue
        if authorities:
            canonical_key, canonical_year, canonical_release_date = next(
                iter(authorities)
            )
            canonical_row = next(
                (
                    row
                    for row in grouped_rows
                    if str(row.get("album_key") or "").strip() == canonical_key
                ),
                grouped_rows[0],
            )
        else:
            established_rows = {
                (album_key, release_year)
                for path, album_key, release_year, _release_date in existing_authorities.get(
                    release_key, set()
                )
                if path in grouped_track_paths
            }
            established_paths = {
                path
                for path, _album_key, _release_year, _release_date in existing_authorities.get(
                    release_key, set()
                )
                if path in grouped_track_paths
            }
            established_identity = (
                next(iter(established_rows))
                if established_paths == grouped_track_paths
                and len(established_rows) == 1
                else None
            )
            if established_identity is not None:
                canonical_key, canonical_year = established_identity
                canonical_row = next(
                    (
                        row
                        for row in grouped_rows
                        if str(row.get("album_key") or "").strip() == canonical_key
                    ),
                    grouped_rows[0],
                )
            else:
                canonical_row = grouped_rows[0]
                canonical_key = str(canonical_row.get("album_key") or "").strip()
                canonical_year = safe_int(canonical_row.get("release_year"))
            canonical_release_date = None
        for album_row in grouped_rows:
            generated_key = str(album_row.get("album_key") or "").strip()
            if not generated_key or generated_key == canonical_key:
                if canonical_release_date is None:
                    continue
            else:
                automatic_year_remaps[generated_key] = canonical_key
            album_row["album_key"] = canonical_key
            album_row["release_year"] = canonical_year
            if canonical_release_date is not None:
                original_metadata = album_row.get("metadata")
                metadata = _jsonb_compatible(original_metadata or {})
                metadata["release_date"] = canonical_release_date
                album_row["metadata"] = (
                    metadata
                    if isinstance(original_metadata, dict)
                    else _jsonb(metadata)
                )
            if album_row is not canonical_row:
                collapsed_album_row_ids.add(id(album_row))

    if collapsed_album_row_ids:
        album_rows[:] = [
            row for row in album_rows if id(row) not in collapsed_album_row_ids
        ]

    for featured_row in featured_artist_rows:
        generated_key = str(featured_row.get("album_key") or "")
        if generated_key in automatic_year_remaps:
            featured_row["album_key"] = automatic_year_remaps[generated_key]
    for track_row in track_rows:
        generated_key = str(track_row.get("album_key") or "")
        if generated_key in automatic_year_remaps:
            track_row["album_key"] = automatic_year_remaps[generated_key]

    albums_by_key = {
        str(row.get("album_key") or ""): row
        for row in album_rows
        if str(row.get("album_key") or "")
    }
    existing_by_path = {
        str(row.get("private_path") or ""): row
        for row in existing_memberships
        if str(row.get("private_path") or "")
    }
    candidates_by_generated_key: dict[
        str, set[tuple[str, str, str, int | None, str | None]]
    ] = {}
    for track_row in track_rows:
        generated_key = str(track_row.get("album_key") or "")
        album_row = albums_by_key.get(generated_key)
        existing = existing_by_path.get(str(track_row.get("track_key") or ""))
        if album_row is None or existing is None:
            continue
        if generated_key in automatic_year_split_keys:
            continue
        generated_title = str(album_row.get("title") or "").strip()
        existing_title = str(existing.get("album_title") or "").strip()
        if not generated_title or generated_title.casefold() != existing_title.casefold():
            continue
        generated_artist_key = str(album_row.get("artist_key") or "").strip()
        existing_key = str(existing.get("album_key") or "").strip()
        existing_artist_key = str(existing.get("artist_key") or "").strip()
        generated_metadata = _jsonb_compatible(album_row.get("metadata") or {})
        generated_edition = str(generated_metadata.get("edition") or "").strip()
        existing_edition = str(existing.get("edition") or "").strip()
        if generated_edition.lower() != existing_edition.lower():
            continue
        generated_release_year = safe_int(album_row.get("release_year"))
        existing_release_year = safe_int(existing.get("release_year"))
        existing_release_date = str(existing.get("release_date") or "").strip() or None
        release_key = album_separate_release_key(
            generated_artist_key, generated_title, generated_edition,
        )
        generated_year_is_unresolved = generated_key.endswith("::year::unresolved")
        if (
            generated_key != release_key
            and not generated_year_is_unresolved
            and generated_release_year is not None
            and existing_release_year is not None
            and generated_release_year != existing_release_year
            and existing_release_date is None
        ):
            continue
        if (
            generated_key != release_key
            and not generated_year_is_unresolved
            and release_key in separate_release_keys
        ):
            continue
        if (
            generated_artist_key
            and existing_artist_key
            and generated_artist_key.casefold() == existing_artist_key.casefold()
            and existing_key
        ):
            candidates_by_generated_key.setdefault(generated_key, set()).add(
                (
                    existing_key,
                    existing_artist_key,
                    existing_title,
                    existing_release_year,
                    existing_release_date,
                )
            )

    remapped: dict[str, tuple[str, str, str]] = {
        generated_key: next(iter(candidates))
        for generated_key, candidates in candidates_by_generated_key.items()
        if len(candidates) == 1
    }
    for album_row in album_rows:
        generated_key = str(album_row.get("album_key") or "")
        target = remapped.get(generated_key)
        if target is None:
            continue
        album_row["album_key"], album_row["artist_key"], album_row["title"] = target[:3]
        if target[4] is not None:
            album_row["release_year"] = target[3]
            original_metadata = album_row.get("metadata")
            metadata = _jsonb_compatible(original_metadata or {})
            metadata["release_date"] = target[4]
            album_row["metadata"] = (
                metadata if isinstance(original_metadata, dict) else _jsonb(metadata)
            )
        elif generated_key.endswith("::year::unresolved") and target[3] is not None:
            album_row["release_year"] = target[3]
    for featured_row in featured_artist_rows:
        generated_key = str(featured_row.get("album_key") or "")
        target = remapped.get(generated_key)
        if target is None:
            continue
        featured_row["album_key"] = target[0]
        if str(featured_row.get("featured_kind") or "") == "owner":
            featured_row["artist_key"] = target[1]
    for track_row in track_rows:
        generated_key = str(track_row.get("album_key") or "")
        target = remapped.get(generated_key)
        if target is not None:
            track_row["album_key"] = target[0]


def _inventory_rows_from_albums(
    file_cache: dict[str, dict[str, object]],
    albums: list[object],
    *,
    include_track_inventory: bool = True,
) -> tuple[
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
]:
    from music_app.services.album_local_membership import rejected_local_album_paths

    rejected_paths = rejected_local_album_paths(file_cache.values())
    file_cache = {key: {**entry, "local_album_membership_problem": rejected_paths.get(str(entry.get("path") or key))}
                  for key, entry in file_cache.items() if isinstance(entry, dict)}
    file_entries_by_path = _file_entries_by_path(file_cache)
    represented_private_paths: set[str] = set()
    artists: dict[str, dict[str, object]] = {}
    album_rows: list[dict[str, object]] = []
    featured_artist_rows: list[dict[str, object]] = []
    track_rows: list[dict[str, object]] = []
    track_file_rows: list[dict[str, object]] = []
    seen_featured_rows: set[tuple[str, str, str, str]] = set()

    def ensure_artist(name: object) -> str | None:
        artist_name = _text_or_none(name)
        if artist_name is None:
            return None
        artist_key = _key(artist_name)
        artists.setdefault(
            artist_key,
            {
                "artist_key": artist_key,
                "name": artist_name,
                "sort_name": artist_name.casefold(),
                "metadata": _jsonb({"source": _SOURCE}),
            },
        )
        return artist_key

    def album_owner_name(album: object) -> str | None:
        classified_owner = _text_or_none(getattr(album, "album_artist", None))
        tagged_owner_names = _deduped_artist_names(
            _text_or_none(file_entries_by_path.get(str(track.path), {}).get("album_artist"))
            for track in getattr(album, "tracks", []) or []
        )
        if len({_key(name) for name in tagged_owner_names}) == 1:
            tagged_owner = tagged_owner_names[0]
            if (
                _is_various_artist(tagged_owner)
                and classified_owner
                and not _is_various_artist(classified_owner)
            ):
                return classified_owner
            if _is_various_artist(tagged_owner):
                return None
            tagged_members = split_album_artist_members(tagged_owner)
            if (
                classified_owner is not None
                and len(tagged_members) >= 2
                and any(
                    _key(classified_owner) == _key(member)
                    for member in tagged_members
                )
            ):
                return classified_owner
            return tagged_owner
        return classified_owner

    for album in albums:
        owner_name = album_owner_name(album)
        persisted_album_artist = owner_name or getattr(album, "album_artist", None)
        member_artist_names = _deduped_artist_names(getattr(album, "artists", []) or [])
        if not member_artist_names:
            if owner_name is not None:
                member_artist_names = [owner_name]
        member_artist_keys = {_key(name) for name in member_artist_names}
        has_structured_shared_credit = bool(
            owner_name
            and len(member_artist_keys) >= 2
            and _key(owner_name) not in member_artist_keys
            and not _is_various_artist(owner_name)
        )
        album_artist_key = None if has_structured_shared_credit else ensure_artist(owner_name)
        album_key = str(getattr(album, "key", "") or "").strip()
        classified_owner = _text_or_none(getattr(album, "album_artist", None))
        if (
            owner_name
            and classified_owner
            and _key(owner_name) != _key(classified_owner)
        ):
            title = _text_or_none(getattr(album, "name", None)) or "Unknown Album"
            edition = _text_or_none(getattr(album, "edition", None)) or ""
            classified_release_key = album_separate_release_key(
                classified_owner,
                title,
                edition,
            )
            tagged_release_key = album_separate_release_key(
                owner_name,
                title,
                edition,
            )
            if album_key == classified_release_key:
                album_key = tagged_release_key
            elif album_key.startswith(f"{classified_release_key}::year::"):
                album_key = (
                    tagged_release_key + album_key[len(classified_release_key):]
                )
        if not album_key:
            continue
        tag_album_rating = _raw_tag_album_rating_from_file_entries(
            album,
            file_entries_by_path,
        )
        track_artist_names: list[str] = []
        split_track_member_keys: list[str] = []
        for track in getattr(album, "tracks", []) or []:
            track_member_keys = {
                _key(name)
                for name in track_artist_credit_members(
                    getattr(track, "artist", None),
                    None,
                )
                if _key(name) in member_artist_keys
            }
            if len(track_member_keys) != 1:
                split_track_member_keys = []
                break
            split_track_member_keys.extend(track_member_keys)
        is_split_release = (
            str(getattr(album, "release_type", "") or "").strip().casefold()
            == "split"
            or has_structured_shared_credit
            and bool(split_track_member_keys)
            and set(split_track_member_keys) == member_artist_keys
            and len(member_artist_keys) >= 2
        )
        album_rows.append(
            {
                "artist_key": album_artist_key,
                "album_key": album_key,
                "title": _text_or_none(getattr(album, "name", None)) or "Unknown Album",
                "release_year": safe_int(getattr(album, "year", None)),
                "cover_path": _text_or_none(getattr(album, "cover_path", None)),
                "metadata": _jsonb(
                    {
                        "source": _SOURCE,
                        "album_artist": persisted_album_artist,
                        "artists": member_artist_names,
                        "is_compilation": bool(
                            getattr(album, "is_compilation", False)
                        ),
                        "featured_artists": [],
                        "edition": getattr(album, "edition", None),
                        "release_type": getattr(album, "release_type", None) or "ALBUM",
                        "is_split_album": is_split_release,
                        "cover_revision": getattr(album, "cover_revision", None),
                        **_album_cover_authority_metadata(album),
                        "root_provenance": getattr(album, "root_provenance", None),
                    }
                ),
            }
        )
        _append_featured_artist_row(
            featured_artist_rows,
            seen_featured_rows,
            album_key=album_key,
            artist_key=album_artist_key,
            featured_kind="owner",
            source=_SOURCE,
        )
        owner_key = _key(owner_name) if owner_name is not None else None
        for member_name in member_artist_names:
            if owner_name and same_artist_credit_spelling(owner_name, member_name):
                continue
            member_key = ensure_artist(member_name)
            featured_kind = (
                "owner"
                if is_split_release or has_structured_shared_credit or member_key == owner_key
                else "featured_member"
            )
            _append_featured_artist_row(
                featured_artist_rows,
                seen_featured_rows,
                album_key=album_key,
                artist_key=member_key,
                featured_kind=featured_kind,
                source=_SOURCE,
            )
        for track in getattr(album, "tracks", []) or []:
            track_key = str(getattr(track, "path", "") or "").strip()
            if not track_key:
                continue
            file_entry = file_entries_by_path.get(track_key) or {}
            private_path = str(file_entry.get("path") or track_key).strip()
            represented_private_paths.add(private_path)
            track_artist_name = _text_or_none(getattr(track, "artist", None) or getattr(album, "album_artist", None))
            raw_track_artist_names = file_entry.get("artists")
            attached_track_artist_names = (
                _deduped_artist_names(list(raw_track_artist_names))
                if isinstance(raw_track_artist_names, (list, tuple))
                else []
            ) or track_artist_credit_members(track_artist_name, owner_name)
            track_artist_key = ensure_artist(
                attached_track_artist_names[0]
                if attached_track_artist_names
                else track_artist_name
            )
            track_artist_names.extend(attached_track_artist_names)
            for attached_artist_name in attached_track_artist_names:
                if owner_name and same_artist_credit_spelling(owner_name, attached_artist_name):
                    continue
                attached_artist_key = ensure_artist(attached_artist_name)
                _append_featured_artist_row(
                    featured_artist_rows,
                    seen_featured_rows,
                    album_key=album_key,
                    artist_key=attached_artist_key,
                    featured_kind="featured_track_artist",
                    source=_SOURCE,
                )
            if not include_track_inventory:
                continue
            track_rows.append(
                {
                    "album_key": album_key,
                    "artist_key": track_artist_key,
                    "track_key": track_key,
                    "title": _text_or_none(getattr(track, "title", None)) or Path(track_key).stem,
                    "disc_number": safe_int(getattr(track, "disc_number", None)),
                    "track_number": safe_int(getattr(track, "track_number", None)),
                    "duration_seconds": safe_int(getattr(track, "duration_seconds", None)),
                    "metadata": _jsonb(
                        {
                            "source": _SOURCE,
                            "album": getattr(track, "album", None),
                            "album_artist": getattr(track, "album_artist", None),
                            "artist": track_artist_name,
                            "artists": attached_track_artist_names,
                            "root_provenance": getattr(track, "root_provenance", None),
                        }
                    ),
                }
            )
            track_file_rows.append(
                {
                    "track_key": track_key,
                    "private_path": private_path,
                    "relative_path": None,
                    "file_size_bytes": safe_int(file_entry.get("size")),
                    "modified_at_epoch": _float_or_zero(file_entry.get("mtime")),
                    "metadata": _jsonb(
                        {
                            "source": _SOURCE,
                            "library_root_id": file_entry.get("library_root_id"),
                            "library_root_category": file_entry.get("library_root_category"),
                            "scan_cache": {
                                "source": _SOURCE,
                                "stale": False,
                                "file_entry": serialize_file_entry(file_entry),
                            },
                        }
                    ),
                }
            )
        album_rows[-1]["metadata"] = _jsonb(
            {
                "source": _SOURCE,
                "album_artist": persisted_album_artist,
                "artists": member_artist_names,
                "is_compilation": bool(
                    getattr(album, "is_compilation", False)
                ),
                "featured_artists": [
                    artist_name
                    for artist_name in _deduped_artist_names([*member_artist_names, *track_artist_names])
                    if not (owner_name and same_artist_credit_spelling(owner_name, artist_name))
                ],
                "edition": getattr(album, "edition", None),
                "release_type": getattr(album, "release_type", None) or "ALBUM",
                "is_split_album": is_split_release,
                "cover_revision": getattr(album, "cover_revision", None),
                **_album_cover_authority_metadata(album),
                "root_provenance": getattr(album, "root_provenance", None),
                "tag_album_rating": tag_album_rating,
                "tag_album_rating_source": (
                    "file_tag" if tag_album_rating is not None else None
                ),
            }
        )

    published_album_keys = {
        str(row.get("album_key") or "").strip()
        for row in album_rows
        if str(row.get("album_key") or "").strip()
    }
    for cache_key, file_entry in (file_cache.items() if include_track_inventory else ()):
        if not isinstance(file_entry, dict):
            continue
        private_path = str(file_entry.get("path") or cache_key or "").strip()
        if not private_path or private_path in represented_private_paths:
            continue
        album_owner = _text_or_none(
            file_entry.get("album_artist") or file_entry.get("artist")
        )
        album_title = _text_or_none(file_entry.get("album"))
        unrepresented_album_key = (
            album_separate_release_key(
                str(album_owner or ""),
                str(album_title or ""),
                str(file_entry.get("edition") or ""),
            )
            if (
                album_owner
                and album_title
                and not normalize_exception_value(file_entry.get("exception_type"))
            )
            else None
        )
        track_artist_key = ensure_artist(
            file_entry.get("artist") or file_entry.get("album_artist") or "Unknown Artist"
        )
        if (
            unrepresented_album_key
            and album_owner
            and album_title
            and unrepresented_album_key not in published_album_keys
        ):
            album_artist_key = ensure_artist(album_owner)
            album_rows.append(
                {
                    "artist_key": album_artist_key,
                    "album_key": unrepresented_album_key,
                    "title": album_title,
                    "release_year": safe_int(file_entry.get("year")),
                    "cover_path": None,
                    "metadata": _jsonb(
                        {
                            "source": _SOURCE,
                            "album_artist": album_owner,
                            "artists": [album_owner],
                            "is_compilation": False,
                            "featured_artists": [],
                            "edition": file_entry.get("edition"),
                            "release_type": file_entry.get("album_type") or "ALBUM",
                            "root_provenance": build_root_provenance_payload(
                                file_entry.get("library_root_id"),
                                file_entry.get("library_root_category"),
                            ),
                        }
                    ),
                }
            )
            _append_featured_artist_row(
                featured_artist_rows,
                seen_featured_rows,
                album_key=unrepresented_album_key,
                artist_key=album_artist_key,
                featured_kind="owner",
                source=_SOURCE,
            )
            published_album_keys.add(unrepresented_album_key)
        track_key = private_path
        track_rows.append(
            {
                "album_key": unrepresented_album_key,
                "artist_key": track_artist_key,
                "track_key": track_key,
                "title": _text_or_none(file_entry.get("title")) or Path(track_key).stem,
                "disc_number": safe_int(file_entry.get("disc_number")),
                "track_number": safe_int(file_entry.get("track_number")),
                "duration_seconds": safe_int(file_entry.get("duration_seconds")),
                "metadata": _jsonb(
                    {
                        "source": _SOURCE,
                        "album": file_entry.get("album"),
                        "album_artist": file_entry.get("album_artist"),
                        "scan_cache_only": True,
                    }
                ),
            }
        )
        track_file_rows.append(
            {
                "track_key": track_key,
                "private_path": private_path,
                "relative_path": None,
                "file_size_bytes": safe_int(file_entry.get("size")),
                "modified_at_epoch": _float_or_zero(file_entry.get("mtime")),
                "metadata": _jsonb(
                    {
                        "source": _SOURCE,
                        "library_root_id": file_entry.get("library_root_id"),
                        "library_root_category": file_entry.get("library_root_category"),
                        "scan_cache": {
                            "source": _SOURCE,
                            "stale": False,
                            "file_entry": serialize_file_entry(file_entry),
                            "cache_only": True,
                        },
                    }
                ),
            }
        )

    return (
        sorted(artists.values(), key=lambda row: str(row["artist_key"])),
        album_rows,
        featured_artist_rows,
        track_rows,
        track_file_rows,
    )


def _deduped_artist_names(values: list[object]) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for value in values:
        name = _text_or_none(value)
        if name is None:
            continue
        name_key = _key(name)
        if name_key in seen:
            continue
        seen.add(name_key)
        names.append(name)
    return names


def _append_featured_artist_row(
    rows: list[dict[str, object]],
    seen_rows: set[tuple[str, str, str, str]],
    *,
    album_key: str,
    artist_key: str | None,
    featured_kind: str,
    source: str,
) -> None:
    if artist_key is None:
        return
    row_identity = (album_key, artist_key, featured_kind, source)
    if row_identity in seen_rows:
        return
    seen_rows.add(row_identity)
    rows.append(
        {
            "album_key": album_key,
            "artist_key": artist_key,
            "featured_kind": featured_kind,
            "metadata": _jsonb({"source": source}),
        }
    )


def _file_entries_by_path(file_cache: dict[str, dict[str, object]]) -> dict[str, dict[str, object]]:
    entries: dict[str, dict[str, object]] = {}
    for cache_key, entry in file_cache.items():
        if not isinstance(entry, dict):
            continue
        for path_value in (
            cache_key,
            entry.get("path"),
            str(Path(str(cache_key or ""))),
            str(cache_key or "").replace("\\", "/"),
            str(cache_key or "").replace("/", "\\"),
            str(entry.get("path") or "").replace("\\", "/"),
            str(entry.get("path") or "").replace("/", "\\"),
        ):
            path = str(path_value or "").strip()
            if path:
                entries[path] = entry
    return entries


def _fallback_file_entry(row: dict[str, object]) -> dict[str, object] | None:
    path = _text_or_none(row.get("private_path"))
    if path is None:
        return None
    return {
        "path": path,
        "mtime": _float_or_zero(row.get("modified_at_epoch")),
        "size": safe_int(row.get("file_size_bytes")) or 0,
        "album": row.get("album_title") or "Unknown Album",
        "album_artist": row.get("album_artist") or "Unknown Artist",
        "title": row.get("track_title") or Path(path).stem,
        "track_number": row.get("track_number"),
        "disc_number": row.get("disc_number"),
        "disc_number_raw": None,
        "artist": row.get("track_artist"),
        "duration_seconds": row.get("duration_seconds"),
        "cover_path": row.get("cover_path"),
        "year": row.get("release_year"),
        "edition": row.get("edition"),
        "album_rating": row.get("album_rating"),
        "library_root_id": row.get("library_root_id"),
        "library_root_category": row.get("library_root_category"),
        "exception_type": None,
    }


def _restore_structurally_inherited_covers(
    incoming_entries: dict[str, dict[str, object]],
    persisted_entries: dict[str, dict[str, object]],
) -> dict[str, dict[str, object]]:
    restored_entries = dict(incoming_entries)
    for path, incoming_entry in incoming_entries.items():
        persisted_entry = persisted_entries.get(path)
        if not isinstance(persisted_entry, dict):
            continue
        cover_path = str(persisted_entry.get("cover_path") or "").strip()
        if (
            incoming_entry.get("cover_path")
            or persisted_entry.get("cover_inherited_from_structural_edit") is not True
            or not cover_path
            or not Path(cover_path).is_file()
            or not inferred_local_cover_belongs_to_track(cover_path, path)
        ):
            continue
        restored_entry = dict(incoming_entry)
        restored_entry["cover_path"] = cover_path
        restored_entry["cover_inherited_from_structural_edit"] = True
        restored_entries[path] = restored_entry
    return restored_entries


def _targeted_surviving_file_entry(
    row: dict[str, object],
) -> dict[str, object] | None:
    file_entry = _fallback_file_entry(row)
    if file_entry is None:
        return None
    persisted_entry = row.get("file_entry")
    if isinstance(persisted_entry, dict):
        # Do not attribute a removed member's cover to every survivor.
        file_entry.pop("cover_path", None)
        file_entry.update(persisted_entry)
    if type(row.get("album_is_compilation")) is bool:
        file_entry["is_compilation"] = row["album_is_compilation"]
    album_metadata = row.get("album_metadata")
    if not isinstance(album_metadata, dict):
        album_metadata = {}
    cover_selection_origin = str(
        file_entry.get("cover_selection_origin")
        or row.get("cover_selection_origin")
        or ""
    ).casefold()
    cover_selection_provenance = str(
        file_entry.get("cover_selection_provenance")
        or row.get("cover_selection_provenance")
        or ""
    ).casefold()
    if (
        file_entry.get("cover_path")
        and cover_selection_origin == "automatic"
        and cover_selection_provenance != "explicit"
        and not (
            file_entry.get("remote_cover_url")
            or album_metadata.get("remote_cover_url")
        )
        and not inferred_local_cover_belongs_to_track(
            file_entry.get("cover_path"), row.get("private_path")
        )
    ):
        for field in _AUTHORITATIVE_COVER_FIELDS:
            file_entry[field] = None
        file_entry["cover_selection_origin"] = None
        file_entry["cover_selection_provenance"] = None
    if (
        not file_entry.get("cover_path")
        and inferred_local_cover_belongs_to_track(
            row.get("cover_path"), row.get("private_path")
        )
    ):
        # Folder art remains authoritative while its physical album survives,
        # even when older serialized entries predate cover hydration.
        file_entry["cover_path"] = row.get("cover_path")
        for field in _ALBUM_COVER_METADATA_FIELDS:
            if (
                field != "cover_selection_repair_previous"
                and field in album_metadata
            ):
                file_entry[field] = album_metadata[field]
    if file_entry.get("cover_path") and not file_entry.get(
        "cover_selection_origin"
    ):
        # File serialization keeps cover path/revision; the owning album
        # retains the selection's origin.
        file_entry["cover_selection_origin"] = row.get("cover_selection_origin")
    return file_entry


def _load_cover_mutation_revision_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        select coalesce(
          nullif(library.libraries.metadata ->> 'cover_mutation_revision', '')::bigint,
          0
        ) as cover_mutation_revision
        from library.libraries
        join bootstrap_context on bootstrap_context.library_id = library.libraries.id
        limit 1;
    """


def _increment_cover_mutation_revision_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        update library.libraries
           set metadata = coalesce(library.libraries.metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'cover_mutation_revision',
                  coalesce(
                    nullif(library.libraries.metadata ->> 'cover_mutation_revision', '')::bigint,
                    0
                  ) + 1
                ),
               updated_at = now()
        from bootstrap_context
        where library.libraries.id = bootstrap_context.library_id;
    """


def _load_inventory_mutation_revision_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        select coalesce(
          nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
          0
        ) as inventory_mutation_revision
        from library.libraries
        join bootstrap_context on bootstrap_context.library_id = library.libraries.id
        limit 1;
    """


def _retire_placeholder_albums_sql() -> str:
    """Delete "Unknown Artist"/"Unknown Album" rows once no track uses them.

    Owner-approved 2026-11-04: absent tags are loose tracks, so a placeholder
    album that an older scan published is retired after its tracks move to
    Loose Tracks. Real albums and placeholders still holding tracks are kept.
    """
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        delete from library.local_albums albums
        using bootstrap_context
        where albums.library_id = bootstrap_context.library_id
          and (%(album_ids)s::bigint[] is null or albums.id = any(%(album_ids)s::bigint[]))
          and (
            lower(btrim(coalesce(albums.title, ''))) in ('', 'unknown album')
            or exists (
              select 1 from library.local_artists artists
              where artists.id = albums.artist_id and artists.artist_key = 'unknown artist'
            )
          )
          and not exists (
            select 1 from library.local_tracks tracks where tracks.album_id = albums.id
          )
        returning albums.album_key
    """


def _increment_inventory_mutation_revision_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        updated_library as (
          update library.libraries
             -- The same transaction publishes relations before it commits, so
             -- it never marks them stale: a loose-track-only change has no
             -- album journal rows to justify a stale status.
             set metadata = coalesce(library.libraries.metadata, '{}'::jsonb)
                   || jsonb_build_object(
                        'inventory_mutation_revision',
                        coalesce(
                          nullif(
                            library.libraries.metadata ->> 'inventory_mutation_revision',
                            ''
                          )::bigint,
                          0
                        ) + 1
                      ),
                 updated_at = now()
          from bootstrap_context
          where library.libraries.id = bootstrap_context.library_id
          returning coalesce(
            nullif(
              library.libraries.metadata ->> 'inventory_mutation_revision',
              ''
            )::bigint,
            0
          ) as inventory_mutation_revision
        )
        select inventory_mutation_revision
        from updated_library
        limit 1;
    """


def _reconcile_semantic_local_albums_sql(
    *,
    target_album_ids: tuple[int, ...] | None = None,
    allow_same_year_separate_release_merge: bool = False,
) -> tuple[str, ...]:
    scoped_target_ids = tuple(
        sorted(
            {
                int(album_id)
                for album_id in (target_album_ids or ())
                if int(album_id) > 0
            }
        )
    )
    if allow_same_year_separate_release_merge and not scoped_target_ids:
        raise ValueError("Explicit release consolidation requires a targeted album identity.")
    target_identity_cte_sql = (
        """
        semantic_album_target_identities as materialized (
          select distinct
            library.local_albums.library_id,
            library.local_albums.artist_id,
            lower(btrim(library.local_albums.title)) as normalized_title,
            library.local_albums.release_year,
            lower(
              btrim(
                coalesce(
                  library.local_albums.metadata ->> 'edition',
                  ''
                )
              )
            ) as normalized_edition
          from library.local_albums
          join bootstrap_context
            on bootstrap_context.library_id = library.local_albums.library_id
          where library.local_albums.id =
                any(%(target_album_ids)s::bigint[])
        ),
        """
        if scoped_target_ids
        else ""
    )
    target_identity_join_sql = (
        """
            join semantic_album_target_identities as target_identity
              on target_identity.library_id = library.local_albums.library_id
             and target_identity.artist_id is not distinct from
                 library.local_albums.artist_id
             and target_identity.normalized_title =
                 lower(btrim(library.local_albums.title))
             and target_identity.release_year is not distinct from
                 library.local_albums.release_year
             and target_identity.normalized_edition =
                 lower(
                   btrim(
                     coalesce(
                       library.local_albums.metadata ->> 'edition',
                       ''
                     )
                   )
                 )
        """
        if scoped_target_ids
        else ""
    )
    sql = (
        """
        with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id =
               app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        select pg_advisory_xact_lock(
          hashtextextended(
            'album_haven:semantic-local-album-reconciliation:'
              || bootstrap_context.library_id::text,
            0
          )
        )
        from bootstrap_context;

        drop table if exists pg_temp.semantic_album_candidates;
        create temporary table semantic_album_candidates (
          redundant_album_id bigint primary key,
          canonical_album_id bigint not null,
          library_id bigint not null,
          redundant_album_key text not null,
          canonical_album_key text not null
        ) on commit drop;

        with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id =
               app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        """
        + target_identity_cte_sql
        + """
        semantic_album_candidates as materialized (
          select
            ranked.album_id as redundant_album_id,
            ranked.canonical_album_id,
            ranked.library_id,
            ranked.album_key as redundant_album_key,
            ranked.canonical_album_key
          from (
            select
            library.local_albums.id as album_id,
            library.local_albums.library_id,
            library.local_albums.album_key,
            min(library.local_albums.id) over (
              partition by
                library.local_albums.library_id,
                library.local_albums.artist_id,
                lower(btrim(library.local_albums.title)),
                library.local_albums.release_year,
                lower(
                  btrim(
                    coalesce(
                      library.local_albums.metadata ->> 'edition',
                      ''
                    )
                  )
                )
            ) as canonical_album_id,
            first_value(library.local_albums.album_key) over (
              partition by
                library.local_albums.library_id,
                library.local_albums.artist_id,
                lower(btrim(library.local_albums.title)),
                library.local_albums.release_year,
                lower(
                  btrim(
                    coalesce(
                      library.local_albums.metadata ->> 'edition',
                      ''
                    )
                  )
                )
              order by library.local_albums.id
            ) as canonical_album_key
            from library.local_albums
            join bootstrap_context
              on bootstrap_context.library_id =
                 library.local_albums.library_id
        """
        + target_identity_join_sql
        + """
            left join library.local_artists
              on library.local_artists.id = library.local_albums.artist_id
             and library.local_artists.library_id =
                 library.local_albums.library_id
            where nullif(btrim(library.local_albums.title), '') is not null
              and library.local_albums.artist_id is not null
              and (
        """
        + ("true" if allow_same_year_separate_release_merge else "false")
        + """
                or not exists (
                select 1
                from library.separate_releases
                where library.separate_releases.library_id =
                      library.local_albums.library_id
                  and library.separate_releases.release_key = concat_ws(
                      '::',
                      lower(
                        btrim(
                          coalesce(
                            nullif(
                              btrim(
                                library.local_albums.metadata
                                  ->> 'album_artist'
                              ),
                              ''
                            ),
                            library.local_artists.name,
                            ''
                          )
                        )
                      ),
                      lower(btrim(library.local_albums.title)),
                      nullif(
                        lower(
                          btrim(
                            coalesce(
                              library.local_albums.metadata ->> 'edition',
                              ''
                            )
                          )
                        ),
                        ''
                      )
                      )
                )
              )
          ) as ranked
          where ranked.album_id <> ranked.canonical_album_id
        )
        insert into pg_temp.semantic_album_candidates (
          redundant_album_id,
          canonical_album_id,
          library_id,
          redundant_album_key,
          canonical_album_key
        )
        select
          semantic_album_candidates.redundant_album_id,
          semantic_album_candidates.canonical_album_id,
          semantic_album_candidates.library_id,
          semantic_album_candidates.redundant_album_key,
          semantic_album_candidates.canonical_album_key
        from semantic_album_candidates;

        -- Acquire all album locks in stable ID order before moving dependents.
        select library.local_albums.id
        from library.local_albums
        where library.local_albums.id in (
          select semantic_album_candidates.canonical_album_id
          from semantic_album_candidates
          union
          select semantic_album_candidates.redundant_album_id
          from semantic_album_candidates
        )
        order by library.local_albums.id
        for update;

        with semantic_album_members as (
          select distinct
            semantic_album_candidates.canonical_album_id,
            semantic_album_candidates.canonical_album_id as album_id
          from semantic_album_candidates
          union
          select
            semantic_album_candidates.canonical_album_id,
            semantic_album_candidates.redundant_album_id
          from semantic_album_candidates
        ),
        metadata_candidates as (
          select
            semantic_album_members.canonical_album_id,
            semantic_album_members.album_id,
            metadata_entry.key,
            metadata_entry.value,
            case
              when metadata_entry.value = 'null'::jsonb then false
              when jsonb_typeof(metadata_entry.value) = 'string'
                then nullif(
                  btrim(metadata_entry.value #>> '{}'),
                  ''
                ) is not null
              when jsonb_typeof(metadata_entry.value) = 'array'
                then metadata_entry.value <> '[]'::jsonb
              when jsonb_typeof(metadata_entry.value) = 'object'
                then metadata_entry.value <> '{}'::jsonb
              else true
            end as metadata_value_is_meaningful
          from semantic_album_members
          join library.local_albums
            on library.local_albums.id = semantic_album_members.album_id
          cross join lateral jsonb_each(
            coalesce(library.local_albums.metadata, '{}'::jsonb)
          ) as metadata_entry
        ),
        metadata_values as (
          select
            metadata_candidates.canonical_album_id,
            metadata_candidates.key,
            metadata_candidates.value,
            row_number() over (
              partition by
                metadata_candidates.canonical_album_id,
                metadata_candidates.key
              order by
                (
                  metadata_candidates.album_id =
                  metadata_candidates.canonical_album_id
                  and metadata_value_is_meaningful
                ) desc,
                metadata_value_is_meaningful desc,
                (
                  metadata_candidates.album_id =
                  metadata_candidates.canonical_album_id
                ) desc,
                metadata_candidates.album_id
            ) as preference
          from metadata_candidates
        ),
        merged_metadata as (
          select
            metadata_values.canonical_album_id,
            jsonb_object_agg(
              metadata_values.key,
              metadata_values.value
            ) as metadata
          from metadata_values
          where metadata_values.preference = 1
          group by metadata_values.canonical_album_id
        ),
        merged_album_projection as (
          select
            semantic_album_members.canonical_album_id,
            (
              array_agg(
                nullif(btrim(library.local_albums.cover_path), '')
                order by
                  (
                    semantic_album_members.album_id =
                    semantic_album_members.canonical_album_id
                    and nullif(
                      btrim(library.local_albums.cover_path),
                      ''
                    ) is not null
                  ) desc,
                  (
                    nullif(
                      btrim(library.local_albums.cover_path),
                      ''
                    ) is not null
                  ) desc,
                  semantic_album_members.album_id
              )
            )[1] as cover_path,
            min(library.local_albums.first_seen_at) as first_seen_at,
            max(library.local_albums.last_seen_at) as last_seen_at,
            (
              array_agg(
                semantic_album_members.album_id
                order by
                  (library.local_albums.mbid is not null) desc,
                  (
                    library.local_albums.mbid_assertion_state <>
                    'unreviewed'
                  ) desc,
                  library.local_albums.evidence_confidence desc nulls last,
                  (
                    semantic_album_members.album_id =
                    semantic_album_members.canonical_album_id
                  ) desc,
                  (library.local_albums.evidence_source is not null) desc,
                  semantic_album_members.album_id
              )
            )[1] as best_evidence_album_id
          from semantic_album_members
          join library.local_albums
            on library.local_albums.id = semantic_album_members.album_id
          group by semantic_album_members.canonical_album_id
        )
        update library.local_albums
        set
          cover_path = merged_album_projection.cover_path,
          first_seen_at = merged_album_projection.first_seen_at,
          last_seen_at = merged_album_projection.last_seen_at,
          mbid = best_evidence_album.mbid,
          mbid_assertion_state =
            best_evidence_album.mbid_assertion_state,
          evidence_source = best_evidence_album.evidence_source,
          evidence_confidence = best_evidence_album.evidence_confidence,
          mbid_assertion_migration_run_id =
            best_evidence_album.mbid_assertion_migration_run_id,
          mbid_assertion_scan_run_ref =
            best_evidence_album.mbid_assertion_scan_run_ref,
          metadata = coalesce(
            merged_metadata.metadata,
            library.local_albums.metadata
          )
        from merged_album_projection
        left join merged_metadata
          on merged_metadata.canonical_album_id =
             merged_album_projection.canonical_album_id
        join library.local_albums as best_evidence_album
          on best_evidence_album.id =
             merged_album_projection.best_evidence_album_id
        where library.local_albums.id =
              merged_album_projection.canonical_album_id;

        insert into app.album_ratings (
          account_id,
          library_id,
          album_key,
          rating,
          provenance,
          created_at,
          updated_at,
          metadata
        )
        select distinct on (
          app.album_ratings.account_id,
          semantic_album_candidates.library_id,
          semantic_album_candidates.canonical_album_key
        )
          app.album_ratings.account_id,
          semantic_album_candidates.library_id,
          semantic_album_candidates.canonical_album_key,
          app.album_ratings.rating,
          app.album_ratings.provenance,
          app.album_ratings.created_at,
          app.album_ratings.updated_at,
          app.album_ratings.metadata
        from semantic_album_candidates
        join app.album_ratings
          on app.album_ratings.library_id =
             semantic_album_candidates.library_id
         and app.album_ratings.album_key =
             semantic_album_candidates.redundant_album_key
        order by
          app.album_ratings.account_id,
          semantic_album_candidates.library_id,
          semantic_album_candidates.canonical_album_key,
          (app.album_ratings.rating is not null) desc,
          app.album_ratings.updated_at desc,
          semantic_album_candidates.redundant_album_id
        on conflict (account_id, library_id, album_key) do update
        set
          rating = coalesce(app.album_ratings.rating, excluded.rating),
          provenance = case
            when app.album_ratings.rating is null
             and excluded.rating is not null
              then excluded.provenance
            else app.album_ratings.provenance
          end,
          created_at = least(app.album_ratings.created_at, excluded.created_at),
          updated_at = greatest(app.album_ratings.updated_at, excluded.updated_at),
          metadata = excluded.metadata || app.album_ratings.metadata;

        delete from app.album_ratings
        using semantic_album_candidates
        where app.album_ratings.library_id =
              semantic_album_candidates.library_id
          and app.album_ratings.album_key =
              semantic_album_candidates.redundant_album_key;

        insert into library.local_album_featured_artists (
          library_id,
          album_id,
          artist_id,
          featured_kind,
          first_seen_at,
          last_seen_at,
          metadata
        )
        select distinct on (
          library.local_album_featured_artists.library_id,
          semantic_album_candidates.canonical_album_id,
          library.local_album_featured_artists.artist_id,
          library.local_album_featured_artists.featured_kind
        )
          library.local_album_featured_artists.library_id,
          semantic_album_candidates.canonical_album_id,
          library.local_album_featured_artists.artist_id,
          library.local_album_featured_artists.featured_kind,
          library.local_album_featured_artists.first_seen_at,
          library.local_album_featured_artists.last_seen_at,
          library.local_album_featured_artists.metadata
        from semantic_album_candidates
        join library.local_album_featured_artists
          on library.local_album_featured_artists.album_id =
             semantic_album_candidates.redundant_album_id
        order by
          library.local_album_featured_artists.library_id,
          semantic_album_candidates.canonical_album_id,
          library.local_album_featured_artists.artist_id,
          library.local_album_featured_artists.featured_kind,
          library.local_album_featured_artists.last_seen_at desc,
          semantic_album_candidates.redundant_album_id
        on conflict (library_id, album_id, artist_id, featured_kind) do update
        set
          first_seen_at = least(
            library.local_album_featured_artists.first_seen_at,
            excluded.first_seen_at
          ),
          last_seen_at = greatest(
            library.local_album_featured_artists.last_seen_at,
            excluded.last_seen_at
          ),
          metadata = excluded.metadata
            || library.local_album_featured_artists.metadata;

        delete from library.local_album_featured_artists
        using semantic_album_candidates
        where library.local_album_featured_artists.album_id =
              semantic_album_candidates.redundant_album_id;

        update library.local_mbid_assertions
        set
          album_id = semantic_album_candidates.canonical_album_id,
          target_key = case
            when library.local_mbid_assertions.target_kind = 'album'
              then semantic_album_candidates.canonical_album_key
            else library.local_mbid_assertions.target_key
          end
        from semantic_album_candidates
        where library.local_mbid_assertions.album_id =
              semantic_album_candidates.redundant_album_id;

        insert into library.ignored_versions (
          library_id,
          version_key,
          created_at,
          metadata
        )
        select distinct on (
          library.ignored_versions.library_id,
          semantic_album_candidates.canonical_album_key
        )
          library.ignored_versions.library_id,
          semantic_album_candidates.canonical_album_key,
          library.ignored_versions.created_at,
          library.ignored_versions.metadata
        from semantic_album_candidates
        join library.ignored_versions
          on library.ignored_versions.library_id =
             semantic_album_candidates.library_id
         and library.ignored_versions.version_key =
             semantic_album_candidates.redundant_album_key
        order by
          library.ignored_versions.library_id,
          semantic_album_candidates.canonical_album_key,
          library.ignored_versions.created_at
        on conflict (library_id, version_key) do update
        set
          created_at = least(
            library.ignored_versions.created_at,
            excluded.created_at
          ),
          metadata = excluded.metadata || library.ignored_versions.metadata;

        delete from library.ignored_versions
        using semantic_album_candidates
        where library.ignored_versions.library_id =
              semantic_album_candidates.library_id
          and library.ignored_versions.version_key =
              semantic_album_candidates.redundant_album_key;

        insert into library.manual_versions (
          library_id,
          child_key,
          parent_key,
          created_at,
          updated_at,
          metadata
        )
        select distinct on (
          mapped_version.library_id,
          mapped_version.child_key
        )
          mapped_version.library_id,
          mapped_version.child_key,
          mapped_version.parent_key,
          mapped_version.created_at,
          mapped_version.updated_at,
          mapped_version.metadata
        from (
          select
            library.manual_versions.library_id,
            coalesce(
              child_candidate.canonical_album_key,
              library.manual_versions.child_key
            ) as child_key,
            coalesce(
              parent_candidate.canonical_album_key,
              library.manual_versions.parent_key
            ) as parent_key,
            library.manual_versions.child_key as original_child_key,
            library.manual_versions.created_at,
            library.manual_versions.updated_at,
            library.manual_versions.metadata
          from library.manual_versions
          left join semantic_album_candidates as child_candidate
            on child_candidate.library_id =
               library.manual_versions.library_id
           and child_candidate.redundant_album_key =
               library.manual_versions.child_key
          left join semantic_album_candidates as parent_candidate
            on parent_candidate.library_id =
               library.manual_versions.library_id
           and parent_candidate.redundant_album_key =
               library.manual_versions.parent_key
          where child_candidate.redundant_album_id is not null
             or parent_candidate.redundant_album_id is not null
        ) as mapped_version
        where mapped_version.child_key <> mapped_version.parent_key
        order by
          mapped_version.library_id,
          mapped_version.child_key,
          (
            mapped_version.original_child_key =
            mapped_version.child_key
          ) desc,
          mapped_version.updated_at desc
        on conflict (library_id, child_key) do update
        set
          parent_key = excluded.parent_key,
          created_at = least(
            library.manual_versions.created_at,
            excluded.created_at
          ),
          updated_at = greatest(
            library.manual_versions.updated_at,
            excluded.updated_at
          ),
          metadata = excluded.metadata || library.manual_versions.metadata;

        delete from library.manual_versions
        using semantic_album_candidates
        where library.manual_versions.library_id =
              semantic_album_candidates.library_id
          and (
            library.manual_versions.child_key =
              semantic_album_candidates.redundant_album_key
            or library.manual_versions.parent_key =
              semantic_album_candidates.redundant_album_key
          );

        update ops.cover_lookup_tasks
        set album_key = semantic_album_candidates.canonical_album_key,
            metadata = jsonb_set(
              coalesce(ops.cover_lookup_tasks.metadata, '{}'::jsonb),
              '{source_payload}',
              coalesce(
                ops.cover_lookup_tasks.metadata -> 'source_payload',
                '{}'::jsonb
              ) || jsonb_build_object(
                'album_payload',
                coalesce(
                  ops.cover_lookup_tasks.metadata
                    #> '{source_payload,album_payload}',
                  '{}'::jsonb
                ) || jsonb_build_object(
                  'id', semantic_album_candidates.canonical_album_id,
                  'album_id', semantic_album_candidates.canonical_album_id,
                  'key', semantic_album_candidates.canonical_album_key
                )
              ),
              true
            )
        from semantic_album_candidates
        where ops.cover_lookup_tasks.library_id =
              semantic_album_candidates.library_id
          and ops.cover_lookup_tasks.album_key =
              semantic_album_candidates.redundant_album_key;

        update library.local_tracks
        set album_id = semantic_album_candidates.canonical_album_id
        from semantic_album_candidates
        where library.local_tracks.album_id =
              semantic_album_candidates.redundant_album_id;

        delete from library.local_albums
        using semantic_album_candidates
        where library.local_albums.id =
              semantic_album_candidates.redundant_album_id;

        drop table if exists pg_temp.semantic_album_candidates;
    """
    )
    return tuple(
        statement.strip()
        for statement in sql.split(";")
        if statement.strip()
    )


def _execute_semantic_local_album_reconciliation(
    connection: Any,
    *,
    target_album_ids: tuple[int, ...] | None = None,
    allow_same_year_separate_release_merge: bool = False,
) -> None:
    scoped_target_ids = tuple(
        sorted(
            {
                int(album_id)
                for album_id in (target_album_ids or ())
                if int(album_id) > 0
            }
        )
    )
    if allow_same_year_separate_release_merge and not scoped_target_ids:
        raise ValueError("Explicit release consolidation requires a targeted album identity.")
    if not scoped_target_ids:
        for statement in _reconcile_semantic_local_albums_sql():
            connection.execute(statement)
        return
    for statement in _reconcile_semantic_local_albums_sql(
        target_album_ids=scoped_target_ids,
        allow_same_year_separate_release_merge=allow_same_year_separate_release_merge,
    ):
        if "%(target_album_ids)s" in statement:
            connection.execute(
                statement,
                {"target_album_ids": list(scoped_target_ids)},
            )
        else:
            connection.execute(statement)


def _rebind_cover_lookup_tasks_after_structural_edit_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        update ops.cover_lookup_tasks as tasks
        set album_key = %(destination_album_key)s,
            metadata = jsonb_set(
              coalesce(tasks.metadata, '{}'::jsonb),
              '{source_payload}',
              coalesce(tasks.metadata -> 'source_payload', '{}'::jsonb)
                || jsonb_build_object(
                     'artist', %(destination_artist_name)s::text,
                     'album', %(destination_album_title)s::text,
                     'year', %(destination_release_year)s::integer,
                     'album_payload',
                     coalesce(
                       tasks.metadata #> '{source_payload,album_payload}',
                       '{}'::jsonb
                     ) || jsonb_build_object(
                       'id', %(destination_album_id)s::bigint,
                       'album_id', %(destination_album_id)s::bigint,
                       'key', %(destination_album_key)s::text,
                       'name', %(destination_album_title)s::text,
                       'album', %(destination_album_title)s::text,
                       'album_artist', %(destination_artist_name)s::text,
                       'artist', %(destination_artist_name)s::text,
                       'year', %(destination_release_year)s::integer
                     )
                   ),
              true
            )
        from bootstrap_context
        where tasks.library_id = bootstrap_context.library_id
          and (
                coalesce(
                  tasks.metadata #>> '{source_payload,album_payload,id}',
                  tasks.metadata #>> '{source_payload,album_payload,album_id}',
                  ''
                ) = %(source_album_id)s::text
                or (
                     coalesce(
                       tasks.metadata #>> '{source_payload,album_payload,id}',
                       tasks.metadata #>> '{source_payload,album_payload,album_id}',
                       ''
                     ) = ''
                     and tasks.album_key = %(source_album_key)s
                   )
              );
    """


def _persist_blank_album_tag_edit_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        input_rows as materialized (
          select *
          from jsonb_to_recordset(%(input_rows)s::jsonb) as input_row (
            private_path text,
            file_entry jsonb
          )
        ),
        selected_track_files as materialized (
          select
            library.local_tracks.id as track_id,
            library.local_tracks.album_id as source_album_id,
            library.local_track_files.id as track_file_id,
            input_rows.file_entry
          from bootstrap_context
          join input_rows on true
          join library.local_track_files
            on library.local_track_files.private_path = input_rows.private_path
           and library.local_track_files.scan_cache_stale is false
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
        ),
        selection_scope as materialized (
          select
            (select count(*) from unnest(%(changed_paths)s::text[])) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.track_id) as resolved_track_count,
            count(distinct selected_track_files.source_album_id) as source_album_count,
            min(selected_track_files.source_album_id) as source_album_id
          from selected_track_files
        ),
        source_album_track_files as materialized (
          select library.local_track_files.id
          from bootstrap_context
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = (select source_album_id from selection_scope)
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and library.local_track_files.scan_cache_stale is false
        ),
        updated_tracks as (
          update library.local_tracks
          set album_id = case
                when %(retain_album_membership)s::boolean
                then selected_track_files.source_album_id
                else null
              end,
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || jsonb_build_object('album', selected_track_files.file_entry -> 'album')
                || (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                    from jsonb_each(selected_track_files.file_entry)
                    where key = any(array['artist', 'artists', 'album_artist'])),
              last_seen_at = now()
          from selected_track_files
          where library.local_tracks.id = selected_track_files.track_id
            and (select source_album_count from selection_scope) <= 1
            and (select resolved_path_count from selection_scope) =
                (select input_path_count from selection_scope)
          returning library.local_tracks.id
        ),
        updated_track_files as (
          update library.local_track_files
          set metadata = jsonb_set(
                coalesce(library.local_track_files.metadata, '{}'::jsonb),
                '{scan_cache}',
                coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'source', %(source)s::text,
                       'stale', false,
                       'file_entry',
                       coalesce(
                         library.local_track_files.metadata #> '{scan_cache,file_entry}',
                         '{}'::jsonb
                       ) || selected_track_files.file_entry
                     ),
                true
              ),
              last_seen_at = now()
          from selected_track_files
          where library.local_track_files.id = selected_track_files.track_file_id
            and (select count(*) from updated_tracks) =
                (select resolved_track_count from selection_scope)
          returning library.local_track_files.id
        ),
        updated_library as (
          update library.libraries
            -- Track/file triggers journal the bounded mutation. Preserve the proven
            -- relation baseline until the same transaction publishes its replacement.
            set metadata = coalesce(library.libraries.metadata, '{}'::jsonb)
                || jsonb_build_object(
                    'inventory_mutation_revision',
                    coalesce(
                        nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
                        0
                    ) + 1
                ),
              updated_at = now()
          from bootstrap_context
          where library.libraries.id = bootstrap_context.library_id
            and (select count(*) from updated_tracks) =
                (select resolved_track_count from selection_scope)
            and (select count(*) from updated_track_files) =
                (select input_path_count from selection_scope)
          returning coalesce(
            nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
            0
          ) as inventory_mutation_revision
        )
        select
          (select input_path_count from selection_scope) as input_path_count,
          (select resolved_path_count from selection_scope) as resolved_path_count,
          (select resolved_track_count from selection_scope) as resolved_track_count,
          (select source_album_count from selection_scope) as source_album_count,
          (select count(*) from source_album_track_files) as source_album_track_file_count,
          (select source_album_id from selection_scope) as source_album_id,
          (select source_album_id from selection_scope) as destination_album_id,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          coalesce((select inventory_mutation_revision from updated_library), 0)
            as inventory_mutation_revision;
    """


def _finalize_detached_album_restore_sql() -> str:
    return """
        with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(%(changed_paths)s::text[]) as input_path
        ),
        input_rows as materialized (
          select incoming.private_path, incoming.file_entry
          from jsonb_to_recordset(%(input_rows)s::jsonb)
            as incoming(private_path text, file_entry jsonb)
        ),
        destination_album as materialized (
          select library.local_albums.id
          from bootstrap_context
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.album_key = %(destination_album_key)s
          order by library.local_albums.id
          limit 1
          for update of local_albums
        ),
        selected_track_files as materialized (
          select
            library.local_tracks.id as track_id,
            library.local_track_files.id as track_file_id,
            library.local_track_files.private_path,
            input_rows.file_entry
          from bootstrap_context
          join library.local_track_files on true
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
          join input_track_paths
            on input_track_paths.private_path = library.local_track_files.private_path
          join input_rows
            on input_rows.private_path = library.local_track_files.private_path
          where library.local_track_files.scan_cache_stale is false
          order by library.local_tracks.id, library.local_track_files.id
          for update of local_tracks, local_track_files
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.track_id) as resolved_track_count,
            count(distinct selected_track_files.track_file_id)
              as resolved_track_file_count
          from selected_track_files
        ),
        updated_tracks as (
          update library.local_tracks
          set album_id = (select destination_album.id from destination_album),
              title = case when selected_track_files.file_entry ? 'title'
                then selected_track_files.file_entry ->> 'title' else library.local_tracks.title end,
              track_number = case when selected_track_files.file_entry ? 'track_number'
                then nullif(selected_track_files.file_entry ->> 'track_number', '')::integer
                else library.local_tracks.track_number end,
              disc_number = case when selected_track_files.file_entry ? 'disc_number'
                then nullif(selected_track_files.file_entry ->> 'disc_number', '')::integer
                else library.local_tracks.disc_number end,
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || case when selected_track_files.file_entry ? 'album'
                     then jsonb_build_object('album', selected_track_files.file_entry -> 'album')
                     else '{}'::jsonb end
                || (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                    from jsonb_each(selected_track_files.file_entry)
                 where key = any(array['artist', 'artists', 'album_artist', 'title', 'genre', 'year',
                      'edition', 'track_number', 'disc_number', 'total_discs', 'disc_subtitle',
                      'album_type', 'album_rating'])),
              last_seen_at = now()
          from selected_track_files
          cross join selection_scope
          where library.local_tracks.id = selected_track_files.track_id
            and selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.input_path_count =
                selection_scope.resolved_track_file_count
            and (select count(*) from destination_album) = 1
          returning library.local_tracks.id
        ),
        updated_track_files as (
          update library.local_track_files
          set metadata = jsonb_set(
                coalesce(library.local_track_files.metadata, '{}'::jsonb),
                '{scan_cache}',
                coalesce(
                  library.local_track_files.metadata -> 'scan_cache',
                  '{}'::jsonb
                ) || jsonb_build_object(
                  'source', %(source)s::text,
                  'stale', false,
                  'file_entry',
                  coalesce(
                    library.local_track_files.metadata
                      #> '{scan_cache,file_entry}',
                    '{}'::jsonb
                  ) || selected_track_files.file_entry
                ),
                true
              ),
              last_seen_at = now()
          from selected_track_files
          cross join selection_scope
          where library.local_track_files.id = selected_track_files.track_file_id
           and library.local_track_files.scan_cache_stale is false
            and selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.input_path_count =
                selection_scope.resolved_track_file_count
            and (select count(*) from destination_album) = 1
          returning library.local_track_files.id
        ),
        updated_library as (
          update library.libraries
          set metadata = jsonb_set(
                coalesce(library.libraries.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'inventory_mutation_revision',
                       coalesce(
                         nullif(
                           library.libraries.metadata ->> 'inventory_mutation_revision',
                           ''
                         )::bigint,
                         0
                       ) + 1
                     ),
                '{scan_cache}',
                coalesce(
                  library.libraries.metadata -> 'scan_cache',
                  '{}'::jsonb
                ) || jsonb_build_object(
                  'relation_projection',
                  coalesce(
                    library.libraries.metadata
                      #> '{scan_cache,relation_projection}',
                    '{}'::jsonb
                  ) || jsonb_build_object(
                    'status', 'stale',
                    'rebuild_reason', 'structural_tag_edit'
                  )
                ),
                true
              ),
              updated_at = now()
          from bootstrap_context
          where library.libraries.id = bootstrap_context.library_id
            and (select count(*) from updated_tracks) =
                (select resolved_track_count from selection_scope)
            and (select count(*) from updated_track_files) =
                (select input_path_count from selection_scope)
          returning coalesce(
            nullif(
              library.libraries.metadata ->> 'inventory_mutation_revision',
              ''
            )::bigint,
            0
          ) as inventory_mutation_revision
        )
        select
          (select input_path_count from selection_scope) as input_path_count,
          (select resolved_path_count from selection_scope) as resolved_path_count,
          (select resolved_track_count from selection_scope) as resolved_track_count,
          0::bigint as source_album_count,
          0::bigint as source_album_track_file_count,
          (select count(*) from destination_album) as destination_album_count,
          (select count(*) from destination_album) as album_rows_updated,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          coalesce(
            (select inventory_mutation_revision from updated_library),
            0
          ) as inventory_mutation_revision,
          (select id from destination_album) as destination_album_id
        ;
    """


def _persist_targeted_inventory_tag_edit_sql() -> str:
    return """
        with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(%(changed_paths)s::text[]) as input_path
        ),
        input_rows as materialized (
          select incoming.private_path, incoming.file_entry, incoming.track_artist_key, incoming.track_artist_name
          from jsonb_to_recordset(%(input_rows)s::jsonb)
            as incoming(private_path text, file_entry jsonb, track_artist_key text, track_artist_name text)
        ),
        selected_track_files as materialized (
          select
            library.local_tracks.id as track_id,
            library.local_track_files.id as track_file_id,
            library.local_tracks.album_id,
            library.local_track_files.private_path,
            input_rows.file_entry, input_rows.track_artist_key, input_rows.track_artist_name
          from bootstrap_context
          join library.local_track_files on true
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
          join input_track_paths
            on input_track_paths.private_path = library.local_track_files.private_path
          join input_rows
            on input_rows.private_path = library.local_track_files.private_path
          where library.local_track_files.scan_cache_stale is false
          order by library.local_tracks.id, library.local_track_files.id
          for update of local_tracks, local_track_files
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.track_id) as resolved_track_count,
            count(distinct selected_track_files.track_file_id)
              as resolved_track_file_count,
            count(*) as source_album_track_file_count
          from selected_track_files
        ),
        inserted_tag_artists as (
          insert into library.local_artists(library_id,artist_key,name,sort_name,metadata)
          select bootstrap_context.library_id, selected_track_files.track_artist_key,
            min(selected_track_files.track_artist_name), lower(min(selected_track_files.track_artist_name)),
            jsonb_build_object('source', %(source)s::text)
          from selected_track_files cross join bootstrap_context cross join selection_scope
          where %(updates_track_artist)s::boolean
            and (selected_track_files.file_entry ? 'artist' or selected_track_files.file_entry ? 'album_artist')
            and selection_scope.input_path_count = selection_scope.resolved_path_count
          group by bootstrap_context.library_id, selected_track_files.track_artist_key
          on conflict(library_id,artist_key) do update set last_seen_at=now()
          returning id,artist_key
        ),
        updated_tracks as (
          update library.local_tracks
          set artist_id = case when %(updates_track_artist)s::boolean
                and (selected_track_files.file_entry ? 'artist' or selected_track_files.file_entry ? 'album_artist')
              then (select id from inserted_tag_artists
                    where artist_key=selected_track_files.track_artist_key)
              else library.local_tracks.artist_id end,
              title = case
                when selected_track_files.file_entry ? 'title'
                then selected_track_files.file_entry ->> 'title'
                else library.local_tracks.title
              end,
              track_number = case
                when selected_track_files.file_entry ? 'track_number'
                then nullif(selected_track_files.file_entry ->> 'track_number', '')::integer
                else library.local_tracks.track_number
              end,
              disc_number = case
                when selected_track_files.file_entry ? 'disc_number'
                then nullif(selected_track_files.file_entry ->> 'disc_number', '')::integer
                else library.local_tracks.disc_number
              end,
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || case when selected_track_files.file_entry ? 'album'
                     then jsonb_build_object('album', selected_track_files.file_entry -> 'album')
                     else '{}'::jsonb end
                || (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                    from jsonb_each(selected_track_files.file_entry)
                 where key = any(array['artist', 'artists', 'album_artist', 'title', 'genre', 'year',
                      'edition', 'track_number', 'disc_number', 'total_discs', 'disc_subtitle',
                      'album_type', 'album_rating'])),
              last_seen_at = now()
          from selected_track_files
          cross join selection_scope
          where library.local_tracks.id = selected_track_files.track_id
            and selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.input_path_count =
                selection_scope.resolved_track_file_count
          returning library.local_tracks.id
        ),
        updated_track_files as (
          update library.local_track_files
          set metadata = jsonb_set(
                coalesce(library.local_track_files.metadata, '{}'::jsonb),
                '{scan_cache}',
                coalesce(
                  library.local_track_files.metadata -> 'scan_cache',
                  '{}'::jsonb
                ) || jsonb_build_object(
                  'source', %(source)s::text,
                  'stale', false,
                  'file_entry',
                  coalesce(
                    library.local_track_files.metadata #> '{scan_cache,file_entry}',
                    '{}'::jsonb
                  ) || selected_track_files.file_entry
                ),
                true
              ),
              last_seen_at = now()
          from selected_track_files
          cross join selection_scope
          where library.local_track_files.id = selected_track_files.track_file_id
            and library.local_track_files.scan_cache_stale is false
            and selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.input_path_count =
                selection_scope.resolved_track_file_count
          returning library.local_track_files.id
        ),
        updated_library as (
          update library.libraries
          set metadata = coalesce(library.libraries.metadata, '{}'::jsonb)
                || jsonb_build_object(
                     'inventory_mutation_revision',
                     coalesce(
                       nullif(
                         library.libraries.metadata ->> 'inventory_mutation_revision',
                         ''
                       )::bigint,
                       0
                     ) + 1
                   ),
              updated_at = now()
          from bootstrap_context
          where library.libraries.id = bootstrap_context.library_id
            and (select count(*) from updated_tracks) =
                (select resolved_track_count from selection_scope)
            and (select count(*) from updated_track_files) =
                (select input_path_count from selection_scope)
          returning coalesce(
            nullif(
              library.libraries.metadata ->> 'inventory_mutation_revision',
              ''
            )::bigint,
            0
          ) as inventory_mutation_revision
        )
        select
          (select input_path_count from selection_scope) as input_path_count,
          (select resolved_path_count from selection_scope) as resolved_path_count,
          (select resolved_track_count from selection_scope) as resolved_track_count,
          (select source_album_track_file_count from selection_scope)
            as source_album_track_file_count,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          coalesce(
            (select inventory_mutation_revision from updated_library),
            0
          ) as inventory_mutation_revision;
    """


def _persist_structural_album_tag_edit_sql(
    *,
    updates_release_year: bool = False,
) -> str:
    renamed_album_metadata_sql = """
              , metadata = case
                  when validated_source_album.has_display_year_override
                  then jsonb_set(
                         coalesce(library.local_albums.metadata, '{}'::jsonb),
                         '{release_date}',
                         to_jsonb(coalesce(
                           nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                           validated_source_album.release_year::text
                         )),
                         true
                       )
                  else library.local_albums.metadata
                end || %(destination_artist_metadata)s::jsonb
    """
    inserted_album_metadata_sql = """
            case
              when validated_source_album.has_display_year_override
              then jsonb_set(
                     coalesce(validated_source_album.metadata, '{}'::jsonb),
                     '{release_date}',
                     to_jsonb(coalesce(
                       nullif(btrim(validated_source_album.metadata ->> 'release_date'), ''),
                       validated_source_album.release_year::text
                     )),
                     true
                   )
              else validated_source_album.metadata
            end
    """
    if updates_release_year:
        renamed_album_metadata_sql = """
              , metadata = coalesce(library.local_albums.metadata, '{}'::jsonb)
                  || %(destination_artist_metadata)s::jsonb
                || jsonb_build_object(
                     'release_date',
                     %(destination_release_date)s::text
                   )
        """
        inserted_album_metadata_sql = """
            coalesce(validated_source_album.metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'release_date',
                   %(destination_release_date)s::text
                 )
        """
    return (
        """
        with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(%(changed_paths)s::text[]) as input_path
        ),
        input_rows as materialized (
          select incoming.private_path,
                 incoming.track_artist_key,
                 incoming.track_artist_name,
                 incoming.file_entry
          from jsonb_to_recordset(%(input_rows)s::jsonb)
            as incoming(
              private_path text,
              track_artist_key text,
              track_artist_name text,
              file_entry jsonb
            )
        ),
        selected_track_files as materialized (
          select
            library.local_track_files.id as track_file_id,
            library.local_tracks.id as track_id,
            library.local_tracks.album_id as source_album_id,
            input_rows.track_artist_key,
            input_rows.file_entry
          from bootstrap_context
          join library.local_track_files on true
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
          join input_track_paths
            on input_track_paths.private_path = library.local_track_files.private_path
          join input_rows
            on input_rows.private_path = library.local_track_files.private_path
          where coalesce(
            (
              library.local_track_files.metadata
                #>> '{scan_cache,stale}'
            )::boolean,
            false
          ) is false
          order by library.local_tracks.id, library.local_track_files.id
          for update of local_tracks, local_track_files
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.track_id) as resolved_track_count,
            count(distinct selected_track_files.source_album_id) as source_album_count,
            min(selected_track_files.source_album_id) as source_album_id
          from selected_track_files
        ),
        source_album_track_files as materialized (
          select library.local_track_files.id as track_file_id
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = selection_scope.source_album_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and coalesce(
                 (
                   library.local_track_files.metadata
                     #>> '{scan_cache,stale}'
                 )::boolean,
                 false
               ) is false
        ),
        source_album_identity as materialized (
          select
            library.local_albums.id,
            library.local_albums.artist_id,
            library.local_albums.release_year
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.id = selection_scope.source_album_id
        ),
        locked_album_scope as materialized (
          select
            library.local_albums.id,
            library.local_albums.library_id,
            library.local_albums.album_key,
            library.local_albums.artist_id,
            library.local_albums.title,
            library.local_albums.release_year,
            library.local_albums.cover_path,
            library.local_albums.metadata
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join source_album_identity on true
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and (
                 library.local_albums.id = selection_scope.source_album_id
                 or library.local_albums.album_key = %(destination_album_key)s
                 or (
                      library.local_albums.artist_id is not distinct from
                        source_album_identity.artist_id
                      and lower(btrim(library.local_albums.title)) =
                        lower(btrim(%(destination_album_title)s))
                      and library.local_albums.release_year is not distinct from
                        case
                          when %(updates_release_year)s::boolean
                          then %(destination_release_year)s
                          else source_album_identity.release_year
                        end
                      and lower(
                            btrim(
                              coalesce(
                                library.local_albums.metadata ->> 'edition',
                                ''
                              )
                            )
                          ) = lower(btrim(%(destination_edition)s))
                    )
               )
          order by library.local_albums.id
          for update of local_albums
        ),
        existing_destination_album as materialized (
          select
            locked_album_scope.id,
            locked_album_scope.album_key
          from locked_album_scope
          join selection_scope on true
          where locked_album_scope.id <> selection_scope.source_album_id
            and not (
                  %(destination_is_explicit_separate)s::boolean
                  and (select input_path_count from selection_scope) = (
                        select count(*) from source_album_track_files
                      )
                )
            and (
                  locked_album_scope.album_key = %(destination_album_key)s
                  or (
                       locked_album_scope.artist_id is not distinct from
                         (select artist_id from source_album_identity)
                       and lower(btrim(locked_album_scope.title)) =
                         lower(btrim(%(destination_album_title)s))
                       and locked_album_scope.release_year is not distinct from
                         case
                           when %(updates_release_year)s::boolean
                           then %(destination_release_year)s
                           else (
                             select release_year
                             from source_album_identity
                           )
                         end
                       and lower(
                             btrim(
                               coalesce(
                                 locked_album_scope.metadata ->> 'edition',
                                 ''
                               )
                             )
                           ) = lower(btrim(%(destination_edition)s))
                     )
                )
          order by
            case
              when locked_album_scope.album_key = %(destination_album_key)s
              then 0
              else 1
            end,
            locked_album_scope.id
          limit 1
        ),
        validated_source_album as materialized (
          select
            locked_album_scope.id,
            locked_album_scope.library_id,
            locked_album_scope.album_key,
            locked_album_scope.artist_id,
            locked_album_scope.release_year,
            locked_album_scope.cover_path,
            locked_album_scope.metadata,
            exists (
              select 1
              from source_album_track_files
              join library.local_track_files
                on library.local_track_files.id =
                   source_album_track_files.track_file_id
              where locked_album_scope.release_year is not null
                and library.local_track_files.metadata
                      #>> '{scan_cache,file_entry,year}' ~ '^[+-]?[0-9]+$'
                and (
                      library.local_track_files.metadata
                        #>> '{scan_cache,file_entry,year}'
                    )::bigint <> locked_album_scope.release_year
            ) as has_display_year_override
          from selection_scope
          join locked_album_scope
            on locked_album_scope.id = selection_scope.source_album_id
          where selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.source_album_count = 1
            and selection_scope.input_path_count <= (
                  select count(*) from source_album_track_files
                )
        ),
        retained_source_album as materialized (
          select id, album_key
          from validated_source_album
          where album_key = %(destination_album_key)s
            and not %(updates_release_year)s::boolean
            and (select input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
        ),
        marked_partial_source_album as (
          update library.local_albums
          set metadata = jsonb_set(
                coalesce(library.local_albums.metadata, '{}'::jsonb),
                '{release_date}',
                to_jsonb(coalesce(
                  nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                  validated_source_album.release_year::text
                )),
                true
              )
          from validated_source_album
          where library.local_albums.id = validated_source_album.id
            and validated_source_album.has_display_year_override
            and (select input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
          returning library.local_albums.id
        ),
        normalized_existing_destination_album as (
          update library.local_albums
          set release_year = case
                when not %(updates_release_year)s::boolean
                 and validated_source_album.has_display_year_override
                 and nullif(btrim(library.local_albums.metadata ->> 'release_date'), '') is null
                then validated_source_album.release_year
                else library.local_albums.release_year
              end,
              metadata = case
                when not %(updates_release_year)s::boolean
                 and validated_source_album.has_display_year_override
                then jsonb_set(
                       coalesce(library.local_albums.metadata, '{}'::jsonb),
                       '{release_date}',
                       to_jsonb(coalesce(
                         nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                         nullif(btrim(validated_source_album.metadata ->> 'release_date'), ''),
                         validated_source_album.release_year::text
                       )),
                       true
                     )
                else library.local_albums.metadata
              end,
              last_seen_at = now()
          from validated_source_album
          join existing_destination_album on true
          where library.local_albums.id = existing_destination_album.id
          returning library.local_albums.id, library.local_albums.album_key
        ),
        updated_album_ratings as (
          update app.album_ratings
          set album_key = case
                when %(destination_is_explicit_separate)s::boolean
                 and (select input_path_count from selection_scope) = (
                       select count(*) from source_album_track_files
                     )
                then validated_source_album.album_key
                else %(destination_album_key)s
              end,
              updated_at = now()
          from validated_source_album
          where app.album_ratings.library_id = validated_source_album.library_id
            and app.album_ratings.album_key = validated_source_album.album_key
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning app.album_ratings.id
        ),
        inserted_destination_artist as (
          insert into library.local_artists (
            library_id, artist_key, name, sort_name, metadata
          )
          select validated_source_album.library_id,
                 %(destination_artist_key)s, %(destination_artist_name)s,
                 lower(%(destination_artist_name)s),
                 jsonb_build_object('source', %(source)s::text)
          from validated_source_album
          on conflict (library_id, artist_key) do update
            set last_seen_at = now()
          returning library.local_artists.id, library.local_artists.artist_key
        ),
        inserted_track_artists as (
          insert into library.local_artists (
            library_id, artist_key, name, sort_name, metadata
          )
          select distinct
                 validated_source_album.library_id,
                 input_rows.track_artist_key,
                 input_rows.track_artist_name,
                 lower(input_rows.track_artist_name),
                 jsonb_build_object('source', %(source)s::text)
          from validated_source_album
          cross join input_rows
          where input_rows.track_artist_key <> %(destination_artist_key)s
          on conflict (library_id, artist_key) do update
            set last_seen_at = now()
          returning library.local_artists.id, library.local_artists.artist_key
        ),
        resolved_track_artists as materialized (
          select id, artist_key from inserted_destination_artist
          union all
          select id, artist_key from inserted_track_artists
        ),
        renamed_source_album as (
          update library.local_albums
          set artist_id = (select id from inserted_destination_artist),
              album_key = case
                when %(destination_is_explicit_separate)s::boolean
                then validated_source_album.album_key
                else %(destination_album_key)s
              end,
              title = %(destination_album_title)s,
              release_year = case
                when %(updates_release_year)s::boolean
                then %(destination_release_year)s
                else library.local_albums.release_year
              end
        """
        + renamed_album_metadata_sql
        + """,
              last_seen_at = now()
          from validated_source_album
          where library.local_albums.id = validated_source_album.id
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        updated_renamed_album_owner as (
          update library.local_album_featured_artists
          set artist_id = (select id from inserted_destination_artist),
              last_seen_at = now()
          from renamed_source_album
          join validated_source_album
            on validated_source_album.id = renamed_source_album.id
          where library.local_album_featured_artists.album_id =
                renamed_source_album.id
            and library.local_album_featured_artists.featured_kind = 'owner'
            and library.local_album_featured_artists.artist_id =
                validated_source_album.artist_id
            and exists (select 1 from inserted_destination_artist)
          returning library.local_album_featured_artists.id
        ),
        inserted_destination_album as (
          insert into library.local_albums (
            library_id,
            artist_id,
            album_key,
            title,
            release_year,
            cover_path,
            metadata
          )
          select
            validated_source_album.library_id,
            (select id from inserted_destination_artist),
            %(destination_album_key)s,
            %(destination_album_title)s,
            case
              when %(updates_release_year)s::boolean
              then %(destination_release_year)s
              else validated_source_album.release_year
            end,
            validated_source_album.cover_path,
        """
        + "(" + inserted_album_metadata_sql + ") || %(destination_artist_metadata)s::jsonb"
        + """
          from validated_source_album
          where (select input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
            and not exists (select 1 from retained_source_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        destination_album as materialized (
          select
            normalized_existing_destination_album.id,
            normalized_existing_destination_album.album_key
          from normalized_existing_destination_album
          where exists (select 1 from validated_source_album)
          union all
          select
            renamed_source_album.id,
            renamed_source_album.album_key
          from renamed_source_album
          union all
          select
            inserted_destination_album.id,
            inserted_destination_album.album_key
          from inserted_destination_album
          union all
          select retained_source_album.id, retained_source_album.album_key
          from retained_source_album
        ),
        inserted_separate_release as (
          insert into library.separate_releases (
            library_id,
            release_key,
            metadata
          )
          select
            bootstrap_context.library_id,
            %(destination_separate_release_key)s::text,
            jsonb_build_object('source', %(source)s::text)
          from bootstrap_context
          where %(updates_release_year)s::boolean
            and exists (select 1 from destination_album)
          on conflict (library_id, release_key) do nothing
          returning library.separate_releases.release_key
        ),
        copied_album_ratings as (
          insert into app.album_ratings (
            account_id,
            library_id,
            album_key,
            rating,
            provenance,
            metadata
          )
          select
            app.album_ratings.account_id,
            app.album_ratings.library_id,
            destination_album.album_key,
            app.album_ratings.rating,
            app.album_ratings.provenance,
            app.album_ratings.metadata
          from app.album_ratings
          join validated_source_album
            on validated_source_album.library_id = app.album_ratings.library_id
           and validated_source_album.album_key = app.album_ratings.album_key
          cross join destination_album
          where exists (select 1 from inserted_destination_album)
             or (
                  exists (select 1 from existing_destination_album)
                  and (select input_path_count from selection_scope) = (
                        select count(*) from source_album_track_files
                      )
                )
          on conflict (account_id, library_id, album_key) do nothing
          returning app.album_ratings.id
        ),
        copied_featured_artists as (
          insert into library.local_album_featured_artists (
            library_id,
            album_id,
            artist_id,
            featured_kind,
            metadata
          )
          select
            library.local_album_featured_artists.library_id,
            destination_album.id,
            library.local_album_featured_artists.artist_id,
            library.local_album_featured_artists.featured_kind,
            library.local_album_featured_artists.metadata
          from library.local_album_featured_artists
          join validated_source_album
            on validated_source_album.id =
               library.local_album_featured_artists.album_id
          cross join destination_album
          where not exists (select 1 from inserted_destination_album)
             or library.local_album_featured_artists.metadata ->> 'source'
                  is distinct from %(source)s
          on conflict (library_id, album_id, artist_id, featured_kind) do nothing
          returning library.local_album_featured_artists.id
        ),
        updated_album_mbid_assertions as (
          update library.local_mbid_assertions
          set album_id = destination_album.id
          from validated_source_album
          cross join destination_album
          where library.local_mbid_assertions.album_id = validated_source_album.id
            and exists (select 1 from existing_destination_album)
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
          returning library.local_mbid_assertions.id
        ),
        updated_tracks as (
          update library.local_tracks
          set album_id = (select destination_album.id from destination_album),
              artist_id = case when selected_track_files.file_entry ? 'artist' or selected_track_files.file_entry ? 'album_artist' then (
                select resolved_track_artists.id
                from resolved_track_artists
                where resolved_track_artists.artist_key =
                      selected_track_files.track_artist_key
              ) else library.local_tracks.artist_id end,
              title = case when selected_track_files.file_entry ? 'title'
                then selected_track_files.file_entry ->> 'title' else library.local_tracks.title end,
              track_number = case when selected_track_files.file_entry ? 'track_number'
                then nullif(selected_track_files.file_entry ->> 'track_number', '')::integer
                else library.local_tracks.track_number end,
              disc_number = case when selected_track_files.file_entry ? 'disc_number'
                then nullif(selected_track_files.file_entry ->> 'disc_number', '')::integer
                else library.local_tracks.disc_number end,
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || case when selected_track_files.file_entry ? 'album'
                     then jsonb_build_object('album', selected_track_files.file_entry -> 'album')
                     else '{}'::jsonb end
                || (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                    from jsonb_each(selected_track_files.file_entry)
                 where key = any(array['artist', 'artists', 'album_artist', 'title', 'genre', 'year',
                      'edition', 'track_number', 'disc_number', 'total_discs', 'disc_subtitle',
                      'album_type', 'album_rating'])),
              last_seen_at = now()
          from selected_track_files
          where library.local_tracks.id = selected_track_files.track_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
          returning library.local_tracks.id
        ),
        updated_track_files as (
          update library.local_track_files
          set private_path = coalesce(
                nullif(selected_track_files.file_entry ->> 'path', ''),
                library.local_track_files.private_path
              ),
              metadata = jsonb_set(
                coalesce(library.local_track_files.metadata, '{}'::jsonb),
                '{scan_cache}',
                coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'source', %(source)s::text,
                       'stale', false,
                       'file_entry',
                       coalesce(
                         library.local_track_files.metadata #> '{scan_cache,file_entry}',
                         '{}'::jsonb
                       ) || selected_track_files.file_entry
                     ),
                true
              ),
              last_seen_at = now()
          from selected_track_files
          where library.local_track_files.id = selected_track_files.track_file_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
          returning library.local_track_files.id
        ),
        vacated_source_album as materialized (
          select validated_source_album.id
          from validated_source_album
          where exists (select 1 from existing_destination_album)
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and (select count(*) from updated_tracks) =
                (select resolved_track_count from selection_scope)
            and (select count(*) from updated_track_files) =
                (select input_path_count from selection_scope)
        ),
        updated_library as (
          update library.libraries
          set metadata = jsonb_set(
                coalesce(library.libraries.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'inventory_mutation_revision',
                       coalesce(
                         nullif(
                           library.libraries.metadata ->> 'inventory_mutation_revision',
                           ''
                         )::bigint,
                         0
                       ) + 1
                     ),
                '{scan_cache}',
                coalesce(library.libraries.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'relation_projection',
                       coalesce(
                         library.libraries.metadata #> '{scan_cache,relation_projection}',
                         '{}'::jsonb
                       ) || jsonb_build_object(
                         'status', 'stale',
                         'rebuild_reason', 'structural_tag_edit'
                       )
                     ),
                true
              ),
              updated_at = now()
          from bootstrap_context
          where library.libraries.id = bootstrap_context.library_id
            and (select count(*) from updated_track_files) =
                (select input_path_count from selection_scope)
            and (select count(*) from updated_tracks) =
                (select resolved_track_count from selection_scope)
            and (select count(*) from destination_album) = 1
            and (
                  not exists (select 1 from existing_destination_album)
                  or (select input_path_count from selection_scope) < (
                       select count(*) from source_album_track_files
                     )
                  or (select count(*) from vacated_source_album) = 1
                )
          returning coalesce(
            nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
            0
          ) as inventory_mutation_revision
        )
        select
          (select input_path_count from selection_scope) as input_path_count,
          (select resolved_path_count from selection_scope) as resolved_path_count,
          (select resolved_track_count from selection_scope) as resolved_track_count,
          (select source_album_count from selection_scope) as source_album_count,
          (select count(*) from source_album_track_files) as source_album_track_file_count,
          0 as destination_conflict_count,
          (select count(*) from destination_album) as destination_album_count,
          (select id from validated_source_album) as source_album_id,
          (select album_key from validated_source_album) as source_album_key,
          (select id from destination_album) as destination_album_id,
          exists (select 1 from inserted_destination_album) as inserted_destination_album,
          (select count(*) from destination_album) as album_rows_updated,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          coalesce(
            (select inventory_mutation_revision from updated_library),
            0
          ) as inventory_mutation_revision,
          case
            when %(updates_release_year)s::boolean
             and exists (select 1 from destination_album)
            then %(destination_separate_release_key)s::text
            else null
          end as separate_release_key;
        """
    )


def _validate_blank_album_tag_edit_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(%(changed_paths)s::text[]) as input_path
        ),
        selected_track_files as materialized (
          select library.local_tracks.album_id
          from bootstrap_context
          join input_track_paths on true
          join library.local_track_files
            on library.local_track_files.private_path = input_track_paths.private_path
           and library.local_track_files.scan_cache_stale is false
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.album_id) as source_album_count,
            min(selected_track_files.album_id) as source_album_id
          from selected_track_files
        ),
        source_album_track_files as materialized (
          select library.local_track_files.id
          from bootstrap_context
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = (select source_album_id from selection_scope)
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and library.local_track_files.scan_cache_stale is false
        )
        select
          (select input_path_count from selection_scope) as input_path_count,
          (select resolved_path_count from selection_scope) as resolved_path_count,
          (select source_album_count from selection_scope) as source_album_count,
          (select count(*) from source_album_track_files) as source_album_track_file_count;
    """


def _validate_structural_album_tag_edit_sql() -> str:
    return """
        with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(%(changed_paths)s::text[]) as input_path
        ),
        selected_track_files as materialized (
          select
            library.local_track_files.id as track_file_id,
            library.local_tracks.album_id as source_album_id
          from bootstrap_context
          join library.local_track_files on true
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
          join input_track_paths
            on input_track_paths.private_path = library.local_track_files.private_path
          where coalesce(
            (library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean,
            false
          ) is false
          order by library.local_tracks.id, library.local_track_files.id
          for update of local_tracks, local_track_files
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct source_album_id) as source_album_count,
            min(source_album_id) as source_album_id
          from selected_track_files
        ),
        source_album_track_files as materialized (
          select library.local_track_files.id
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = selection_scope.source_album_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and coalesce(
                 (library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean,
                 false
               ) is false
        ),
        locked_album_scope as materialized (
          select library.local_albums.id, library.local_albums.album_key
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and (
                 library.local_albums.id = selection_scope.source_album_id
                 or library.local_albums.album_key = %(destination_album_key)s
               )
          order by library.local_albums.id
          for update of local_albums
        ),
        existing_destination_album as materialized (
          select locked_album_scope.id
          from locked_album_scope
          join selection_scope on true
          where locked_album_scope.album_key = %(destination_album_key)s
            and locked_album_scope.id <> selection_scope.source_album_id
        )
        select
          (select input_path_count from selection_scope) as input_path_count,
          (select resolved_path_count from selection_scope) as resolved_path_count,
          (select source_album_count from selection_scope) as source_album_count,
          (select count(*) from source_album_track_files)
            as source_album_track_file_count,
          0 as destination_conflict_count;
    """


def _load_scan_snapshot_sql(*, metadata_only: bool = False) -> str:
    projection = (
        "library.libraries.metadata -> 'scan_cache' ->> 'last_scan' as last_scan, "
        "library.libraries.metadata -> 'scan_cache' ->> 'library_root_identity' as library_root_identity"
        if metadata_only else "(library.libraries.metadata -> 'scan_cache') || jsonb_build_object('relation_views', library.local_relation_views(library.libraries.id)) as scan_cache"
    )
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        select {projection}
        from library.libraries
        join bootstrap_context on bootstrap_context.library_id = library.libraries.id
        limit 1;
    """


def _persist_local_cover_selection_sql(
    *,
    include_origin: bool = False,
    include_linked_remote: bool = False,
    include_expected_cover_state: bool = False,
    include_clear_selection: bool = False,
    include_explicit_selection: bool = False,
    include_reject_explicit_selection: bool = False,
    include_local_dimensions: bool = False,
) -> str:
    album_origin_json = (
        ", 'cover_selection_origin', %(cover_selection_origin)s::text"
        if include_origin
        else ""
    )
    if include_explicit_selection:
        album_origin_json += ", 'cover_selection_provenance', 'explicit'"
    local_dimensions_json = (
        ", 'local_cover_width', %(local_cover_width)s::integer, 'local_cover_height', %(local_cover_height)s::integer"
        if include_local_dimensions else ""
    )
    user_origin_guard = (
        """
            and (
              not %(reject_if_user_controlled)s::boolean
              or coalesce(
                library.local_albums.metadata ->> 'cover_selection_origin',
                ''
              ) <> 'user'
            )
        """
        if include_origin
        else ""
    )
    blocked_selection = (
        """
          (
            %(reject_if_user_controlled)s::boolean
            and exists (select 1 from target_album)
            and not exists (select 1 from updated_albums)
          )
        """
        if include_origin
        else "false"
    )
    expected_cover_state_guard = (
        """
            and coalesce(
              library.local_albums.metadata ->> 'cover_selection_origin',
              ''
            ) = %(expected_cover_selection_origin)s::text
            and coalesce(
              library.local_albums.metadata ->> 'cover_revision',
              ''
            ) = %(expected_cover_revision)s::text
        """
        if include_expected_cover_state
        else ""
    )
    if include_reject_explicit_selection:
        expected_cover_state_guard += " and coalesce(library.local_albums.metadata ->> 'cover_selection_provenance', '') <> 'explicit' "
    blocked_expected_cover_state = (
        """
          (
            exists (select 1 from target_album)
            and not exists (select 1 from updated_albums)
          )
        """
        if include_expected_cover_state
        else "false"
    )
    linked_remote_json = (
        """,
                'remote_cover_url', %(remote_cover_url)s::text,
                'remote_cover_thumbnail_url', %(remote_cover_thumbnail_url)s::text,
                'remote_cover_source', %(remote_cover_source)s::text,
                'remote_cover_source_label', %(remote_cover_source_label)s::text,
                'remote_cover_album_url', %(remote_cover_album_url)s::text,
                'remote_cover_width', %(remote_cover_width)s::integer,
                'remote_cover_height', %(remote_cover_height)s::integer
        """
        if include_linked_remote
        else ""
    )
    album_metadata = (
        """
              coalesce(library.local_albums.metadata, '{}'::jsonb)
              - array[
                'cover_path',
                'cover_revision',
                'cover_selection_origin',
                'cover_selection_provenance',
                'cover_selection_repair_previous',
                'remote_cover_url',
                'remote_cover_thumbnail_url',
                'remote_cover_source',
                'remote_cover_source_label',
                'remote_cover_album_url',
                'remote_cover_width',
                'remote_cover_height'
              ]::text[]
        """
        if include_clear_selection
        else """
              (
                coalesce(library.local_albums.metadata, '{}'::jsonb)
                - array[
                  'remote_cover_url',
                  'remote_cover_thumbnail_url',
                  'remote_cover_source',
                  'remote_cover_source_label',
                  'remote_cover_album_url',
                  'remote_cover_width',
                  'remote_cover_height'
                ]::text[]
              )
                || jsonb_build_object(
                  'cover_path', %(selected_cover_path)s::text,
                  'cover_revision', %(cover_revision)s::text
                  __ALBUM_ORIGIN_JSON__
                  __LINKED_REMOTE_JSON__
                )
        """
    )
    file_entry_metadata = (
        """
                  coalesce(
                    library.local_track_files.metadata #> '{scan_cache,file_entry}',
                    '{}'::jsonb
                  )
                  - array[
                    'cover_path',
                    'cover_revision',
                    'remote_cover_url',
                    'remote_cover_thumbnail_url',
                    'remote_cover_source',
                    'remote_cover_source_label',
                    'remote_cover_album_url',
                    'remote_cover_width',
                    'remote_cover_height'
                  ]::text[]
        """
        if include_clear_selection
        else """
                  (
                    coalesce(
                      library.local_track_files.metadata #> '{scan_cache,file_entry}',
                      '{}'::jsonb
                    )
                    - array[
                      'remote_cover_url',
                      'remote_cover_thumbnail_url',
                      'remote_cover_source',
                      'remote_cover_source_label',
                      'remote_cover_album_url',
                      'remote_cover_width',
                      'remote_cover_height'
                    ]::text[]
                  ) || jsonb_build_object(
                    'cover_path', %(selected_cover_path)s::text,
                    'cover_revision', %(cover_revision)s::text
                    __LINKED_REMOTE_JSON__
                  )
        """
    )
    sql = """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(%(track_paths)s::text[]) as input_path
        ),
        selected_track_files as materialized (
          select
            library.local_track_files.id as track_file_id,
            library.local_tracks.album_id
          from bootstrap_context
          join library.local_track_files
            on true
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
          join input_track_paths
            on input_track_paths.private_path = library.local_track_files.private_path
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.album_id) as selected_album_count,
            min(selected_track_files.album_id) as album_id
          from selected_track_files
        ),
        target_album as materialized (
          select selection_scope.album_id
          from selection_scope
          where selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.selected_album_count = 1
        ),
        album_track_files as materialized (
          select library.local_track_files.id as track_file_id
          from bootstrap_context
          join target_album on true
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = target_album.album_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
        ),
        updated_albums as (
          update library.local_albums
          set
            cover_path = %(selected_cover_path)s,
            metadata = __ALBUM_METADATA__
          from bootstrap_context
          where library.local_albums.library_id = bootstrap_context.library_id
            and library.local_albums.id = (select album_id from target_album)
            __USER_ORIGIN_GUARD__
            __EXPECTED_COVER_STATE_GUARD__
          returning library.local_albums.id
        ),
        updated_track_files as (
          update library.local_track_files
          set metadata = jsonb_set(
            coalesce(library.local_track_files.metadata, '{}'::jsonb),
            '{scan_cache}',
            coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
              || jsonb_build_object(
                'file_entry',
                __FILE_ENTRY_METADATA__
              ),
            true
          )
          from album_track_files
          where library.local_track_files.id = album_track_files.track_file_id
            and exists (select 1 from updated_albums)
          returning library.local_track_files.id
        )
        select
          (select input_path_count from selection_scope) as input_path_count,
          (select resolved_path_count from selection_scope) as resolved_path_count,
          (select selected_album_count from selection_scope) as selected_album_count,
          (select count(*) from album_track_files) as album_track_file_count,
          (select count(*) from updated_albums) as album_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          __BLOCKED_SELECTION__ as blocked_by_user_selection,
          __BLOCKED_EXPECTED_COVER_STATE__ as blocked_by_expected_cover_state;
    """
    return (
        sql.replace("__ALBUM_METADATA__", album_metadata)
        .replace("__FILE_ENTRY_METADATA__", file_entry_metadata)
        .replace("__ALBUM_ORIGIN_JSON__", album_origin_json)
        .replace("__LINKED_REMOTE_JSON__", local_dimensions_json + linked_remote_json)
        .replace("__USER_ORIGIN_GUARD__", user_origin_guard)
        .replace("__EXPECTED_COVER_STATE_GUARD__", expected_cover_state_guard)
        .replace("__BLOCKED_SELECTION__", blocked_selection)
        .replace("__BLOCKED_EXPECTED_COVER_STATE__", blocked_expected_cover_state)
    )


def _bootstrap_context_ready_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        select 1 as bootstrap_context_ready
        from bootstrap_context;
    """


def _load_separate_release_keys(connection: Any) -> set[str]:
    rows = connection.execute(_load_separate_release_keys_sql()).fetchall()
    release_keys: set[str] = set()
    for row in rows:
        release_key = str(
            _row_mapping(row).get("release_key") or ""
        ).strip()
        if release_key:
            release_keys.add(release_key)
    return release_keys


def _load_separate_release_keys_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        select library.separate_releases.release_key
        from library.separate_releases
        join bootstrap_context
          on bootstrap_context.library_id = library.separate_releases.library_id
        order by library.separate_releases.release_key;
    """


def _load_targeted_album_memberships_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        select
            library.local_track_files.private_path,
            library.local_tracks.album_id,
            library.local_albums.album_key,
          library.local_albums.title as album_title,
          library.local_albums.release_year,
        library.local_albums.metadata ->> 'release_date' as release_date,
          library.local_albums.metadata ->> 'edition' as edition,
            library.local_track_files.scan_file_album_artist as album_artist,
          library.local_artists.artist_key
        from bootstrap_context
        join library.local_track_files
          on library.local_track_files.private_path = any(%(active_paths)s::text[])
         and library.local_track_files.scan_cache_stale is false
        join library.local_tracks
          on library.local_tracks.id = library.local_track_files.track_id
         and library.local_tracks.library_id = bootstrap_context.library_id
        left join library.local_albums
          on library.local_albums.id = library.local_tracks.album_id
         and library.local_albums.library_id = bootstrap_context.library_id
        left join library.local_artists
          on library.local_artists.id = library.local_albums.artist_id
         and library.local_artists.library_id = bootstrap_context.library_id;
    """


def _synchronize_album_cover_file_entries_sql(
    *, by_album_ids: bool = False,
) -> str:
    selection_fields = ", ".join(
        f"'{field}', album.metadata -> '{field}'"
        for field in ("cover_revision", *_ALBUM_COVER_AUTHORITY_FIELDS)
    )
    structural_cover_field = (
        ", 'cover_inherited_from_structural_edit', "
        "%(cover_inherited_from_structural_edit)s::boolean"
        if by_album_ids
        else ""
    )
    album_filter = (
        """(
          album.id = any(%(album_ids)s::bigint[])
          or exists (
            select 1
            from library.local_tracks as selected_tracks
            join library.local_track_files as selected_files
              on selected_files.track_id = selected_tracks.id
             and selected_files.scan_cache_stale is false
            where selected_tracks.album_id = album.id
              and selected_tracks.library_id = album.library_id
              and selected_files.private_path = any(%(active_paths)s::text[])
          )
        )"""
        if by_album_ids
        else "album.album_key = any(%(album_keys)s::text[])"
    )
    return f"""
        with repaired_albums as (
          select album.* from library.local_albums album
          join library.libraries lib on lib.id = album.library_id
          join app.bootstrap_owners owner on owner.account_id = lib.owner_account_id
          where owner.owner_key = 'local-bootstrap-owner' and lib.library_kind = 'local'
            and {album_filter}
        )
        update library.local_track_files files
        set metadata = jsonb_set(files.metadata, '{{scan_cache,file_entry}}',
          (files.metadata #> '{{scan_cache,file_entry}}') || jsonb_build_object(
            'album_id', album.id, 'cover_path', album.cover_path,
            {selection_fields}{structural_cover_field}
          ), true)
        from library.local_tracks tracks
        join repaired_albums album on album.id = tracks.album_id and album.library_id = tracks.library_id
        join library.library_roots roots on roots.library_id = tracks.library_id and roots.is_active is true
        where files.track_id = tracks.id and files.library_root_id = roots.id
          and files.scan_cache_stale is false and files.scan_file_entry_is_object is true
          and coalesce(files.metadata #>> '{{scan_cache,file_entry,local_album_membership_problem}}', '') = ''
          and coalesce(files.metadata #>> '{{scan_cache,file_entry,exception_type}}', '') = ''
        returning files.private_path, files.metadata #> '{{scan_cache,file_entry}}' as file_entry
    """


def _load_cover_selections_sql() -> str:
    return """
        select album.id as album_id, album.cover_path,
               album.metadata ->> 'cover_selection_origin' as cover_selection_origin,
               album.metadata ->> 'cover_selection_provenance' as cover_selection_provenance,
               album.metadata ->> 'cover_revision' as cover_revision,
               album.metadata ->> 'remote_cover_url' as remote_cover_url,
               (album.metadata ->> 'remote_cover_width')::integer as remote_cover_width,
               (album.metadata ->> 'remote_cover_height')::integer as remote_cover_height
        from library.local_albums album
        join library.libraries lib on lib.id = album.library_id
        join app.bootstrap_owners owner on owner.account_id = lib.owner_account_id
        where owner.owner_key = 'local-bootstrap-owner'
          and lib.name = 'Local Library' and lib.library_kind = 'local'
          and album.id = any(%(album_ids)s::bigint[])
          and exists (
            select 1 from library.local_tracks track
            join library.local_track_files file on file.track_id = track.id
            join library.library_roots root on root.id = file.library_root_id
              and root.library_id = album.library_id and root.is_active is true
            where track.album_id = album.id and track.library_id = album.library_id
              and file.scan_cache_stale is false
              and file.metadata #>> '{scan_cache,source}' = %(source)s
          );
    """


def _load_file_entries_sql(*, targeted_albums: bool = False) -> str:
    album_filter = "and library.local_albums.album_key = any(%(album_keys)s::text[])" if targeted_albums else ""
    album_metadata_selection = (
        "library.local_albums.metadata as album_metadata,"
        if targeted_albums
        else ""
    )
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        select
          library.local_track_files.private_path,
          library.local_albums.id as album_id,
          library.local_albums.album_key,
          album_owner.artist_key as album_owner_key,
          library.local_track_files.file_size_bytes,
          extract(epoch from library.local_track_files.modified_at) as modified_at_epoch,
          library.local_track_files.metadata #> '{scan_cache,file_entry}' as file_entry,
          coalesce(
            nullif(library.library_roots.metadata ->> 'root_id', ''),
            library.local_track_files.metadata ->> 'library_root_id'
          ) as library_root_id,
          coalesce(
            nullif(library.library_roots.metadata ->> 'category', ''),
            nullif(library.library_roots.root_kind, ''),
            library.local_track_files.metadata ->> 'library_root_category'
          ) as library_root_category,
          library.local_tracks.title as track_title,
          library.local_tracks.track_number,
          library.local_tracks.disc_number,
          library.local_tracks.duration_seconds,
          library.local_albums.title as album_title,
          library.local_albums.release_year,
          library.local_albums.cover_path,
          __TARGETED_ALBUM_METADATA_SELECTION__
          library.local_albums.metadata ->> 'album_artist' as album_artist,
          case
            when library.local_albums.metadata ? 'is_compilation'
            then lower(btrim(
              library.local_albums.metadata ->> 'is_compilation'
            )) in ('true', 't', 'yes', 'y', 'on', '1')
            else null
          end as album_is_compilation,
          library.local_albums.metadata ->> 'edition' as edition,
          library.local_albums.metadata ->> 'cover_selection_origin' as cover_selection_origin,
          library.local_albums.metadata ->> 'cover_selection_provenance' as cover_selection_provenance,
          track_artists.name as track_artist
        from library.local_track_files
        join library.local_tracks on library.local_tracks.id = library.local_track_files.track_id
        join bootstrap_context on bootstrap_context.library_id = library.local_tracks.library_id
        join library.library_roots
          on library.library_roots.id = library.local_track_files.library_root_id
         and library.library_roots.library_id = library.local_tracks.library_id
         and library.library_roots.is_active is true
        left join library.local_albums on library.local_albums.id = library.local_tracks.album_id
        left join library.local_artists album_owner on album_owner.id = library.local_albums.artist_id
        left join library.local_artists track_artists on track_artists.id = library.local_tracks.artist_id
        where library.local_track_files.metadata #>> '{scan_cache,source}' = %(source)s
          and coalesce((library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean, false) is false
          __TARGETED_ALBUM_FILTER__
        order by library.local_track_files.private_path;
    """.replace(
        "__TARGETED_ALBUM_FILTER__", album_filter
    ).replace(
        "__TARGETED_ALBUM_METADATA_SELECTION__", album_metadata_selection
    )


def _save_scan_snapshot_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        update library.libraries
           set metadata = library.libraries.metadata || jsonb_build_object('scan_cache', %(scan_cache)s::jsonb),
               updated_at = now()
        from bootstrap_context
        where library.libraries.id = bootstrap_context.library_id;
    """


def _upsert_local_artist_sql(*, preserve_existing_identity: bool = False) -> str:
    # A track edit ensures artist references exist; it does not rename or
    # normalize the shared artist record for every other album using it.
    identity_update = "" if preserve_existing_identity else "name = excluded.name, sort_name = excluded.sort_name,"
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into library.local_artists (library_id, artist_key, name, sort_name, metadata)
        select bootstrap_context.library_id, %(artist_key)s, %(name)s, %(sort_name)s, %(metadata)s::jsonb
        from bootstrap_context
        on conflict (library_id, artist_key) do update
          set {identity_update}
              last_seen_at = now(),
              metadata = library.local_artists.metadata || excluded.metadata;
    """


def _inherited_cover_repair_guard_sql(existing_album: str, incoming_metadata: str) -> str:
    return f"""coalesce((
        {incoming_metadata} -> 'cover_selection_repair_previous' is not null
        and coalesce({existing_album}.metadata ->> 'cover_selection_provenance', '') <> 'explicit'
        and {existing_album}.cover_path = {incoming_metadata} #>> '{{cover_selection_repair_previous,cover_path}}'
        and coalesce({existing_album}.metadata ->> 'cover_revision', '') = coalesce({incoming_metadata} #>> '{{cover_selection_repair_previous,cover_revision}}', '')
        and coalesce({existing_album}.metadata ->> 'cover_selection_origin', '') = coalesce({incoming_metadata} #>> '{{cover_selection_repair_previous,cover_selection_origin}}', '')
    ), false)"""


def _upsert_local_album_sql(
    *, preserve_existing_cover_authority: bool = True
) -> str:
    inherited_repair_guard = _inherited_cover_repair_guard_sql("library.local_albums", "excluded.metadata")
    cover_path_update = (
        f"""case
                when library.local_albums.metadata ->> 'cover_selection_origin' = 'user' and not {inherited_repair_guard}
                then library.local_albums.cover_path
                else excluded.cover_path
              end"""
        if preserve_existing_cover_authority
        else "excluded.cover_path"
    )
    metadata_update = (
        f"""library.local_albums.metadata || case
                when library.local_albums.metadata ->> 'cover_selection_origin' = 'user' and not {inherited_repair_guard}
                then excluded.metadata - array[{', '.join(repr(field) for field in _ALBUM_COVER_METADATA_FIELDS)}]
                else excluded.metadata
              end"""
        if preserve_existing_cover_authority
        else "library.local_albums.metadata || excluded.metadata"
    )
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        artist_match as (
          select library.local_artists.id
          from library.local_artists
          join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
          where library.local_artists.artist_key = %(artist_key)s
          limit 1
        )
        insert into library.local_albums (
          library_id, artist_id, album_key, title, release_year, cover_path, metadata
        )
        select
          bootstrap_context.library_id,
          (select id from artist_match),
          %(album_key)s,
          %(title)s,
          %(release_year)s,
          %(cover_path)s,
          %(metadata)s::jsonb
        from bootstrap_context
        on conflict (library_id, album_key) do update
          set artist_id = excluded.artist_id,
              title = excluded.title,
              release_year = case
                when nullif(library.local_albums.metadata ->> 'release_date', '') is not null
                then library.local_albums.release_year
                else excluded.release_year
              end,
              cover_path = {cover_path_update},
              last_seen_at = now(),
              metadata = {metadata_update};
    """


def _update_targeted_album_aggregate_sql() -> str:
    inherited_repair_guard = _inherited_cover_repair_guard_sql("album", "(%(cover_metadata)s::jsonb)")
    return f"""
        update library.local_albums as album
        set release_year = case
              when nullif(album.metadata ->> 'release_date', '') is not null
              then album.release_year else %(release_year)s end,
            cover_path = case
              when album.metadata ->> 'cover_selection_origin' = 'user' and not {inherited_repair_guard}
              then album.cover_path else %(cover_path)s end,
            metadata = album.metadata || %(metadata)s || case
              when album.metadata ->> 'cover_selection_origin' = 'user' and not {inherited_repair_guard}
              then '{{}}'::jsonb else %(cover_metadata)s::jsonb end
        from library.libraries as owned_library, app.bootstrap_owners as owner
        where album.library_id = owned_library.id
          and owned_library.owner_account_id = owner.account_id
          and owned_library.name = 'Local Library'
          and owned_library.library_kind = 'local'
          and owner.owner_key = 'local-bootstrap-owner'
          and album.album_key = %(album_key)s;
    """


def _load_targeted_subtree_track_paths_sql() -> str:
    return """
        select distinct file.private_path
        from library.local_track_files as file
        join library.local_tracks as track on track.id = file.track_id
        join library.library_roots as root
          on root.id = file.library_root_id and root.library_id = track.library_id
        join library.libraries as owned_library on owned_library.id = track.library_id
        join app.bootstrap_owners as owner on owner.account_id = owned_library.owner_account_id
        where owner.owner_key = 'local-bootstrap-owner'
          and owned_library.name = 'Local Library'
          and owned_library.library_kind = 'local'
          and file.metadata #>> '{scan_cache,source}' = %(source)s
          and exists (
            select 1
            from jsonb_to_recordset(%(subtrees)s::jsonb) as subtree(root_id text, path text)
            where subtree.root_id = coalesce(nullif(root.metadata ->> 'root_id', ''), file.metadata ->> 'library_root_id')
              and starts_with(
                replace(file.private_path, E'\\\\', '/'),
                rtrim(replace(subtree.path, E'\\\\', '/'), '/') || '/'
              )
          )
        order by file.private_path;
    """


def _upsert_local_album_featured_artist_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        album_match as (
          select library.local_albums.id
          from library.local_albums
          join bootstrap_context on bootstrap_context.library_id = library.local_albums.library_id
          where library.local_albums.album_key = %(album_key)s
          limit 1
        ),
        artist_match as (
          select library.local_artists.id
          from library.local_artists
          join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
          where library.local_artists.artist_key = %(artist_key)s
          limit 1
        )
        insert into library.local_album_featured_artists (
          library_id, album_id, artist_id, featured_kind, metadata
        )
        select
          bootstrap_context.library_id,
          (select id from album_match),
          (select id from artist_match),
          %(featured_kind)s,
          %(metadata)s::jsonb
        from bootstrap_context
        where exists (select 1 from album_match)
          and exists (select 1 from artist_match)
        on conflict (library_id, album_id, artist_id, featured_kind) do update
          set last_seen_at = now(),
              metadata = library.local_album_featured_artists.metadata
                         || (excluded.metadata - 'source');
    """


def _synchronize_local_album_featured_artists_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        current_featured_rows as (
          select
            library.local_albums.id as album_id,
            library.local_artists.id as artist_id,
            incoming.featured_kind
          from jsonb_to_recordset(%(current_featured_rows)s::jsonb)
            as incoming(album_key text, artist_key text, featured_kind text)
          join bootstrap_context on true
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.album_key = incoming.album_key
          join library.local_artists
            on library.local_artists.library_id = bootstrap_context.library_id
           and library.local_artists.artist_key = incoming.artist_key
        )
        delete from library.local_album_featured_artists
        using bootstrap_context
        where library.local_album_featured_artists.library_id = bootstrap_context.library_id
          and library.local_album_featured_artists.metadata ->> 'source'
              = any(%(synchronized_sources)s::text[])
          and not exists (
            select 1
            from current_featured_rows
            where current_featured_rows.album_id = library.local_album_featured_artists.album_id
              and current_featured_rows.artist_id = library.local_album_featured_artists.artist_id
              and current_featured_rows.featured_kind = library.local_album_featured_artists.featured_kind
          );
    """


def _upsert_local_track_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        input_rows as (
          select *
          from jsonb_to_recordset(%(rows)s::jsonb) as input_row (
            album_key text,
            artist_key text,
            track_key text,
            title text,
            disc_number integer,
            track_number integer,
            duration_seconds integer,
            metadata jsonb
          )
        )
        insert into library.local_tracks (
          library_id, album_id, artist_id, track_key, title, disc_number, track_number, duration_seconds, metadata
        )
        select
          bootstrap_context.library_id,
          library.local_albums.id,
          library.local_artists.id,
          input_rows.track_key,
          input_rows.title,
          input_rows.disc_number,
          input_rows.track_number,
          input_rows.duration_seconds,
          input_rows.metadata
        from bootstrap_context
        cross join input_rows
        left join library.local_albums
          on library.local_albums.library_id = bootstrap_context.library_id
         and library.local_albums.album_key = input_rows.album_key
        left join library.local_artists
          on library.local_artists.library_id = bootstrap_context.library_id
         and library.local_artists.artist_key = input_rows.artist_key
        on conflict (library_id, track_key) do update
          set album_id = excluded.album_id,
              artist_id = excluded.artist_id,
              title = excluded.title,
              disc_number = excluded.disc_number,
              track_number = excluded.track_number,
              duration_seconds = excluded.duration_seconds,
              last_seen_at = now(),
              metadata = library.local_tracks.metadata || excluded.metadata
          where (
            library.local_tracks.album_id,
            library.local_tracks.artist_id,
            library.local_tracks.title,
            library.local_tracks.disc_number,
            library.local_tracks.track_number,
            library.local_tracks.duration_seconds,
            library.local_tracks.metadata
          ) is distinct from (
            excluded.album_id,
            excluded.artist_id,
            excluded.title,
            excluded.disc_number,
            excluded.track_number,
            excluded.duration_seconds,
            library.local_tracks.metadata || excluded.metadata
          );
    """


def _upsert_local_track_file_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        input_rows as (
          select *
          from jsonb_to_recordset(%(rows)s::jsonb) as input_row (
            track_key text,
            private_path text,
            relative_path text,
            file_size_bytes bigint,
            modified_at_epoch double precision,
            metadata jsonb
          )
        )
        insert into library.local_track_files (
          track_id, library_root_id, private_path, relative_path, file_size_bytes, modified_at, metadata
        )
        select
          library.local_tracks.id,
          library.require_local_track_file_root_id(
            bootstrap_context.library_id,
            input_rows.private_path,
            input_rows.metadata
          ),
          input_rows.private_path,
          input_rows.relative_path,
          input_rows.file_size_bytes,
          to_timestamp(input_rows.modified_at_epoch),
          input_rows.metadata
        from bootstrap_context
        cross join input_rows
        join library.local_tracks
          on library.local_tracks.library_id = bootstrap_context.library_id
         and library.local_tracks.track_key = input_rows.track_key
        on conflict (private_path) do update
          set track_id = excluded.track_id,
              library_root_id = excluded.library_root_id,
              relative_path = excluded.relative_path,
              file_size_bytes = excluded.file_size_bytes,
              modified_at = excluded.modified_at,
              last_seen_at = now(),
              metadata = (
                library.local_track_files.metadata || excluded.metadata
              ) #- '{scan_cache,stale_marked_at}'
          where (
            library.local_track_files.track_id,
            library.local_track_files.library_root_id,
            library.local_track_files.relative_path,
            library.local_track_files.file_size_bytes,
            library.local_track_files.modified_at,
            library.local_track_files.metadata
          ) is distinct from (
            excluded.track_id,
            excluded.library_root_id,
            excluded.relative_path,
            excluded.file_size_bytes,
            excluded.modified_at,
            (library.local_track_files.metadata || excluded.metadata)
              #- '{scan_cache,stale_marked_at}'
          );
    """


def _mark_stale_track_files_sql() -> str:
    return """
        -- stale_marked_at is written only on the first active-to-stale transition.
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        update library.local_track_files
           set metadata = jsonb_set(
                 coalesce(library.local_track_files.metadata, '{}'::jsonb),
                 '{scan_cache}',
                 coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
                   || jsonb_build_object(
                   'source', %(source)s,
                   'stale', true,
                   'stale_marked_at', coalesce(
                     library.local_track_files.metadata
                       #>> '{scan_cache,stale_marked_at}',
                     now()::text
                   )
                 ),
                 true
               ),
               last_seen_at = now()
        from library.local_tracks
        join bootstrap_context on bootstrap_context.library_id = library.local_tracks.library_id
        join library.library_roots
          on library.library_roots.library_id = bootstrap_context.library_id
        where library.local_track_files.track_id = library.local_tracks.id
          and library.library_roots.id = library.local_track_files.library_root_id
          and coalesce(
            nullif(btrim(library.local_track_files.metadata #>> '{scan_cache,source}'), ''),
            %(source)s
          ) = %(source)s
          and library.local_track_files.scan_cache_stale is false
          and coalesce(
            nullif(library.library_roots.metadata ->> 'root_id', ''),
            library.local_track_files.metadata ->> 'library_root_id'
          ) = any(%(observed_root_ids)s::text[])
          and (
            %(current_path_count)s = 0
            or library.local_track_files.private_path <> all(%(current_paths)s::text[])
          );
    """


def _synchronize_targeted_local_album_featured_artists_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        affected_albums as (
          select library.local_albums.id as album_id
          from unnest(%(affected_album_keys)s::text[]) as affected(album_key)
          join bootstrap_context on true
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.album_key = affected.album_key
        ),
        current_featured_rows as (
          select library.local_albums.id as album_id,
                 library.local_artists.id as artist_id,
                 incoming.featured_kind
          from jsonb_to_recordset(%(current_featured_rows)s::jsonb)
            as incoming(album_key text, artist_key text, featured_kind text)
          join bootstrap_context on true
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.album_key = incoming.album_key
          join library.local_artists
            on library.local_artists.library_id = bootstrap_context.library_id
           and library.local_artists.artist_key = incoming.artist_key
        )
        delete from library.local_album_featured_artists
        using bootstrap_context, affected_albums
        where library.local_album_featured_artists.library_id = bootstrap_context.library_id
          and library.local_album_featured_artists.album_id = affected_albums.album_id
          and library.local_album_featured_artists.metadata ->> 'source'
              = any(%(synchronized_sources)s::text[])
          and not exists (
            select 1 from current_featured_rows
            where current_featured_rows.album_id = library.local_album_featured_artists.album_id
              and current_featured_rows.artist_id = library.local_album_featured_artists.artist_id
              and current_featured_rows.featured_kind = library.local_album_featured_artists.featured_kind
          );
    """


def _mark_targeted_track_files_stale_sql() -> str:
    return r"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        matched_files as (
          select library.local_track_files.id
          from library.local_track_files
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          join library.library_roots
            on library.library_roots.id = library.local_track_files.library_root_id
           and library.library_roots.library_id = bootstrap_context.library_id
          where coalesce(
                  nullif(library.library_roots.metadata ->> 'root_id', ''),
                  library.local_track_files.metadata ->> 'library_root_id'
                ) = %(root_id)s
            and library.local_track_files.metadata #>> '{scan_cache,source}' = %(source)s
            and library.local_track_files.scan_cache_stale is false
            and library.local_track_files.private_path
              <> all(%(active_paths)s::text[])
            and (
              library.local_track_files.private_path = any(%(deleted_paths)s::text[])
              or exists (
                select 1
                from unnest(%(deleted_subtrees)s::text[]) as deleted_subtree(path)
                where starts_with(
                  replace(library.local_track_files.private_path, E'\\', '/'),
                  rtrim(replace(deleted_subtree.path, E'\\', '/'), '/') || '/'
                )
              )
            )
        ),
        updated_files as (
          update library.local_track_files
             set metadata = jsonb_set(
                   coalesce(library.local_track_files.metadata, '{}'::jsonb),
                   '{scan_cache}',
                   coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
                     || jsonb_build_object(
                     'source', %(source)s,
                     'stale', true,
                     'stale_marked_at', coalesce(
                       library.local_track_files.metadata
                         #>> '{scan_cache,stale_marked_at}',
                       now()::text
                     )
                   ),
                   true
                 ),
                 last_seen_at = now()
          from matched_files
          where library.local_track_files.id = matched_files.id
          returning library.local_track_files.track_id
        )
        -- Loose tracks have no album, but removing them is still an inventory
        -- change: return one row per touched album, or a null key for loose tracks.
        select distinct library.local_albums.album_key as affected_album_key
        from updated_files
        join library.local_tracks
          on library.local_tracks.id = updated_files.track_id
        left join library.local_albums
          on library.local_albums.id = library.local_tracks.album_id;
    """
