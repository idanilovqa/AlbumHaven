# Settings Button Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inert, interactive Save and Cancel examples to the Appearance settings preview.

**Architecture:** Compose the existing shared Button renderer into `editorMarkup()` and style only the new preview footer. Keep the examples free of production action attributes so the existing controller cannot treat them as real settings actions.

**Tech Stack:** JavaScript markup functions, shared Button component, CSS, Node test runner, Playwright component tests.

## Global Constraints

- Reuse the shared Button component and current Appearance tokens.
- The preview buttons must be focusable but must not save, cancel, or mutate settings.
- Do not add a browser companion or separate mockup surface.

---

### Task 1: Preview button composition

**Files:**
- Modify: `tests/js/runtime/appearance-workspace.test.js`
- Modify: `music_app/static/js/appearance-backgrounds.js`
- Modify: `music_app/static/css/appearance-backgrounds.css`

**Interfaces:**
- Consumes: `ButtonComponent.renderButton(options)` and `editorMarkup()`.
- Produces: `.background-preview-actions`, `[data-background-preview-cancel]`, and `[data-background-preview-save]` markup.

- [x] **Step 1: Write the failing runtime test**

Assert that `editorMarkup()` includes the `Buttons` explanation, shared Button classes, preview-only data attributes, and no real `data-background-save` or `data-background-cancel` attributes on the examples.

- [x] **Step 2: Run the test and verify RED**

Run `node --test --test-concurrency=1 tests/js/runtime/appearance-workspace.test.js` and expect failure because the preview footer is absent.

- [x] **Step 3: Implement the minimal markup and styles**

Load the shared Button component beside the palette catalog, render quiet Cancel and primary Save examples, and add a compact footer below the miniature player. Scope sizing and colors to `.background-preview-actions`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the runtime test plus `tests/js/runtime/button-component.test.js` and `tests/js/runtime/appearance-waveform-recents.test.js`; expect all tests to pass.

### Task 2: Interaction verification

**Files:**
- Modify: `tests/components/buttonInteractionOutline.spec.js`

**Interfaces:**
- Consumes: production Appearance and Button stylesheets.
- Produces: browser coverage for preview hover and keyboard-focus styling.

- [x] **Step 1: Extend the component test and verify RED**

Render the preview action markup and assert the quiet Cancel and primary Save examples use the configured outline during pointer and keyboard interaction. Expect failure before the preview markup is present.

- [x] **Step 2: Complete any minimal CSS correction**

Adjust only preview-scoped selectors if the production cascade prevents the shared interaction states from appearing.

- [x] **Step 3: Run focused browser verification**

Run `npm run test:component -- tests/components/buttonInteractionOutline.spec.js`; expect one passing test.

- [x] **Step 4: Check the diff**

Run `git diff --check` for every file in this plan and expect no whitespace errors.
