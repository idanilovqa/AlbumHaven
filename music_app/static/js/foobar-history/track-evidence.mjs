const PROTOCOL='foobar_account_track_evidence_v1';
const URL='/integrations/foobar/account/history/native/evidence';
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const decimal=(v,zero=false)=>typeof v==='string'&&(zero?/^(0|[1-9]\d{0,18})$/:/^[1-9]\d{0,18}$/).test(v)&&BigInt(v)<=9223372036854775807n;
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const hex=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const key=item=>item.source_ref+':'+item.observation_ref;
const REASONS=Object.freeze({local_timestamp_vector_unavailable:'The local timestamp vector is unavailable.',invalid_count:'The imported count is invalid.',count_unavailable:'No usable count was supplied.',zero_count_with_boundaries:'A zero count conflicts with supplied dates.',boundary_order_conflict:'First and last dates conflict.',single_count_boundary_conflict:'One reported play has conflicting first and last dates.'});
const invalid=()=>new Error('Imported evidence could not be verified. Refresh to try again.');
const semantics=item=>{
  if(item.evidence_kind==='enhanced_store')return (
    item.count_state==='valid'&&item.count!==null&&BigInt(item.count)<=32766n&&item.status==='ready'&&item.reason===null
    ||item.count_state==='unavailable'&&item.count===null&&item.status==='unavailable'&&item.reason==='local_timestamp_vector_unavailable');
  if(item.count_state!=='valid')return item.count===null&&(
    item.count_state==='invalid'&&item.status==='needs_reconciliation'&&item.reason==='invalid_count'
    ||['absent','empty','unavailable'].includes(item.count_state)&&item.status==='unavailable'&&item.reason==='count_unavailable');
  if(item.count===null)return false;
  if(item.status==='ready')return item.reason===null;
  if(item.status!=='needs_reconciliation')return false;
  return item.reason==='zero_count_with_boundaries'&&item.count==='0'
    ||item.reason==='boundary_order_conflict'&&BigInt(item.count)>0n
    ||item.reason==='single_count_boundary_conflict'&&item.count==='1';
};
export function validateTrackEvidence(value,{context,accountId,libraryId,trackId,family,cursor}){
  if(!exact(value,['protocol','context_ref','result'])||value.protocol!==PROTOCOL||value.context_ref!==context)throw invalid();
  const r=value.result;
  if(!exact(r,['track_id','family','items','next_cursor','consistency'])||r.track_id!==trackId||r.family!==family
    ||r.consistency!=='current_page_refresh_to_restart'||!Array.isArray(r.items)||r.items.length>20)throw invalid();
  let previous=cursor?key(cursor):null;
  for(const item of r.items){
    if(!exact(item,['source_ref','source_created_at','observation_ref','source_revision','association_version','evidence_kind','count_state','count','status','reason'])
      ||!uuid(item.source_ref)||!uuid(item.observation_ref)||!decimal(item.source_revision)||!decimal(item.association_version)
      ||typeof item.source_created_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(item.source_created_at)
      ||!['tsv_snapshot','enhanced_store'].includes(item.evidence_kind)
      ||!['valid','invalid','unavailable','absent','empty'].includes(item.count_state)
      ||!['ready','unavailable','needs_reconciliation'].includes(item.status)
      ||!(item.count===null||decimal(item.count,true))
      ||!(item.reason===null||['local_timestamp_vector_unavailable','invalid_count','count_unavailable','zero_count_with_boundaries','boundary_order_conflict','single_count_boundary_conflict'].includes(item.reason)))throw invalid();
    if(!semantics(item))throw invalid();
    if(previous!==null&&key(item)<=previous)throw invalid();previous=key(item);
  }
  const c=r.next_cursor;
  if(c!==null&&(!exact(c,['account_id','library_id','track_id','track_sha256','family','source_ref','observation_ref'])
    ||c.account_id!==accountId||c.library_id!==libraryId||c.track_id!==trackId||c.family!==family||!hex(c.track_sha256)
    ||!uuid(c.source_ref)||!uuid(c.observation_ref)||r.items.length!==20||key(c)!==previous
    ||cursor&&c.track_sha256!==cursor.track_sha256))throw invalid();
  return r;
}

export function mountFoobarTrackEvidence(host,{transport,isCurrent,trackId,libraryId,accountId}){
  if(!host?.ownerDocument||typeof transport?.request!=='function'||typeof transport?.context!=='function'
    ||typeof transport?.generation!=='function'||typeof transport?.subscribe!=='function'||typeof isCurrent!=='function'
    ||![trackId,libraryId,accountId].every(v=>decimal(v)))throw invalid();
  const document=host.ownerDocument,context=transport.context(),generation=transport.generation();
  let disposed=false,pending=null,sequence=0,page=null,family='standard',release=null;
  const listen=[];
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;host.append(n);return n;};
  host.setAttribute('role','region');host.setAttribute('aria-label','Foobar imported track evidence');
  const heading=node('h4','Foobar imported evidence');heading.tabIndex=-1;
  node('p','Source-specific reported evidence for this library track. Values are never added to Last.fm or Album Haven listening, or summed across sources.');
  const label=node('label','TSV count family '),select=document.createElement('select');label.append(select);
  for(const [value,text] of [['standard','Standard'],['enhanced','Enhanced']]){const o=document.createElement('option');o.value=value;o.textContent=text;select.append(o);}
  node('p','Enhanced database counts mean reported local timestamp entries, not lifetime plays or measured Full listens. Cached Last.fm entries are excluded.');
  const status=node('p','Choose Load evidence.'),error=node('p','');status.setAttribute('role','status');error.setAttribute('role','alert');error.hidden=true;
  const items=node('div'),load=node('button','Load evidence'),next=node('button','More sources'),close=node('button','Close evidence');
  for(const b of [load,next,close])b.type='button';next.disabled=true;
  const current=()=>{try{return !disposed&&host.isConnected&&isCurrent()===true&&transport.context()===context&&transport.generation()===generation;}catch{return false;}};
  function cancel(){sequence++;pending?.abort();pending=null;}
  function dispose(){if(disposed)return;disposed=true;cancel();release?.();for(const [n,e,f]of listen)n.removeEventListener(e,f);host.replaceChildren();host.remove();}
  function bind(n,e,f){n.addEventListener(e,f);listen.push([n,e,f]);}
  function paint(result){
    items.replaceChildren();
    for(const item of result.items){
      const section=document.createElement('section'),title=document.createElement('h5'),value=document.createElement('p'),provenance=document.createElement('p');
      title.textContent='Source created '+item.source_created_at+' · '+item.source_ref;
      const category=item.evidence_kind==='enhanced_store'?'Reported local timestamp entries':(family==='standard'?'Standard':'Enhanced')+' TSV reported plays';
      value.textContent=category+': '+(item.count===null?'Unavailable':item.count)+(item.status==='needs_reconciliation'?' (conflicting source evidence; requires reconciliation)':'');
      if(item.reason)value.textContent+=' '+REASONS[item.reason];
      provenance.textContent='Observation '+item.observation_ref+' · source revision '+item.source_revision+' · association decision '+item.association_version;
      section.append(title,value,provenance);items.append(section);
    }
    status.textContent=result.items.length?(result.next_cursor?'Showing '+result.items.length+' source observations. More are available.':'End of current source observations.'):'No currently matched Foobar source evidence.';
    status.textContent+=' Each page is a current read. Refresh from the beginning after imports or match changes.';
    next.disabled=!result.next_cursor;
  }
  async function read(cursor){
    if(!current()||pending)return;
    cancel();const token=sequence,abort=new AbortController();pending=abort;
    load.disabled=next.disabled=select.disabled=true;error.hidden=true;status.textContent='Reading source evidence…';
    const timer=setTimeout(()=>abort.abort(),30000);
    try{
      const value=await transport.request(URL,{method:'POST',body:{version:PROTOCOL,track_id:trackId,family,cursor},signal:abort.signal,isCurrent:()=>current()&&sequence===token});
      if(!current()||sequence!==token||abort.signal.aborted)return;
      const result=validateTrackEvidence(value,{context,accountId,libraryId,trackId,family,cursor});
      page=result;paint(result);load.textContent='Refresh from beginning';
    }catch(e){if(current()&&sequence===token){error.textContent='Evidence is unavailable or changed. Refresh from the beginning; no totals were inferred.';error.hidden=false;status.textContent='Previous page is not evidence of current completeness.';page=null;}}
    finally{clearTimeout(timer);if(pending===abort)pending=null;if(current()&&sequence===token){load.disabled=select.disabled=false;next.disabled=!page?.next_cursor;}abort.abort();}
  }
  bind(load,'click',()=>void read(null));bind(next,'click',()=>{if(page?.next_cursor)void read(page.next_cursor);});
  bind(select,'change',()=>{cancel();family=select.value;page=null;items.replaceChildren();status.textContent='Count family changed. Load evidence to review this family.';load.disabled=select.disabled=false;next.disabled=true;});
  bind(close,'click',dispose);release=transport.subscribe(()=>{if(!current())dispose();});
  return Object.freeze({dispose,load:()=>read(null),focus:()=>{if(current())heading.focus();}});
}
