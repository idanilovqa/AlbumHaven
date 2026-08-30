from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from threading import Event

from music_app.services.cover_provider_groups import COVER_LOOKUP_PROVIDER_GROUP_NAMES


COVER_LOOKUP_JOB_SCHEMA_VERSION = 1

_CANDIDATE_LOOKUP_PROVIDER_GROUPS = list(COVER_LOOKUP_PROVIDER_GROUP_NAMES)

_SAVE_REMOTE_PROVIDER_GROUPS = [
    "remote_image_download",
    "cover_writeback",
]


def build_cover_lookup_job_contract(job_kind: str | None) -> dict[str, object]:
    normalized_job_kind = str(job_kind or "").strip() or "candidate_lookup"
    provider_groups = (
        _SAVE_REMOTE_PROVIDER_GROUPS
        if normalized_job_kind == "save_remote_selection"
        else _CANDIDATE_LOOKUP_PROVIDER_GROUPS
    )
    return {
        "schema_version": COVER_LOOKUP_JOB_SCHEMA_VERSION,
        "job_family": "cover_lookup",
        "job_kind": normalized_job_kind,
        "runtime_backend": "in_process_executor",
        "durability": "ephemeral",
        "provider_groups": list(provider_groups),
        "status_contract": {
            "task_id_field": "id",
            "status_field": "status",
            "cancel_requested_field": "cancel_requested",
        },
    }


@dataclass(frozen=True)
class CoverLookupRuntimeJob:
    task_id: str
    config: Mapping[str, object]
    logger: object
    user_agent: str
    album: dict[str, object]
    requested_track_paths: set[str]
    cancel_event: Event
    manual_urls: list[str] | None = None
    job_contract: dict[str, object] | None = None
