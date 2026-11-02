"""Bounded pure page projection for rate-tagged checkpoint evidence.

The database owner supplies authenticated, edition/version-qualified maps and a
genuine frozen checkpoint cutoff. This module neither queries nor admits data.
Cursor identity is not playback continuity: the writer must validate owner
sequence/output ordering before a checkpoint can be supplied here.
"""
from dataclasses import dataclass
from fractions import Fraction
import json

from music_app.services.playback_rate_evidence import (
    MAX_FRAME, MAX_SPANS, RateEvidenceError, RateMap,
    exact_ticks, normalize_spans, project_span,
)


CURSOR_PROFILE = 'rate-checkpoint-span-cursor-v1'


def _id(value, minimum=1):
    if type(value) is not int or not minimum <= value <= MAX_FRAME:
        raise RateEvidenceError('invalid_rate_cursor')
    return value


@dataclass(frozen=True)
class RateCursor:
    owner_id: int
    checkpoint_id: int
    # Last visited index. -1 is the position before this checkpoint's first span.
    span_index: int

    def __post_init__(self):
        _id(self.owner_id)
        _id(self.checkpoint_id)
        _id(self.span_index, -1)
        if self.span_index >= MAX_SPANS:
            raise RateEvidenceError('invalid_rate_cursor')

    def wire(self):
        return {'profile': CURSOR_PROFILE, 'owner_id': str(self.owner_id),
                'checkpoint_id': str(self.checkpoint_id),
                'span_index': self.span_index}


@dataclass(frozen=True)
class RateProjectedRow:
    owner_id: int
    parent_id: int
    checkpoint_id: int
    span_index: int
    map_ref: str
    cohort_ref: str
    coordinate_rate_hz: int
    coordinate_start_frame: int
    frame_count: int
    repeat_count: int
    output_start_frame: int
    output_end_frame: int
    continuity_serial: int
    generation: int
    stream_id: int
    source_interval: tuple[Fraction, Fraction] | None
    source_extent: Fraction | None
    rendered_seconds: Fraction
    eligible_source_seconds: Fraction


@dataclass(frozen=True)
class RateCheckpointPage:
    rows: tuple[RateProjectedRow, ...]
    cursor: RateCursor
    checkpoint_complete: bool


def project_checkpoint_page(*, owner_id, parent_id, checkpoint_id,
                            cutoff_checkpoint_id, coordinate_rate_hz,
                            raw_spans, authorized_maps, cursor=None,
                            limit=MAX_SPANS):
    """Project a single admitted checkpoint without exceeding the page budget.

    The caller advances to the next checkpoint only when checkpoint_complete.
    Empty/terminal-only checkpoints are visited once with span_index=-1; their
    terminal meaning remains with the caller, never becomes positive coverage.
    No mutation occurs on validation/capacity failure.
    """
    _id(owner_id); _id(parent_id); _id(checkpoint_id); _id(cutoff_checkpoint_id)
    _id(limit)
    if limit > MAX_SPANS or checkpoint_id > cutoff_checkpoint_id:
        raise RateEvidenceError('invalid_rate_page')
    if cursor is not None and type(cursor) is not RateCursor:
        raise RateEvidenceError('invalid_rate_cursor')
    if cursor is not None and (cursor.owner_id != owner_id
                               or cursor.checkpoint_id > checkpoint_id):
        raise RateEvidenceError('invalid_rate_cursor')
    spans = normalize_spans(raw_spans, coordinate_rate_hz, authorized_maps)
    previous_index = (cursor.span_index if cursor is not None
                      and cursor.checkpoint_id == checkpoint_id else -1)
    if previous_index >= len(spans):
        raise RateEvidenceError('invalid_rate_cursor')
    first = previous_index + 1
    end = min(len(spans), first + limit)
    rows = []
    for index in range(first, end):
        span = spans[index]
        mapping = authorized_maps[span.map_ref]
        if type(mapping) is not RateMap:
            raise RateEvidenceError('unavailable_rate_map')
        projected = project_span(span, mapping)
        rows.append(RateProjectedRow(
            owner_id, parent_id, checkpoint_id, index, span.map_ref,
            mapping.cohort_ref, coordinate_rate_hz, span.coordinate_start_frame,
            span.frame_count, span.repeat_count, span.output_start_frame,
            span.output_start_frame + span.frame_count * span.repeat_count, span.continuity_serial,
            mapping.generation, mapping.stream_id,
            projected.interval,
            None if mapping.source_extent_frames is None else
                Fraction(mapping.source_extent_frames, mapping.source_rate_hz),
            projected.rendered_seconds, projected.eligible_source_seconds,
        ))
    next_cursor = RateCursor(owner_id, checkpoint_id, end - 1)
    return RateCheckpointPage(tuple(rows), next_cursor, end == len(spans))


def geometry_row(projected, *, track_id, source_version, timebase,
                 selection_and_version_qualified):
    """Convert only a caller-qualified row to explicitly named measurement ticks.

    Caller qualification must include current authenticated edition membership,
    file/version identity and the map's alignment policy. Missing qualification
    or extent creates a barrier, never a made-up denominator or skipped hole.
    """
    if type(projected) is not RateProjectedRow:
        raise RateEvidenceError('invalid_rate_projection')
    if type(selection_and_version_qualified) is not bool:
        raise RateEvidenceError('invalid_rate_qualification')
    if (not selection_and_version_qualified or projected.source_interval is None
            or projected.source_extent is None):
        return {'eligible': False}
    _id(track_id)
    if type(source_version) is not str or not source_version:
        raise RateEvidenceError('invalid_rate_source_version')
    start, end = projected.source_interval
    return dict(eligible=True, owner_id=projected.owner_id, parent_id=projected.parent_id,
                track_id=track_id, map_ref=projected.map_ref, version=source_version,
                coordinate_rate_hz=projected.coordinate_rate_hz,
                continuity_serial=projected.continuity_serial,
                generation=projected.generation, stream_id=projected.stream_id,
                frame_count=projected.frame_count, repeat_count=projected.repeat_count,
                output_start_frame=projected.output_start_frame,
                output_end_frame=projected.output_end_frame,
                start_ticks=str(exact_ticks(start, timebase)),
                end_ticks=str(exact_ticks(end, timebase)),
                extent_ticks=str(exact_ticks(projected.source_extent, timebase)))


@dataclass(frozen=True)
class RateDatabasePage:
    rows: tuple
    cursor: RateCursor | None
    has_more: bool


def next_rate_owner(connection, live, selected, cutoff, after=0):
    """Run only inside the caller's existing authorized history transaction."""
    _id(cutoff); _id(after, 0)
    row = connection.execute('''select o.id from integration.playback_capture_owner o
      where o.account_id=%s and o.library_id=%s and o.id>%s
        and o.rate_coordinate_hz is not null and exists(
          select 1 from integration.playback_capture_session p
          join integration.playback_capture_checkpoint cp on cp.session_id=p.id
          where p.owner_id=o.id and p.account_id=o.account_id and p.library_id=o.library_id
            and p.original_album_id=%s and p.evidence_version='app-rate-tagged-position-v1'
            and cp.rate_owner_id=o.id and cp.id<=%s and not cp.evidence_redacted)
      order by o.id limit 1''',
      (live.actor.account_id, live.library_id, after, selected.album_id, cutoff)).fetchone()
    return row['id'] if row else None


_RATE_PAGE = '''select cp.id as checkpoint_id,p.id as parent_id,p.original_track_id as track_id,
 cp.rate_owner_id as owner_id,cp.rate_owner_sequence,p.rate_coordinate_hz,
 span.ordinality-1 as span_index,span.value as span,
 m.map_ref,m.cohort_ref,m.original_file_id,m.original_root_id,m.inventory_source_revision,
 m.coordinate_rate_hz,m.source_rate_hz,m.window_start_frame,m.window_frames,m.source_extent_frames,
 m.opened_at,m.generation,m.stream_id,m.owner_uuid as map_owner_uuid,s.membership_revision
 from integration.playback_capture_checkpoint cp
 join integration.playback_capture_session p on p.id=cp.session_id
 join integration.playback_capture_owner owner on owner.id=cp.rate_owner_id and owner.id=p.owner_id
   and owner.account_id=p.account_id and owner.library_id=p.library_id
   and owner.auth_session_guard=p.auth_session_guard
 cross join lateral jsonb_array_elements(cp.evidence->'spans') with ordinality span(value,ordinality)
 left join integration.playback_rate_map m on m.account_id=p.account_id
   and m.map_ref::text=span.value->>'map_ref' and m.auth_session_guard=p.auth_session_guard
   and m.original_library_id=p.library_id and m.original_track_id=p.original_track_id
   and m.original_file_id=p.original_file_id and m.original_root_id=p.original_root_id
   and m.owner_uuid=owner.owner_uuid
   and m.coordinate_rate_hz=p.rate_coordinate_hz and m.coordinate_rate_hz=owner.rate_coordinate_hz
 left join integration.playback_edition_capture ec on ec.account_id=p.account_id
   and ec.original_capture_session_id=p.id and ec.live_capture_session_id=p.id
   and ec.original_track_id=p.original_track_id
 left join integration.playback_edition_selection s on s.account_id=ec.account_id
   and s.selection_ref=ec.selection_ref and s.original_library_id=p.library_id
   and s.original_album_id=p.original_album_id
 where cp.rate_owner_id=%s and cp.rate_owner_sequence>=%s
   and cp.id<=%s and not cp.evidence_redacted
   and case when jsonb_typeof(cp.evidence->'spans')='array'
       then jsonb_array_length(cp.evidence->'spans')>0 else false end
   and p.account_id=%s and p.library_id=%s and p.original_album_id=%s
   and p.original_track_id=any(%s) and p.evidence_version='app-rate-tagged-position-v1'
   and (cp.id<>%s or span.ordinality-1>%s)
 order by cp.rate_owner_sequence,span.ordinality limit 257'''


def read_rate_page(connection, live, selected, versions, facts, *, owner_id, cutoff, cursor=None):
    """Indexed owner-sequence traversal; checkpoint ID remains the shared cut.

    Missing map/version/selection support yields an explicit barrier row. It is
    never filtered away to manufacture adjacency across unsupported evidence.
    Scope locks, readiness, revision/cut capture and final authority are caller
    responsibilities, identical to the existing local Full reader's boundaries.
    """
    _id(owner_id); _id(cutoff)
    after_id, after_index, after_sequence = 0, -1, 0
    if cursor is not None:
        if type(cursor) is not RateCursor or cursor.owner_id != owner_id:
            raise RateEvidenceError('invalid_rate_cursor')
        after_id, after_index = cursor.checkpoint_id, cursor.span_index
        previous = connection.execute('''select cp.rate_owner_sequence
          from integration.playback_capture_checkpoint cp
          join integration.playback_capture_session p on p.id=cp.session_id
          where cp.id=%s and cp.rate_owner_id=%s and cp.id<=%s
            and p.account_id=%s and p.library_id=%s and p.original_album_id=%s
            and p.evidence_version='app-rate-tagged-position-v1' and not cp.evidence_redacted''',
          (after_id, owner_id, cutoff, live.actor.account_id, live.library_id, selected.album_id)).fetchone()
        if previous is None:
            raise RateEvidenceError('rate_cursor_invalidated')
        after_sequence = previous['rate_owner_sequence']
    raw = connection.execute(_RATE_PAGE, (owner_id, after_sequence, cutoff,
        live.actor.account_id, live.library_id, selected.album_id, list(selected.track_ids),
        after_id, after_index)).fetchall()
    more, rows = len(raw) > MAX_SPANS, []
    for row in raw[:MAX_SPANS]:
        next_cursor = RateCursor(owner_id, row['checkpoint_id'], row['span_index'])
        qualified = (row['map_ref'] is not None
            and versions.get((row['track_id'], row['original_file_id'], row['original_root_id']))
                == row['inventory_source_revision']
            and row['membership_revision'] == selected.membership_revision)
        if not qualified:
            rows.append({'eligible': False, 'cursor': next_cursor})
            continue
        mapping = RateMap(str(row['map_ref']), row['cohort_ref'], row['coordinate_rate_hz'],
            row['source_rate_hz'], row['window_start_frame'], row['window_frames'], row['source_extent_frames'],
            row['generation'], row['stream_id'], str(row['map_owner_uuid']))
        span = normalize_spans([row['span']], row['rate_coordinate_hz'], {mapping.map_ref: mapping})[0]
        projected = project_span(span, mapping)
        extent_supported = facts.get((row['original_file_id'], row['inventory_source_revision'])) == (
            mapping.source_rate_hz, mapping.source_extent_frames)
        point = RateProjectedRow(owner_id, row['parent_id'], row['checkpoint_id'], row['span_index'],
            mapping.map_ref, mapping.cohort_ref, mapping.coordinate_rate_hz, span.coordinate_start_frame,
            span.frame_count, span.repeat_count, span.output_start_frame, span.output_start_frame + span.frame_count * span.repeat_count,
            span.continuity_serial, mapping.generation, mapping.stream_id, projected.interval,
            None if not extent_supported or mapping.source_extent_frames is None else
                Fraction(mapping.source_extent_frames, mapping.source_rate_hz),
            projected.rendered_seconds, projected.eligible_source_seconds)
        rows.append(dict(eligible=True, cursor=next_cursor, projection=point,
            track_id=row['track_id'], source_version=row['inventory_source_revision'],
            file_id=row['original_file_id'], root_id=row['original_root_id'],
            opened_at=row['opened_at'], generation=row['generation'], stream_id=row['stream_id'],
            source_rate_hz=mapping.source_rate_hz))
    return RateDatabasePage(tuple(rows), rows[-1]['cursor'] if rows else cursor, more)


def read_rate_facts(connection, live, versions):
    """Bounded current-source facts and rate set; metadata gives no heard credit."""
    wanted = sorted({(file_id, version) for (_track, file_id, _root), version in versions.items()})
    if len(wanted) > 4096:
        raise RateEvidenceError('rate_geometry_capacity')
    if not wanted:
        return {}, ()
    rows = connection.execute('''select wanted.file_id,wanted.version,
        low_rate.source_rate_hz as low_rate,high_rate.source_rate_hz as high_rate,
        low_extent.source_extent_frames as low_extent,high_extent.source_extent_frames as high_extent
      from jsonb_to_recordset(%s::jsonb) wanted(file_id bigint,version text)
      left join lateral(select source_rate_hz from integration.playback_rate_map
        where account_id=%s and original_library_id=%s and original_file_id=wanted.file_id
          and inventory_source_revision=wanted.version and source_extent_frames is not null
        order by source_rate_hz limit 1) low_rate on true
      left join lateral(select source_rate_hz from integration.playback_rate_map
        where account_id=%s and original_library_id=%s and original_file_id=wanted.file_id
          and inventory_source_revision=wanted.version and source_extent_frames is not null
        order by source_rate_hz desc limit 1) high_rate on true
      left join lateral(select source_extent_frames from integration.playback_rate_map
        where account_id=%s and original_library_id=%s and original_file_id=wanted.file_id
          and inventory_source_revision=wanted.version and source_rate_hz=low_rate.source_rate_hz
          and source_extent_frames is not null order by source_extent_frames limit 1) low_extent on true
      left join lateral(select source_extent_frames from integration.playback_rate_map
        where account_id=%s and original_library_id=%s and original_file_id=wanted.file_id
          and inventory_source_revision=wanted.version and source_rate_hz=low_rate.source_rate_hz
          and source_extent_frames is not null order by source_extent_frames desc limit 1) high_extent on true''',
      (json.dumps([dict(file_id=file_id, version=version) for file_id, version in wanted]),
       *((live.actor.account_id, live.library_id) * 4))).fetchall()
    # Current MR36 mappings are identity or the two high-rate fallback families.
    # This bounded superset avoids scanning every historical map to collect rates.
    facts, rates = {}, {44100, 48000}
    for row in rows:
        if row['low_rate'] is not None:
            rates.add(row['low_rate'])
        if row['high_rate'] is not None:
            rates.add(row['high_rate'])
        if (row['low_rate'] is not None and row['low_rate'] == row['high_rate']
                and row['low_extent'] is not None and row['low_extent'] == row['high_extent']):
            facts[(row['file_id'], row['version'])] = (row['low_rate'], row['low_extent'])
    if len(rates) > 1024:
        raise RateEvidenceError('rate_geometry_capacity')
    return facts, tuple(sorted(rates))
