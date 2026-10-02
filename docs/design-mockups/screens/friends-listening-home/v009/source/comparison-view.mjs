import {comparisonDirection} from './listening-model.mjs';
import {albums} from './fixture-data.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const isKnownComparisonNumber=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const shown=isKnownComparisonNumber;

// Explicitly fictional presentation data. The source album preference belongs to
// Alex only; never repeat it as another person's rating. An absent key or null
// is unknown/unrated, while an explicit zero remains a numeric zero.
export const comparisonRatingFixtures=Object.freeze({
  maya:Object.freeze({a1:9,a2:8,a4:8,a5:7,a6:null}),
  sam:Object.freeze({a1:7,a3:9,a4:null,a5:6,a7:0}),
  noor:Object.freeze({a1:7,a2:8,a4:9,a6:8}),
  theo:Object.freeze({a1:8,a3:null}),
});
export function comparisonRating(album,person){
  const value=person==='me'?album?.album_preference?.rating:comparisonRatingFixtures[person]?.[album?.id];
  return shown(value)&&value<=10?value:undefined;
}

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
  const track={key:'track',label:kind==='albums'?'Track listens':'Plays',left:count(pair.left,'me'),right:count(pair.right,friend)};
  if(kind!=='albums')return[track];
  const full=who=>{const value=record.album.mock.full[who];return value==null?value:shown(value)?value*factor:undefined;};
  return[{key:'full',label:'Full listens',left:full('me'),right:full(friend)},track];
}

export function comparisonSign(metric,friend){
  const direction=comparisonDirection(metric.left,metric.right),symbol=direction==null?'—':direction>0?'&gt;':direction<0?'&lt;':'=';
  const text=direction==null?`${metric.label}: comparison unavailable because a count is missing or unknown`:`${metric.label}: Yours ${metric.left}, ${friend} ${metric.right}; Yours is ${direction>0?'higher':direction<0?'lower':'equal'}`;
  // Descriptive joined marker: no button, tabindex, click handler or action role.
  return `<span class="mock-comparison-sign mock-comparison-joined" data-relation="${direction==null?'missing':direction>0?'greater':direction<0?'less':'equal'}" role="img" aria-label="${escape(text)}"><span aria-hidden="true">${symbol}</span></span>`;
}
export function sortHeading(label,key,sort,ascending){
  const active=sort===key,arrow=active?(ascending?'↑':'↓'):'↕';
  return window.ButtonComponent.renderButton({label:`${label} ${arrow}`,quiet:true,size:'small',className:'mock-sort-heading',
    ariaLabel:`Sort by ${label}${active?`, ${ascending?'ascending':'descending'}`:''}`,attributes:{'data-mock-sort':key,'aria-pressed':String(active)}});
}
function metricValues(metrics,side){
  return metrics.map(metric=>`<span class="mock-paired-value${shown(metric[side])?'':' mock-missing-value'}" data-metric="${metric.key}"><span>${shown(metric[side])?metric[side]:'—'}</span>${metrics.length>1?`<small>${metric.label}</small>`:''}</span>`).join('');
}
function numericRating(album,person){
  const value=comparisonRating(album,person);
  return `<span class="mock-comparison-rating${shown(value)?'':' mock-missing-value'}" data-rating-known="${shown(value)}" aria-label="${shown(value)?`Rating ${value} out of 10`:'Rating unavailable'}">${shown(value)?`${value}<small>/10</small>`:'—'}</span>`;
}
function albumValues(pair,side,person,factor,{indicators=true}={}){
  const album=(pair.left||pair.right).album,who=side==='left'?'me':person.id;
  return `<div class="mock-comparison-album-values" data-metric-side="${side}"><div class="mock-comparison-metric" data-metric="rating"><small>Rating</small>${numericRating(album,who)}</div>${comparisonMetrics(pair,'albums',person.id,factor).map(metric=>`<div class="mock-comparison-metric" data-metric="${metric.key}"><small>${metric.label}</small><span class="mock-comparison-number${shown(metric[side])?'':' mock-missing-value'}">${shown(metric[side])?metric[side]:'—'}</span>${side==='left'&&indicators?comparisonSign(metric,person.name):''}</div>`).join('')}</div>`;
}

// Native GalleryCard owns the artwork and open-album controls. Retain its
// identity slots for compact rows; no source album or fixture is mutated.
export function comparisonAlbumIdentity(album,owners){
  const host=document.createElement('div');host.innerHTML=owners.card(album,'list');
  const card=host.querySelector('.album-card');if(!card)return host.innerHTML;
  card.classList.add('mock-comparison-album-identity');
  card.querySelectorAll('.rating-row,.chip-row,.mock-card-listen-metrics').forEach(element=>element.remove());
  const body=card.querySelector('.gallery-card-info,.album-body'),meta=card.querySelector('.album-meta-row');
  if(meta)meta.innerHTML=`<span class="mock-comparison-artist">${escape(album.album_artist)}</span><span class="mock-comparison-year">${escape(album.year)}</span>`;
  if(body&&meta)body.append(meta);
  card.querySelector('.album-title-button')?.setAttribute('title',album.name);
  return host.innerHTML;
}

export function comparisonAlbumTable({pairs,person,factor,sort,ascending,phone=false,view='list'},owners){
  const id='mock-shared-albums';
  const html=owners.table({id,ariaLabel:`Your and ${person.name}'s album listening comparison`,columns:'minmax(220px,1fr) 156px 156px',frame:'none',
    columnsConfig:[{key:'album',label:'Album'},{key:'yours',label:'Yours'},{key:'friend',label:person.name}],
    rows:pairs.map((pair,index)=>({key:pair.id,dataAttributes:{'comparison-album-id':pair.id},cells:{
      album:{content:`<div class="mock-comparison-album-identity-cell"><span class="mock-comparison-rank" aria-label="Rank ${index+1}">${index+1}</span>${comparisonAlbumIdentity((pair.left||pair.right).album,owners)}</div>`},
      yours:{content:albumValues(pair,'left',person,factor,{indicators:view!=='cards'})},
      friend:{content:albumValues(pair,'right',person,factor,{indicators:false})},
    }}))});
  const host=document.createElement('div');host.innerHTML=html;const table=host.querySelector('.compact-data-table');
  table.classList.add('mock-shared-comparison','mock-comparison-album-table');table.dataset.comparisonKind='albums';table.dataset.comparisonView=view;table.dataset.comparisonPhone=String(phone);
  for(const [key,label]of [['yours','Yours'],['friend',person.name]]){
    const header=table.querySelector(`[role=columnheader][data-cdt-column=${key}]`);header.innerHTML=sortHeading(label,key,sort,ascending);header.setAttribute('aria-sort',sort===key?(ascending?'ascending':'descending'):'none');
  }
  return host.innerHTML;
}

// Add the current viewer's shared native love control. In the friend table this
// is still the viewer's preference, never an inferred friend preference.
function addComparisonTrackLove(table,owners){
  for(const row of table.querySelectorAll('[role=row]')){
    const duration=row.querySelector('[data-cdt-column=duration]');
    if(!duration||row.querySelector('[data-cdt-column=love]'))continue;
    const header=duration.getAttribute('role')==='columnheader';
    const cell=document.createElement('div');cell.dataset.cdtColumn='love';cell.className='mock-comparison-love-cell';
    cell.setAttribute('role',header?'columnheader':'cell');
    if(header){
      cell.id=table.id+'-header-love';cell.textContent='Love';cell.setAttribute('aria-label','Your track love');cell.title='Your track love';
    }else{
      const trackPath=row.dataset.trackRowPath||row.dataset.cdtRowKey;
      cell.setAttribute('aria-labelledby',table.id+'-header-love');
      cell.innerHTML=owners.trackLoveControl(trackPath);
    }
    duration.before(cell);
  }
}

// Keep one identity per phone row. Native track cells retain their actual play
// controls, row IDs and Length behavior; love state stays with the shared owner.
export function sharedComparisonTable({kind,pairs,person,factor,view,sort,ascending},owners){
  if(kind==='albums')return comparisonAlbumTable({pairs,person,factor,view,sort,ascending,phone:true},owners);
  const id='mock-shared-'+kind,rows=pairs.map(pair=>({... (pair.left||pair.right)}));
  const host=document.createElement('div');
  host.innerHTML=kind==='tracks'?owners.playTable({id,rows,artwork:true,label:`Your and ${person.name}'s track listens`})
    :owners.artistTable({id,rows,label:`Your and ${person.name}'s artist listens`});
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
      left.id=table.id+'-yours';sign.id=table.id+'-comparison';right.id=table.id+'-friend';sign.setAttribute('aria-label','Comparison');
      for(const [cell,label,key] of [[left,'Yours','yours'],[right,person.name,'friend']]){
        cell.innerHTML=sortHeading(label,key,sort,ascending);cell.setAttribute('aria-sort',sort===key?(ascending?'ascending':'descending'):'none');
      }
    }else{
      const pair=indexed.get(row.dataset.trackRowPath||row.dataset.cdtRowKey);if(!pair)continue;
      const metrics=comparisonMetrics(pair,kind,person.id,factor);left.innerHTML=metricValues(metrics,'left');right.innerHTML=metricValues(metrics,'right');
      sign.innerHTML=metrics.map(metric=>comparisonSign(metric,person.name)).join('');
      for(const [cell,key] of [[left,'yours'],[sign,'comparison'],[right,'friend']])cell.setAttribute('aria-labelledby',table.id+'-'+key);
    }
    left.after(sign,right);
  }
  if(kind==='tracks')addComparisonTrackLove(table,owners);
  return host.innerHTML;
}

// Desktop native tables face their count columns toward the common center.
// Each pair stays in the same row on each side, including known numeric zeros.
export function comparisonSideTable({side,kind,pairs,person,factor},owners){
  const rows=pairs.map(pair=>{
    const count=comparisonMetrics(pair,kind,person.id,factor)[0][side];
    return{...(pair[side]||pair.left||pair.right),count,missing:!shown(count)};
  });
  const label=side==='left'?'Your':person.name;
  const host=document.createElement('div');host.innerHTML=kind==='tracks'
    ?owners.playTable({id:'mock-compare-'+side,label:`${label} tracks`,rows})
    :owners.artistTable({id:'mock-compare-'+side,label:`${label} artists`,rows});
  const table=host.querySelector('.compact-data-table');table.classList.add('mock-comparison-facing-table');table.dataset.comparisonSide=side;table.dataset.comparisonKind=kind;
  if(kind==='tracks')addComparisonTrackLove(table,owners);
  for(const row of table.querySelectorAll('[role=row]')){
    const count=row.querySelector('[data-cdt-column=count]');if(!count)continue;
    count.removeAttribute('data-cdt-action');
    if(side==='right')row.prepend(count);else row.append(count);
  }
  return side==='left'?annotateComparisonBoundary(host.innerHTML,pairs,kind,person,factor):host.innerHTML;
}
export function annotateComparisonBoundary(html,pairs,kind,person,factor){
  const host=document.createElement('div');host.innerHTML=html;const indexed=new Map(pairs.map(pair=>[pair.id,pair]));
  for(const row of host.querySelectorAll('[data-track-row-path],[data-cdt-row-key]')){
    const pair=indexed.get(row.dataset.trackRowPath||row.dataset.cdtRowKey);if(!pair)continue;
    const marker=document.createElement('span');marker.className='mock-boundary-comparison';
    marker.innerHTML=comparisonMetrics(pair,kind,person.id,factor).map(metric=>comparisonSign(metric,person.name)).join('');
    (row.querySelector('[data-cdt-column=count]')||row.lastElementChild).append(marker);
  }
  return host.innerHTML;
}

export function comparisonCard(pair,side,person,factor,owners){
  const album=(pair.left||pair.right).album,who=side==='left'?'me':person.id;
  const host=document.createElement('div');host.innerHTML=owners.card(album,'cards');
  const card=host.querySelector('.album-card');if(!card)return host.innerHTML;
  card.dataset.comparisonAlbumId=pair.id;card.dataset.comparisonSide=side;card.classList.add('mock-comparison-gallery-card');
  card.querySelectorAll('.rating-row,.mock-card-listen-metrics').forEach(element=>element.remove());
  const body=card.querySelector('.gallery-card-info,.album-body'),chip=card.querySelector('.chip-row');
  const rating=document.createElement('div');rating.className='mock-comparison-card-rating';rating.innerHTML=`<small>Rating</small>${numericRating(album,who)}`;
  if(chip)chip.before(rating);else body?.append(rating);
  const metrics=document.createElement('div');metrics.className='mock-card-listen-metrics';
  metrics.innerHTML=comparisonMetrics(pair,'albums',person.id,factor).map(metric=>`<span${shown(metric[side])?'':' class="mock-missing-value"'}><strong>${shown(metric[side])?metric[side]:'—'}</strong> ${metric.label}</span>`).join('');body?.append(metrics);
  card.querySelector('.album-title-button')?.setAttribute('title',album.name);
  card.querySelector('.album-subtitle')?.setAttribute('title',`${album.album_artist} · ${album.year}`);
  if(side==='left')card.querySelectorAll('[data-open-tracklist]').forEach(button=>button.setAttribute('aria-describedby','mock-comparison-match-instructions'));
  return host.innerHTML;
}

// Content-size hints, not text measurement or rendered-pixel assertions.
export function comparisonContentWidth(pairs,kind){
  const length=Math.max(12,...pairs.map(pair=>{const row=pair.left||pair.right;return Math.max(String(row.title||'').length,String(row.artist||'').length);}));
  return kind==='albums'?Math.max(660,Math.min(960,480+length*7))
    :kind==='artists'?Math.max(560,Math.min(1000,250+length*15))
      :Math.max(832,Math.min(1200,532+length*14));
}
