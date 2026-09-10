# Player & Seekbar Mode Hierarchy Design

## Approved outcome

The Appearance editor separates always-applicable player appearance from waveform-seekbar customization. Selecting Default seekbar leaves the real application's existing loop-selection behavior unchanged: an active loop may still reveal the waveform because the loop UI requires it. The Appearance page, however, treats waveform colors and handles as unavailable while Default seekbar is selected.

## Page hierarchy

The Player & Seekbar page keeps this order:

1. Player preview.
2. Player themes and Recent sets.
3. Always-available Player appearance controls.
4. Seekbar style selection.
5. Conditional Waveform seekbar controls.
6. Compact player setting.
7. Shared Appearance footer.

Player themes, Recent sets, Surface, and Controls apply to both Default and Waveform seekbar modes. Surface covers the player background and gradient. Controls covers play-button and control-outline colors.

The Seekbar style section contains the existing Default seekbar and Waveform seekbar radio buttons. It remains a browser display preference that applies immediately through the current client-preference path.

## Conditional waveform controls

When Default seekbar is selected:

- the preview renders a plain seekbar instead of a waveform;
- Waveform and Edges & handles navigation is absent;
- waveform fill, waveform edge, recent waveform colors, handle color, and browser-color recovery are hidden;
- hidden waveform controls cannot receive focus or dispatch edits;
- existing saved or draft waveform values remain intact for later use.

When Waveform seekbar is selected:

- the preview renders the approved stereo waveform;
- Waveform and Edges & handles controls appear;
- their fields, recent colors, handle preview, and recovery action work as they do now.

If the user switches from a waveform-only panel to Default seekbar, the editor returns to Surface before hiding waveform-only navigation. Switching back to Waveform restores the preserved waveform values.

## Player themes and Recent sets

Permanent Player themes remain complete player configurations. While Default seekbar is selected, choosing a theme applies its player surface and control colors immediately in the preview and preserves the theme's waveform and handle colors as latent values. Switching to Waveform later reveals those stored values.

Recent sets behave the same way: restoring a set updates the whole player configuration, while only the surface and control portions are visible in Default mode.

## Real player behavior

This change does not disable waveform rendering in the application. The existing player rule that displays the waveform for an active loop remains intact. It does not change loop selection, handles, seeking, waveform geometry, or playback behavior.

## State and accessibility

The Appearance page reads the current `state.player.appearance.seekbarMode` value used by the Seekbar radio group. Conditional controls use actual `hidden` state rather than visual dimming alone, so unavailable controls leave the focus order and cannot be activated.

The selected radio keeps native checked semantics. The conditional waveform region is associated with Waveform seekbar and becomes available immediately after that radio is selected.

## Verification

Focused tests cover:

- Default mode shows Player themes, Recent sets, Surface, Controls, Seekbar style, and Compact player.
- Default mode hides waveform and handle navigation, fields, recent colors, recovery, and waveform preview.
- Waveform mode reveals those controls and the stereo preview.
- Switching to Default from a waveform-only panel returns to Surface.
- Hidden waveform values survive mode changes and remain part of complete themes and recent sets.
- The real player still shows its waveform when loop selection requires it.
