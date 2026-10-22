import {mountAlbumTops} from '/music_app/static/js/album-tops/index.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
window.startNavigationFixture=function(options={}){
  const f=window.navFixture,{TOP,OTHER,calls}=f;
  const BROWSE='library.browse.read',CREATE='library.album_tops.create',MANAGE='library.album_tops.manage',ITEMS='library.album_tops.items.manage';
  const source=[{item_ref:id(21),album_ref:id(11),title:'Retained local',artist:'Artist',year:2001,position:1,original_position:4},
    {item_ref:id(22),album_ref:id(12),title:'Retained nonlocal',artist:'Artist',year:null,position:2,original_position:9}];
  let data={top_ref:TOP,revision:'7',title:'Curated Top',description:'Subtitle',visibility:'private',items:source,
    allowed_actions:{[BROWSE]:true,[MANAGE]:true,[ITEMS]:true,can_read:true,can_edit:true,can_rename:true,can_add:true,can_remove:true,can_reorder:true},
    edit_draft:{items:[{item_ref:id(21),album_ref:id(11),selected_local_album_id:11,selected_source_ref:id(31)},{item_ref:id(22),album_ref:id(12)}],publication_preview_required:false}};
  f.original=structuredClone(data);f.getPersisted=()=>structuredClone(data);const writes=[],searches=[],refreshReads=[];let refreshReleased=false;
  const providers={list:async()=>({tops:[data,{...data,top_ref:OTHER,title:'Other Top'}],allowed_actions:{[BROWSE]:true,[CREATE]:true,can_create:true},next_cursor:null}),
    read:async ref=>{calls.reads++;if(options.holdRefresh&&calls.writes.length&&!refreshReleased)await new Promise(resolve=>refreshReads.push(resolve));
      return structuredClone(ref===OTHER?{...data,top_ref:OTHER,title:'Other Top'}:data);},
    searchAlbums:request=>{calls.search.push(request.q);const result={albums:[{local_album_id:13,album_ref:id(13),title:'Found edition',artist:'Artist',year:2002}],next_cursor:null};
      request.signal.addEventListener('abort',()=>{calls.aborts++;});return options.holdSearch?new Promise(resolve=>searches.push(()=>resolve(result))):Promise.resolve(result);},
    admitAlbum:async localId=>({album_ref:id(localId)}),
    execute:async(action,command)=>{calls.writes.push({action,command:structuredClone(command)});if(options.holdWrite)await new Promise(resolve=>writes.push(resolve));
      if(options.uncertain)throw new TypeError('Synthetic lost acknowledgement');
      data={...data,title:command.title??data.title,description:command.description??data.description,revision:String(Number(data.revision)+1)};
      if(command.items){data.items=command.items.map((row,index)=>({...source.find(old=>old.album_ref===row.album_ref),...row,position:index+1}));data.edit_draft={...data.edit_draft,items:structuredClone(command.items)};}
      return{top_ref:TOP,revision:data.revision,action,request_key:command.request_key};}};
  const nativeRuntime=window.AlbumHavenAlbumTopsRuntime;
  const runtime=options.missingRegistration?{...nativeRuntime,registerDraftNavigation:undefined}:options.rejectedRegistration?{...nativeRuntime,registerDraftNavigation:()=>false}:nativeRuntime;
  const mounted=mountAlbumTops({host:document.querySelector('#album-tops-root'),sidebarHost:document.querySelector('#album-tops-sidebar-root'),runtime,providers});
  const refreshDetail=()=>{state.view={...state.view};AlbumHavenAlbumTopsRuntime.sync();};
  Object.assign(f,{resolveWrite:()=>writes.shift()?.(),resolveRefresh(){refreshReleased=true;for(const resolve of refreshReads.splice(0))resolve();},resolveSearch:()=>searches.shift()?.(),dispose:()=>mounted.dispose(),
    revise(){data={...data,revision:String(Number(data.revision)+1)};refreshDetail();},
    revoke(){data={...data,allowed_actions:{...data.allowed_actions,[BROWSE]:false,[MANAGE]:false,[ITEMS]:false,can_edit:false,can_add:false,can_remove:false,can_reorder:false}};refreshDetail();},
    changeScope(){document.querySelector('#app-shell').dataset.nativeAccountId='account:two';AlbumHavenAlbumTopsRuntime.sync();},
    changeGeneration(){document.querySelector('#app-shell').dataset.privateUiContext='b'.repeat(64);AlbumHavenAlbumTopsRuntime.sync();},
    newerHistory(){AlbumHavenSettingsNavigation.instance.pushLibraryHistory('/?surface=album_tops&top_ref='+OTHER,{});handleGalleryBootstrapPopState();},
  });
};
