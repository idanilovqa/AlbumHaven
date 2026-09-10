# Player View Test Coverage Design

## Scope

Cover the accepted desktop player layouts as one state model:

- expanded player;
- docked compact player;
- floating compact player;
- collapse and expansion in both compact styles.

The coverage extends the existing `FTC-PLAYER-019` through `FTC-PLAYER-022`
contracts. It does not redefine playback, queue, appearance, or narrow-web
behavior.

## Test layers

### Functional E2E

Production-ASGI Playwright coverage owns behavior that crosses application
boundaries: starting a real generated track, collapsing and expanding without
changing playback identity, selecting and saving Docked or Floating through
Appearance, persisted style after reload, compact transport behavior, Floating
click-versus-drag behavior, viewport clamping, and narrow-web exclusion.

The flow uses visible controls and the existing isolated Postgres/generated-media
fixture. It does not intercept application routes, inject state, or add a runtime
test hook. Player state is read only through visible DOM and existing production
snapshots already approved for E2E observation.

### Rendered component coverage

A deterministic browser component harness renders the production player markup
and production CSS without starting the application or touching Postgres. It
owns geometry and styling contracts:

- the expanded `player-controls` centerline matches the player centerline;
- waveform/main content keeps its separately approved lower centerline;
- Docked chevron, artwork, and transport are balanced and vertically centered;
- Floating compact geometry, overlap, glow, and control visibility remain
  stable;
- expanded and compact controls remain separate accessible component roots.

Numeric bounding-box and computed-style assertions are the primary contract.
One element screenshot per stable layout is retained as a visual review aid.
Animations, caret, and volatile canvas pixels are disabled or masked before the
capture. Baselines are browser-and-platform specific.

## Runner isolation

- Component tests use fulfilled in-memory documents, bind no TCP port, and use
  a process-scoped artifact directory.
- Functional runs receive explicit invocation-scoped application/provider ports
  and output paths from the runner or CI shard definition; they never reuse an
  existing server.
- Each Playwright test receives a fresh browser context. Compact mode local
  storage is reset by context teardown, while server-side Appearance changes use
  the fixture account owned by that isolated run.
- The transition journey stays in one E2E case so no test depends on another
  test's mode, playback, or Appearance mutation.
- Screenshots live only in the component suite. Functional E2E retains traces
  and failure screenshots but does not compare volatile media-backed pixels.

## Acceptance

The work is complete when focused JavaScript/component coverage passes, the
production-parity gate accepts the new E2E actions, and the four player cases
pass through the managed isolated runner without leaving owned processes,
listeners, fixture roots, or database state behind.
