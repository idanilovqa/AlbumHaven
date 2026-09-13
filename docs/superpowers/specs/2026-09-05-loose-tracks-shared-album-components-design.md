# Loose Tracks shared Album Details components

## Goal

Make the Loose Tracks modal use the approved Album Details header and track-table components instead of maintaining similar modal-local markup. Preserve the Album Details table's playback interactions and visual states exactly, while allowing Loose Tracks to supply its additional file-path data. Align interactive error labels in Problematic Files with the existing gallery artbox error action so error controls retain an error-family outline instead of the global mint interaction outline.

## Approved visual direction

Loose Tracks is a variant of the existing Album Details composition, not a separately styled table or header.

- The header uses the same `AlbumDetailsHeader` bar, typography, spacing, and shared action buttons as Album Details.
- Its copy is `Loose Tracks` with the existing explanatory subtext. Its actions are Edit tags and Close only.
- The body uses the same `AlbumTrackTable` component, including hover and selected states, play-button activation motion, currently-playing row glow and perimeter animation, reduced-motion behavior, structural outline, and Total Length footer glow.
- Loose Tracks columns are Play, `#`, Track with artist subtitle, File path, the existing unlabeled problem/status action slot, and Length.
- The problem/status header remains visually absent. The existing Problematic Files icon and navigation behavior are preserved unchanged. No new info, warning, or error labels are introduced in either track table by this work.
- Total Length appears once at the bottom of the complete Loose Tracks table, after all displayed Loose Tracks groups.

No additional mockup is required because the approved target is exact reuse of existing production components and their current visual behavior.

## Component design

### Album Details header

Extend `AlbumDetailsHeader` with narrow identity and action configuration rather than adding a Loose Tracks header implementation. The component will accept caller-owned title/subtitle content and DOM identifiers while retaining its existing Album Details defaults. Its action renderer will accept the approved action set so Loose Tracks can request Edit tags and Close without rendering raw modal-local buttons.

The Loose Tracks modal template will expose a header host. Opening or refreshing the modal renders the configured shared header into that host. Existing Loose Tracks action hooks and accessible labels remain stable so edit and close behavior do not change.

### Album track table

Extend `AlbumTrackTable` through optional column and row fields while preserving its existing Album Details defaults. `CompactDataTable` remains a layout primitive; it will not acquire playback, album, or Loose Tracks policy.

The Loose Tracks adapter supplies:

- playback identity and state;
- displayed row number;
- track title and artist subtitle;
- display-safe file path;
- duration;
- optional existing problem action metadata; and
- group identity and label.

The shared table owns row markup and class names, play controls, current/playing state classes, animation classes, duration formatting, and the single Total Length footer. Loose Tracks categories such as Non-album rarity, Interviews, and Other render as groups within that one table composition. Group labels remain visible even when a group is the only populated group.

The hidden-header problem/status action slot remains supported by the main Album Details table and the Loose Tracks variant. This work does not repurpose it: problematic tracks continue to render the current Problematic Files icon, and tracks without that condition render an empty cell.

### Semantic error labels

Introduce a reusable semantic alert-label treatment for the textual problem pills in Problematic Files. Static labels and interactive exclusion labels share the same base component, with the interactive variant adding button semantics and selected state.

The component uses the existing alert severity palette (`--alert-edge`, `--alert-tint`, and `--alert-ink`) that drives the gallery artbox `SmallAlert`. Error labels therefore match the gallery action's red edge, dark red tint, red-white text, and restrained red glow. Hover, selected, and keyboard-focus states use a brighter or dimmer mix of `--alert-edge`; they must not inherit the global mint interaction outline. Keyboard focus remains clearly visible and meets the same shape boundary as hover without changing semantic color family.

`SmallAlert` remains the specialized expandable gallery hover action. The new textual label and `SmallAlert` share semantic tone variables rather than forcing different interaction models into one DOM component.

## State and event flow

The Loose Tracks controller continues to own modal data loading, grouping, tag editing, closing, and playback commands. It maps server-owned track data into `AlbumTrackTable` inputs. Playback refresh applies the same current, playing, animated, and `data-track-playing` state contract used by Album Details, so existing player events update both surfaces identically.

Total Length is the sum of the durations of all tracks rendered in the current Loose Tracks result. Missing or invalid individual durations remain display-safe and do not break the total.

Problematic Files retains its existing exclusion and navigation event hooks. Replacing hand-built pill markup with the shared semantic label must not change data attributes, accessible names, selected state, enabled state, or click behavior.

## Accessibility and responsive behavior

- Header titles, subtitles, buttons, and modal labelling retain unique Loose Tracks IDs and accessible names.
- The play button remains the first column and keeps the current Album Details accessible playback labels.
- The problem/status column has no visible header but retains cell semantics.
- File paths may truncate visually, while the existing safe full-value affordance remains available where currently supported.
- Interactive error labels have a visible same-family keyboard-focus ring and preserve `aria-pressed` or disabled state where applicable.
- Existing reduced-motion rules continue to suppress track-table animation.

## Permissions, deployment, and clients

This refinement adds no action, permission, capability, storage, endpoint, or deployment-mode change. Edit tags, playback, close, and Problematic Files navigation retain their existing authorization and client constraints, so the private permission registry needs no new entry.

Client classification for this visible current-web refinement:

- Web: required.
- Tauri: required through the shared web UI.
- Android: unsupported by this slice.
- TV: unsupported by this slice.
- Apple: unsupported by this slice.

## Verification

Add failing focused tests before implementation, then verify:

- `AlbumDetailsHeader` renders configurable Loose Tracks copy and only the shared Edit tags and Close actions without changing Album Details defaults.
- `AlbumTrackTable` preserves its default Album Details output and supports the Loose Tracks column order and artist/path fields.
- Loose Tracks uses one shared table with visible group labels and one correctly summed Total Length footer.
- Loose Tracks playback refresh applies the same current, playing, animated, and playback-data states as Album Details.
- Existing problematic-track icons and Problematic Files navigation markup remain unchanged.
- Problematic Files static and interactive reason labels use the shared semantic alert-label component and error-family hover/focus/selected styling without the global interaction-outline color.
- Existing component CSS tests continue to protect Album Details row hover, play activation, playing-row animation, reduced motion, and footer glow.
- The existing Loose Tracks E2E case is updated to assert the shared header/table composition and behavior after focused unit tests pass.

Manual verification will compare Album Details and Loose Tracks side by side, exercise play and playback transitions, inspect group totals, open Edit tags, close the modal, and confirm Problematic Files error pills keep red-family hover and keyboard-focus treatment.

## Alternatives considered

1. **Extend the existing header and table with narrow configuration points (selected).** This keeps one source of truth for the exact behavior the owner requested and leaves `CompactDataTable` domain-neutral.
2. **Create Loose Tracks wrappers by copying Album Details internals.** This is initially smaller but would duplicate animation, footer, accessibility, and state contracts and would drift again.
3. **Move playback and semantic-label behavior into `CompactDataTable`.** This would overgeneralize a layout primitive and couple unrelated table consumers to album-domain behavior.
