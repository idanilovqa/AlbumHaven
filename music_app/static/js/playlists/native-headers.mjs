import {mountSharedHeader} from '../home-friends/shared-header.mjs';
import {mountButton} from '../home-friends/native-controls.mjs';
import {createNativeOwnerScope} from './native-owner-scope.mjs';
const saved = [['add','Add tracks','add'],['missing','Inspect missing tracks','missing-playlist'],['top','Create Album Top','create-top'],['export','Export TXT','export-text'],['share','Share','share'],['copy','Save a copy','save'],['settings','Playlist settings','more'],['filters','Filters','filters'],['save','Save','save'],['discard','Discard unsaved changes','close']];
const draft = [['top','Create Album Top','create-top'],['export','Export TXT','export-text'],['filters','Filters','filters'],['save','Save','save'],['close','Close playlist preview','close']];
function mountHeader(host, runtime, initial, isDraft) {
  const scope = createNativeOwnerScope();
  let disposed = false, revision = 0;
  try {
    const id = props => isDraft ? props.id || `${props.filtersId}-header` : 'playlists';
    const header = scope.own(mountSharedHeader(host, runtime, {id:id(initial), className:'playlists__header'}));
    const heading = host.ownerDocument.createElement('div'); heading.className='gallery-bar__title';
    (isDraft ? header.slots.identity : header.slots.content).append(heading);
    const buttons = new Map();
    for (const [key,label,icon] of isDraft ? draft : saved) {
      const slot=host.ownerDocument.createElement('span');
      (key === (isDraft ? 'close' : 'discard') ? header.slots.finalAction : header.slots.actions).append(slot);
      buttons.set(key,{slot,owner:scope.own(mountButton(slot,runtime,{label,icon}))});
    }
    function update(props) {
      if(disposed)return;
      const version=++revision;
      const current=()=>{
        if(disposed||version!==revision)return false;
        const allowed=props.isCurrent?.()!==false;
        return allowed&&!disposed&&version===revision;
      };
      if(!current())return;
      const title=String(isDraft ? props.title || 'Missing tracks' : props.draft?.title || props.detail?.title || 'Playlists');
      if(!current())return;
      heading.textContent=title;
      const actions=props.actions || {};
      for(const [key,label,icon] of isDraft ? draft : saved) {
        if(!current())return;
        const {slot,owner}=buttons.get(key);
        const denied=isDraft ? !actions[key] : ['add','missing','top','export','save'].includes(key) ? !actions[key]
          : key==='share' ? !props.detail || actions.share===false
          : ['settings','filters'].includes(key) ? !props.detail : key==='discard' ? !props.draft : key==='copy' ? !actions.copy : false;
        slot.hidden=!isDraft && key==='copy' && !actions.copy;
        owner.update({label,icon,disabled:Boolean(props.busy || denied),
          title:isDraft && key==='top' && !actions.top ? 'Album Top creation is unavailable for these source albums.'
            : !isDraft && key==='missing' && !actions.missing ? 'Missing-track playlist creation is not available for this source yet.' : label,
          attributes:{[isDraft?'data-playlists-draft-action':'data-playlists-action']:key,
            ...(key==='filters'?{'aria-expanded':String(Boolean(props.filtersOpen)),'aria-controls':isDraft?props.filtersId:'playlists-filters'}:{})},
          onClick:()=>props.onAction?.(key)});
      }
      if(!current())return;
      header.update({id:id(props),className:'playlists__header'});
    }
    update(initial);
    return {element:header.element,slots:header.slots,update,dispose(){if(disposed)return;disposed=true;scope.dispose();}};
  } catch(error) {disposed=true;scope.dispose();throw error;}
}
export const mountPlaylistHeader=(host,runtime,props)=>mountHeader(host,runtime,props,false);
export const mountMissingPlaylistDraftHeader=(host,runtime,props)=>mountHeader(host,runtime,props,true);
