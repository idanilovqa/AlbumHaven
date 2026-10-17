import {mountButton,mountTabs,mountStatus} from '../home-friends/native-controls.mjs';
import {mountDetailProjectionPanel} from '../home-friends/detail-projection-ui.mjs';
import {mountResourceDetail} from '../home-friends/resource-detail.mjs';
import {playlistAlbumSelection,playlistArtistSelection,playlistSourceReadable,playlistTrackSummary} from './selection.mjs';
let serial=0;
const known=value=>typeof value==='string'&&value.trim()?value:'Unknown';
const unavailableDetail=()=>({status:'unavailable'});
const itemIdentity=(row,scopeKey)=>JSON.stringify([scopeKey,row?.playlist_item_id||row?.row_key||null]);
const duration=value=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0)return 'Unknown';const seconds=Math.floor(value);return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
export function mountPlaylistSelectionPanel(host,runtime,initial){
 let props=initial,disposed=false,tab='track',detailOwner=null,ownerKind=null,lastIdentity=itemIdentity(props.row,props.scopeKey),error='',renderedRow=null,renderedScope=null,renderedReader=null,renderedTab=null;const id=`playlist-selection-native-${++serial}`,doc=host.ownerDocument;
 const acquired=[];let constructing=true;const acquire=value=>{if(constructing)acquired.push(()=>value.dispose());return value;};
 try{
 host.className='playlists__selection';host.setAttribute('aria-label','Selected playlist item');
 const header=doc.createElement('header');header.className='gallery-bar playlists__selection-header';const heading=doc.createElement('h2');heading.textContent='Selected item';const closeHost=doc.createElement('div');header.append(heading,closeHost);const tabsHost=doc.createElement('div'),body=doc.createElement('div');body.className='playlists__selection-body gallery-scrollbar';body.setAttribute('role','tabpanel');host.replaceChildren(header,tabsHost,body);
 const close=()=>props.onClose?.({rowKey:props.row.row_key,restoreFocusRequested:true}),button=acquire(mountButton(closeHost,runtime,{label:'Close selection',icon:'close',onClick:close})),tabs=acquire(mountTabs(tabsHost,runtime,{id,label:'Selected item information',items:[['track','Track'],['album','Album']],value:tab,onChange:next=>{tab=next;render();}}));
 function keydown(event){if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();close();}}host.addEventListener('keydown',keydown);acquired.push(()=>host.removeEventListener('keydown',keydown));
 function retireDetail(){detailOwner?.dispose();detailOwner=null;ownerKind=null;body.replaceChildren();}
 function mountOrUpdate(kind,next,mount){if(ownerKind===kind&&detailOwner)detailOwner.update(next);else{retireDetail();ownerKind=kind;detailOwner=acquire(mount(body,runtime,next));}}
 function render(){
  if(disposed)return;
  const row=props.row,identity=itemIdentity(row,props.scopeKey);
  if(identity!==lastIdentity){lastIdentity=identity;tab='track';error='';retireDetail();}
  if(row===renderedRow&&props.scopeKey===renderedScope&&props.readDetail===renderedReader&&tab===renderedTab)return;
  renderedRow=row;renderedScope=props.scopeKey;renderedReader=props.readDetail;
  host.hidden=!row;if(!row){retireDetail();return;}
  const artist=playlistArtistSelection(row);if(tab==='artist'&&!artist)tab='track';
  if(renderedTab!==tab)retireDetail();renderedTab=tab;
  tabs.update({id,label:'Selected item information',items:[['track','Track'],['album','Album'],...(artist?[['artist','Artist']]:[])],value:tab,onChange:next=>{if(['track','album'].includes(next)||next==='artist'&&artist){tab=next;render();}}});body.setAttribute('aria-labelledby',`${id}-${tab}`);
 if(tab==='track'){const value=playlistTrackSummary(row),data=value.data;if(!data){mountOrUpdate('track-status',{value,label:"this track's information"},mountStatus);return;}retireDetail();const metadata={current:'Current metadata',last_known:'Last-known metadata',unknown:'Metadata freshness unknown'}[data.metadata_state],escape=runtime.escapeHtml;body.innerHTML=`<section class="home-detail" aria-label="Track information"><div class="home-detail__overview"><div class="home-detail__artwork">${runtime.artboxHtml({state:data.artwork_url?'ready':'empty',label:`${known(data.title)} artwork`,coverHtml:data.artwork_url?`<img src="${escape(data.artwork_url)}" alt="" loading="lazy" decoding="async">`:''})}</div><div class="home-detail__identity">${runtime.detailHeaderHtml({variant:'copy',titleId:`${id}-title`,subtitleId:`${id}-subtitle`,title:known(data.title),eyebrow:data.artist||data.secondary_artist,subtitle:metadata})}</div></div><dl class="home-detail__facts">${[['Artist',known(data.artist||data.secondary_artist)],['Album',known(data.album_title)],['Track',data.track_number??'Unknown'],['Disc',data.disc_number??'Unknown'],['Length',data.duration_seconds===null?known(data.duration_display):duration(data.duration_seconds)],['Source',known(data.source_label)],['Source type',known(data.source_kind)],['Availability',{local:'Confirmed local',missing:'Confirmed missing',unresolved:'Unresolved'}[data.availability]]].map(([label,text])=>`<dt>${escape(label)}</dt><dd>${escape(text)}</dd>`).join('')}</dl></section>`;return;}
 if(!playlistSourceReadable(row)){mountOrUpdate('resource-status',{value:{status:'denied'},label:`this ${tab}'s information`},mountStatus);return;}const selection=tab==='artist'?artist:playlistAlbumSelection(row);if(!selection?.allowed_actions.can_view_details){mountOrUpdate('projection',{selection,value:{status:'unavailable',data:null}},mountDetailProjectionPanel);return;}
 const ownerIdentity=identity,ownerTab=tab;mountOrUpdate('resource',{scopeKey:props.scopeKey,selection,readDetail:typeof props.readDetail==='function'?props.readDetail:unavailableDetail,onError:message=>{if(!disposed&&itemIdentity(props.row,props.scopeKey)===ownerIdentity&&tab===ownerTab){error=message;const notice=doc.createElement('div');notice.innerHTML=runtime.alertHtml({severity:'error',role:'alert',message});body.prepend(notice);}}},mountResourceDetail);
 }
 render();constructing=false;acquired.length=0;return {element:host,update(next){if(disposed)return;props=next;render();},dispose(){disposed=true;detailOwner?.dispose();button.dispose();tabs.dispose();host.removeEventListener('keydown',keydown);host.replaceChildren();}};
 }catch(error){disposed=true;for(const cleanup of acquired.splice(0).reverse()){try{cleanup();}catch{}}host.replaceChildren();throw error;}
}
