# Native-rate listening setup

Listening uses source-position evidence at the actual playback rate. It does not
resample audio or treat native frames as 48 kHz frames. Source silence counts;
inserted underrun silence, buffered/downloaded bytes and metadata do not.

## Installation

Apply the normal ordered PostgreSQL migration inventory through
`migrations/postgres/0170_native_rate_capture.sql`, after 0169. This installs the
versioned rate-map/checkpoint support; existing historical v1/v2 rows keep their
meaning. No separate experimental SQL file is needed. Application startup does
not run migrations or grant database privileges automatically. Readiness checks
fail closed until the required schema, constraints, indexes and privileges exist.

## Existing opt-in and override

`ALBUM_HAVEN_POSITION_CAPTURE_ENABLED` remains the existing overall opt-in.
When `ALBUM_HAVEN_NATIVE_RATE_CAPTURE_ENABLED` is absent, it follows that setting,
so an already-enabled tracking installation needs no second opt-in. An explicit
false value disables native evidence; explicit true still cannot bypass overall
position capture, account/library authority or storage readiness. Accepted true
values are `1`, `true`, `yes` (case-insensitive); other explicit values remain false.

`ALBUM_HAVEN_WAV_ABSOLUTE_CAPTURE_ENABLED` retains its separate proof/rollout gate.
Unsupported source layouts or unqualified seek origins may play normally without
being promoted to precise listening evidence. The source-map producer must prove
alignment; requested seek time alone is not evidence of heard source position.

Album Tops presentation retains its existing presentation setting and membership
checks. Full counts and time/depth details are derived in bounded pages from
retained evidence; incomplete history is not presented as complete lifetime history.
No private import file is saved by this integration. The new evidence stores
authenticated identities, rates and consumed spans, not raw private source paths.
