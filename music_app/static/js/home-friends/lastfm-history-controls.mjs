import {mountButton} from './native-controls.mjs';
// Explicit, finite provider reads. One click advances one page; never sends plays.
export function historyRange(start, end, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const first = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last)
    || new Date(first).toISOString().slice(0,10) !== start || new Date(last).toISOString().slice(0,10) !== end) return null;
  const range_start = first / 1000, range_end = Math.min(last / 1000 + 86399, Math.floor(now / 1000) - 60);
  return range_start >= 0 && range_end >= range_start && range_end - range_start <= 31 * 86400
    ? {range_start,range_end} : null;
}
export function mountLastfmHistoryControls(host, runtime) {
  let context = null, coverage = null, key = null, jobs = [], pending = false, disposed = false, revision = 0, controller = null;
  const document = host.ownerDocument;
  const node = (tag,text) => {const item = document.createElement(tag); if (text) item.textContent = text; host.append(item); return item;};
  const note = node('p'), startLabel = node('label','From (UTC) '), start = document.createElement('input'); start.type='date'; startLabel.append(start);
  const endLabel = node('label','Through (UTC) '), end = document.createElement('input'); end.type='date'; endLabel.append(end);
  const today = new Date().toISOString().slice(0,10); end.value=today;
  start.value = new Date(Date.now()-6*86400000).toISOString().slice(0,10);
  const owners = [], jobOwners = [];
  const button = (label, callback) => {const owner=mountButton(node('span'),runtime,{label,onClick:callback});owners.push(owner);
    return {set disabled(disabled){owner.update({label,onClick:callback,disabled});}};};
  const begin = button('Import selected dates', () => {const range=historyRange(start.value,end.value); if (!range) {message.textContent='Choose at most 31 days, ending before the last minute.';return;} void command({command:'begin',...range});});
  const recover = button('Find unfinished imports', () => {void command({command:'pending'});});
  const allTime = button('Start or recover All Time import', () => {void command({command:'backfill_begin'});});
  const recoverPlans = button('Find All Time plans', () => {void command({command:'backfill_pending'});});
  const list=node('div'), message=node('p'); message.setAttribute('role','status'); message.setAttribute('aria-live','polite');
  function paint() {
    if (disposed) return;
    host.hidden = !coverage?.enabled || context?.account_ref !== null || context?.kind !== 'listens';
    note.textContent = `Selected-library in-app history plus account-wide Last.fm observations. ${({not_imported:'No range has been imported.',disconnected:'Last.fm is disconnected.',binding_unavailable:'The connection identity is unavailable.',partial:'Some ranges are unfinished.',observed_ranges:'Some ranges were observed; this is not complete history.',uncertain:'Provider observations changed or are uncertain.'})[coverage?.observation_state] || 'Observation coverage is incomplete.'} Remote metadata does not grant local playback. No plays are sent.`;
    const allowed = !host.hidden && coverage.connected === true && runtime.canImportLastfmHistory?.(context) === true && !pending;
    begin.disabled = !allowed; recover.disabled = !allowed; allTime.disabled = !allowed; recoverPlans.disabled = !allowed; start.disabled=pending;end.disabled=pending;
    for(const owner of jobOwners.splice(0)) owner.dispose();
    list.replaceChildren();
    for (const job of jobs) {
      if (job.plan) {
        const line=document.createElement('p');
        line.textContent=`All Time plan ${job.plan.slice(0,8)}: ${job.state}, ${job.completed_windows} observed windows. Fixed upper cut ${new Date(job.upper_cut*1000).toISOString()}; descending cursor ${job.cursor_end < 0 ? 'range observed' : new Date(job.cursor_end*1000).toISOString()}. Next permitted advance ${job.next_allowed_at}. Each click reads at most one page. Provider history may change; recent tail and completeness remain unknown. `;
        if (job.reason === 'single_second_over_budget') line.textContent += 'Unresolved gap: one timestamp second exceeds the supported whole-bucket budget. Previously retained observations were not deleted; this range and plan are not complete. ';
        else if (job.reason === 'dense_second') line.textContent += 'Dense timestamp continuation: keep advancing finite pages for this same second; no lifetime page cutoff is implied. ';
        else if (job.reason === 'storage_quota') line.textContent += 'Unresolved gap: this account reached its configured retained-payload quota. Existing observations remain; no storage was automatically allocated or limit increased. ';
        else if (job.reason === 'range_split') line.textContent += 'Dense range split into smaller windows; the cursor has not skipped history. ';
        else if (job.state === 'blocked') line.textContent += 'This range remains unresolved. Resume re-observes it; absence is not proof of no history. ';
        const actions=job.state === 'active' ? [['Read next All Time page','backfill_advance'],['Pause All Time import','backfill_pause']]
          : ['paused','blocked'].includes(job.state) ? [['Resume same All Time range','backfill_resume']] : [];
        for (const [label,action] of actions) {
          const control=document.createElement('span');line.append(control);
          jobOwners.push(mountButton(control,runtime,{label,disabled:!allowed,onClick:()=>{
            void command({command:action,plan:job.plan,revision:job.revision});}}));
        }
        list.append(line);continue;
      }
      const line=document.createElement('p');line.textContent=`Import ${job.generation.slice(0,8)}: ${job.state}${job.next_page ? `, next page ${job.next_page}` : ''}. `;
      if (job.state === 'reading') for (const [label,action] of [['Read next page','advance'],['Stop this import','abandon']]) {
        const control=document.createElement('span');line.append(control);
        jobOwners.push(mountButton(control,runtime,{label,disabled:!allowed,onClick:()=>{void command({command:action,generation:job.generation,...(action==='advance'?{page:job.next_page}:{})});}}));
      }
      list.append(line);
    }
  }
  async function command(payload) {
    if (disposed || pending || !coverage?.connected || runtime.canImportLastfmHistory?.(context) !== true) return;
    const owned=revision, ownedContext=context; pending=true; controller=new AbortController(); message.textContent='Reading history. Closing this view does not undo a committed page.';paint();
    try {
      const result=await runtime.importLastfmHistory(payload,ownedContext,controller.signal);
      if (disposed || revision!==owned) return;
      const ranges=jobs.filter(job=>!job.plan),plans=jobs.filter(job=>job.plan);
      jobs=payload.command==='pending'?[...plans,...result.generations]
        :payload.command==='backfill_pending'?[...ranges,...result.plans]
        :result.plan?[...ranges,...plans.filter(job=>job.plan!==result.plan),result]
        :[...plans,...ranges.filter(job=>job.generation!==result.generation),result];
      jobs=[...jobs.filter(job=>!job.plan).slice(-4),...jobs.filter(job=>job.plan).slice(-5)];
      message.textContent=payload.command==='pending'||payload.command==='backfill_pending'
        ? (jobs.length?'Choose a saved import to continue.':'No saved imports.')
        :result.plan ? (result.state==='observed'?'Requested historical range observed, not an immutable or complete provider snapshot.'
          :result.state==='active'?'Plan saved. Advance one page explicitly when its next permitted time arrives.'
          :'Plan paused, blocked or connection changed. No range was skipped or automatically retried.')
        :result.state==='reading'?'Range saved. Read the next page when ready.':result.state==='complete'?'Observed range imported. Refreshing listening history.':'Import stopped or uncertain; retained observations were not deleted.';
    } catch (error) {
      if (!disposed && revision===owned) message.textContent='The outcome may be uncertain. Find unfinished imports before retrying; no automatic retry was made.';
    } finally {
      if (!disposed && revision===owned) {pending=false;controller=null;paint();if(!['pending','backfill_pending'].includes(payload.command))runtime.refreshLastfmHistory?.(ownedContext);}
    }
  }
  return {update(next) {
    if(disposed)return;
    const nextKey=JSON.stringify([next.context?.scopeKey,next.context?.account_ref,next.context?.kind,next.context?.period]);
    if(nextKey!==key){revision++;controller?.abort();controller=null;pending=false;jobs=[];message.textContent='';key=nextKey;}
    context=next.context;coverage=next.coverage;
    if(coverage?.enabled !== true || context?.account_ref !== null || context?.kind !== 'listens') {
      revision++;controller?.abort();controller=null;pending=false;jobs=[];message.textContent='';
    }
    if(coverage?.enabled === true && context?.account_ref === null && context?.kind === 'listens' && !pending && jobs.length===0) jobs=runtime.lastfmImportProgress?.(context) || [];
    paint();
  },dispose(){if(disposed)return;disposed=true;revision++;controller?.abort();for(const owner of [...owners,...jobOwners])owner.dispose();host.replaceChildren();}};
}
