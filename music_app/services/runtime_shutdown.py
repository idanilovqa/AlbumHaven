from __future__ import annotations

import threading
import weakref
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures.thread import _threads_queues, _worker
from threading import Lock


_EXECUTOR_REGISTRY_LOCK = Lock()
_REGISTERED_EXECUTORS: list[ThreadPoolExecutor] = []
_RUNTIME_SHUTDOWN_LOCK = Lock()
_RUNTIME_SHUTDOWN_REQUESTED = False


class DaemonThreadPoolExecutor(ThreadPoolExecutor):
    """ThreadPoolExecutor variant whose worker threads do not block process exit."""

    def _adjust_thread_count(self) -> None:
        if self._idle_semaphore.acquire(timeout=0):
            return

        def weakref_cb(_ref, queue=self._work_queue):
            queue.put(None)

        num_threads = len(self._threads)
        if num_threads >= self._max_workers:
            return

        thread_name = "%s_%d" % (self._thread_name_prefix or self, num_threads)
        worker_args: tuple[object, ...]
        if hasattr(self, "_create_worker_context"):
            worker_args = (
                weakref.ref(self, weakref_cb),
                self._create_worker_context(),
                self._work_queue,
            )
        else:
            worker_args = (
                weakref.ref(self, weakref_cb),
                self._work_queue,
                getattr(self, "_initializer", None),
                getattr(self, "_initargs", ()),
            )
        worker_thread = threading.Thread(
            name=thread_name,
            target=_worker,
            args=worker_args,
        )
        worker_thread.daemon = True
        worker_thread.start()
        self._threads.add(worker_thread)
        _threads_queues[worker_thread] = self._work_queue


def create_daemon_executor(*, max_workers: int, thread_name_prefix: str) -> DaemonThreadPoolExecutor:
    executor = DaemonThreadPoolExecutor(
        max_workers=max_workers,
        thread_name_prefix=thread_name_prefix,
    )
    with _EXECUTOR_REGISTRY_LOCK:
        _REGISTERED_EXECUTORS.append(executor)
    return executor


def shutdown_registered_executors(*, wait: bool = False, cancel_futures: bool = True) -> None:
    with _EXECUTOR_REGISTRY_LOCK:
        executors = list(_REGISTERED_EXECUTORS)

    for executor in executors:
        try:
            executor.shutdown(wait=wait, cancel_futures=cancel_futures)
        except TypeError:
            executor.shutdown(wait=wait)
        except Exception:
            continue


def _request_runtime_shutdown_for_state(library_state: dict[str, object]) -> None:
    from music_app.services.cover_refresh_runtime import cancel_cover_refresh
    from music_app.services.state import cancel_background_refresh_for_state

    for cancel in (
        lambda: cancel_background_refresh_for_state(library_state),
        lambda: cancel_cover_refresh(lambda: library_state),
    ):
        try:
            cancel()
        except Exception:
            continue

    library_state["relations_in_progress"] = False
    library_state["relations_phase"] = "Idle"


def request_runtime_shutdown(app=None) -> bool:
    global _RUNTIME_SHUTDOWN_REQUESTED

    with _RUNTIME_SHUTDOWN_LOCK:
        if _RUNTIME_SHUTDOWN_REQUESTED:
            return False
        _RUNTIME_SHUTDOWN_REQUESTED = True

    if app is not None:
        try:
            library_state = app.library_state
            _request_runtime_shutdown_for_state(library_state)
        except Exception:
            pass

    shutdown_registered_executors(wait=False, cancel_futures=True)
    return True
