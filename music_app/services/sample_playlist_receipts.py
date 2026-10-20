"""Bounded Sample receipts and the dedicated same-transaction Save validator.

Ranking is captured history. Reads reauthorize the parent and used identity facts
without rereading observations, evaluating a selection or renewing the receipt.
"""
from collections import Counter
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import json
from math import isfinite
import re

from psycopg.types.json import Jsonb

from music_app.services import sample_playlist as evaluator
from music_app.services import sample_playlist_facets as facets
from music_app.services import sample_playlist_sources as snapshots
from music_app.services import playlist_complete_sources as complete
from music_app.services import playlist_creation_sources_postgres as sources
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.owned_playlists import (
    BROWSE, CREATE, MAX_PLAYLIST_COMMAND_BYTES, MAX_PLAYLIST_ITEMS_PER_COMMAND,
    PlaylistError, evidence_digest, playlist_revision, uuid_ref,
)
from music_app.services.policy import ResourceScope
from music_app.services.popularity_snapshots import PopularityObservation, validate_observation

SAMPLE_PROTOCOL = "sample_playlist_selection_v1"
_MAX_BYTES = 2097152
_MAX_ITEMS = MAX_PLAYLIST_ITEMS_PER_COMMAND
_TOP_KEYS = frozenset(("version", "request", "request_digest", "membership_digest",
    "facts", "facts_digest", "ranking", "ranking_digest", "result", "result_digest",
    "source_diagnostics"))
_OPTION_KEYS = frozenset(("selection_basis", "songs_per_group", "unknown_facets",
    "selection_method", "length", "styles", "countries"))
_FACT_KEYS = frozenset(("track_id", "canonical_recording_id", "recording_evidence",
    "album_ref", "primary_artist_ref", "source_position", "disc_number", "track_number",
    "duration_seconds", "styles", "countries", "inventory_digest", "identity_evidence"))
_MAPPING_KEYS = frozenset(("track_id", "mapping_revision", "provider", "source_entity_id",
    "canonical_recording_id", "recording_evidence", "canonical_artist_id", "artist_evidence"))
_OBSERVATION_KEYS = frozenset(("provider", "metric", "source_entity_id", "source_revision",
    "observed_at", "imported_at", "count", "attribution_state"))
_RESULT_KEYS = frozenset(("track_ids", "entry_order", "random_order", "diagnostics", "group_counts"))
_HASH = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)


def _changed():
    raise PlaylistError("source_changed", 409)


def _require(condition):
    if not condition:
        _changed()


def _keys(value, keys):
    _require(type(value) is dict and set(value) == set(keys))


def _integer(value, minimum=1, maximum=2**63 - 1):
    return type(value) is int and minimum <= value <= maximum


def _text(value):
    return type(value) is str and bool(value.strip())


def _hash(value):
    return type(value) is str and _HASH.fullmatch(value) is not None


def _uuid(value):
    try:
        _require(uuid_ref(value) == value)
    except PlaylistError:
        _changed()


def _array(value, maximum, *, nullable=False):
    if nullable and value is None:
        return
    _require(type(value) is list)
    if len(value) > maximum:
        raise PlaylistError("source_too_large", 413)


def _duration_value(value):
    if value is None:
        return None
    if type(value) is int and value >= 0:
        return {"type": "int", "value": str(value)}
    if type(value) is float and isfinite(value) and value >= 0:
        return {"type": "float", "value": value.hex()}
    if type(value) is Decimal and value.is_finite() and value >= 0:
        parts = value.as_tuple()
        return {"type": "decimal", "sign": parts.sign,
                "digits": list(parts.digits), "exponent": parts.exponent}
    _changed()


def _duration_from_value(value):
    if value is None:
        return None
    _require(type(value) is dict)
    try:
        kind = value.get("type")
        if kind in ("int", "float"):
            _keys(value, ("type", "value"))
            _require(type(value["value"]) is str)
            result = int(value["value"]) if kind == "int" else float.fromhex(value["value"])
        elif kind == "decimal":
            _keys(value, ("type", "sign", "digits", "exponent"))
            _require(_integer(value["sign"], 0, 1) and type(value["exponent"]) is int)
            _array(value["digits"], _MAX_BYTES)
            _require(bool(value["digits"]) and all(_integer(n, 0, 9) for n in value["digits"]))
            result = Decimal((value["sign"], tuple(value["digits"]), value["exponent"]))
        else:
            _changed()
        _require(_duration_value(result) == value)
        return result
    except (ValueError, TypeError, OverflowError, InvalidOperation):
        _changed()


def _utc_timestamp(value):
    if not isinstance(value, datetime) or value.utcoffset() is None:
        _changed()
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _json_bytes(value, maximum):
    return facets.json_bytes(value, maximum)


def _digest(domain, value):
    return evidence_digest({"domain": domain, "value": value})


def _request(playlist_ref, revision, options, random_order, origin=None):
    evaluator._validate_options(options)
    if random_order is not None:
        if type(random_order) is not tuple or any(not _integer(n) for n in random_order):
            raise PlaylistError("invalid_command")
        if len(random_order) > _MAX_ITEMS:
            raise PlaylistError("source_too_large", 413)
    if origin is not None:
        if playlist_ref is not None or revision is not None:
            raise PlaylistError("invalid_command")
        value = {"origin": snapshots.normalize_sample_origin(origin), "options": facets.encode_options(options),
                 "random_order": list(random_order) if random_order is not None else None}
    else:
        value = {"playlist_ref": uuid_ref(playlist_ref), "revision": playlist_revision(revision),
                 "options": facets.encode_options(options), "random_order": list(random_order) if random_order is not None else None}
    _json_bytes(value, MAX_PLAYLIST_COMMAND_BYTES)
    return value


def _mapping(value, track_id):
    if value is None:
        return
    _keys(value, _MAPPING_KEYS)
    _require(_integer(value["track_id"]) and value["track_id"] == track_id)
    _require(value["provider"] == "lastfm")
    _require(_text(value["mapping_revision"]) and _text(value["source_entity_id"]))
    for identity, evidence in (("canonical_recording_id", "recording_evidence"),
                               ("canonical_artist_id", "artist_evidence")):
        if value[identity] is None:
            _require(value[evidence] is None)
        else:
            _uuid(value[identity])
            _require(_text(value[evidence]))


def _assertion(value):
    if value is not None:
        _keys(value, ("canonical_id", "source"))
        _uuid(value["canonical_id"])
        _require(_text(value["source"]))


def _fact(value):
    _keys(value, _FACT_KEYS)
    _require(_integer(value["track_id"]) and _integer(value["source_position"], 0))
    for name in ("disc_number", "track_number"):
        _require(value[name] is None or _integer(value[name], 1, 2**31 - 1))
    if value["canonical_recording_id"] is None:
        _require(value["recording_evidence"] is None)
    else:
        _uuid(value["canonical_recording_id"])
        _require(_text(value["recording_evidence"]))
    for name in ("album_ref", "primary_artist_ref"):
        _require(value[name] is None or _text(value[name]))
    _duration_from_value(value["duration_seconds"])
    try:
        for field in ("styles", "countries"):
            decoded = facets.facet_set(value[field], field, wire=True, restricted=False)
            _require(field != "countries" or decoded is None or len(decoded) <= 1)
    except ValueError:
        _changed()
    _require(_hash(value["inventory_digest"]))
    identity = value["identity_evidence"]
    _keys(identity, ("mapping", "asserted_recording", "asserted_track_artist"))
    _mapping(identity["mapping"], value["track_id"])
    _assertion(identity["asserted_recording"])
    _assertion(identity["asserted_track_artist"])
    mapped = identity["mapping"]
    asserted = identity["asserted_recording"]
    if mapped is not None and mapped["canonical_recording_id"] is not None:
        _require(value["canonical_recording_id"] == mapped["canonical_recording_id"]
                 and value["recording_evidence"] == mapped["recording_evidence"] and asserted is None)
    elif asserted is not None:
        _require(value["canonical_recording_id"] == asserted["canonical_id"]
                 and value["recording_evidence"] == asserted["source"])
    else:
        _require(value["canonical_recording_id"] is None)


def _ranking(value, fact):
    _keys(value, ("track_id", "mapping", "popularity"))
    _require(_integer(value["track_id"]) and value["track_id"] == fact["track_id"])
    _mapping(value["mapping"], value["track_id"])
    _require(value["mapping"] == fact["identity_evidence"]["mapping"])
    popularity = value["popularity"]
    if popularity is None:
        return
    _keys(popularity, ("local_track_id", "mapping_revision", "observation"))
    mapping = value["mapping"]
    _require(mapping is not None and _integer(popularity["local_track_id"])
             and popularity["local_track_id"] == value["track_id"]
             and popularity["mapping_revision"] == mapping["mapping_revision"])
    observation = popularity["observation"]
    _keys(observation, _OBSERVATION_KEYS)
    _require(observation["provider"] == mapping["provider"]
             and observation["source_entity_id"] == mapping["source_entity_id"])
    try:
        decoded = dict(observation)
        for name in ("observed_at", "imported_at"):
            _require(type(observation[name]) is str)
            decoded[name] = datetime.fromisoformat(observation[name])
            _require(_utc_timestamp(decoded[name]) == observation[name])
        validate_observation(PopularityObservation(**decoded))
    except (TypeError, ValueError, OverflowError):
        _changed()


def _order(fact):
    return (fact["source_position"], fact["disc_number"] is None, fact["disc_number"] or 0,
            fact["track_number"] is None, fact["track_number"] or 0, fact["track_id"])


def _descriptor_parts(value):
    """Validate scalar/shape/cardinality/digests, also for an uncommitted header."""
    _require(type(value) is dict and type(value.get("version")) is int and value["version"] in (1, 2))
    typed = value["version"] == 2
    _keys(value, _TOP_KEYS | {"origin_proof"} if typed else _TOP_KEYS)
    _keys(value["request"], ("origin", "options", "random_order") if typed else ("playlist_ref", "revision", "options", "random_order"))
    if typed:
        _keys(value["origin_proof"], ("kind", "members"))
        _array(value["origin_proof"]["members"], _MAX_ITEMS)
    _keys(value["result"], _RESULT_KEYS)
    request, result = value["request"], value["result"]
    _keys(request["options"], _OPTION_KEYS)
    # Bounds precede deeper associations, duplicate checks and digest work.
    for array, maximum, nullable in (
        (value["facts"], _MAX_ITEMS, False), (value["ranking"], _MAX_ITEMS, True),
        (request["random_order"], _MAX_ITEMS, True), (result["track_ids"], _MAX_ITEMS, False),
        (result["entry_order"], _MAX_ITEMS, False), (result["random_order"], _MAX_ITEMS, True),
        (result["group_counts"], _MAX_ITEMS, False), (result["diagnostics"], 4 * _MAX_ITEMS, False),
        (value["source_diagnostics"], _MAX_ITEMS * (1 + len(facets.active(request["options"]))), False)):
        _array(array, maximum, nullable=nullable)
    _require(_hash(value["membership_digest"]))
    try:
        if typed:
            _require(snapshots.normalize_sample_origin(request["origin"]) == request["origin"])
        else:
            _uuid(request["playlist_ref"])
            _require(playlist_revision(request["revision"]) == request["revision"])
        _keys(request["options"], _OPTION_KEYS)
        options = facets.decode_options(request["options"])
        evaluator._validate_options(options)
    except PlaylistError as error:
        if error.status_code == 413:
            raise
        _changed()
    except (TypeError, ValueError):
        _changed()
    random = options.selection_method == "random"
    _require((request["random_order"] is not None) == random)
    if result["random_order"] is not None:
        _require(all(_integer(identity) for identity in result["random_order"]))
    _require(result["random_order"] == request["random_order"])
    _require((value["ranking"] is None) == random and (value["ranking_digest"] is None) == random)
    facts = value["facts"]
    for fact in facts:
        _fact(fact)
    ids = [fact["track_id"] for fact in facts]
    _require(len(set(ids)) == len(ids))
    _require(facts == sorted(facts, key=lambda fact: (fact["source_position"], fact["track_id"])))
    if not random:
        _require(len(value["ranking"]) == len(facts))
        for rank, fact in zip(value["ranking"], facts):
            _ranking(rank, fact)
    for name in ("request", "facts", "ranking", "result"):
        if name == "ranking" and random:
            continue
        _require(_hash(value[name + "_digest"]))
        try:
            _require(value[name + "_digest"] == _digest("request_v2" if typed and name == "request" else name + "_v1", value[name]))
        except (TypeError, ValueError, OverflowError):
            _changed()
    selected = result["track_ids"]
    _require(all(_integer(identity) for identity in selected) and len(set(selected)) == len(selected))
    _require(set(selected).issubset(ids))
    for ref in result["entry_order"]:
        _uuid(ref)
    _require(len(set(result["entry_order"])) == len(result["entry_order"]))
    if random:
        order = request["random_order"]
        _require(all(_integer(identity) for identity in order) and len(set(order)) == len(order))
        _require(set(order).issubset(ids) and set(selected).issubset(order))
        _require([identity for identity in order if identity in set(selected)] == selected)
    by_id = {fact["track_id"]: fact for fact in facts}
    recording_ids = [by_id[identity]["canonical_recording_id"] for identity in selected]
    _require(None not in recording_ids and len(set(recording_ids)) == len(recording_ids))
    group_field = "album_ref" if options.selection_basis == "per_album" else "primary_artist_ref"
    groups = list(dict.fromkeys(fact[group_field] for fact in sorted(facts, key=_order) if fact[group_field] is not None))
    counts = Counter(by_id[identity][group_field] for identity in selected)
    _require(None not in counts)
    for group in result["group_counts"]:
        _require(type(group) is list and len(group) == 2 and _text(group[0])
                 and _integer(group[1], 0, _MAX_ITEMS) and group[1] <= options.songs_per_group)
    _require(result["group_counts"] == [[group, counts[group]] for group in groups])
    for diagnostics in (result["diagnostics"], value["source_diagnostics"]):
        for item in diagnostics:
            _require(type(item) is list and len(item) == 2 and _integer(item[0])
                     and item[0] in by_id and _text(item[1]))
    _require(result["diagnostics"] == sorted(result["diagnostics"], key=lambda item: (_order(by_id[item[0]]), item[1])))
    _require(value["source_diagnostics"] == sorted(value["source_diagnostics"]))
    categories = {"ambiguous_attribution": "mapping", "missing_recording_identity": "mapping",
        "missing_provider_mapping": "mapping", "provider_unavailable": "mapping",
        "missing_canonical_recording": "mapping"}
    for field in facets.active(options):
        prefix = "style" if field == "styles" else "country"
        categories.update({prefix + "_metadata_" + state: field for state in ("unknown", "unresolved")})
    seen_diagnostics, admitted_ids = set(), set(ids)
    for identity, reason in value["source_diagnostics"]:
        _require(identity in admitted_ids and reason in categories)
        key = (identity, categories[reason])
        _require(key not in seen_diagnostics)
        seen_diagnostics.add(key)
    for fact in facts:
        for field in ("styles", "countries"):
            if field not in facets.active(options):
                _require(fact[field] is None)
            elif fact[field] is not None:
                _require((fact["track_id"], field) not in seen_diagnostics)
            else:
                _require((fact["track_id"], field) in seen_diagnostics)
    if typed:
        _origin_proof(value)
    return options


def _origin_proof(value):
    proof, origin = value["origin_proof"], value["request"]["origin"]
    _keys(proof, ("kind", "members"))
    _require(proof["kind"] == origin["kind"])
    members = proof["members"]
    _array(members, _MAX_ITEMS)
    occurrences, libraries, item_refs = [], set(), set()
    for index, member in enumerate(members):
        _keys(member, ("index", "item_ref", "catalog_ref", "remote_admission_ref", "inventory_album_ref", "track_refs", "omission"))
        _require(type(member["index"]) is int and member["index"] == index)
        _array(member["track_refs"], _MAX_ITEMS)
        occurrences.extend(member["track_refs"])
        if len(occurrences) > _MAX_ITEMS:
            raise PlaylistError("source_too_large", 413)
        _require(member["omission"] in (None, "remote_summary", "unavailable", "ambiguous_edition", "tracks_unavailable"))
        for name in ("item_ref", "catalog_ref", "remote_admission_ref"):
            if member[name] is not None:
                _uuid(member[name])
        try:
            if member["inventory_album_ref"] is not None:
                library, _identity = snapshots.sample_inventory_ref(member["inventory_album_ref"], "album")
                libraries.add(library)
            for ref in member["track_refs"]:
                library, _identity = snapshots.sample_inventory_ref(ref, "track")
                libraries.add(library)
        except PlaylistError:
            _changed()
        _require(len(set(member["track_refs"])) == len(member["track_refs"]))
        if proof["kind"] == "album_top":
            _require(member["item_ref"] is not None and member["catalog_ref"] is not None and member["item_ref"] not in item_refs)
            item_refs.add(member["item_ref"])
            if member["remote_admission_ref"] is not None:
                _require(member["omission"] == "remote_summary" and member["inventory_album_ref"] is None and not member["track_refs"])
            elif member["inventory_album_ref"] is None:
                _require(member["omission"] in ("unavailable", "ambiguous_edition") and not member["track_refs"])
            else:
                _require(member["omission"] == (None if member["track_refs"] else "tracks_unavailable"))
        else:
            _require(all(member[name] is None for name in ("item_ref", "catalog_ref", "remote_admission_ref")))
            if proof["kind"] == "album_set":
                _require(len(members) == len(origin["selections"]))
                selector = origin["selections"][index]
                if selector["kind"] == "unavailable":
                    _require(member["inventory_album_ref"] is None and not member["track_refs"] and member["omission"] == "unavailable")
                else:
                    _require(member["inventory_album_ref"] == selector["inventory_album_ref"]
                        and member["omission"] == (None if member["track_refs"] else "tracks_unavailable"))
            else:
                _require(len(members) == len(origin["track_refs"]) and member["inventory_album_ref"] is None
                    and member["track_refs"] == [origin["track_refs"][index]] and member["omission"] is None)
    if proof["kind"] == "album_set":
        _require(len(members) == len(origin["selections"]))
    elif proof["kind"] == "album_details":
        _require(len(members) == len(origin["track_refs"]))
    _require(len(libraries) <= 1)
    positions, albums = {}, {}
    position = 0
    for member in members:
        for ref in member["track_refs"]:
            identity = snapshots.sample_inventory_ref(ref, "track")[1]
            positions.setdefault(identity, position)
            if member["inventory_album_ref"] is not None:
                albums.setdefault(identity, member["inventory_album_ref"])
                _require(albums[identity] == member["inventory_album_ref"])
            position += 1
    for fact in value["facts"]:
        _require(fact["track_id"] in positions and fact["source_position"] == positions[fact["track_id"]])
        if fact["track_id"] in albums:
            _require(fact["album_ref"] == albums[fact["track_id"]])
    _require(value["membership_digest"] == _digest("membership_v2", proof))


def _prepare_snapshot(owner, connection, live, **arguments):
    if "origin" in arguments:
        return snapshots._prepare_origin_snapshot(owner, connection, live, **arguments)
    return snapshots._prepare_sample_snapshot(owner, connection, live, **arguments)


@contextmanager
def _snapshot(owner, connection, live, **arguments):
    if "origin" not in arguments:
        with snapshots._playlist_sample_snapshot(owner, connection, live, **arguments) as result:
            yield result
        return
    snapshot, identities, finish = _prepare_snapshot(owner, connection, live, **arguments)
    yield snapshot, identities
    finish()


def _validate_descriptor_shape(descriptor):
    _descriptor_parts(descriptor)
    _require(len(descriptor["result"]["entry_order"]) == len(descriptor["result"]["track_ids"]))


def _identity_payload(identity):
    def asserted(value):
        return {"canonical_id": value[0], "source": value[1]} if value is not None else None
    return {"mapping": asdict(identity.mapping) if identity.mapping is not None else None,
            "asserted_recording": asserted(identity.asserted_recording),
            "asserted_track_artist": asserted(identity.asserted_track_artist)}


def _facts(snapshot, identities):
    evidence = {item.track_id: item for item in identities}
    digests = dict(snapshot.inventory_digests)
    result = []
    for candidate in snapshot.candidates:
        # Deliberately enumerate non-popularity fields: Random never inspects cache.
        item = {name: getattr(candidate, name) for name in (
            "track_id", "canonical_recording_id", "recording_evidence", "album_ref",
            "primary_artist_ref", "source_position", "disc_number", "track_number")}
        item.update(duration_seconds=_duration_value(candidate.duration_seconds),
                    styles=sorted(candidate.styles) if candidate.styles is not None else None,
                    countries=sorted(candidate.countries) if candidate.countries is not None else None,
                    inventory_digest=digests[candidate.track_id],
                    identity_evidence=_identity_payload(evidence[candidate.track_id]))
        result.append(item)
    return result


def _descriptor(request, snapshot, identities, selection):
    facts = _facts(snapshot, identities)
    ranking = None
    if request["options"]["selection_method"] == "most_listened":
        ranking = []
        for candidate, fact in zip(snapshot.candidates, facts):
            popularity = asdict(candidate.popularity) if candidate.popularity is not None else None
            if popularity is not None:
                for name in ("observed_at", "imported_at"):
                    popularity["observation"][name] = _utc_timestamp(popularity["observation"][name])
            ranking.append({"track_id": candidate.track_id,
                            "mapping": fact["identity_evidence"]["mapping"], "popularity": popularity})
    result = {"track_ids": list(selection.track_ids), "entry_order": [],
              "random_order": list(selection.random_order) if selection.random_order is not None else None,
              "diagnostics": [list(item) for item in selection.diagnostics],
              "group_counts": [list(item) for item in selection.group_counts]}
    typed = "origin" in request
    value = {"version": 2 if typed else 1, "request": request, "membership_digest": snapshot.membership_digest,
             "facts": facts, "ranking": ranking, "result": result,
             "source_diagnostics": [list(item) for item in snapshot.diagnostics]}
    if typed:
        value["origin_proof"] = snapshot.origin_proof
    for name in ("request", "facts", "ranking", "result"):
        value[name + "_digest"] = None if name == "ranking" and ranking is None else _digest(
            "request_v2" if typed and name == "request" else name + "_v1", value[name])
    return value


def _preflight(connection, descriptor):
    _json_bytes(descriptor, _MAX_BYTES)
    _descriptor_parts(descriptor)
    size = connection.execute("select octet_length(%s::jsonb::text) as receipt_bytes",
                              (Jsonb(descriptor),)).fetchone()["receipt_bytes"]
    if size > _MAX_BYTES:
        raise PlaylistError("source_too_large", 413)


def _fresh(owner, connection, live, source):
    now = lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                                    actor_session_id=live.actor.session_id, clock=owner._clock)
    if source["expires_at"] <= now:
        raise PlaylistError("source_expired", 410)
    return now


def _lookup(owner, connection, live, ref, *, revision=None, capture=False):
    row = connection.execute("""select * from app.playlist_creation_sources
        where ref=%s and actor_account_id=%s and session_id=%s and library_id=%s for share""",
        (ref, live.actor.account_id, live.actor.session_id, live.library_id)).fetchone()
    if row is None:
        if capture and connection.execute("select ref from app.playlist_creation_sources where ref=%s", (ref,)).fetchone() is None:
            return None
        raise PlaylistError("source_unavailable", 404)
    if row["protocol"] != SAMPLE_PROTOCOL or row["source_kind"] not in ("playlist", "library"):
        raise PlaylistError("source_unavailable" if capture else "source_changed", 404 if capture else 409)
    source = sources.load_source(connection, live, ref, revision or str(row["revision"]), owner._clock(),
                                 protocol=SAMPLE_PROTOCOL, kind=row["source_kind"])
    _fresh(owner, connection, live, source)
    return source


def _current_facts(descriptor, snapshot, identities):
    _require(descriptor["membership_digest"] == snapshot.membership_digest)
    current = _facts(snapshot, identities)
    old = descriptor["facts"]
    _require([item["track_id"] for item in old] == [item["track_id"] for item in current])
    options = descriptor["request"]["options"]
    group = "album_ref" if options["selection_basis"] == "per_album" else "primary_artist_ref"
    fields = ("canonical_recording_id", group, "source_position", "disc_number", "track_number")
    active_fields = facets.active(options)
    if "countries" in active_fields:
        fields += ("primary_artist_ref",)
    prefixes = tuple("style_metadata_" if field == "styles" else "country_metadata_" for field in active_fields)
    _require([item for item in descriptor["source_diagnostics"] if item[1].startswith(prefixes)] ==
        [list(item) for item in snapshot.diagnostics if item[1].startswith(prefixes)])
    for captured, actual in zip(old, current):
        _require(all(captured[field] == actual[field] for field in active_fields))
        _require(all(captured[name] == actual[name] for name in fields))
        if options["length"] is not None:
            _require(captured["duration_seconds"] == actual["duration_seconds"])
        # Losing a captured valid mapping changes the identity basis, even when
        # a local recording assertion could still resolve the same UUID. A new
        # current revision of the same used identity is intentionally allowed.
        mapping = captured["identity_evidence"]["mapping"]
        if mapping is not None:
            now = actual["identity_evidence"]["mapping"]
            _require(now is not None and mapping["canonical_recording_id"] == now["canonical_recording_id"])


def _validated_entries(owner, connection, live, source):
    descriptor = source["origin_descriptor"]
    _json_bytes(descriptor, _MAX_BYTES)
    _validate_descriptor_shape(descriptor)
    refs, ids = descriptor["result"]["entry_order"], descriptor["result"]["track_ids"]
    all_rows = connection.execute("select ref,original_local_track_id,evidence_digest from app.playlist_creation_entries where source_ref=%s",
                                  (source["ref"],)).fetchall()
    by_ref = {str(row["ref"]): row["original_local_track_id"] for row in all_rows}
    _require(len(all_rows) == len(refs) and set(by_ref) == set(refs))
    _require([by_ref[ref] for ref in refs] == ids)
    facts = {fact["track_id"]: fact for fact in descriptor["facts"]}
    _require(all(row["evidence_digest"] == facts[row["original_local_track_id"]]["inventory_digest"]
                 for row in all_rows))
    selected = sources.selected_entries(connection, live, source, refs, config=owner._config)
    return selected


def _project(owner, connection, live, source, *, constraints, selected=None):
    descriptor = source["origin_descriptor"]
    if selected is None:
        selected = _validated_entries(owner, connection, live, source)
    entries = []
    for row in selected:
        entry = sources.project_entry(source, row, album_readable=lambda album_id:
            owner._resource_allowed(live, BROWSE, ResourceScope("album", str(album_id)), constraints))
        entry["allowed_actions"]["can_select"] = False
        entries.append(entry)
    _fresh(owner, connection, live, source)
    return {"status": "ready", "data": {**sources.source_envelope(source),
        "allowed_actions": {"can_read": True, "can_use_for_playlist": False, "can_play": False},
        "entries_complete": True, "entries": entries, "retained_parent_albums": [],
        "options": descriptor["request"]["options"], "diagnostics": descriptor["result"]["diagnostics"],
        "source_diagnostics": descriptor["source_diagnostics"],
        **({"origin_diagnostics": [[m["index"], m["omission"]] for m in descriptor["origin_proof"]["members"] if m["omission"] is not None]} if descriptor["version"] == 2 else {}),
        "group_counts": descriptor["result"]["group_counts"], "actor_scope": owner._scope(live)}}


@contextmanager
def validated_source(owner, connection, live, source, *, constraints=None):
    """Validate a scoped loaded source through consumer writes and ledger.

    The caller loads the source through the existing scoped receipt owner before
    entering; this context neither captures nor opens another transaction.
    """
    _require(source["protocol"] == SAMPLE_PROTOCOL and source["source_kind"] in ("playlist", "library"))
    _fresh(owner, connection, live, source)
    descriptor = source["origin_descriptor"]
    _json_bytes(descriptor, _MAX_BYTES)
    _validate_descriptor_shape(descriptor)
    _require(source["source_kind"] == ("library" if descriptor["version"] == 2 else "playlist"))
    request = descriptor["request"]
    arguments = dict(selection_method=request["options"]["selection_method"],
        include_observations=False, constraints=constraints, facet_fields=facets.active(request["options"]))
    if descriptor["version"] == 2:
        arguments.update(origin=request["origin"], retained_proof=descriptor["origin_proof"])
    else:
        arguments.update(playlist_ref=request["playlist_ref"], revision=request["revision"])
    with _snapshot(owner, connection, live, **arguments) as (snapshot, identities):
        _current_facts(descriptor, snapshot, identities)
        selected = _validated_entries(owner, connection, live, source)
        yield selected
        # Consumers may have written before this exit. Reread through the same
        # source owner, never a copied identity algorithm or a second transaction.
        current, current_identities, finish = _prepare_snapshot(
            owner, connection, live, **arguments)
        _current_facts(descriptor, current, current_identities)
        _validated_entries(owner, connection, live, source)
        finish()
        _fresh(owner, connection, live, source)
    _fresh(owner, connection, live, source)


def _read_in_transaction(owner, connection, live, source, constraints, *, native=False):
    with validated_source(owner, connection, live, source, constraints=constraints) as selected:
        result = _project(owner, connection, live, source, constraints=constraints, selected=selected)
        if native:
            result = _native_actions(owner, connection, live, selected, result, constraints=constraints)
    return result


def capture(owner, context, *, playlist_ref=None, revision=None, origin=None, options, request_key,
            random_order=None, constraints=None, native=False):
    ref = uuid_ref(request_key)
    request = _request(playlist_ref, revision, options, random_order, origin)
    with owner._authorized(context, constraints) as (connection, live, _now):
        owner._require(live, (BROWSE, CREATE), constraints)
        source = _lookup(owner, connection, live, ref, capture=True)
        if source is not None:
            descriptor = source["origin_descriptor"]
            _json_bytes(descriptor, _MAX_BYTES)
            _validate_descriptor_shape(descriptor)
            if descriptor["request_digest"] != _digest("request_v2" if "origin" in request else "request_v1", request):
                raise PlaylistError("request_key_conflict", 409)
            return _read_in_transaction(owner, connection, live, source, constraints, native=native)
        arguments = {"origin": request["origin"]} if "origin" in request else {
            "playlist_ref": request["playlist_ref"], "revision": request["revision"]}
        with _snapshot(owner, connection, live, **arguments,
                selection_method=options.selection_method, constraints=constraints,
                facet_fields=facets.active(options)) as (snapshot, identities):
            selection = evaluator.evaluate_sample_playlist(snapshot.candidates, options, random_order=random_order)
            descriptor = _descriptor(request, snapshot, identities, selection)
            rows = sources.inventory_rows(connection, live.library_id, selection.track_ids,
                                          lock=True, config=owner._config)
            _require(set(rows) == set(selection.track_ids))
            now = lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                                            actor_session_id=live.actor.session_id, clock=owner._clock)
            _preflight(connection, descriptor)
            source = complete._header(connection, live, now, protocol=SAMPLE_PROTOCOL,
                                      kind="library" if "origin" in request else "playlist", origin=descriptor, source_ref=ref)
            observed = sources._observe_page(connection, source, [rows[identity] for identity in selection.track_ids])
            descriptor["result"]["entry_order"] = [str(row["ref"]) for row in observed]
            descriptor["result_digest"] = _digest("result_v1", descriptor["result"])
            _validate_descriptor_shape(descriptor)
            _preflight(connection, descriptor)
            connection.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s",
                               (Jsonb(descriptor), ref))
            source["origin_descriptor"] = descriptor
            result = (_read_in_transaction(owner, connection, live, source, constraints, native=True)
                      if native else _project(owner, connection, live, source, constraints=constraints))
        _fresh(owner, connection, live, source)
        return result


def read(owner, context, *, source_ref, source_revision, constraints=None, native=False):
    ref, revision = uuid_ref(source_ref), uuid_ref(source_revision)
    with owner._authorized(context, constraints) as (connection, live, _now):
        owner._require(live, (BROWSE, CREATE), constraints)
        source = _lookup(owner, connection, live, ref, revision=revision)
        return _read_in_transaction(owner, connection, live, source, constraints, native=native)


def read_capture(owner, context, *, request_key, constraints=None, native=False):
    ref = uuid_ref(request_key)
    with owner._authorized(context, constraints) as (connection, live, _now):
        owner._require(live, (BROWSE, CREATE), constraints)
        source = _lookup(owner, connection, live, ref)
        return _read_in_transaction(owner, connection, live, source, constraints, native=native)


def representatives(owner, context, *, playlist_ref=None, revision=None, origin=None, options, constraints=None):
    """Read current Random representatives; not a capture token or authority."""
    evaluator._validate_options(options)
    if options.selection_method != "random":
        raise PlaylistError("invalid_command")
    request = _request(playlist_ref, revision, options, None, origin)
    arguments = {"origin": request["origin"]} if "origin" in request else {
        "playlist_ref": request["playlist_ref"], "revision": request["revision"]}
    with owner._authorized(context, constraints) as (connection, live, _now):
        owner._require(live, (BROWSE, CREATE), constraints)
        with _snapshot(owner, connection, live,
                **arguments, selection_method="random",
                include_observations=False, constraints=constraints, facet_fields=facets.active(options)) as (snapshot, _identities):
            ids = evaluator.random_representative_ids(snapshot.candidates, options)
            result = {"status": "ready", "data": {
                **({"origin": request["origin"]} if "origin" in request else {"parent": arguments}), "options": facets.encode_options(options),
                "representative_refs": [f"inventory-track:{live.library_id}:{identity}" for identity in ids],
                "actor_scope": owner._scope(live)}}
        return result


def _require_current_media(owner, live, targets, constraints):
    # Target resolution can precede another owner operation or wait. Do not turn
    # its earlier permission result into later authority at response publication.
    if any(not owner._resource_allowed(live, action, ResourceScope("track", str(identity)), constraints)
           for identity in targets for action in (BROWSE, "library.media.read")):
        raise PlaylistError("item_unavailable", 404)


def _native_actions(owner, connection, live, selected, result, *, constraints):
    from music_app.services.private_native_targets import PrivateNativeTargets
    targets = PrivateNativeTargets(owner._config).resolve_play_queue(connection, live,
        [row["original_local_track_id"] for row in selected], constraints=constraints)
    playable = {str(row["ref"]) for row in selected if row["original_local_track_id"] in targets}
    data = result["data"]
    projected = {**result, "data": {**data,
        "native_actions": {"can_save": bool(selected), "can_play": bool(playable)},
        "entries": [{**entry, "native_actions": {"can_play": entry["entry_ref"] in playable}}
                    for entry in data["entries"]]}}
    _require_current_media(owner, live, targets, constraints)
    return projected


def native_queue(owner, context, payload, *, constraints=None, media_resolver=None):
    """Dedicated retained Sample playback; never a generic Queue admission."""
    from music_app.services import listen_history_postgres as history
    from music_app.services.private_native_targets import PrivateNativeTargets
    if (not isinstance(payload, dict) or set(payload) != {
            "source_ref", "source_revision", "entry_refs", "starting_entry_ref"}
            or type(payload["entry_refs"]) is not list or not 1 <= len(payload["entry_refs"]) <= _MAX_ITEMS):
        raise PlaylistError("invalid_command")
    ref, revision = uuid_ref(payload["source_ref"]), uuid_ref(payload["source_revision"])
    refs = [uuid_ref(value) for value in payload["entry_refs"]]
    starting = uuid_ref(payload["starting_entry_ref"])
    if len(set(refs)) != len(refs) or starting not in refs:
        raise PlaylistError("invalid_command")
    with owner._authorized(context, constraints) as (connection, live, _now):
        owner._require(live, (BROWSE, CREATE), constraints)
        source = _lookup(owner, connection, live, ref, revision=revision)
        with validated_source(owner, connection, live, source, constraints=constraints) as rows:
            if refs != source["origin_descriptor"]["result"]["entry_order"]:
                raise PlaylistError("source_changed", 409)
            by_ref = {str(row["ref"]): row["original_local_track_id"] for row in rows}
            targets = PrivateNativeTargets(owner._config, media_resolver=media_resolver).resolve_play_queue(
                connection, live, [by_ref[entry] for entry in refs], constraints=constraints)
            counts = history.read_scoped_track_play_counts(connection, account_id=live.actor.account_id,
                library_id=live.library_id, track_ids=list(targets))
            tracks, unavailable = [], []
            for entry in refs:
                target = targets.get(by_ref[entry])
                if target is None:
                    if entry == starting:
                        raise PlaylistError("item_unavailable", 404)
                    unavailable.append(entry)
                else:
                    tracks.append({"playlist_item_id": entry, "play_count": counts.get(by_ref[entry]),
                        "native_target": {**target, "playlist_item_id": entry}})
            _require_current_media(owner, live, targets, constraints)
            result = {"source": {"kind": source["source_kind"], "ref": ref, "revision": revision},
                "source_protocol": SAMPLE_PROTOCOL, "starting_item_ref": starting,
                "tracks": tracks, "unavailable_item_refs": unavailable}
        return result
