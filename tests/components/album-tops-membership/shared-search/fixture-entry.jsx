// Synthetic providers and host; all mounted UI and controller modules are real.
import React, {useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {AlbumTopBuilder} from './music_app/static/js/album-tops/builder.jsx';
import {AlbumTopsView} from './music_app/static/js/album-tops/app.jsx';
import {createAlbumTopController} from './music_app/static/js/album-tops/model.mjs';
import {CreationSearch, CreationForm} from './music_app/static/js/playlists/creation.jsx';
import {createPlaylistCreationController} from './music_app/static/js/playlists/creation.mjs';
import {Tabs} from './music_app/static/js/home-friends/components.jsx';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const TOP=id(1),A=id(11),B=id(12),C=id(13),D=id(14),IA=id(21),IB=id(22),SOURCE=id(31);
const BROWSE='library.browse.read',CREATE='library.album_tops.create',MANAGE='library.album_tops.manage',ITEMS='library.album_tops.items.manage';
function runtimeFor(options,calls){return {
  buttonHtml:value=>ButtonComponent.renderButton(value),actionHtml:value=>ButtonComponent.renderActionButton(value),
  alertHtml:value=>buildOnPageAlertHtml(value),galleryCardHtml:value=>buildGalleryCardHtml(value),artboxHtml:value=>buildAlbumArtboxHtml(value),
  searchHtml:value=>buildSearchInputHtml(value),tabsHtml:value=>buildInPageTabsHtml(value),mountTabs:value=>mountInPageTabs(value),
  escapeHtml,tableHtml:value=>buildCompactDataTable(value),albumTrackRow:(row,index)=>buildAlbumTrackTableRow({...row,duration:row.duration_display},index,{readOnly:true}),
  confirm:async(message,settings)=>{calls.confirms.push({message,settings});return options.confirmDiscard===true;},confirmRetryOriginal:async()=>false,
  openForm(settings){calls.forms.push(settings.pageId);const outer=document.createElement('section');outer.setAttribute('role','dialog');outer.setAttribute('aria-label',settings.title);
    const host=document.createElement('div');outer.appendChild(host);document.body.appendChild(outer);settings.onMount(host);let disabled=settings.dismissDisabled,closed=false;
    return {setDismissDisabled(value){disabled=value;},async close(_value,closeOptions={}){
      if(closed)return true;if(!closeOptions.force&&(disabled||settings.beforeDismiss&&await settings.beforeDismiss('cancel')!==true))return false;
      closed=true;settings.onClose(host,closeOptions);outer.remove();if(closeOptions.restoreFocus!==false)settings.returnFocus?.()?.focus();return true;}};},
};}
window.startReviewFixture=async(kind='top-create',options={})=>{
  const calls={search:[],admit:[],writes:[],confirms:[],forms:[]},pendingSearch=[],pendingWrites=[],pendingAdmissions=[];
  const runtime=runtimeFor(options,calls),host=document.querySelector('#mount'),reactRoot=createRoot(host),opener=document.querySelector('#opener');
  let controller,settleShared,original,persisted,sequence=0;
  const held=(value,fail=false)=>{const match=typeof value==='string'?pendingSearch.find(row=>row.query===value):pendingSearch.at(-1);if(match){pendingSearch.splice(pendingSearch.indexOf(match),1);fail?match.reject(Object.assign(new Error('Unavailable'),{status:503})):match.resolve(match.result);}};
  let dispose=()=>reactRoot.unmount();
  if(kind==='shared-search'){
    function Shared(){const [query,setQuery]=useState(''),[phase,setPhase]=useState('idle'),[tab,setTab]=useState('all');settleShared=()=>setPhase('ready');
      return <section aria-label="Shared search probe"><CreationSearch runtime={runtime} id="shared-probe" value={query} disabled={false} label="Shared search" onChange={value=>{calls.search.push({q:value});setQuery(value);setPhase('loading');}}/>
        <Tabs runtime={runtime} id="shared-tabs" label="Probe tabs" items={[[ 'all','All'],['selected','Selected']]} value={tab} onChange={setTab}/><output aria-label="Query state">{query}</output><output aria-label="Resource phase">{phase}</output></section>;}
    reactRoot.render(<Shared/>);
  }else if(kind==='playlist-create'){
    const grants={can_read:true,can_use_for_playlist:true},source={kind:'library',ref:'source:one',revision:'rev:one',source_protocol:'library_selection_v1',allowed_actions:grants};
    const page=query=>({status:'ready',data:{scopeKey:'playlist:fixture',mode:'ordinary',source,source_protocol:'library_selection_v1',entries_complete:false,
      entries:[],allowed_actions:grants,query,search_revision:'search:one',limit:100,has_more:false,next_cursor:null}});
    controller=createPlaylistCreationController({providers:{readPlaylistCreationSource:request=>{calls.search.push({q:request.q??''});const result=page(request.q??'');
      if(!request.q)return Promise.resolve(result);return new Promise((resolve,reject)=>pendingSearch.push({query:request.q,resolve,reject,result}));},
      createPlaylistFromSelection:async request=>{calls.writes.push(request);return {status:'ready',data:{scopeKey:request.scopeKey,request_key:request.request_key,playlist_id:'fixture:created',revision:'1'}};}}});
    controller.setContext({scopeKey:'playlist:fixture',mode:'ordinary',canCreate:true,source});await controller.load();
    function Playlist(){const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot);return <CreationForm runtime={runtime} controller={controller} state={state} onDismiss={()=>{}}/>;}
    reactRoot.render(<Playlist/>);dispose=()=>{reactRoot.unmount();controller.dispose();};
  }else{
    const items=[{item_ref:IA,album_ref:A,title:'Retained local',artist:'Artist',year:2001,original_position:4,position:1},{item_ref:IB,album_ref:B,title:'Retained nonlocal',artist:'Artist',year:null,original_position:9,position:2}];
    persisted={top_ref:TOP,revision:'7',title:'Curated Top',description:'Subtitle',visibility:'private',items,
      allowed_actions:{[BROWSE]:true,[MANAGE]:true,[ITEMS]:true,can_read:true,can_edit:true,can_rename:true,can_add:true,can_remove:true,can_reorder:true},
      edit_draft:{items:[{item_ref:IA,album_ref:A,selected_local_album_id:11,selected_source_ref:SOURCE},{item_ref:IB,album_ref:B}],publication_preview_required:false}};
    if(options.legacy)delete persisted.edit_draft;original=structuredClone(persisted);
    const albums=[{local_album_id:13,album_ref:C,title:'Found edition',artist:'Artist',year:2002},{local_album_id:14,album_ref:D,title:'Second edition',artist:'Artist',year:2003}];
    const providers={list:async()=>({tops:[persisted],allowed_actions:{[BROWSE]:true,[CREATE]:true,can_create:true},next_cursor:null}),read:async()=>persisted,
      searchAlbums:request=>{calls.search.push({q:request.q,cursor:request.cursor});const result={albums:options.multiResults?albums:albums.slice(0,1),next_cursor:request.q==='old'?'old-cursor':null};
        if(options.holdSearch)return new Promise((resolve,reject)=>pendingSearch.push({query:request.q,resolve,reject,result}));
        if(request.q==='failure')return Promise.reject(Object.assign(new Error('Search unavailable'),{status:503}));return Promise.resolve(result);},
      admitAlbum:async localId=>{calls.admit.push(localId);if(options.holdAdmit)await new Promise((resolve,reject)=>pendingAdmissions.push({resolve,reject}));return {album_ref:id(localId)};},execute:async(action,command)=>{
        calls.writes.push({action,command:structuredClone(command)});if(options.holdWrite)await new Promise(resolve=>pendingWrites.push(resolve));
        if(options.uncertain)throw new TypeError('Lost acknowledgement');
        persisted={...persisted,title:command.title??persisted.title,description:command.description??persisted.description,revision:String(Number(persisted.revision)+1)};
        if(command.items){persisted.items=command.items.map((item,index)=>({...original.items.find(row=>row.album_ref===item.album_ref),...item,position:index+1}));persisted.edit_draft={...persisted.edit_draft,items:command.items};}
        return {top_ref:TOP,revision:persisted.revision,action,request_key:command.request_key};}};
    controller=createAlbumTopController({providers,requestKey:()=>id(100+sequence++)});controller.setScope('top:review:fixture');await controller.load();
    const editing=kind==='top-inline'||kind==='top-edit';if(editing)await controller.open(TOP);
    function Top(){const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot),[open,setOpen]=useState(true);
      if(kind==='top-inline')return <AlbumTopsView runtime={runtime} controller={controller} providers={providers} state={state} onOpen={ref=>controller.open(ref)}/>;
      return open?<AlbumTopBuilder runtime={runtime} controller={controller} providers={providers} state={state} existing={editing?original:null} onClose={()=>setOpen(false)} returnFocus={()=>opener}/>:null;}
    reactRoot.render(<Top/>);dispose=()=>{reactRoot.unmount();controller.dispose();};
  }
  window.reviewFixture={calls,controller,original,getPersisted:()=>persisted,resolveSearch:q=>kind==='shared-search'?settleShared?.():held(q),rejectSearch:q=>held(q,true),
    resolveWrite:()=>pendingWrites.shift()?.(),resolveAdmission:()=>pendingAdmissions.shift()?.resolve(),rejectAdmission:()=>pendingAdmissions.shift()?.reject(Object.assign(new Error('Admission unavailable'),{status:503})),dispose,
    async revise(){persisted={...persisted,revision:String(Number(persisted.revision)+1)};await controller.open(TOP);},
    async revokeItems(){persisted={...persisted,allowed_actions:{...persisted.allowed_actions,[ITEMS]:false,can_add:false,can_remove:false,can_reorder:false}};await controller.open(TOP);},
    revoke(){controller.observeDenial?.('top:review:fixture',Object.assign(new Error('Denied'),{status:403}));},
    async navigate(){await controller.open(null);},async reopen(){await controller.open(TOP);},
  };
};
