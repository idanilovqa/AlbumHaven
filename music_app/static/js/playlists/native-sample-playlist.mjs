import {createNativeOwnerScope} from './native-owner-scope.mjs';
import {mountButton,mountChoice,mountStatus} from '../home-friends/native-controls.mjs';
import {mountPlaylistTracks} from './native-track-table.mjs';
import {mountPlaylistFilterSurface} from './native-filter-surface.mjs';
import {HOME_PHONE_QUERY} from '../home-friends/presentation.mjs';
import {normalizeSampleOptions,normalizeSampleSelector,isSampleSelectionMethod,compareSampleScalars} from './sample-playlist-input.mjs';
const node=(host,tag='div')=>{const value=host.ownerDocument.createElement(tag);host.append(value);return value;};
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const emptyOptions=()=>({selection_basis:null,songs_per_group:null,unknown_facets:null,selection_method:null,length:null,styles:null,countries:null});
const optionRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const copyArray=value=>Object.assign(value.slice(),value);
function copySuppliedOptions(value){
  if(!optionRecord(value))return Array.isArray(value)?copyArray(value):value;
  return {...value,...(Array.isArray(value.styles)?{styles:copyArray(value.styles)}:{}),
    ...(Array.isArray(value.countries)?{countries:copyArray(value.countries)}:{})};
}
const selector=props=>normalizeSampleSelector(props.origin?{origin:props.origin}:props.parent);
const targetKey=pair=>JSON.stringify([pair.track_ref,pair.primary_artist_ref]);
let filterSerial=0;
export function mountSamplePlaylistPage(host,runtime,initial){
  const scope=createNativeOwnerScope();let props=initial,disposed=false,rendering=false,again=false,table=null,unsubscribe=null,starting=false;
  // Only an absent setup receives blank fields and the native quota default.
  // Supplied partial/malformed values retain their missing fields or invalid shape.
  let inputs=props.options===undefined?{...emptyOptions(),songs_per_group:2}:copySuppliedOptions(props.options);
  let sourceSelector=selector(props),suspended=props.suspended===true,filterSurface=null;
  const window=host.ownerDocument.defaultView,phone=()=>window?.matchMedia?.(HOME_PHONE_QUERY)?.matches??window?.innerWidth<=900;
  let filtersOpen=!phone();
  const filterId=`sample-playlist-filters-${++filterSerial}`;
  // Table sorting changes presentation only, never the retained playback order.
  const tableRuntime={...runtime,canTrackIntent(intent,row,options={}){
    const state=props.controller.getSnapshot();
    return !disposed&&!suspended&&state.facetDiscovery.status!=='loading'&&state.countryMetadata.status!=='loading'
      &&runtime.canTrackIntent?.(intent,row,options)===true;
  },trackIntent(intent,row,options={}){
    const source=props.controller.source(),state=props.controller.getSnapshot();
    if(disposed||suspended||state.facetDiscovery.status==='loading'||state.countryMetadata.status==='loading'
      ||intent!=='play'||!source||!source.entry_refs.includes(row?.playlist_item_id))return false;
    return runtime.trackIntent(intent,row,{...options,displayedItemIds:[...source.entry_refs]});
  }};
  const own=value=>{scope.defer(()=>value.dispose());return value;};
  const listen=(el,type,callback)=>{el.addEventListener(type,callback);scope.defer(()=>el.removeEventListener(type,callback));};
  let page=null;
  try{
  page=node(host,'main');page.className='playlists__content';page.setAttribute('aria-label','Temporary Sample Playlist');
  node(page,'h2').textContent='Sample Playlist';
  const controls=node(page),basis=own(mountChoice(node(controls),runtime,{})),method=own(mountChoice(node(controls),runtime,{})),unknown=own(mountChoice(node(controls),runtime,{}));
  const countLabel=node(controls,'label');countLabel.append('Songs per group');const count=node(countLabel,'input');count.type='number';count.min='1';count.step='1';count.setAttribute('aria-label','Songs per group');
  const length=own(mountChoice(node(controls),runtime,{}));
  node(controls,'p').textContent='Unknown duration applies only when Length is restricted. Missing Style or Country metadata stays eligible unless that filter is applied.';
  const change=patch=>{
    if(disposed||suspended)return false;
    const previous=optionRecord(inputs)?inputs:null;
    if(previous&&Object.keys(patch).every(key=>Object.hasOwn(previous,key)&&same(previous[key],patch[key]))){render();return true;}
    if(!props.controller.invalidateOptions({reason:'edit'})){render();return false;}
    // An actual edit supplies only the edited fields, never the omitted defaults.
    inputs={...(previous||{}),...patch};render();return true;
  };
  listen(count,'input',()=>change({songs_per_group:/^[1-9][0-9]*$/.test(count.value)?Number(count.value):null}));
  const facetActions=node(page),refresh=own(mountButton(node(facetActions),runtime,{})),
    filterToggleHost=node(facetActions),filterToggle=own(mountButton(filterToggleHost,runtime,{})),
    load=own(mountButton(node(facetActions),runtime,{})),cancelHost=node(facetActions),
    cancel=own(mountButton(cancelHost,runtime,{})),facetNotes=node(page,'p'),filterHost=node(page);
  scope.defer(()=>filterSurface?.dispose());
  function closeFilters(){const previous=filterSurface;filterSurface=null;filtersOpen=false;previous?.dispose();if(!disposed)render();}
  function mountFacetControls(parent){
    const childScope=createNativeOwnerScope(),ownChild=value=>{childScope.defer(()=>value.dispose());return value;};
    try{
    const choices=node(parent),selectedHost=node(parent),targetHost=node(parent),targetList=node(parent);
    choices.className='playlists__filters playlists__rich-filters tag-editor-form';
    const style=ownChild(mountChoice(node(choices),runtime,{})),addStyle=ownChild(mountButton(node(choices),runtime,{}));
    const country=ownChild(mountChoice(node(choices),runtime,{})),addCountry=ownChild(mountButton(node(choices),runtime,{}));
    const artist=ownChild(mountChoice(node(targetHost),runtime,{})),addArtist=ownChild(mountButton(node(targetHost),runtime,{}));
    const removals=new Map();let styleChoice='',countryChoice='',artistChoice='',lastDiscovery=null,childDisposed=false;
    childScope.defer(()=>{for(const item of removals.values())item.owner.dispose();removals.clear();});
    const patchFacet=(name,identity)=>{
      const values=Array.isArray(inputs?.[name])?inputs[name]:[];
      return change({[name]:identity===null?null:[...values,identity].sort(compareSampleScalars)});
    };
    function targetSelection(keys){
      const available=props.controller.getSnapshot().facetDiscovery.data?.facets.countries?.enrichment_targets||[];
      return props.controller.setCountryMetadataTargets(available.filter(pair=>keys.has(targetKey(pair))));
    }
    function update(){
      if(childDisposed||disposed)return;
      const state=props.controller.getSnapshot(),data=state.facetDiscovery.status==='ready'?state.facetDiscovery.data:null;
      if(data!==lastDiscovery){styleChoice='';countryChoice='';artistChoice='';lastDiscovery=data;}
      const active=!suspended&&props.controller.canUseFacets(),busy=state.facetDiscovery.status==='loading'||state.countryMetadata.status==='loading',
        disabled=!active||busy,targets=state.countryMetadata.selectedTargets,offered=data?.facets.countries?.enrichment_targets||[],
        selectedKeys=new Set(targets.map(targetKey)),permission=data?.allowed_actions.enrich_country===true&&data?.facets.countries?.status==='ready';
      const styles=data?.facets.styles?.status==='ready'?data.facets.styles.choices:[],
        countries=data?.facets.countries?.status==='ready'?data.facets.countries.choices:[];
      const styleValues=Array.isArray(inputs?.styles)?inputs.styles:[],countryValues=Array.isArray(inputs?.countries)?inputs.countries:[];
      const styleAvailable=styles.filter(choice=>!styleValues.includes(choice.identity)),countryAvailable=countries.filter(choice=>!countryValues.includes(choice.identity));
      if(!styleAvailable.some(choice=>choice.identity===styleChoice))styleChoice='';
      if(!countryAvailable.some(choice=>choice.identity===countryChoice))countryChoice='';
      const available=permission?offered.filter(pair=>!selectedKeys.has(targetKey(pair))):[];
      if(!available.some(pair=>targetKey(pair)===artistChoice))artistChoice='';
      style.update({label:'Style',value:styleChoice,disabled:disabled||!styleAvailable.length,
        options:[['','Choose style'],...styleAvailable.map(choice=>[choice.identity,choice.label])],
        onChange:value=>{styleChoice=value;update();}});
      addStyle.update({label:'Add Style',disabled:disabled||!styleChoice,onClick:()=>{
        if(!disabled&&styleAvailable.some(choice=>choice.identity===styleChoice))patchFacet('styles',styleChoice);
      }});
      country.update({label:'Country',value:countryChoice,disabled:disabled||!countryAvailable.length,
        options:[['','Choose country'],...countryAvailable.map(choice=>[choice.identity,choice.label])],
        onChange:value=>{countryChoice=value;update();}});
      addCountry.update({label:'Add Country',disabled:disabled||!countryChoice,onClick:()=>{
        if(!disabled&&countryAvailable.some(choice=>choice.identity===countryChoice))patchFacet('countries',countryChoice);
      }});
      artist.update({label:'Country metadata artists',value:artistChoice,disabled:disabled||!permission||!available.length||targets.length>=25,
        options:[['','Choose artist'],...available.map(pair=>[targetKey(pair),`${pair.primary_artist_ref} · ${pair.track_ref}`])],
        onChange:value=>{artistChoice=value;update();}});
      addArtist.update({label:'Add artist',disabled:disabled||!permission||!artistChoice||targets.length>=25,onClick:()=>{
        if(disabled||!available.some(pair=>targetKey(pair)===artistChoice))return;
        targetSelection(new Set([...selectedKeys,artistChoice]));
      }});
      const wanted=new Map();
      for(const [name,values] of [['styles',styleValues],['countries',countryValues]])for(const identity of values){
        const label=name==='styles'?'Style':'Country';
        wanted.set(`${name}:${identity}`,{host:selectedHost,text:identity,label:`Remove ${label}`,disabled:!active||state.countryMetadata.status==='loading',
          remove:()=>{const next=values.filter(value=>value!==identity);change({[name]:next.length?next:null});}});
      }
      for(const pair of targets)wanted.set(`artist:${targetKey(pair)}`,{host:targetList,
        text:`${pair.primary_artist_ref} · ${pair.track_ref}`,label:'Remove artist',disabled,
        remove:()=>{const next=new Set(selectedKeys);next.delete(targetKey(pair));targetSelection(next);}});
      for(const [key,item] of removals)if(!wanted.has(key)){item.owner.dispose();item.slot.remove();removals.delete(key);}
      const positions=new Map();
      for(const [key,item] of wanted){
        let existing=removals.get(key);
        if(!existing){const slot=node(item.host),text=node(slot,'span'),owner=mountButton(node(slot),runtime,{});
          existing={slot,text,owner};removals.set(key,existing);}
        existing.text.textContent=item.text;existing.owner.update({label:item.label,disabled:item.disabled,onClick:()=>{if(!item.disabled)item.remove();}});
        const position=positions.get(item.host)||0;
        if(item.host.children[position]!==existing.slot)item.host.insertBefore(existing.slot,item.host.children[position]||null);
        positions.set(item.host,position+1);
      }
    }
    update();
    return {update,dispose(){if(childDisposed)return;childDisposed=true;childScope.dispose();parent.replaceChildren();}};
    }catch(error){childScope.dispose();parent.replaceChildren();throw error;}
  }
  const actions=node(page),generate=own(mountButton(node(actions),runtime,{})),play=own(mountButton(node(actions),runtime,{})),save=own(mountButton(node(actions),runtime,{})),close=own(mountButton(node(actions),runtime,{}));
  const titleLabel=node(page,'label');titleLabel.append('Title');const title=node(titleLabel,'input');title.maxLength=100;title.setAttribute('aria-label','Playlist title');listen(title,'input',()=>props.controller.edit({title:title.value}));
  const descriptionLabel=node(page,'label');descriptionLabel.append('Description');const description=node(descriptionLabel,'textarea');description.maxLength=1000;listen(description,'input',()=>props.controller.edit({description:description.value}));
  const notes=node(page),status=own(mountStatus(node(page),runtime,{value:{status:'idle'},label:'Sample Playlist'})),tableHost=node(page);
  const recovery=node(page),recoverCapture=own(mountButton(node(recovery),runtime,{})),retryCapture=own(mountButton(node(recovery),runtime,{})),recoverSave=own(mountButton(node(recovery),runtime,{}));
  const saved=node(page),openSaved=own(mountButton(node(saved),runtime,{}));
  async function saveNow(){const view=props,result=await view.controller.save();if(result&&!disposed&&props.controller===view.controller)await view.onSaved(result);}
  async function playNow(){
    const state=props.controller.getSnapshot();
    if(disposed||suspended||starting||state.facetDiscovery.status==='loading'||state.countryMetadata.status==='loading')return;
    const view=props,source=view.controller.source(),rows=source?.detail.track_rows||[];
    const row=rows[0];if(!row||runtime.canTrackIntent?.('play',row)!==true)return;
    starting=true;render();try{await runtime.trackIntent('play',row,{fromStart:true,displayedItemIds:[...source.entry_refs]});}
    catch{}finally{starting=false;if(!disposed&&props.controller===view.controller)render();}
  }
  function render(){
    if(disposed)return;if(rendering){again=true;return;}rendering=true;
    try{do{again=false;const state=props.controller.getSnapshot(),source=props.controller.source(),
      acquiring=state.countryMetadata.status==='loading',discovering=state.facetDiscovery.status==='loading',
      busy=state.resource.status==='loading'||state.mutation.status==='loading'||acquiring||discovering,
      done=state.mutation.status==='ready',pending=props.controller.pendingSave();
      page.hidden=suspended;
      const disabled=suspended||state.resource.status==='loading'||state.mutation.status==='loading'||acquiring||done||pending;
      basis.update({label:'Choose songs',value:inputs?.selection_basis||'',disabled,options:[['','Choose basis'],['per_album','Per album'],['per_artist','Per artist']],onChange:value=>change({selection_basis:value})});
      method.update({label:'Selection method',value:inputs?.selection_method||'',disabled,options:[['','Choose method'],['most_listened','Most listened'],['random','Random']],onChange:value=>change({selection_method:value||null})});
      unknown.update({label:'Unknown duration',value:inputs?.unknown_facets||'',disabled,options:[['','Choose policy'],['include','Include'],['exclude','Exclude']],onChange:value=>change({unknown_facets:value||null})});
      length.update({label:'Length',value:inputs?.length||'',disabled,options:[['','Unrestricted'],['up_to_3','Up to 3 minutes'],['up_to_5','Up to 5 minutes'],['up_to_8','Up to 8 minutes'],['up_to_10','Up to 10 minutes'],['over_10','Over 10 minutes']],onChange:value=>change({length:value||null})});
      count.disabled=disabled;const countValue=inputs?.songs_per_group==null?'':String(inputs.songs_per_group);if(count.value!==countValue)count.value=countValue;
      const facetAllowed=!suspended&&props.controller.canUseFacets();
      refresh.update({label:'Refresh available values',disabled:!facetAllowed||!sourceSelector||!isSampleSelectionMethod(inputs?.selection_method),
        onClick:()=>props.controller.discoverFacets({source:sourceSelector,selectionMethod:inputs?.selection_method,facets:['styles','countries']})});
      filterToggle.update({label:filtersOpen?'Hide filter values':'Show filter values',disabled:suspended,
        onClick:()=>{if(filtersOpen)closeFilters();else{filtersOpen=true;render();}}});
      const selected=state.countryMetadata.selectedTargets,discovered=state.facetDiscovery.status==='ready'?state.facetDiscovery.data:null;
      load.update({label:'Load Country metadata for selected artists',disabled:!facetAllowed||busy||selected.length<1||selected.length>25
        ||discovered?.allowed_actions.enrich_country!==true||discovered?.facets.countries?.status!=='ready',
        onClick:()=>props.controller.loadCountryMetadata()});
      cancelHost.hidden=!acquiring;cancel.update({label:'Cancel Country metadata loading',disabled:!acquiring,onClick:()=>props.controller.cancelCountryMetadata()});
      const summaries=[];
      if(discovering)summaries.push('Reading stored available values.');
      if(state.facetDiscovery.status==='error'||state.facetDiscovery.status==='denied')summaries.push('Available values could not be read. Refresh explicitly when access is available.');
      for(const name of ['styles','countries']){
        const facet=discovered?.facets[name],label=name==='styles'?'Style':'Country';
        if(facet?.status==='unavailable')summaries.push(`${label} values are unavailable because the source is too large.`);
        if(facet?.status==='ready')summaries.push(`${label}: ${facet.coverage.known} known, ${facet.coverage.unknown} missing from the source, ${facet.coverage.unresolved} not loaded or unresolved.`);
      }
      if(acquiring)summaries.push('Loading Country metadata. Cancellation may leave metadata already saved.');
      if(state.countryMetadata.status==='uncertain')summaries.push('The Country metadata outcome is uncertain; metadata may already have been saved. Refresh available values before making a new explicit selection.');
      if(state.countryMetadata.status==='ready')summaries.push(`Country results acknowledged: ${state.countryMetadata.results.map(result=>`${result.primary_artist_ref} · ${result.track_ref}: ${result.status}`).join('; ')}. Refresh available values to read stored values.`);
      facetNotes.textContent=summaries.join(' ');
      if(filtersOpen&&!suspended){
        if(!filterSurface)filterSurface=mountPlaylistFilterSurface(filterHost,runtime,{id:filterId,mount:mountFacetControls,
          returnFocus:()=>filterToggleHost.querySelector('button'),onClose:closeFilters});
        else filterSurface.update({id:filterId,mount:mountFacetControls,returnFocus:()=>filterToggleHost.querySelector('button'),onClose:closeFilters});
      }
      generate.update({label:'Generate',disabled:disabled||discovering||!normalizeSampleOptions(inputs),onClick:()=>props.controller.generate({... (props.origin ? {origin:props.origin} : {parent:props.parent}),options:inputs})});
      play.update({label:'Play',icon:'play',disabled:suspended||starting||busy||!source?.detail.allowed_actions.can_play||!source.detail.track_rows[0]||runtime.canTrackIntent?.('play',source.detail.track_rows[0])!==true,onClick:playNow});
      save.update({label:'Save as playlist',icon:'save',disabled:!props.controller.canSave(),onClick:saveNow});
      close.update({label:'Back',onClick:()=>{if(props.controller.invalidateOptions({reason:'suspend'}))return props.onClose();}});
      title.disabled=description.disabled=disabled||discovering;if(title.value!==state.title)title.value=state.title;if(description.value!==state.description)description.value=state.description;
      notes.textContent=source?source.entry_refs.length?`${source.entry_refs.length} captured tracks`:'No tracks match this selection.':'';
      if(source?.diagnostics.length)notes.textContent+=' '+source.diagnostics.map(item=>item[1]).join(', ');
      if(source?.origin_diagnostics?.length)notes.textContent+=' '+source.origin_diagnostics.map(item=>item[1]).join(', ');
      status.update({value:state.mutation.status==='error'?state.mutation:state.resource,label:'Sample Playlist'});
      if(source){const tableProps={rows:source.detail.track_rows,detail:source.detail,controller:props.controller,state,selected:null,currentItemId:null,onSelect:()=>{},onError:()=>{}};
        if(table)table.update(tableProps);else table=mountPlaylistTracks(tableHost,tableRuntime,tableProps);
      }else if(table){table.dispose();table=null;}
      recovery.hidden=state.resource.status!=='error'&&!pending;
      recoverCapture.update({label:'Check capture',disabled:busy||pending,onClick:()=>props.controller.recoverCapture()});
      retryCapture.update({label:'Retry original capture',disabled:busy||pending,onClick:()=>props.controller.retryCapture()});
      recoverSave.update({label:'Check original Save',disabled:busy||!pending,onClick:async()=>{const value=await props.controller.recoverSave();if(value&&!disposed)await props.onSaved(value);}});
      saved.hidden=!done;openSaved.update({label:'Open saved playlist',disabled:!done,onClick:()=>props.onSaved(state.mutation.data)});
    }while(again&&!disposed);}finally{rendering=false;}
  }
  unsubscribe=props.controller.subscribe(render);render();
  return {update(next){
    if(disposed)return;
    const nextSelector=selector(next);
    if(!same(nextSelector,sourceSelector)&&!props.controller.invalidateOptions({reason:'source'}))return;
    sourceSelector=nextSelector;props=next;suspended=next.suspended===true;render();
  },setSuspended(value){
    if(disposed||suspended===value)return;suspended=value===true;
    if(suspended&&phone())closeFilters();
    render();
  },dispose(){
    if(disposed)return;disposed=true;unsubscribe?.();props.controller.invalidateOptions({reason:'suspend'});
    table?.dispose();scope.dispose();page.remove();
  }};
  }catch(error){unsubscribe?.();table?.dispose();scope.dispose();page?.remove();throw error;}
}
