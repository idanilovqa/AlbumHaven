# Cover lookup header alignment and light-theme clear icon

## Outcome

Make the Cover lookups drawer header read as one balanced row. The title and
subtitle form one text block on the left. The clear and close actions on the
right are vertically centered against that complete block. In light themes,
the clear action uses the existing dark icon by default so it remains visible.

## Scope

- Change only the Cover lookups drawer header layout and clear-action icon
  presentation.
- Preserve the current title, subtitle, action order, accessible names,
  disabled behavior, hover behavior, focus behavior, and drawer dimensions.
- Preserve dark-theme icon behavior.
- Do not add a button background, CSS image filter, new image asset, setting,
  persistence field, or JavaScript behavior.

## Layout

The header retains two columns:

- The first column contains the title and subtitle in a normal stacked text
  wrapper.
- The second column contains the existing inline action group.
- Grid alignment centers the action group against the combined height of the
  first-column wrapper rather than against the title line alone.

This removes the current `display: contents` split that places the title and
subtitle in separate grid rows.

## Theme behavior

The existing clear action includes light and dark icon assets. Dark themes
retain the current default and hover/focus swap. Under
`data-appearance-mode='light'`, the dark icon is visible in the default state
and the nearly invisible off-white icon is hidden. Hover and keyboard focus
remain visibly responsive without recoloring or filtering either asset.

## Verification

Rendered component coverage will verify:

- both action-button centers align with the vertical center of the complete
  title/subtitle text block;
- clear and close buttons retain equal geometry;
- the light theme displays the dark clear icon by default;
- the dark theme retains its current default icon behavior; and
- hover/focus continues to expose the intended alternate icon.
