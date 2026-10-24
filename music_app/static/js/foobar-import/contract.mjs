import {validateObservationPage,OBSERVATION_RESPONSE_BYTES} from './observation-contract.mjs';
// Strict native account-import wire contract. Digests express intent, not authority.
export const BASE='/integrations/foobar/account';
export const JOB='foobar_account_job_v3',REVIEW='foobar_account_review_v4';
export const JOB_LIST='foobar_account_job_list_v1';
export const SCOPE='account-foobar-v1',MAPPING='foobar_text_tools_snapshot_v1';
export const ENHANCED_MAPPING='foobar_enhanced_playcount_store_v1',ENHANCED_PARSER='foobar_enhanced_sqlite_record_v1';
export const MAX_INPUT_BYTES=67108864,MAX_RESPONSE_BYTES=12288;
export const MAX_REVIEW_RESPONSE_BYTES=65536;
export const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=()=>{throw new Error('Invalid import response.');};
const counts=(v,n,max)=>Array.isArray(v)&&v.length===n&&v.every(x=>integer(x,max));
const personalField=v=>v==='rating'||v==='favorite';
const personalRating=v=>integer(v,5)&&v>=1;
const personalKey=v=>`${v.row}:${v.field}`;
const sourceLabel=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\p{C}\u2028\u2029]/u.test(v)&&new TextEncoder().encode(v).length<=max;
export const COMMAND_KEYS=Object.freeze(['source_ref','job_ref','upload_sha256','parser_version','mapping_name','original_matching_library_id','original_generation','total_rows']);
export const PROBLEM_CODES=Object.freeze(['no_matching_library','explicit_detach','association_unavailable','duplicate_source_identity','ambiguous_library_identity','duplicate_local_target','association_conflict','target_not_eligible','no_local_match','invalid_rating','invalid_favorite','invalid_count','unsupported_history_field','protected_rating','protected_favorite']);
const fields=new Set(['path','artist','album_artist','album','date','discnumber','tracknumber','title','rating','rating_stars','rating_stars_fixed','play_count','play_count_enhanced','first_played','last_played','added','first_played_enhanced','last_played_enhanced','added_enhanced','favorite','length','length_ex','played_times','played_times_js','played_times_raw','lastfm_played_times_js','lastfm_play_count']);
export const ERRORS=Object.freeze({foobar_source_quota_exceeded:'The source storage or record limit would be exceeded while saving. This includes temporary save space, even if the final compact history would fit. No automatic retry will be made. Review a smaller import or resolve source capacity before retrying.',authentication_required:'Sign in again, then review the file again.',forbidden:'This import is not permitted for this account or library.',invalid_import_request:'The file or import request is not supported.',stale_import:'The file, account, library or saved state changed. Review again before importing.',unavailable:'Import is unavailable. Check status before trying again.',commit_uncertain:'The last outcome is not confirmed. Check the same import status; do not start a new import.',source_choice_required:'Choose an existing source reference explicitly.'});
export function validateCommand(v){
  if(!exact(v,COMMAND_KEYS)||!uuid(v.source_ref)||!uuid(v.job_ref)||!hex(v.upload_sha256)||![MAPPING,ENHANCED_MAPPING].includes(v.mapping_name)||v.parser_version!==(v.mapping_name===MAPPING?MAPPING:ENHANCED_PARSER)||!integer(v.original_generation,2147483647)||v.original_generation<1||!integer(v.total_rows,100000)||v.total_rows<1||v.original_matching_library_id!==null&&(!integer(v.original_matching_library_id)||v.original_matching_library_id<1))fail();
  return Object.freeze({...v});
}
export function contextEnvelope(v,expected,protocol){if(!v||v.protocol!==protocol||v.context_ref!==expected||v.context_scope!==SCOPE||!hex(expected))fail();return v;}
// Keep the six fractional digits intact for keyset cursors. Date is used only
// to reject impossible calendar dates; it is never used to rebuild a cursor.
const timestamp=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v)
  &&v.slice(0,4)!=='0000'&&Number.isFinite(Date.parse(v.slice(0,23)+'Z'))&&new Date(v.slice(0,23)+'Z').toISOString()===v.slice(0,23)+'Z';
export function validateJobListCursor(v){
  if(v===null)return null;
  if(!exact(v,['updated_at','source_ref','job_ref'])||!timestamp(v.updated_at)||!uuid(v.source_ref)||!uuid(v.job_ref))fail();
  return Object.freeze({...v});
}
export function jobListRequest(unfinished=true,cursor=null){
  if(typeof unfinished!=='boolean')fail();
  return Object.freeze({version:JOB_LIST,unfinished,cursor:validateJobListCursor(cursor)});
}
export function validateJobList(v,expected,unfinished,cursor=null){
  contextEnvelope(v,expected,JOB_LIST);
  if(!exact(v,['protocol','operation','result','context_ref','context_scope'])||v.operation!=='list')fail();
  const r=v.result;
  if(!exact(r,['unfinished','snapshot_kind','busy','items','next_cursor'])||r.unfinished!==unfinished
      ||typeof r.unfinished!=='boolean'||!['durable_page','in_process'].includes(r.snapshot_kind)
      ||typeof r.busy!=='boolean'||r.busy!==(r.snapshot_kind==='in_process')
      ||!Array.isArray(r.items)||r.items.length>(r.busy?1:20))fail();
  let previous=validateJobListCursor(cursor);
  const descending=(a,b)=>{
    for(const key of ['updated_at','source_ref','job_ref']){if(a[key]!==b[key])return a[key]<b[key];}
    return false;
  };
  const seen=new Set();
  const items=r.items.map(x=>{
    if(!exact(x,['source_ref','job_ref','created_at','updated_at','confirmed_rows','total_rows','cancel_requested'])
        ||!uuid(x.source_ref)||!uuid(x.job_ref)||!integer(x.total_rows,100000)||x.total_rows<1
        ||seen.has(x.source_ref+':'+x.job_ref))fail();
    if(r.busy){
      if(x.created_at!==null||x.updated_at!==null||x.confirmed_rows!==null&&!integer(x.confirmed_rows,x.total_rows)
          ||x.cancel_requested!==null&&typeof x.cancel_requested!=='boolean')fail();
    }else if(!timestamp(x.created_at)||!timestamp(x.updated_at)||x.created_at>x.updated_at
        ||!integer(x.confirmed_rows,x.total_rows)||typeof x.cancel_requested!=='boolean'
        ||unfinished&&x.confirmed_rows===x.total_rows)fail();
    if(!r.busy){if(previous&&!descending(x,previous))fail();previous=x;}
    seen.add(x.source_ref+':'+x.job_ref);return Object.freeze({...x});
  });
  const next=validateJobListCursor(r.next_cursor);
  if(next&&(r.busy||items.length!==20||['updated_at','source_ref','job_ref'].some(k=>next[k]!==items.at(-1)[k])))fail();
  return Object.freeze({...r,items:Object.freeze(items),next_cursor:next});
}
export function validateSource(v,expected){
  contextEnvelope(v,expected,'foobar_account_import_v4');
  if(!exact(v,['protocol','operation','result','context_ref','context_scope'])||v.operation!=='source'||!exact(v.result,['source_ref','generation','source_revision','ownership_protocol'])||!uuid(v.result.source_ref)||!integer(v.result.generation,2147483647)||v.result.generation<1||!integer(v.result.source_revision)||v.result.ownership_protocol!=='foobar_account_source_v2')fail();
  return Object.freeze({...v.result});
}
export function validateAccepted(v,expected,protocol,operation,source,job){
  contextEnvelope(v,expected,protocol);
  if(!exact(v,['protocol','operation','source_ref','job_ref','phase','durable_start_confirmed','context_ref','context_scope'])||v.operation!==operation||v.source_ref!==source||v.job_ref!==job||v.durable_start_confirmed!==false||v.phase!==(protocol===REVIEW?'accepted_for_review':'accepted_for_validation'))fail();
  return v;
}
export function validateReview(v,expected,operation,source,job){
  contextEnvelope(v,expected,REVIEW);
  if(!exact(v,['protocol','operation','result','context_ref','context_scope'])||v.operation!==operation)fail();
  const r=v.result;
  if(!exact(r,['phase','error','review','source_ref','job_ref'])||r.source_ref!==source||r.job_ref!==job||!['receiving_source','validating_source','reviewing','review_ready','cancelled_review','invalid_source','needs_review','review_unavailable'].includes(r.phase)||r.error!==null&&!Object.hasOwn(ERRORS,r.error))fail();
  if(r.review===null){if(r.phase==='review_ready')fail();return Object.freeze({...r});}
  const p=r.review;
  if(r.phase!=='review_ready'||!exact(p,['command','inventory_sha256','resume','review_sha256','checked_rows','start_offset','planned_batches','proposed_counts','review_counts','problems','problems_truncated','advisory_not_reservation','conflicts','conflict_count','conflict_after','conflict_next','conflict_remaining','problem_items','problem_count','problem_after','problem_next','problem_remaining',...(Object.hasOwn(p,'observations')?['observations']:[])]))fail();
  const command=validateCommand(p.command);
  if(command.source_ref!==source||command.job_ref!==job||!hex(p.inventory_sha256)||!hex(p.review_sha256)||typeof p.resume!=='boolean'||!integer(p.start_offset,command.total_rows)||!integer(p.checked_rows,command.total_rows)||p.start_offset+p.checked_rows!==command.total_rows||!integer(p.planned_batches,4000)||p.planned_batches<1||!counts(p.proposed_counts,7,p.checked_rows)||p.proposed_counts.slice(0,4).reduce((a,b)=>a+b,0)!==p.checked_rows||!counts(p.review_counts,6,p.checked_rows)||p.review_counts[0]!==p.checked_rows||!Array.isArray(p.problems)||p.problems.length>32||typeof p.problems_truncated!=='boolean'||p.advisory_not_reservation!==true)fail();
  const problems=p.problems.map(x=>{if(!exact(x,['row','code','field'])||!integer(x.row,command.total_rows)||x.row<1||!PROBLEM_CODES.includes(x.code)||x.field!==null&&!fields.has(x.field))fail();return Object.freeze({...x});});
  if(!Array.isArray(p.problem_items)||p.problem_items.length>32||!integer(p.problem_count,p.checked_rows*32)
      ||!integer(p.problem_after,command.total_rows*32+31)||!integer(p.problem_remaining,p.problem_count)
      ||p.problem_items.length+p.problem_remaining>p.problem_count
      ||p.problem_after===0&&p.problem_items.length+p.problem_remaining!==p.problem_count
      ||p.problem_remaining===0&&p.problem_next!==null
      ||p.problem_remaining>0&&(!integer(p.problem_next,command.total_rows*32+31)
        ||p.problem_next<=p.problem_after||p.problem_items.length!==32))fail();
  let previousProblemCursor=p.problem_after;
  const problemItems=p.problem_items.map(x=>{
    if(!exact(x,['cursor','row','code','field','source_artist','source_title','source_album'])
        ||!integer(x.row,command.total_rows)||x.row<=p.start_offset
        ||!integer(x.cursor,command.total_rows*32+31)||Math.floor(x.cursor/32)!==x.row
        ||x.cursor<=previousProblemCursor||!PROBLEM_CODES.includes(x.code)
        ||x.field!==null&&!fields.has(x.field)
        ||!sourceLabel(x.source_artist,48)||!sourceLabel(x.source_title,96)||!sourceLabel(x.source_album,48))fail();
    previousProblemCursor=x.cursor;return Object.freeze({...x});
  });
  if(p.problem_remaining>0&&p.problem_next!==previousProblemCursor)fail();
  if(!Array.isArray(p.conflicts)||p.conflicts.length>32||!integer(p.conflict_count,p.checked_rows*2)
      ||!integer(p.conflict_after,command.total_rows*2+1)||!integer(p.conflict_remaining,p.conflict_count)
      ||p.conflicts.length+p.conflict_remaining>p.conflict_count
      ||p.conflict_after===0&&p.conflicts.length+p.conflict_remaining!==p.conflict_count
      ||p.conflict_remaining===0&&p.conflict_next!==null
      ||p.conflict_remaining>0&&(!integer(p.conflict_next,command.total_rows*2+1)
        ||p.conflict_next<=p.conflict_after||p.conflicts.length!==32))fail();
  const seen=new Set();
  let previousCursor=p.conflict_after;
  const conflicts=p.conflicts.map(x=>{
    if(!exact(x,['row','field','existing','proposed','consequence','eligible','reason','source_artist','source_title','source_album'])
        ||!sourceLabel(x.source_artist,48)||!sourceLabel(x.source_title,96)||!sourceLabel(x.source_album,48)
        ||!integer(x.row,command.total_rows)||x.row<=p.start_offset||!personalField(x.field)
        ||typeof x.eligible!=='boolean'||x.reason!==(x.eligible?null:'provenance_requires_review')
        ||seen.has(personalKey(x)))fail();
    if(x.field==='rating'){
      if(!personalRating(x.proposed)||x.existing!==null&&!personalRating(x.existing)
          ||x.existing===x.proposed||x.consequence!=='replace_personal_rating')fail();
    }else if(x.existing!=='off'||x.proposed!=='loved'||x.consequence!=='set_personal_favorite')fail();
    // The v2 cursor orders public source ordinals, not native identities. It
    // stays opaque to the screen but the decoder rejects skipped/replayed pages.
    const cursor=2*x.row+(x.field==='favorite'?1:0);
    if(cursor<=previousCursor)fail();
    previousCursor=cursor;
    seen.add(personalKey(x));return Object.freeze({...x});
  });
  if(p.conflict_remaining>0&&p.conflict_next!==previousCursor)fail();
  if(command.mapping_name===ENHANCED_MAPPING&&(p.proposed_counts.slice(2,6).some(n=>n!==0)
    ||command.original_matching_library_id===null&&(p.proposed_counts[6]!==0||p.review_counts[1]!==0||p.review_counts[2]!==0)
    ||p.review_counts[4]!==0
    ||p.conflict_count!==0||p.problem_count!==0||p.conflict_after!==0||p.problem_after!==0
    ||problems.length||problemItems.length||conflicts.length||p.problems_truncated))fail();
  const observation=Object.hasOwn(p,'observations')?validateObservationPage(p.observations,command,p.start_offset):null;
  if(observation&&command.mapping_name!==MAPPING)fail();
  return Object.freeze({...r,review:Object.freeze({...p,...(observation?{observations:observation}:{}),command,proposed_counts:Object.freeze([...p.proposed_counts]),review_counts:Object.freeze([...p.review_counts]),problems:Object.freeze(problems),problem_items:Object.freeze(problemItems),conflicts:Object.freeze(conflicts)})});
}
export function validatePersonalChoices(choices,review){
  if(!Array.isArray(choices)||choices.length<1||choices.length>32||!Array.isArray(review?.conflicts))fail();
  const seen=new Set();
  return Object.freeze(choices.map(choice=>{
    if(!exact(choice,['row','field'])||!integer(choice.row,review.command?.total_rows)
        ||choice.row<1||!personalField(choice.field)||seen.has(personalKey(choice)))fail();
    const conflict=review.conflicts.find(item=>item.row===choice.row&&item.field===choice.field);
    if(!conflict||conflict.eligible!==true||conflict.reason!==null
        ||conflict.field==='rating'&&(!personalRating(conflict.proposed)
          ||conflict.existing!==null&&!personalRating(conflict.existing)||conflict.existing===conflict.proposed
          ||conflict.consequence!=='replace_personal_rating')
        ||conflict.field==='favorite'&&(conflict.existing!=='off'||conflict.proposed!=='loved'
          ||conflict.consequence!=='set_personal_favorite'))fail();
    seen.add(personalKey(choice));
    return Object.freeze({row:conflict.row,field:conflict.field,existing:conflict.existing,proposed:conflict.proposed});
  }));
}
export function validatePersonalChanges(v,expected,selection){
  contextEnvelope(v,expected,REVIEW);
  if(!exact(v,['protocol','operation','result','context_ref','context_scope'])||v.operation!=='personal-changes'
      ||!Array.isArray(selection)||selection.length<1||selection.length>32)fail();
  const r=v.result;
  if(!exact(r,['phase','changed_fields','import_started'])||r.phase!=='personal_changes_applied'
      ||r.import_started!==false||!Array.isArray(r.changed_fields)||r.changed_fields.length!==selection.length)fail();
  const seen=new Set();
  const changed=r.changed_fields.map(x=>{
    if(!exact(x,['row','field','existing','proposed'])||!integer(x.row,100000)||x.row<1
        ||!personalField(x.field)||seen.has(personalKey(x)))fail();
    const requested=selection.find(item=>item.row===x.row&&item.field===x.field);
    if(!requested||x.existing!==requested.existing||x.proposed!==requested.proposed)fail();
    if(x.field==='rating'&&(!personalRating(x.proposed)||x.existing!==null&&!personalRating(x.existing)
        ||x.existing===x.proposed)||x.field==='favorite'&&(x.existing!=='off'||x.proposed!=='loved'))fail();
    seen.add(personalKey(x));return Object.freeze({...x});
  });
  return Object.freeze({...r,changed_fields:Object.freeze(changed)});
}
const JOB_PHASES=new Set(['receiving_source','validating_source','preflighting','preflight_ready','preparing','reconciled_prepare','applying','batch_confirmed','completed','cancelled','needs_resume','paused','needs_preflight','needs_review','needs_reconciliation','invalid_source','needs_file','claimed','ready']);
export function validateJob(v,expected,operation,source,job){
  contextEnvelope(v,expected,JOB);
  const keys=['protocol','operation','result','context_ref','context_scope'];
  if(Object.hasOwn(v,'settled_diagnostic'))keys.push('settled_diagnostic');
  if(!exact(v,keys)||v.operation!==operation)fail();
  const r=v.result,base=['phase','snapshot_kind','uncertain','cancel_pending','error','command','confirmed_rows','remaining_rows','confirmed_counts','disposition','cancel_requested','pending_attempt'];
  if(r&&Object.hasOwn(r,'preflight'))base.push('preflight');
  if(!exact(r,base)||!JOB_PHASES.has(r.phase)||!['durable','last_confirmed'].includes(r.snapshot_kind)||typeof r.uncertain!=='boolean'||typeof r.cancel_pending!=='boolean'||r.error!==null&&!Object.hasOwn(ERRORS,r.error))fail();
  const command=validateCommand(r.command);
  if(command.source_ref!==source||command.job_ref!==job)fail();
  if(r.confirmed_rows===null){if(r.remaining_rows!==null||r.confirmed_counts!==null||r.disposition!==null||r.cancel_requested!==null||r.pending_attempt!==null)fail();}
  else if(!integer(r.confirmed_rows,command.total_rows)||r.remaining_rows!==command.total_rows-r.confirmed_rows||!counts(r.confirmed_counts,7,r.confirmed_rows)||r.confirmed_counts.slice(0,4).reduce((a,b)=>a+b,0)!==r.confirmed_rows||!JOB_PHASES.has(r.disposition)||typeof r.cancel_requested!=='boolean'||(r.disposition==='completed')!==(r.confirmed_rows===command.total_rows))fail();
  if(r.pending_attempt!==null&&(!exact(r.pending_attempt,['batch_no','attempt_no','state'])||!integer(r.pending_attempt.batch_no,100000)||r.pending_attempt.batch_no<1||!integer(r.pending_attempt.attempt_no)||r.pending_attempt.attempt_no<1||!['claimed','ready','confirmed','discarded'].includes(r.pending_attempt.state)))fail();
  if(r.preflight!==undefined){const p=r.preflight;if(!exact(p,['checked_rows','start_offset','planned_batches','proposed_counts','field_error_count','status','advisory_not_reservation'])||!integer(p.checked_rows,command.total_rows)||!integer(p.start_offset,command.total_rows)||!integer(p.planned_batches,4000)||!counts(p.proposed_counts,7,command.total_rows)||!integer(p.field_error_count,3000000)||!['complete_preflight','cancelled_preflight'].includes(p.status)||p.advisory_not_reservation!==true)fail();}
  if(v.settled_diagnostic!==undefined&&v.settled_diagnostic!==null){const d=v.settled_diagnostic;if(!exact(d,['phase','uncertain','error','snapshot_kind','durable_proof'])||!JOB_PHASES.has(d.phase)||typeof d.uncertain!=='boolean'||d.error!==null&&!Object.hasOwn(ERRORS,d.error)||d.snapshot_kind!=='settled_process_diagnostic'||d.durable_proof!==false)fail();}
  return Object.freeze({...r,command,confirmed_counts:r.confirmed_counts===null?null:Object.freeze([...r.confirmed_counts])});
}
export function validateFile(file,mapping=MAPPING){const enhanced=mapping===ENHANCED_MAPPING;if(![MAPPING,ENHANCED_MAPPING].includes(mapping)||!file||typeof file.name!=='string'||!integer(file.size,enhanced?536870912:MAX_INPUT_BYTES)||file.size<(enhanced?100:1)||!(enhanced?/\.(sqlite|sqlite3|db)$/i:/\.tsv$/i).test(file.name)||typeof file.slice!=='function')throw new Error('Choose a supported file for the selected format.');return file;}
export async function readBoundedJSON(response,signal,maximum=MAX_RESPONSE_BYTES){
  if(maximum!==MAX_RESPONSE_BYTES&&maximum!==MAX_REVIEW_RESPONSE_BYTES&&maximum!==OBSERVATION_RESPONSE_BYTES)fail();
  if(!response||response.redirected||!response.headers?.get('content-type')?.toLowerCase().startsWith('application/json'))fail();
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maximum))fail();
  const reader=response.body?.getReader();if(!reader)fail();const decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
  try{while(true){if(signal?.aborted)throw new DOMException('Aborted','AbortError');const item=await reader.read();if(item.done)break;if(!(item.value instanceof Uint8Array))fail();bytes+=item.value.byteLength;if(bytes>maximum)fail();text+=decoder.decode(item.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}


export const TEMPORARY_SOURCE='foobar_temporary_source_v1';
export function validateTemporarySource(v,expected,source,job){
  contextEnvelope(v,expected,TEMPORARY_SOURCE);
  if(!exact(v,['protocol','source','context_ref','context_scope']))fail();
  if(v.source===null)return null;
  const r=v.source;
  if(!exact(r,['source_ref','job_ref','mapping_name','upload_sha256','byte_length','expires_at'])
      ||r.source_ref!==source||r.job_ref!==job||!uuid(source)||!uuid(job)||!hex(r.upload_sha256)
      ||![MAPPING,ENHANCED_MAPPING].includes(r.mapping_name)||!Number.isSafeInteger(r.byte_length)
      ||r.byte_length<(r.mapping_name===ENHANCED_MAPPING?100:1)
      ||r.byte_length>(r.mapping_name===ENHANCED_MAPPING?536870912:67108864)
      ||typeof r.expires_at!=='string'||r.expires_at.length>40||!Number.isFinite(Date.parse(r.expires_at)))fail();
  return Object.freeze({...r});
}
