# Editorial Track Table Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the Editorial AlbumTrackTable left edge with the Album Details title and metadata.

**Architecture:** Preserve the Editorial two-column dialog grid and remove only the legacy `20px` track-list indentation when the active Album Details header uses `editorial_canvas`. Keep Classic Bar, Stacked Bar, cover placement, actions, warnings, and narrow-layout behavior unchanged.

**Tech Stack:** Plain CSS and Node's built-in test runner.

## Global Constraints

- Keep the current FastAPI/ASGI, server-rendered template, plain JavaScript, and CSS stack.
- Scope the alignment change to Editorial view.
- Preserve the approved cover, header, actions, table width, and responsive behavior.

---

### Task 1: Remove Editorial table indentation

**Files:**
- Modify: `tests/js/runtime/album-details-components.test.js`
- Modify: `music_app/static/css/runtime/track-modal-and-lightbox.css`

**Interfaces:**
- Consumes: the Editorial `data-album-details-layout="editorial_canvas"` marker and `.track-modal-list` host.
- Produces: an Editorial-only `.track-modal-list { padding-left: 0; }` layout override.

- [ ] **Step 1: Write the failing CSS contract test**

Add a test that reads `track-modal-and-lightbox.css` and requires the Editorial dialog selector to set `.track-modal-list` to `padding-left: 0`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-concurrency=1 tests/js/runtime/album-details-components.test.js`

Expected: one failure because the Editorial-specific track-list override is absent.

- [ ] **Step 3: Implement the minimal scoped override**

Add the Editorial dialog selector beside the existing Editorial `.track-modal-main` rule and set only `padding-left: 0` on `.track-modal-list`.

- [ ] **Step 4: Run focused verification and verify GREEN**

Run: `node --test --test-concurrency=1 tests/js/runtime/album-details-components.test.js tests/js/runtime/track-modal-lightbox-helpers.test.js`

Expected: all focused Album Details and modal lifecycle tests pass.

- [ ] **Step 5: Rebuild runtime assets**

Run: `npm run build:runtime`

Expected: exit code 0 and runtime source/bundle parity remains intact.

## Plan Self-Review

- The task removes the measured `20px` mismatch at its source.
- The selector cannot affect Classic Bar or Stacked Bar.
- No warning, footer, cover, or action positioning changes are included.
