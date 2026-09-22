# Light-theme Artist Family selected-card fill

## Outcome

Selected cards in the Artist Family panel use a solid theme-green fill in light
themes. The fill makes selection unmistakable while remaining part of the
active palette. Dark themes retain the current border-only selected treatment.

## Scope

- Apply the new fill only to `.artist-family-panel__artist.is-active` under
  `data-appearance-mode='light'`.
- Use the existing player/play green token rather than a hard-coded color or a
  new appearance preference.
- Retain the existing green selected border and marker.
- Preserve card dimensions, artwork, text placement, count placement, hover,
  focus, pressed state, and selection behavior.
- Do not change related chips, navigation-tree selection, Gallery cards, dark
  themes, or persistence.

## Selected-card colors

The selected card background uses `--appearance-play` with the existing green
fallback. Text and the count badge use existing contrast-aware theme tokens so
they remain legible over the solid fill. The artwork is unchanged.

Hover and keyboard focus must not replace the solid selected fill with the
ordinary row-hover background. Existing focus indication remains visible.

## Dark themes

Dark themes keep the current card background and green selected border. No
solid green fill is introduced outside light mode.

## Verification

Automated style coverage will verify:

- a selected Artist Family card has a solid play-green background in light
  mode;
- its label and count badge meet the intended contrast-token contract;
- hover and focus preserve the selected fill;
- an unselected light-theme card is unchanged; and
- the equivalent selected card in dark mode remains border-only.

