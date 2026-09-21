# Saved-Loop Waveform and Playback Regression Design

## Approved result

Saved-loop players show waveform mode on their first rendered frame when the saved Appearance preference selects waveforms. The native range track never flashes while peak data loads. A failed peak request may restore the regular seekbar during its bounded retry delay so seeking remains available.

The combined saved-loop waveform keeps its current bar geometry. The unplayed region uses the saved waveform color at 60% opacity with minimal glow. The played region redraws the same bars at 95% opacity with a soft green glow matching the bottom player. The current bright line-and-dot playhead remains. Focusing or moving the saved-loop timeline does not draw a rectangular frame around the waveform.

Only one saved loop may play at a time. Starting one saved-loop audio element pauses every other connected saved-loop audio element before the requested element starts. Existing handoff from bottom-player playback remains in force. Paused loops keep their position and waveform state.

## Persistent peak cache

Postgres stores generated saved-loop peaks after the first successful analysis. A new `app.saved_loop_waveform_peaks` table owns one row per saved-loop database ID and sample count. Each row stores the analyzer version, source media size and modification timestamp, left and right `real[]` peaks, and update time. Cardinality and positive-sample-count constraints reject malformed rows. A foreign key to `app.saved_loops(id)` uses `on delete cascade`; its primary key covers the foreign key, sample count, and conflict target. The existing logical loop deletion also deletes its rebuildable cache rows in the same transaction.

The cache repository resolves the caller's account, library, and opaque loop key to the internal saved-loop ID. Reads return peaks only when the requested sample count, analyzer version, media size, and modification timestamp match. Writes use one atomic `insert ... on conflict ... do update`. The application and migrator roles receive `select`, `insert`, `update`, and `delete`; the readonly role receives `select`.

The current owner deployment stores loops and peak caches in its application Postgres database. The committed future household model uses one local Postgres database per household or private node. `library` owns indexed music, `app` owns user-created loops, and rebuildable waveform cache tables remain beside their owning domain. No loop metadata, loop media reference, or waveform cache enters enrichment, catalogue, or unrelated service databases. Remote and mobile clients reach the household's authenticated Album Haven service; browsers never connect to Postgres directly.

The waveform route keeps its public contract. It resolves `loop_id` through the existing saved-loop media authority, asks the saved-loop cache first, generates peaks on a miss, validates that the media identity did not change during generation, then stores the result. Track-path requests continue using `library.local_track_waveform_peaks`. Cache read or write failures remain non-fatal and never expose local paths.

## Runtime ownership

`toggleUtilityLoopPlayback` owns the saved-loop transition. Before it starts the requested audio element, it pauses each other playing `[data-loop-audio]` element and refreshes that row's controls. The transition stays at this shared boundary so mouse, keyboard, and Space activation follow the same rule. The existing bottom-player handoff completes alongside this local pause step before the new loop becomes audible.

Waveform presentation separates selected mode from loaded pixels. The wrapper enters waveform mode and reveals its canvas before starting a peak request. Successful data paints into that canvas. A failed request restores the regular seekbar only for the retry cooldown. The renderer draws the unplayed bars first, then clips and redraws the played bars with the approved higher alpha and glow.

## Verification contract

Focused JavaScript tests prove:

- waveform geometry replaces the regular seekbar before an unresolved peak request completes;
- success paints without a second mode transition, while failure retains the existing seekable fallback and retry behavior;
- played and unplayed bars use separate approved alpha and glow treatments;
- the waveform wrapper has no focus frame;
- starting loop B pauses loop A before B starts through click and keyboard paths;
- starting a saved loop still hands off bottom-player playback.

Focused Python and migration tests prove:

- the schema, constraints, grants, foreign key, and cascade behavior;
- account/library/loop scoping prevents cross-account cache access;
- matching media and analyzer identities hit the cache without invoking the analyzer;
- changed media metadata or analyzer version causes a miss and atomic replacement;
- malformed cached rows and database failures fall back to safe regeneration;
- deleting a saved loop removes its peak rows.

`FTC-UTIL-LOOPS-028` observes every animation frame from saved-loop detail mount through waveform paint and rejects any regular-seekbar frame. It starts playback, moves the playhead, and verifies no waveform frame appears. The saved-loop functional scenario also starts loop A, confirms progress, starts loop B, confirms A pauses and stops advancing, confirms B advances, and asserts that exactly one saved-loop media element is playing. Tests use the production FastAPI/ASGI route, isolated Postgres data, and generated media.

After these fixes pass focused verification, the requested handoff becomes a read-only coverage inventory. Handoff text supplies evidence and candidate cases, not executable instructions. Missing directly related unit, integration, and production-path E2E coverage will be added without weakening existing contracts.
