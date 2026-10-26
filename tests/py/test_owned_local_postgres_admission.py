"""Pure ownership/admission negative guards, not PostgreSQL acceptance evidence."""
import hashlib,json,os
from pathlib import Path
from types import SimpleNamespace
import pytest
from tests.py import owned_local_postgres_admission as guard
from tests.py.album_favorites_postgres_support import lane_context,assert_lane_connection

@pytest.fixture
def owned(tmp_path,monkeypatch):
    if os.name != 'posix':
        pytest.skip('POSIX-owned disposable PostgreSQL admission is unsupported on '+os.name)
    token='1'*32;root=tmp_path/('albumhaven-pg17-'+token);root.mkdir(mode=0o700)
    data=root/'data';data.mkdir(mode=0o700)
    (data/'PG_VERSION').write_text('17\n')
    (data/'postmaster.pid').write_text(f'12345\n{data}\n1234567890\n45432\n\n127.0.0.1\n0 0\nready\n')
    pgpass=root/'synthetic.pgpass';pgpass.touch(mode=0o600)
    binaries={}
    for name in ['postgres','pg_controldata']:
        p=root/name;p.write_bytes(('unit-only-'+name).encode());binaries[name]=p
    monkeypatch.setattr(guard,'APPROVED_BINARY_HASHES',{k:hashlib.sha256(v.read_bytes()).hexdigest() for k,v in binaries.items()})
    monkeypatch.setattr(guard,'OWNED_TEMP_PARENT',tmp_path)
    monkeypatch.setattr(guard.os,'kill',lambda *_:None)
    monkeypatch.setattr(guard.subprocess,'run',lambda *a,**kw:SimpleNamespace(stdout='Database system identifier: 1234567\n'))
    suffix='local_'+token
    m=dict(schema_version=1,token=token,creator_uid=os.getuid(),host='127.0.0.1',port=45432,database='album_haven_ci_'+suffix,
      setup_role='album_haven_migrator_'+suffix,app_role='album_haven_app_'+suffix,readonly_role='album_haven_readonly_'+suffix,
      data_directory=str(data),pgpass=str(pgpass),system_identifier='1234567',postmaster_pid=12345,server_start_epoch=1234567890,
      **{k:str(v) for k,v in binaries.items()},**{k+'_sha256':hashlib.sha256(v.read_bytes()).hexdigest() for k,v in binaries.items()})
    path=root/'ownership.json';path.touch(mode=0o600)
    def save():path.write_text(json.dumps(m))
    save()
    env=dict(ALBUM_HAVEN_FAVORITES_TEST_MODE='favorites_owned_local17',ALBUM_HAVEN_OWNED_POSTGRES_MANIFEST=str(path),PGPASSFILE=str(pgpass),
      DATABASE_MIGRATOR_URL=f"postgresql://{m['setup_role']}@127.0.0.1:45432/{m['database']}",
      DATABASE_APP_URL=f"postgresql://{m['app_role']}@127.0.0.1:45432/{m['database']}",
      ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL=f"postgresql://{m['app_role']}@127.0.0.1:45432/{m['database']}")
    return SimpleNamespace(root=root,data=data,path=path,pgpass=pgpass,manifest=m,env=env,save=save)

def test_explicit_owned_mode_is_not_default_or_hosted(owned):
    c=lane_context(owned.env);assert c['major']==17 and c['mode']=='favorites_owned_local17'
    assert lane_context({})==dict(mode='persistent14',major=14)
    with pytest.raises(AssertionError):assert_lane_connection(lane_context({}),{},170011,'app')
    for mode in ['unknown','favorites_linux17','favorites_windows17']:
        with pytest.raises(AssertionError):lane_context(dict(owned.env,ALBUM_HAVEN_FAVORITES_TEST_MODE=mode))

@pytest.mark.parametrize('key,value',[
 ('PGHOSTADDR','203.0.113.1'),('PGOPTIONS','-c session_replication_role=replica'),('GITHUB_ACTIONS','true'),('GITHUB_RUN_ID','123'),('PGPASSWORD','not-a-real-password'),('PGSERVICE','other'),('PGSERVICEFILE','/tmp/other'),
 ('PGPASSFILE','/tmp/unowned'),('ALBUM_HAVEN_OWNED_POSTGRES_MANIFEST','relative.json'),
 ('DATABASE_APP_URL','postgresql://app@remote.invalid/prod'),('DATABASE_MIGRATOR_URL','postgresql://owner@127.0.0.1/album_haven_core'),
 ('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL','postgresql://app@127.0.0.1:45432/other'),
])
def test_environment_overrides_rejected(owned,key,value):
    owned.env[key]=value
    with pytest.raises((AssertionError,OSError)):lane_context(owned.env)

@pytest.mark.parametrize('key,value',[
 ('schema_version',True),('token','bad'),('creator_uid',-1),('host','localhost'),('port',True),('port',543),('port',65536),
 ('database','album_haven_core'),('setup_role','postgres'),('app_role','postgres'),('readonly_role','postgres'),
 ('data_directory','/tmp/other'),('pgpass','/tmp/other'),('system_identifier','different'),('postmaster_pid',42),
 ('server_start_epoch',1234567891),('postgres_sha256','0'*64),('pg_controldata_sha256','0'*64),
])
def test_manifest_identity_tampering_rejected(owned,key,value):
    owned.manifest[key]=value;owned.save()
    with pytest.raises((AssertionError,OSError)):lane_context(owned.env)

@pytest.mark.parametrize('target',['root','data','path','pgpass'])
def test_unsafe_modes_rejected(owned,target):
    getattr(owned,target).chmod(0o777)
    with pytest.raises(AssertionError):lane_context(owned.env)

@pytest.mark.parametrize('target',['path','pgpass'])
def test_symlinks_and_hardlinks_rejected(owned,target):
    p=getattr(owned,target);other=p.with_suffix('.saved');p.rename(other);p.symlink_to(other)
    with pytest.raises(AssertionError):lane_context(owned.env)
    p.unlink();os.link(other,p)
    with pytest.raises(AssertionError):lane_context(owned.env)

@pytest.mark.parametrize('change',['missing_manifest','missing_pid','wrong_major','extra_key','missing_key','pid_port','pid_start','pid_data','pid_unready','pid_unix_socket'])
def test_missing_stale_and_extra_state_rejected(owned,change):
    if change=='missing_manifest':owned.path.unlink()
    elif change=='missing_pid':(owned.data/'postmaster.pid').unlink()
    elif change=='wrong_major':(owned.data/'PG_VERSION').write_text('14')
    elif change=='extra_key':owned.manifest['extra']='x';owned.save()
    elif change=='missing_key':del owned.manifest['port'];owned.save()
    else:
        p=owned.data/'postmaster.pid';rows=p.read_text().splitlines();idx,val={'pid_port':(3,'45433'),'pid_start':(2,'1234567891'),'pid_data':(1,'/tmp/other'),'pid_unready':(7,'starting'),'pid_unix_socket':(4,'/tmp')}[change];rows[idx]=val;p.write_text('\n'.join(rows)+'\n')
    with pytest.raises((AssertionError,OSError)):lane_context(owned.env)

@pytest.mark.parametrize('row',[
 {'host':'127.0.0.2','port':45432,'started':1234567890},
 {'host':'127.0.0.1','port':45433,'started':1234567890},
 {'host':'127.0.0.1','port':45432,'started':1234567891},
])
def test_connected_server_identity_mismatch_rejected(owned,row):
    c=lane_context(owned.env)
    connection=SimpleNamespace(execute=lambda *_:SimpleNamespace(fetchone=lambda:row))
    with pytest.raises(AssertionError):guard.assert_owned_local_server(connection,c)


def test_foreign_private_manifest_is_rejected_before_read(owned,tmp_path,monkeypatch):
    foreign=tmp_path/'private.json';foreign.touch(mode=0o600)
    owned.env['ALBUM_HAVEN_OWNED_POSTGRES_MANIFEST']=str(foreign)
    original=Path.read_text
    def no_foreign_read(path,*args,**kwargs):
        assert path!=foreign,'Foreign file content must never be read'
        return original(path,*args,**kwargs)
    monkeypatch.setattr(Path,'read_text',no_foreign_read)
    with pytest.raises(AssertionError,match='^$'):
        lane_context(owned.env)


def test_non_posix_owned_mode_rejects_before_filesystem_access(monkeypatch):
    def forbidden_path(*args, **kwargs):
        raise AssertionError('Unsupported mode must not inspect filesystem paths')
    monkeypatch.setattr(guard, 'os', SimpleNamespace(name='nt'))
    monkeypatch.setattr(guard, 'Path', forbidden_path)
    with pytest.raises(AssertionError, match='^Owned local PostgreSQL admission requires POSIX ownership semantics$'):
        lane_context({'ALBUM_HAVEN_FAVORITES_TEST_MODE': 'favorites_owned_local17'})
