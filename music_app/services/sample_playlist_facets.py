"""Bounded, current-library Sample-only facets and explicit Country acquisition.

This owner does not widen generic inventory evidence. Reads never acquire provider
metadata. The separate finite action reauthorizes around (not across) provider I/O.
"""
from collections import Counter
from dataclasses import replace
from datetime import datetime, timezone
from hashlib import sha256
import json
import re
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from music_app.services.owned_playlists import BROWSE, CREATE, PlaylistError, playlist_revision, uuid_ref
from music_app.services.policy import ResourceScope

KEY = "musicbrainz_artist_country_v1"
REFRESH = "library.refresh"
POLICY = "musicbrainz-artist-v1"
PREFIXES = {"styles": "genre-tag:", "countries": "musicbrainz-country:"}
TRIM = "".join(chr(n) for n in (*range(9, 14), *range(28, 33), 0x85, 0xa0, 0x1680,
    *range(0x2000, 0x200b), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000))
ABSENT = object()
_ENVELOPE_KEYS = frozenset(("version", "envelope_revision", "provider", "entity_kind", "library_id",
    "local_artist_id", "canonical_artist_mbid", "identity_basis_digest", "state", "country_token",
    "unknown_reason", "country_field", "captured_at", "evidence_policy", "evidence_digest"))


def too_large():
    raise PlaylistError("source_too_large", 413)


def json_bytes(value, maximum):
    """Encode with an incremental cap, including UTF-8 and JSON escaping."""
    chunks, size = [], 0
    try:
        for chunk in json.JSONEncoder(sort_keys=True, separators=(",", ":"),
                ensure_ascii=False, allow_nan=False).iterencode(value):
            encoded = chunk.encode("utf-8")
            size += len(encoded)
            if size > maximum:
                too_large()
            chunks.append(encoded)
    except (TypeError, ValueError, UnicodeError, OverflowError):
        raise PlaylistError("source_changed", 409) from None
    return b"".join(chunks)


def digest(value):
    return sha256(json_bytes(value, 2097152)).hexdigest()


def scalar(value):
    return type(value) is str and not any(0xd800 <= ord(c) <= 0xdfff for c in value)


def facet_set(value, field, *, wire=False, restricted=True):
    if value is None:
        return None
    if type(value) is not (list if wire else frozenset) or restricted and not value:
        raise ValueError("Invalid Sample facet array")
    if len(value) > 5000:
        raise ValueError("Too many Sample facet identities")
    prefix = PREFIXES[field]
    for item in value:
        if not scalar(item) or not item.startswith(prefix):
            raise ValueError("Invalid Sample facet identity")
        token = item[len(prefix):]
        if not token or token.strip(TRIM) != token or len(token.encode("utf-8")) > 1024:
            raise ValueError("Invalid Sample facet token")
    if wire and (len(set(value)) != len(value) or value != sorted(value)):
        raise ValueError("Noncanonical Sample facet array")
    return frozenset(value)


def decode_options(value):
    from music_app.services.sample_playlist import SampleOptions
    result = dict(value)
    for field in PREFIXES:
        result[field] = facet_set(value[field], field, wire=True)
    return SampleOptions(**result)


def encode_options(options):
    from dataclasses import asdict
    value = asdict(options)
    for field in PREFIXES:
        values = facet_set(getattr(options, field), field)
        value[field] = sorted(values) if values is not None else None
    return value


def active(options):
    return tuple(field for field in PREFIXES if (options.get(field) if type(options) is dict else getattr(options, field, None)) is not None)


def normalize_selector(value, library_id=None):
    from music_app.services import sample_playlist_sources as sources
    if type(value) is not dict:
        raise PlaylistError("invalid_command")
    if set(value) == {"playlist_ref", "revision"}:
        return {"playlist_ref": uuid_ref(value["playlist_ref"]), "revision": playlist_revision(value["revision"])}
    if set(value) == {"origin"}:
        return {"origin": sources.normalize_sample_origin(value["origin"], library_id)}
    raise PlaylistError("invalid_command")


def method(value):
    if value not in ("most_listened", "random"):
        raise PlaylistError("invalid_command")
    return value


def facet_mask(value):
    if type(value) is not list or value not in (["styles"], ["countries"], ["styles", "countries"]):
        raise PlaylistError("invalid_command")
    return tuple(value)


def canonical_uuid(value):
    try:
        return type(value) is str and str(UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def normalize_targets(value, library_id):
    from music_app.services.sample_playlist_sources import sample_inventory_ref
    if type(value) is not list or not 1 <= len(value) <= 25:
        raise PlaylistError("invalid_command")
    seen, result = set(), []
    for item in value:
        if type(item) is not dict or set(item) != {"track_ref", "primary_artist_ref"}:
            raise PlaylistError("invalid_command")
        sample_inventory_ref(item["track_ref"], "track", library_id)
        ref = item["primary_artist_ref"]
        if (type(ref) is not str or not ref.startswith("musicbrainz-artist:")
                or not canonical_uuid(ref[len("musicbrainz-artist:"):]) or item["track_ref"] in seen):
            raise PlaylistError("invalid_command")
        seen.add(item["track_ref"])
        result.append(dict(item))
    return result


def physical_preflight(connection, library_id, track_ids):
    """ID-only pages precede the legacy file SHARE read and both JSON aggregates."""
    counts, total, last = Counter(), 0, 0
    while True:
        limit = min(128, 20001 - total)
        rows = connection.execute("""select f.id,f.track_id from library.local_track_files f
            join library.local_tracks t on t.id=f.track_id
            where t.library_id=%s and f.track_id=any(%s::bigint[]) and f.id>%s
            order by f.id limit %s""", (library_id, track_ids, last, limit)).fetchall()
        for row in rows:
            counts[row["track_id"]] += 1
            total += 1
            if total > 20000 or counts[row["track_id"]] > 64:
                too_large()
        if len(rows) < limit:
            return
        last = rows[-1]["id"]


def identity_document(library_id, row, canonical):
    return {"domain": "sample-country-local-identity-v1", "library_id": str(library_id),
        "local_artist_id": str(row["id"]), "canonical_artist_mbid": canonical,
        "row_mbid": str(row["mbid"]) if row["mbid"] is not None else None,
        "row_assertion_state": row["mbid_assertion_state"], "row_evidence_source": row["evidence_source"]}


def country_field(payload):
    raw = payload.get("country", ABSENT)
    if raw is ABSENT:
        return {"presence": "absent", "value": None}, None
    if raw is None:
        return {"presence": "null", "value": None}, None
    if not scalar(raw) or "\x00" in raw or len(raw.encode("utf-8")) > 1024:
        raise ValueError("Invalid structured artist country")
    token = raw.strip(TRIM) or None
    return {"presence": "string", "value": raw}, token


def evidence_digest(canonical, field):
    return digest({"domain": "sample-country-provider-evidence-v1", "evidence_policy": POLICY,
        "requested_mbid": canonical, "returned_mbid": canonical, "country_field": field})


def normalize_artist_country_response(payload, metadata, identity, now):
    """The sole response adapter; success requires strict artist evidence and ID."""
    canonical = identity["canonical_artist_mbid"]
    if (type(payload) is not dict or payload.get("id") != canonical or type(metadata) is not dict
            or metadata.get("status") not in ("network", "cache") or metadata.get("evidence_policy") != POLICY):
        return None
    try:
        field, token = country_field(payload)
        value = {"version": 1, "envelope_revision": str(uuid4()), "provider": "musicbrainz",
            "entity_kind": "artist", "library_id": identity["library_id"],
            "local_artist_id": identity["local_artist_id"], "canonical_artist_mbid": canonical,
            "identity_basis_digest": digest(identity), "state": "known" if token is not None else "unknown",
            "country_token": token, "unknown_reason": None if token is not None else "provider_omitted_country",
            "country_field": field, "captured_at": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "evidence_policy": POLICY, "evidence_digest": evidence_digest(canonical, field)}
        json_bytes(value, 8192)
        return value
    except (ValueError, TypeError, UnicodeError, PlaylistError):
        return None


def valid_envelope(value, identity):
    if type(value) is not dict or set(value) != _ENVELOPE_KEYS:
        return False
    try:
        json_bytes(value, 8192)
        if (type(value["version"]) is not int or value["version"] != 1
                or not canonical_uuid(value["envelope_revision"]) or value["provider"] != "musicbrainz"
                or value["entity_kind"] != "artist" or value["evidence_policy"] != POLICY
                or value["canonical_artist_mbid"] != identity["canonical_artist_mbid"]
                or value["identity_basis_digest"] != digest(identity)):
            return False
        for name in ("library_id", "local_artist_id"):
            if (type(value[name]) is not str or re.fullmatch(r"[1-9][0-9]{0,18}", value[name]) is None
                    or int(value[name]) > 2**63 - 1 or value[name] != identity[name]):
                return False
        stamp = value["captured_at"]
        if type(stamp) is not str or re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z", stamp) is None:
            return False
        datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S.%fZ")
        field = value["country_field"]
        if type(field) is not dict or set(field) != {"presence", "value"}:
            return False
        presence = field["presence"]
        if presence not in ("absent", "null", "string") or (presence != "string" and field["value"] is not None):
            return False
        if presence == "string" and not scalar(field["value"]):
            return False
        actual, token = country_field({} if presence == "absent" else {"country": field["value"]})
        return (actual == field and value["country_token"] == token
            and value["state"] == ("known" if token is not None else "unknown")
            and value["unknown_reason"] == (None if token is not None else "provider_omitted_country")
            and value["evidence_digest"] == evidence_digest(identity["canonical_artist_mbid"], field))
    except (ValueError, TypeError, UnicodeError, PlaylistError):
        return False


def previous_digest(value):
    return digest({"domain": "sample-country-previous-envelope-v1", "present": value is not ABSENT,
        "envelope": None if value is ABSENT else value})


def _styles(connection, library_id, ids):
    values, malformed = {n: set() for n in ids}, set()
    last, occurrences, byte_count = 0, 0, 0
    while True:
        rows = connection.execute("""select f.id,f.track_id,
            jsonb_typeof(f.metadata->'scan_cache') as cache_type,
            jsonb_typeof(f.metadata#>'{scan_cache,file_entry}') as entry_type,
            jsonb_typeof(f.metadata#>'{scan_cache,file_entry,genre}') as genre_type,
            case when jsonb_typeof(f.metadata#>'{scan_cache,file_entry,genre}')='string'
                then octet_length(f.metadata#>>'{scan_cache,file_entry,genre}') else 0 end as genre_bytes,
            case when jsonb_typeof(f.metadata#>'{scan_cache,file_entry,genre}')='string'
                and octet_length(f.metadata#>>'{scan_cache,file_entry,genre}')<=1024
                then f.metadata#>>'{scan_cache,file_entry,genre}' else null end as genre
            from library.local_track_files f
            join library.local_tracks t on t.id=f.track_id
            join library.library_roots r on r.id=f.library_root_id and r.library_id=t.library_id
            where t.library_id=%s and f.track_id=any(%s::bigint[]) and f.id>%s
                and f.scan_cache_stale is false and r.is_active is true
            order by f.id limit %s""", (library_id, ids, last, 128)).fetchall()
        for row in rows:
            occurrences += 1
            if occurrences > 20000 or row["genre_bytes"] > 1024:
                too_large()
            identity = row["track_id"]
            if row["cache_type"] != "object" or row["entry_type"] != "object" or row["genre_type"] not in (None, "null", "string"):
                malformed.add(identity)
            elif row["genre_type"] == "string":
                raw = row["genre"]
                if not scalar(raw):
                    malformed.add(identity)
                    continue
                token = raw.strip(TRIM)
                byte_count += len(raw.encode("utf-8")) + (len(("genre-tag:" + token).encode("utf-8")) if token else 0)
                if byte_count > 4194304:
                    too_large()
                if token:
                    values[identity].add("genre-tag:" + token)
                    if len(values[identity]) > 64:
                        too_large()
        if len(rows) < 128:
            break
        last = rows[-1]["id"]
    return {identity: (None, "unresolved") if identity in malformed else
        (frozenset(tokens), "known") if tokens else (None, "unknown") for identity, tokens in values.items()}


def _artist_rows(connection, library_id, ids):
    result, byte_count = {}, 0
    for offset in range(0, len(ids), 32):
        rows = connection.execute(f"""select id,mbid::text as mbid,mbid_assertion_state,evidence_source,
            metadata ? '{KEY}' as envelope_present,
            octet_length((metadata->'{KEY}')::text) as envelope_bytes,
            case when octet_length((metadata->'{KEY}')::text)<=8192
                then metadata->'{KEY}' else null end as envelope
            from library.local_artists where library_id=%s and id=any(%s::bigint[]) order by id""",
            (library_id, ids[offset:offset+32])).fetchall()
        for row in rows:
            size = row["envelope_bytes"] or 0
            byte_count += size
            if size > 8192 or byte_count > 2097152:
                too_large()
            result[row["id"]] = dict(row)
    return result


def _allowed(owner, live, action, kind, identity, constraints):
    return owner._resource_allowed(live, action, ResourceScope(kind, str(identity)), constraints) is True


def _require_country_action(owner, live, constraints):
    owner._require(live, (BROWSE, CREATE), constraints)
    if owner._resource_allowed(live, REFRESH, None, constraints) is not True:
        raise PlaylistError("forbidden", 403)


def _hint(owner, live, constraints):
    try:
        _require_country_action(owner, live, constraints)
        return True
    except PlaylistError:
        return False


def _budget_choices(values, prefix):
    choices, byte_count = {}, 0
    for tokens, _state in values.values():
        for token in tokens or ():
            if token in choices:
                continue
            label = token[len(prefix):]
            byte_count += len(token.encode("utf-8")) + len(label.encode("utf-8"))
            if len(choices) >= 1024 or byte_count > 262144:
                too_large()
            choices[token] = label
    return [{"identity": token, "label": choices[token]} for token in sorted(choices)]


def project(owner, connection, live, rows, candidates, diagnostics, fields, constraints, state, *, discovery=False):
    """Shared authoritative projection. Inactive fields do not read metadata."""
    from music_app.services import library_mix_inventory_postgres as inventory
    ids = [c.track_id for c in candidates]
    state.update(values={}, facets={}, bindings={}, artists={}, eligible=set(), unavailable=set())
    hint = _hint(owner, live, constraints) if "countries" in fields else False
    state["enrich_country"] = hint
    groups = {c.track_id: c.primary_artist_ref for c in candidates}
    bindings = inventory.primary_artist_bindings(rows, track_artist_ids=state.get("track_artist_ids", {}))
    state["bindings"] = bindings
    candidate_array_bytes, candidate_array_count = 2, 0
    for field in fields:
        try:
            targets, target_bytes = [], 2
            if field == "styles":
                values = _styles(connection, live.library_id, ids)
            else:
                admitted = sorted({b["local_artist_id"] for track_id, b in bindings.items()
                    if (state.get("target_tracks") is None or track_id in state["target_tracks"])
                    and b["local_artist_id"] is not None and b["primary_artist_ref"] is not None
                    and _allowed(owner, live, BROWSE, "artist", b["local_artist_id"], constraints)})
                artists = _artist_rows(connection, live.library_id, admitted)
                state["artists"] = artists
                values, eligible = {}, set()
                for identity in ids:
                    binding = bindings[identity]
                    row = artists.get(binding["local_artist_id"])
                    value, classification = None, "unresolved"
                    if (row is not None and groups[identity] is not None
                            and binding["primary_artist_ref"] == groups[identity]):
                        doc = identity_document(live.library_id, row, groups[identity].split(":", 1)[1])
                        row.setdefault("identity", doc)
                        envelope = row["envelope"] if row["envelope_present"] else ABSENT
                        valid = envelope is ABSENT or valid_envelope(envelope, doc)
                        row["valid"] = valid
                        if valid and hint and _allowed(owner, live, REFRESH, "artist", row["id"], constraints):
                            eligible.add(row["id"])
                        if valid and envelope is not ABSENT:
                            classification = envelope["state"]
                            if classification == "known":
                                value = frozenset(("musicbrainz-country:" + envelope["country_token"],))
                    values[identity] = (value, classification)
                state["eligible"] = eligible
                seen = set()
                for identity in sorted(ids):
                    binding = bindings[identity]
                    artist = binding["local_artist_id"]
                    if (groups[identity] is not None and binding["primary_artist_ref"] == groups[identity]
                            and artist in eligible and artist not in seen):
                        target = {"track_ref": f"inventory-track:{live.library_id}:{identity}", "primary_artist_ref": groups[identity]}
                        if len(targets) >= 5000:
                            too_large()
                        target_size = len(json_bytes(target, 262144))
                        target_bytes += target_size + bool(targets)
                        if target_bytes > 262144:
                            too_large()
                        targets.append(target)
                        seen.add(artist)
            choices = _budget_choices(values, PREFIXES[field])
            size, count = candidate_array_bytes, candidate_array_count
            for tokens, _classification in values.values():
                size += len(json_bytes(sorted(tokens) if tokens is not None else None, 1048576)) + bool(count)
                if size > 1048576:
                    too_large()
                count += 1
            candidate_array_bytes, candidate_array_count = size, count
            state["values"][field] = values
            coverage = Counter(value[1] for value in values.values())
            state["facets"][field] = {"status": "ready", "choices": choices,
                "coverage": {"candidate_count": len(ids), **{name: coverage[name] for name in ("known", "unknown", "unresolved")}},
                "error": None, "enrichment_targets": targets}
        except PlaylistError as error:
            if error.code != "source_too_large" or not discovery:
                raise
            state["unavailable"].add(field)
            state["facets"][field] = {"status": "unavailable", "choices": [], "coverage": None,
                "error": "source_too_large", "enrichment_targets": []}
    result = []
    for candidate in candidates:
        updates = {}
        for field in fields:
            if field in state["unavailable"]:
                continue
            value, classification = state["values"][field][candidate.track_id]
            updates[field] = value
            if classification != "known":
                diagnostics.append((candidate.track_id, ("style" if field == "styles" else "country") + "_metadata_" + classification))
        result.append(replace(candidate, **updates))
    state["rows"] = rows
    return result


def _prepare(owner, connection, live, selector, selection_method, fields, constraints, *, discovery=False, target_tracks=None):
    from music_app.services import sample_playlist_receipts as receipts
    state = {"selection_method": selection_method, "target_tracks": target_tracks}
    snapshot, identities, finish = receipts._prepare_snapshot(owner, connection, live,
        **selector, selection_method=selection_method, include_observations=False,
        constraints=constraints, facet_fields=fields, facet_state=state, facet_discovery=discovery)
    return snapshot, state, finish


def _artist_fences(owner, live, state, constraints):
    for identity in state["artists"]:
        if not _allowed(owner, live, BROWSE, "artist", identity, constraints):
            raise PlaylistError("source_unavailable", 404)


def read_sample_facets(owner, context, selector, selection_method, fields, constraints=None):
    selector = normalize_selector(selector, context.library_id)
    selection_method, fields = method(selection_method), facet_mask(fields)
    with owner._authorized(context, constraints) as (connection, live, _now):
        owner._require(live, (BROWSE, CREATE), constraints)
        _snapshot, state, finish = _prepare(owner, connection, live, selector, selection_method,
            fields, constraints, discovery=True)
        finish()
        _artist_fences(owner, live, state, constraints)
        result = {"status": "ready", "data": {"selection_method": selection_method,
            "facets": state["facets"], "allowed_actions": {"enrich_country": state["enrich_country"]}}}
        json_bytes(result, 524288)
        return result


def association_digest(snapshot, state, selector, selection_method):
    from music_app.services import library_mix_inventory_postgres as inventory
    values = []
    for row in sorted(state["rows"], key=lambda r: r["original_local_track_id"]):
        identity = row["original_local_track_id"]
        if identity not in state["bindings"]:
            continue
        binding = state["bindings"][identity]
        values.append({"track_id": str(identity),
            "album_id": str(row["original_album_id"]) if row["original_album_id"] is not None else None,
            "local_artist_id": str(binding["local_artist_id"]) if binding["local_artist_id"] is not None else None,
            "primary_artist_ref": binding["primary_artist_ref"], "basis": binding["basis"],
            "inventory_revision": inventory.inventory_revision(row),
            "mapping_revision": str(row["mapping_revision"]) if row["mapping_revision"] is not None else None})
    return digest({"domain": "sample-country-association-v1", "selector": selector,
        "selection_method": selection_method, "membership_digest": snapshot.membership_digest,
        "origin_proof_digest": digest(snapshot.origin_proof) if hasattr(snapshot, "origin_proof") else None,
        "bindings": values})


def _target_row(state, target, library_id):
    from music_app.services.sample_playlist_sources import sample_inventory_ref
    identity = sample_inventory_ref(target["track_ref"], "track", library_id)[1]
    binding = state["bindings"].get(identity)
    if binding is None or binding["primary_artist_ref"] != target["primary_artist_ref"]:
        return None
    row = state["artists"].get(binding["local_artist_id"])
    if row is None or row["id"] not in state["eligible"] or not row.get("valid"):
        return None
    return row


class _TargetOutcome(Exception):
    def __init__(self, status):
        self.status = status


def _action_fences(owner, live, row, constraints, finish, should_cancel):
    _require_country_action(owner, live, constraints)
    if any(not _allowed(owner, live, action, "artist", row["id"], constraints) for action in (BROWSE, REFRESH)):
        raise PlaylistError("source_unavailable", 404)
    finish()
    if should_cancel():
        raise _TargetOutcome("cancelled")


def enrich_sample_country_metadata(owner, context, selector, selection_method, targets,
                                   constraints=None, should_cancel=None):
    """One explicit action, 1–25 targets, no retry queue and no provider I/O in a transaction."""
    from music_app.services import musicbrainz_http
    selector = normalize_selector(selector, context.library_id)
    selection_method = method(selection_method)
    targets = normalize_targets(targets, context.library_id)
    from music_app.services.sample_playlist_sources import sample_inventory_ref
    target_tracks = {sample_inventory_ref(t["track_ref"], "track", context.library_id)[1] for t in targets}
    cancel = should_cancel if callable(should_cancel) else lambda: False
    # Batch admission is complete before the first provider call. JSON null is
    # present malformed evidence, not absence and not a refresh grant.
    with owner._authorized(context, constraints) as (connection, live, _now):
        _require_country_action(owner, live, constraints)
        snapshot, state, finish = _prepare(owner, connection, live, selector, selection_method,
            ("countries",), constraints, discovery=True, target_tracks=target_tracks)
        proof = association_digest(snapshot, state, selector, selection_method)
        initial, seen = [], set()
        for target in targets:
            row = _target_row(state, target, live.library_id)
            if row is None or state["unavailable"]:
                raise PlaylistError("source_unavailable", 404)
            if row["id"] in seen:
                raise PlaylistError("invalid_command")
            seen.add(row["id"])
            initial.append(dict(row))
        finish()
        _artist_fences(owner, live, state, constraints)
    results, stopped = [], False
    for target, admitted in zip(targets, initial):
        status = "not_attempted"
        if stopped:
            results.append({**target, "status": status})
            continue
        if cancel():
            status, stopped = "cancelled", True
            results.append({**target, "status": status})
            continue
        current_target_tracks = {sample_inventory_ref(target["track_ref"], "track", context.library_id)[1]}
        try:
            with owner._authorized(context, constraints) as (connection, live, _now):
                _require_country_action(owner, live, constraints)
                snapshot, state, finish = _prepare(owner, connection, live, selector, selection_method,
                    ("countries",), constraints, discovery=True, target_tracks=current_target_tracks)
                if association_digest(snapshot, state, selector, selection_method) != proof:
                    raise _TargetOutcome("source_changed")
                row = _target_row(state, target, live.library_id)
                if row is None or state["unavailable"]:
                    raise _TargetOutcome("unresolved")
                previous = row["envelope"] if row["envelope_present"] else ABSENT
                previous_hash = previous_digest(previous)
                identity = row["identity"]
                _action_fences(owner, live, row, constraints, finish, cancel)
            if cancel():
                raise _TargetOutcome("cancelled")
            user_agent = owner._config.get("MUSICBRAINZ_USER_AGENT") or musicbrainz_http.default_user_agent(owner._config.get("APP_NAME"),
                owner._config.get("APP_VERSION"), owner._config.get("MUSICBRAINZ_CONTACT_EMAIL"))
            payload, metadata = musicbrainz_http.get_artist_json(identity["canonical_artist_mbid"],
                user_agent, should_cancel=cancel)
            if cancel():
                raise _TargetOutcome("cancelled")
            proposed = normalize_artist_country_response(payload, metadata, identity, owner._clock())
            with owner._authorized(context, constraints) as (connection, live, _now):
                _require_country_action(owner, live, constraints)
                if proposed is None:
                    raise _TargetOutcome("unresolved")
                connection.execute("select pg_advisory_xact_lock(hashtext('album-haven:sample-country-v1'),hashtext(%s))",
                    (str(live.library_id),)).fetchone()
                snapshot, state, finish = _prepare(owner, connection, live, selector, selection_method,
                    ("countries",), constraints, discovery=True, target_tracks=current_target_tracks)
                if association_digest(snapshot, state, selector, selection_method) != proof:
                    raise _TargetOutcome("source_changed")
                row = _target_row(state, target, live.library_id)
                if row is None or state["unavailable"]:
                    raise _TargetOutcome("unresolved")
                try:
                    locked = connection.execute("""select id from library.local_artists
                        where library_id=%s and id=%s for update nowait""",
                        (live.library_id, row["id"])).fetchone()
                except Exception as error:
                    if getattr(error, "sqlstate", None) == "55P03":
                        raise _TargetOutcome("concurrent_change") from None
                    raise
                if locked is None:
                    raise _TargetOutcome("source_changed")
                # Reread the exact guarded reserved key after the upgrade.
                try:
                    current = _artist_rows(connection, live.library_id, [row["id"]])[row["id"]]
                except PlaylistError as error:
                    if error.code == "source_too_large":
                        raise _TargetOutcome("unresolved") from None
                    raise
                current_identity = identity_document(live.library_id, current, identity["canonical_artist_mbid"])
                if current_identity != identity:
                    raise _TargetOutcome("source_changed")
                envelope = current["envelope"] if current["envelope_present"] else ABSENT
                if envelope is not ABSENT and not valid_envelope(envelope, current_identity):
                    raise _TargetOutcome("unresolved")
                identical = envelope is not ABSENT and envelope["evidence_digest"] == proposed["evidence_digest"]
                _action_fences(owner, live, row, constraints, finish, cancel)
                if identical:
                    status = "unchanged"
                else:
                    if previous_digest(envelope) != previous_hash:
                        raise _TargetOutcome("concurrent_change")
                    proposed = {**proposed, "envelope_revision": str(uuid4()),
                        "captured_at": owner._clock().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}
                    envelope_bytes = connection.execute(
                        "select octet_length(%s::jsonb::text) as envelope_bytes",
                        (Jsonb(proposed),)).fetchone()["envelope_bytes"]
                    if envelope_bytes > 8192:
                        raise _TargetOutcome("unresolved")
                    predicate = f"not (metadata ? '{KEY}')" if previous is ABSENT else f"metadata->'{KEY}'=%s::jsonb"
                    params = [Jsonb({KEY: proposed}), live.library_id, row["id"]]
                    if previous is not ABSENT:
                        params.append(Jsonb(previous))
                    written = connection.execute(f"""update library.local_artists
                        set metadata=metadata||%s where library_id=%s and id=%s and {predicate}
                        returning id""", tuple(params)).fetchall()
                    if len(written) != 1:
                        raise _TargetOutcome("concurrent_change")
                    status = "stored_" + proposed["state"]
                # Includes the no-op branch: final source, resource, action and
                # actor/session fences must survive, and cancellation rolls back.
                _action_fences(owner, live, row, constraints, finish, cancel)
        except _TargetOutcome as outcome:
            status = outcome.status
            stopped = status == "cancelled"
        results.append({**target, "status": status})
    return {"status": "ready", "data": {"selection_method": selection_method, "results": results}}
