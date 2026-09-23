# Shared UI Convergence Implementation Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement these plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved shared-component convergence design as five independently testable slices while preserving current playback visuals and behavior.

**Architecture:** Establish the smallest shared primitives first, migrate page owners through compatibility facades, and leave generated assets and functional E2E coverage until focused tests and owner manual acceptance are complete.

**Tech Stack:** Browser JavaScript, Jinja templates, CSS custom properties, Node test runner, Python ASGI tests, Playwright, generated runtime bundle.

## Global Constraints

- Canonical design: `docs/superpowers/specs/2026-09-06-shared-ui-convergence-design.md`.
- Capability model: no new permissions or capabilities; preserve every existing authorization check.
- Deployment/client matrix: hosted and self-hosted web required; desktop and narrow web required; Tauri optional through the shared renderer; Android, TV, and Apple unsupported.
- Keep the PlaybackControlCluster play button, loop pod placement, AlbumTrackTable rows, playback animation, and hover behavior visually unchanged except for approved centered SVG glyphs.
- Keep timestamps in their current saved-loop player location and show only the user-assigned loop name above the player.
- Keep the existing Problematic Files icon and navigation behavior.
- Update `C:/Repositories/album-haven-internal/docs/ui-component-system.md` in the implementation commit that introduces or materially extends each reusable component.
- Do not edit `music_app/static/js/runtime-bundle.js` by hand; regenerate it with `npm run build:runtime` after source tests pass.
- Do not add functional E2E coverage until the owner manually accepts the implemented slice.
- Preserve unrelated worktree changes, including `.superpowers/`, `tests/js/runtime/gallery-card-component.test.js`, `tests/js/runtime/gallery-main-refactor-contracts.test.js`, and `tests/py/test_shared_app_bar_templates.py`.
- Run Node tests with `--test-concurrency=1`; run at most one pytest process across the task.

## Execution Order

1. [Shared actions and track icons](2026-09-06-shared-actions-and-track-icons.md)
2. [Account and admin components](2026-09-06-account-and-admin-components.md)
3. [Unified alerts and toasts](2026-09-06-unified-alerts-and-toasts.md)
4. [Image lightbox](2026-09-06-image-lightbox.md)
5. [Saved-loop player](2026-09-06-saved-loop-player.md)

Slices 2-5 depend on Slice 1. Slices 3-5 are otherwise independently reviewable. After all accepted slices are complete, regenerate the runtime bundle once, run the combined focused suites, run `npm run test:js`, and then follow the repository's release/regression workflow if publication is requested.
