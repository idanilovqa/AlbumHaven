from __future__ import annotations

from collections.abc import Mapping

from psycopg.types.json import Jsonb

from music_app.services.postgres_connections import pooled_connection


_EDITABLE_METADATA_FIELDS = frozenset({
    "title",
    "artist",
    "album",
    "album_artist",
    "genre",
    "year",
    "track_number",
    "disc_number",
})


class CueCorrectionError(ValueError):
    pass


class CueCorrectionService:
    def __init__(self, config: Mapping[str, object], *, connect=None) -> None:
        self._database_url = config.get("ALBUM_HAVEN_APP_DATABASE_URL")
        self._connect = connect or pooled_connection

    @staticmethod
    def _scope(actor: object, *, owner: bool = False) -> tuple[int, int]:
        account_id = getattr(actor, "account_id", None)
        library_id = getattr(actor, "current_library_id", None)
        relationships = getattr(actor, "library_relationships", ()) or ()
        relationship = next(
            (
                item
                for item in relationships
                if getattr(item, "library_id", None) == library_id
            ),
            None,
        )
        if not isinstance(account_id, int) or not isinstance(library_id, int) or relationship is None:
            raise CueCorrectionError("Current library membership is required.")
        if owner and not bool(getattr(relationship, "is_primary_owner", False)):
            raise CueCorrectionError("Current library owner access is required.")
        return account_id, library_id

    @staticmethod
    def _identity(value: object) -> str:
        identity = str(value or "").strip()
        if not identity.startswith("cue:") or len(identity) > 256:
            raise CueCorrectionError("Invalid CUE track identity.")
        return identity

    @staticmethod
    def _is_owner(actor: object, library_id: int) -> bool:
        return any(
            getattr(item, "library_id", None) == library_id
            and bool(getattr(item, "is_primary_owner", False))
            for item in (getattr(actor, "library_relationships", ()) or ())
        )

    def _target(self, connection, *, library_id: int, cue_segment_ref: str):
        row = connection.execute(
            """/* cue_correction_target */
            with ordered as (
                select s.track_id, s.program_id, s.start_frame, s.end_frame,
                       lag(s.start_frame) over (
                           partition by s.program_id order by s.program_ordinal
                       ) as previous_start_frame
                from library.cue_track_segments s
            )
            select ordered.*, p.revision_sha256
            from ordered
            join library.local_tracks t on t.id = ordered.track_id
            join library.cue_programs p on p.id = ordered.program_id
            where t.library_id = %s and t.track_key = %s
              and p.library_id = t.library_id and p.is_active and p.is_valid""",
            (library_id, cue_segment_ref),
        ).fetchone()
        if row is None:
            raise CueCorrectionError("CUE track is unavailable.")
        return row

    def load_editor(self, *, actor: object, cue_segment_ref: object) -> dict[str, object]:
        _account_id, library_id = self._scope(actor)
        can_edit_structure = self._is_owner(actor, library_id)
        identity = self._identity(cue_segment_ref)
        with self._connect(self._database_url) as connection:
            rows = connection.execute(
                """/* cue_editor_tracks */
                select t.track_key as cue_segment_ref, t.title, s.program_id,
                       p.revision_sha256,
                       coalesce((boundary.payload->>'start_frame')::bigint, s.start_frame) as start_frame,
                       s.end_frame, s.internal_indexes,
                       metadata.payload->'fields' as metadata_correction,
                       boundary.id is not null as boundary_corrected,
                       metadata.id is not null as metadata_corrected
                from library.local_tracks selected
                join library.cue_track_segments selected_segment on selected_segment.track_id = selected.id
                join library.cue_track_segments s on s.program_id = selected_segment.program_id
                join library.local_tracks t on t.id = s.track_id
                join library.cue_programs p on p.id = s.program_id
                left join lateral (
                    select c.id, c.payload from library.cue_corrections c
                    where c.library_id = t.library_id and c.track_id = t.id
                      and c.base_program_id = p.id
                      and c.correction_kind = 'boundary' and c.status = 'active'
                    order by c.updated_at desc, c.id desc limit 1
                ) boundary on true
                left join lateral (
                    select c.id, c.payload from library.cue_corrections c
                    where c.library_id = t.library_id and c.track_id = t.id
                      and c.base_program_id = p.id
                      and c.correction_kind = 'metadata' and c.status = 'active'
                    order by c.updated_at desc, c.id desc limit 1
                ) metadata on true
                where selected.library_id = %s and selected.track_key = %s
                  and p.library_id = selected.library_id and p.is_active and p.is_valid
                order by s.program_ordinal""",
                (library_id, identity),
            ).fetchall()
        if not rows:
            raise CueCorrectionError("CUE track is unavailable.")
        tracks = []
        for row in rows:
            metadata = row.get("metadata_correction")
            metadata = metadata if isinstance(metadata, Mapping) else {}
            track = {
                "cue_segment_ref": row["cue_segment_ref"],
                "title": str(metadata.get("title") or row.get("title") or ""),
                **dict(metadata),
                "cue_boundary_corrected": bool(row.get("boundary_corrected")),
                "cue_metadata_corrected": bool(row.get("metadata_corrected")),
            }
            if can_edit_structure:
                track["cue_structure"] = {
                    "base_revision_sha256": row["revision_sha256"],
                    "start_frame": row["start_frame"],
                    "end_frame": row["end_frame"],
                    "internal_indexes": row.get("internal_indexes") or [],
                }
            tracks.append(track)
        return {
            "base_revision_sha256": rows[0]["revision_sha256"],
            "can_edit_structure": can_edit_structure,
            "tracks": tracks,
        }

    def apply(self, *, actor: object, payload: object) -> dict[str, object]:
        if not isinstance(payload, Mapping):
            raise CueCorrectionError("Invalid CUE correction.")
        kind = str(payload.get("kind") or "")
        if kind not in {"boundary", "metadata"}:
            raise CueCorrectionError("Invalid CUE correction kind.")
        account_id, library_id = self._scope(actor, owner=kind == "boundary")
        identity = self._identity(payload.get("cue_segment_ref"))
        revision = str(payload.get("base_revision_sha256") or "")
        if len(revision) != 64 or any(character not in "0123456789abcdef" for character in revision):
            raise CueCorrectionError("Invalid CUE revision.")

        with self._connect(self._database_url) as connection:
            target = self._target(
                connection,
                library_id=library_id,
                cue_segment_ref=identity,
            )
            if revision != target["revision_sha256"]:
                raise CueCorrectionError("The CUE program changed. Reload before applying.")
            if kind == "boundary":
                start_frame = payload.get("start_frame")
                previous_start = target.get("previous_start_frame")
                if (
                    type(start_frame) is not int
                    or start_frame < 0
                    or (previous_start is not None and start_frame <= previous_start)
                    or start_frame >= target["end_frame"]
                ):
                    raise CueCorrectionError("Invalid CUE boundary order.")
                correction_payload = {
                    "start_frame": start_frame,
                    "source_start_frame": target["start_frame"],
                }
            else:
                fields = payload.get("fields")
                if (
                    not isinstance(fields, Mapping)
                    or not fields
                    or not set(fields).issubset(_EDITABLE_METADATA_FIELDS)
                    or any(not isinstance(value, str) or len(value) > 4096 for value in fields.values())
                ):
                    raise CueCorrectionError("Invalid CUE metadata correction.")
                correction_payload = {"fields": dict(fields)}

            row = connection.execute(
                """/* cue_store_correction */
                with restored as (
                    update library.cue_corrections
                    set status = 'restored', restored_at = now(), updated_at = now()
                    where library_id = %s and track_id = %s
                      and correction_kind = %s and status = 'active'
                )
                insert into library.cue_corrections (
                    library_id, track_id, account_id, base_program_id,
                    correction_kind, payload
                ) values (%s, %s, %s, %s, %s, %s)
                returning id""",
                (
                    library_id,
                    target["track_id"],
                    kind,
                    library_id,
                    target["track_id"],
                    account_id,
                    target["program_id"],
                    kind,
                    Jsonb(correction_payload),
                ),
            ).fetchone()
        return {"ok": True, "correction_id": row["id"]}

    def restore(
        self,
        *,
        actor: object,
        cue_segment_ref: object,
        kind: object,
    ) -> dict[str, object]:
        correction_kind = str(kind or "")
        if correction_kind not in {"boundary", "metadata"}:
            raise CueCorrectionError("Invalid CUE correction kind.")
        _account_id, library_id = self._scope(actor, owner=correction_kind == "boundary")
        identity = self._identity(cue_segment_ref)
        with self._connect(self._database_url) as connection:
            row = connection.execute(
                """/* cue_restore_correction */
                update library.cue_corrections c
                set status = 'restored', restored_at = now(), updated_at = now()
                from library.local_tracks t
                where c.library_id = %s
                  and c.correction_kind = %s and c.status = 'active'
                  and t.id = c.track_id and t.library_id = c.library_id
                  and t.track_key = %s
                returning c.id""",
                (library_id, correction_kind, identity),
            ).fetchone()
        return {"ok": True, "restored": row is not None}
