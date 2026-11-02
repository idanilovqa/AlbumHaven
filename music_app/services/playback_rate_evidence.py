"""Pure rate-tagged listening geometry; never changes or resamples audio.

Private MR36 integration candidate. A RateMap must come from the authenticated
server mapping owner, not a browser-supplied mapping declaration. These helpers
do not establish scope, decoder alignment, delivery or database authority.
"""
from dataclasses import dataclass
from fractions import Fraction
from math import gcd
from uuid import UUID


PROTOCOL = 'app-rate-tagged-position-v1'
MAX_FRAME = 2**53 - 1
MAX_RATIONAL = 2**127 - 1
MAX_SPANS = 256
MAX_INTERVALS = 8192
MIN_RATE = 8000
MAX_RATE = 192000


class RateEvidenceError(ValueError):
    pass


def _integer(value, minimum=0, maximum=MAX_FRAME):
    if type(value) is not int or not minimum <= value <= maximum:
        raise RateEvidenceError('invalid_rate_coordinate')
    return value


def _uuid(value):
    if type(value) is not str:
        raise RateEvidenceError('invalid_map_ref')
    try:
        parsed = UUID(value)
    except ValueError:
        raise RateEvidenceError('invalid_map_ref') from None
    if parsed.version != 4 or str(parsed) != value:
        raise RateEvidenceError('invalid_map_ref')
    return value


def pack_time(value):
    """Canonical exact seconds, safe to serialize without float conversion."""
    if type(value) is not Fraction or value < 0:
        raise RateEvidenceError('invalid_rate_time')
    if value.numerator > MAX_RATIONAL or value.denominator > MAX_RATIONAL:
        raise RateEvidenceError('rate_geometry_capacity')
    # Decimal strings keep 127-bit integers exact through JSON/JavaScript.
    return [str(value.numerator), str(value.denominator)]


def unpack_time(value):
    if type(value) is not list or len(value) != 2:
        raise RateEvidenceError('invalid_rate_time')
    numbers = []
    for token in value:
        if (type(token) is not str or not token or len(token) > 39
                or not token.isascii() or not token.isdecimal()
                or len(token) > 1 and token[0] == '0'):
            raise RateEvidenceError('invalid_rate_time')
        numbers.append(int(token))
    numerator, denominator = numbers
    if (numerator > MAX_RATIONAL or not 1 <= denominator <= MAX_RATIONAL
            or gcd(numerator, denominator) != 1):
        raise RateEvidenceError('invalid_rate_time')
    return Fraction(numerator, denominator)


@dataclass(frozen=True)
class RateMap:
    """Server-authorized logical media-time window in one playback grid.

    coordinate_* describes post-preroll/post-trim PCM, not encoded byte counts.
    source_extent_frames is a denominator bound, never listened coverage.
    An absent extent permits supported intervals but cannot establish Full.
    cohort_ref must bind the authenticated track/file/version outside this module.
    Mapping qualification (including fallback alignment) belongs to its producer.
    This version requires a qualified common media-time zero: coordinate/rate.
    Fractional/non-grid seek origins are unsupported, never rounded into this map.
    """
    map_ref: str
    cohort_ref: str
    coordinate_rate_hz: int
    source_rate_hz: int
    window_start_frame: int
    window_frames: int
    source_extent_frames: int | None
    generation: int
    stream_id: int
    owner_uuid: str

    def __post_init__(self):
        _uuid(self.map_ref)
        _uuid(self.owner_uuid)
        _integer(self.generation, 1, 2**31 - 1)
        _integer(self.stream_id, 1, 2**31 - 1)
        if (type(self.cohort_ref) is not str or not self.cohort_ref
                or len(self.cohort_ref.encode('utf-8')) > 256):
            raise RateEvidenceError('invalid_source_cohort')
        _integer(self.coordinate_rate_hz, MIN_RATE, MAX_RATE)
        _integer(self.source_rate_hz, MIN_RATE, MAX_RATE)
        fallback_rate = (44100 if self.source_rate_hz % 44100 == 0 else 48000)
        if (self.coordinate_rate_hz != self.source_rate_hz
                and not (self.source_rate_hz > 48000
                         and self.coordinate_rate_hz == fallback_rate)):
            raise RateEvidenceError('unsupported_rate_mapping')
        _integer(self.window_start_frame)
        _integer(self.window_frames)
        _integer(self.window_start_frame + self.window_frames)
        if self.source_extent_frames is not None:
            _integer(self.source_extent_frames)


@dataclass(frozen=True)
class HeardSpan:
    map_ref: str
    coordinate_start_frame: int
    frame_count: int
    repeat_count: int
    output_start_frame: int
    continuity_serial: int


@dataclass(frozen=True)
class ProjectedSpan:
    interval: tuple[Fraction, Fraction] | None
    rendered_seconds: Fraction
    eligible_source_seconds: Fraction


_SPAN_FIELDS = frozenset(HeardSpan.__dataclass_fields__)


def normalize_spans(raw, coordinate_rate_hz, authorized_maps):
    """Validate ordered actual-output spans against already authorized maps.

    Repeated source ranges are deliberately legal. Overlapping output frames
    are not. Cross-report/cross-parent ordering is the transaction owner's job.
    """
    _integer(coordinate_rate_hz, MIN_RATE, MAX_RATE)
    if type(raw) is not list or len(raw) > MAX_SPANS:
        raise RateEvidenceError('invalid_rate_spans')
    result = []
    previous_end = None
    owner_uuid = None
    for value in raw:
        if type(value) is not dict or value.keys() != _SPAN_FIELDS:
            raise RateEvidenceError('invalid_rate_span')
        ref = _uuid(value['map_ref'])
        mapping = authorized_maps.get(ref)
        if type(mapping) is not RateMap or mapping.map_ref != ref:
            raise RateEvidenceError('unavailable_rate_map')
        if mapping.coordinate_rate_hz != coordinate_rate_hz:
            raise RateEvidenceError('rate_context_mismatch')
        if owner_uuid is not None and mapping.owner_uuid != owner_uuid:
            raise RateEvidenceError('rate_owner_mismatch')
        owner_uuid = mapping.owner_uuid
        start = _integer(value['coordinate_start_frame'])
        count = _integer(value['frame_count'], 1)
        end = _integer(start + count)
        output = _integer(value['output_start_frame'])
        repeats = _integer(value['repeat_count'], 1)
        output_length = _integer(count * repeats, 1)
        output_end = _integer(output + output_length)
        continuity = _integer(value['continuity_serial'], 1)
        if (start < mapping.window_start_frame
                or end > mapping.window_start_frame + mapping.window_frames):
            raise RateEvidenceError('outside_rate_map')
        if previous_end is not None and output < previous_end:
            raise RateEvidenceError('overlapping_output_frames')
        result.append(HeardSpan(ref, start, count, repeats, output, continuity))
        previous_end = output_end
    return tuple(result)


def project_span(span, mapping):
    """Return exact logical source interval and separately actual heard time.

    Output-grid rounding of a fallback's declared endpoint may exceed source
    extent. Intersecting with the true extent only removes unsupported coverage;
    it never expands a lower endpoint or fills a missing source interval.
    """
    if type(span) is not HeardSpan or type(mapping) is not RateMap:
        raise RateEvidenceError('invalid_rate_projection')
    checked = normalize_spans([dict(zip(HeardSpan.__dataclass_fields__, (
        span.map_ref, span.coordinate_start_frame, span.frame_count, span.repeat_count,
        span.output_start_frame, span.continuity_serial,
    )))], mapping.coordinate_rate_hz, {mapping.map_ref: mapping})[0]
    rate = mapping.coordinate_rate_hz
    start = Fraction(checked.coordinate_start_frame, rate)
    end = Fraction(checked.coordinate_start_frame + checked.frame_count, rate)
    duration = Fraction(checked.frame_count * checked.repeat_count, rate)
    if mapping.source_extent_frames is not None:
        end = min(end, Fraction(mapping.source_extent_frames, mapping.source_rate_hz))
    interval = None if end <= start else (start, end)
    return ProjectedSpan(interval, duration,
                         Fraction(0) if interval is None else (end - start) * checked.repeat_count)


def union_intervals(intervals):
    """Exact union only; no epsilon bridges, rounding or replay multiplication."""
    if type(intervals) not in (tuple, list) or len(intervals) > MAX_INTERVALS:
        raise RateEvidenceError('rate_geometry_capacity')
    ordered = []
    for interval in intervals:
        if (type(interval) not in (tuple, list) or len(interval) != 2
                or any(type(value) is not Fraction for value in interval)
                or not 0 <= interval[0] < interval[1]):
            raise RateEvidenceError('invalid_rate_interval')
        pack_time(interval[0]); pack_time(interval[1])
        ordered.append(tuple(interval))
    result = []
    for start, end in sorted(ordered):
        if result and start <= result[-1][1]:
            result[-1] = (result[-1][0], max(result[-1][1], end))
        else:
            result.append((start, end))
    return tuple(result)


def exact_timebase(rates):
    """Bounded exact integer measurement scale, not a playback sample rate."""
    if type(rates) not in (tuple, list) or not 1 <= len(rates) <= 1024:
        raise RateEvidenceError('rate_geometry_capacity')
    result = 1
    for rate in rates:
        _integer(rate, MIN_RATE, MAX_RATE)
        result = result // gcd(result, rate) * rate
        if result > MAX_RATIONAL:
            raise RateEvidenceError('rate_geometry_capacity')
    return result


def exact_ticks(value, timebase):
    """No rounding: denominator must divide this frozen measurement scale."""
    if type(timebase) is not int or not 1 <= timebase <= MAX_RATIONAL:
        raise RateEvidenceError('invalid_rate_timebase')
    pack_time(value)
    if timebase % value.denominator:
        raise RateEvidenceError('rate_timebase_mismatch')
    ticks = value.numerator * (timebase // value.denominator)
    if ticks > MAX_RATIONAL:
        raise RateEvidenceError('rate_geometry_capacity')
    return ticks
