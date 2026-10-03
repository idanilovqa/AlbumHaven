/** Isolated fictional global popularity and native track-love presentation. */
import {albums} from './fixture-data.mjs';
const tracks=albums.flatMap(album=>album.tracks.map(track=>({album,track})));
export function trackPopularity(path){const index=tracks.findIndex(item=>item.track.path===path);return index<0?null:12400+(index+1)*9137+((index*7919)%87000);}
export function albumPopularity(album){const values=(album?.tracks||[]).map(track=>trackPopularity(track.path));return values.length&&values.every(Number.isFinite)?values.reduce((sum,value)=>sum+value,0):null;}
export function artistPopularity(artist){const rows=albums.filter(album=>album.mock.artist_id===artist?.id||album.album_artist===artist?.name);return rows.length?rows.reduce((sum,album)=>sum+(albumPopularity(album)||0),0):null;}
const heart='M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z';
const flame='M15 2c1 3-2 4-1 6 1-1 2-1 2-3 3 3 4 6 1 8-2 1-5-1-4-4-1 0-1 1-1 2-3-4 1-5 3-9Z';
export function loveControl(path,love='none',buttons=window.ButtonComponent){
  const title=tracks.find(item=>item.track.path===path)?.track.title||'track';const next=love==='none'?'Love':love==='loved'?'Mark Obsessed':'Remove love';
  const html=buttons.renderActionButton({ariaLabel:`${next}: ${title}`,title:`${love==='none'?'Not loved':love==='loved'?'Loved':'Obsessed'} · ${next}`,presentation:'bare',className:'mock-track-love',attributes:{'data-mock-track-love':path,'data-love-state':love,'aria-pressed':String(love!=='none')}});
  return html.replace('<span class="action-button__icon" aria-hidden="true"></span>',`<span class="action-button__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path class="mock-heart-outline" d="${heart}"/>${love==='obsessed'?`<path class="mock-love-flame" d="${flame}"/>`:''}</svg></span>`);
}
export function refreshLoveControls(root,getLove,{breakingTrack=null}={}){
  for(const button of root.querySelectorAll('[data-mock-track-love]')){
    const path=button.dataset.mockTrackLove,template=document.createElement('div');template.innerHTML=loveControl(path,getLove(path));const next=template.firstElementChild;
    button.innerHTML=next.innerHTML;for(const name of ['aria-label','title','data-love-state','aria-pressed'])button.setAttribute(name,next.getAttribute(name));
    if(path===breakingTrack&&!matchMedia('(prefers-reduced-motion: reduce)').matches){button.classList.add('mock-love-breaking');setTimeout(()=>button.classList.remove('mock-love-breaking'),400);}
  }
}
