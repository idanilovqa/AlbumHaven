# Multi-root initial implementation: manual acceptance

This is an initial-build checkpoint, not release approval. Use the isolated
`2026-09-23-multi-root-libraries` branch. No automatic or manual move work is added.

## Start the build

Use the normal private-node configuration and existing credentials, without
committing `.env`. Apply the repository's ordered PostgreSQL migrations through
the migrator role (including canonical `0082_library_source_indicators.sql`), then run:

```powershell
node scripts/build-runtime-bundle.cjs
python app.py
```

Follow `docs/local-auth-setup-and-manual-tests.md` for HTTPS/auth configuration.
Do not provision a replacement owner or reset credentials for this feature.

## Acceptance script

1. In Appearance > Album page, find Library sources. Confirm defaults: card
   colors Off, hover outline colors Off, source icons On. The last enabled
   option cannot be switched off. Enable another option before disabling it.
2. Change options, press Cancel, and confirm saved styling is unchanged. Save a
   different valid combination and reload; confirm it persists. Card color,
   outline color and icons must behave independently.
3. In library settings, confirm the owner-provided Hoard and New Arrivals paths
   are present, with the existing Main root and move policy preserved. All four
   added folders were accessible when configured, and a full scan has published
   their inventory. Do not configure a root that overlaps another root. Report
   any later inaccessible mapped drive rather than replacing it with an inferred
   location.
4. Inspect Hoard and New Arrivals albums in Cards and Covers modes. Hover artwork:
   icons appear, but labels stay collapsed. Hover/focus each individual icon:
   only that label expands. Check the chest and mailbox/vinyl designs in both
   dark and light themes.
5. Enable source colors and outlines. An album represented in Main, Hoard and
   New Arrivals must show all three border/frame segments, including the neutral
   Main segment. With colors disabled, normal theme styling remains.
6. For equal artist/title/valid-year albums in separate folders, inspect the
   `Duplicate files` artwork action, Album Details source tabs, and Problematic
   Files. Different file sizes, formats, durations or bonus-track counts must not
   suppress the warning. No duplicate message belongs below the card.
7. Select and play each duplicate copy. Only that source's tracks belong to its
   queue. Check different-year, different-artist, unknown metadata and multidisc
   examples for false duplicate warnings.
8. With an account that can browse the library but lacks `library.paths.read`,
   confirm the duplicate warning and default playback remain available, while
   alternate-copy folders, track lists and source selection are absent.
9. Disable source icons while retaining a color indicator. Duplicate and missing
   inventory warnings remain available. `Album not found` is only for missing
   inventory, not missing artwork or duplicates.

The full scan has published 159,545 file entries. After the cover pass, record
its completion/no-match results, unavailable roots and remaining errors.
Preserve existing selected art.
Functional E2E and complete CI/release gates are separate follow-up checkpoints.
