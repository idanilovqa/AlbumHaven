# Album Track Edge Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bottom-right corner blob with a gradual, edge-only color transition from the final table into the Total Length footer.

**Architecture:** Restore the footer's original accented right border and remove its wide pseudo-element. Add a narrow pseudo-element to only the final CompactDataTable right edge, fading from transparent to the same accent strength used by the footer border.

**Tech Stack:** CSS, Node.js test runner, Playwright visual verification.

## Global Constraints

- Preserve the original Total Length background glow.
- Change outline color only; do not introduce an inward corner glow.
- Keep the transition scoped to a table that has a Total Length footer.

---

### Task 1: Replace the corner blob with an edge-only handoff

**Files:**
- Modify: `tests/js/runtime/album-track-table.test.js`
- Modify: `music_app/static/css/runtime/album-track-table.css`

**Interfaces:**
- Consumes: `.album-track-table__frame`, its final `.compact-data-table`, and `.album-track-table__total`.
- Produces: A 1px right-edge gradient matching the footer's 75% accent border at the junction.

- [x] **Step 1: Write the failing regression test**

Assert that the footer has its original right border and no pseudo-element, while the final table owns a 1px bottom-anchored vertical gradient.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-concurrency=1 tests/js/runtime/album-track-table.test.js`

Expected: FAIL because the footer still owns the 12px corner treatment.

- [x] **Step 3: Implement the minimal CSS correction**

Restore `border-right: 1px solid color-mix(in srgb, var(--album-track-accent) 75%, transparent)` on `.album-track-table__total`, remove `.album-track-table__total::after`, and add a 1px `::after` gradient to the final `.compact-data-table`.

- [x] **Step 4: Verify GREEN and rebuild**

Run the focused test and `npm run build:runtime`.

- [x] **Step 5: Render the result**

Use headless Chrome with the actual AlbumTrackTable CSS and renderer. Confirm the transition remains exactly 1px wide and capture a screenshot for manual acceptance.
