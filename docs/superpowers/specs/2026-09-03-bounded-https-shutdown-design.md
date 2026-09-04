# Bounded HTTPS shutdown

The direct HTTPS launcher currently uses Uvicorn's default unlimited graceful
shutdown wait. When cover requests remain active, the first `Ctrl+C` closes the
listener but can wait forever before FastAPI lifecycle cleanup cancels runtime
work. A second `Ctrl+C` forces Uvicorn to cancel the lifecycle task and prints a
`KeyboardInterrupt` / `CancelledError` traceback.

## Design

- Configure the direct `start_https.py` launcher with a five-second Uvicorn
  graceful-shutdown timeout.
- Preserve normal graceful completion for requests that finish within that
  window. After the window, let Uvicorn cancel remaining request tasks and then
  run the existing FastAPI lifecycle cleanup.
- Keep the timeout local to this direct HTTPS launcher. Do not change reverse
  proxy deployments, `python app.py`, request behavior, cover-provider policy,
  or the owner-locked playback architecture.
- Add a focused launcher regression asserting the exact timeout passed to
  Uvicorn. Update the HTTPS operator guide and FTC-OPS-009 to record that a
  single interrupt has a bounded completion window when work is active.

## Verification

Run the focused HTTPS launcher tests and the existing runtime-shutdown tests
sequentially. Manually start `python start_https.py` with browser connections
active, press `Ctrl+C` once, and confirm that the process exits within the
five-second drain window plus cleanup time without requiring `taskkill`.
