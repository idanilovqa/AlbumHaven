from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any, Callable

from music_app.services.music_identity_matching import (
    canonical_artist_identity,
    normalize_search_text,
    same_artist_identity,
)


DEFAULT_POST_SCAN_MBID_ASSERTION_MAX_ARTISTS = 25
_NO_WINDOW_CREATION_FLAGS = (
    getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if os.name == "nt"
    else 0
)
TRUE_ARTIST_MBID_EVIDENCE_SOURCES = {
    "lastfm.public.artists",
    "lastfm.public.tracks.artist_mbid",
}
LOCAL_MATCH_CONTEXT_EVIDENCE_SOURCES = {
    "lastfm.public.albums",
    "lastfm.public.tracks.mbid",
}


class PsqlSubprocessTarget:
    """Small psql-backed target for post-scan MBID assertion writes."""

    def __init__(self, *, database_url: str | None = None, psql_path: str | None = None) -> None:
        self.database_url = database_url or os.environ.get("ALBUM_HAVEN_DATABASE_URL")
        self.psql_path = psql_path or _resolve_psql_path()
        if not self.database_url:
            raise RuntimeError("ALBUM_HAVEN_DATABASE_URL is required for post-scan MBID assertions.")

    def execute(self, sql: str, params: object | None = None) -> int:
        command = [
            self.psql_path,
            "-w",
            "-v",
            "ON_ERROR_STOP=1",
            self.database_url,
            "-At",
            "-c",
            _render_sql(sql, params),
        ]
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            creationflags=_NO_WINDOW_CREATION_FLAGS,
        )
        return sum(1 for line in completed.stdout.splitlines() if line.strip())


class LastfmReadonlySubprocessSource:
    """Read-only psql-backed Last.fm source for MBID evidence."""

    _MUTATING_SQL = re.compile(
        r"\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|copy)\b",
        re.IGNORECASE,
    )
    _INTO_SQL = re.compile(r"\binto\b", re.IGNORECASE)

    def __init__(self, *, database_url: str | None = None, psql_path: str | None = None) -> None:
        self.database_url = database_url or os.environ.get("ALBUM_HAVEN_LASTFM_READONLY_URL")
        self.psql_path = psql_path or _resolve_psql_path()
        if not self.database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_LASTFM_READONLY_URL is required for Last.fm MBID evidence reads."
            )

    def query_json(self, sql: str, params: object | None = None) -> list[dict[str, object]]:
        rendered_sql = _render_sql(sql, params).strip().rstrip(";")
        guard_sql = _sql_guard_text(rendered_sql)
        if self._MUTATING_SQL.search(guard_sql) or self._INTO_SQL.search(guard_sql):
            raise ValueError("Last.fm readonly source only accepts SELECT statements.")
        if not rendered_sql.lower().startswith(("select", "with")):
            raise ValueError("Last.fm readonly source only accepts SELECT statements.")
        wrapped_sql = f"""
            select coalesce(jsonb_agg(to_jsonb(lastfm_rows)), '[]'::jsonb)
            from (
              {rendered_sql}
            ) as lastfm_rows;
        """
        command = [
            self.psql_path,
            "-w",
            "-v",
            "ON_ERROR_STOP=1",
            self.database_url,
            "-At",
            "-c",
            wrapped_sql,
        ]
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            creationflags=_NO_WINDOW_CREATION_FLAGS,
        )
        decoded = json.loads(completed.stdout.strip() or "[]")
        if not isinstance(decoded, list):
            raise RuntimeError("Last.fm readonly query did not return a JSON list.")
        return [dict(item) for item in decoded if isinstance(item, dict)]


def local_inventory_key(value: object) -> str:
    return " ".join(str(value or "").strip().casefold().split())


def select_new_local_artists_for_scan_follow_up(
    previous_albums: object,
    current_albums: object,
    *,
    max_artists: int = DEFAULT_POST_SCAN_MBID_ASSERTION_MAX_ARTISTS,
) -> list[str]:
    previous_artist_keys = _artist_keys_from_albums(previous_albums)
    previous_album_keys = _album_keys(previous_albums)
    selected: dict[str, str] = {}
    for album in current_albums or []:
        album_key = str(getattr(album, "key", "") or "")
        if album_key and album_key in previous_album_keys:
            continue
        for artist_name in _artist_names_from_album(album):
            artist_key = local_inventory_key(artist_name)
            if not artist_key or artist_key in previous_artist_keys:
                continue
            selected.setdefault(artist_key, artist_name)
            if len(selected) >= max(0, int(max_artists or 0)):
                return sorted(selected.values(), key=str.casefold)
    return sorted(selected.values(), key=str.casefold)


def queue_post_scan_artist_mbid_assertion_follow_up(
    library_state: dict[str, object],
    *,
    previous_albums: object,
    config: dict[str, object],
    submit_follow_up: Callable[..., object],
) -> bool:
    database_url = _config_value(config, "ALBUM_HAVEN_DATABASE_URL")
    lastfm_readonly_url = _config_value(config, "ALBUM_HAVEN_LASTFM_READONLY_URL")
    if not database_url or not lastfm_readonly_url:
        return False
    max_artists = _safe_int(
        config.get("POST_SCAN_MBID_ASSERTION_MAX_ARTISTS"),
        DEFAULT_POST_SCAN_MBID_ASSERTION_MAX_ARTISTS,
    )
    artist_names = select_new_local_artists_for_scan_follow_up(
        previous_albums,
        library_state.get("albums", []),
        max_artists=max_artists,
    )
    if not artist_names:
        return False
    submit_follow_up(
        artist_names=artist_names,
        database_url=database_url,
        lastfm_readonly_url=lastfm_readonly_url,
        scan_run_ref=_scan_run_ref(library_state),
    )
    return True


def run_post_scan_artist_mbid_assertion_follow_up(
    artist_names: list[str],
    *,
    scan_run_ref: str,
    target: object | None = None,
    lastfm_source: object | None = None,
    database_url: str | None = None,
    lastfm_readonly_url: str | None = None,
) -> dict[str, int]:
    bounded_artist_names = [
        name for name in artist_names[:DEFAULT_POST_SCAN_MBID_ASSERTION_MAX_ARTISTS]
        if str(name or "").strip()
    ]
    if not bounded_artist_names:
        return {"artist_count": 0, "asserted_count": 0, "assertion_row_count": 0}
    write_target = target or PsqlSubprocessTarget(database_url=database_url)
    source = lastfm_source or LastfmReadonlySubprocessSource(database_url=lastfm_readonly_url)
    if hasattr(source, "collect_artist_evidence"):
        evidence_by_artist = source.collect_artist_evidence(bounded_artist_names)
    else:
        evidence_by_artist, _summary = collect_lastfm_mbid_evidence_for_artists(
            bounded_artist_names,
            source=source,
        )

    asserted_count = 0
    assertion_row_count = 0
    for artist_name in bounded_artist_names:
        artist_key = local_inventory_key(artist_name)
        classification = classify_artist_mbid_evidence(
            artist_name,
            evidence_by_artist.get(artist_key, []),
        )
        if classification.get("mbid_assertion_state") == "asserted":
            asserted_count += 1
        write_target.execute(
            _upsert_local_artist_mbid_projection_sql(),
            [
                artist_key,
                artist_name,
                classification.get("mbid"),
                classification.get("mbid_assertion_state"),
                classification.get("evidence_source"),
                classification.get("confidence"),
                scan_run_ref,
                {
                    "source": "post_scan_artist_mbid_assertion_follow_up",
                    "scan_run_ref": scan_run_ref,
                },
            ],
        )
        write_target.execute(
            _insert_local_artist_mbid_assertion_sql(),
            [
                artist_key,
                classification.get("assertion_mbid") or classification.get("mbid"),
                classification.get("mbid_assertion_state"),
                classification.get("evidence_source") or "lastfm_mbid_evidence",
                classification.get("confidence"),
                classification.get("explanation"),
                scan_run_ref,
                classification.get("source_payload"),
            ],
        )
        assertion_row_count += 1
    return {
        "artist_count": len(bounded_artist_names),
        "asserted_count": asserted_count,
        "assertion_row_count": assertion_row_count,
    }


def collect_lastfm_mbid_evidence_for_artists(
    artist_names: list[str],
    *,
    source: object,
) -> tuple[dict[str, list[dict[str, object]]], dict[str, object]]:
    artist_evidence, _album_evidence, _track_evidence, summary = (
        collect_lastfm_mbid_evidence_for_local_targets(artist_names, source=source)
    )
    return artist_evidence, summary


def collect_lastfm_mbid_evidence_for_local_targets(
    artist_names: list[str],
    *,
    source: object,
) -> tuple[
    dict[str, list[dict[str, object]]],
    dict[tuple[str, str], list[dict[str, object]]],
    dict[tuple[str, str], list[dict[str, object]]],
    dict[str, object],
]:
    target_artists = {
        local_inventory_key(name): str(name).strip()
        for name in artist_names
        if local_inventory_key(name)
    }
    normalized_artist_names = sorted(target_artists)
    if not normalized_artist_names:
        return {}, {}, {}, _lastfm_evidence_summary()

    bounded_artist_filters = {
        variant
        for target_name in target_artists.values()
        for variant in (
            local_inventory_key(target_name),
            local_inventory_key(normalize_search_text(target_name)),
            local_inventory_key(canonical_artist_identity(target_name)),
        )
        if variant
    }
    for target_name in target_artists.values():
        normalized_tokens = normalize_search_text(target_name).split()
        without_conjunction = [token for token in normalized_tokens if token != "and"]
        if len(without_conjunction) >= 2:
            bounded_artist_filters.add(" ".join(without_conjunction))
    filter_sql = _lastfm_artist_filter_sql(sorted(bounded_artist_filters))
    available_columns = _lastfm_available_columns(source)
    source_specs = [
        (
            "artist_mbid_count",
            "lastfm.public.artists",
            "artists",
            {"name", "mbid"},
            0.98,
            f"""
                select
                  artists.name as artist_name,
                  artists.mbid as mbid,
                  ctid::text as provider_row
                from public.artists as artists
                where artists.mbid is not null
                  and btrim(artists.mbid::text) <> ''
                  and lower(btrim(artists.name::text)) in ({filter_sql})
                order by lower(btrim(artists.name::text)), artists.mbid::text, ctid::text
            """,
        ),
        (
            "album_mbid_count",
            "lastfm.public.albums",
            "albums",
            {"artist", "title", "mbid"},
            0.94,
            f"""
                select
                  albums.artist as artist_name,
                  albums.title as album_title,
                  albums.mbid as mbid,
                  ctid::text as provider_row
                from public.albums as albums
                where albums.mbid is not null
                  and btrim(albums.mbid::text) <> ''
                  and lower(btrim(albums.artist::text)) in ({filter_sql})
                order by lower(btrim(albums.artist::text)), lower(btrim(albums.title::text)), albums.mbid::text, ctid::text
            """,
        ),
        (
            "track_artist_mbid_count",
            "lastfm.public.tracks.artist_mbid",
            "tracks",
            {"artist", "title", "artist_mbid"},
            0.93,
            f"""
                select
                  tracks.artist as artist_name,
                  tracks.title as track_title,
                  tracks.artist_mbid as mbid,
                  ctid::text as provider_row
                from public.tracks as tracks
                where tracks.artist_mbid is not null
                  and btrim(tracks.artist_mbid::text) <> ''
                  and lower(btrim(tracks.artist::text)) in ({filter_sql})
                order by lower(btrim(tracks.artist::text)), lower(btrim(tracks.title::text)), tracks.artist_mbid::text, ctid::text
            """,
        ),
        (
            "track_mbid_count",
            "lastfm.public.tracks.mbid",
            "tracks",
            {"artist", "title", "mbid"},
            0.94,
            f"""
                select
                  tracks.artist as artist_name,
                  tracks.title as track_title,
                  tracks.mbid as mbid,
                  ctid::text as provider_row
                from public.tracks as tracks
                where tracks.mbid is not null
                  and btrim(tracks.mbid::text) <> ''
                  and lower(btrim(tracks.artist::text)) in ({filter_sql})
                order by lower(btrim(tracks.artist::text)), lower(btrim(tracks.title::text)), tracks.mbid::text, ctid::text
            """,
        ),
    ]
    evidence_by_artist: dict[str, list[dict[str, object]]] = {}
    evidence_by_album: dict[tuple[str, str], list[dict[str, object]]] = {}
    evidence_by_track: dict[tuple[str, str], list[dict[str, object]]] = {}
    warning_messages: list[str] = []
    counts = {
        "artist_mbid_count": 0,
        "album_mbid_count": 0,
        "track_artist_mbid_count": 0,
        "track_mbid_count": 0,
    }
    for count_key, evidence_source, table_name, required_columns, confidence, sql in source_specs:
        missing_columns = sorted(required_columns - available_columns.get(table_name, set()))
        if missing_columns:
            warning_messages.append(
                f"{evidence_source} skipped because public.{table_name} is missing columns: "
                f"{', '.join(missing_columns)}."
            )
            continue
        rows = source.query_json(sql)
        counts[count_key] = len(rows)
        for row in rows:
            returned_artist_name = str(row.get("artist_name") or "").strip()
            matching_target_keys = [
                target_key
                for target_key, target_name in target_artists.items()
                if same_artist_identity(target_name, returned_artist_name)
            ]
            mbid = str(row.get("mbid") or "").strip()
            if len(matching_target_keys) != 1 or not mbid:
                continue
            artist_key = matching_target_keys[0]
            evidence_item = {
                "mbid": mbid,
                "confidence": confidence,
                "source": evidence_source,
                "payload": {key: value for key, value in row.items() if key != "mbid"},
            }
            if evidence_source in {"lastfm.public.artists", "lastfm.public.tracks.artist_mbid"}:
                evidence_by_artist.setdefault(artist_key, []).append(evidence_item)
            elif evidence_source == "lastfm.public.albums":
                album_key = local_inventory_key(row.get("album_title"))
                if album_key:
                    evidence_by_album.setdefault((artist_key, album_key), []).append(evidence_item)
            elif evidence_source == "lastfm.public.tracks.mbid":
                track_key = local_inventory_key(row.get("track_title"))
                if track_key:
                    evidence_by_track.setdefault((artist_key, track_key), []).append(evidence_item)
    return evidence_by_artist, evidence_by_album, evidence_by_track, _lastfm_evidence_summary(
        source_count=sum(counts.values()),
        warning_count=len(warning_messages),
        message=" ".join(warning_messages) if warning_messages else None,
        warning_messages=warning_messages,
        counts=counts,
    )


def classify_artist_mbid_evidence(
    artist_name: str,
    evidence: list[dict[str, object]],
    *,
    local_match_evidence: list[dict[str, object]] | None = None,
    high_confidence_threshold: float = 0.9,
) -> dict[str, object]:
    normalized_evidence = _normalized_artist_mbid_evidence(evidence)
    normalized_local_match_evidence = _normalized_artist_mbid_evidence(
        local_match_evidence or _local_match_context_evidence(normalized_evidence)
    )
    candidate_evidence = [
        item for item in normalized_evidence
        if _is_artist_mbid_candidate_evidence(item)
    ]
    candidates = [
        {**item, "normalized_mbid": normalized_mbid}
        for item in candidate_evidence
        if (normalized_mbid := _normalize_uuid_text(item.get("mbid"))) is not None
    ]
    source_payload = {
        "artist": artist_name,
        "evidence": normalized_evidence,
        "local_match_evidence": normalized_local_match_evidence,
    }
    if not candidates:
        return {
            "mbid": None,
            "assertion_mbid": None,
            "mbid_assertion_state": "missing",
            "evidence_source": None,
            "confidence": None,
            "explanation": "No true artist MBID evidence was provided for this local artist.",
            "source_payload": source_payload,
        }
    high_confidence = [
        item for item in candidates
        if _safe_float(item.get("confidence")) >= high_confidence_threshold
    ]
    if not high_confidence:
        top = max(candidates, key=lambda item: _safe_float(item.get("confidence")))
        return {
            "mbid": None,
            "assertion_mbid": top["normalized_mbid"],
            "mbid_assertion_state": "low_confidence",
            "evidence_source": _evidence_source(top),
            "confidence": _safe_float(top.get("confidence")),
            "explanation": "MBID evidence exists, but no candidate reached the high-confidence threshold.",
            "source_payload": source_payload,
        }
    mbids = {str(item["normalized_mbid"]) for item in high_confidence}
    top = max(high_confidence, key=lambda item: _safe_float(item.get("confidence")))
    if len(mbids) > 1:
        return {
            "mbid": None,
            "assertion_mbid": top["normalized_mbid"],
            "mbid_assertion_state": "conflicting",
            "evidence_source": _evidence_source(top),
            "confidence": _safe_float(top.get("confidence")),
            "explanation": "Multiple high-confidence true artist MBID candidates disagree.",
            "source_payload": source_payload,
        }
    explanation = "Exactly one high-confidence true artist MBID candidate was found."
    if len(high_confidence) > 1:
        explanation = "Multiple high-confidence true artist MBID rows corroborate the same MBID."
    return {
        "mbid": top["normalized_mbid"],
        "assertion_mbid": top["normalized_mbid"],
        "mbid_assertion_state": "asserted",
        "evidence_source": _evidence_source(top),
        "confidence": _safe_float(top.get("confidence")),
        "explanation": explanation,
        "source_payload": source_payload,
    }


def classify_album_mbid_evidence(
    artist_name: str,
    album_title: str,
    evidence: list[dict[str, object]],
    *,
    high_confidence_threshold: float = 0.9,
) -> dict[str, object]:
    return _classify_local_mbid_evidence(
        target_kind="album",
        artist_name=artist_name,
        title=album_title,
        title_payload_key="album_title",
        evidence=evidence,
        high_confidence_threshold=high_confidence_threshold,
    )


def classify_track_mbid_evidence(
    artist_name: str,
    track_title: str,
    evidence: list[dict[str, object]],
    *,
    high_confidence_threshold: float = 0.9,
) -> dict[str, object]:
    return _classify_local_mbid_evidence(
        target_kind="track",
        artist_name=artist_name,
        title=track_title,
        title_payload_key="track_title",
        evidence=evidence,
        high_confidence_threshold=high_confidence_threshold,
    )


def _classify_local_mbid_evidence(
    *,
    target_kind: str,
    artist_name: str,
    title: str,
    title_payload_key: str,
    evidence: list[dict[str, object]],
    high_confidence_threshold: float,
) -> dict[str, object]:
    normalized_evidence = _normalized_artist_mbid_evidence(evidence)
    local_artist_key = local_inventory_key(artist_name)
    local_title_key = local_inventory_key(title)
    exact_evidence = [
        item for item in normalized_evidence
        if _evidence_sort_text(item, "artist_name") == local_artist_key
        and _evidence_sort_text(item, title_payload_key) == local_title_key
    ]
    candidates = [
        {**item, "normalized_mbid": normalized_mbid}
        for item in exact_evidence
        if (normalized_mbid := _normalize_uuid_text(item.get("mbid"))) is not None
    ]
    source_payload = {
        "artist": artist_name,
        "title": title,
        "target_kind": target_kind,
        "evidence": normalized_evidence,
    }
    if not candidates:
        return {
            "mbid": None,
            "mbid_assertion_state": "missing",
            "evidence_source": None,
            "confidence": None,
            "explanation": f"No exact local {target_kind} MBID evidence was provided.",
            "source_payload": source_payload,
        }
    high_confidence = [
        item for item in candidates
        if _safe_float(item.get("confidence")) >= high_confidence_threshold
    ]
    if not high_confidence:
        top = max(candidates, key=lambda item: _safe_float(item.get("confidence")))
        return _non_asserted_local_mbid_classification(
            top,
            state="low_confidence",
            explanation="Exact MBID evidence exists, but no candidate reached the high-confidence threshold.",
            source_payload=source_payload,
        )
    mbids = {str(item["normalized_mbid"]) for item in high_confidence}
    top = max(high_confidence, key=lambda item: _safe_float(item.get("confidence")))
    if len(mbids) > 1:
        return _non_asserted_local_mbid_classification(
            top,
            state="conflicting",
            explanation="Multiple exact high-confidence MBID candidates disagree.",
            source_payload=source_payload,
        )
    if len(high_confidence) > 1:
        return _non_asserted_local_mbid_classification(
            top,
            state="ambiguous",
            explanation="Multiple exact high-confidence evidence rows point to the same MBID.",
            source_payload=source_payload,
        )
    return {
        "mbid": top["normalized_mbid"],
        "mbid_assertion_state": "asserted",
        "evidence_source": _evidence_source(top),
        "confidence": _safe_float(top.get("confidence")),
        "explanation": "Exactly one exact high-confidence MBID candidate was found.",
        "source_payload": source_payload,
    }


def _upsert_local_artist_mbid_projection_sql() -> str:
    return """
        with input_row as (
          select
            %s as artist_key,
            %s as artist_name,
            %s::uuid as mbid,
            %s as mbid_assertion_state,
            %s as evidence_source,
            %s as evidence_confidence,
            %s as scan_run_ref,
            %s::jsonb as metadata
        ),
        bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into library.local_artists (
          library_id,
          artist_key,
          name,
          mbid,
          mbid_assertion_state,
          evidence_source,
          evidence_confidence,
          mbid_assertion_scan_run_ref,
          metadata
        )
        select
          bootstrap_context.library_id,
          input_row.artist_key,
          input_row.artist_name,
          input_row.mbid,
          input_row.mbid_assertion_state,
          input_row.evidence_source,
          input_row.evidence_confidence,
          input_row.scan_run_ref,
          input_row.metadata
        from bootstrap_context
        cross join input_row
        on conflict (library_id, artist_key) do update
          set name = excluded.name,
              mbid = excluded.mbid,
              mbid_assertion_state = excluded.mbid_assertion_state,
              evidence_source = excluded.evidence_source,
              evidence_confidence = excluded.evidence_confidence,
              mbid_assertion_scan_run_ref = excluded.mbid_assertion_scan_run_ref,
              last_seen_at = now(),
              metadata = library.local_artists.metadata || excluded.metadata
        returning 1;
    """


def _insert_local_artist_mbid_assertion_sql() -> str:
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
          where library.local_artists.artist_key = %s
          limit 1
        ),
        proposed_assertion as (
          select
            (select id from artist_match) as artist_id,
            %s::uuid as mbid,
            %s as mbid_assertion_state,
            %s as evidence_source,
            %s as confidence,
            %s as explanation,
            %s as scan_run_ref,
            %s::jsonb as source_payload
          where exists (select 1 from artist_match)
        )
        insert into library.local_artist_mbid_assertions (
          artist_id,
          mbid,
          mbid_assertion_state,
          evidence_source,
          confidence,
          explanation,
          mbid_assertion_scan_run_ref,
          source_payload
        )
        select
          proposed_assertion.artist_id,
          proposed_assertion.mbid,
          proposed_assertion.mbid_assertion_state,
          proposed_assertion.evidence_source,
          proposed_assertion.confidence,
          proposed_assertion.explanation,
          proposed_assertion.scan_run_ref,
          proposed_assertion.source_payload
        from proposed_assertion
        where not exists (
          select 1
          from library.local_artist_mbid_assertions existing
          where existing.artist_id = proposed_assertion.artist_id
            and existing.evidence_source = proposed_assertion.evidence_source
            and existing.mbid is not distinct from proposed_assertion.mbid
            and existing.mbid_assertion_state = proposed_assertion.mbid_assertion_state
            and existing.source_payload = proposed_assertion.source_payload
        )
        returning 1;
    """


def _artist_names_from_album(album: object) -> list[str]:
    names: list[str] = []
    album_artist = str(getattr(album, "album_artist", "") or "").strip()
    if album_artist:
        names.append(album_artist)
    for artist in getattr(album, "artists", []) or []:
        text = str(artist or "").strip()
        if text:
            names.append(text)
    deduped: dict[str, str] = {}
    for name in names:
        deduped.setdefault(local_inventory_key(name), name)
    return list(deduped.values())


def _artist_keys_from_albums(albums: object) -> set[str]:
    return {
        key
        for album in albums or []
        for key in [local_inventory_key(name) for name in _artist_names_from_album(album)]
        if key
    }


def _album_keys(albums: object) -> set[str]:
    return {
        str(getattr(album, "key", "") or "")
        for album in albums or []
        if str(getattr(album, "key", "") or "")
    }


def _scan_run_ref(library_state: dict[str, object]) -> str:
    generation = int(library_state.get("scan_generation") or 0)
    last_scan = library_state.get("last_scan") or 0
    return f"scan-{generation}-{last_scan}"


def _config_value(config: dict[str, object], key: str) -> str | None:
    value = config.get(key)
    if value is None:
        value = os.environ.get(key)
    text = str(value or "").strip()
    return text or None


def _lastfm_available_columns(source: object) -> dict[str, set[str]]:
    rows = source.query_json(
        """
            select
              columns.table_name,
              columns.column_name
            from information_schema.columns as columns
            where columns.table_schema = 'public'
              and columns.table_name in ('artists', 'albums', 'tracks')
        """
    )
    available: dict[str, set[str]] = {"artists": set(), "albums": set(), "tracks": set()}
    for row in rows:
        table_name = str(row.get("table_name") or "").strip()
        column_name = str(row.get("column_name") or "").strip()
        if table_name in available and column_name:
            available[table_name].add(column_name)
    return available


def _lastfm_artist_filter_sql(normalized_artist_names: list[str]) -> str:
    return ", ".join(_sql_literal(name) for name in normalized_artist_names)


def _lastfm_evidence_summary(
    *,
    source_count: int = 0,
    skipped_count: int = 0,
    warning_count: int = 0,
    error_count: int = 0,
    message: str | None = None,
    warning_messages: list[str] | None = None,
    counts: dict[str, int] | None = None,
) -> dict[str, object]:
    summary: dict[str, object] = {
        "source_family": "lastfm_mbid_evidence",
        "source_path": str(Path("lastfm.public")),
        "source_count": source_count,
        "target_count": 0,
        "skipped_count": skipped_count,
        "warning_count": warning_count,
        "error_count": error_count,
        "rows": [],
        "artist_mbid_count": 0,
        "album_mbid_count": 0,
        "track_artist_mbid_count": 0,
        "track_mbid_count": 0,
        "identity_retrieval": {
            "mode": "bounded_literal_filters",
            "safe_punctuation_widening_available": False,
            "limitation": (
                "Safe punctuation widening is unavailable with the current read-only "
                "Last.fm schema."
            ),
        },
    }
    if counts:
        summary.update(counts)
    if message:
        summary["message"] = message
    if warning_messages:
        summary["warning_messages"] = warning_messages
    return summary


def _non_asserted_local_mbid_classification(
    top: dict[str, object],
    *,
    state: str,
    explanation: str,
    source_payload: dict[str, object],
) -> dict[str, object]:
    return {
        "mbid": None,
        "mbid_assertion_state": state,
        "evidence_source": _evidence_source(top),
        "confidence": _safe_float(top.get("confidence")),
        "explanation": explanation,
        "source_payload": source_payload,
    }


def _normalized_artist_mbid_evidence(evidence: list[dict[str, object]]) -> list[dict[str, object]]:
    deduped: dict[str, dict[str, object]] = {}
    for item in evidence:
        if not isinstance(item, dict):
            continue
        normalized_item = dict(item)
        normalized_mbid = _normalize_uuid_text(normalized_item.get("mbid"))
        if normalized_mbid is not None:
            normalized_item["mbid"] = normalized_mbid
        identity = json.dumps(normalized_item, sort_keys=True, separators=(",", ":"), default=str)
        deduped.setdefault(identity, normalized_item)
    return sorted(deduped.values(), key=_artist_mbid_evidence_sort_key)


def _artist_mbid_evidence_sort_key(
    item: dict[str, object],
) -> tuple[int, str, float, str, str, str, str, str, str]:
    normalized_mbid = _normalize_uuid_text(item.get("mbid"))
    mbid_key = normalized_mbid or str(item.get("mbid") or "").strip()
    return (
        0 if normalized_mbid is not None else 1,
        mbid_key,
        -_safe_float(item.get("confidence")),
        _evidence_sort_text(item, "source") or _evidence_sort_text(item, "evidence_source"),
        _evidence_sort_text(item, "artist_name"),
        _evidence_sort_text(item, "album_title"),
        _evidence_sort_text(item, "track_title"),
        _evidence_sort_text(item, "provider_row"),
        json.dumps(item, sort_keys=True, separators=(",", ":"), default=str),
    )


def _evidence_sort_text(item: dict[str, object], key: str) -> str:
    value = item.get(key)
    payload = item.get("payload")
    if (value is None or value == "") and isinstance(payload, dict):
        value = payload.get(key)
    return local_inventory_key(value)


def _evidence_source(item: dict[str, object]) -> str | None:
    return str(item.get("source") or item.get("evidence_source") or "").strip() or None


def _is_artist_mbid_candidate_evidence(item: dict[str, object]) -> bool:
    source = _evidence_source(item)
    return source in TRUE_ARTIST_MBID_EVIDENCE_SOURCES


def _local_match_context_evidence(evidence: list[dict[str, object]]) -> list[dict[str, object]]:
    return [
        item for item in evidence
        if _evidence_source(item) in LOCAL_MATCH_CONTEXT_EVIDENCE_SOURCES
    ]


def _safe_int(value: object, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _normalize_uuid_text(value: object) -> str | None:
    raw_value = str(value or "").strip()
    if not raw_value:
        return None
    try:
        return str(uuid.UUID(raw_value))
    except (AttributeError, ValueError):
        return None


def _resolve_psql_path() -> str:
    path = shutil.which("psql")
    if path:
        return path
    return str(Path(r"C:\PostgreSQL\18\bin\psql.exe"))


def _sql_guard_text(sql: str) -> str:
    chars = list(sql)
    index = 0
    while index < len(chars):
        current = chars[index]
        next_char = chars[index + 1] if index + 1 < len(chars) else ""
        if current == "'":
            chars[index] = " "
            index += 1
            while index < len(chars):
                if chars[index] == "'":
                    chars[index] = " "
                    if index + 1 < len(chars) and chars[index + 1] == "'":
                        chars[index + 1] = " "
                        index += 2
                        continue
                    index += 1
                    break
                chars[index] = " "
                index += 1
            continue
        if current == '"':
            chars[index] = " "
            index += 1
            while index < len(chars):
                if chars[index] == '"':
                    chars[index] = " "
                    if index + 1 < len(chars) and chars[index + 1] == '"':
                        chars[index + 1] = " "
                        index += 2
                        continue
                    index += 1
                    break
                chars[index] = " "
                index += 1
            continue
        if current == "-" and next_char == "-":
            chars[index] = " "
            chars[index + 1] = " "
            index += 2
            while index < len(chars) and chars[index] not in "\r\n":
                chars[index] = " "
                index += 1
            continue
        if current == "/" and next_char == "*":
            chars[index] = " "
            chars[index + 1] = " "
            index += 2
            while index < len(chars):
                if chars[index] == "*" and index + 1 < len(chars) and chars[index + 1] == "/":
                    chars[index] = " "
                    chars[index + 1] = " "
                    index += 2
                    break
                chars[index] = " "
                index += 1
            continue
        index += 1
    return "".join(chars)


def _render_sql(sql: str, params: object | None = None) -> str:
    if params is None:
        return sql
    values = list(params.values()) if isinstance(params, dict) else list(params)
    parts = sql.split("%s")
    placeholder_count = len(parts) - 1
    if placeholder_count != len(values):
        raise ValueError(
            f"SQL placeholder count ({placeholder_count}) does not match parameter count ({len(values)})."
        )
    rendered_parts: list[str] = []
    for index, part in enumerate(parts):
        rendered_parts.append(part)
        if index < len(values):
            rendered_parts.append(_sql_literal(values[index]))
    return "".join(rendered_parts)


def _sql_literal(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, dict | list):
        text = json.dumps(value, sort_keys=True, separators=(",", ":"))
    else:
        text = str(value)
    return "'" + text.replace("'", "''") + "'"
