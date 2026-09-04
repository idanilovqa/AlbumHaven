# Expanded Player Layout and Playback Control Cluster Design

## Approved outcome

Album Haven will tighten the expanded bottom player around its title, time, waveform, artwork, and playback controls. The waveform center will match the expanded Play/Pause button center. The title and time will sit closer to the waveform. The player will keep about 6px of clearance below its lowest visible element and 6–8px above the text. The implementation will start from the current 108px height and remove any height that remains unused above the text after alignment.

Album Haven will also replace the player’s separate playback-control markup with one reusable `PlaybackControlCluster` component. The component owns its buttons, loop-action area, layout, state hooks, and accessibility contract. Player layouts select a component variant instead of attaching buttons or action pods around a standalone Play/Pause button.

The owner approved this design from the current-player screenshot and the written layout criteria on 2026-09-03.

## Component boundary

`PlaybackControlCluster` renders one root element and owns these controls:

- Previous
- Play/Pause
- Next
- Loop entry
- Loop edit, save, and cancel actions

The component supports layout variants while preserving one state and ownership contract:

- `expanded-player` shows Play/Pause and the loop action area. It keeps Previous and Next hidden.
- `compact-player` shows Previous, Play/Pause, and Next. It keeps loop actions hidden.
- `saved-loop` shows Play/Pause and its loop action area in saved-loop rows.

Each variant renders only its supported controls inside the component root. CSS positions child controls relative to that root. A player shell must not mount a loop pod, transport button, or action overlay outside the component and place it over the component with page-level coordinates.

The component exposes named elements and callbacks for previous, play/pause, next, loop entry, save, and cancel. Existing playback and loop controllers keep authority over playback state and loop sessions. They pass state into the component and handle emitted actions. The component owns rendering and layout; it does not create a second playback state store.

The current web stack needs matching JavaScript and Jinja render paths because the expanded and compact player shells start in the server template while saved-loop rows render in JavaScript. This slice migrates all three consumers. Both paths must emit the same root classes, variant names, action attributes, accessible names, and disabled semantics.

## Expanded player layout

The expanded player uses one vertical composition for metadata and waveform:

```text
top clearance: 6–8px
title / album                                      elapsed / duration
gap: 4–6px
artwork   [ PlaybackControlCluster ]   waveform, 56px high
bottom clearance: about 6px
```

The layout must satisfy these measurable rules at the reference desktop width:

- The waveform’s vertical center and the Play/Pause circle’s vertical center differ by no more than 1px.
- The waveform remains 56px high.
- The metadata row ends 4–6px above the waveform’s visible top edge.
- The player’s lowest visible child ends about 6px above the player’s bottom edge.
- The player leaves 6–8px between its top edge and the metadata text box.

The implementation will first align and position the content within the current 108px player. If the top clearance exceeds 8px after the other rules pass, the implementation will reduce `--player-height` by that excess. It will not shrink the waveform, Play/Pause target, artwork target, text line height, or bottom clearance to reach a smaller height.

Artwork and the expanded control cluster share the waveform center line. The title and time move as one metadata row so their baselines remain aligned. Loop edit handles and the range surface continue to use the waveform’s full height and follow the same vertical placement.

Compact-player dimensions and visible controls do not change in this layout pass. Previous and Next remain visible only in compact mode.

## Behavior and accessibility

The refactor preserves the current playback, queue, seek, waveform, loop-session, artwork, compact-mode, and keyboard behavior. The owner-locked streaming architecture remains unchanged.

Each rendered button keeps native button semantics, a stable accessible name, keyboard activation, focus-visible treatment, and a visible disabled state. The Play/Pause label follows current playback state. Previous and Next expose their existing queue availability. Loop controls expose the existing idle, editing, saving, and disabled states through the component contract.

## Scope

This slice changes the current web player component boundary and expanded-player spacing. It does not migrate the full player to React, change playback architecture, add expanded-player Previous or Next buttons, redesign compact mode, or alter waveform data and drawing behavior.

Web support remains required. Tauri uses the shared web implementation. Native Android, TV, and Apple player renderers remain outside this DOM-component slice.

The implementation must register the reusable component in the private UI component system and store the owner-approved screenshot reference under the design-mockup path selected by the repository workflow.

## Verification

Focused source and component tests will prove:

- one component root owns each variant’s controls and action area;
- expanded mode renders Play/Pause plus loop actions without Previous or Next;
- compact mode renders Previous, Play/Pause, and Next without loop actions;
- saved-loop mode renders Play/Pause plus its loop actions without Previous or Next;
- external player markup no longer mounts transport or loop controls around the component;
- component state preserves accessible names, disabled semantics, and action callbacks;
- the expanded waveform and Play/Pause centers differ by no more than 1px;
- metadata-to-waveform, top, and bottom spacing meet the approved ranges;
- the waveform remains 56px high; and
- existing playback, waveform, loop, compact-player, and generated-bundle contracts pass their focused suites.

Rendered verification will use the same desktop player state shown in the owner’s reference screenshot. The manual check will cover normal playback, paused playback, loop editing, loop save/cancel, compact Previous/Next, and the transition between expanded and compact modes.
