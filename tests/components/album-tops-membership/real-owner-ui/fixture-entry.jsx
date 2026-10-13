// Synthetic providers and host; actual React app/controller, native bridge,
// Settings/mobile navigation, request, and confirmation owners. No runtime stub.
import React, {useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {AlbumTopBuilder} from './music_app/static/js/album-tops/builder.jsx';
import {AlbumTopsView} from './music_app/static/js/album-tops/app.jsx';
import {createAlbumTopController} from './music_app/static/js/album-tops/model.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const TOP=id(1),A=id(11),B=id(12),C=id(13),D=id(14),IA=id(21),IB=id(22),SOURCE=id(31);
const BROWSE='library.browse.read',CREATE='library.album_tops.create',MANAGE='library.album_tops.manage',ITEMS='library.album_tops.items.manage';
window.startReviewFixture=async(kind='top-create',options={})=>{
  const calls={search:[],admit:[],preview:[],writes:[],confirms:[],forms:[]},pendingSearch=[],pendingWrites=[],pendingAdmissions=[];
  const runtime=window.AlbumHavenAlbumTopsRuntime,host=document.querySelector('#mount'),reactRoot=createRoot(host),opener=document.querySelector('#opener');
  let controller,original,persisted,sequence=0;
  const held=(value,fail=false)=>{const match=typeof value==='string'?pendingSearch.find(row=>row.query===value):pendingSearch.at(-1);if(match){pendingSearch.splice(pendingSearch.indexOf(match),1);fail?match.reject(Object.assign(new Error('Unavailable'),{status:503})):match.resolve(match.result);}};
  let dispose=()=>reactRoot.unmount();
  if(!['top-inline','top-create'].includes(kind))throw new Error('Unsupported UI port fixture kind');
  {
    const items=[{item_ref:IA,album_ref:A,title:'Retained local',artist:'Artist',year:2001,original_position:4,position:1},{item_ref:IB,album_ref:B,title:'Retained nonlocal',artist:'Artist',year:null,original_position:9,position:2}];
    persisted={top_ref:TOP,revision:'7',title:'Curated Top',description:'Subtitle',visibility:'private',items,
      allowed_actions:{[BROWSE]:true,[MANAGE]:true,[ITEMS]:true,can_read:true,can_edit:true,can_rename:true,can_add:true,can_remove:true,can_reorder:true},
      edit_draft:{items:[{item_ref:IA,album_ref:A,selected_local_album_id:11,selected_source_ref:SOURCE},{item_ref:IB,album_ref:B}],publication_preview_required:false}};
    if(options.legacy)delete persisted.edit_draft;
    if(options.previewSourceError){persisted.items=persisted.items.slice(0,1);persisted.edit_draft.items=persisted.edit_draft.items.slice(0,1);persisted.edit_draft.publication_preview_required=true;}
    original=structuredClone(persisted);
    const albums=[{local_album_id:13,album_ref:C,title:'Found edition',artist:'Artist',year:2002},{local_album_id:14,album_ref:D,title:'Second edition',artist:'Artist',year:2003}];
    const providers={list:async()=>({tops:[persisted],allowed_actions:{[BROWSE]:true,[CREATE]:true,can_create:true},next_cursor:null}),read:async()=>persisted,
      searchAlbums:request=>{calls.search.push({q:request.q,cursor:request.cursor});const result={albums:options.multiResults?albums:albums.slice(0,1),next_cursor:request.q==='old'?'old-cursor':null};
        if(options.holdSearch)return new Promise((resolve,reject)=>pendingSearch.push({query:request.q,resolve,reject,result}));
        if(request.q==='failure')return Promise.reject(Object.assign(new Error('Search unavailable'),{status:503}));return Promise.resolve(result);},
      admitAlbum:async localId=>{calls.admit.push(localId);if(options.holdAdmit)await new Promise((resolve,reject)=>pendingAdmissions.push({resolve,reject}));return {album_ref:id(localId)};},
      preview:async(ref,payload)=>{calls.preview.push({ref,payload:structuredClone(payload)});throw Object.assign(new Error('The request could not be completed.'),{status:options.previewSourceError==='command_too_large'?413:409,code:options.previewSourceError});},
      execute:async(action,command)=>{
        calls.writes.push({action,command:structuredClone(command)});
        if(options.commandSourceError&&Object.hasOwn(command,'items'))throw Object.assign(new Error('The request could not be completed.'),{status:options.commandSourceError==='command_too_large'?413:409,code:options.commandSourceError});
        if(options.holdWrite)await new Promise(resolve=>pendingWrites.push(resolve));
        if(options.rejectWriteAfterRelease)throw Object.assign(new Error('Synthetic definitive rejection'),{status:422,code:'invalid_command'});
        if(options.uncertain)throw new TypeError('Lost acknowledgement');
        persisted={...persisted,title:command.title??persisted.title,description:command.description??persisted.description,revision:String(Number(persisted.revision)+1)};
        if(command.items){persisted.items=command.items.map((item,index)=>({...original.items.find(row=>row.album_ref===item.album_ref),...item,position:index+1}));persisted.edit_draft={...persisted.edit_draft,items:command.items};}
        return {top_ref:TOP,revision:persisted.revision,action,request_key:command.request_key};}};
    controller=createAlbumTopController({providers,requestKey:()=>id(100+sequence++)});controller.setScope(runtime.snapshot().scopeKey);await controller.load();
    const editing=kind==='top-inline'||kind==='top-edit';if(editing)await controller.open(TOP);
    function Top(){const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot),[open,setOpen]=useState(true);
      if(kind==='top-inline')return <AlbumTopsView runtime={runtime} controller={controller} providers={providers} state={state} onOpen={ref=>controller.open(ref)}/>;
      return open?<AlbumTopBuilder runtime={runtime} controller={controller} providers={providers} state={state} existing={editing?original:null} onClose={()=>setOpen(false)} returnFocus={()=>opener}/>:null;}
    reactRoot.render(<Top/>);dispose=()=>{reactRoot.unmount();controller.dispose();};
  }
  window.reviewFixture={calls,controller,original,getPersisted:()=>persisted,resolveSearch:q=>held(q),rejectSearch:q=>held(q,true),
    resolveWrite:()=>pendingWrites.shift()?.(),resolveAdmission:()=>pendingAdmissions.shift()?.resolve(),rejectAdmission:()=>pendingAdmissions.shift()?.reject(Object.assign(new Error('Admission unavailable'),{status:503})),dispose,
    async revise(){persisted={...persisted,revision:String(Number(persisted.revision)+1)};await controller.open(TOP);},
    async revokeItems(){persisted={...persisted,allowed_actions:{...persisted.allowed_actions,[ITEMS]:false,can_add:false,can_remove:false,can_reorder:false}};await controller.open(TOP);},
    revoke(){controller.observeDenial?.(controller.getSnapshot().scopeKey,Object.assign(new Error('Denied'),{status:403}));},
    async navigate(){await controller.open(null);},async reopen(){await controller.open(TOP);},
  };
};
