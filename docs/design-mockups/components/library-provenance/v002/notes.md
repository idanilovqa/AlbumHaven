# Library provenance v002

Owner selected the subtle treatment, with revisions before implementation.
This version supersedes v001 as the active review candidate; no exact v002
visual approval is recorded yet.

- Appearance > Albums: `Color cards by library source`, proposed default off.
  Reuse own-account Appearance persistence and Save/Cancel in production.
  The mock demonstrates staged preview/save/cancel in memory only.
- Off: ordinary neutral cards; artbox hover frame white in dark theme, black
  in light theme. Source icons appear only on card hover or keyboard focus.
- On: subtle amber Hoard / teal New Arrivals card tint and matching artbox
  hover frames. Main Library remains neutral; mixed albums use dual accents.
- Hovering artwork reveals icons without expanding any label. Each source
  label expands only while that particular icon is hovered or keyboard-focused.
  On touch-only devices icons stay reachable, since hover is unavailable.
- Hoard icon: stacked record sleeves with a visible vinyl disc. New Arrivals:
  open delivery box with a large downward arrow. These are inline SVG review
  assets; shared production icon-catalog adoption follows exact approval.
- Latest owner correction: remove the below-card Duplicate files message.
  Use a warning action at the artbox bottom-right, revealed on card hover/focus.
  Only hovering/focusing that warning expands its `Duplicate files` label.
  Clicking it opens the sample duplicate locations. Each source still opens
  location details; no move workflow is introduced.

Existing production `!` evidence: `music_app/static/js/runtime/virtual-artist-grid.js`
sets `albumMissing` when `inventory_status === 'missing'` (line 19), then adds
`buildSmallAlertHtml({severity:'error',message:'Album not found'})` (lines 58-60).
It is not triggered by duplicates or a missing artwork image. Preserve that
missing-inventory warning separately from category provenance and duplicates.

Reference remains the historical gallery screenshot in v001 and current branch
card/hover source. This is a targeted appearance/interaction review, not a new
production shell or Album Details redesign. v001 is preserved as review history.

Current-stack exception and final technical/test-plan approval remain pending;
choosing subtle does not by itself authorize unrelated React migration work.
