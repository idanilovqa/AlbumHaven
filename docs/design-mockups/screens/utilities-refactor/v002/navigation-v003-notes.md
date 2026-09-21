# Navigational review v003

Open navigation.html. Inherits the reviewed v002 component snapshots, with isolated revision-v003.js and navigation-v003.css refinements.

Fixes: compact header width no longer intercepts tabs; Close is at the right. Header Artbox hover has no green outline; keyboard focus remains visible with neutral ink.

Detected Problems now includes an automatic Suggested edits column and Apply next to Create Exception. Sample proposals demonstrate year inference from matching release metadata, reversible tag-encoding correction, and a filename-derived track number. Unknown artwork remains unresolved. Apply confirms the visible proposal types and updates only those types in preview. No real tag writes, metadata queries, or automatic inference engine is implemented by this artifact. Production design must map the existing problem catalog to reliable inference sources, preserve uncertain/no-suggestion states, and use existing tag-write authority and confirmation behavior.

Verification: all six tabs clicked successfully; Close right inset 17px; Apply confirmation and remaining-proposal state checked. User requested new navigational artifact; visual acceptance remains pending.
Loops now previews the refined option A joined capsule, using the shared loop-action controller and reviewed icon glow/spacing. Playback and slice creation remain mock interactions.

Player & Seekbar now includes A/B loop-control style selection. Visibility is gated by the loop-creation capability, as requested by the owner for musician/practice users. Mock capability defaults enabled; ?canCreateLoops=false previews absence. Choice is preview-only; production capability wiring/persistence remains outside the mock. Both styles reveal actions on hover and retain selection when folded.

Scrobbling includes Playback statistics: Local playcount and Total listening time. Values are illustrative sample data in this mock, separate from Last.FM scrobble counts.

## Owner approval — 2026-09-09
All current mocks approved by the owner. The approved-artifacts.json manifest identifies the exact visual source revision. Includes A and B: 300 ms idle reveal, immediate idle hide, 500 ms active-loop hide. Text selection remains available with carets hidden. This is visual approval, not production manual acceptance.
