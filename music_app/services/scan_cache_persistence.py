from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
import re
from time import perf_counter
from typing import Any, Protocol

from config import PERSISTENCE_BACKEND_POSTGRES
from music_app.services.album_ratings_postgres import PostgresAlbumRatingsService
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
    album_separate_release_key,
    build_albums_from_file_cache,
    safe_int,
)
from music_app.services.library_inventory_postgres import local_inventory_identity_key
from music_app.services.non_album_view_payloads import infer_blank_album_membership
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.relation_projection_postgres import (
    RELATION_PROJECTION_BUILDER_VERSION,
    RELATION_PROJECTION_METADATA_KEY,
    build_ready_relation_projection_metadata,
    build_relation_views_from_postgres_rows,
    load_relation_source_rows_sql,
    relation_projection_advisory_lock_sql,
    relation_projection_structure_complete,
    relation_source_fingerprint,
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
_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_SOURCE = "runtime_scan_cache"
_PIPELINE_BATCH_SIZE = 1_000
_MISSING_STRUCTURAL_VALUE = object()
_TARGETED_STRUCTURAL_EDIT_FIELD_SETS = {
    frozenset({"album"}),
    frozenset({"year"}),
}
_TARGETED_INVENTORY_EDIT_FIELDS = frozenset(
    {"title", "genre", "track_number", "disc_number"}
)
_OWNER_LED_FEATURE_RE = re.compile(
    r"^(?P<owner>.+?)(?:\s+(?:feat\.?|featuring|with|vs|x)\s+|\s*&\s*|/|;|,\s*)(?P<featured>.+)$",
    re.IGNORECASE,
)
_FEATURED_MEMBER_SPLIT_RE = re.compile(r"\s+(?:and|и)\s+|(?:\s*&\s*)|/|;|,")


class ScanCachePublicationSuperseded(RuntimeError):
    """Raised when a newer inventory mutation makes a prepared scan stale."""


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
    ) -> dict[str, object] | None:
        ...

    def load_cover_mutation_revision(self) -> int:
        ...

    def load_inventory_mutation_revision(self) -> int:
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
        reject_if_user_controlled: bool = False,
        clear_selection: bool = False,
        expected_cover_selection_origin: str | None = None,
        expected_cover_revision: str | None = None,
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

    def load_snapshot(self, cache_path: Path, root_identity: object) -> ScanCacheSnapshot:
        try:
            return self.load_snapshot_strict(cache_path, root_identity)
        except Exception as exc:
            return {}, 0.0, {}, 0.0, f"Could not read Postgres scan cache: {exc}"

    def load_cover_mutation_revision(self) -> int:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            return _load_cover_mutation_revision(connection)

    def load_inventory_mutation_revision(self) -> int:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            return _load_inventory_mutation_revision(connection)

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
            path = str(file_entry.get("path") or row_payload.get("private_path") or "").strip()
            if not path:
                continue
            try:
                hydrated_entry = deserialize_file_entry(file_entry)
            except Exception:
                hydrated_entry = dict(file_entry)
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
        reject_if_user_controlled: bool = False,
        clear_selection: bool = False,
        expected_cover_selection_origin: str | None = None,
        expected_cover_revision: str | None = None,
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
        if (normalized_expected_origin is None) != (normalized_expected_revision is None):
            raise ValueError(
                "Expected cover state requires both selection origin and cover revision."
            )
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
            expected_cover_state_guard = normalized_expected_origin is not None
            if not reject_if_user_controlled and not expected_cover_state_guard:
                connection.execute(_increment_cover_mutation_revision_sql())
            result_row = _first_row(
                connection.execute(
                    _persist_local_cover_selection_sql(
                        include_origin=normalized_origin is not None,
                        include_linked_remote=linked_remote,
                        include_expected_cover_state=expected_cover_state_guard,
                        include_clear_selection=clear_selection,
                    ),
                    {
                        "track_paths": normalized_track_paths,
                        "selected_cover_path": str(resolved_cover_path) if resolved_cover_path else None,
                        "cover_revision": str(cover_revision) if cover_revision else None,
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
    ) -> dict[str, object]:
        source_album_name = str(next(iter(previous_entries.values())).get("album") or "").strip()
        retained_memberships = {
            path: infer_blank_album_membership(
                updated_file_entries[path],
                updated_file_entries.values(),
            )
            for path in normalized_paths
        }
        retain_album_membership = bool(source_album_name) and all(
            str(inferred or "").casefold() == source_album_name.casefold()
            for inferred in retained_memberships.values()
        )
        input_rows = [
            {
                "private_path": path,
                "file_entry": {
                    **_structural_file_entry_delta(
                        previous_entries[path],
                        updated_file_entries[path],
                    ),
                    # The refreshed entry may omit an absent TALB frame. Persist
                    # the requested blank explicitly so the old cache value dies.
                    "album": "",
                },
            }
            for path in normalized_paths
        ]
        with self._connect_to_database() as connection:
            connection.execute(_inventory_publication_advisory_lock_sql())
            connection.execute(relation_projection_advisory_lock_sql())
            _ensure_bootstrap_context(connection)
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
                track_rows_updated != input_path_count
                or track_file_rows_updated != input_path_count
                or inventory_mutation_revision < 1
            ):
                raise RuntimeError("Targeted blank Album persistence did not update the selected inventory.")
            committed_relation_state = (
                _commit_structural_relation_projection(connection, self._config)
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
        input_rows = [
            {
                "private_path": path,
                "file_entry": _structural_file_entry_delta(
                    previous_entries[path],
                    updated_entries[path],
                ),
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
            for row in artist_rows:
                connection.execute(_upsert_local_artist_sql(), row)
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
                or track_rows_updated != input_path_count
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
            committed_relation_state = (
                _commit_structural_relation_projection(connection, self._config)
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
        normalized_paths = sorted(
            {str(path or "").strip() for path in changed_paths if str(path or "").strip()}
        )
        if not normalized_paths:
            raise ValueError("Structural tag persistence requires at least one changed path.")
        normalized_changed_fields = frozenset(changed_field_names)
        targeted_inventory_edit = bool(normalized_changed_fields) and (
            normalized_changed_fields <= _TARGETED_INVENTORY_EDIT_FIELDS
        )
        if (
            normalized_changed_fields not in _TARGETED_STRUCTURAL_EDIT_FIELD_SETS
            and not targeted_inventory_edit
        ):
            raise ValueError(
                "Targeted tag persistence requires an album-only or year-only "
                "edit, or a non-identity inventory edit."
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

        if targeted_inventory_edit:
            input_rows = [
                {
                    "private_path": path,
                    "file_entry": _structural_file_entry_delta(
                        previous_entries[path],
                        updated_entries[path],
                    ),
                }
                for path in normalized_paths
            ]
            with self._connect_to_database() as connection:
                connection.execute(_inventory_publication_advisory_lock_sql())
                _ensure_bootstrap_context(connection)
                result = _row_mapping(
                    _first_row(
                        connection.execute(
                            _persist_targeted_inventory_tag_edit_sql(),
                            {
                                "changed_paths": normalized_paths,
                                "input_rows": _jsonb(input_rows),
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
                    or track_rows_updated != input_path_count
                    or track_file_rows_updated != input_path_count
                    or inventory_mutation_revision < 1
                ):
                    raise RuntimeError(
                        "Targeted inventory tag persistence did not update every selected file."
                    )
                if before_commit is not None:
                    before_commit(connection)
                if commit_guard is not None:
                    commit_guard(connection.commit)

            return {
                "album_rows_updated": 0,
                "track_rows_updated": track_rows_updated,
                "track_file_rows_updated": track_file_rows_updated,
                "inventory_mutation_revision": inventory_mutation_revision,
            }

        previous_album_names = {
            str(entry.get("album") or "").strip()
            for entry in previous_entries.values()
        }
        destination_album_names = {
            str(entry.get("album") or "").strip()
            for entry in updated_entries.values()
        }
        if len(previous_album_names) != 1:
            raise RuntimeError("Structural tag persistence requires one source album.")
        if normalized_changed_fields == frozenset({"album"}) and destination_album_names == {""}:
            return self._persist_blank_album_tag_edit(
                normalized_paths=normalized_paths,
                previous_entries=previous_entries,
                updated_file_entries=updated_file_entries,
                commit_guard=commit_guard,
                before_commit=before_commit,
                rebuild_relation_projection=rebuild_relation_projection,
            )
        if (
            normalized_changed_fields == frozenset({"album"})
            and previous_album_names == {""}
            and len(destination_album_names) == 1
        ):
            return self._persist_detached_album_restore(
                normalized_paths=normalized_paths,
                previous_entries=previous_entries,
                updated_entries=updated_entries,
                commit_guard=commit_guard,
                before_commit=before_commit,
                rebuild_relation_projection=rebuild_relation_projection,
            )
        if len(destination_album_names) != 1 or not next(iter(destination_album_names), ""):
            raise RuntimeError("Structural tag persistence requires one destination album.")

        updates_release_year = normalized_changed_fields == frozenset({"year"})
        input_rows = [
            {
                "private_path": path,
                "file_entry": _structural_file_entry_delta(
                    previous_entries[path],
                    updated_entries[path],
                ),
            }
            for path in normalized_paths
        ]
        with self._connect_to_database() as connection:
            connection.execute(_inventory_publication_advisory_lock_sql())
            connection.execute(relation_projection_advisory_lock_sql())
            _ensure_bootstrap_context(connection)
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
            result_row = _first_row(
                connection.execute(
                    _persist_structural_album_tag_edit_sql(
                        updates_release_year=updates_release_year,
                    ),
                    {
                        "changed_paths": normalized_paths,
                        "input_rows": _jsonb(input_rows),
                        "destination_album_key": destination_album_key,
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
                or track_rows_updated != input_path_count
                or track_file_rows_updated != input_path_count
                or inventory_mutation_revision < 1
                or destination_album_id < 1
            ):
                raise RuntimeError(
                    "Targeted structural tag persistence did not update the complete album inventory."
                )
            _execute_semantic_local_album_reconciliation(
                connection,
                target_album_ids=(destination_album_id,),
            )
            committed_relation_state = (
                _commit_structural_relation_projection(connection, self._config)
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
            "track_rows_updated": track_rows_updated,
            "track_file_rows_updated": track_file_rows_updated,
            "inventory_mutation_revision": inventory_mutation_revision,
        }
        if committed_relation_state is not None:
            persistence_result.update(committed_relation_state)
        if persisted_separate_release_key:
            persistence_result["separate_release_key"] = (
                persisted_separate_release_key
            )
        return persistence_result

    def validate_structural_tag_edit(
        self,
        *,
        changed_paths: set[str],
        previous_file_entries: dict[str, dict[str, object]],
        updated_file_entries: dict[str, dict[str, object]],
        changed_field_names: set[str],
    ) -> None:
        normalized_paths = sorted(
            {str(path or "").strip() for path in changed_paths if str(path or "").strip()}
        )
        normalized_changed_fields = frozenset(changed_field_names)
        targeted_inventory_edit = bool(normalized_changed_fields) and (
            normalized_changed_fields <= _TARGETED_INVENTORY_EDIT_FIELDS
        )
        if (
            not normalized_paths
            or (
                normalized_changed_fields not in _TARGETED_STRUCTURAL_EDIT_FIELD_SETS
                and not targeted_inventory_edit
            )
        ):
            raise ValueError(
                "Targeted tag prevalidation requires an album-only or year-only "
                "edit, or a non-identity inventory edit."
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
        if targeted_inventory_edit:
            return
        destination_album_names = {
            str(entry.get("album") or "").strip()
            for entry in updated_entries.values()
        }
        previous_album_names = {
            str(entry.get("album") or "").strip()
            for entry in previous_entries.values()
        }
        uses_blank_album_persistence = (
            normalized_changed_fields == frozenset({"album"})
            and (
                destination_album_names == {""}
                or (
                    previous_album_names == {""}
                    and len(destination_album_names) == 1
                )
            )
        )
        if uses_blank_album_persistence:
            restores_blank_album = (
                previous_album_names == {""}
                and destination_album_names != {""}
            )
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
        if source_album_count != 1:
            raise RuntimeError(
                "Structural tag persistence requires one source album."
            )
        if source_album_track_file_count < input_path_count:
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
    ) -> dict[str, object] | None:
        publication_started_at = perf_counter()
        del cache_path
        committed_relation_state: dict[str, object] | None = None
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
                raise ScanCachePublicationSuperseded(
                    "Inventory changed through a structural tag edit while the scan snapshot was being prepared."
                )
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
                    "source": _SOURCE,
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
            connection.execute(
                _mark_stale_track_files_sql(),
                {
                    "current_paths": current_private_paths,
                    "current_path_count": len(current_private_paths),
                    "source": _SOURCE,
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
                replace_artist_family_projection_in_transaction(
                    connection,
                    relation_views_payload,
                    relations_last_built=_float_or_zero(
                        resolved_relations_last_built
                    ),
                )
                projection_metadata = build_ready_relation_projection_metadata(
                    source_fingerprint,
                    reason="queued_cache_update",
                    duration_ms=(perf_counter() - publication_started_at) * 1000,
                    source_row_count=len(relation_source_rows),
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
            connection.execute(_save_scan_snapshot_sql(), {"scan_cache": _jsonb(snapshot_payload)})
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
                    if before_commit is not None:
                        before_commit(connection)
                    connection.commit()

                album_rating_seed_guard(seed_and_commit_publication)
            elif publication_commit_guard is not None:
                if before_commit is not None:
                    before_commit(connection)
                publication_commit_guard(connection.commit)
            elif before_commit is not None:
                before_commit(connection)
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


def _jsonb(value: object) -> object:
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
        set album_key = adoptions.canonical_album_key
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


def _structural_file_entry_delta(
    previous_entry: dict[str, object],
    updated_entry: dict[str, object],
) -> dict[str, object]:
    """Return only request-owned changes; cover state is persisted separately."""
    delta: dict[str, object] = {}
    for key in set(previous_entry) | set(updated_entry):
        if key in _AUTHORITATIVE_COVER_FIELDS:
            continue
        if previous_entry.get(key, _MISSING_STRUCTURAL_VALUE) == updated_entry.get(
            key,
            _MISSING_STRUCTURAL_VALUE,
        ):
            continue
        if key in updated_entry:
            delta[str(key)] = _jsonb_compatible(updated_entry[key])
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
    destination_albums = build_albums(
        projection_entries,
        (
            set()
            if changed_field_names == frozenset({"year"})
            else active_separate_release_keys
        ),
    )
    if len(destination_albums) != 1:
        raise RuntimeError(
            "Structural tag persistence requires one destination album projection."
        )
    destination_album = destination_albums[0]
    if changed_field_names == frozenset({"year"}):
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


def _commit_structural_relation_projection(
    connection: Any,
    config: dict[str, object],
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
    relation_views = build_relation_views_from_postgres_rows(config, relation_source_rows)
    if not relation_projection_structure_complete(relation_views):
        raise RuntimeError("Relation projection builder returned an incomplete projection.")
    relations_last_built = datetime.now(timezone.utc).timestamp()
    relation_views_payload = serialize_relation_views(relation_views)
    replace_artist_family_projection_in_transaction(
        connection,
        relation_views_payload,
        relations_last_built=relations_last_built,
    )
    next_scan_cache["relation_views"] = relation_views_payload
    next_scan_cache["relations_last_built"] = relations_last_built
    next_scan_cache[RELATION_PROJECTION_METADATA_KEY] = build_ready_relation_projection_metadata(
        source_fingerprint,
        reason="structural_tag_edit",
        duration_ms=0.0,
        source_row_count=len(relation_source_rows),
    )
    connection.execute(_save_scan_snapshot_sql(), {"scan_cache": _jsonb(next_scan_cache)})
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
    fields = (
        "cover_selection_origin",
        "local_cover_width",
        "local_cover_height",
        "remote_cover_url",
        "remote_cover_thumbnail_url",
        "remote_cover_source",
        "remote_cover_source_label",
        "remote_cover_album_url",
        "remote_cover_width",
        "remote_cover_height",
    )
    return {
        field: value
        for field in fields
        if (value := getattr(album, field, None)) is not None
    }


def _inventory_rows_from_albums(
    file_cache: dict[str, dict[str, object]],
    albums: list[object],
) -> tuple[
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
]:
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

    for album in albums:
        album_artist_key = ensure_artist(getattr(album, "album_artist", None))
        member_artist_names = _deduped_artist_names(getattr(album, "artists", []) or [])
        if not member_artist_names:
            owner_name = _text_or_none(getattr(album, "album_artist", None))
            if owner_name is not None:
                member_artist_names = [owner_name]
        for member in member_artist_names:
            ensure_artist(member)
        album_key = str(getattr(album, "key", "") or "").strip()
        if not album_key:
            continue
        tag_album_rating = _raw_tag_album_rating_from_file_entries(
            album,
            file_entries_by_path,
        )
        track_artist_names: list[str] = []
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
                        "album_artist": getattr(album, "album_artist", None),
                        "artists": member_artist_names,
                        "is_compilation": bool(
                            getattr(album, "is_compilation", False)
                        ),
                        "featured_artists": [],
                        "edition": getattr(album, "edition", None),
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
        owner_name = _text_or_none(getattr(album, "album_artist", None))
        owner_key = _key(owner_name) if owner_name is not None else None
        for member_name in member_artist_names:
            member_key = ensure_artist(member_name)
            featured_kind = "owner" if member_key == owner_key else "featured_member"
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
            track_artist_key = ensure_artist(track_artist_name)
            attached_track_artist_names = _attached_track_artist_names(
                track_artist_name,
                owner_name,
            )
            track_artist_names.extend(attached_track_artist_names)
            for attached_artist_name in attached_track_artist_names:
                attached_artist_key = ensure_artist(attached_artist_name)
                _append_featured_artist_row(
                    featured_artist_rows,
                    seen_featured_rows,
                    album_key=album_key,
                    artist_key=attached_artist_key,
                    featured_kind="featured_track_artist",
                    source=_SOURCE,
                )
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
                "album_artist": getattr(album, "album_artist", None),
                "artists": member_artist_names,
                "is_compilation": bool(
                    getattr(album, "is_compilation", False)
                ),
                "featured_artists": [
                    artist_name
                    for artist_name in _deduped_artist_names([*member_artist_names, *track_artist_names])
                    if _key(artist_name) != owner_key
                ],
                "edition": getattr(album, "edition", None),
                "cover_revision": getattr(album, "cover_revision", None),
                **_album_cover_authority_metadata(album),
                "root_provenance": getattr(album, "root_provenance", None),
                "tag_album_rating": tag_album_rating,
                "tag_album_rating_source": (
                    "file_tag" if tag_album_rating is not None else None
                ),
            }
        )

    for cache_key, file_entry in file_cache.items():
        if not isinstance(file_entry, dict):
            continue
        private_path = str(file_entry.get("path") or cache_key or "").strip()
        if not private_path or private_path in represented_private_paths:
            continue
        track_artist_key = ensure_artist(
            file_entry.get("artist") or file_entry.get("album_artist") or "Unknown Artist"
        )
        track_key = private_path
        track_rows.append(
            {
                "album_key": None,
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


def _attached_track_artist_names(track_artist_name: str | None, owner_name: str | None) -> list[str]:
    artist_name = _text_or_none(track_artist_name)
    if artist_name is None:
        return []
    owner = _text_or_none(owner_name)
    if owner is None:
        return [artist_name]
    if _key(artist_name) == _key(owner):
        return [owner]
    match = _OWNER_LED_FEATURE_RE.match(artist_name)
    if match is None or _key(match.group("owner")) != _key(owner):
        return [artist_name]
    return _deduped_artist_names([owner, *_split_featured_member_names(match.group("featured"))])


def _split_featured_member_names(value: object) -> list[str]:
    names: list[str] = []
    for part in _FEATURED_MEMBER_SPLIT_RE.split(str(value or "")):
        name = _text_or_none(part)
        if name is None:
            continue
        names.append(name)
    return names


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


def _inventory_publication_advisory_lock_sql() -> str:
    return "select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));"


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


def _reconcile_semantic_local_albums_sql(
    *,
    target_album_ids: tuple[int, ...] | None = None,
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
              and not exists (
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
        set album_key = semantic_album_candidates.canonical_album_key
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
    if not scoped_target_ids:
        for statement in _reconcile_semantic_local_albums_sql():
            connection.execute(statement)
        return
    for statement in _reconcile_semantic_local_albums_sql(
        target_album_ids=scoped_target_ids,
    ):
        if "%(target_album_ids)s" in statement:
            connection.execute(
                statement,
                {"target_album_ids": list(scoped_target_ids)},
            )
        else:
            connection.execute(statement)


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
                || jsonb_build_object('album', selected_track_files.file_entry -> 'album'),
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
                (select input_path_count from selection_scope)
          returning library.local_track_files.id
        ),
        updated_library as (
          update library.libraries
          set metadata = jsonb_set(
                coalesce(library.libraries.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'inventory_mutation_revision',
                       coalesce(
                         nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
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
            and (select count(*) from updated_tracks) =
                (select input_path_count from selection_scope)
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
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || case
                     when selected_track_files.file_entry ? 'album'
                     then jsonb_build_object(
                            'album',
                            selected_track_files.file_entry -> 'album'
                          )
                     else '{}'::jsonb
                   end,
              last_seen_at = now()
          from selected_track_files
          cross join selection_scope
          where library.local_tracks.id = selected_track_files.track_id
            and selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.input_path_count = selection_scope.resolved_track_count
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
            and selection_scope.input_path_count = selection_scope.resolved_track_count
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
                (select input_path_count from selection_scope)
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
          select incoming.private_path, incoming.file_entry
          from jsonb_to_recordset(%(input_rows)s::jsonb)
            as incoming(private_path text, file_entry jsonb)
        ),
        selected_track_files as materialized (
          select
            library.local_tracks.id as track_id,
            library.local_track_files.id as track_file_id,
            library.local_tracks.album_id,
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
              as resolved_track_file_count,
            count(*) as source_album_track_file_count
          from selected_track_files
        ),
        updated_tracks as (
          update library.local_tracks
          set title = case
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
                || selected_track_files.file_entry,
              last_seen_at = now()
          from selected_track_files
          cross join selection_scope
          where library.local_tracks.id = selected_track_files.track_id
            and selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.input_path_count = selection_scope.resolved_track_count
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
            and selection_scope.input_path_count = selection_scope.resolved_track_count
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
                (select input_path_count from selection_scope)
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
    renamed_album_metadata_sql = ""
    inserted_album_metadata_sql = "validated_source_album.metadata"
    if updates_release_year:
        renamed_album_metadata_sql = """
              , metadata = coalesce(library.local_albums.metadata, '{}'::jsonb)
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
          select incoming.private_path, incoming.file_entry
          from jsonb_to_recordset(%(input_rows)s::jsonb)
            as incoming(private_path text, file_entry jsonb)
        ),
        selected_track_files as materialized (
          select
            library.local_track_files.id as track_file_id,
            library.local_tracks.id as track_id,
            library.local_tracks.album_id as source_album_id,
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
            locked_album_scope.metadata
          from selection_scope
          join locked_album_scope
            on locked_album_scope.id = selection_scope.source_album_id
          where selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.source_album_count = 1
            and selection_scope.input_path_count <= (
                  select count(*) from source_album_track_files
                )
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
        renamed_source_album as (
          update library.local_albums
          set album_key = case
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
            validated_source_album.artist_id,
            %(destination_album_key)s,
            %(destination_album_title)s,
            case
              when %(updates_release_year)s::boolean
              then %(destination_release_year)s
              else validated_source_album.release_year
            end,
            validated_source_album.cover_path,
        """
        + inserted_album_metadata_sql
        + """
          from validated_source_album
          where (select input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        destination_album as materialized (
          select
            existing_destination_album.id,
            existing_destination_album.album_key
          from existing_destination_album
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
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || case
                     when selected_track_files.file_entry ? 'album'
                     then jsonb_build_object(
                            'album',
                            selected_track_files.file_entry -> 'album'
                          )
                     else '{}'::jsonb
                   end,
              last_seen_at = now()
          from selected_track_files
          where library.local_tracks.id = selected_track_files.track_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
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
                (select input_path_count from selection_scope)
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
                (select input_path_count from selection_scope)
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
          (select source_album_count from selection_scope) as source_album_count,
          (select count(*) from source_album_track_files) as source_album_track_file_count,
          0 as destination_conflict_count,
          (select count(*) from destination_album) as destination_album_count,
          (select id from destination_album) as destination_album_id,
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


def _load_scan_snapshot_sql() -> str:
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
        select library.libraries.metadata -> 'scan_cache' as scan_cache
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
) -> str:
    album_origin_json = (
        ", 'cover_selection_origin', %(cover_selection_origin)s::text"
        if include_origin
        else ""
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
        .replace("__USER_ORIGIN_GUARD__", user_origin_guard)
        .replace("__EXPECTED_COVER_STATE_GUARD__", expected_cover_state_guard)
        .replace("__BLOCKED_SELECTION__", blocked_selection)
        .replace("__BLOCKED_EXPECTED_COVER_STATE__", blocked_expected_cover_state)
        .replace("__LINKED_REMOTE_JSON__", linked_remote_json)
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


def _load_file_entries_sql() -> str:
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
          track_artists.name as track_artist
        from library.local_track_files
        join library.local_tracks on library.local_tracks.id = library.local_track_files.track_id
        join bootstrap_context on bootstrap_context.library_id = library.local_tracks.library_id
        join library.library_roots
          on library.library_roots.id = library.local_track_files.library_root_id
         and library.library_roots.library_id = library.local_tracks.library_id
         and library.library_roots.is_active is true
        left join library.local_albums on library.local_albums.id = library.local_tracks.album_id
        left join library.local_artists track_artists on track_artists.id = library.local_tracks.artist_id
        where library.local_track_files.metadata #>> '{scan_cache,source}' = %(source)s
          and coalesce((library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean, false) is false
        order by library.local_track_files.private_path;
    """


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


def _upsert_local_artist_sql() -> str:
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
        insert into library.local_artists (library_id, artist_key, name, sort_name, metadata)
        select bootstrap_context.library_id, %(artist_key)s, %(name)s, %(sort_name)s, %(metadata)s::jsonb
        from bootstrap_context
        on conflict (library_id, artist_key) do update
          set name = excluded.name,
              sort_name = excluded.sort_name,
              last_seen_at = now(),
              metadata = library.local_artists.metadata || excluded.metadata;
    """


def _upsert_local_album_sql() -> str:
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
              cover_path = excluded.cover_path,
              last_seen_at = now(),
              metadata = library.local_albums.metadata || excluded.metadata;
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
          and library.local_album_featured_artists.metadata ->> 'source' = %(source)s
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
              metadata = library.local_track_files.metadata || excluded.metadata
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
            library.local_track_files.metadata || excluded.metadata
          );
    """


def _mark_stale_track_files_sql() -> str:
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
        update library.local_track_files
           set metadata = library.local_track_files.metadata || %(stale_metadata)s::jsonb,
               last_seen_at = now()
        from library.local_tracks
        join bootstrap_context on bootstrap_context.library_id = library.local_tracks.library_id
        where library.local_track_files.track_id = library.local_tracks.id
          and library.local_track_files.metadata #>> '{scan_cache,source}' = %(source)s
          and (
            %(current_path_count)s = 0
            or library.local_track_files.private_path <> all(%(current_paths)s::text[])
          );
    """
