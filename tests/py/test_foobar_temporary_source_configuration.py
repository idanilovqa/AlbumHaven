"""Exercise real Config and ASGI runtime config loader, without creating the app."""
import json
import os
from pathlib import Path
import subprocess
import sys
import pytest

@pytest.mark.parametrize('value', [None, '', 'false', '1', 'yes', 'TRUE', ' true '])
def test_obsolete_flag_cannot_enable_raw_retention_in_real_configuration(value, tmp_path):
    environment=dict(os.environ)
    environment['MUSIC_DATA_DIR']=str(tmp_path)
    key='ALBUM_HAVEN_FOOBAR_TEMPORARY_SOURCE_ENABLED'
    if value is None:
        environment.pop(key,None)
    else:
        environment[key]=value
    result=subprocess.run([sys.executable,'-c',
        'import json; from config import Config; from music_app import _build_runtime_config; '
        'print(json.dumps([getattr(Config,"ALBUM_HAVEN_FOOBAR_TEMPORARY_SOURCE_ENABLED",False), '
        '_build_runtime_config().get("ALBUM_HAVEN_FOOBAR_TEMPORARY_SOURCE_ENABLED",False)]))'],
        cwd=Path(__file__).resolve().parents[2],env=environment,capture_output=True,text=True,timeout=20,check=False)
    assert result.returncode==0,result.stderr
    assert json.loads(result.stdout)==[False,False]
