# Shared UI Convergence Design

**Date:** September 6, 2026  
**Status:** Owner-approved visual design and written specification
**Scope:** Current web UI component convergence for administration, account pages, alerts, playback controls, the artwork lightbox, and Saved Loops

## Objective

Finish the still-unimplemented UI work requested during the September 5–6 review without redesigning established Album Haven interactions. Existing behavior moves behind shared component contracts; page-local markup and styling are removed only where the approved shared component can preserve the current result.

This is a coordinated design with independently complete implementation slices. Each slice may be implemented and verified separately, but all slices use the same shared primitives and semantic tokens.

## Approved scope

The owner approved the following scope classification on September 6, 2026:

- Existing permissions and capability checks remain authoritative. This work grants no capability and changes no action availability.
- Hosted and self-hosted web deployment modes are supported.
- Desktop and narrow web are required.
- Tauri is optional through the shared web renderer.
- Android, TV, and Apple native clients are unsupported for this DOM-component slice.

The work adds no persistence fallback, media-path exposure, or new server-owned action.

## Controlling visual decisions

The owner approved the cumulative visual direction represented by the brainstorming artifacts under `.superpowers/brainstorm/1918-1788673854/content/`. Later artifacts supersede earlier artifacts when they show the same surface:

- `all-unimplemented-component-mockups-v2.html`: account layouts, admin actions, alerts, and lightbox direction;
- `final-control-details-v4.html`: table SVG-only constraint and audio-derived waveform behavior;
- `saved-loop-heading-v5.html`: Saved Loop title and timestamp hierarchy;
- `play-loop-hover-v8.html`: final Play/loop-action overlap and hover behavior;
- `saved-loop-ribbon-centerline-v10.html`: final mirrored waveform and exact centerline.

The mockup measurement guides are review aids and must not render in production.

## Component architecture

### Shared form controls

Account forms consume shared `Input`, `PasswordInput`, `Select`, and `Checkbox` contracts rather than page-local control styling. Each contract owns its label association, validation state, disabled state, keyboard focus, and theme interaction styling. Page templates supply names, values, descriptions, and authorization-derived disabled state.

The change does not alter form endpoints, field names, server validation, password policy, capability inheritance, or submission behavior.

### Shared tables

`CompactDataTable` remains the general table primitive. It gains or formalizes a frame-free presentation that removes only the outer outline/background while retaining row separators, column semantics, keyboard behavior, responsive treatment, and accessible headers.

`AlbumTrackTable` continues to compose `CompactDataTable`. No table or row visual behavior changes as part of the Play/Pause icon correction.

### Shared actions

`Button` remains the text-action primitive. `ActionButton` remains the square icon-action specialization. The component family gains:

- a destructive semantic modifier whose border, hover, focus, and pressed states derive from the error palette instead of the general green interaction outline;
- `RoundActionButton`, a circular specialization for overlay navigation and dismissal controls. It shares ActionButton semantics, icon sizing rules, focus, disabled behavior, and accessible names while allowing the approved larger circular lightbox target.

All icons use normalized inline SVG viewboxes and explicit centering. Font glyph metrics do not determine icon alignment.

### Shared alerts

One alert schema feeds all visual alert presentations:

- `AlertLabel` for compact inline labels;
- `SmallAlert` for compact expanding artbox actions;
- `OnPageAlert` for persistent explanatory or error content;
- `ToastAlert` for transient operation feedback.

The schema carries severity, title, message, optional action, dismissibility, and stable identity. Producers choose meaning; the component chooses presentation. Success is green, information uses the selected theme-coordinated blue, warning is amber, and error is red.

Appearance exposes one coordinated alert-scheme selection, not four independent color inputs. A scheme supplies all four semantic severities and their edge, tint, ink, focus, and glow relationships. Existing alert meanings and action callbacks remain unchanged.

### Playback components

`PlaybackControlCluster` remains the public player-control component for expanded, compact, and saved-loop variants. A shared internal Play/Pause renderer may remove duplicated markup, but it must emit the existing variant classes, identifiers, data hooks, dimensions, state updates, and accessible labels. Componentization is not permission to redesign the control.

The compound Play plus loop-action control remains owned by the cluster. The main Play button, loop-entry action, expansion behavior, and player-specific tokens remain one coordinated component rather than unrelated neighboring buttons.

### Image lightbox

`ImageLightbox` becomes the owner of the full-size artwork overlay. It owns open/close state, loading and failure states, the image surface, previous/next navigation, zoom/pan behavior, Escape and backdrop dismissal, focus trapping, and focus restoration.

Close, Previous, and Next use `RoundActionButton` with centered SVG artwork. Existing image selection and navigation data remain outside the component and are passed through its public interface.

## Surface designs

### Admin roster

The Add User shared Button centers its icon and label on the button's true horizontal and vertical centerlines.

Each roster row renders actions according to the already-authorized action list:

- zero actions: no action control;
- one action: render that action directly;
- two or more actions: render the shared three-dot `ActionMenu`, which opens the shared dropdown/menu presentation.

Edit uses a pencil SVG in `ActionButton`, not text. Pending-user actions such as Copy invite link and Send invitation email remain available and retain their existing authorization and behavior. A pending row with multiple actions therefore continues to use the three-dot menu.

### My Account

Desktop uses a two-column page composition:

- Change Password occupies the left column;
- Active Sessions occupies the right column.

Change Password is a flat page section. Its shared password inputs are not enclosed by a visible outer panel. Active Sessions uses frame-free `CompactDataTable`. Narrow web stacks the sections in reading order.

### Add/Edit User

Edit User uses the same page grammar as My Account: flat sections, matching dividers, shared controls, and a two-column desktop layout. Access and permissions occupy the left column; Account Settings occupies the right. Account Settings uses the same frame-free `CompactDataTable` presentation as Active Sessions. Add User uses the same applicable form controls and spacing.

The Capability Role row places the shared Select and informational alert side by side. The Select is visibly longer than the alert, approximately a 63/37 allocation at ordinary desktop widths. The informational alert remains concise. On narrow web the two controls stack without truncating the message.

Account-enabled, library-access, and permission controls use shared Checkbox styling and preserve their current disabled/inherited states. Save, Cancel, email, invitation, and revoke actions use shared Buttons with existing semantics.

### Album and Loose Tracks Play/Pause buttons

The only approved change is replacing the current Play and Pause font glyphs inside the existing `AlbumTrackTable` button with normalized centered SVGs. This applies to Album Details and Loose Tracks because both consume the same table component.

The following are immutable in this slice:

- the 28px circular button and its border;
- row geometry, column order, hover, selection, and total-length treatment;
- current-row glow and outline;
- activation and playing animations;
- theme/player color derivation;
- focus and disabled behavior.

The Play triangle may use a minimal optical horizontal offset inside its SVG box. Pause bars remain geometrically centered and do not rely on font baselines.

### Compound Play and loop-action control

The approved geometry preserves the current 48px circular Play button. The loop-action pod sits behind it and shares its bottom edge.

In the resting state:

- the pod is a short oval;
- its left oval cap is fully hidden behind Play;
- the exposed scissors are fully visible;
- scissors use a subdued green-gray ink.

On direct scissors hover or keyboard focus, only the scissors brighten and receive a restrained icon-only glow.

When loop creation expands:

- the pod's left edge, bottom anchor, and scissors coordinates do not move;
- only the right edge grows outward;
- the plain Cancel `×` appears immediately beside the scissors;
- Cancel is gray at rest and red on direct hover or focus;
- Cancel has no circle, pill, background glow, or text glow.

These rules apply wherever the compound control is already used. Existing playback and loop-session state ownership remains unchanged.

### Full-size artwork

The visual presentation remains a dark full-viewport overlay with the existing artwork sizing and navigation placement. Only ownership and control consistency change. Round close and navigation controls use centered SVGs. They do not inherit font-glyph skew or a square ActionButton shape.

### Saved Loop player

The Saved Loop heading contains only the name supplied by the user. It does not add artist, track, source interval, or duplicate time metadata. The current-time/total-duration timestamp remains right-aligned in its existing player top-row position; pitch remains on the left.

The player retains its existing Play/loop-action, pitch, Repeat, Speed, timeline, and delete capabilities. Play, the seek surface, Repeat, and Speed share one exact visual centerline:

- the line crosses the Play glyph's vertical center;
- it equals the waveform's zero-amplitude center;
- it crosses the Repeat glyph's center;
- it crosses the Speed value's visual center.

Pitch and time are positioned above the seek surface without contributing height that pushes the waveform off this centerline.

The existing seekbar appearance choice also controls Saved Loops:

- Default renders the existing range timeline.
- Waveform renders one combined waveform, not separate left and right lanes.

The combined waveform uses the approved mirrored-ribbon treatment. It is derived from the saved loop's decoded PCM samples, combines stereo channel magnitude per time bucket, normalizes the envelope once, and mirrors every measured amplitude above and below zero. It is not decorative or randomly generated. The played region to the left of the playhead is brighter; the remaining region to the right is dimmer. Seeking, duration updates, repeat, pitch, speed, and loop editing retain their existing behavior.

If waveform data cannot be decoded or rendered, the control fails safely to the regular range timeline and reports a non-blocking warning through `ToastAlert`. Playback remains available.

The Remove Loop control becomes a destructive `ActionButton`. Its hover/focus outline stays in the red semantic family and cannot inherit the global green outline. The scroll area provides enough top inset for the first row's outline to render without clipping.

## Toast migration

All current toast producers—including cover lookup scheduling, tag edits, deletion, invitation operations, and similar asynchronous actions—render through `ToastAlert`. Operations that can succeed or fail choose success or error from their result. Blue is reserved for informational state that is neither success nor failure.

Migration changes presentation ownership only. Existing timing, deduplication, cancellation, callbacks, and server error messages remain intact unless a focused test proves an existing inconsistency that must be normalized through the shared schema.

## Accessibility

- Every icon-only control has an explicit accessible name.
- SVGs are decorative within named buttons and are hidden from the accessibility tree.
- Menu triggers expose expanded state and menu ownership.
- Alert severity is conveyed through semantics and text, not color alone.
- Toast announcements preserve the current appropriate live-region priority.
- Lightbox focus is trapped while open and restored to its invoker on close.
- All hover behavior has an equivalent keyboard-focus state.
- Reduced-motion preferences continue to disable nonessential table and glow animation.

## Responsive behavior

Desktop account pages use the approved two-column compositions. At narrow widths, columns stack in source order, role Select and info alert stack, tables retain accessible headers even when visually condensed, and action menus remain within the viewport.

The Saved Loop player keeps the required Play/waveform centerline at supported widths. Existing narrow fallback behavior may hide or move secondary Repeat/Speed controls only where the current implementation already does so; this slice does not invent a new mobile player.

## Error handling

- Server validation errors render through the appropriate OnPageAlert/form error contract.
- Asynchronous success and failure use the matching ToastAlert severity.
- A waveform failure falls back to the regular seekbar without preventing playback.
- A lightbox image failure retains an accessible close path and reports the existing failure meaning.
- Unauthorized actions never render merely because a component supports them.

## Test proposal

Implementation begins with focused failing tests for each slice:

1. Admin roster rendering covers zero, one, and multiple authorized actions; direct Edit uses the pencil ActionButton; pending invitation actions remain in the shared menu.
2. Account rendering proves shared control markup, flat Change Password, two-column desktop composition, frame-free tables, the longer role Select, and narrow stacking.
3. Alert tests prove all four presentations consume one schema, every toast producer routes through ToastAlert, and one Appearance scheme changes the coordinated semantic token set.
4. AlbumTrackTable tests prove Play/Pause SVG markup while pinning existing classes, geometry hooks, and animation-state behavior.
5. PlaybackControlCluster tests pin the existing public hooks plus fixed scissors coordinates, bottom alignment, right-only expansion, and independent scissors/Cancel hover states.
6. ImageLightbox tests cover RoundActionButton markup, centered SVGs, focus trap/restoration, Escape/backdrop close, navigation, loading, and image failure.
7. Saved Loop tests cover title-only heading, unchanged timestamp location, exact transport centerline, default/waveform modes, audio-derived combined peaks, played/unplayed coloring, seek synchronization, safe fallback, and unclipped destructive delete focus.
8. Accessibility-focused DOM tests cover names, ARIA states, live regions, focus behavior, and reduced motion.

Focused JavaScript and Python tests run during implementation. The broader JavaScript and Python suites run before release work. Functional Playwright coverage is proposed after focused verification and owner manual acceptance, following the repository's Wave 2 workflow; it is not added before that acceptance.

## Implementation boundaries

The implementation should be split into independently reviewable vertical slices:

1. shared action/icon foundations and the table SVG-only correction;
2. account/admin shared controls, layouts, tables, and menus;
3. unified alerts, ToastAlert migration, and Appearance scheme;
4. ImageLightbox and RoundActionButton adoption;
5. PlaybackControlCluster preservation refinements and Saved Loop waveform/centerline/delete behavior.

Each slice must update the private component registry and its functional-case proposal before production implementation, preserve server authorization, and stop for manual acceptance after focused verification. Existing unrelated UI and the already-implemented Appearance sticky-preview, Loose Tracks shared table/header, and Problematic Files alert-label work are outside this implementation scope.
