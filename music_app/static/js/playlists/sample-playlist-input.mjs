const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = ['selection_basis','songs_per_group','unknown_facets','selection_method','length','styles','countries'];
export function normalizeSampleOptions(value) {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))
    || !['per_album','per_artist'].includes(value.selection_basis)
    || !Number.isSafeInteger(value.songs_per_group) || value.songs_per_group < 1
    || !['include','exclude'].includes(value.unknown_facets) || !['random','most_listened'].includes(value.selection_method)
    || value.length !== null && !['up_to_3','up_to_5','up_to_8','up_to_10','over_10'].includes(value.length)
    || !sampleJsonWithin(value,524288)) return null;
  const styles=normalizeFacetSelection(value.styles,'styles'),countries=normalizeFacetSelection(value.countries,'countries');
  if(styles===undefined||countries===undefined)return null;
  return Object.freeze({...Object.fromEntries(keys.map(key => [key,value[key]])),styles,countries});
}
const maximum = '9223372036854775807';
const decimal = value => /^[1-9][0-9]*$/.test(value) && (value.length < maximum.length || value.length === maximum.length && value <= maximum);
export function isSampleInventoryRef(value, libraryId = undefined) {
  if (typeof value !== 'string') return false;
  const match = /^inventory-track:([1-9][0-9]*):([1-9][0-9]*)$/.exec(value);
  return Boolean(match && decimal(match[1]) && decimal(match[2]) && (libraryId === undefined || match[1] === String(libraryId)));
}

const exactKeys = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value,name));
const canonicalUuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export function isSampleAlbumRef(value, libraryId = undefined) {
  if (typeof value !== 'string') return false;
  const match = /^inventory-album:([1-9][0-9]*):([1-9][0-9]*)$/.exec(value);
  return Boolean(match && decimal(match[1]) && decimal(match[2]) && (libraryId === undefined || match[1] === String(libraryId)));
}
export function normalizeSampleOrigin(value, libraryId = undefined) {
  if (!record(value)) return null;
  if (value.kind === 'album_top') {
    if (!exactKeys(value,['kind','top_ref','revision']) || !canonicalUuid(value.top_ref)
      || typeof value.revision !== 'string' || !decimal(value.revision)) return null;
    return Object.freeze({kind:value.kind,top_ref:value.top_ref,revision:value.revision});
  }
  if (value.kind === 'album_set') {
    if (!exactKeys(value,['kind','selections']) || !Array.isArray(value.selections) || value.selections.length > 5000) return null;
    const selections=[],seen=new Set();
    for (const row of value.selections) {
      if (exactKeys(row,['kind']) && row.kind === 'unavailable') selections.push(Object.freeze({kind:'unavailable'}));
      else if (exactKeys(row,['kind','inventory_album_ref']) && row.kind === 'local'
        && isSampleAlbumRef(row.inventory_album_ref,libraryId) && !seen.has(row.inventory_album_ref)) {
        seen.add(row.inventory_album_ref);selections.push(Object.freeze({kind:'local',inventory_album_ref:row.inventory_album_ref}));
      } else return null;
    }
    return Object.freeze({kind:value.kind,selections:Object.freeze(selections)});
  }
  if (value.kind === 'album_details') {
    if (!exactKeys(value,['kind','track_refs']) || !Array.isArray(value.track_refs) || value.track_refs.length > 5000
      || Array.from(value.track_refs).some(ref=>!isSampleInventoryRef(ref,libraryId)) || new Set(value.track_refs).size !== value.track_refs.length) return null;
    return Object.freeze({kind:value.kind,track_refs:Object.freeze([...value.track_refs])});
  }
  return null;
}

// The wire vocabulary deliberately uses Python's frozen scalar trim set, not
// String.trim (which would also remove U+FEFF), or UTF-16 default sort.
const trimScalar=point=>point>=0x09&&point<=0x0d||point>=0x1c&&point<=0x20
  ||[0x85,0xa0,0x1680,0x2028,0x2029,0x202f,0x205f,0x3000].includes(point)||point>=0x2000&&point<=0x200a;
function dense(value){
  if(!Array.isArray(value)||Object.keys(value).length!==value.length)return false;
  for(let index=0;index<value.length;index++)if(!Object.hasOwn(value,index))return false;
  return true;
}
function scalarBytes(value){
  if(typeof value!=='string')return null;
  let count=0;
  for(const char of value){const point=char.codePointAt(0);
    if(point>=0xd800&&point<=0xdfff)return null;
    count+=point<=0x7f?1:point<=0x7ff?2:point<=0xffff?3:4;
  }
  return count;
}
export function compareSampleScalars(a,b){
  const left=Array.from(a),right=Array.from(b);
  for(let index=0;index<Math.min(left.length,right.length);index++){
    const difference=left[index].codePointAt(0)-right[index].codePointAt(0);if(difference)return difference;
  }
  return left.length-right.length;
}
// Count encoded bytes incrementally. Do not materialize an oversized JSON string.
export function sampleJsonWithin(value,limit){
  let bytes=0;const seen=new Set();
  const add=count=>(bytes+=count)<=limit;
  function string(text){
    if(!add(2))return false;
    for(const char of text){const point=char.codePointAt(0);
      if(point>=0xd800&&point<=0xdfff)return false;
      const size=point===34||point===92||[8,9,10,12,13].includes(point)?2
        :point<32?6:point<=0x7f?1:point<=0x7ff?2:point<=0xffff?3:4;
      if(!add(size))return false;
    }return true;
  }
  function visit(item){
    if(item===null)return add(4);
    if(typeof item==='string')return string(item);
    if(typeof item==='boolean')return add(item?4:5);
    if(typeof item==='number')return Number.isFinite(item)&&add(String(item).length);
    if(typeof item!=='object'||seen.has(item))return false;
    seen.add(item);
    let valid=add(2);
    if(Array.isArray(item)){
      if(!dense(item))return false;
      for(let index=0;valid&&index<item.length;index++)valid=(!index||add(1))&&visit(item[index]);
    }else{
      const names=Object.keys(item);
      for(let index=0;valid&&index<names.length;index++)
        valid=(!index||add(1))&&string(names[index])&&add(1)&&visit(item[names[index]]);
    }
    seen.delete(item);return valid;
  }
  return visit(value);
}
const facetPrefix=name=>name==='styles'?'genre-tag:':'musicbrainz-country:';
function facetToken(identity,name){
  const prefix=facetPrefix(name);
  if(typeof identity!=='string'||!identity.startsWith(prefix))return null;
  const payload=identity.slice(prefix.length),bytes=scalarBytes(payload);
  if(!payload||bytes===null||bytes>1024||trimScalar(payload.codePointAt(0))
    ||trimScalar(Array.from(payload).at(-1).codePointAt(0)))return null;
  return payload;
}
function normalizeFacetSelection(value,name){
  if(value===null)return null;
  if(!dense(value)||!value.length||value.length>5000)return undefined;
  for(let index=0;index<value.length;index++)
    if(facetToken(value[index],name)===null||index&&compareSampleScalars(value[index-1],value[index])>=0)return undefined;
  return Object.freeze([...value]);
}
export function normalizeSampleSelector(value,libraryId=undefined){
  if(exactKeys(value,['playlist_ref','revision'])&&typeof value.playlist_ref==='string'
    &&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.playlist_ref)
    &&typeof value.revision==='string'&&decimal(value.revision))
    return Object.freeze({playlist_ref:value.playlist_ref,revision:value.revision});
  if(exactKeys(value,['origin'])){
    const origin=normalizeSampleOrigin(value.origin,libraryId);
    if(origin)return Object.freeze({origin});
  }
  return null;
}
export const isSampleSelectionMethod=value=>['random','most_listened'].includes(value);
export function normalizeSampleFacetMask(value){
  if(!dense(value)||!['["styles"]','["countries"]','["styles","countries"]'].includes(JSON.stringify(value)))return null;
  return Object.freeze([...value]);
}
const primary=value=>typeof value==='string'&&value.startsWith('musicbrainz-artist:')&&canonicalUuid(value.slice('musicbrainz-artist:'.length));
const compareDecimal=(a,b)=>a.length-b.length||(a<b?-1:a>b?1:0);
const compareTrack=(a,b)=>{
  const left=a.split(':'),right=b.split(':');
  return compareDecimal(left[1],right[1])||compareDecimal(left[2],right[2]);
};
export function normalizeSampleCountryTargets(value,{minimum=1,maximum=25,libraryId=undefined,ordered=false}={}){
  if(!Array.isArray(value)||value.length<minimum||value.length>maximum||!dense(value))return null;
  const seen=new Set(),result=[];
  for(const pair of value){
    if(!exactKeys(pair,['track_ref','primary_artist_ref'])||!isSampleInventoryRef(pair.track_ref,libraryId)
      ||!primary(pair.primary_artist_ref)||seen.has(pair.track_ref)
      ||ordered&&result.length&&compareTrack(result.at(-1).track_ref,pair.track_ref)>=0)return null;
    seen.add(pair.track_ref);result.push(Object.freeze({track_ref:pair.track_ref,primary_artist_ref:pair.primary_artist_ref}));
  }
  return Object.freeze(result);
}
export function isSampleFacetEnvelope(value,context){
  return exactKeys(value,['status','data','context_ref'])&&value.status==='ready'
    &&value.context_ref===context&&sampleJsonWithin(value,524288);
}
export function normalizeSampleFacetDiscovery(value,selectionMethod,mask,scopeKey=undefined){
  const names=normalizeSampleFacetMask(mask),scoped=scopeKey!==undefined;
  if(!names||!isSampleSelectionMethod(selectionMethod)
    ||!exactKeys(value,['selection_method','facets','allowed_actions',...(scoped?['scopeKey']:[])])
    ||scoped&&value.scopeKey!==scopeKey||value.selection_method!==selectionMethod
    ||!exactKeys(value.facets,names)||!exactKeys(value.allowed_actions,['enrich_country'])
    ||typeof value.allowed_actions.enrich_country!=='boolean'
    ||!names.includes('countries')&&value.allowed_actions.enrich_country
    ||!sampleJsonWithin({selection_method:value.selection_method,facets:value.facets,allowed_actions:value.allowed_actions},524288))return null;
  const facets={};let candidateCount=null;
  for(const name of names){
    const field=value.facets[name];
    if(!exactKeys(field,['status','choices','coverage','error','enrichment_targets'])
      ||!Array.isArray(field.choices)||field.choices.length>1024||!dense(field.choices))return null;
    const targets=normalizeSampleCountryTargets(field.enrichment_targets,{minimum:0,maximum:5000,ordered:true});
    if(!targets||!sampleJsonWithin(targets,262144)
      ||(name==='styles'||!value.allowed_actions.enrich_country)&&targets.length)return null;
    if(field.status==='unavailable'){
      if(field.choices.length||field.coverage!==null||field.error!=='source_too_large'||targets.length)return null;
      facets[name]=Object.freeze({status:'unavailable',choices:Object.freeze([]),coverage:null,error:'source_too_large',enrichment_targets:targets});
      continue;
    }
    const coverage=field.coverage;
    if(field.status!=='ready'||field.error!==null||!exactKeys(coverage,['candidate_count','known','unknown','unresolved'])
      ||Object.values(coverage).some(count=>!Number.isSafeInteger(count)||count<0||count>5000)
      ||coverage.known+coverage.unknown+coverage.unresolved!==coverage.candidate_count
      ||candidateCount!==null&&coverage.candidate_count!==candidateCount||targets.length>coverage.candidate_count
      ||Boolean(coverage.known)!==Boolean(field.choices.length)
      ||name==='countries'&&field.choices.length>coverage.known)return null;
    candidateCount=coverage.candidate_count;
    const choices=[];let choiceBytes=0;
    for(const choice of field.choices){
      if(!exactKeys(choice,['identity','label'])||facetToken(choice.identity,name)===null
        ||choice.label!==facetToken(choice.identity,name)
        ||scalarBytes(choice.label)>1024
        ||choices.length&&compareSampleScalars(choices.at(-1).identity,choice.identity)>=0)return null;
      choiceBytes+=scalarBytes(choice.identity)+scalarBytes(choice.label);
      if(choiceBytes>262144)return null;
      choices.push(Object.freeze({identity:choice.identity,label:choice.label}));
    }
    facets[name]=Object.freeze({status:'ready',choices:Object.freeze(choices),coverage:Object.freeze({...coverage}),error:null,enrichment_targets:targets});
  }
  return Object.freeze({selection_method:selectionMethod,facets:Object.freeze(facets),
    allowed_actions:Object.freeze({enrich_country:value.allowed_actions.enrich_country}),...(scoped?{scopeKey}:{})});
}
const countryStatuses=['stored_known','stored_unknown','unchanged','unresolved','source_changed','concurrent_change','cancelled','not_attempted'];
export function normalizeSampleCountryMetadata(value,selectionMethod,targets,scopeKey=undefined){
  const scoped=scopeKey!==undefined;
  if(!isSampleSelectionMethod(selectionMethod)
    ||!exactKeys(value,['selection_method','results',...(scoped?['scopeKey']:[])])
    ||scoped&&value.scopeKey!==scopeKey||value.selection_method!==selectionMethod
    ||!Array.isArray(value.results)||value.results.length!==targets.length||!dense(value.results)
    ||!sampleJsonWithin({selection_method:value.selection_method,results:value.results},524288))return null;
  const results=[];
  for(let index=0;index<targets.length;index++){
    const row=value.results[index],pair=targets[index];
    if(!exactKeys(row,['track_ref','primary_artist_ref','status'])||row.track_ref!==pair.track_ref
      ||row.primary_artist_ref!==pair.primary_artist_ref||!countryStatuses.includes(row.status))return null;
    results.push(Object.freeze({track_ref:row.track_ref,primary_artist_ref:row.primary_artist_ref,status:row.status}));
  }
  return Object.freeze({selection_method:selectionMethod,results:Object.freeze(results),...(scoped?{scopeKey}:{})});
}
