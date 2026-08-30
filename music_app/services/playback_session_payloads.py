from __future__ import annotations


def normalize_playback_request_origin(payload: object = None) -> dict[str, str]:
    source = payload if isinstance(payload, dict) else {}
    raw_origin = source.get("request_origin")
    request_origin = raw_origin if isinstance(raw_origin, dict) else {}

    client_kind = str(
        request_origin.get("client_kind")
        or source.get("client_kind")
        or "private_web"
    ).strip() or "private_web"
    origin_type = str(
        request_origin.get("origin_type")
        or source.get("origin_type")
        or "browser_tab"
    ).strip() or "browser_tab"
    origin_id = str(
        request_origin.get("origin_id")
        or source.get("origin_id")
        or ""
    ).strip()

    return {
        "client_kind": client_kind,
        "origin_type": origin_type,
        "origin_id": origin_id,
    }


def normalize_playback_track_payload(payload: dict[str, object]) -> dict[str, object]:
    return {
        "artist": str(payload.get("artist") or "").strip(),
        "track": str(payload.get("title") or payload.get("track") or "").strip(),
        "album": str(payload.get("album") or "").strip(),
        "album_artist": str(payload.get("album_artist") or payload.get("albumArtist") or "").strip(),
        "duration": int(payload.get("duration_seconds") or payload.get("duration") or 0) or 0,
        "track_number": str(payload.get("track_number") or payload.get("trackNumber") or "").strip(),
        "timestamp": int(payload.get("started_at_unix") or payload.get("timestamp") or 0) or 0,
        "request_origin": normalize_playback_request_origin(payload),
    }
