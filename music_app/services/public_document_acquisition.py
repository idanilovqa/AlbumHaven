"""Owned short-lived URL worker supervision; no database or credentials in child."""
import atexit
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

from music_app.services.public_document_worker import (
    BODY_LIMIT, OUTPUT_LIMIT, DocumentError, normalize_url,
)

_SLOTS = threading.BoundedSemaphore(4)
_OWNERS = set()
_LOCK = threading.Lock()
_WORKER = str(Path(__file__).with_name('public_document_worker.py').resolve())


def trusted_hosts(settings):
    """Only the existing validated auth-policy owner, never request Host headers."""
    if not isinstance(settings, dict) or not isinstance(settings.get('public_base_url'), str):
        raise DocumentError('self_origin_unavailable')
    values = (settings['public_base_url'], *settings.get('trusted_origins', ()))
    result = []
    for value in values:
        host = urlsplit(value).hostname
        if not host:
            raise DocumentError('self_origin_unavailable')
        host = host.encode('idna').decode('ascii').lower().removesuffix('.')
        if host not in result:
            result.append(host)
    if len(result) > 16:
        raise DocumentError('self_origin_unavailable')
    return tuple(result)


class _Owner:
    def __init__(self, observe, clock, popen):
        self.observe, self.clock, self.popen = observe, clock, popen
        self.cancel = threading.Event()
        self.proc = None
        self.threads = []
        self.output = bytearray()
        self.failure = threading.Event()
        self.observed = threading.Event()
        self.observation_ok = False
        self.observer_started = None
        self.next_observation = 0

    def observation(self):
        try:
            self.observation_ok = self.observe() is True
        except Exception:
            self.observation_ok = False
        finally:
            self.observed.set()

    def check(self, *, schedule=True):
        now = self.clock()
        if self.cancel.is_set() or self.failure.is_set():
            raise DocumentError('acquisition_canceled')
        if self.observer_started is not None:
            if self.observed.is_set():
                if not self.observation_ok:
                    raise DocumentError('source_changed')
                self.observer_started = None
            elif now - self.observer_started >= .750:
                raise DocumentError('source_observation_timeout')
        if schedule and self.observer_started is None and now >= self.next_observation:
            self.observed.clear()
            self.observer_started = now
            self.next_observation = now + 1
            thread = threading.Thread(target=self.observation, daemon=True)
            self.threads.append(thread)
            thread.start()

    def drain(self, stream, *, stderr=False):
        count = 0
        try:
            while True:
                data = stream.read(8192)
                if not data:
                    return
                count += len(data)
                if count > (16384 if stderr else OUTPUT_LIMIT):
                    self.failure.set()
                    return
                if not stderr:
                    self.output.extend(data)
        except Exception:
            self.failure.set()

    def send(self, data):
        try:
            position = 0
            while position < len(data):
                sent = self.proc.stdin.write(data[position:])
                if not sent:
                    raise OSError('closed')
                position += sent
        except Exception:
            self.failure.set()

    def stop(self):
        proc = self.proc
        if proc is None:
            return
        try:
            proc.stdin.close()
        except Exception:
            pass
        for action, delay in ((None, .250), ('terminate', .750), ('kill', 1.0)):
            if proc.poll() is not None:
                break
            try:
                if action:
                    getattr(proc, action)()
                proc.wait(timeout=delay)
            except (subprocess.TimeoutExpired, OSError):
                pass

    def closed(self):
        return ((self.proc is None or self.proc.poll() is not None)
                and not any(thread.is_alive() for thread in self.threads))

    def release(self):
        if self.proc is not None:
            self.proc.wait()
            for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                try:
                    stream.close()
                except Exception:
                    pass
        with _LOCK:
            _OWNERS.discard(self)
        _SLOTS.release()

    def finish(self):
        self.stop()
        for thread in self.threads:
            thread.join(timeout=.05)
        if self.closed():
            self.release()
            return True
        # Exceptional cleanup remains bounded in admission count, not falsely
        # called successfully reaped. Keep the slot and process handle owned.
        def reap():
            while not self.closed():
                self.stop()
                time.sleep(.1)
            self.release()
        threading.Thread(target=reap, daemon=True).start()
        return False


def _shutdown():
    with _LOCK:
        owners = tuple(_OWNERS)
    for owner in owners:
        owner.cancel.set()
        owner.stop()


atexit.register(_shutdown)


def fetch_document(url, *, excluded_hosts, observe, clock=time.monotonic, popen=subprocess.Popen):
    normalize_url(url)
    if not _SLOTS.acquire(blocking=False):
        raise DocumentError('acquisition_busy')
    owner = _Owner(observe, clock, popen)
    with _LOCK:
        _OWNERS.add(owner)
    started = clock()
    value = None
    try:
        # Initial authority observation finishes before the child gets a URL.
        while not owner.observed.is_set():
            owner.check()
            time.sleep(.01)
        owner.check()
        environment = {}
        if os.name == 'nt':
            root = os.environ.get('SystemRoot')
            if not root or not os.path.isabs(root):
                raise DocumentError('worker_environment')
            environment['SystemRoot'] = root
        owner.proc = popen([sys.executable, '-I', '-S', '-B', _WORKER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            shell=False, close_fds=True, env=environment, bufsize=0)
        owner.check()
        remaining = 30 - (clock() - started)
        if remaining <= 0:
            raise DocumentError('deadline')
        payload = json.dumps({'url': url, 'excluded_hosts': list(excluded_hosts), 'seconds': remaining},
                             ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\n'
        if len(payload) > 32768:
            raise DocumentError('worker_input')
        for target, arguments in ((owner.drain, (owner.proc.stdout,)),
                                  (lambda stream: owner.drain(stream, stderr=True), (owner.proc.stderr,)),
                                  (owner.send, (payload,))):
            thread = threading.Thread(target=target, args=arguments, daemon=True)
            owner.threads.append(thread); thread.start()
        while owner.proc.poll() is None:
            owner.check()
            if clock() - started >= 30:
                raise DocumentError('deadline')
            time.sleep(.01)
        owner.check(schedule=False)
        if owner.proc.returncode != 0 or clock() - started >= 30:
            raise DocumentError('acquisition_failed')
        while owner.observer_started is not None:
            owner.check(schedule=False)
            if clock() - started >= 30:
                raise DocumentError('deadline')
            time.sleep(.01)
        for thread in owner.threads:
            thread.join(timeout=.05)
        if any(thread.is_alive() for thread in owner.threads) or owner.failure.is_set():
            raise DocumentError('cleanup_failed')
        value = json.loads(bytes(owner.output))
        if type(value) is not dict or set(value) != {'final_url', 'redirect_chain', 'mime', 'charset', 'body'}:
            raise DocumentError('worker_output')
        normalize_url(value['final_url'])
        if type(value['redirect_chain']) is not list or not 1 <= len(value['redirect_chain']) <= 6:
            raise DocumentError('worker_output')
        for hop in value['redirect_chain']:
            normalize_url(hop)
        if value['mime'] not in ('text/plain', 'text/html') or value['charset'] not in (
                'utf-8', 'utf8', 'us-ascii', 'ascii', 'iso-8859-1', 'windows-1252'):
            raise DocumentError('worker_output')
        body = base64.b64decode(value['body'], validate=True)
        if len(body) > BODY_LIMIT:
            raise DocumentError('worker_output')
        text = body.decode(value['charset'], errors='strict')
        if '\0' in text:
            raise DocumentError('worker_output')
        value = {**value, 'content': text}
    except DocumentError:
        raise
    except Exception:
        raise DocumentError('acquisition_failed') from None
    finally:
        closed = owner.finish()
        if not closed:
            raise DocumentError('cleanup_failed')
    return value
