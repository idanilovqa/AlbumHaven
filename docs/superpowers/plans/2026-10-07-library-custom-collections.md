# Library Custom Collections Implementation Plan

**Goal:** Allow library-scoped custom exception types and named Custom Collections, with marked tracks exclusively in Loose Tracks and ordinary tag problems retained.

**Architecture:** Extend existing Postgres exception overrides and tag-edit intents with `custom_collection_name`. Reuse existing source-category scope, non-album projections, shared editor and compact track table. Treat every nonempty exception as non-album; do not maintain a provider-style allowlist of exceptions.

**Approved design:** Owner approved `docs/design-mockups/screens/loose-tracks-collections/v001` on October 7, 2026 with an explicit amendment: use existing Loose Tracks subsection styling and the shared track table, adding collapsible subsections; omit the mockup's separate pills and panels. Collection name is required. Library scope means the current main-library, hoard and new-arrivals source categories, including combined selections. Preserve selected-artist menu behavior; the app-bar entry opens the full selected library scope.

## Delivery and constraints

One vertical delivery: library-scoped exceptions, collection metadata, app-bar entry and grouped table. Prerequisites: approved design above, existing Postgres authority and source-category selection. Relevant acceptance contracts: FTC-TAGS-002, FTC-NON-ALBUM-001 through 004 and 012. Extend behavior additively; retain original rarity/interview order, compact table cells, playback, paths, editing and Problematic Files diagnostics.

No media tag is written for collection metadata. No schema replacement or file/JSON application persistence. Existing override records without a collection name stay readable. Clearing Exception restores normal album classification and clears collection association. A Custom Collection edit without a nonblank effective name is rejected before changes. Keep unrelated dirty work and live Sandbox3 fetch intact. No deployment, push, release or mixed-work commit in this batch.

Compatibility and rollback: new metadata is optional in old records; optional shared-table grouping leaves existing tables unchanged. Reverting the scoped feature preserves durable override payloads, though older code will not display named collection metadata. Merge/publish checkpoint follows owner manual acceptance and normal hosted review/CI in a separately scoped delivery; this accumulated worktree is not automatically published.

## Tasks

- [x] Inspect editor, exception override, gallery/non-album projection, shared table and source-category seams. Capture mixed-work baseline outside the repository.
- [x] Record approval with the existing-subsection/shared-table amendment.
- [ ] Author focused red tests for arbitrary exceptions, required collection name, durable app-only metadata and library isolation.
- [ ] Extend Postgres override payloads, intent recovery and scan/edit projections with `custom_collection_name`; eliminate fixed exception membership allowlists. Validate before mutation.
- [ ] Add editable exception choices scoped to source library, Custom Collection name field, optimistic propagation and app-bar Loose Tracks entry.
- [ ] Extend existing shared track table with optional collapsible nested subsections. Group by exception, then collection or existing folder/album context, retaining tag warnings and edit/playback row identity.
- [ ] Run focused Python then JavaScript tests sequentially; rebuild generated runtime bundle and check encoding/diff integrity.
- [ ] Complete two full relevant-diff review passes, fix confirmed issues and repeat focused checks as needed.
- [ ] Provide owner manual test steps; keep automated E2E acceptance expansion after manual acceptance per feature workflow.

## Verification and handoff

Python selections cover metadata normalization, exception overrides, rule state, edit workflow, tag-edit recovery, scan persistence, inventory/browse and non-album payloads. JavaScript selections cover editor stage/apply, optimistic non-album membership, modal/table and source-scope ownership. Use one pytest process maximum; Python and JavaScript never overlap. The test-author agent supplies exact commands after resolving current harnesses.

Manual steps: select one library; bulk-mark a generated or owner-selected folder as Custom Collection and enter a name; verify gallery disappearance and app-bar Loose Tracks membership; expand the existing-style collection subsection and inspect shared table warnings/edit/playback; reopen metadata and reload to verify persistence; switch library and verify type/collection isolation; create another exception type; clear Exception and confirm restoration. Reject blank collection names before Apply. Existing diagnostics remain independently visible.

Direct task time, process overhead and total elapsed are not reconstructed from commit metadata. Record measured verification results and changed-file inventory before handoff. No acceptance or automation count is promoted without evidence.
