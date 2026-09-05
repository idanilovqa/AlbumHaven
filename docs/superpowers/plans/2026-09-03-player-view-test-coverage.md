# Player View Test Coverage Implementation Plan

1. Add rendered player locators and actions for collapse, expand, style save,
   mode/geometry observation, Floating drag, and narrow-web observation.
2. Add a production-ASGI functional spec covering `FTC-PLAYER-019` through
   `FTC-PLAYER-022` as an isolated player-state journey.
3. Register the case in the fixture matrix and functional shard manifest.
4. Add a no-server component harness with geometry, computed-style, accessibility,
   and stable element-screenshot assertions for expanded, Docked, and Floating.
5. Make component artifacts invocation-scoped while keeping committed snapshot
   baselines stable.
6. Add focused source contracts for configuration and action-path safety.
7. Run focused Node tests, component Playwright, production parity, and the
   isolated functional target with explicit unused ports; verify process and port
   cleanup before reporting completion.
