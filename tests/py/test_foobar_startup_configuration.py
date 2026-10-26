"""Real deployment loader checks; never create the app, worker, or database."""
import json
import os
from pathlib import Path
import subprocess
import sys
import pytest

ENABLE = 'ALBUM_HAVEN_FOOBAR_ACCOUNT_IMPORT_ENABLED'
INTAKE = 'ALBUM_HAVEN_FOOBAR_IMPORT_INTAKE_BYTES'
TOTAL = 'ALBUM_HAVEN_FOOBAR_IMPORT_TOTAL_LOGICAL_BYTES'

def loaded(tmp_path, values):
    env = dict(os.environ)
    env['MUSIC_DATA_DIR'] = str(tmp_path)
    env['ALBUM_HAVEN_APP_DATABASE_URL'] = ''
    for key in (ENABLE, INTAKE, TOTAL):
        env.pop(key, None)
    env.update({key: value for key, value in values.items() if value is not None})
    script = """
import json
from config import Config
from music_app import _build_runtime_config
from music_app.services.foobar_account_import_service import parse_foobar_import_limits
from music_app.services.foobar_source_postgres import SourceUnavailable
keys = ['ALBUM_HAVEN_FOOBAR_ACCOUNT_IMPORT_ENABLED', 'ALBUM_HAVEN_FOOBAR_IMPORT_INTAKE_BYTES', 'ALBUM_HAVEN_FOOBAR_IMPORT_TOTAL_LOGICAL_BYTES']
runtime = _build_runtime_config()
assert all(getattr(Config, key) == runtime[key] for key in keys)
try:
    limits = parse_foobar_import_limits(runtime)
    capacity = [limits.intake_bytes, limits.total_logical_bytes]
except SourceUnavailable:
    capacity = None
print(json.dumps([[runtime[key] for key in keys], capacity]))
"""
    result = subprocess.run([sys.executable, '-c', script], cwd=Path(__file__).resolve().parents[2],
        env=env, capture_output=True, text=True, timeout=20, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)

@pytest.mark.parametrize('value,expected', [(None,False), ('',False), ('false',False), ('1',False), ('yes',False), ('TRUE',True), (' true ',True)])
def test_account_import_opt_in_uses_real_runtime_loader(value, expected, tmp_path):
    assert loaded(tmp_path, {ENABLE:value}) == [[expected,None,None],None]

@pytest.mark.parametrize('value,accepted', [(None,False), ('',False), ('0',False), ('-1',False), ('01',False), (' 12 ',False), ('1.0',False), ('true',False), ('9223372036854775808',False), ('1',True), ('9223372036854775807',True)])
@pytest.mark.parametrize('key', [INTAKE,TOTAL])
def test_mandatory_capacity_remains_strict_after_real_runtime_loading(key, value, accepted, tmp_path):
    values = {ENABLE:'true', INTAKE:'12', TOTAL:'34', key:value}
    result = loaded(tmp_path, values)
    assert result[0] == [True,values[INTAKE],values[TOTAL]]
    assert result[1] == ([int(values[INTAKE]),int(values[TOTAL])] if accepted else None)
