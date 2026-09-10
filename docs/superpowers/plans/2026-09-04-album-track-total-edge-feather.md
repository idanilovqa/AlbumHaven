# Album Track Total Edge Feather Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Total Length strip's right edge emerge gradually instead of beginning as a hard vertical accent line.

**Architecture:** Keep the existing right-anchored footer, horizontal fill fade, text, and lower-right geometry. Remove the uniform physical right border and draw that edge with a dedicated pseudo-element whose vertical gradient starts transparent at the top seam and strengthens smoothly toward the rounded corner.

**Tech Stack:** Plain CSS and Node's built-in test runner.

## Global Constraints

- Preserve the approved `AlbumTrackTable` structure and current FastAPI/ASGI, server-rendered template, plain JavaScript, and CSS stack.
- Preserve the existing horizontal background and mask fade, Total Length text, spacing, and final rounded lower-right corner.
- Change only the decorative right edge; add no behavior, persistence, or client-support changes.

---

### Task 1: Feather the Total Length right edge

**Files:**
- Modify: `tests/js/runtime/album-track-table.test.js`
- Modify: `music_app/static/css/runtime/album-track-table.css`

**Interfaces:**
- Consumes: `.album-track-table__total`, `--album-track-accent`, and the existing footer geometry.
- Produces: a non-interactive `.album-track-table__total::after` edge decoration with a transparent-to-accent vertical ramp.

- [x] **Step 1: Write the failing CSS contract test**

Extend the footer test to require `position: relative`, no uniform `border-right`, and an absolutely positioned `::after` pseudo-element using `linear-gradient(to bottom, transparent ... accent ...)`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-concurrency=1 tests/js/runtime/album-track-table.test.js`

Expected: the footer-edge assertion fails because the current stylesheet still uses a solid `border-right` and has no `::after` gradient edge.

- [x] **Step 3: Implement the minimal CSS change**

Set the footer to `position: relative`, replace its physical right border with `border-right: 0`, and add a pointer-events-disabled `::after` positioned on the right edge. Give the pseudo-element a one-pixel width and a top-to-bottom gradient that starts transparent, eases through low-strength accent, and reaches the existing edge strength near the lower-right curve.

- [x] **Step 4: Run focused verification and verify GREEN**

Run: `node --test --test-concurrency=1 tests/js/runtime/album-track-table.test.js`

Expected: all AlbumTrackTable tests pass with zero failures.

- [x] **Step 5: Rebuild and verify runtime parity**

Run: `npm run build:runtime`

Expected: exit code 0 and the generated runtime bundle remains in parity with its source modules.

## Plan Self-Review

- The task covers the approved right-edge fade without widening scope.
- It preserves the footer's horizontal dissolve and content.
- The RED failure is specific to the missing feathered edge, and GREEN verifies the source stylesheet contract.
