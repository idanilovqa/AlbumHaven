import {comparisonDirection} from './listening-model.mjs';
import {albums} from './fixture-data.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shown=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function comparisonMetrics(pair,kind,friend,factor){
  const record=pair.left||pair.right;
  const count=(row,who)=>{
    if(row)return row.count;
    const sources=kind==='artists'?albums.filter(album=>album.mock.artist_id===record.id):[record.album];
    if(!sources.length||!sources.every(album=>shown(album.mock.counts[who])))return undefined;
    const total=sources.reduce((sum,album)=>sum+album.mock.counts[who],0);
    if(kind!=='tracks')return total*factor;
    const index=record.album.tracks.findIndex(track=>track.path===record.id);if(index<0)return undefined;
    return(Math.floor(total/record.album.tracks.length)+(index<total%record.album.tracks.length?1:0))*factor;
  };
  const track={key:'track',label:'Track listens',left:count(pair.left,'me'),right:count(pair.right,friend)};
  if(kind!=='albums')return[track];
  const full=who=>{const value=record.album.mock.full[who];return value==null?value:shown(value)?value*factor:undefined;};
  return[{key:'full',label:'Full listens',left:full('me'),right:full(friend)},track];
}
export function comparisonSign(metric,friend){
  const direction=comparisonDirection(metric.left,metric.right),symbol=direction==null?'—':direction>0?'&gt;':direction<0?'&lt;':'=';
  const text=direction==null?`${metric.label}: comparison unavailable because a count is missing or unknown`:`${metric.label}: Yours ${metric.left}, ${friend} ${metric.right}; Yours is ${direction>0?'higher':direction<0?'lower':'equal'}`;
  return `<span class="mock-comparison-sign" data-relation="${direction==null?'missing':direction>0?'greater':direction<0?'less':'equal'}" role="img" aria-label="${escape(text)}">${symbol}</span>`;
}
export function sortHeading(label,key,sort,ascending){
  const active=sort===key,arrow=active?(ascending?'↑':'↓'):'↕';
  return window.ButtonComponent.renderButton({label:`${label} ${arrow}`,quiet:true,size:'small',className:'mock-sort-heading',
    ariaLabel:`Sort by ${label}${active?`, ${ascending?'ascending':'descending'}`:''}`,attributes:{'data-mock-sort':key,'aria-pressed':String(active)}});
}
function metricValues(metrics,side){
  return metrics.map(metric=>`<span class="mock-paired-value${shown(metric[side])?'':' mock-missing-value'}" data-metric="${metric.key}"><span>${shown(metric[side])?metric[side]:'—'}</span>${metrics.length>1?`<small>${metric.label}</small>`:''}</span>`).join('');
}

// Decorate actual native rows; identity, art, playback and Gallery metadata
// remain with AlbumTrackTable, the artist table and GalleryCard renderers.
export function sharedComparisonTable({kind,pairs,person,factor,view,sort,ascending},owners){
  const id='mock-shared-'+kind,rows=pairs.map(pair=>({... (pair.left||pair.right)}));
  const host=document.createElement('div');
  host.innerHTML=kind==='tracks'?owners.playTable({id,rows,artwork:true,label:`Your and ${person.name}'s track listens`})
    :kind==='artists'?owners.artistTable({id,rows,label:`Your and ${person.name}'s artist listens`})
    :owners.table({id,ariaLabel:`Your and ${person.name}'s album listens`,columns:'minmax(140px,1fr) 52px',columnsConfig:[{key:'album',label:'Album'},{key:'count',label:'Count'}],rows:rows.map(row=>({key:row.id,cells:{album:{content:owners.card(row.album,view)},count:{content:'0'}}}))});
  const table=host.querySelector('.compact-data-table');table.classList.add('mock-shared-comparison');table.dataset.comparisonKind=kind;table.dataset.comparisonView=view;
  const indexed=new Map(pairs.map(pair=>[pair.id,pair]));
  for(const row of table.querySelectorAll('[role=row]')){
    const left=row.querySelector('[data-cdt-column=count]');if(!left)continue;
    const header=left.getAttribute('role')==='columnheader';
    const sign=document.createElement('div'),right=document.createElement('div');
    left.dataset.cdtColumn='yours';sign.dataset.cdtColumn='comparison';right.dataset.cdtColumn='friend';
    sign.className='mock-comparison-signs';right.className='mock-count-cell';
    for(const cell of [sign,right])cell.setAttribute('role',header?'columnheader':'cell');
    if(header){
      left.id=table.id+'-yours';sign.id=table.id+'-comparison';right.id=table.id+'-friend';
      sign.setAttribute('aria-label','Comparison');
      for(const [cell,label,key] of [[left,'Yours','yours'],[right,person.name,'friend']]){
        cell.innerHTML=sortHeading(label,key,sort,ascending);cell.setAttribute('aria-sort',sort===key?(ascending?'ascending':'descending'):'none');
      }
    }else{
      const pair=indexed.get(row.dataset.trackRowPath||row.dataset.cdtRowKey);if(!pair)continue;
      const metrics=comparisonMetrics(pair,kind,person.id,factor);
      left.innerHTML=metricValues(metrics,'left');right.innerHTML=metricValues(metrics,'right');
      sign.innerHTML=metrics.map(metric=>comparisonSign(metric,person.name)).join('');
      for(const [cell,key] of [[left,'yours'],[sign,'comparison'],[right,'friend']])cell.setAttribute('aria-labelledby',table.id+'-'+key);
    }
    left.after(sign,right);
  }
  return host.innerHTML;
}

export function annotateComparisonBoundary(html,pairs,kind,person,factor){
  const host=document.createElement('div');host.innerHTML=html;
  const indexed=new Map(pairs.map(pair=>[pair.id,pair]));
  for(const row of host.querySelectorAll('[data-track-row-path],[data-cdt-row-key]')){
    const pair=indexed.get(row.dataset.trackRowPath||row.dataset.cdtRowKey);if(!pair)continue;
    const marker=document.createElement('span');marker.className='mock-boundary-comparison';
    marker.innerHTML=comparisonMetrics(pair,kind,person.id,factor).map(metric=>comparisonSign(metric,person.name)).join('');(row.querySelector('[data-cdt-column=count]')||row.lastElementChild).append(marker);
  }
  return host.innerHTML;
}
