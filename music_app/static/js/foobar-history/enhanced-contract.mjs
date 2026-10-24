import {uuid,hex,SCOPE} from './contract.mjs';
export const ENHANCED_PROTOCOL='foobar_account_enhanced_history_v1';
export const ENHANCED_FAMILY='local_entries';
const MIN=-9223372036854775808n,MAX=9223372036854775807n,MAX64=18446744073709551615n;
const EPOCH=116444736000000000n,CALENDAR=2534023007999999999n;
const fail=()=>{throw new Error('Invalid Enhanced history response.');};
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const decimal=(v,min=0n,max=MAX)=>typeof v==='string'&&/^(0|-?[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)>=min&&BigInt(v)<=max;
const viewFor=mode=>mode==='individual'?'entries':mode==='grouped'?'records':fail();
const key=(row)=>[row.entry?.state==='resolved'?BigInt(row.entry.unix_100ns):MIN,row.observation_ref,BigInt(row.entry?.ordinal??-1)];
const compare=(a,b)=>{for(let i=0;i<3;i++){if(a[i]<b[i])return -1;if(a[i]>b[i])return 1;}return 0;};
export function enhancedCursor(v,context,query){
  if(v===null)return null;
  if(!exact(v,['context_ref','source_ref','source_revision','view','sort_key','observation_ref','ordinal','direction'])
    ||v.context_ref!==context||v.source_ref!==query.source_ref||v.view!==viewFor(query.mode)
    ||!decimal(v.source_revision)||!decimal(v.sort_key,MIN,CALENDAR)||!uuid(v.observation_ref)
    ||!decimal(v.ordinal,-1n,32765n)||!['older','newer'].includes(v.direction)
    ||v.view==='records'&&(BigInt(v.sort_key)!==MIN||v.ordinal!=='-1')
    ||v.view==='entries'&&BigInt(v.ordinal)<0n)fail();
  return Object.freeze({...v});
}
function entry(v){
  if(!exact(v,['ordinal','raw_filetime_ticks','unix_100ns','state','code','iso_utc','provenance'])
    ||!Number.isInteger(v.ordinal)||v.ordinal<0||v.ordinal>32765||!decimal(v.raw_filetime_ticks,0n,MAX64)
    ||!decimal(v.unix_100ns,-EPOCH,MAX64-EPOCH)||v.provenance!=='incomplete_possibly_seeded')fail();
  const raw=BigInt(v.raw_filetime_ticks),unix=raw-EPOCH;
  if(BigInt(v.unix_100ns)!==unix)fail();
  const code=raw===0n?'zero_or_unavailable':raw===MAX64?'sentinel_like':unix>CALENDAR?'outside_supported_calendar':null;
  if(v.code!==code||v.state!==(code?'unresolved':'resolved'))fail();
  if(code){if(v.iso_utc!==null)fail();}
  else{
    const fraction=(unix%10000000n+10000000n)%10000000n;
    const seconds=(unix-fraction)/10000000n;
    const iso=new Date(Number(seconds*1000n)).toISOString().replace('.000Z','.'+String(fraction).padStart(7,'0')+'Z');
    if(v.iso_utc!==iso)fail();
  }
  return Object.freeze({...v});
}
export function validateEnhancedHistory(value,context,query,cursor){
  if(!exact(value,['protocol','result','context_ref','context_scope'])||value.protocol!==ENHANCED_PROTOCOL
    ||value.context_ref!==context||value.context_scope!==SCOPE||!hex(context))fail();
  const p=value.result,view=viewFor(query.mode);
  if(!exact(p,['source_ref','source_revision','view','ordering','items','next_cursor','previous_cursor'])
    ||p.source_ref!==query.source_ref||!uuid(p.source_ref)||!decimal(p.source_revision)||p.view!==view
    ||p.ordering!==(view==='entries'?'resolved_time_then_undated':'source_record_identity')
    ||!Array.isArray(p.items)||p.items.length>20||cursor&&cursor.source_revision!==p.source_revision)fail();
  let previous=null;
  const items=p.items.map(v=>{
    if(!exact(v,['observation_ref','observation_revision','effective_sha256','display_sha256','label','label_kind','label_truncated','local_vector_count','count_meaning','local_provenance','entry'])
      ||!uuid(v.observation_ref)||!decimal(v.observation_revision,1n)||BigInt(v.observation_revision)>BigInt(p.source_revision)
      ||!hex(v.effective_sha256)||!hex(v.display_sha256)||typeof v.label!=='string'||!v.label
      ||v.label.length>256||new TextEncoder().encode(v.label).length>256||/[\p{C}\u2028\u2029]/u.test(v.label)
      ||!['source_filename','source_record'].includes(v.label_kind)||typeof v.label_truncated!=='boolean'
      ||v.count_meaning!=='reported_local_vector_entries_not_lifetime_plays'
      ||v.local_vector_count!==null&&!decimal(v.local_vector_count,0n,32766n)
      ||v.local_provenance!==(v.local_vector_count===null?null:'incomplete_possibly_seeded')
      ||(v.entry!==null)!==(view==='entries'))fail();
    const e=v.entry===null?null:entry(v.entry);
    if(e&&(v.local_vector_count===null||BigInt(e.ordinal)>=BigInt(v.local_vector_count)))fail();
    const row=Object.freeze({...v,entry:e}),current=key(row);
    if(previous&&compare(current,previous)>=0)fail();
    if(cursor){const anchor=[BigInt(cursor.sort_key),cursor.observation_ref,BigInt(cursor.ordinal)];
      if(cursor.direction==='older'?compare(current,anchor)>=0:compare(current,anchor)<=0)fail();}
    previous=current;
    return Object.freeze({observation_ref:v.observation_ref,kind:e?'local_entry:'+e.ordinal:'enhanced_record',enhanced:row});
  });
  const next=enhancedCursor(p.next_cursor,context,query),prior=enhancedCursor(p.previous_cursor,context,query);
  for(const [c,row,direction] of [[next,items.at(-1),'older'],[prior,items[0],'newer']]){
    if(c&&(!row||c.direction!==direction||c.source_revision!==p.source_revision
      ||compare([BigInt(c.sort_key),c.observation_ref,BigInt(c.ordinal)],key(row.enhanced))!==0))fail();
  }
  if(!cursor&&prior||(!cursor||cursor.direction==='older')&&next&&items.length!==20
    ||cursor?.direction==='newer'&&prior&&items.length!==20)fail();
  return Object.freeze({source_ref:p.source_ref,source_revision:p.source_revision,family:ENHANCED_FAMILY,
    mode:query.mode,items:Object.freeze(items),next_cursor:next,previous_cursor:prior});
}
