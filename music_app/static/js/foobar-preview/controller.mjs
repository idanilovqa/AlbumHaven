import {CAPABILITIES_URL,PREVIEW_URL,PreviewBodyInterruptedError,readBoundedJSON,validateCapabilities,validateFile,validatePage} from './contract.mjs';

const messages=Object.freeze({authentication_required:'Sign in again to preview this file.',preview_denied:'Preview is not allowed for this account or library.',preview_invalid:'The file or selected mapping could not be previewed.',preview_too_large:'This file exceeds the preview limits.',preview_capacity_unavailable:'Preview is not available on this server.',preview_busy:'Preview is busy. Try again later.',preview_unavailable:'Preview is temporarily unavailable.',preview_stale_context:'The account or library changed. Reopen preview.'});
const safeError=value=>value && value.protocol==='foobar_preview_v1' && Object.keys(value).length===2 && Object.hasOwn(messages,value.error)?messages[value.error]:'The preview request could not be completed.';

export function createPreviewController({fetch,transport,allows,isCurrent,onChange}) {
  let generation=0,abort=null,timer=null,file=null,disposed=false,retired=false;
  let expected=null,contextGeneration=null,unsubscribe=null;
  let value=Object.freeze({phase:'checking',filename:'',page:null,error:'',available:false});
  const publish=patch=>{value=Object.freeze({...value,...patch});onChange(value);};
  const cancelRequest=()=>{generation++;abort?.abort();abort=null;clearTimeout(timer);timer=null;};
  function retire() {
    if(disposed || retired)return;
    retired=true;cancelRequest();file=null;
    publish({phase:'retired',filename:'',page:null,available:false,error:'The account or library changed. Reopen preview.'});
  }
  const sameContext=()=>{
    try{return !disposed && !retired && expected!==null && transport.peekGeneration()===contextGeneration && transport.context()===expected && !retired;}
    catch{return false;}
  };
  const current=()=>{
    if(!sameContext()){retire();return false;}
    if(allows('library.browse.read')!==true){
      if(value.phase!=='denied'){cancelRequest();file=null;publish({phase:'denied',filename:'',page:null,error:'Preview is not allowed for this account or library.',available:false});}
      return false;
    }
    return !disposed && !retired && isCurrent();
  };
  const revoke=()=>{
    // The genuine owner retires every subscriber in this context generation.
    try{transport.invalidate();}catch{/* Retirement precedes notifications. */}
    retire();
  };
  async function request(url,options,validate,capabilityCheck=false) {
    cancelRequest();
    if(!current())return;
    const token=generation,controller=new AbortController();abort=controller;
    timer=setTimeout(()=>controller.abort(),60000);
    const live=()=>generation===token && current();
    let transient=true;
    try{
      const response=await fetch(url,{...options,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{Accept:'application/json','X-AlbumHaven-Context':expected,...options.headers}});
      transient=false;
      // Consumed denial belongs to its context even if a newer form superseded it.
      if(response.status===401 || response.status===403){if(sameContext())revoke();return;}
      if(!live())return;
      const body=await readBoundedJSON(response,controller.signal);
      if(!live())return;
      if(!response.ok){
        if(body?.error==='preview_stale_context' || body?.error==='stale_context'){revoke();return;}
        transient=response.status===503 && body?.protocol==='foobar_preview_v1' && Object.keys(body).length===2 && ['preview_busy','preview_unavailable'].includes(body.error);
        throw new Error(safeError(body));
      }
      // First capability response and every page require actual shell membership.
      transport.accept(body,expected);
      if(!live())return;
      const result=validate(body,expected);
      if(live())return result;
    }catch(error){
      if(live())publish({phase:capabilityCheck && (transient || error instanceof PreviewBodyInterruptedError || controller.signal.aborted)?'capability-error':'error',page:null,error:controller.signal.aborted?'Preview timed out. You can try again.':(Object.values(messages).includes(error?.message)?error.message:'The preview request could not be completed.')});
    }finally{
      controller.abort();
      if(generation===token){clearTimeout(timer);timer=null;abort=null;}
    }
  }
  async function checkCapabilities() {
    if(!current())return;
    // Publish synchronously before fetch so repeated explicit clicks cannot overlap.
    publish({phase:'checking',available:false,page:null,error:''});
    const result=await request(CAPABILITIES_URL,{method:'GET'},validateCapabilities,true);
    if(result && current())publish({phase:result.status==='available'?'empty':'unavailable',available:result.status==='available',error:result.status==='available'?'':'Preview is not available on this server.'});
  }
  return Object.freeze({
    getState:()=>value,
    async initialize(){
      if(disposed || retired || expected!==null)return;
      try{
        if(!transport || !['context','accept','generation','peekGeneration','subscribe','invalidate'].every(key=>typeof transport[key]==='function'))throw new Error();
        expected=transport.context();contextGeneration=transport.generation();
        if(!/^[a-f0-9]{64}$/.test(expected) || !Number.isSafeInteger(contextGeneration) || transport.peekGeneration()!==contextGeneration)throw new Error();
        unsubscribe=transport.subscribe(retire);
      }catch{retire();return;}
      await checkCapabilities();
    },
    async retryCapabilities(){
      if(value.phase!=='capability-error' || !current())return;
      await checkCapabilities();
    },
    choose(candidate){
      cancelRequest();file=null;if(!current() || !value.available)return;
      try{file=validateFile(candidate);publish({phase:'selected',filename:file.name,page:null,error:''});}
      catch(error){publish({phase:'error',filename:'',page:null,error:error.message});}
    },
    async preview(offset=0){
      if(!current() || !value.available || !file || value.phase==='loading' || !Number.isSafeInteger(offset) || offset<0 || offset>99999)return;
      const previous=value.page;if(offset!==0 && offset!==previous?.next_offset)return;
      const chosen=file;publish({phase:'loading',page:null,error:''});
      const result=await request(PREVIEW_URL+'?offset='+offset,{method:'POST',headers:{'Content-Type':'text/tab-separated-values; charset=utf-8','X-Album-Haven-Foobar-Bytes':String(chosen.size)},body:chosen},body=>validatePage(body,offset,expected));
      if(!result || !current() || file!==chosen)return;
      if(previous && offset!==0 && (previous.source_sha256!==result.source_sha256 || previous.inventory_revision!==result.inventory_revision || previous.total_rows!==result.total_rows)){
        publish({phase:'error',page:null,error:'The file or library changed. Start a new preview.'});return;
      }
      publish({phase:'ready',page:result,error:''});
    },
    clear(){cancelRequest();file=null;if(!retired)publish({phase:value.available?'empty':'unavailable',filename:'',page:null,error:''});},
    dispose(){cancelRequest();file=null;disposed=true;unsubscribe?.();unsubscribe=null;value=Object.freeze({phase:'disposed',filename:'',page:null,error:'',available:false});},
  });
}
