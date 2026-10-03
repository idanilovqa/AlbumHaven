/** Isolated fictional global popularity and native track-love presentation. */
import {albums} from './fixture-data.mjs';
const tracks=albums.flatMap(album=>album.tracks.map(track=>({album,track})));
export function trackPopularity(path){const index=tracks.findIndex(item=>item.track.path===path);return index<0?null:12400+(index+1)*9137+((index*7919)%87000);}
export function albumPopularity(album){const values=(album?.tracks||[]).map(track=>trackPopularity(track.path));return values.length&&values.every(Number.isFinite)?values.reduce((sum,value)=>sum+value,0):null;}
export function artistPopularity(artist){const rows=albums.filter(album=>album.mock.artist_id===artist?.id||album.album_artist===artist?.name);return rows.length?rows.reduce((sum,album)=>sum+(albumPopularity(album)||0),0):null;}
const heart='M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z';
const flame='M12 1c2 4 5 4 4 9 2-1 3-3 3-5 4 5 5 9 2 14-2 3-5 4-9 4S5 22 3 19C0 14 3 10 6 7c-1 3 0 5 2 6-1-5 4-6 4-12Z';
const innerFlame='M12 5c1 4 5 5 3 10 2-1 3-3 3-5 4 6 1 11-6 11-6 0-9-5-5-10 0 3 1 4 3 5-1-4 2-6 2-11Z';
export const LOVE_BREAK_DURATION_MS=400;

/** Transient paint only. The playlist controller remains the sole affection owner. */
export function createLoveFeedback({clock={now:Date.now,setTimeout,clearTimeout}}={}){
  const pending=new Map(),listeners=new Set();let serial=0;
  const notify=path=>{for(const listener of [...listeners])listener(path);};
  const cancel=path=>{const entry=pending.get(path);if(!entry)return;clock.clearTimeout(entry.timer);pending.delete(path);notify(path);};
  return {
    begin(path){
      if(pending.has(path))return pending.get(path);
      const entry={token:String(++serial),startedAt:clock.now(),timer:null};
      pending.set(path,entry);
      entry.timer=clock.setTimeout(()=>{if(pending.get(path)!==entry)return;pending.delete(path);notify(path);},LOVE_BREAK_DURATION_MS);
      notify(path);return entry;
    },
    cancel,
    get(path){const entry=pending.get(path);return entry?{token:entry.token,elapsed:Math.max(0,clock.now()-entry.startedAt)}:null;},
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){for(const entry of pending.values())clock.clearTimeout(entry.timer);pending.clear();listeners.clear();},
  };
}
export const loveFeedback=createLoveFeedback();

const escapeLoveText=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function loveIcon(love,breaking=false){
  return `<svg viewBox="0 0 24 24" focusable="false">${love==='obsessed'?`<g transform="translate(-4 -10.666667) scale(1.333333)"><path class="mock-love-flame" d="${flame}"/><path class="mock-love-flame-core" d="${innerFlame}"/></g>`:''}<path class="mock-heart-outline" d="${heart}"/>${breaking?`<g class="mock-heart-break-half mock-heart-break-left"><path d="${heart}"/></g><g class="mock-heart-break-half mock-heart-break-right"><path d="${heart}"/></g>`:''}</svg>`;
}

/** Read-only statistic. No button, pressed state, tabindex or mutation hook. */
export function loveIndicator(path,love,{userId,userName}){
  const title=tracks.find(item=>item.track.path===path)?.track.title||'track';
  const state=['none','loved','obsessed'].includes(love)?love:'unknown';
  const description=`${userName}: ${state==='none'?'Not loved':state==='loved'?'Loved':state==='obsessed'?'Obsessed':'Love status unavailable'} · ${title}`;
  return `<span class="mock-track-love mock-track-love-indicator" role="img" aria-label="${escapeLoveText(description)}" title="${escapeLoveText(description)}" data-comparison-affection-user="${escapeLoveText(userId)}" data-comparison-affection-track="${escapeLoveText(path)}" data-love-state="${state}"><span aria-hidden="true">${state==='unknown'?'—':loveIcon(state)}</span></span>`;
}

export function loveControl(path,love='none',buttons=window.ButtonComponent,feedback=loveFeedback){
  const title=tracks.find(item=>item.track.path===path)?.track.title||'track';const next=love==='none'?'Love':love==='loved'?'Mark Obsessed':'Remove love';
  const breaking=love==='none'?feedback.get(path):null;
  const html=buttons.renderActionButton({ariaLabel:`${next}: ${title}`,title:`${love==='none'?'Not loved':love==='loved'?'Loved':'Obsessed'} · ${next}`,presentation:'bare',className:'mock-track-love'+(breaking?' mock-love-breaking':''),attributes:{'data-mock-track-love':path,'data-love-state':love,'aria-pressed':String(love!=='none'),'data-love-feedback':breaking?.token||'',...(breaking?{style:`--mock-love-break-delay:-${breaking.elapsed}ms;--mock-love-break-duration:${LOVE_BREAK_DURATION_MS}ms`}:{})}});
  // Keep the heart's path and anchor identical in every state. Only the flame
  // extends above that anchor; its approved path shapes and proportions stay intact.
  return html.replace('<span class="action-button__icon" aria-hidden="true"></span>',`<span class="action-button__icon" aria-hidden="true">${loveIcon(love,breaking)}</span>`);
}
export function refreshLoveControls(root,getLove,{breakingTrack=null,feedback=loveFeedback}={}){
  if(breakingTrack&&getLove(breakingTrack)==='none')feedback.begin(breakingTrack);
  for(const button of root.querySelectorAll('[data-mock-track-love]')){
    const path=button.dataset.mockTrackLove,template=button.ownerDocument.createElement('div');
    template.innerHTML=loveControl(path,getLove(path),button.ownerDocument.defaultView.ButtonComponent,feedback);const next=template.firstElementChild;
    // Keeping an in-flight SVG avoids restarting it on unrelated model updates.
    if(button.dataset.loveState!==next.dataset.loveState||button.dataset.loveFeedback!==next.dataset.loveFeedback){
      button.innerHTML=next.innerHTML;
      for(const property of ['--mock-love-break-delay','--mock-love-break-duration']){
        const value=next.style.getPropertyValue(property);if(value)button.style.setProperty(property,value);else button.style.removeProperty(property);
      }
    }
    for(const name of ['aria-label','title','data-love-state','aria-pressed','data-love-feedback'])button.setAttribute(name,next.getAttribute(name));
    button.classList.toggle('mock-love-breaking',next.classList.contains('mock-love-breaking'));
  }
}

/** One shared click/subscription owner for Recent, Album, comparison and Playlist. */
export function bindTrackLoveControls({root,controller,feedback=loveFeedback}){
  const doc=root.ownerDocument||root,view=doc.defaultView;
  let previous=controller.getSnapshot(),disposed=false;
  const refresh=()=>{if(!disposed)refreshLoveControls(root,controller.getLove,{feedback});};
  const unsubscribeFeedback=feedback.subscribe(refresh);
  const unsubscribe=controller.subscribe(()=>{
    const next=controller.getSnapshot(),old=previous;previous=next;
    for(const [path,preference] of Object.entries(next.preferences)){
      if(preference.state!=='none')feedback.cancel(path);
      else if(old.preferences[path]?.state&&old.preferences[path].state!=='none')feedback.begin(path);
    }
    refresh();
  });
  const click=event=>{
    const button=event.target.closest?.('[data-mock-track-love]');if(!button||!root.contains(button))return;
    event.preventDefault();event.stopPropagation();
    if(button.closest('[data-mock-playlist-exiting]'))return;
    const path=button.dataset.mockTrackLove;
    // Prepare paint before synchronous model subscribers can replace any rows.
    if(controller.getLove(path)==='obsessed')feedback.begin(path);else feedback.cancel(path);
    controller.cycleLove(path);
  };
  root.addEventListener('click',click);
  const observer=view.MutationObserver?new view.MutationObserver(records=>{
    if(records.some(record=>[...record.addedNodes].some(node=>node.nodeType===1&&(node.matches('[data-mock-track-love]')||node.querySelector('[data-mock-track-love]')))))refresh();
  }):null;
  observer?.observe(root,{childList:true,subtree:true});refresh();
  return()=>{disposed=true;root.removeEventListener('click',click);unsubscribe();unsubscribeFeedback();observer?.disconnect();feedback.dispose();};
}
