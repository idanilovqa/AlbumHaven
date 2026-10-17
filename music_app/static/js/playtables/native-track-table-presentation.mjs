import {bindTrackTablePresentation} from './track-table-presentation.mjs';
import {mountButton} from '../home-friends/native-controls.mjs';
export function mountTrackTablePresentation(host,initialOptions){
 let options=initialOptions,choices={},owner=null,disposed=false;
 function settings(){const resourceKey=options.resourceKey;return {...options,choices,openChoice:options.runtime.openChoice,isCurrent:()=>!disposed&&options.enabled!==false&&options.resourceKey===resourceKey&&options.isCurrent?.()!==false,onChoicesChange(next){if(!disposed&&options.resourceKey===resourceKey){choices=next;owner?.update(settings());options.onChoicesChange?.(next);}}};}
 function connect(){if(options.enabled!==false)owner=bindTrackTablePresentation(host,settings());}
 connect();return {get available(){return options.enabled!==false&&typeof options.runtime.openChoice==='function';},openColumns:anchor=>owner?.openColumns(anchor),update(next){if(disposed)return;const reset=next.resourceKey!==options.resourceKey||next.runtime!==options.runtime||next.enabled!==options.enabled;options=next;if(reset){owner?.dispose();owner=null;choices={};connect();}else owner?.update(settings());},dispose(){disposed=true;owner?.dispose();owner=null;}};
}
export function mountTrackTableColumnsAction(host,runtime,presentation){
 host.className='compact-data-table__columns-action';return mountButton(host,runtime,{label:'Track columns',icon:typeof runtime.actionHtml==='function'?'more':undefined,disabled:!presentation.available||typeof runtime.actionHtml!=='function',attributes:{'data-track-table-columns':'','aria-haspopup':'menu','aria-expanded':'false'},onClick:event=>presentation.openColumns(event.target.closest('button'))});
}
