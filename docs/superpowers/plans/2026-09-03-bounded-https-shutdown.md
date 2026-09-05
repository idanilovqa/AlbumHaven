# Bounded HTTPS Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure one `Ctrl+C` cannot leave the direct HTTPS launcher waiting indefinitely on active requests.

**Architecture:** Pass a five-second `timeout_graceful_shutdown` value from the direct HTTPS launcher to Uvicorn. Uvicorn retains its normal connection-drain behavior, then cancels remaining request tasks and invokes the application's existing lifecycle cleanup.

**Tech Stack:** Python, Uvicorn, FastAPI, pytest.

## Global Constraints

- Preserve unrelated authentication changes already present in the checkout.
- Do not change the playback architecture, request contracts, or cover-provider behavior.
- Run Python tests sequentially with at most one pytest process.

---

### Task 1: Bound the direct HTTPS shutdown wait

**Files:**
- Modify: `tests/py/test_start_https.py`
- Modify: `start_https.py`
- Modify: `docs/start-https.md`
- Modify: `../album-haven-internal/docs/functional-test-cases/scan-status-caching-and-operational-flows.md`

**Interfaces:**
- Consumes: `uvicorn.run(app, **kwargs)` and its `timeout_graceful_shutdown` option.
- Produces: direct HTTPS launcher configuration with a five-second graceful-shutdown timeout.

- [x] **Step 1: Write the failing launcher regression**

  Extend `test_main_loads_config_and_launches_only_when_requested` with:

  ```python
  assert calls[0][1]["timeout_graceful_shutdown"] == 5
  ```

- [x] **Step 2: Verify the regression fails for the missing option**

  Run: `python -m pytest tests/py/test_start_https.py::test_main_loads_config_and_launches_only_when_requested -q --tb=short`

  Expected: the non-check invocation fails with `KeyError: 'timeout_graceful_shutdown'`.

- [x] **Step 3: Configure the bounded wait**

  Add a named five-second constant in `start_https.py` and pass it to
  `uvicorn.run` as `timeout_graceful_shutdown=5`.

- [x] **Step 4: Update operator and acceptance documentation**

  Explain the five-second drain window in `docs/start-https.md`. Extend
  FTC-OPS-009 to cover `python start_https.py`, one interrupt, the bounded wait,
  and clean completion without a forced-cancellation traceback.

- [x] **Step 5: Run focused verification**

  Run sequentially:

  ```text
  python -m pytest tests/py/test_start_https.py -q --tb=short
  python -m pytest tests/py/test_runtime_shutdown.py -q --tb=short
  ```

  Expected: both commands exit 0 with no failures.

- [x] **Step 6: Review the scoped diff**

  Confirm the diff contains only the design, plan, launcher, launcher test,
  HTTPS guide, and operational functional case. Do not stage or modify the
  unrelated authentication work.

### Task 2: Remove lifecycle cleanup blockers exposed by manual testing

**Files:**
- Modify: `music_app/__init__.py`
- Modify: `music_app/services/runtime_shutdown.py`
- Modify: `tests/py/test_runtime_shutdown.py`
- Modify: `start_https.py`
- Modify: `tests/py/test_start_https.py`

**Interfaces:**
- Consumes: the library watcher, event coordinator, targeted reconciliation
  daemon executor, and Python's `asyncio` logger.
- Produces: nonblocking watcher cleanup and narrow suppression of Windows
  Proactor connection-reset noise.

- [x] **Step 1: Add failing regressions**

  Require watcher shutdown to stop intake and coordination before calling
  `targeted_executor.shutdown(wait=False, cancel_futures=True)`. Require the
  logging filter to reject only `WinError 10054` emitted by
  `_ProactorBasePipeTransport._call_connection_lost`.

- [x] **Step 2: Implement the lifecycle fix**

  Extract `_stop_library_watch_runtime`, route lifespan cleanup through it,
  and leave the targeted executor's daemon worker unjoined during process exit.

  Exclude `DaemonThreadPoolExecutor` workers from the standard library's
  interpreter-exit join registry; otherwise its exit hook would undo the
  executor's daemon behavior.

- [x] **Step 3: Filter the benign Windows transport record**

  Attach `_WindowsProactorConnectionResetFilter` to the `asyncio` logger only
  while the direct HTTPS launcher runs, and remove it in `finally`.

- [x] **Step 4: Run focused verification**

  Verify the two new regressions, the complete HTTPS launcher test file, and
  the library watcher/coordinator test files.
