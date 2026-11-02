"""Optional native map publication; no playback scheduling or heard credit."""
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID, uuid4


@dataclass(frozen=True)
class RateCaptureFacts:
    coordinate_rate_hz: int
    source_rate_hz: int
    window_start_frame: int
    window_frames: int
    source_extent_frames: int


def valid_rate_owner_uuid(owner_uuid):
    try:
        owner = UUID(owner_uuid) if type(owner_uuid) is str else None
        return owner is not None and owner.version == 4 and str(owner) == owner_uuid
    except ValueError:
        return False


def rate_capture_descriptor(owner_uuid, command, decoder):
    """Only producer-attached facts qualify; requested seek time is not proof."""
    try:
        owner = UUID(owner_uuid) if type(owner_uuid) is str else None
        facts = getattr(decoder, 'rate_capture_facts', None)
        if (owner is None or owner.version != 4 or str(owner) != owner_uuid
                or type(facts) is not RateCaptureFacts):
            return None
        from music_app.services.playback_rate_evidence import RateMap
        # Validate the same immutable shape before exposing a pending reference.
        mapping = RateMap(map_ref=str(uuid4()), cohort_ref='pending-server-admission',
            owner_uuid=owner_uuid, generation=command.generation,
            stream_id=command.stream_id, **facts.__dict__)
        descriptor = {name: getattr(mapping, name) for name in (
            'map_ref', 'owner_uuid', 'coordinate_rate_hz', 'window_start_frame',
            'window_frames', 'generation', 'stream_id')}
        if getattr(decoder, 'rate_capture_requires_positions', False):
            descriptor['delivery_positions'] = 'per-packet'
        return descriptor
    except (ValueError, TypeError):
        return None


def publish_open_rate_map(database_url, context, admission, facts, descriptor,
                          opened_at, *, constraints=None,
                          enabled=lambda: False):
    """Publish only the immutable admission captured before this decoder opened."""
    from music_app.services.playback_capture import CaptureError
    from music_app.services.playback_decoder_observation import DecoderAdmission
    from music_app.services.playback_rate_capture_postgres import publish_rate_map, rate_source_cohort
    from music_app.services.playback_rate_evidence import RateMap
    if (enabled() is not True or type(facts) is not RateCaptureFacts
            or type(admission) is not DecoderAdmission):
        return False
    mapping = RateMap(map_ref=descriptor['map_ref'], cohort_ref=rate_source_cohort(admission),
        owner_uuid=descriptor['owner_uuid'], generation=descriptor['generation'],
        stream_id=descriptor['stream_id'], **facts.__dict__)
    try:
        publish_rate_map(database_url, context, admission, mapping,
            owner_uuid=mapping.owner_uuid, generation=mapping.generation,
            stream_id=mapping.stream_id, opened_at=opened_at,
            constraints=constraints, enabled=enabled)
    except CaptureError:
        return False
    return True


def check_rate_capture_context(database_url, context, *, constraints=None,
                               selections=False, connect=None, clock=None):
    from music_app.services.playback_capture_postgres import _selector, _final_authority
    from music_app.services.playback_decoder_observation import _bounded_connection, decoder_observation_ready
    from music_app.services.playback_rate_capture_postgres import require_rate_storage
    from music_app.services.playback_edition_selection import selection_schema_ready
    from music_app.services.private_library_authority import current_library_transaction, require_private_action
    from music_app.services.playback_capture import CaptureError
    clock = clock or (lambda: datetime.now(timezone.utc))
    with current_library_transaction(database_url, context, constraints=constraints,
            connect=connect or _bounded_connection, clock=clock, read_only=True,
            inventory_publication_first=True) as (connection, live, _now):
        _selector(connection, live)
        require_private_action(live, 'library.media.read', constraints=constraints)
        require_rate_storage(connection)
        if not decoder_observation_ready(connection):
            raise CaptureError('capture_unavailable', 503)
        available = selections is True and selection_schema_ready(connection)
        _final_authority(connection, live, constraints, clock)
        return bool(available)
