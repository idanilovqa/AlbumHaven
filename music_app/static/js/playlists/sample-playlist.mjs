import {normalizePlaylistPayload} from './model.mjs';
import {normalizeSampleOptions, isSampleInventoryRef, normalizeSampleOrigin, normalizeSampleSelector,
  isSampleSelectionMethod, normalizeSampleFacetMask, normalizeSampleCountryTargets, sampleJsonWithin,
  normalizeSampleFacetDiscovery, normalizeSampleCountryMetadata} from './sample-playlist-input.mjs';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const revision = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && (value.length < 19 || value.length === 19 && value <= '9223372036854775807');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const freeze = value => Object.freeze(value);
const PROTOCOL = 'sample_playlist_selection_v1';
function project(value, scopeKey, intent) {
  const data = value?.status === 'ready' ? value.data : null;
  if (!data || data.scopeKey !== scopeKey || data.source_protocol !== PROTOCOL || data.source?.kind !== (intent.origin ? 'library' : 'playlist')
    || !uuid(data.source.ref) || !uuid(data.source.revision) || data.source.ref !== intent.request_key
    || data.mode !== 'ordinary' || data.entries_complete !== true || data.allowed_actions?.can_read !== true
    || !same(normalizeSampleOptions(data.options), intent.options) || !Array.isArray(data.entries) || data.entries.length > 5000)
    throw new TypeError('Sample capture was not acknowledged.');
  const refs = data.entries.map(row => row?.entry_ref);
  if (refs.some(ref => !uuid(ref)) || new Set(refs).size !== refs.length || data.entries.some(row => row.allowed_actions?.can_read !== true))
    throw new TypeError('Sample membership changed.');
  const nativeActions = freeze({can_save: data.native_actions?.can_save === true && refs.length > 0,
    can_play: data.native_actions?.can_play === true && refs.length > 0});
  const projection = normalizePlaylistPayload({playlist_sidebar:{items:[]}, playlist_detail:{
    playlist_id:data.source.ref, revision:data.source.revision, title:'Sample Playlist', description:'',
    items_complete:true, active_sort:{key:'playlist_position',direction:'asc'},
    allowed_actions:{can_open:true,can_play:nativeActions.can_play},
    track_rows:data.entries.map((row,index) => ({...row,playlist_item_id:row.entry_ref,playlist_position:index,
      source_readable:true,allowed_actions:{can_play:row.native_actions?.can_play === true},
      album_ref:row.parent_album?.album_ref ?? row.album_ref}))}});
  const detail = freeze({...projection.detail,native_actions:nativeActions,
    track_rows:freeze(projection.detail.track_rows.map((row,index) => freeze({...row,
      native_actions:freeze({can_play:data.entries[index].native_actions?.can_play === true})})))});
  return freeze({source:freeze({...data.source}),source_protocol:PROTOCOL,entry_refs:freeze(refs),detail,
    native_actions:nativeActions,diagnostics:data.diagnostics || [],source_diagnostics:data.source_diagnostics || [],
    ...(intent.origin ? {origin_diagnostics:data.origin_diagnostics || []} : {}),
    group_counts:data.group_counts || [],expires_at:data.expires_at});
}
export function createSamplePlaylistController({providers,scopeKey,isCurrent,isFacetActive,requestKey=()=>crypto.randomUUID(),random=Math.random,shuffleCopy}) {
  let disposed=false, serial=0, pending=null, intent=null, uncertain=false, saved=false;
  let facetSerial=0,discovery=null,acquisition=null,discoveryIntent=null;
  const listeners=new Set();
  const emptyTargets=freeze([]);
  const idleFacets=()=>freeze({status:'idle',data:null,error:null});
  const metadata=(status='idle',selectedTargets=emptyTargets,results=null,error=null)=>freeze({status,selectedTargets,results,error});
  let state=freeze({scopeKey,selectedPlaylistId:null,drafts:freeze({}),filters:freeze({}),resource:freeze({status:'idle',data:null}),mutation:freeze({status:'idle'}),
    title:'Sample Playlist',description:'',dirty:false,facetDiscovery:idleFacets(),countryMetadata:metadata()});
  const alive=()=>!disposed&&isCurrent()===true;
  const owns=token=>alive()&&token===serial;
  const publish=patch=>{if(!alive())return;state=freeze({...state,...patch});for(const listener of [...listeners])listener();};
  const source=()=>alive()&&state.resource.status==='ready'?state.resource.data:null;
  const pendingSave=()=>uncertain||providers.hasPendingPlaylistOperation?.({scopeKey,action:'create'})===true;
  const busy=()=>Boolean(pending||discovery||acquisition);
  const facetActive=()=>{try{return alive()&&typeof isFacetActive==='function'&&isFacetActive()===true;}catch{return false;}};
  const facetAdmission=()=>typeof scopeKey==='string'&&Boolean(scopeKey)&&facetActive()&&!saved&&!pendingSave()&&state.mutation.status!=='loading';
  const facetOwns=operation=>alive()&&operation.token===facetSerial;
  // Inactive retained forms may keep a truthful warning, but a late response
  // must never repaint them. Save continues to use its original lifetime owner.
  function publishFacet(patch){
    if(!alive())return;
    if(facetActive())publish(patch);else state=freeze({...state,...patch});
  }
  function retireFacets(){
    const lost=acquisition?.invoked===true;
    facetSerial++;discovery?.abort.abort();acquisition?.abort.abort();
    discovery=null;acquisition=null;discoveryIntent=null;
    const previous=state.countryMetadata,warning=lost||previous.status==='uncertain';
    return {facetDiscovery:idleFacets(),countryMetadata:metadata(warning?'uncertain':'idle',emptyTargets,null,warning?previous.error:null)};
  }
  function begin(){const token=++serial;pending=new AbortController();return {token,signal:pending.signal};}
  function end(token){if(token===serial){pending=null;if(alive())publish({});}}
  function failed(error,token,kind){if(owns(token))publish({[kind]:freeze({status:[401,403].includes(error?.status)?'denied':'error',error})});}
  async function capture(recover=false){
    if(!alive()||busy()||!intent||pendingSave()||saved)return false;
    const {token,signal}=begin();publish({resource:freeze({status:'loading',data:null})});
    try{
      const value=await (recover?providers.readSamplePlaylist({scopeKey,request_key:intent.request_key,signal})
        :providers.captureSamplePlaylist({...intent,scopeKey,signal}));
      if(!owns(token))return false;
      const valueSource=project(value,scopeKey,intent);publish({selectedPlaylistId:valueSource.source.ref,resource:freeze({status:'ready',data:valueSource})});return true;
    }catch(error){failed(error,token,'resource');return false;}finally{end(token);}
  }
  function acceptSave(value,key){
    const receipt=value?.data||value;
    if(!receipt||receipt.scopeKey!==scopeKey||receipt.action!=='create'||!uuid(receipt.playlist_id)
      || !uuid(receipt.request_key)||key&&receipt.request_key!==key)throw new TypeError('Sample Save was not acknowledged.');
    saved=true;uncertain=false;publish({mutation:freeze({status:'ready',action:'create',data:receipt}),dirty:false});return receipt;
  }
  const controller={
    getSnapshot:()=>state,source,pendingSave,reorder:()=>false,
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    canUseFacets:()=>facetAdmission()&&!pending&&!acquisition,
    async discoverFacets(input){
      if(!facetAdmission()||pending||acquisition||typeof providers.readSamplePlaylistFacets!=='function')return false;
      const selector=normalizeSampleSelector(input?.source),facets=normalizeSampleFacetMask(input?.facets),
        selectionMethod=input?.selectionMethod;
      if(!selector||!facets||!isSampleSelectionMethod(selectionMethod)
        ||!sampleJsonWithin({...selector,selection_method:selectionMethod,facets},32768))return false;
      discovery?.abort.abort();
      const operation={token:++facetSerial,abort:new AbortController()};
      const request=freeze({source:selector,selectionMethod,facets,scopeKey,generation:operation.token});
      discovery=operation;discoveryIntent=null;
      publishFacet({facetDiscovery:freeze({status:'loading',data:null,error:null}),
        countryMetadata:freeze({...state.countryMetadata,selectedTargets:emptyTargets})});
      try{
        await Promise.resolve();
        if(!facetOwns(operation)||discovery!==operation||!facetActive()||operation.abort.signal.aborted)return false;
        const response=await providers.readSamplePlaylistFacets({source:request.source,selectionMethod:request.selectionMethod,
          facets:request.facets,scopeKey,signal:operation.abort.signal});
        if(!facetOwns(operation)||discovery!==operation||!facetActive()||operation.abort.signal.aborted)return false;
        const data=response?.status==='ready'
          ?normalizeSampleFacetDiscovery(response.data,request.selectionMethod,request.facets,scopeKey):null;
        if(!data)throw new TypeError('Sample facets were not acknowledged.');
        if(!facetOwns(operation)||discovery!==operation||operation.abort.signal.aborted||!facetActive())return false;
        discoveryIntent=request;discovery=null;
        publish({facetDiscovery:freeze({status:'ready',data,error:null}),
          countryMetadata:freeze({...state.countryMetadata,selectedTargets:emptyTargets})});
        return true;
      }catch(error){
        if(facetOwns(operation)&&discovery===operation){
          discovery=null;discoveryIntent=null;
          publishFacet({facetDiscovery:freeze({status:[401,403].includes(error?.status)?'denied':'error',data:null,error})});
        }
        return false;
      }finally{
        if(facetOwns(operation)&&discovery===operation){
          discovery=null;discoveryIntent=null;
          publishFacet({facetDiscovery:idleFacets()});
        }
      }
    },
    setCountryMetadataTargets(targets){
      if(!facetAdmission()||busy()||!discoveryIntent||discoveryIntent.generation!==facetSerial
        ||state.facetDiscovery.status!=='ready')return false;
      const data=state.facetDiscovery.data,country=data?.facets.countries;
      if(data?.allowed_actions.enrich_country!==true||country?.status!=='ready')return false;
      const normalized=normalizeSampleCountryTargets(targets,{minimum:0});
      if(!normalized)return false;
      let previous=-1;
      for(const pair of normalized){
        const index=country.enrichment_targets.findIndex(offered=>offered.track_ref===pair.track_ref&&offered.primary_artist_ref===pair.primary_artist_ref);
        if(index<=previous)return false;previous=index;
      }
      publishFacet({countryMetadata:freeze({...state.countryMetadata,selectedTargets:normalized})});return true;
    },
    async loadCountryMetadata(){
      if(!facetAdmission()||busy()||!discoveryIntent||discoveryIntent.generation!==facetSerial
        ||state.facetDiscovery.status!=='ready'||state.facetDiscovery.data?.allowed_actions.enrich_country!==true
        ||state.facetDiscovery.data.facets.countries?.status!=='ready'
        ||typeof providers.enrichSamplePlaylistCountryMetadata!=='function')return false;
      const targets=normalizeSampleCountryTargets(state.countryMetadata.selectedTargets);
      if(!targets)return false;
      const request=discoveryIntent;
      if(!sampleJsonWithin({...request.source,selection_method:request.selectionMethod,targets},32768))return false;
      const operation={token:++facetSerial,abort:new AbortController(),invoked:false};
      acquisition=operation;discoveryIntent=null;
      publishFacet({facetDiscovery:idleFacets(),countryMetadata:metadata('loading')});
      try{
        // Allows cancellation or suspension before dispatch, including listeners
        // responding synchronously to the loading state, without claiming writes.
        await Promise.resolve();
        if(!facetOwns(operation)||acquisition!==operation||!facetActive()||operation.abort.signal.aborted)return false;
        operation.invoked=true;
        const response=await providers.enrichSamplePlaylistCountryMetadata({source:request.source,
          selectionMethod:request.selectionMethod,targets,scopeKey,signal:operation.abort.signal});
        if(!facetOwns(operation)||acquisition!==operation)return false;
        if(!facetActive()||operation.abort.signal.aborted)throw new Error('Country metadata outcome is uncertain.');
        const data=response?.status==='ready'
          ?normalizeSampleCountryMetadata(response.data,request.selectionMethod,targets,scopeKey):null;
        if(!data)throw new TypeError('Country metadata result was not acknowledged.');
        if(!facetOwns(operation)||acquisition!==operation)return false;
        if(operation.abort.signal.aborted||!facetActive())throw new Error('Country metadata outcome is uncertain.');
        acquisition=null;
        publish({countryMetadata:metadata('ready',emptyTargets,data.results)});return true;
      }catch(error){
        if(facetOwns(operation)&&acquisition===operation){
          acquisition=null;
          publishFacet({countryMetadata:metadata(operation.invoked?'uncertain':'idle',emptyTargets,null,error),
            ...([401,403].includes(error?.status)?{facetDiscovery:freeze({status:'denied',data:null,error})}:{})});
        }
        return false;
      }finally{
        if(facetOwns(operation)&&acquisition===operation){
          acquisition=null;
          publishFacet({countryMetadata:metadata(operation.invoked?'uncertain':'idle')});
        }
      }
    },
    cancelCountryMetadata(){
      if(!alive()||!acquisition)return false;
      const operation=acquisition;facetSerial++;acquisition=null;discoveryIntent=null;operation.abort.abort();
      publishFacet({facetDiscovery:idleFacets(),countryMetadata:metadata(operation.invoked?'uncertain':'idle')});return true;
    },
    invalidateOptions({reason}={}){
      if(!alive()||!['edit','source','suspend'].includes(reason))return false;
      const protectedSave=state.mutation.status==='loading'||pendingSave();
      if(reason==='edit'&&(protectedSave||saved))return false;
      const patch=retireFacets();
      if(reason!=='suspend'){
        intent=null;
        if(!protectedSave){
          serial++;pending?.abort();pending=null;
          Object.assign(patch,{selectedPlaylistId:null,resource:freeze({status:'idle',data:null})});
        }
      }
      publish(patch);return true;
    },
    canSave:()=>Boolean(alive()&&!busy()&&!saved&&!pendingSave()&&source()?.native_actions.can_save&&state.title.trim()
      &&state.title.length<=100&&state.description.length<=1000&&typeof providers.createPlaylistFromSelection==='function'),
    edit(patch){if(!alive()||busy()||saved||pendingSave())return false;
      if(Object.keys(patch).some(key=>!['title','description'].includes(key))||Object.values(patch).some(value=>typeof value!=='string'))return false;
      publish({...patch,dirty:true});return true;},
    async generate(input){
      if(!alive()||busy()||pendingSave()||saved)return false;
      const normalized=normalizeSampleOptions(input?.options),parent=input?.parent,typed=Object.hasOwn(input || {},'origin');
      const origin=typed ? normalizeSampleOrigin(input.origin) : null;
      if(!normalized || (typed ? !origin || Object.hasOwn(input,'parent') : !uuid(parent?.playlist_ref)||!revision(parent?.revision)))return false;
      const key=requestKey();if(!uuid(key))return false;
      const sourceInput=typed ? {origin} : {playlist_ref:parent.playlist_ref,revision:parent.revision};
      const next={...sourceInput,options:normalized,request_key:key,random_order:null};
      intent=null; // A deliberate new generation retires any older capture command.
      const facetPatch=retireFacets();
      const {token,signal}=begin();publish({...facetPatch,resource:freeze({status:'loading',data:null})});
      try{
        if(normalized.selection_method==='random'){
          if(typeof shuffleCopy!=='function')throw new TypeError('Sample shuffle is unavailable.');
          const response=await providers.readSamplePlaylistRepresentatives({scopeKey,...sourceInput,options:normalized,signal});
          if(!owns(token))return false;
          const data=response?.status==='ready'?response.data:null,refs=data?.representative_refs;
          if(!data||data.scopeKey!==scopeKey||(typed ? Object.hasOwn(data,'parent') || !same(normalizeSampleOrigin(data.origin),origin) : Object.hasOwn(data,'origin') || !same(data.parent,{playlist_ref:next.playlist_ref,revision:next.revision}))
            ||!same(normalizeSampleOptions(data.options),normalized)||(data.library_ref ?? data.actor_scope?.library_id)==null||!Array.isArray(refs)||refs.length>5000
            ||refs.some(ref=>!isSampleInventoryRef(ref,data.library_ref ?? data.actor_scope?.library_id))||new Set(refs).size!==refs.length)
            throw new TypeError('Sample representatives changed.');
          const shuffled=shuffleCopy(freeze([...refs]),random),members=new Set(refs);
          if(!Array.isArray(shuffled)||shuffled.length!==refs.length||new Set(shuffled).size!==refs.length
            ||Array.from(shuffled).some(ref=>!members.has(ref)))throw new TypeError('Sample shuffle changed membership.');
          next.random_order=freeze([...shuffled]);
        }
        if(!owns(token))return false;
        intent=freeze(next);
        const response=await providers.captureSamplePlaylist({...intent,scopeKey,signal});
        if(!owns(token))return false;
        const valueSource=project(response,scopeKey,intent);
        publish({selectedPlaylistId:valueSource.source.ref,resource:freeze({status:'ready',data:valueSource})});return true;
      }catch(error){failed(error,token,'resource');return false;}finally{end(token);}
    },
    retryCapture:()=>capture(false),recoverCapture:()=>capture(true),
    async save(){
      if(!controller.canSave())return false;
      const selected=source(),key=requestKey();if(!uuid(key))return false;
      const body={scopeKey,mode:'ordinary',source_protocol:PROTOCOL,source:{...selected.source},entry_refs:[...selected.entry_refs],
        title:state.title,description:state.description,request_key:key};
      const {token,signal}=begin();publish({mutation:freeze({status:'loading',action:'create'})});
      try{const value=await providers.createPlaylistFromSelection({...body,signal});if(!owns(token))return false;return acceptSave(value,key);}
      catch(error){if(owns(token))uncertain=error?.responseRejected!==true;failed(error,token,'mutation');return false;}finally{end(token);}
    },
    async recoverSave(){
      if(!alive()||busy()||saved||!pendingSave()||typeof providers.recoverPlaylistCreation!=='function')return false;
      const {token,signal}=begin();publish({mutation:freeze({status:'loading',action:'create'})});
      try{const value=await providers.recoverPlaylistCreation({scopeKey,signal});if(!owns(token)||!value)return false;return acceptSave(value);}
      catch(error){failed(error,token,'mutation');return false;}finally{end(token);}
    },
    dispose(){if(disposed)return;disposed=true;serial++;facetSerial++;pending?.abort();discovery?.abort.abort();acquisition?.abort.abort();
      pending=null;discovery=null;acquisition=null;discoveryIntent=null;listeners.clear();}
  };
  return freeze(controller);
}
