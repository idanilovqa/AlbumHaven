import {BASE,SCOPE,uuid,readBoundedJSON} from './contract.mjs';

const PROTOCOL='foobar_account_maintenance_v1';
const keys=(v,w)=>v&&typeof v==='object'&&!Array.isArray(v)
  &&Object.keys(v).sort().join('|')===[...w].sort().join('|');
const integer=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const timestamp=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/.test(value)
      ||Number(value.slice(0,4))<1)return false;
  // Validate the visible Gregorian calendar without rounding or rewriting the
  // opaque six-digit cursor. Only the validation projection uses milliseconds.
  const projected=value.slice(0,23)+'Z';
  try{return new Date(projected).toISOString()===projected;}catch{return false;}
};
const cursor=value=>value===null||(keys(value,['expires_at','generation','receipt_ref'])
  &&timestamp(value.expires_at)
  &&integer(value.generation,2147483647)&&value.generation>0&&uuid(value.receipt_ref));

export function validateMaintenance(value,context,source){
  if(!keys(value,['protocol','context_ref','context_scope','result'])
      ||value.protocol!==PROTOCOL||value.context_ref!==context||value.context_scope!==SCOPE)
    throw new TypeError('Unconfirmed maintenance response');
  const r=value.result;
  if(!keys(r,['source_ref','inspected','removed_receipts','protected_receipts','removed_keys',
      'retired_through','next_cursor','more_retired_keys','history_deleted','job_reconciled'])
      ||r.source_ref!==source||!uuid(source)||!integer(r.inspected,20)
      ||!integer(r.removed_receipts,20)||!integer(r.protected_receipts,20)
      ||r.removed_receipts+r.protected_receipts!==r.inspected||!integer(r.removed_keys,100)
      ||!integer(r.retired_through,2147483646)||!cursor(r.next_cursor)
      ||r.next_cursor!==null&&r.inspected!==20||typeof r.more_retired_keys!=='boolean'
      ||r.history_deleted!==false||r.job_reconciled!==false)
    throw new TypeError('Unconfirmed maintenance result');
  return Object.freeze({...r,next_cursor:r.next_cursor===null?null:Object.freeze({...r.next_cursor})});
}

// Existing authenticated fetch owns CSRF. This component never retries a POST.
// A timeout/abandon is not a rollback claim, and no generation/key is invented.
export function mountMaintenance(host,{fetch,contextRoot,isCurrent,allows}){
  const d=host.ownerDocument,w=d.defaultView,context=contextRoot.dataset.accountFoobarContext;
  let disposed=false,busy=false,source=null,enabled=false,next=null,moreKeys=false,abort=null,sequence=0;
  const section=d.createElement('details'),summary=d.createElement('summary'),hint=d.createElement('p');
  summary.textContent='Expired import replay metadata';
  hint.textContent='Run one bounded cleanup pass for the selected account source. Imported history and job checkpoints are kept. Unresolved jobs may prevent cleanup. This does not resume, cancel or erase an import.';
  const start=d.createElement('button'),more=d.createElement('button'),status=d.createElement('p');
  start.type=more.type='button';start.textContent='Clean expired metadata';more.textContent='Continue bounded cleanup';
  status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  section.append(summary,hint,start,more,status);host.append(section);
  const live=()=>!disposed&&host.isConnected&&contextRoot.isConnected
    &&contextRoot.dataset.accountFoobarContext===context&&contextRoot.dataset.accountFoobarScope===SCOPE
    &&isCurrent()===true&&allows('account.self.foobar.write')===true;
  function paint(){start.disabled=!enabled||busy||!source;more.disabled=start.disabled||(!next&&!moreKeys);}
  async function run(continuation){
    if(!live()||!enabled||busy||!source||continuation&&!next&&!moreKeys)return;
    const chosen=source,token=++sequence,requested=continuation?next:null;
    busy=true;next=null;moreKeys=false;paint();status.textContent='Checking one bounded metadata page…';
    const controller=new AbortController();abort=controller;
    const timer=w.setTimeout(()=>controller.abort(),65000);
    try{
      const response=await fetch(BASE+'/maintenance',{method:'POST',credentials:'same-origin',
        cache:'no-store',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',
          Accept:'application/json','X-AlbumHaven-Foobar-Context':context},
        body:JSON.stringify({version:PROTOCOL,source_ref:chosen,cursor:requested})});
      const value=await readBoundedJSON(response,controller.signal,12288);
      if(!live()||sequence!==token||source!==chosen)return;
      if(!response.ok)throw new Error('Maintenance not confirmed');
      const r=validateMaintenance(value,context,chosen);next=r.next_cursor;moreKeys=r.more_retired_keys;
      status.textContent=`This pass inspected ${r.inspected} expired receipts, removed ${r.removed_receipts}, protected ${r.protected_receipts}, and retired ${r.removed_keys} request-key records. Imported history was not deleted. `
        +(r.protected_receipts?'Protected job receipts require their genuine status/reconciliation flow. ':'')
        +(next||moreKeys?'More bounded work is available.':'No later work was reported in this pass. A fresh pass can reconsider protected or newly expired metadata.');
    }catch{
      if(live()&&sequence===token&&source===chosen)status.textContent='Cleanup outcome was not confirmed and may have committed. No automatic retry was sent. You may explicitly start a new current-state pass; this is not a retry of the old result.';
    }finally{
      w.clearTimeout(timer);controller.abort();if(sequence===token){abort=null;busy=false;paint();}
    }
  }
  const first=()=>{void run(false);},later=()=>{void run(true);};
  start.addEventListener('click',first);more.addEventListener('click',later);paint();
  return Object.freeze({update(state){
    const selected=uuid(state?.source?.source_ref)?state.source.source_ref:null;
    if(selected!==source){sequence++;abort?.abort();abort=null;busy=false;source=selected;next=null;moreKeys=false;status.textContent='';}
    enabled=['idle','error'].includes(state?.phase)&&state?.submitted!==true&&state?.discoveryLoading!==true;
    paint();
  },dispose(){disposed=true;sequence++;abort?.abort();start.removeEventListener('click',first);
    more.removeEventListener('click',later);section.remove();}});
}
