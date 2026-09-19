# Utilities refactor intake

Status: draft intake; no visual artifact or technical design approved yet.

## Confirmed owner direction

- Branch: codex/settings-refactor, based on 2026-09-05-gallery-refactor at 8111f2ecf7abd6d274ae4866d7ae8e6eba101931.
- On September 8, 2026 the owner explicitly chose: "use current stack".
- Use the current Jinja/template, JavaScript, and CSS stack for this redesign. This is the task-specific exception to React migration requirements, not approval of a broader architecture change.
- The attached owner handoff is preserved verbatim in source/owner-handoff.txt.
- Scope is the Utilities shell and the handoff's Problematic Files, Rules, Loops, Log History, and Integrations states. Appearance is an existing structural reference and shares the shell.
- Match the Gallery, main page, and admin panel visual language with reusable app components.

## Existing implementation findings

- Utilities shell: music_app/templates/partials/primary-modals.html.
- Tab/detail rendering: music_app/static/js/runtime/utility-renderers-and-actions.js.
- Lists, problem detail, rules, and integrations: music_app/static/js/runtime/utility-list-builders.js.
- Delegated interactions: music_app/static/js/runtime/bootstrap-utility-event-handlers.js.
- Problem mutations: music_app/static/js/runtime/problem-exclusion-mutations.js.
- Saved-loop playback: music_app/static/js/runtime/utility-loop-playback.js.
- History export: music_app/static/js/runtime/browser-log-history-store.js.
- Existing reusable pieces include AlertLabel, compact tables, NavigationTree styling, SearchInput styling, Button/ActionButton, album details components, and player controls.
- Log History and Integrations currently disable their sidebar search. Enabling these is a functional addition.
- History currently offers a single Export Logs action. Selected-log export and filtered bulk export need explicit behavior design.
- Existing problem-detail actions also include separate-release handling and missing-album removal. Preserve these flows in the redesign even though the handoff does not illustrate them.

## Review checklist

- [x] Preserve owner handoff and record current-stack decision.
- [x] Verify branch base.
- [ ] Confirm visual review format with owner (local interactive recommended; image or Figma alternatives).
- [ ] Capture current connected/similar screens.
- [ ] Inventory existing authority and identify any new action-policy decisions; do not infer new access from UI visibility.
- [ ] Prepare reusable-component mapping and proposed extensions.
- [ ] Prepare normal, confirmation, loading, empty, error, disabled, and narrow-layout review states.
- [ ] Obtain exact visual-artifact and technical-design approval.
- [ ] Record functional cases and focused test proposal before implementation.

## Open decisions

- Mockup format is pending owner response.
- Deployment/client classification and action-policy changes are not approved by the current-stack choice.
- The handoff's optional Include file paths export control is not authorization to expose raw local paths; exclude this optional control from the initial proposal pending explicit policy review.
- No production UI has been changed by this intake.

## September 8 interactive draft

Owner selected local interactive mockups. The draft is index.html, served only on localhost at http://127.0.0.1:8766.

The preview provides all six tabs, sidebar search, selectable problem labels, row selection, separate Create Exception and Revert rule dialogs, expanded loop navigation, loop-card footers, the console view, filtered-export controls, Last.FM sections, and an Appearance context placeholder.

This is an initial layout study, not an implementation-ready approved artifact. Playback, mutation, export, integration, and filter-application actions are simulated. Loop waveform handles and nested-loop reorder are visual affordances only. Non-Last.FM integration detail forms still need mapping to the real app. Missing-album and separate-release states, other edge states, and exact current-component fidelity remain to be reviewed.

Browser checks: selecting a track enables Create Exception; the dialog reflects the selected problem. Revert rule opens No/Yes confirmation. Export all logs opens filters and Custom reveals date inputs. Loops renders controls inside each card footer. Production tests were not run because production files are unchanged.

Reference provenance: references/stored-library-desktop.jpg and stored-admin-desktop.jpg are prior screenshots from the private NavigationTree v001 record, not fresh September 8 captures. The owner confirmed the app is running on port 5001. Browser navigation to https://localhost:5001 succeeds but requires sign-in; fresh connected-app capture is pending. The earlier port probe was insufficient evidence that the app was stopped.

Approaches considered: (1) shared-shell and per-tab component adoption, recommended to cover the handoff consistently; (2) CSS-only restyling, insufficient for the new interaction states; (3) replacing all Utilities behavior at once, more regression risk than preserving the existing action owners. The owner chose current stack; exact design approval remains pending.
