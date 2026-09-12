import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

export async function createGalleryRegressionFixture(username) {
  const connection = resolveIsolatedE2ESetupConnection(process.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL);
  const env = {...process.env, PGCLIENTENCODING:'UTF8'};
  delete env.PGDATABASE;
  if (connection.password) env.PGPASSWORD=connection.password;
  const exec = promisify(execFile);
  const sql = async statement => {
    const commands=resolvePsqlCommands(env,process.platform);
    for(let i=0;i<commands.length;i++) {
      try { return (await exec(commands[i],['--no-psqlrc','--quiet','--tuples-only','--no-align',`--dbname=${connection.databaseTarget}`,'--set=ON_ERROR_STOP=1','--command',statement],{env,windowsHide:true,encoding:'utf8'})).stdout.trim(); }
      catch(error) { if(error.code!=='ENOENT'||i===commands.length-1)throw error; }
    }
  };
  const name=Buffer.from(username.toLowerCase()).toString('base64');
  const identity=JSON.parse(await sql(`select jsonb_build_object('account',a.id,'library',l.id,'dismissal',l.metadata #> array['watcher_warning_dismissals',a.id::text]) from app.accounts a join app.bootstrap_owners o on o.owner_key='local-bootstrap-owner' join library.libraries l on l.owner_account_id=o.account_id and l.name='Local Library' where a.username_normalized=convert_from(decode('${name}','base64'),'UTF8')`));
  if(!Number.isSafeInteger(identity.account)||!Number.isSafeInteger(identity.library))throw new Error('Invalid isolated warning fixture identity');
  const root=`e2e-warning-${randomUUID()}`;
  const owner=`e2e-gallery-${randomUUID()}`;
  return {
    async warn(at) {
      const payload=Buffer.from(JSON.stringify({[root]:{state:'overflow',detected_at:at}})).toString('base64');
      await sql(`update library.libraries set metadata=jsonb_set(coalesce(metadata,'{}'),'{library_watch_health}',coalesce(metadata->'library_watch_health','{}') || convert_from(decode('${payload}','base64'),'UTF8')::jsonb) where id=${identity.library}`);
    },
    async linkVersions() {
      const count=await sql(`with inserted as (insert into library.manual_versions(library_id,child_key,parent_key,metadata) select c.library_id,c.album_key,p.album_key,jsonb_build_object('e2e_owner','${owner}') from library.local_albums c join library.local_albums p on p.library_id=c.library_id where c.library_id=${identity.library} and c.title='Ordinary Numeric Disc Control' and p.title='Featured Signal Collection' returning 1) select count(*) from inserted`);
      if(count!=='1')throw new Error('Expected exactly one owned fixture version link');
    },
    async clear() {
      await sql(`update library.libraries set metadata=jsonb_set(metadata,'{library_watch_health}',coalesce(metadata->'library_watch_health','{}')-'${root}') where id=${identity.library}`);
    },
    async restore() {
      const saved=Buffer.from(JSON.stringify(identity.dismissal===null?{}:{[identity.account]:identity.dismissal})).toString('base64');
      await sql(`begin; update library.libraries set metadata=jsonb_set(jsonb_set(metadata,'{library_watch_health}',coalesce(metadata->'library_watch_health','{}')-'${root}'),'{watcher_warning_dismissals}',(coalesce(metadata->'watcher_warning_dismissals','{}')-'${identity.account}') || convert_from(decode('${saved}','base64'),'UTF8')::jsonb) where id=${identity.library}; delete from library.manual_versions where metadata->>'e2e_owner'='${owner}'; commit;`);
    },
  };
}
