# Cover Lookup Header Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Center the Cover lookups drawer actions against the complete title/subtitle block and keep the clear icon visible in light themes.

**Architecture:** Restore the first header child as a normal stacked text wrapper in the existing two-column grid. Center the unchanged action group against that wrapper, and use appearance-mode CSS to swap the two existing clear-icon assets only in light mode.

**Tech Stack:** CSS Grid, existing Jinja markup/assets, Playwright component tests.

## Global Constraints

- Do not change drawer dimensions, copy, action order, accessible names, disabled behavior, JavaScript, or image assets.
- Preserve existing dark-theme default and hover/focus icon behavior.
- Use the existing dark clear icon as the light-theme default.

---

### Task 1: Header geometry contract

**Files:**
- Modify: `tests/components/coverLookupDrawerHeader.spec.js`
- Modify: `music_app/static/css/runtime/cover-lookup-drawer-and-related.css`

- [ ] Change the component assertion from title-line centering to complete text-block centering.
- [ ] Run the exact test and confirm it fails against `display: contents` and `grid-row: 1`.
- [ ] Make the first child a normal stacked wrapper, simplify the grid to one row, and center the action group.
- [ ] Rerun the exact geometry test and confirm equal action geometry and aligned centers.

### Task 2: Light-theme clear icon contract

**Files:**
- Modify: `tests/components/coverLookupDrawerHeader.spec.js`
- Modify: `music_app/static/css/runtime/cover-lookup-drawer-and-related.css`

- [ ] Add light/dark default plus hover/focus opacity assertions using both existing icon classes.
- [ ] Confirm the light default assertion fails before implementation.
- [ ] Add a light-mode-only opacity swap while retaining existing hover/focus transitions.
- [ ] Run the complete component spec and related cover-lookup tests.
- [ ] Run `git diff --check` and verify port 5001 serves the updated CSS.

