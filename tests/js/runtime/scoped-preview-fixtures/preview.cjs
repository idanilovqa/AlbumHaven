'use strict';
const assert=require('node:assert/strict');
const N=require('../album-tops-native-fixtures/actual-native-runtime.cjs'),F=require('../album-tops-membership-fixtures/top-builder-fixtures.cjs');
const tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const key=row=>row.album_ref||row.selection_key;
const metadata=(rating=null,rating_state='available',artwork_url=null)=>({release_type:'studio',rating,rating_state,artwork_url});
const rows=()=>[F.album(11,{artist:'First',creation_metadata:metadata(7)}),F.album(12,{artist:'Second',creation_metadata:metadata()}),F.album(13,{artist:'First',creation_metadata:metadata(null,'unavailable')})];
async function setup(t,options={}){
  const {createAlbumTopDraft}=await F.load('album-tops/draft.mjs'),{mountScopedCreationPreview}=await F.load('album-tops/scoped-creation-preview.mjs');
  const h=N.nativeEnvironment(),control=F.controllerFixture(),api=F.providerFixture(),owners=[];let population=options.rows||rows(),current=true;
  api.providers.listScopedAlbums=async()=>({albums:population,next_cursor:null});
  const draft=createAlbumTopDraft({controller:control.controller,providers:api.providers,artistScope:{root_artist_id:'3',mode:'artist'}});await tick();
  // Transparent adapters to whole native owners; no replacement renderer or Gallery.
  h.runtime.artistSeparatorHtml=h.owner('buildFamilyArtistHeaderHtml');h.runtime.galleryRatingHtml=h.owner('buildGalleryRatingHtml');
  const calls={cards:[],separators:[],ratings:[],art:[],galleries:[],metadata:[],focus:[],preferences:[]};
  for(const [method,list]of [['galleryCardHtml','cards'],['artistSeparatorHtml','separators'],['galleryRatingHtml','ratings'],['artboxHtml','art']]){
    const actual=h.runtime[method];h.runtime[method]=function(...args){calls[list].push(args);return Reflect.apply(actual,this,args);};
  }
  for(const [method,list]of [['createGalleryHost','galleries'],['createGalleryMetadataOwner','metadata'],['createGalleryFocusOwner','focus']]){
    const actual=h.runtime[method];h.runtime[method]=function(options){const owner=actual(options);calls[list].push({options,owner});return owner;};
  }
  const preference=h.runtime.setGalleryDisplayMode;h.runtime.setGalleryDisplayMode=function(...args){calls.preferences.push(args);return preference(...args);};
  const props=patch=>({draft,value:draft.getSnapshot(),isCurrent:()=>current,...patch});
  const own=owner=>{owners.push(owner);return owner;};let preview=options.noMount?null:own(mountScopedCreationPreview(h.host,h.runtime,props(options.props)));
  t.after(async()=>{for(const owner of owners.reverse())owner.dispose();draft.dispose();h.host.remove();await N.nextTask();h.assertClean();});
  const rowNodes=()=>[...h.host.querySelectorAll('[data-album-draft-key]')];
  return {...h,...control,draft,api,calls,props,own,preview,mount:mountScopedCreationPreview,
    update(patch){return preview.update(props(patch));},setCurrent(value){current=value;},setRows(value){population=value;},
    rows:rowNodes,keys:()=>rowNodes().map(node=>node.getAttribute('data-album-draft-key')),
    row(id){const found=rowNodes().find(node=>node.getAttribute('data-album-draft-key')===id);assert.ok(found,id);return found;},
    click(node){assert.ok(node);node.dispatchEvent(new h.context.Event('click',{bubbles:true}));},
    selected:()=>draft.getSnapshot().items.map(key)};
}
module.exports={setup,F,N,key,metadata,rows,tick};
