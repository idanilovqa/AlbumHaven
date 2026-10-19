"""Real supervisor decisions with owned deterministic process/pipe boundaries."""
import base64
import io
import json
import os
import subprocess
import sys
import threading
import time
import pytest

from music_app.services import public_document_acquisition as acquisition
from music_app.services.public_document_worker import DocumentError, OUTPUT_LIMIT


def result(content=b'1. Album'):
    return {'final_url': 'http://example.org/', 'redirect_chain': ['http://example.org/#section'],
            'mime': 'text/plain', 'charset': 'utf-8', 'body': base64.b64encode(content).decode()}


class Process:
    def __init__(self, output=None, *, status=0, stderr=b''):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(json.dumps(result() if output is None else output).encode())
        self.stderr = io.BytesIO(stderr)
        self.returncode = status
        self.actions = []
    def poll(self):
        return self.returncode
    def wait(self, timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired('owned worker', timeout)
        return self.returncode
    def terminate(self):
        self.actions.append('terminate')
    def kill(self):
        self.actions.append('kill'); self.returncode = -9


def test_actual_supervisor_passes_only_fixed_command_and_minimal_environment(monkeypatch):
    monkeypatch.setenv('HTTP_PROXY', 'http://secret:password@private')
    monkeypatch.setenv('SSL_CERT_FILE', '/private/ca')
    calls = []
    process = Process()
    def launch(arguments, **kwargs):
        calls.append((arguments, kwargs)); return process
    value = acquisition.fetch_document('http://example.org/#section', excluded_hosts=('app.example.org',),
                                       observe=lambda: True, popen=launch)
    argv, options = calls[0]
    assert argv == [sys.executable, '-I', '-S', '-B', acquisition._WORKER]
    assert all('example.org' not in argument for argument in argv)
    assert options['shell'] is False and options['close_fds'] is True and options['bufsize'] == 0
    assert set(options['env']) <= {'SystemRoot'}
    assert value['content'] == '1. Album' and not acquisition._OWNERS


@pytest.mark.parametrize('output', [[], {'body': 'bad'}, {**result(), 'body': '!!'},
    {**result(), 'final_url': 'http://127.0.0.1'}, {**result(), 'charset': 'utf-7'}])
def test_malformed_worker_results_never_publish(output):
    with pytest.raises(DocumentError):
        acquisition.fetch_document('http://example.org', excluded_hosts=(), observe=lambda: True,
                                   popen=lambda *a, **k: Process(output))
    assert not acquisition._OWNERS


def test_output_and_stderr_limits_kill_and_reap_without_decoding():
    for stream in ('stdout', 'stderr'):
        process = Process()
        setattr(process, stream, io.BytesIO(b'x' * (OUTPUT_LIMIT + 1 if stream == 'stdout' else 16385)))
        with pytest.raises(DocumentError):
            acquisition.fetch_document('http://example.org', excluded_hosts=(), observe=lambda: True,
                                       popen=lambda *a, **k: process)
    assert not acquisition._OWNERS


def test_denied_observation_prevents_spawn():
    def forbidden(*args, **kwargs):
        pytest.fail('worker must not spawn')
    with pytest.raises(DocumentError, match='source_changed'):
        acquisition.fetch_document('http://example.org', excluded_hosts=(), observe=lambda: False, popen=forbidden)
    assert not acquisition._OWNERS


def test_observer_blockage_cannot_block_supervisor_deadline():
    entered, release = threading.Event(), threading.Event()
    def observe():
        entered.set(); release.wait(); return True
    now = [0]
    owner = acquisition._Owner(observe, lambda: now[0], None)
    try:
        owner.check()
        assert entered.wait(1)
        now[0] = .751
        with pytest.raises(DocumentError, match='source_observation_timeout'):
            owner.check()
        assert len(owner.threads) == 1 and owner.threads[0].is_alive()
    finally:
        release.set()
        owner.threads[0].join(1)


def test_stop_escalates_ignored_graceful_termination_then_reaps():
    owner = acquisition._Owner(lambda: True, time.monotonic, None)
    owner.proc = Process(status=None)
    owner.stop()
    assert owner.proc.actions == ['terminate', 'kill'] and owner.closed()


def test_failed_spawn_releases_slot_and_never_exposes_exception_details():
    def failure(*args, **kwargs):
        raise OSError('private URL secret')
    with pytest.raises(DocumentError) as error:
        acquisition.fetch_document('http://example.org', excluded_hosts=(), observe=lambda: True, popen=failure)
    assert 'secret' not in str(error.value) and not acquisition._OWNERS


def test_existing_auth_policy_is_only_self_origin_input():
    settings = {'public_base_url': 'https://app.example.org/base',
                'trusted_origins': ('https://other.example.org', 'https://app.example.org')}
    assert acquisition.trusted_hosts(settings) == ('app.example.org', 'other.example.org')
    with pytest.raises(DocumentError):
        acquisition.trusted_hosts(None)


def test_actual_standalone_worker_exits_on_parent_input_close_without_network():
    # Future runtime test: actual fixed worker process, no URL ever supplied.
    process = subprocess.Popen([sys.executable, '-I', '-S', '-B', acquisition._WORKER],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        close_fds=True, env={'SystemRoot': os.environ['SystemRoot']} if os.name == 'nt' else {}, bufsize=0)
    try:
        process.stdin.close()
        assert process.wait(timeout=5) == 2
        assert process.stdout.read(1) == b'' and process.stderr.read(1) == b''
    finally:
        if process.poll() is None:
            process.kill(); process.wait(timeout=5)
        process.stdout.close(); process.stderr.close()


def test_actual_worker_success_exits_with_open_liveness_pipe_and_no_shutdown_error():
    # The complete actual main/stdio/watchdog owner executes in a real process.
    # Only acquisition is supplied by this test-only harness, so no DNS/HTTP runs.
    harness = ("import runpy,sys\n"
        "def trace(frame,event,arg):\n"
        " if event=='call' and frame.f_code.co_name=='main' and frame.f_code.co_filename==" + repr(acquisition._WORKER) + ":\n"
        "  frame.f_globals['acquire']=lambda *a,**k:" + repr(result()) + "\n"
        "  sys.settrace(None)\n"
        "  return None\n"
        " return trace\n"
        "sys.settrace(trace)\nrunpy.run_path(" + repr(acquisition._WORKER) + ",run_name='__main__')\n")
    process = subprocess.Popen([sys.executable, '-I', '-S', '-B', '-c', harness],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        close_fds=True, env={'SystemRoot': os.environ['SystemRoot']} if os.name == 'nt' else {}, bufsize=0)
    try:
        process.stdin.write(json.dumps({'url': 'http://example.org', 'excluded_hosts': [], 'seconds': 5}).encode() + b'\n')
        # Keep stdin open: successful exit must not depend on parent EOF.
        assert process.wait(timeout=5) == 0
        output = process.stdout.read(OUTPUT_LIMIT + 1)
        assert len(output) <= OUTPUT_LIMIT and json.loads(output) == result()
        assert process.stderr.read(16385) == b''
    finally:
        if process.poll() is None:
            process.kill(); process.wait(timeout=5)
        process.stdin.close(); process.stdout.close(); process.stderr.close()


@pytest.mark.parametrize('mode', ['deadline', 'cancel'])
def test_full_fetch_stops_an_active_child_and_releases_only_after_reap(mode):
    now, allowed = [0.0], [True]
    process = Process(status=None)
    original_poll = process.poll
    polls = [0]
    def poll():
        polls[0] += 1
        if polls[0] >= 3 and process.returncode is None:
            now[0] = 31.0 if mode == 'deadline' else 1.1
            if mode == 'cancel':
                allowed[0] = False
        return original_poll()
    process.poll = poll
    with pytest.raises(DocumentError):
        acquisition.fetch_document('http://example.org', excluded_hosts=(), observe=lambda: allowed[0],
            clock=lambda: now[0], popen=lambda *a, **k: process)
    assert process.returncode == -9 and process.actions == ['terminate', 'kill']
    assert not acquisition._OWNERS


def test_full_fetch_retains_slot_until_a_stuck_observer_actually_closes():
    entered, release = threading.Event(), threading.Event()
    def blocked():
        entered.set(); release.wait(); return True
    def no_spawn(*args, **kwargs):
        pytest.fail('unconfirmed authority must not spawn')
    held = []
    try:
        with pytest.raises(DocumentError, match='cleanup_failed'):
            acquisition.fetch_document('http://example.org', excluded_hosts=(), observe=blocked, popen=no_spawn)
        assert entered.is_set() and len(acquisition._OWNERS) == 1
        while acquisition._SLOTS.acquire(blocking=False):
            held.append(True)
        assert len(held) == 3, 'blocked observer still owns the fourth slot'
    finally:
        for _ in held:
            acquisition._SLOTS.release()
        release.set()
        end = time.monotonic() + 3
        while acquisition._OWNERS and time.monotonic() < end:
            time.sleep(.01)
    assert not acquisition._OWNERS


def test_actual_worker_maximum_unicode_quote_witnesses_and_full_body_fit_output():
    # Generate the large value inside the child, avoiding command-line limits.
    # Six exact 4096-byte private witnesses contain non-ASCII and JSON quotes;
    # fragments are inert transport-wise. Exercise the real main serializer.
    harness = ("import base64,runpy,sys\n"
        "chain=[]\n"
        "for i in range(6):\n"
        " prefix='https://example.org/'+str(i)+'#'\n"
        " part='é'*((4096-len(prefix.encode())-1)//2)+'\\\"'\n"
        " url=prefix+part\n"
        " url+='a'*(4096-len(url.encode()))\n"
        " chain.append(url)\n"
        "value={'final_url':'https://example.org/5','redirect_chain':chain,"
        "'mime':'text/plain','charset':'utf-8','body':base64.b64encode(b'a'*(512*1024)).decode()}\n"
        "def trace(frame,event,arg):\n"
        " if event=='call' and frame.f_code.co_name=='main' and frame.f_code.co_filename==" + repr(acquisition._WORKER) + ":\n"
        "  frame.f_globals['acquire']=lambda *a,**k:value\n"
        "  sys.settrace(None)\n"
        "  return None\n"
        " return trace\n"
        "sys.settrace(trace)\nrunpy.run_path(" + repr(acquisition._WORKER) + ",run_name='__main__')\n")
    process = subprocess.Popen([sys.executable, '-I', '-S', '-B', '-c', harness],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        close_fds=True, env={'SystemRoot': os.environ['SystemRoot']} if os.name == 'nt' else {}, bufsize=0)
    output = bytearray()
    try:
        process.stdin.write(json.dumps({'url': 'https://example.org', 'excluded_hosts': [], 'seconds': 5}).encode() + b'\n')
        # Drain before wait: the full body exceeds pipe capacity. The actual
        # worker watchdog bounds stalled output; never read beyond one sentinel.
        while len(output) <= OUTPUT_LIMIT:
            chunk = process.stdout.read(min(8192, OUTPUT_LIMIT + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
        assert len(output) <= OUTPUT_LIMIT
        assert process.wait(timeout=5) == 0
        assert process.stderr.read(16385) == b''
        value = json.loads(output)
        assert len(value['redirect_chain']) == 6
        assert all(len(url.encode('utf-8')) == 4096 and 'é' in url and '"' in url
                   for url in value['redirect_chain'])
        assert base64.b64decode(value['body'], validate=True) == b'a' * (512 * 1024)
        assert value['final_url'] == 'https://example.org/5'
        assert value['mime'] == 'text/plain' and value['charset'] == 'utf-8'
        # This specifically distinguishes UTF-8 from default ASCII escaping:
        # the latter expands the same evidence and must not replace fixed UTF-8.
        assert len(json.dumps(value).encode('utf-8')) > len(output) + 40000
        assert bytes(output) == json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    finally:
        if process.poll() is None:
            process.kill(); process.wait(timeout=5)
        process.stdin.close(); process.stdout.close(); process.stderr.close()
