import {mountAlbumPicker} from '/music_app/static/js/album-tops/builder.mjs';
import {createAlbumTopDraft} from '/music_app/static/js/album-tops/draft.mjs';
import {createAlbumTopController} from '/music_app/static/js/album-tops/model.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
window.startBoundedPicker=async function(){
  const TOP=id(1),BROWSE='library.browse.read',CREATE='library.album_tops.create',MANAGE='library.album_tops.manage',ITEMS='library.album_tops.items.manage';
  const items=Array.from({length:5000},(_,index)=>({item_ref:id(10000+index),album_ref:id(20000+index),title:'Retained '+(index+1),artist:'Artist',year:null,position:index+1,original_position:index+1}));
  const bindings=items.map((row,index)=>({item_ref:row.item_ref,album_ref:row.album_ref,selected_local_album_id:index+1,selected_source_ref:id(30000+index)}));
  const data={top_ref:TOP,revision:'7',title:'Capacity fixture',description:'Genuine full draft; bounded All surface',visibility:'private',items,
    allowed_actions:{[BROWSE]:true,[MANAGE]:true,[ITEMS]:true,can_read:true,can_edit:true,can_rename:true,can_add:true,can_remove:true,can_reorder:true},
    edit_draft:{items:bindings,publication_preview_required:false}};
  const original=structuredClone(data),calls={search:[],admit:[],writes:[],fixture:[]};
  const providers={list:async()=>({tops:[data],allowed_actions:{[BROWSE]:true,[CREATE]:true,can_create:true},next_cursor:null}),read:async()=>structuredClone(data),
    searchAlbums:async request=>{calls.search.push(request.q);return{albums:[{local_album_id:13,album_ref:id(13),title:'Found edition',artist:'Artist',year:2002}],next_cursor:null};},
    admitAlbum:async local=>{calls.admit.push(local);return{album_ref:id(local)};},execute:async(action,command)=>{calls.writes.push({action,command});throw new Error('No Save belongs to this picker-only probe');}};
  const controller=createAlbumTopController({providers});controller.setScope('bounded-picker:actor:library');await controller.load();await controller.open(TOP);
  const draft=createAlbumTopDraft({controller,providers});draft.setTab('all');
  const runtime={buttonHtml:value=>ButtonComponent.renderButton(value),actionHtml:value=>ButtonComponent.renderActionButton(value),alertHtml:value=>buildOnPageAlertHtml(value),
    galleryCardHtml:value=>buildGalleryCardHtml(value),artboxHtml:value=>buildAlbumArtboxHtml(value),searchHtml:value=>buildSearchInputHtml(value),tabsHtml:value=>buildInPageTabsHtml(value),mountTabs:value=>mountInPageTabs(value)};
  const pickerProps=()=>{const value=draft.getSnapshot();return {draft,value,disabled:value.busy||value.stale||value.denied};};
  const picker=mountAlbumPicker(document.querySelector('#picker-root'),runtime,pickerProps());
  const unsubscribePicker=draft.subscribe(()=>picker.update(pickerProps()));
  const inspect=()=>{const value=draft.getSnapshot();document.querySelector('#fixture-observation').textContent=JSON.stringify({qualification:'Actual5000-item model/draft and actual AlbumPicker; only All/search cards rendered. No full-gallery performance acceptance.',
    count:value.items.length,tab:value.tab,query:value.query,canEditMembership:draft.canEditMembership(),first:value.items[0]?.album_ref,last:value.items.at(-1)?.album_ref,calls,
    savedCount:data.items.length,savedFirstBinding:data.edit_draft.items[0],draftFirstBinding:value.items[0]&&{item_ref:value.items[0].item_ref,album_ref:value.items[0].album_ref,selected_source_ref:value.items[0].selected_source_ref}},null,2);};
  const operations={removeOne(){const row=draft.getSnapshot().items[0];calls.fixture.push('removeOne');if(row)draft.remove(row.album_ref);inspect();},
    reorder(){const refs=draft.getSnapshot().items.map(row=>row.album_ref);calls.fixture.push('reorder');[refs[0],refs[1]]=[refs[1],refs[0]];draft.reorder(refs);inspect();},inspect};
  const controls=document.querySelector('#fixture-controls'),onControl=event=>operations[event.target.closest('[data-fixture]')?.dataset.fixture]?.();
  controls.addEventListener('click',onControl);
  window.pickerFixture={draft,controller,calls,original,getPersisted:()=>structuredClone(data),inspect,dispose(){unsubscribePicker();unsubscribeInspect();controls.removeEventListener('click',onControl);picker.dispose();draft.dispose();controller.dispose();}};
  const unsubscribeInspect=draft.subscribe(inspect);inspect();
};
