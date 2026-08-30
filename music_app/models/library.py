from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path

@dataclass
class Track:
    path: Path
    title: str
    track_number: int | None = None
    disc_number: int | None = None
    disc_number_raw: str | None = None
    artist: str | None = None
    album: str | None = None
    album_artist: str | None = None
    genre: str | None = None
    year: int | None = None
    edition: str | None = None
    album_rating: int | None = None
    exception_type: str | None = None
    cover_path: Path | None = None
    cover_revision: str | None = None
    local_cover_width: int | None = None
    local_cover_height: int | None = None
    remote_cover_url: str | None = None
    remote_cover_thumbnail_url: str | None = None
    remote_cover_source: str | None = None
    remote_cover_source_label: str | None = None
    remote_cover_album_url: str | None = None
    remote_cover_width: int | None = None
    remote_cover_height: int | None = None
    duration_seconds: int | None = None
    release_date: str | None = None
    library_root_id: str | None = None
    library_root_category: str | None = None
    root_provenance: dict[str, object] | None = None

@dataclass
class Album:
    key: str
    name: str
    album_artist: str
    tracks: list[Track] = field(default_factory=list)
    artists: list[str] = field(default_factory=list)
    is_compilation: bool = False
    cover_path: Path | None = None
    cover_revision: str | None = None
    cover_selection_origin: str | None = None
    local_cover_width: int | None = None
    local_cover_height: int | None = None
    remote_cover_url: str | None = None
    remote_cover_thumbnail_url: str | None = None
    remote_cover_source: str | None = None
    remote_cover_source_label: str | None = None
    remote_cover_album_url: str | None = None
    remote_cover_width: int | None = None
    remote_cover_height: int | None = None
    year: int | None = None
    edition: str | None = None
    album_rating: int | None = None
    total_duration_seconds: int = 0
    release_date: str | None = None
    library_root_id: str | None = None
    library_root_category: str | None = None
    root_provenance: dict[str, object] | None = None
