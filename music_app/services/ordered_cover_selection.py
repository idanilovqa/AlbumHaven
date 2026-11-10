"""Reference-only ordered Save validation and primary projection.

Source inventory stays outside the saved list. No image is copied or fetched.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from uuid import UUID, uuid4

from music_app.services.ordered_cover_references import (
    OrderedCoverSelectionConflict, _local_identity, _remote_identity,
    project_selected_cover_metadata,
)


class InvalidOrderedCoverSelection(ValueError):
    """A malformed or duplicate selection list, rather than a missing source."""


def validate_save_request(*, expected_album_id, expected_revision, mutation_id, references):
    if type(expected_album_id) is not int or expected_album_id <= 0:
        raise ValueError("A concrete album ID is required.")
    if type(expected_revision) is not int or expected_revision < 0:
        raise ValueError("A nonnegative selection revision is required.")
    if not isinstance(mutation_id, str):
        raise ValueError("A mutation UUID is required.")
    try:
        mutation_id = str(UUID(mutation_id))
    except ValueError as exc:
        raise ValueError("A mutation UUID is required.") from exc
    if not isinstance(references, list) or not 1 <= len(references) <= 3:
        raise ValueError("Select one to three covers.")
    selectors = set()
    for reference in references:
        if not isinstance(reference, dict):
            raise ValueError("Invalid cover selector.")
        fields = set(reference)
        if fields == {"selection_id"}:
            values = [reference["selection_id"]]
            selector = ("selection_id", reference["selection_id"])
        elif fields == {"retain_current", "expected_primary"} and reference["retain_current"] is True:
            if not isinstance(reference["expected_primary"], str) or not re.fullmatch(r"[0-9a-f]{64}", reference["expected_primary"]):
                raise ValueError("A current primary token is required.")
            values = []
            selector = ("retain_current",)
        elif reference.get("kind") == "local" and fields == {"kind", "path"}:
            selector = ("local", _local_identity(reference["path"]))
            values = [reference["path"]]
        elif reference.get("kind") == "remote" and fields == {"kind", "candidate_id", "candidate_generation"}:
            values = [reference["candidate_id"], reference["candidate_generation"]]
        else:
            raise ValueError("Only existing selected IDs or source selectors are accepted.")
        if any(not isinstance(value, str) or not value or value != value.strip() for value in values):
            raise ValueError("Cover selector fields must be nonempty text.")
        if reference.get("kind") == "remote":
            try:
                generation = str(UUID(reference["candidate_generation"]))
            except ValueError as exc:
                raise InvalidOrderedCoverSelection("A candidate generation UUID is required.") from exc
            selector = ("remote", reference["candidate_id"], generation)
        if selector in selectors:
            raise InvalidOrderedCoverSelection("Cover selectors must be unique.")
        selectors.add(selector)
    body = {"album_id": expected_album_id, "revision": expected_revision, "references": references}
    request_hash = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return {"mutation_id": mutation_id, "request_hash": request_hash}


def source_identity(item):
    return (item["kind"], _local_identity(item["path"]) if item["kind"] == "local" else _remote_identity(item["url"]))


def current_cover_reference(*, cover_path, metadata):
    """Read persisted primary authority without inventing selection provenance.

    Availability does not change this source. In particular a missing local
    primary must not silently fall back to linked remote artwork.
    """
    saved = project_selected_cover_metadata(metadata)
    if saved:
        return dict(saved["selected_covers"][0])
    if cover_path:
        item = {"kind": "local", "path": cover_path}
    elif isinstance(metadata, Mapping) and metadata.get("remote_cover_url"):
        item = {"kind": "remote", **{key: metadata["remote_cover_" + key] for key in (
            "url", "thumbnail_url", "source", "source_label", "album_url", "width", "height",
        ) if metadata.get("remote_cover_" + key) is not None}}
    else:
        return None
    source_identity(item)
    return item


def current_cover_token(*, album_id, library_id, cover_path, metadata):
    """Bind a retain selector to its observed concrete album and source.

    Legacy primary mutations need this guard because they have no ordered-list
    revision to compare. This token is an identity check, never authorization.
    """
    if any(type(value) is not int or value <= 0 for value in (album_id, library_id)):
        raise ValueError("A concrete album and library are required.")
    item = current_cover_reference(cover_path=cover_path, metadata=metadata)
    if item is None:
        return None
    body = [library_id, album_id, source_identity(item)]
    return hashlib.sha256(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def prepare_selection(*, metadata, expected_revision, request, references, config, album_root, track_paths, snapshot, configured_root_paths, cover_path=None, album_id=None, library_id=None):
    saved = project_selected_cover_metadata(metadata)
    current = saved.get("selected_covers", [])
    revision = saved.get("selected_covers_revision", 0)
    latest = saved.get("selected_covers_last_request", {})
    if latest.get("mutation_id") == request["mutation_id"]:
        if latest != request:
            raise OrderedCoverSelectionConflict("This Save request ID was already used for different selections.")
        return None, {**saved, "changed": False, "replayed": True}
    if revision != expected_revision:
        raise OrderedCoverSelectionConflict("The cover selection changed. Reload before saving again.")
    by_id = {item["selection_id"]: item for item in current}
    by_source = {source_identity(item): item for item in current}
    selected = []
    selected_sources = set()
    for reference in references:
        if "selection_id" in reference:
            if reference["selection_id"] not in by_id:
                raise OrderedCoverSelectionConflict("The selected cover no longer belongs to this album.")
            item = dict(by_id[reference["selection_id"]])
        elif reference.get("retain_current") is True:
            if reference["expected_primary"] != current_cover_token(
                album_id=album_id, library_id=library_id, cover_path=cover_path, metadata=metadata,
            ):
                raise OrderedCoverSelectionConflict("The primary cover changed. Reload before saving again.")
            item = current_cover_reference(cover_path=cover_path, metadata=metadata)
        elif reference["kind"] == "local":
            from music_app.services.cover_workflow import validate_local_cover_source
            from music_app.services.generated_preview_storage import is_generated_cover_artifact
            from music_app.services.covers import image_dimensions
            if album_root is None:
                raise FileNotFoundError("Album sources are unavailable.")
            path = validate_local_cover_source(config, album_root, reference["path"], track_paths=track_paths, configured_root_paths=configured_root_paths)
            extensions = config.get("IMAGE_EXTENSIONS") or {".jpg", ".jpeg", ".png", ".webp"}
            if path.suffix.lower() not in extensions or is_generated_cover_artifact(path, album_root):
                raise ValueError("Select an existing source image, not a generated preview.")
            if min(image_dimensions(path)) <= 0:
                raise ValueError("The selected source is not a readable image.")
            item = {"kind": "local", "path": str(path)}
        else:
            from music_app.services.album_cover_candidate_publisher import sanitize_persisted_candidate_snapshot
            try:
                generation = str(UUID(str((snapshot or {}).get("search_generation"))))
            except ValueError as exc:
                raise OrderedCoverSelectionConflict("Remote candidates changed. Reload before saving.") from exc
            if generation != str(UUID(reference["candidate_generation"])):
                raise OrderedCoverSelectionConflict("Remote candidates changed. Reload before saving.")
            candidates, invalid = sanitize_persisted_candidate_snapshot(snapshot.get("candidates"))
            matches = [candidate for candidate in candidates if candidate.get("id") == reference["candidate_id"]]
            if invalid or len(matches) != 1 or matches[0].get("art_kind") not in {"cover", "other"}:
                raise ValueError("The remote source is not selectable artwork.")
            candidate = matches[0]
            item = {"kind": "remote", **{key: candidate[key] for key in (
                "url", "thumbnail_url", "source", "source_label", "album_url",
                "width", "height", "art_kind", "art_label",
            ) if key in candidate}, "candidate_id": candidate["id"],
                    "candidate_generation": generation}
        identity = source_identity(item)
        if identity in selected_sources:
            raise InvalidOrderedCoverSelection("Selected cover sources must be unique.")
        selected_sources.add(identity)
        previous = by_source.get(identity)
        if previous is not None:
            # Re-selecting the same source does not rename or refresh its saved provenance.
            item = dict(previous)
        else:
            item["selection_id"] = str(uuid4())
        selected.append(item)
    changed = selected != current
    patch = {"selected_covers": selected, "selected_covers_revision": revision + int(changed),
             "selected_covers_last_request": request}
    project_selected_cover_metadata(patch)
    return patch, {**patch, "changed": changed, "replayed": False}


def primary_projection(selection):
    primary = selection[0]
    projection = {"cover_selection_origin": "user", "cover_selection_provenance": "explicit",
                  "cover_revision": None, "cover_selection_repair_previous": None,
                  "local_cover_width": None, "local_cover_height": None}
    for key in ("url", "thumbnail_url", "source", "source_label", "album_url", "width", "height"):
        projection["remote_cover_" + key] = primary.get(key) if primary["kind"] == "remote" else None
    return primary.get("path"), projection
