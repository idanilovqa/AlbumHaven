import threading

import pytest

from music_app.services.progressive_scan_publication import ProgressiveScanPublisher, contiguous_revision


def _folder(name, count=2):
    return {f"C:/m/{name}/{index:02}.flac": {"path": f"C:/m/{name}/{index:02}.flac", "title": f"{name} {index}"}
            for index in range(count)}


class Recorder:
    def __init__(self, fail_on=()):
        self.calls = []
        self.fail_on = set(fail_on)
        self.revision = 10
        self.published = threading.Event()

    def __call__(self, root_id, entries):
        self.calls.append((root_id, sorted(entries)))
        if len(self.calls) in self.fail_on:
            raise RuntimeError("database unavailable")
        self.revision += 1
        self.published.set()
        return {"inventory_mutation_revision": self.revision}


def test_full_batches_publish_while_the_scan_runs_and_the_rest_on_close():
    recorder = Recorder()
    publisher = ProgressiveScanPublisher(recorder, max_albums=2, max_seconds=3600).start()
    folders = {name: _folder(name) for name in ("a", "b", "c")}
    for name, entries in folders.items():
        publisher.submit("root-1", {name: entries}, False, frozenset(entries))

    assert recorder.published.wait(5), "the first full batch must publish before the scan ends"
    publisher.close()

    assert recorder.calls == [
        ("root-1", sorted({**folders["a"], **folders["b"]})),
        ("root-1", sorted(folders["c"])),
    ]
    assert publisher.revisions == [11, 12]
    assert publisher.first_published_at is not None
    assert [batch["files"] for batch in publisher.batches] == [4, 2]


def test_a_partial_batch_publishes_after_its_time_limit():
    recorder = Recorder()
    publisher = ProgressiveScanPublisher(recorder, max_albums=100, max_seconds=0.05).start()
    entries = _folder("slow")
    publisher.submit("root-1", {"slow": entries}, False, frozenset(entries))

    assert recorder.published.wait(5), "a lone album must not wait for a full batch"
    publisher.close()
    assert recorder.calls == [("root-1", sorted(entries))]


def test_unchanged_folders_are_not_published_and_roots_publish_separately():
    recorder = Recorder()
    publisher = ProgressiveScanPublisher(recorder, max_albums=100, max_seconds=3600).start()
    unchanged, changed, other_root = _folder("same"), _folder("new"), _folder("elsewhere")
    publisher.submit("root-1", {"same": unchanged, "new": changed}, False, frozenset(changed))
    publisher.submit("root-2", {"elsewhere": other_root}, True, frozenset(list(other_root)[:1]))
    publisher.close()

    assert sorted(recorder.calls) == [
        ("root-1", sorted(changed)),
        ("root-2", sorted(other_root)),  # a changed file publishes its whole album folder
    ]


def test_cancel_drops_queued_folders_and_a_failed_batch_does_not_stop_the_scan():
    cancelled = Recorder()
    publisher = ProgressiveScanPublisher(cancelled, max_albums=100, max_seconds=3600).start()
    entries = _folder("queued")
    publisher.submit("root-1", {"queued": entries}, False, frozenset(entries))
    publisher.close(cancel=True)
    assert cancelled.calls == []

    failing = Recorder(fail_on={1})
    publisher = ProgressiveScanPublisher(failing, max_albums=1, max_seconds=3600).start()
    for name in ("first", "second"):
        entries = _folder(name)
        publisher.submit("root-1", {name: entries}, False, frozenset(entries))
    publisher.close()
    assert len(failing.calls) == 2
    assert publisher.failed_batches == 1
    assert publisher.revisions == [11]


@pytest.mark.parametrize(("start", "revisions", "expected"), [
    (5, [], (5, False)),
    (5, [6, 7, 8], (8, False)),
    (5, [6, 8, 9], (6, True)),  # another writer committed revision 7 between batches
    (None, [6], (None, True)),
])
def test_contiguous_revision_stops_where_another_writer_interleaved(start, revisions, expected):
    assert contiguous_revision(start, revisions) == expected
