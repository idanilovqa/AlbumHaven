# Player Centerline Mode Layout Design

## Owner-approved result

The expanded bottom player uses separate geometry for waveform and regular seekbar modes. The owner approved the final local mockup on September 4, 2026.

Waveform mode keeps the 92px player and 56px waveform. The collapse chevron, artwork, Play/Pause button, and waveform share a centerline 57px below the player top. Metadata starts at the player inner-left edge above the controls. The timestamp stays at the right edge.

Regular mode reduces the player to 68px. After the first live review, the owner moved the complete regular-player group upward by 4px so the seekbar no longer touches the bottom edge. The collapse chevron, artwork, Play/Pause button, seekbar track, and seek thumb now share a centerline 39px below the player top. Metadata stays aligned with the seekbar start, to the right of Play/Pause. The timestamp stays at the right edge. Metadata begins 10px and the timestamp 11px below the player top. The 48px timeline box begins at 15px, leaving 5px of bottom padding.

The player stays anchored to the viewport bottom. The regular-mode height reduction removes 4px from the prior 72px mockup's top edge. It does not move the player bottom.

## Runtime layout contract

The existing `PlaybackControlCluster` keeps control ownership. The player controller gives the expanded player a mode class derived from the same `loopActive || seekbarMode === 'waveform'` rule that decides whether to render the waveform. CSS uses that class for player height, grid columns, text placement, and the controls centerline.

Waveform mode lets `.player-meta` span from the player's inner-left edge. The controls occupy the row below it. `.player-main` keeps the waveform start to the right of the controls so the waveform never paints behind artwork or Play/Pause.

Regular mode keeps `.player-meta`, `.player-time`, and the seekbar inside `.player-main`. Their horizontal anchors remain unchanged. The player applies the revised 10px, 11px, and 15px vertical offsets and 68px height only while the regular seekbar is active.

Loop editing continues to force waveform mode. Switching the Appearance preference or entering and leaving loop editing updates the player mode class and geometry through the existing render path.

## Behavior, permissions, and client support

The revision changes layout only. Existing playback, queue, seek, waveform, loop, artwork, keyboard, focus, and disabled-state behavior stays intact. The owner-locked AudioWorklet and PCM streaming architecture does not change.

The component grants no capability and adds no action. Hosted and self-hosted deployment support stays unchanged. Web desktop is required. Tauri may use the shared web renderer. Narrow web keeps its existing fallback. Android, TV, and Apple remain unsupported for this current-web slice.

## Test proposal

Focused source and component tests will cover both modes:

- Waveform mode keeps a 92px player and 56px waveform.
- Waveform controls and waveform share the 57px centerline within 1px.
- Waveform metadata begins at the player's inner-left edge, while the timestamp stays right-aligned.
- Regular mode uses a 68px player.
- Regular controls, seek track, and thumb share the 39px centerline within 1px.
- Regular metadata begins at the seekbar start and uses the revised 10px top offset; the timestamp uses 11px.
- The regular 48px timeline box ends 5px above the player bottom edge.
- Loop editing selects waveform geometry even when the saved preference is regular.
- Mode changes preserve playback and seek state.

The component screenshot suite will retain one image for waveform mode and add one for regular mode. The functional E2E proposal extends the approved player-view scenario with one test that changes seekbar style through the normal Appearance flow, verifies both geometries, starts loop editing from regular mode, and confirms the waveform geometry appears without interrupting playback. The test uses the existing isolated functional data profile and maps to the existing player-view contract; it adds assertions without weakening established expectations.

## Manual acceptance

The owner will verify the live player at desktop width in regular playback, waveform playback, and loop editing. The check covers both centerlines, the regular player's 5px bottom padding, both metadata anchors, the 68px regular height, the 92px waveform height, seeking, and expanded-to-compact transitions.

## Approved artifact

The private owner registry stores the final mockup at `docs/design-mockups/components/playback-control-cluster/v002/index.html`. The amber centerline in the regular-player mockup is an approval aid and will not render in the product.
