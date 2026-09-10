# Album Track Edge Handoff Design

## Intent

Preserve the original Total Length background glow while making the final table's right outline transition gradually into the footer's accented right outline.

## Approved visual behavior

- The Total Length background and border treatment returns to its original form.
- No glow layer extends inward from the bottom-right corner.
- Only the final table's 1px right outline changes color.
- The outline begins at the ordinary table border color, becomes subtly accented over the final rows, and reaches the footer's existing accent strength at their junction.
- The footer retains its rounded bottom-right border.

## Implementation boundary

The correction remains CSS-only in `music_app/static/css/runtime/album-track-table.css`. A regression test in `tests/js/runtime/album-track-table.test.js` verifies that the transition is edge-only and that the removed corner-blob treatment cannot return.

## Verification

Run the focused AlbumTrackTable tests, rebuild the runtime bundle, and render a representative table in headless Chrome to confirm the edge transition is 1px wide and the Total Length background is unchanged.
