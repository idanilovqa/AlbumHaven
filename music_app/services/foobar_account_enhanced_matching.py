"""Worker-owned alias projection, never account or library authority.

The actual Prepare transaction constructs and rechecks this cache against the
genuine selected-library inventory. Only immutable bounded matching scalars
survive the alias pass; native file availability is not probed here.
"""
from dataclasses import dataclass

from . import foobar_account_import_prepare as prepare
from . import foobar_enhanced_raw_windows as windows
from .foobar_account_source_postgres import SourceUnavailable, SourceStale

RECORD_BYTES = 256
TARGET_COUNT_BYTES = 1024
CONTROL_BYTES = 65536


@dataclass(frozen=True, slots=True)
class _MatchingCache:
    scope: tuple
    inventory: object
    candidates: tuple
    target_counts: dict
    by_ref: dict
    by_id: dict
    alias_proof_sha256: str
    retained_bytes: int


def _scope(live, command, upload):
    return (live.actor.account_id, live.actor.session_id, command.source_ref,
        command.generation, prepare.gate.ENHANCED_PARSER, command.mapping_name,
        command.matching_library_id, command.inventory_sha256, upload.upload_sha256)


def _admit(capacity, upload, files):
    records = upload.records
    path_bytes = sum(row.path_bytes for row in files)
    # Full inventory/projection views use the established owner ledger. These
    # extra charges name only our record tuple/list and bounded count map.
    extra = CONTROL_BYTES + RECORD_BYTES * records + TARGET_COUNT_BYTES * len(files)
    retained = windows.index_retained_logical_bytes(records)
    prepare.intake._admit(capacity, retained + windows.READER_PHASE_LOGICAL_BYTES
        + prepare.MAX_PRIVATE_BYTES + extra
        + prepare._inventory_intake_bytes(0, 0, len(files), path_bytes))
    return extra


def matching_cache_on_connection(connection, live, *, upload, command, capacity, constraints):
    """Read fresh authority/inventory even when a prior scalar cache exists."""
    if (type(upload) is not windows.EnhancedRawIndex
            or command.mapping_name != prepare.gate.ENHANCED_MAPPING
            or command.matching_library_id is None
            or live.library_id != command.matching_library_id):
        raise SourceUnavailable()
    prepare.require_account_foobar(live, constraints)
    cached = upload._matching_cache
    if cached is not None:
        if type(cached) is not _MatchingCache:
            raise SourceUnavailable()
        _admit(capacity, upload, cached.inventory.files)
    else:
        prepare.intake._admit(capacity, windows.index_retained_logical_bytes(upload.records)
            + windows.READER_PHASE_LOGICAL_BYTES + prepare.MAX_PRIVATE_BYTES
            + prepare.preview.SCALAR_WORK_BYTES + prepare.INVENTORY_FORWARDING_BYTES)
    files = prepare.read_foobar_inventory_scalars_on_connection(connection, live, constraints=constraints)
    extra = _admit(capacity, upload, files)
    scope = _scope(live, command, upload)
    if cached is not None:
        if (type(cached) is not _MatchingCache or cached.scope != scope
                or cached.inventory.files != files or cached.retained_bytes != extra):
            raise SourceStale()
        prepare._check_complete_inventory_policy(live, cached.inventory.targets, constraints=constraints)
        return cached
    inventory = prepare.read_foobar_preview_inventory_on_connection(connection, live,
        expected_files=files, constraints=constraints)
    if inventory.revision != command.inventory_sha256:
        raise SourceStale()
    projections = prepare._path_projections(inventory.inventory)
    # Full admitted path claims, not the preview's capped display candidates.
    # This scratch map and the per-record set are charged per inventory file.
    path_targets = {}
    for entry in inventory.inventory:
        path_targets.setdefault(entry.path, set()).add(entry.canonical_track_ref)
    record_targets = set()
    candidates = []
    target_counts = {}
    current = 0
    selected = None
    ambiguous = False
    aliases = 0
    stream = upload.alias_pages()
    try:
        while True:
            try:
                page = next(stream)
            except StopIteration as completed:
                terminal = completed.value
                break
            if (type(page) is not windows.EnhancedAliasPage or page.record_ordinal != current
                    or type(page.filenames) is not tuple):
                raise SourceUnavailable()
            for alias in page.filenames:
                projection = projections.get(alias)
                aliases += 1
                if projection is None:
                    continue
                record_targets.update(path_targets[alias])
                if projection[0] != 'exact_unique':
                    ambiguous = True
                    continue
                target = projection[4]
                if selected is not None and selected != target:
                    ambiguous = True
                selected = target
            if page.final:
                status = 'ambiguous' if ambiguous else 'unique' if selected is not None else 'unmatched'
                candidate = selected if status == 'unique' else None
                candidates.append((status, candidate))
                for target in record_targets:
                    target_counts[target] = target_counts.get(target, 0) + 1
                record_targets.clear()
                current += 1
                selected = None
                ambiguous = False
            page = None
    finally:
        stream.close()
    if (type(terminal) is not windows.EnhancedAliasSummary
            or terminal.upload_sha256 != command.upload_sha256
            or terminal.records != upload.records or current != upload.records
            or terminal.aliases != aliases or not prepare.gate._hex(terminal.proof_sha256)):
        raise SourceUnavailable()
    del projections, path_targets, record_targets
    if prepare.read_foobar_inventory_scalars_on_connection(connection, live, constraints=constraints) != files:
        raise SourceStale()
    prepare._check_complete_inventory_policy(live, inventory.targets, constraints=constraints)
    prepare.require_account_foobar(live, constraints)
    cached = _MatchingCache(scope, inventory, tuple(candidates), target_counts,
        {target.canonical_track_ref: target for target in inventory.targets},
        {target.track_id: target for target in inventory.targets},
        terminal.proof_sha256, extra)
    upload._matching_cache = cached
    return cached


def association_seals_on_connection(connection, live, *, command, observations,
        cache, retained_bytes, constraints):
    """Saved decisions outrank aliases; ambiguity never merges store keys."""
    prepare.associations._observations(observations)
    count = len(observations)
    prepare._private(CONTROL_BYTES + prepare.associations.association_phase_bytes(count)
        + 8192 * count + retained_bytes)
    original = prepare.associations.read_import_associations_on_connection(connection, live,
        source_ref=command.source_ref, library_id=command.matching_library_id,
        observations=observations, constraints=constraints)
    result = []
    for (ordinal, observation_ref), seal in zip(observations, original):
        status, suggested = cache.candidates[ordinal - 1]
        if seal[8] == 'saved':
            target = cache.by_id.get(seal[3])
        elif seal[8] == 'never_decided' and status == 'unique':
            target = cache.by_ref.get(suggested)
        else:
            target = None
        if target is not None:
            own_claim = suggested == target.canonical_track_ref and status == 'unique'
            claims = cache.target_counts.get(target.canonical_track_ref, 0)
            # Offline/missing physical availability does not invalidate readable
            # track identity. Conflicting identity cannot establish a new link.
            if (not target.browse_allowed or target.selection_status == 'conflict'
                    or claims > int(own_claim)
                    or seal[8] == 'never_decided' and claims != 1):
                target = None
        result.append(seal[:9] + (None if target is None else target.track_id,))
    ids = tuple(sorted({seal[9] for seal in result if seal[9] is not None}))
    external = (prepare.associations.projection_conflicts_on_connection(connection, live,
        source_ref=command.source_ref, observations=observations, track_ids=ids,
        constraints=constraints) if ids else frozenset())
    # Retained bindings reserve their target even if their projection is absent.
    # Blanket input exclusion in the external query cannot bypass this reserve.
    return tuple(seal[:9] + (None,) if seal[9] is not None and (
        seal[9] in external
        or any(j != i and other[8] == 'saved' and other[3] == seal[9]
               for j, other in enumerate(result))
        or sum(other[9] == seal[9] for other in result) > 1) else seal
        for i, seal in enumerate(result))
