"""Genuine upload owner with controlled filesystem boundaries; unexecuted."""
from hashlib import sha256
import threading

import pytest

from music_app.services import foobar_enhanced_upload as upload


def channel(length=100):
    return upload.EnhancedUploadChannel(length, threading.Event())


def ready(payload=b'x'*100):
    result = channel(len(payload))
    assert result.offer(payload) is True
    result.finish()
    return result


@pytest.mark.parametrize('length', [True, 99, 536_870_913, '100', None])
def test_declared_length_requires_exact_bounded_integer(length):
    with pytest.raises(upload.EnhancedUploadRejected):
        channel(length)


def test_one_slot_backpressure_does_not_accept_or_count_second_chunk():
    item = channel(200)
    first, second = b'a'*100, b'b'*100
    assert item.offer(first) is True
    assert item.offer(second) is False
    assert item.receive() is first
    assert item.offer(second) is True
    item.finish()
    assert item.receive() is second
    assert item.receive() is None
    item.close()


@pytest.mark.parametrize('payload', [b'', bytearray(b'x'*100), b'x'*(1_048_576+1)])
def test_invalid_chunk_is_not_accepted(payload):
    item = channel()
    try:
        with pytest.raises(upload.EnhancedUploadRejected):
            item.offer(payload)
    finally:
        item.close()


def test_overflow_and_truncation_fail_without_successful_end():
    item = channel()
    with pytest.raises(upload.EnhancedUploadRejected):
        item.offer(b'x'*101)
    item.close()
    item = channel()
    assert item.offer(b'x'*99)
    with pytest.raises(upload.EnhancedUploadRejected):
        item.finish()
    item.close()
    with pytest.raises(upload.EnhancedUploadRejected):
        item.receive()


def test_cancel_and_close_reject_further_producer_and_consumer_activity():
    for action in ('cancel', 'close'):
        item = ready()
        if action == 'cancel':
            item.cancelled.set()
        else:
            item.close()
        for operation in (item.receive, item.finish, lambda: item.offer(b'x')):
            with pytest.raises(upload.EnhancedUploadRejected):
                operation()
        item.close()


def test_deadline_rejects_before_file_or_wait(monkeypatch):
    clock = [10.0]
    monkeypatch.setattr(upload.time, 'monotonic', lambda: clock[0])
    item = channel()
    clock[0] = 610.0
    with pytest.raises(upload.EnhancedUploadRejected):
        item.receive()
    item.close()


class FileBoundary:
    def __init__(self, *, short=False, cleanup_error=False, flush_error=False):
        self.events = []
        self.bytes = bytearray()
        self.closed = False
        self.short = short
        self.cleanup_error = cleanup_error
        self.flush_error = flush_error

    def install(self, monkeypatch):
        boundary = self
        class Directory:
            def __enter__(self):
                boundary.events.append('directory_open')
                return 'owned-private-directory'
            def __exit__(self, *args):
                boundary.events.append('cleanup')
                assert boundary.closed
                if boundary.cleanup_error:
                    raise OSError('synthetic cleanup error')
        class Destination:
            def __enter__(self):
                boundary.events.append('file_open')
                return self
            def write(self, data):
                boundary.bytes.extend(data)
                return len(data)-1 if boundary.short else len(data)
            def flush(self):
                boundary.events.append('flush')
                if boundary.flush_error:
                    raise OSError('synthetic flush error')
            def __exit__(self, *args):
                boundary.closed = True
                boundary.events.append('file_closed')
        class Path:
            def __init__(self, directory):
                assert directory == 'owned-private-directory'
            def __truediv__(self, name):
                assert name == 'artifact.sqlite'
                return self
            def open(self, mode):
                assert mode == 'xb'
                return Destination()
        def directory(*, prefix):
            assert prefix == 'albumhaven-foobar-upload-'
            return Directory()
        monkeypatch.setattr(upload.tempfile, 'TemporaryDirectory', directory)
        monkeypatch.setattr(upload, 'Path', Path)


def test_worker_file_closed_before_reader_and_removed_after_reader(monkeypatch):
    boundary = FileBoundary()
    boundary.install(monkeypatch)
    item = ready()
    with upload.staged_enhanced_upload(item) as artifact:
        assert boundary.closed
        boundary.events.append('reader_open')
        assert artifact.sha256 == sha256(b'x'*100).hexdigest()
        assert artifact.byte_length == 100
        assert bytes(boundary.bytes) == b'x'*100
        boundary.events.append('reader_closed')
    assert boundary.events == ['directory_open', 'file_open', 'flush', 'file_closed', 'reader_open', 'reader_closed', 'cleanup']
    with pytest.raises(upload.EnhancedUploadRejected):
        item.receive()


def test_reader_failure_still_cleans_artifact_and_closes_channel(monkeypatch):
    boundary = FileBoundary()
    boundary.install(monkeypatch)
    item = ready()
    with pytest.raises(ValueError, match='synthetic reader'):
        with upload.staged_enhanced_upload(item):
            raise ValueError('synthetic reader')
    assert boundary.events[-1] == 'cleanup'
    with pytest.raises(upload.EnhancedUploadRejected):
        item.receive()


@pytest.mark.parametrize('kind', ['short', 'flush_error'])
def test_write_failure_never_publishes_artifact_and_still_cleans(monkeypatch, kind):
    boundary = FileBoundary(**{kind: True})
    boundary.install(monkeypatch)
    item = ready()
    expected = upload.EnhancedUploadRejected if kind == 'short' else upload.EnhancedUploadStorageFailed
    with pytest.raises(expected):
        with upload.staged_enhanced_upload(item):
            pytest.fail('failed write published artifact')
    assert boundary.events[-1] == 'cleanup'
    with pytest.raises(upload.EnhancedUploadRejected):
        item.receive()


def test_cleanup_failure_cannot_publish_settled_success(monkeypatch):
    boundary = FileBoundary(cleanup_error=True)
    boundary.install(monkeypatch)
    item = ready()
    settled = False
    with pytest.raises(upload.EnhancedUploadStorageFailed) as caught:
        with upload.staged_enhanced_upload(item):
            pass
        settled = True
    assert type(caught.value) is upload.EnhancedUploadStorageFailed
    assert str(caught.value) == ''
    assert not settled
    with pytest.raises(upload.EnhancedUploadRejected):
        item.receive()


@pytest.mark.parametrize('action', ['offer', 'finish'])
def test_invalid_producer_operation_terminally_releases_pending_slot(action):
    item = channel(200)
    assert item.offer(b'x'*100)
    with pytest.raises(upload.EnhancedUploadRejected):
        if action == 'offer':
            item.offer(b'')
        else:
            item.finish()
    assert item._chunk is None
    with pytest.raises(upload.EnhancedUploadRejected):
        item.receive()
    with pytest.raises(upload.EnhancedUploadRejected):
        item.offer(b'y'*100)


def test_cancelled_before_consumption_still_cleans_owned_empty_file(monkeypatch):
    boundary = FileBoundary()
    boundary.install(monkeypatch)
    item = ready()
    item.cancelled.set()
    with pytest.raises(upload.EnhancedUploadRejected):
        with upload.staged_enhanced_upload(item):
            pytest.fail('cancelled upload published artifact')
    assert boundary.events == ['directory_open', 'file_open', 'file_closed', 'cleanup']


def test_storage_allocation_failure_is_typed_fail_stop_and_closes_channel(monkeypatch):
    def failed_directory(*, prefix):
        raise OSError('sensitive synthetic storage path')
    monkeypatch.setattr(upload.tempfile, 'TemporaryDirectory', failed_directory)
    item = ready()
    with pytest.raises(upload.EnhancedUploadStorageFailed) as caught:
        with upload.staged_enhanced_upload(item):
            pytest.fail('allocation failure published artifact')
    assert type(caught.value) is upload.EnhancedUploadStorageFailed
    assert str(caught.value) == ''
    assert caught.value.__suppress_context__ is True
    with pytest.raises(upload.EnhancedUploadRejected):
        item.receive()


def test_reader_oserror_is_conservatively_typed_storage_failure(monkeypatch):
    boundary = FileBoundary()
    boundary.install(monkeypatch)
    item = ready()
    with pytest.raises(upload.EnhancedUploadStorageFailed) as caught:
        with upload.staged_enhanced_upload(item):
            raise OSError('synthetic reader storage failure')
    assert type(caught.value) is upload.EnhancedUploadStorageFailed
    assert boundary.events[-1] == 'cleanup'
    with pytest.raises(upload.EnhancedUploadRejected):
        item.receive()
