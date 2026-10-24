"""Bounded presentation of verified TSV incoming/effective observations.

No parser, authority, persistent preference or mutation owner. The genuine
rollback-only candidate must validate the original envelope and admit decoder
scratch before calling collect. Public serialization remains caller-owned.
"""
from dataclasses import dataclass

from . import foobar_source_evidence as evidence
from .foobar_account_source_postgres import SourceUnavailable

MAX_ROWS = 20
RAW_PREFIX_CHARACTERS = 8
RAW_CHUNK_CHARACTERS = 512
# Retained DTO/escaped response controls are separate from the unchanged
# private candidate bound. The actual caller must reserve before collection.
CONTROL_BYTES = 1048576
FIELDS = ('play_count', 'play_count_enhanced', 'first_played', 'last_played',
          'first_played_enhanced', 'last_played_enhanced')
INDICES = (11, 12, 13, 14, 16, 17)


@dataclass(frozen=True, slots=True)
class RawFieldRequest:
    ordinal: int
    side: str
    field: str
    offset: int


@dataclass(frozen=True, slots=True)
class ObservationField:
    field: str
    state: str
    count: str | None
    code: str | None
    origin: tuple | None
    raw_prefix: str | None
    raw_characters: int


@dataclass(frozen=True, slots=True)
class ObservationRow:
    ordinal: int
    source_artist: str
    source_title: str
    source_album: str
    incoming: tuple
    effective: tuple


@dataclass(frozen=True, slots=True)
class RawFieldChunk:
    ordinal: int
    side: str
    field: str
    offset: int
    total_characters: int
    text: str
    next_offset: int | None


def validate_page(after, limit=MAX_ROWS, raw=None):
    if (type(after) is not int or not 0 <= after <= 100000
            or type(limit) is not int or not 0 <= limit <= MAX_ROWS):
        raise SourceUnavailable()
    if raw is not None and (type(raw) is not RawFieldRequest
            or type(raw.ordinal) is not int or not after < raw.ordinal <= min(after+MAX_ROWS,100000)
            or raw.side not in ('incoming','effective') or raw.field not in FIELDS
            or type(raw.offset) is not int or not 0 <= raw.offset <= 65536
            or raw.offset % RAW_CHUNK_CHARACTERS):
        raise SourceUnavailable()


def _project(fields):
    result=[]
    for name,index in zip(FIELDS,INDICES):
        state,raw,value,code,origin=fields[index]
        count=None
        if index in (11,12) and state=='valid':
            if type(value) is not int or not 0 <= value <= 9223372036854775807:
                raise SourceUnavailable()
            count=str(value)
        if raw is not None and type(raw) is not str:
            raise SourceUnavailable()
        result.append(ObservationField(name,state,count,code,origin,
            None if raw is None else raw[:RAW_PREFIX_CHARACTERS],
            0 if raw is None else len(raw)))
    return tuple(result)


def collect(original, *, after, limit, raw, admit, label):
    """Use genuine verified original bytes; decode one evidence side at a time.

    admit(payload_bytes) must account for the still-live original envelope,
    body/association controls and evidence.decode_phase_bytes BEFORE bytes.fromhex.
    label is the existing bounded source-label sanitizer, never a native lookup.
    No unbounded row collection or decoded evidence escapes this function.
    """
    validate_page(after,limit,raw)
    rows=[]
    chunk=None
    remaining=0
    for row in original[2]:
        ordinal=row[0]
        if ordinal<=after:
            continue
        if len(rows)>=limit:
            remaining+=1
            continue
        sides=[]
        labels=None
        for side,position in (('incoming',6),('effective',7)):
            encoded=row[position]
            if type(encoded) is not str or len(encoded)%2:
                raise SourceUnavailable()
            admit(len(encoded)//2)
            payload=bytes.fromhex(encoded)
            fields=evidence.decode_evidence(payload)
            del payload
            sides.append(_project(fields))
            if side=='incoming':
                labels=tuple(label(fields[index][1],maximum) for index,maximum in
                             ((1,48),(7,96),(3,48)))
            if raw is not None and ordinal==raw.ordinal and side==raw.side:
                value=fields[INDICES[FIELDS.index(raw.field)]][1]
                if value is None:
                    if raw.offset:
                        raise SourceUnavailable()
                    value=''
                if type(value) is not str or raw.offset>len(value) or raw.offset and raw.offset==len(value):
                    raise SourceUnavailable()
                end=min(raw.offset+RAW_CHUNK_CHARACTERS,len(value))
                chunk=RawFieldChunk(ordinal,side,raw.field,raw.offset,len(value),
                    value[raw.offset:end],end if end<len(value) else None)
                del value
            del fields
        rows.append(ObservationRow(ordinal,*labels,*sides))
    return tuple(rows),remaining,chunk
