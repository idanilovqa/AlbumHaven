import {OBSERVATION_RESPONSE_BYTES,validateRawFieldRequest} from './observation-contract.mjs';
import {BASE,JOB,JOB_LIST,REVIEW,SCOPE,MAPPING,ENHANCED_MAPPING,ERRORS,MAX_REVIEW_RESPONSE_BYTES,MAX_RESPONSE_BYTES,uuid,hex,validateFile,readBoundedJSON,validateSource,validateAccepted,validateReview,validatePersonalChoices,validatePersonalChanges,validateJob,jobListRequest,validateJobList} from './contract.mjs';

// File bytes remain in this mounted controller only. No browser storage or new
// key fallback is used to recover a possibly committed import.
export function createImportController({fetch,contextRoot,allows,isCurrent,onChange}){
  let disposed=false,retired=false,expected=null,matchingHint='',sequence=0,abort=null,poll=null;
  let file=null,reviewFile=null,submitted=false,submittedCommand=null,jobRef=null,sourceRef=null,resumeMode=false,sourcePending=false,reviewCancelled=false;
  let reviewAfter=0,problemAfter=0,reviewCandidate=null,continuationReview=null,discoveryPending=false,observationRequest=null;
  let state=Object.freeze({phase:'checking',source:null,filename:'',mapping:MAPPING,countFamily:'standard',matching:false,matchingAvailable:false,review:null,job:null,error:'',notice:'',jobRef:null,submitted:false});
  const discoverySafe=()=>!submitted&&!file&&!reviewFile&&!reviewCandidate&&!continuationReview&&!state.review&&!sourcePending&&!discoveryPending&&!abort&&!poll&&['idle','error'].includes(state.phase);
  const publish=patch=>{state=Object.freeze({...state,...patch,jobRef,submitted});state=Object.freeze({...state,canDiscover:discoverySafe()});if(!disposed)onChange(state);};
  const stop=()=>{sequence++;abort?.abort();abort=null;clearTimeout(poll);poll=null;};
  const same=()=>!disposed&&!retired&&contextRoot?.isConnected===true&&contextRoot.dataset.accountFoobarContext===expected&&contextRoot.dataset.accountFoobarScope===SCOPE&&(contextRoot.dataset.accountFoobarMatchingLibraryId||'')===matchingHint;
  function retire(){if(disposed||retired)return;retired=true;stop();file=reviewFile=reviewCandidate=null;continuationReview=null;publish({phase:'retired',review:null,filename:'',error:'The account or selected library changed. Reopen Integrations and check the same import status.',notice:''});}
  function current(){try{if(!same()||allows('account.self.foobar.write')!==true||isCurrent()!==true){retire();return false;}return true;}catch{retire();return false;}}
  const busy=()=>discoveryPending||['checking','reviewing','saving_personal','submitting','importing'].includes(state.phase);
  const durableComplete=result=>result.phase==='completed'&&result.snapshot_kind==='durable'&&result.uncertain===false&&result.disposition==='completed'&&result.confirmed_rows===result.command.total_rows&&result.remaining_rows===0;
  const phaseAfterError=()=>submitted?'paused':'error';
  function failure(code){reviewFile=reviewCandidate=null;continuationReview=null;publish({phase:phaseAfterError(),review:null,error:ERRORS[code]||'The request could not be confirmed. Check the same import status before retrying.',notice:submitted?'Committed batches are not undone. Keep this source and import reference.':''});}
  function personalFailure(code){
    reviewFile=reviewCandidate=null;continuationReview=null;
    publish({phase:phaseAfterError(),review:null,error:code==='stale_import'
      ?'The personal-change proposal is no longer current. Run a fresh review before choosing fields again.'
      :'The personal save outcome could not be confirmed. Selected fields may already have changed. Run a fresh review to inspect current values; do not resend the old selections.',
      notice:'Personal changes are separate from import progress. A fresh review and explicit confirmation are required before any further save or import.'});
  }
  async function request(path,{body,command,protocol,validate,onFailure=failure}){
    stop();if(!current())return null;const token=sequence,controller=new AbortController();abort=controller;
    const timeout=setTimeout(()=>controller.abort(),command?.mapping_name===ENHANCED_MAPPING?610000:60000);
    const live=()=>token===sequence&&current();
    try{
      const headers={Accept:'application/json','X-AlbumHaven-Foobar-Context':expected};
      if(command){headers['Content-Type']=command.mapping_name===ENHANCED_MAPPING?'application/vnd.sqlite3':'text/tab-separated-values; charset=utf-8';headers['X-Album-Haven-Foobar-Bytes']=String(body.size);headers['X-AlbumHaven-Foobar-Command']=JSON.stringify(command);}
      else headers['Content-Type']='application/json';
      const response=await fetch(BASE+path,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers,body:command?body:JSON.stringify(body)});
      if(response.status===401||response.status===403){if(same())retire();return null;}
      if(!live())return null;
      const value=await readBoundedJSON(response,controller.signal,protocol===REVIEW?(observationRequest!==null||state.review?.observations?OBSERVATION_RESPONSE_BYTES:MAX_REVIEW_RESPONSE_BYTES):MAX_RESPONSE_BYTES);
      if(!live())return null;
      if(!response.ok){const code=value?.protocol===protocol&&value.context_ref===expected&&value.context_scope===SCOPE&&Object.hasOwn(ERRORS,value.error)?value.error:null;onFailure(code);return null;}
      return validate(value);
    }catch{if(live())onFailure(null);return null;}
    finally{clearTimeout(timeout);controller.abort();if(token===sequence)abort=null;}
  }
  const schedule=fn=>{clearTimeout(poll);if(current())poll=setTimeout(()=>{poll=null;void fn();},1000);};
  function identity(){return {version:JOB,source_ref:sourceRef,job_ref:jobRef};}
  async function discoverJobs(unfinished=state.discoveryUnfinished??true,cursor=null){
    if(!current()||!discoverySafe())return null;
    const body=jobListRequest(unfinished,cursor);
    discoveryPending=true;
    publish({discoveryLoading:true,discoveryError:'',discoveryUnfinished:unfinished});
    const result=await request('/job/list',{protocol:JOB_LIST,body,validate:v=>validateJobList(v,expected,unfinished,body.cursor),
      onFailure:()=>publish({discoveryError:'The import list could not be read. Earlier entries may be stale; no import identity was changed. Refresh to try again.'})});
    discoveryPending=false;
    if(!current())return null;
    // Discovery is advisory and cannot erase or replace a retained identity.
    publish({discoveryLoading:false,...(result?{discovery:result,discoveryCursor:body.cursor,discoveryError:''}:{})});
    return result;
  }
  async function recoverJob(ref,source){
    if(!current()||busy()||submitted&&(jobRef!==ref||sourceRef!==source)||!uuid(ref)||!uuid(source))return;
    stop();sourceRef=source;jobRef=ref;submitted=true;resumeMode=true;file=reviewFile=null;
    publish({phase:'paused',filename:'',source:Object.freeze({source_ref:source,generation:null,source_revision:null}),review:null,job:null,error:'',notice:'Reading the exact saved import. No new import key will be created.'});
    await refreshStatus();
  }
  async function selectDiscoveredJob(ref,source){
    if(!current()||!discoverySafe()||state.discoveryLoading||state.discoveryError
        ||!state.discovery?.items.some(item=>item.job_ref===ref&&item.source_ref===source))return;
    await recoverJob(ref,source);
  }
  async function selectSource(ref=null){
    if(discoveryPending)return;
    if(!current()||sourcePending||busy()&&state.phase!=='checking'||submitted){if(submitted)publish({notice:'Keep the current import identity until status confirms completion. Recover it instead of choosing a new source.'});return;}
    if(ref!==null&&!uuid(ref)){publish({phase:'error',error:'Enter the exact source reference UUID, or choose the default source.'});return;}
    publish({phase:'checking',review:null,error:'',notice:''});
    sourcePending=true;
    const result=await request('/ui/source',{protocol:'foobar_account_import_v4',body:{source_ref:ref},validate:v=>validateSource(v,expected)});
    sourcePending=false;
    if(result&&current()){sourceRef=result.source_ref;jobRef=null;resumeMode=false;publish({phase:file?'selected':'idle',source:result,job:null,review:null,error:''});}
    else if(current())publish({}); // Re-enable safe discovery after source failure settles.
  }
  async function pollReview(){
    if(!current()||state.phase!=='reviewing')return;
    const result=await request('/review/status',{protocol:REVIEW,body:{version:REVIEW,source_ref:sourceRef,job_ref:jobRef},validate:v=>validateReview(v,expected,'status',sourceRef,jobRef)});
    if(!result||!current())return;
    if(result.phase==='review_ready'){
      if(reviewCancelled){reviewFile=reviewCandidate=null;continuationReview=null;publish({phase:file?'selected':'idle',review:null,notice:'Review cancelled. No import was applied.'});return;}
      const p=result.review;
      if(file!==reviewCandidate||p.command.mapping_name!==state.mapping||p.conflict_after!==reviewAfter||p.problem_after!==problemAfter||p.resume!==resumeMode||p.command.original_matching_library_id!==(state.matching?Number(matchingHint):null)){failure('stale_import');return;}
      // A lost initial response never licenses different immutable input under
      // the saved identity. A new-review success proves no retained job under
      // the real source lock; confirmation still rechecks the same command.
      if(submittedCommand&&Object.keys(submittedCommand).some(key=>submittedCommand[key]!==p.command[key])){failure('stale_import');return;}
      if(continuationReview&&(p.review_sha256!==continuationReview.review_sha256
          ||p.inventory_sha256!==continuationReview.inventory_sha256
          ||observationRequest===null&&(p.conflict_count!==continuationReview.conflict_count||p.problem_count!==continuationReview.problem_count)
          ||p.start_offset!==continuationReview.start_offset||p.checked_rows!==continuationReview.checked_rows
          ||Object.keys(continuationReview.command).some(key=>continuationReview.command[key]!==p.command[key]))){failure('stale_import');return;}
      if(continuationReview&&observationRequest===null){
        // The unchanged cursor must retain its page, while the advanced cursor
        // consumes exactly the cached remaining instances. Counts are not songs.
        for(const [prefix,items] of [['problem','problem_items'],['conflict','conflicts']]){
          const previous=continuationReview;
          const advanced=p[`${prefix}_after`]!==previous[`${prefix}_after`];
          if(advanced?p[items].length+p[`${prefix}_remaining`]!==previous[`${prefix}_remaining`]
              :p[`${prefix}_remaining`]!==previous[`${prefix}_remaining`]
                ||p[`${prefix}_next`]!==previous[`${prefix}_next`]
                ||p[items].length!==previous[items].length
                ||p[items].some((item,index)=>Object.keys(item).some(key=>item[key]!==previous[items][index]?.[key]))){failure('stale_import');return;}
        }
      }
      if(observationRequest!==null){
        const view=p.observations,raw=observationRequest.raw;
        if(!view||view.after!==observationRequest.after
            ||raw===null&&view.raw_chunk!==null
            ||raw!==null&&(!view.raw_chunk||Object.keys(raw).some(key=>view.raw_chunk[key]!==raw[key]))){failure('stale_import');return;}
      }else if(p.observations){failure('stale_import');return;}
      reviewFile=reviewCandidate;reviewCandidate=null;continuationReview=null;observationRequest=null;
      publish({phase:'review_ready',review:p,error:'',notice:'Dry run only. Nothing has been imported by this review. Personal changes require their own separate confirmation; importing requires explicit import confirmation.'});
    }else if(['receiving_source','validating_source','reviewing'].includes(result.phase))schedule(pollReview);
    else if(result.phase==='cancelled_review'){reviewFile=reviewCandidate=null;continuationReview=null;publish({phase:file?'selected':'idle',review:null,notice:'Review cancelled. No import was applied.'});}
    else failure(result.error||'unavailable');
  }
  async function startReview(after=0,problem=0,previous=null,observation=null){
    if(!current()||busy()||!file||!sourceRef)return;
    if(previous){
      if(state.phase!=='review_ready'||state.review!==previous||file!==reviewFile)return;
      if(observation!==null){
        const old=previous.observations;
        if(state.mapping!==MAPPING||after!==0||problem!==0||!Number.isSafeInteger(observation.after)
            ||(old?!(observation.after===old.after||observation.after===old.next&&observation.raw===null)
                :observation.after!==previous.start_offset||observation.raw!==null))return;
      }else if(previous.observations||!((after===previous.conflict_next&&after!==null&&problem===previous.problem_after)
          ||(problem===previous.problem_next&&problem!==null&&after===previous.conflict_after)))return;
    }else if(observation!==null)return;
    if(submitted&&!state.job&&!submittedCommand){publish({phase:'paused',notice:'Read the current import status before reviewing remaining work. Original command details are not retained here.'});return;}
    if(!jobRef){try{jobRef=crypto.randomUUID();}catch{failure('unavailable');return;}if(!uuid(jobRef)){failure('unavailable');return;}}
    resumeMode=submitted&&state.job!==null;reviewCancelled=false;
    const chosen=file,scope=state.matching?Number(matchingHint):null;
    reviewAfter=after;problemAfter=problem;reviewCandidate=chosen;continuationReview=previous;reviewFile=null;observationRequest=observation;
    publish({phase:'reviewing',review:null,error:'',notice:previous
      ?'Uploading the same original file and running a new whole-file review for the next page. Selections and confirmations are cleared; no changes are saved.'
      :'Checking the complete remaining file, starting at the first problem and conflict pages. This does not import anything or save personal changes.'});
    const result=await request('/review/start',{protocol:REVIEW,body:chosen,command:{version:REVIEW,source_ref:sourceRef,job_ref:jobRef,mapping_name:state.mapping,matching_library_id:scope,resume:resumeMode,conflict_after:after,problem_after:problem,previous_review_sha256:previous?.review_sha256||null,...(observation?{observation_after:observation.after,observation_raw:observation.raw}:{})},validate:v=>validateAccepted(v,expected,REVIEW,'start',sourceRef,jobRef)});
    if(result&&current()&&file===chosen)schedule(pollReview);
  }
  async function preview(){await startReview();}
  async function inspectObservations(after=null,raw=null){
    if(!current()||busy()||state.phase!=='review_ready'||!state.review||file!==reviewFile||state.mapping!==MAPPING)return;
    const previous=state.review,page=previous.observations;
    try{raw=validateRawFieldRequest(raw,page);}catch{return;}
    await startReview(0,0,previous,Object.freeze({after:after===null?(page?.after??previous.start_offset):after,raw}));
  }
  async function nextConflictPage(){
    if(!current()||state.phase!=='review_ready'||!state.review||file!==reviewFile||state.review.conflict_next===null)return;
    await startReview(state.review.conflict_next,state.review.problem_after,state.review);
  }
  async function firstConflictPage(){
    if(!current()||state.phase!=='review_ready'||!state.review||file!==reviewFile||state.review.conflict_after===0)return;
    await startReview();
  }
  async function nextProblemPage(){
    if(!current()||state.phase!=='review_ready'||!state.review||file!==reviewFile||state.review.problem_next===null)return;
    await startReview(state.review.conflict_after,state.review.problem_next,state.review);
  }
  async function firstProblemPage(){
    if(!current()||state.phase!=='review_ready'||!state.review||file!==reviewFile||state.review.problem_after===0)return;
    await startReview();
  }
  async function savePersonalChanges(choices){
    if(!current()||state.phase!=='review_ready'||!state.review||!file||file!==reviewFile)return;
    const proposal=state.review;
    let selection;
    try{selection=validatePersonalChoices(choices,proposal);}
    catch{publish({error:'Choose between 1 and 32 eligible individual fields from this current conflict page.'});return;}
    // Invalidate before dispatch. Even an unreadable/lost acknowledgment cannot
    // authorize a replay, an import, a new job identity or reused choices.
    reviewFile=reviewCandidate=null;continuationReview=null;
    publish({phase:'saving_personal',review:null,error:'',notice:'Saving only the explicitly selected personal fields, separately from import.'});
    const result=await request('/review/personal-changes',{protocol:REVIEW,
      body:{version:REVIEW,source_ref:sourceRef,job_ref:jobRef,review_sha256:proposal.review_sha256,choices:selection.map(item=>[item.row,item.field])},
      validate:v=>validatePersonalChanges(v,expected,selection),onFailure:personalFailure});
    if(!current())return;
    reviewFile=reviewCandidate=null;continuationReview=null;
    if(result)publish({phase:submitted?'paused':'selected',review:null,error:'',
      notice:`Saved ${result.changed_fields.length} selected personal fields. No import was started by this save, and import progress is unchanged. Run a fresh review before selecting more personal changes or confirming an import.`});
    else if(state.phase==='saving_personal')personalFailure(null);
  }
  async function refreshStatus(){
    if(!current()||!submitted||!sourceRef||!jobRef||state.phase==='reviewing'||state.phase==='submitting'||state.phase==='saving_personal')return;
    const result=await request('/job/status',{protocol:JOB,body:identity(),validate:v=>validateJob(v,expected,'status',sourceRef,jobRef)});
    if(!result||!current())return;
    if(submittedCommand&&Object.keys(submittedCommand).some(key=>submittedCommand[key]!==result.command[key])){failure('stale_import');return;}
    submittedCommand=result.command;
    if(state.mapping!==result.command.mapping_name){file=reviewFile=null;publish({mapping:result.command.mapping_name,filename:'',review:null});}
    const library=result.command.original_matching_library_id;
    const completed=durableComplete(result);
    if(!completed&&library!==null&&String(library)!==matchingHint){publish({phase:'paused',job:result,review:null,error:'This import keeps its original library scope. Select that library before reviewing remaining work.',notice:'Status remains account-owned; no library access was used to recover it.'});if(result.snapshot_kind==='last_confirmed')schedule(refreshStatus);return;}
    const running=result.snapshot_kind==='last_confirmed'&&['receiving_source','validating_source','preflighting','preflight_ready','preparing','reconciled_prepare','applying','batch_confirmed'].includes(result.phase);
    publish({phase:completed?'completed':running?'importing':'paused',job:result,matching:library!==null&&String(library)===matchingHint,
      error:result.error?ERRORS[result.error]||ERRORS.unavailable:'',
      notice:completed?'All rows are confirmed by durable checkpoints.':result.uncertain?'The last outcome is uncertain. Reconcile this same import; do not start another.':result.cancel_pending?'Cancellation is pending. An already-running batch may still commit.':'Only the confirmed prefix is counted. Later failures do not undo it.'});
    if(running||result.phase==='completed'&&result.snapshot_kind==='last_confirmed')schedule(refreshStatus);
  }
  async function confirm(){
    if(!current()||state.phase!=='review_ready'||!state.review||!file||file!==reviewFile)return;
    const proposal=state.review,chosen=file,operation=proposal.resume?'resume':'start';
    submitted=true;submittedCommand=proposal.command;resumeMode=true;
    publish({phase:'submitting',error:'',notice:'Submitting the reviewed intent. Acceptance is not proof of completion.'});
    const result=await request('/job/'+operation,{protocol:JOB,body:chosen,command:{version:JOB,...proposal.command,inventory_sha256:proposal.inventory_sha256,review_sha256:proposal.review_sha256},validate:v=>validateAccepted(v,expected,JOB,operation,sourceRef,jobRef)});
    reviewFile=null;
    if(result&&current()){publish({phase:'importing',review:null});schedule(refreshStatus);}
  }
  async function cancel(){
    if(!current()||!jobRef||!sourceRef||state.phase==='saving_personal')return;
    if(state.phase==='reviewing'){
      reviewCancelled=true;reviewFile=null;
      const result=await request('/review/cancel',{protocol:REVIEW,body:{version:REVIEW,source_ref:sourceRef,job_ref:jobRef},validate:v=>validateReview(v,expected,'cancel',sourceRef,jobRef)});
      if(result&&current()){publish({phase:'reviewing',review:null,notice:'Review cancellation requested. Waiting for its current bounded work to settle.'});schedule(pollReview);}return;
    }
    if(!submitted)return;
    const result=await request('/job/cancel',{protocol:JOB,body:identity(),validate:v=>validateJob(v,expected,'cancel',sourceRef,jobRef)});
    if(result&&current()){
      if(submittedCommand&&Object.keys(submittedCommand).some(key=>submittedCommand[key]!==result.command[key])){failure('stale_import');return;}
      submittedCommand=result.command;
      const completed=durableComplete(result);
      publish({phase:completed?'completed':'paused',job:result,review:null,notice:completed?'All rows are confirmed by durable checkpoints.':result.cancel_pending?'Cancellation is pending. Already committed rows remain.':'Cancellation checked. Already committed rows remain.'});
      if(!completed)schedule(refreshStatus);
    }
  }
  return Object.freeze({getState:()=>state,
    async initialize(){if(disposed||expected!==null)return;try{expected=contextRoot.dataset.accountFoobarContext;matchingHint=contextRoot.dataset.accountFoobarMatchingLibraryId||'';if(!hex(expected)||contextRoot.dataset.accountFoobarScope!==SCOPE||matchingHint!==''&&(!/^[1-9][0-9]*$/.test(matchingHint)||!Number.isSafeInteger(Number(matchingHint))))throw new Error();publish({phase:'idle',matchingAvailable:matchingHint!==''});}catch{retire();return;}const listed=await discoverJobs(true,null);if(listed&&!listed.busy&&discoverySafe())await selectSource(null);},
    discoverJobs,selectDiscoveredJob,
    async nextJobPage(){if(!state.discovery||state.discoveryError||state.discovery.unfinished!==state.discoveryUnfinished||!state.discovery.next_cursor)return;await discoverJobs(state.discovery.unfinished,state.discovery.next_cursor);},
    selectSource,
    choose(candidate){if(!current()||busy())return;try{file=validateFile(candidate,state.mapping);reviewFile=null;publish({phase:'selected',filename:file.name,review:null,error:'',notice:submitted?'Reselect the identical original file. Review remaining work before confirming.':''});}catch{file=reviewFile=null;publish({phase:'error',filename:'',review:null,error:state.mapping===ENHANCED_MAPPING?'Choose a finalized self-contained SQLite artifact, at most 512 MiB.':'Choose a nonempty UTF-8 TSV file, at most 64 MiB.'});}},
    setMapping(value){if(!current()||busy()||submitted||![MAPPING,ENHANCED_MAPPING].includes(value))return;file=reviewFile=reviewCandidate=null;continuationReview=null;publish({mapping:value,matching:false,filename:'',review:null,phase:'idle',notice:'Format changed. Select the original file and run a fresh review.'});},
    setMatching(value){if(!current()||busy()||submitted||typeof value!=='boolean'||value&&!state.matchingAvailable)return;publish({matching:value,review:null,phase:file?'selected':'idle',notice:'Changing matching scope requires a fresh review.'});},
    setCountFamily(value){if(!current()||busy()||submitted||state.mapping!==MAPPING||!['standard','enhanced'].includes(value))return;
      publish({countFamily:value,review:state.review?Object.freeze({...state.review}):null,
        notice:'Count display changed. Both original families remain separate and retained; confirm this review again before importing.'});},
    inspectObservations,
    preview,confirm,refreshStatus,cancel,savePersonalChanges,nextConflictPage,firstConflictPage,nextProblemPage,firstProblemPage,
    async resume(){if(!current()||busy()||!submitted||!file||!state.job&&!submittedCommand)return;await preview();},
    recoverJob,
    clear(){if(!current()||busy()||submitted&&state.phase!=='completed'){if(submitted)publish({notice:'Keep this import reference. Check or reconcile its status before starting another import.'});return;}stop();file=reviewFile=null;submittedCommand=null;submitted=resumeMode=false;jobRef=null;publish({phase:sourceRef?'idle':'error',filename:'',review:null,job:null,error:'',notice:''});},
    dispose(){stop();disposed=true;file=reviewFile=reviewCandidate=null;continuationReview=null;state=Object.freeze({...state,phase:'retired',filename:'',review:null});},
  });
}
