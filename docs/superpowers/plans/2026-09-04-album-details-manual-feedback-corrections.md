# Album Details Manual Feedback Corrections Implementation Plan

**Goal:** Apply the approved Album Details UI corrections for ActionButton hover outlines, problematic-track icon placement, and Editorial table alignment.

**Architecture:** Keep each correction within its existing shared owner: ActionButton styling remains in the shared button component, track status layout remains in AlbumTrackTable/CompactDataTable, and Editorial alignment remains a scoped modal-layout override. Preserve all existing actions and accessible labels.

**Tech Stack:** CSS, vanilla JavaScript runtime components, Node test runner, Playwright component-render verification.

---

### Task 1: Give ActionButton hover the approved focus-style outline

- [x] Add a failing shared-component CSS regression test.
- [x] Add a transparent resting outline and transition.
- [x] Apply the same outline color on hover and keyboard focus.

### Task 2: Move problematic-track status into a dedicated headerless column

- [x] Add failing table-structure regression coverage.
- [x] Add a narrow reserved problem column immediately before Length.
- [x] Keep the warning control, action metadata, and accessible label unchanged.

### Task 3: Verify the approved correction set

- [x] Run the focused JavaScript component suites.
- [x] Rebuild the runtime bundle.
- [x] Render and inspect hover, problem-column, and Editorial-alignment states.
- [x] Confirm the owned browser process exits cleanly.
