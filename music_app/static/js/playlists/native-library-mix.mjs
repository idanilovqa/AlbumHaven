import {createNativeOwnerScope} from './native-owner-scope.mjs';
import {mountButton,mountChoice,mountStatus} from '../home-friends/native-controls.mjs';
import {mountSharedHeader} from '../home-friends/shared-header.mjs';
import {openNativeDialog} from '../home-friends/native-dialog.mjs';
import {mountPlaylistTracks} from './native-track-table.mjs';
import {mountPlaylistSelectionPanel} from './native-selection.mjs';
import {MIX_ORDER_OPTIONS,mixOrder,normalizeMixRecipe,orderUnplayedMixRows} from './library-mix.mjs';
const node=(host,tag='div',className='')=>{const value=host.ownerDocument.createElement(tag);value.className=className;host.append(value);return value;};
export function mountLibraryMixSetup(host,runtime,initialProps){
 let props=initialProps,disposed=false,operational=true,closeReported=false,dialog=null;
 let basis='per_artist',count='3',automatic=false,order='regular',closeDialog=null;
 let status,choiceBasis,choiceOrder,choiceAuto,create,input,form,unsubscribe=null,subscriptionVersion=0;
 const owners=[],listeners=[];
 const acquire=owner=>{owners.push(owner);return owner;};
 const listen=(target,type,callback)=>{target.addEventListener(type,callback);listeners.push(()=>target.removeEventListener(type,callback));};
 function retire(){
  if(!operational)return;operational=false;subscriptionVersion++;closeDialog=null;
  const stop=unsubscribe;unsubscribe=null;try{stop?.();}catch{/* Continue retiring the remaining native owners. */}
  for(const remove of listeners.splice(0).reverse()){try{remove();}catch{}}
  for(const owner of owners.splice(0).reverse()){try{owner.dispose();}catch{}}
  form?.remove();form=null;
 }
 function reportClose(options){retire();if(disposed||closeReported)return;closeReported=true;props.onClose?.(options);}
 function recipe(){return normalizeMixRecipe({selection_basis:basis,songs_per_group:/^\d+$/.test(count)?Number(count):null,auto_update:automatic,playback_order:order});}
 async function prepare(){
  if(disposed||!operational)return;
  const value=recipe(),controller=props.controller;if(controller.getSnapshot().resource.status==='loading'||!value)return;
  if(await controller.prepare(value)&&!disposed&&operational&&props.controller===controller)await props.onReady(closeDialog);
 }
 function render(){
  if(disposed||!operational||!status)return;
  const state=props.controller.getSnapshot(),busy=state.resource.status==='loading';input.disabled=busy;
  choiceBasis.update({label:'Choose songs',value:basis,disabled:busy,options:[['per_artist','Per artist'],['per_album','Per album']],onChange:value=>{if(!operational)return;basis=value;render();}});
  choiceOrder.update({label:'Playback order',value:order,disabled:busy,options:MIX_ORDER_OPTIONS,onChange:value=>{if(!operational)return;order=value;render();}});
  choiceAuto.update({label:'Update automatically when saved',value:automatic?'on':'off',disabled:busy,options:[['off','Off'],['on','On']],onChange:value=>{if(!operational)return;automatic=value==='on';render();}});
  status.update({value:state.resource,label:'Library Mix'});status.element.hidden=!['loading','error','denied'].includes(state.resource.status);
  create.update({label:'Create mix',icon:'play',disabled:busy||!recipe(),onClick:prepare});
 }
 function subscribe(){
  if(!operational||disposed)return;
  const token=++subscriptionVersion,controller=props.controller;
  let acquiring=true,pending=false;
  const notify=()=>{
   if(!operational||disposed||token!==subscriptionVersion||props.controller!==controller)return;
   if(acquiring){pending=true;return;}
   try{render();}catch(error){retire();try{dialog?.dispose();}catch{/* Keep the publication failure. */}throw error;}
  };
  const next=controller.subscribe(notify);
  acquiring=false;
  if(operational&&!disposed&&token===subscriptionVersion&&props.controller===controller){unsubscribe=next;if(pending)notify();}
  else next?.();
 }
 try{
  dialog=openNativeDialog(runtime,{title:props.controller.getSnapshot().artistScope?'Popular Artist tracks':'Library Mix',pageId:'library-mix'},{fallbackHost:host,
   mount(body,close){
    try{
     closeDialog=close;form=node(body,'form','tag-editor-form');const intro=node(form,'p','playlists__note');intro.textContent=props.controller.getSnapshot().artistScope?'Choose popular songs from this captured Artist selection, ranked by Last.fm global plays.':'Choose popular songs from your whole server library, ranked by Last.fm global plays.';
     choiceBasis=acquire(mountChoice(node(form),runtime,{label:'Choose songs',value:basis,options:[['per_artist','Per artist'],['per_album','Per album']],onChange:value=>{if(!operational)return;basis=value;render();}}));
     const label=node(form,'label');label.append('Songs per group');input=node(label,'input');Object.assign(input,{type:'number',min:'1',max:'5000',step:'1',inputMode:'numeric',value:count});input.setAttribute('aria-label','Songs per group');listen(input,'input',()=>{if(!operational)return;count=input.value;render();});
     choiceOrder=acquire(mountChoice(node(form),runtime,{label:'Playback order',value:order,options:MIX_ORDER_OPTIONS,onChange:value=>{if(!operational)return;order=value;render();}}));
     choiceAuto=acquire(mountChoice(node(form),runtime,{label:'Update automatically when saved',value:'off',options:[['off','Off'],['on','On']],onChange:value=>{if(!operational)return;automatic=value==='on';render();}}));
     const note=node(form,'p','playlists__note');note.textContent=(props.controller.getSnapshot().artistScope?'Off saves this exact captured list. On recalculates only these Artist IDs and retained category/type filters. New family members are not added. ':'')+'Songs without resolved Last.fm popularity are left out. Auto-updating mixes recalculate the top songs as your library changes and keep generated membership locked. Mixes are limited to 5,000 songs; reduce songs per group if the result is too large.';
     status=acquire(mountStatus(node(form),runtime,{value:props.controller.getSnapshot().resource,label:'Library Mix'}));status.element.hidden=!['loading','error','denied'].includes(props.controller.getSnapshot().resource.status);
     const actions=node(form,'div','dialog-actions');acquire(mountButton(node(actions),runtime,{label:'Cancel',onClick:()=>{if(operational)close();}}));
     create=acquire(mountButton(node(actions),runtime,{label:'Create mix',icon:'play',onClick:prepare}));
     listen(form,'submit',event=>{event.preventDefault();prepare();});render();
     return {dispose:retire};
    }catch(error){retire();throw error;}
   },onError:retire,onClose:reportClose});
  if(dialog.failed||dialog.closed)retire();else subscribe();
 }catch(error){retire();try{dialog?.dispose();}catch{/* Keep the construction failure. */}throw error;}
 return {element:host,update(next){
  if(disposed)return;
  const changed=next.controller!==props.controller;props=next;if(!operational)return;
  if(changed){unsubscribe?.();unsubscribe=null;subscribe();}render();
 },dispose(){if(disposed)return;disposed=true;retire();dialog?.dispose();}};
}

export function mountLibraryMixPage(host,runtime,initialProps){
 const scope=createNativeOwnerScope();
 let props=initialProps,disposed=false,revision=0,connection=0,unsubscribe=null,rendering=false,renderAgain=false;
 let selected=null,starting=false,message='',displayedView=null,table=null,panel=null;
 let header,title,playButton,orderChoice,saveButton,closeButton,titleInput,description;
 let notes,tableHost,panelHost,resource,mutation,retryHost,savedHost,errorHost;
 let selectionHost,selectionBasisOwner,selectionAutoOwner,selectionApply,selectionCountInput;
 let selectionRecipe=null,selectionBasis='per_artist',selectionCount='3',selectionAuto=false;
 let cleanupFailure=null;
 const release=callback=>{try{callback?.();}catch(error){cleanupFailure??=error;}};
 const own=owner=>{scope.defer(()=>release(()=>owner.dispose()));return owner;};
 const listen=(target,type,callback)=>{target.addEventListener(type,callback);scope.defer(()=>release(()=>target.removeEventListener(type,callback)));};
 const alive=(version,view)=>!disposed&&revision===version&&props===view;
 const rowsFor=state=>{
  const detail=state.resource.data?.detail;
  return !detail?[]:state.playbackOrder==='unplayed_first'?orderUnplayedMixRows(detail.track_rows):detail.track_rows;
 };
 function dispose(){
  if(disposed)return;
  disposed=true;revision++;connection++;
  const stop=unsubscribe;unsubscribe=null;
  const oldTable=table,oldPanel=panel;table=panel=null;
  release(stop);release(()=>oldTable?.dispose());release(()=>oldPanel?.dispose());scope.dispose();
  if(cleanupFailure)throw cleanupFailure;
 }
 function connect(){
  const token=++connection,view=props,old=unsubscribe;unsubscribe=null;
  release(old);
  if(disposed||connection!==token||props!==view)return;
  let acquiring=true,pending=false;
  const notify=()=>{
   if(disposed||connection!==token||props.controller!==view.controller)return;
   if(acquiring){pending=true;return;}
   render();
  };
  const stop=view.controller.subscribe(notify);
  acquiring=false;
  if(disposed||connection!==token||props.controller!==view.controller)release(stop);
  else{unsubscribe=stop;if(pending)notify();}
 }
 function edit(patch){if(!disposed)props.controller.edit(patch);}
 function close(){if(!disposed)props.onClose();}
 async function save(check){
  if(disposed)return;
  const view=props,owner=view.controller;
  const receipt=await(check?owner.retrySave():owner.save());
  if(receipt&&!disposed&&props.controller===owner)await view.onSaved(receipt);
 }
 async function play(){
  if(disposed||starting)return;
  const view=props,version=revision,state=view.controller.getSnapshot();
  if(!alive(version,view))return;
  const detail=state.resource.data?.detail,rows=displayedView?.detail===detail&&displayedView.scopeKey===state.scopeKey?displayedView.rows:rowsFor(state);
  const intent=runtime.trackIntent,can=runtime.canTrackIntent;
  const current=()=>alive(version,view)&&runtime.trackIntent===intent&&runtime.canTrackIntent===can;
  let row;
  try{
   for(const candidate of rows){
    const allowed=can?.call(runtime,'play',candidate,{playlist_id:detail?.playlist_id,scopeKey:state.scopeKey});
    if(!current())return;
    if(allowed===true){row=candidate;break;}
   }
   if(!row||!current())return;
   starting=true;message='';
   const result=intent.call(runtime,'play',row,{playlist_id:detail.playlist_id,scopeKey:state.scopeKey,displayedItemIds:rows.map(item=>item.playlist_item_id),playbackOrder:state.playbackOrder,fromStart:true});
   if(current())render();
   await result;
  }catch(error){if(!disposed&&props.controller===view.controller&&runtime.trackIntent===intent&&error?.name!=='AbortError')message='This mix could not be played.';}
  finally{if(!disposed&&props.controller===view.controller){starting=false;render();}}
 }
 // A child factory owns its host until it returns and is accepted or retired.
 // Nested updates invalidate callbacks immediately, but must not reuse that host yet.
 function render(){
  if(disposed)return;
  if(rendering){revision++;renderAgain=true;return;}
  rendering=true;
  try{
   do{renderAgain=false;renderPass();}while(renderAgain&&!disposed);
  }catch(error){try{dispose();}catch{/* Keep the render failure. */}throw error;}
  finally{rendering=false;}
 }
 function renderPass(){
  if(disposed)return;
  const version=++revision,view=props,current=()=>alive(version,view);
  const state=view.controller.getSnapshot();if(!current())return;
  const detail=state.resource.data?.detail,rows=rowsFor(state),busy=state.mutation.status==='loading',saved=state.mutation.status==='ready';
  const pending=view.controller.pendingSave();if(!current())return;
  const selecting=state.resource.status==='loading';
  if(state.artistScope&&state.recipe!==selectionRecipe&&state.resource.status==='ready'){
   selectionRecipe=state.recipe;selectionBasis=state.recipe.selection_basis;
   selectionCount=String(state.recipe.songs_per_group);selectionAuto=state.recipe.auto_update;
  }
  const selectedOptions=normalizeMixRecipe({selection_basis:selectionBasis,
   songs_per_group:/^\d+$/.test(selectionCount)?Number(selectionCount):null,
   auto_update:selectionAuto,playback_order:state.playbackOrder});
  const selectionDirty=Boolean(state.artistScope&&(!selectedOptions||JSON.stringify({...selectedOptions,playback_order:state.recipe?.playback_order})!==JSON.stringify(state.recipe)));
  if(selectionHost){
  selectionHost.hidden=!state.artistScope;
  const selectionBusy=busy||saved||pending||selecting;
  selectionBasisOwner.update({label:'Choose songs',value:selectionBasis,disabled:selectionBusy,
   options:[['per_artist','Per artist'],['per_album','Per album']],onChange:value=>{if(current()){selectionBasis=value;render();}}});if(!current())return;
  selectionAutoOwner.update({label:'Update automatically when saved',value:selectionAuto?'on':'off',disabled:selectionBusy,
   options:[['off','Off'],['on','On']],onChange:value=>{if(current()){selectionAuto=value==='on';render();}}});if(!current())return;
  selectionCountInput.disabled=selectionBusy;if(selectionCountInput.value!==selectionCount)selectionCountInput.value=selectionCount;
  selectionApply.update({label:'Update selection',disabled:selectionBusy||!selectionDirty||!selectedOptions,
   onClick:()=>{if(current())view.controller.prepare(selectedOptions);}});if(!current())return;
  }
  const canSave=view.controller.canSave();if(!current())return;
  title.textContent=state.title||'Library Mix';
  header.update({id:'library-mix',className:'playlists__header'});if(!current())return;
  playButton.update({label:'Play',icon:'play',disabled:starting||!detail?.allowed_actions.can_play||!rows.length,onClick:play});if(!current())return;
  orderChoice.update({label:'Playback order',value:state.playbackOrder,options:MIX_ORDER_OPTIONS,disabled:busy||saved||pending,onChange:value=>{if(current())view.controller.setOrder(value);}});if(!current())return;
  saveButton.update({label:'Save as playlist',icon:'save',disabled:!canSave||selectionDirty,onClick:()=>save(false)});if(!current())return;
  closeButton.update({label:'Close mix',icon:'close',disabled:busy,onClick:close});if(!current())return;
  titleInput.disabled=description.disabled=Boolean(busy||saved||pending);
  if(titleInput.value!==state.title)titleInput.value=state.title||'';
  if(description.value!==state.description)description.value=state.description||'';
  notes.replaceChildren();
  const note=text=>{const p=node(notes,'p','playlists__note');p.setAttribute('role','status');p.textContent=text;};
  note(`Temporary mix · ${rows.length} songs · Last.fm global plays${state.recipe?.auto_update?' · Auto-updating after save; generated membership is locked':' · Save keeps this selection'}`);
  if(state.artistScope)note('Saved scope keeps these selected Artist IDs. Automatic updates are optional; new family members are not added.');
  if(state.selectionError)note('The selection could not be updated. The previous captured list is retained.');
  if(Number.isSafeInteger(state.coverage.excluded_count))note(`${state.coverage.excluded_count} local tracks excluded because popularity or grouping could not be resolved.`);
  if(['queued','running'].includes(state.popularityRefreshStatus))note('Last.fm popularity refresh is in progress. This temporary mix keeps its captured selection; create another mix later to use newly resolved counts.');
  if(state.popularityRefreshStatus==='blocked'||state.popularityRefreshError)note(`${state.popularityRefreshError==='not_configured'?'Last.fm popularity refresh is not configured.':'Last.fm popularity refresh is unavailable.'} Resolved cached counts are still used.`);
  if(!rows.length&&detail)note('No local songs with resolved Last.fm popularity match this mix.');
  if(detail){
   const tableProps={rows,detail,controller:view.controller,state,selected,currentItemId:null,
    onSelect:row=>{if(current()){selected=row.row_key;render();}},onError:value=>{if(current()){message=value;render();}},onDisplayedRowsChange:value=>{if(current())displayedView=value;}};
   if(table)table.update(tableProps);
   else{const next=mountPlaylistTracks(tableHost,runtime,tableProps);if(!current()){release(()=>next.dispose());return;}table=next;}
  }else{const old=table;table=null;displayedView=null;release(()=>old?.dispose());}
  if(!current())return;
  const row=rows.find(item=>item.row_key===selected);
  if(row){
   const panelProps={scopeKey:state.scopeKey,row,readDetail:view.readDetail,onClose:()=>{if(current()){selected=null;render();}}};
   if(panel)panel.update(panelProps);
   else{const next=mountPlaylistSelectionPanel(panelHost,runtime,panelProps);if(!current()){release(()=>next.dispose());return;}panel=next;}
  }else{const old=panel;panel=null;release(()=>old?.dispose());}
  if(!current())return;
  resource.update({value:state.resource,label:'Library Mix'});if(!current())return;
  mutation.update({value:state.mutation,label:'Saving playlist'});if(!current())return;
  mutation.element.hidden=state.mutation.status==='idle';retryHost.hidden=!pending||busy;savedHost.hidden=!saved;
  const html=message?runtime.alertHtml({severity:'error',role:'alert',message}):'';
  if(current())errorHost.innerHTML=html;
 }
 try{
  scope.defer(()=>release(()=>host.replaceChildren()));
  const page=node(host,'main','playlists__content');page.setAttribute('aria-label','Temporary Library Mix');
  header=own(mountSharedHeader(node(page),runtime,{id:'library-mix',className:'playlists__header'}));
  title=node(header.slots.content,'div','gallery-bar__title');
  playButton=own(mountButton(node(header.slots.actions),runtime,{label:'Play',icon:'play',onClick:play}));
  orderChoice=own(mountChoice(node(header.slots.actions),runtime,{label:'Playback order',value:'regular',options:MIX_ORDER_OPTIONS}));
  saveButton=own(mountButton(node(header.slots.actions),runtime,{label:'Save as playlist',icon:'save',onClick:()=>save(false)}));
  closeButton=own(mountButton(node(header.slots.finalAction),runtime,{label:'Close mix',icon:'close',onClick:close}));
  const scroll=node(page,'div','playlists__scroll gallery-scrollbar'),metadata=node(scroll,'div','playlists__metadata tag-editor-form');
  const titleLabel=node(metadata,'label');titleLabel.append('Title');titleInput=node(titleLabel,'input');titleInput.maxLength=100;titleInput.setAttribute('aria-label','Playlist title');
  listen(titleInput,'input',()=>edit({title:titleInput.value}));
  const descriptionLabel=node(metadata,'label');descriptionLabel.append('Description');description=node(descriptionLabel,'textarea');description.rows=2;description.maxLength=1000;description.setAttribute('aria-label','Playlist description');
  listen(description,'input',()=>edit({description:description.value}));
  if(props.controller.getSnapshot().artistScope){
  selectionHost=node(scroll,'div','playlists__metadata tag-editor-form');selectionHost.hidden=true;
  selectionBasisOwner=own(mountChoice(node(selectionHost),runtime,{label:'Choose songs',value:selectionBasis,options:[['per_artist','Per artist'],['per_album','Per album']]}));
  const countLabel=node(selectionHost,'label');countLabel.append('Songs per group');selectionCountInput=node(countLabel,'input');
  Object.assign(selectionCountInput,{type:'number',min:'1',max:'5000',step:'1',value:'3'});selectionCountInput.setAttribute('aria-label','Songs per group');
  listen(selectionCountInput,'input',()=>{selectionCount=selectionCountInput.value;render();});
  selectionAutoOwner=own(mountChoice(node(selectionHost),runtime,{label:'Update automatically when saved',value:'off',options:[['off','Off'],['on','On']]}));
  selectionApply=own(mountButton(node(selectionHost),runtime,{label:'Update selection'}));
  }
  notes=node(scroll);tableHost=node(scroll);panelHost=node(scroll);
  resource=own(mountStatus(node(scroll),runtime,{value:{status:'idle'},label:'Library Mix'}));
  mutation=own(mountStatus(node(scroll),runtime,{value:{status:'idle'},label:'Saving playlist'}));
  retryHost=node(scroll);savedHost=node(scroll);errorHost=node(scroll);
  own(mountButton(retryHost,runtime,{label:'Check original save',onClick:()=>save(true)}));
  own(mountButton(savedHost,runtime,{label:'Open saved playlist',onClick:()=>{if(!disposed)props.onSaved(props.controller.getSnapshot().mutation.data);}}));
  connect();render();
 }catch(error){try{dispose();}catch{/* Preserve the construction failure. */}throw error;}
 return {element:host,update(next){
  if(disposed)return;
  const changed=next.controller!==props.controller;props=next;revision++;
  try{if(changed){starting=false;displayedView=null;connect();}render();}
  catch(error){try{dispose();}catch{/* Keep the update failure. */}throw error;}
 },dispose};
}

export function mountSavedLibraryMixOrder(host,runtime,initial){
 const scope=createNativeOwnerScope();
 let props=initial,disposed=false,choice=null,starting=false,message='',generation=0,revision=0;
 let active=null,button,select,errorHost;
 let cleanupFailure=null;
 const release=callback=>{try{callback?.();}catch(error){cleanupFailure??=error;}};
 const own=owner=>{scope.defer(()=>release(()=>owner.dispose()));return owner;};
 const current=owner=>!disposed&&active===owner&&owner.generation===generation;
 function disconnect(){const old=active;active=null;if(!old)return;release(()=>old.abort.abort());const stop=old.stop;old.stop=null;release(stop);}
 function dispose(){if(disposed)return;disposed=true;generation++;revision++;disconnect();scope.dispose();if(cleanupFailure)throw cleanupFailure;}
 function connect(){
  const token=++generation;disconnect();
  if(disposed||generation!==token)return;
  const view=props,owner={generation:token,abort:new AbortController(),stop:null,notifications:0};active=owner;
  choice=null;
  const scopeKey=view.scopeKey,playlistId=view.detail.playlist_id;
  const accept=value=>{
   if(!current(owner)||value?.status!=='ready'||value.data?.scopeKey!==scopeKey||value.data.playlist_id!==playlistId||!mixOrder(value.data.library_mix_order))return;
   choice={scopeKey,playlistId,mode:value.data.library_mix_order};render();
  };
  let acquiring=true;const pending=[];
  const notify=value=>{
   if(!current(owner))return;
   if(acquiring){pending.push(value);return;}
   owner.notifications++;
   try{accept(value);}catch(error){try{dispose();}catch{/* Keep the publication failure. */}throw error;}
  };
  const stop=runtime.subscribePlayback?.({scopeKey,playlist_id:playlistId,onChange:notify});
  acquiring=false;
  if(!current(owner)){release(stop);return;}
  owner.stop=stop;
  for(const value of pending){if(!current(owner))break;notify(value);}
  if(!current(owner))return;
  const before=owner.notifications;
  const result=runtime.readPlayback?.({scopeKey,playlist_id:playlistId,signal:owner.abort.signal});
  Promise.resolve(result).then(value=>{if(current(owner)&&owner.notifications===before)accept(value);}).catch(()=>{});
 }
 async function play(){
  if(disposed||starting||!choice||props.detail.allowed_actions.can_play!==true)return;
  const owner=active,view=props,version=revision,intent=runtime.trackIntent,can=runtime.canTrackIntent;
  const valid=()=>current(owner)&&props===view&&revision===version&&runtime.trackIntent===intent&&runtime.canTrackIntent===can;
  const rows=view.rows||view.detail.track_rows;
  let claimedBusy=false;
  try{
   let first;
   for(const row of rows){const allowed=can?.call(runtime,'play',row,{scopeKey:view.scopeKey,playlist_id:view.detail.playlist_id});if(!valid())return;if(allowed===true){first=row;break;}}
   if(!first||!valid())return;
   starting=true;claimedBusy=true;message='';
   const result=intent.call(runtime,'play',first,{scopeKey:view.scopeKey,playlist_id:view.detail.playlist_id,displayedItemIds:rows.map(row=>row.playlist_item_id),fromStart:true});
   if(valid())render();
   await result;
  }catch(error){if(current(owner)&&props===view&&runtime.trackIntent===intent&&error?.name!=='AbortError')message='This mix could not be played.';}
  // A current owner may receive new rows/props from its own playback notification.
  // Release only a busy lifetime this invocation actually acquired. A superseded
  // pre-admission callback must not release a reentrant operation, and a retired
  // owner must not release its replacement's operation.
  finally{if(claimedBusy&&current(owner)){starting=false;render();}}
 }
 function render(){
  if(disposed)return;
  const version=++revision,view=props,owner=active,valid=()=>!disposed&&revision===version&&props===view&&active===owner;
  const rows=view.rows||view.detail.track_rows;let first;
  for(const row of rows){const allowed=runtime.canTrackIntent?.('play',row,{scopeKey:view.scopeKey,playlist_id:view.detail.playlist_id});if(!valid())return;if(allowed===true){first=row;break;}}
  const ready=choice?.scopeKey===view.scopeKey&&choice.playlistId===view.detail.playlist_id;
  button.update({label:'Play mix',icon:'play',disabled:!ready||starting||!first||view.detail.allowed_actions.can_play!==true,onClick:play});if(!valid())return;
  select.update({label:'Playback order',value:ready?choice.mode:view.detail.library_mix.playback_order,options:MIX_ORDER_OPTIONS,title:'Order for the next playlist start; saved default is unchanged',disabled:!ready||starting||view.detail.allowed_actions.can_play!==true||typeof runtime.setLibraryMixOrder!=='function',onChange:mode=>{
   if(!valid())return;
   const accepted=runtime.setLibraryMixOrder({scopeKey:view.scopeKey,playlist_id:view.detail.playlist_id,mode});
   if(accepted&&valid()){choice={scopeKey:view.scopeKey,playlistId:view.detail.playlist_id,mode};render();}
  }});if(!valid())return;
  const html=message?runtime.alertHtml({severity:'error',role:'alert',message}):'';
  if(valid())errorHost.innerHTML=html;
 }
 try{
  scope.defer(()=>release(()=>host.replaceChildren()));
  const playHost=node(host,'span'),orderHost=node(host,'span');errorHost=node(host);
  button=own(mountButton(playHost,runtime,{label:'Play mix',icon:'play'}));
  select=own(mountChoice(orderHost,runtime,{label:'Playback order',value:props.detail.library_mix.playback_order,options:MIX_ORDER_OPTIONS}));
  connect();render();
 }catch(error){try{dispose();}catch{/* Preserve the construction failure. */}throw error;}
 return {element:host,update(next){
  if(disposed)return;
  const changed=next.scopeKey!==props.scopeKey||next.detail!==props.detail;
  props=next;revision++;
  try{if(changed){starting=false;connect();}render();}
  catch(error){try{dispose();}catch{/* Keep the update failure. */}throw error;}
 },dispose};
}
