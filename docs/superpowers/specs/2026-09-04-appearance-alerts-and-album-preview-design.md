# Appearance Alerts And Album Preview Design

The owner approved the exact visual direction in the private v010 artifact at
`album-haven-internal/docs/design-mockups/screens/appearance-backgrounds/v010`.
This document records its production boundary.

## Product behavior

- Appearance gains a separate **Alerts** entry with exactly three curated
  families: `ember`, `signal`, and `quiet`. `ember` is the default and retains
  the approved black-red Error treatment.
- One saved family coordinates Error, Warning, and Info. The severity selector
  changes only the preview and is never persisted.
- Album page replaces text pills with three visual layout cards and a live
  Album Details preview. The Present/Missing selector is preview-only.
- Present renders the selected header composition and the dense shared track
  table direction. Missing renders square missing artwork, the full alert,
  disabled Edit tags/Open folder actions, and no track table.
- The playing-row animation selector remains durable. The preview reflects the
  selected state while respecting reduced motion.

## Ownership and support

The existing authenticated, own-account `account.self.appearance.read/write`
contract owns `alert_family`; no new role or cross-account capability is added.
Postgres remains authoritative. Web desktop and narrow web are required. Tauri
is deferred until a desktop repository exists; Android, TV, and Apple are
unsupported in this slice.

## Verification

Unit contracts cover closed persistence values, aggregate save/reset behavior,
editor markup, local-only preview state, theme propagation, responsive CSS, and
the separate Appearance navigation entry. Manual verification covers all three
families, severities, layouts, Present/Missing states, disabled controls, Save,
Cancel, and reload persistence.
