import React, {useLayoutEffect, useRef, useState} from 'react';
import {Button} from './components.jsx';

// Same finite UTC range contract as the accepted Tops control, without replacing
// this branch's existing React owner or introducing a native surface bootstrap.
export function historyRange(start, end, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const first=Date.parse(`${start}T00:00:00Z`),last=Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(first)||!Number.isFinite(last)||new Date(first).toISOString().slice(0,10)!==start
    ||new Date(last).toISOString().slice(0,10)!==end)return null;
  const range_start=first/1000,range_end=Math.min(last/1000+86399,Math.floor(now/1000)-60);
  return range_start>=0&&range_end>=range_start&&range_end-range_start<=31*86400?{range_start,range_end}:null;
}
export function LastfmHistoryControls({runtime,context,coverage}) {
  if(coverage?.enabled!==true||context?.account_ref!==null||context?.kind!=='listens')return null;
  return <HistoryOwner key={JSON.stringify([context.scopeKey,context.account_ref,context.kind,context.period])}
    runtime={runtime} context={context} coverage={coverage}/>;
}
function HistoryOwner({runtime,context,coverage}) {
  const [start,setStart]=useState(()=>new Date(Date.now()-6*86400000).toISOString().slice(0,10));
  const [end,setEnd]=useState(()=>new Date().toISOString().slice(0,10));
  const [jobs,setJobs]=useState(()=>runtime.lastfmImportProgress?.(context)||[]);
  const [pending,setPending]=useState(false),[message,setMessage]=useState('');
  const lifetime=useRef({active:true,controller:null,pending:false}),latest=useRef(null);
  latest.current={runtime,context,coverage};
  useLayoutEffect(()=>{
    const owner={active:true,controller:null,pending:false};lifetime.current=owner;
    setPending(false);setMessage('');setJobs(runtime.lastfmImportProgress?.(context)||[]);
    return()=>{owner.active=false;owner.controller?.abort();};
  },[runtime,context]);
  const allowed=coverage.connected===true&&runtime.canImportLastfmHistory?.(context)===true&&!pending;
  async function command(payload) {
    const owner=lifetime.current,held=latest.current;
    if(!owner.active||owner.pending||held.coverage.connected!==true||held.runtime.canImportLastfmHistory?.(held.context)!==true)return;
    owner.pending=true;owner.controller=new AbortController();setPending(true);
    setMessage('Reading history. Closing this view does not undo a committed page.');
    const current=()=>owner.active&&latest.current.runtime===held.runtime
      &&latest.current.context===held.context&&latest.current.coverage.enabled===true;
    try {
      const result=await held.runtime.importLastfmHistory(payload,held.context,owner.controller.signal);
      if(!current())return;
      setJobs(previous=>{
        const ranges=previous.filter(job=>!job.plan),plans=previous.filter(job=>job.plan);
        const next=payload.command==='pending'?[...plans,...result.generations]
          :payload.command==='backfill_pending'?[...ranges,...result.plans]
          :result.plan?[...ranges,...plans.filter(job=>job.plan!==result.plan),result]
          :[...plans,...ranges.filter(job=>job.generation!==result.generation),result];
        return [...next.filter(job=>!job.plan).slice(-4),...next.filter(job=>job.plan).slice(-5)];
      });
      setMessage(['pending','backfill_pending'].includes(payload.command)?'Choose a saved import to continue, if any.'
        :result.plan?(result.state==='observed'?'Requested historical range observed, not an immutable or complete provider snapshot.'
          :result.state==='active'?'Plan saved. Advance one page explicitly when its next permitted time arrives.'
          :'Plan paused, blocked or connection changed. No range was skipped or automatically retried.')
        :result.state==='reading'?'Range saved. Read the next page when ready.'
          :result.state==='complete'?'Observed range imported. Refreshing listening history.'
          :'Import stopped or uncertain; retained observations were not deleted.');
    } catch(error) {
      if(current())setMessage('The outcome may be uncertain. Find unfinished imports before retrying; no automatic retry was made.');
    } finally {
      if(current()){owner.pending=false;owner.controller=null;setPending(false);
        if(!['pending','backfill_pending'].includes(payload.command))held.runtime.refreshLastfmHistory?.(held.context);}
    }
  }
  const button=(label,payload)=><Button key={label} runtime={runtime} disabled={!allowed} onClick={()=>{void command(payload);}}>{label}</Button>;
  return <section aria-label="Last.fm history import">
    <p>Selected-library in-app history plus account-wide Last.fm observations. {({not_imported:'No range has been imported.',disconnected:'Last.fm is disconnected.',binding_unavailable:'The connection identity is unavailable.',partial:'Some ranges are unfinished.',observed_ranges:'Some ranges were observed; this is not complete history.',uncertain:'Provider observations changed or are uncertain.'})[coverage.observation_state]||'Observation coverage is incomplete.'} Remote metadata does not grant local playback. No plays are sent.</p>
    <label>From (UTC) <input type="date" value={start} disabled={pending} onChange={event=>setStart(event.target.value)}/></label>
    <label>Through (UTC) <input type="date" value={end} disabled={pending} onChange={event=>setEnd(event.target.value)}/></label>
    <Button runtime={runtime} disabled={!allowed} onClick={()=>{const range=historyRange(start,end);
      if(!range){setMessage('Choose at most 31 days, ending before the last minute.');return;}void command({command:'begin',...range});}}>Import selected dates</Button>
    {button('Find unfinished imports',{command:'pending'})}
    {button('Start or recover All Time import',{command:'backfill_begin'})}
    {button('Find All Time plans',{command:'backfill_pending'})}
    <div>{jobs.map(job=>job.plan?<p key={job.plan}>
      All Time plan {job.plan.slice(0,8)}: {job.state}, {job.completed_windows} observed windows. Fixed upper cut {new Date(job.upper_cut*1000).toISOString()}; descending cursor {job.cursor_end<0?'range observed':new Date(job.cursor_end*1000).toISOString()}. Next permitted advance {job.next_allowed_at}. Each click reads at most one page. Provider history may change; recent tail and completeness remain unknown.
      {job.reason==='storage_quota'?' Unresolved gap: retained-payload quota reached. Existing observations remain; no storage was allocated or limit increased.'
        :job.reason==='dense_second'?' Dense timestamp continuation: advance finite pages for this same second; no lifetime page cutoff.'
        :job.reason==='range_split'?' Dense range split into smaller windows; history was not skipped.'
        :job.state==='blocked'?' This range remains unresolved. Absence is not proof of no history.':''}
      {(job.state==='active'?[['Read next All Time page','backfill_advance'],['Pause All Time import','backfill_pause']]
        :['paused','blocked'].includes(job.state)?[['Resume same All Time range','backfill_resume']]:[])
        .map(([label,action])=>button(label,{command:action,plan:job.plan,revision:job.revision}))}
    </p>:<p key={job.generation}>Import {job.generation.slice(0,8)}: {job.state}{job.next_page?`, next page ${job.next_page}`:''}.
      {job.state==='reading'&&[['Read next page','advance'],['Stop this import','abandon']].map(([label,action])=>button(label,
        {command:action,generation:job.generation,...(action==='advance'?{page:job.next_page}:{})}))}
    </p>)}</div><p role="status" aria-live="polite">{message}</p>
  </section>;
}
