"""Exercise real Config and ASGI runtime config loader, without creating the app."""
import json
import os
from pathlib import Path
import subprocess
import sys
import pytest

@pytest.mark.parametrize('value,expected', [(None,False), ('',False), ('false',False), ('1',False), ('yes',False), ('TRUE',True), (' true ',True)])
def test_temporary_source_flag_reaches_real_runtime_configuration(value, expected, tmp_path):
    environment=dict(os.environ)
    environment['MUSIC_DATA_DIR']=str(tmp_path)
    key='ALBUM_HAVEN_FOOBAR_TEMPORARY_SOURCE_ENABLED'
    if value is None:
        environment.pop(key,None)
    else:
        environment[key]=value
    result=subprocess.run([sys.executable,'-c',
        'import json; from config import Config; from music_app import _build_runtime_config; '
        'print(json.dumps([Config.ALBUM_HAVEN_FOOBAR_TEMPORARY_SOURCE_ENABLED, '
        '_build_runtime_config()["ALBUM_HAVEN_FOOBAR_TEMPORARY_SOURCE_ENABLED"]]))'],
        cwd=Path(__file__).resolve().parents[2],env=environment,capture_output=True,text=True,timeout=20,check=False)
    assert result.returncode==0,result.stderr
    assert json.loads(result.stdout)==[expected,expected]
