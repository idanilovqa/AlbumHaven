# Saved-loop surfaces

Approved outcome: neutral theme-aware loop cards, fine borders, outward light-theme shadows and short accent-colored dark-theme glows. The existing 12px gaps must retain an unlit center. No left stripe; no extra play-button halo. Preserve the existing play/scissors capability behavior and destructive ActionButton. Pitch steps are unboxed; dark repeat/speed controls remain translucent green.

One delivery unit: CSS and focused component tests. No API, permission, persistence, or playback changes. Existing web surface only; no client-support changes. Revert only this styling/test delta to roll back. No commit, PR, merge, or publish requested.

- [x] Replace obsolete solid-dark-in-light regression with light, charcoal and black cases using existing controls.
- [x] Verify tests fail before implementation.
- [x] Change the saved-loop theme rules at their existing owner; keep markup and component behavior.
- [x] Use a short 3px glow so a 12px gap cannot become a green band; pixel checks confirm black gap centers.
- [x] Run focused component and play/scissors regressions; inspect four-card screenshots.
- [ ] Present the rendered result for manual acceptance.
