"""Closed private metadata labels. Text remains untrusted at every renderer."""
import json

from . import foobar_source_evidence as evidence
from . import foobar_snapshot_parser as parser


VERSION = "foobar_source_display_v1"
NAMES = ("artist", "album_artist", "album", "title", "date", "discnumber", "tracknumber")
MAX_BYTES = 1_048_576


def display_size(fields):
    evidence._validate_fields(fields)
    size = 2 + evidence._json_size(VERSION) + 1 + 2 + len(NAMES) - 1
    for name in NAMES:
        state, raw, value, code, origin = fields[parser.FIELD_NAMES.index(name)]
        if state not in ("absent", "empty", "valid"):
            raise evidence.SourceEvidenceError()
        size += 2 + evidence._json_size(state) + 1 + evidence._json_size(raw)
    if size > MAX_BYTES:
        raise evidence.SourceEvidenceError()
    return size


def encode_display(fields):
    size = display_size(fields)
    entries = [[fields[parser.FIELD_NAMES.index(name)][0],
                fields[parser.FIELD_NAMES.index(name)][1]] for name in NAMES]
    result = json.dumps([VERSION, entries], ensure_ascii=False, allow_nan=False,
                        separators=(",", ":")).encode("utf-8")
    if len(result) != size:
        raise evidence.SourceEvidenceError()
    return result


def check_display(payload, fields):
    # Strict association/canonical check, rather than a separately drifting decoder.
    if type(payload) is not bytes or not 1 <= len(payload) <= MAX_BYTES:
        raise evidence.SourceEvidenceError()
    if encode_display(fields) != payload:
        raise evidence.SourceEvidenceError()


def display_phase_bytes(fields):
    # Caller evidence plus entry/envelope/encoder/text/bytes views; original
    # retained display/raw/driver holders remain additional caller owners.
    return evidence.evidence_size(fields) + 5 * display_size(fields) + evidence.CLASSIFIER_WORK_BYTES
