# Light-Theme Gallery-Bar Hover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Gallery-bar action controls a brighter surface-derived hover only in light appearance mode.

**Architecture:** Keep the existing Gallery-local base surface variable and hover behavior. Add one light-mode override beside the current hover rules, using a 15% white color mix; do not alter shared theme tokens or dark-mode selectors.

**Tech Stack:** CSS color-mix, Playwright component tests.

## Global Constraints

- Scope the override to `.gallery-bar__actions` under `data-appearance-mode='light'`.
- Preserve the existing border, green icon, pressed, focus, disabled, and open-anchor behavior.
- Preserve current dark-mode hover behavior.
- Use `--gallery-toolbar-button-background` as the mix source.

---

### Task 1: Computed hover contract

**Files:**
- Modify: `tests/components/galleryBarAlignment.spec.js`

- [ ] Add a light/dark table-driven component test with explicit Gallery surface, hover, border, and play-color tokens.
- [ ] Assert light hover computes to the 85% Gallery surface / 15% white mix while retaining the existing border and green icon.
- [ ] Assert dark hover continues resolving the existing hover token.
- [ ] Run the exact test and confirm the light assertion fails before implementation.

### Task 2: Gallery-local light hover

**Files:**
- Modify: `music_app/static/css/gallery-main.css`

- [ ] Add the minimal light-mode hover override beside the existing Gallery hover rules.
- [ ] Run the exact component test and confirm both modes pass.
- [ ] Run the complete Gallery component spec and related Gallery CSS contract tests.
- [ ] Run `git diff --check` and verify port 5001 serves the new rule.

