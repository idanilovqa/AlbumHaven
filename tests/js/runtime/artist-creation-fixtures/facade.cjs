'use strict';
const assert=require('node:assert/strict');
const A=require('../artist-host-fixtures/actual-artist-runtime.cjs');
const F=require('../album-tops-membership-fixtures/top-builder-fixtures.cjs');
const STAMP='a'.repeat(64),wire=()=>({context_ref:STAMP,artist_ref:A.ARTIST,artist_scope:{root_artist_id:'3',mode:'artist'}});
function payload(options={}){const launch=wire(),main=A.group(A.ARTIST,[A.album(1)],{artist_listen_through_launch:launch});return A.artistView({context_ref:STAMP,artist_listen_through_context_ref:STAMP,artist_groups:[main],primary_artist_groups:[main],family_artist_groups:[],artist_page:{artist_ref:A.ARTIST,active_page_mode:'info',page_modes:['gallery','info'],default_page_mode:'gallery',artist_listen_through_launch:launch},...options});}
async function fixture(t,{withDestinationHost=true,...options}={}){const h=A.fixture(t,options);await h.entry();if(withDestinationHost)destinationHost(h);await h.admit(payload(options.payload));const bridge=h.context.AlbumHavenAlbumTopsRuntime;assert.ok(bridge?.artistCreation);const origin=bridge.artistCreation.snapshot();assert.ok(origin,'real native response admitted an Artist creation origin');t.after(()=>bridge.artistCreation.snapshot()?.dispose());return {...h,bridge,origin,namespace:bridge.artistCreation};}
const form=(h,options={})=>h.origin.openForm({title:'Create Listen-through',pageId:'artist-create-test',...options});
function terminal(h){assert.equal(h.state.busy,false);assert.equal(h.state.ui.activeViewRequestController??null,null);assert.equal(h.state.ui.activeViewRequestUrl||'', '');assert.equal(h.state.ui.pendingViewRequest??null,null);assert.equal(h.state.ui.pendingViewTransition,false);}
async function acknowledgement(t,h){const {createAlbumTopController}=await F.load('album-tops/model.mjs');const calls=[];
  const providers={list:async()=>({tops:[],allowed_actions:{[F.BROWSE]:true,[F.CREATE]:true,can_create:true}}),read:async ref=>F.detail({top_ref:ref,revision:'1',items:[]}),execute:async(action,command)=>{calls.push({action,command});return {action,request_key:command.request_key,top_ref:F.TOP,revision:'1'};}};
  const controller=createAlbumTopController({providers,requestKey:()=>F.id(101)});controller.setScope(h.origin.scopeKey);await controller.load();await controller.mutate('create',{title:'Captured',description:'',album_refs:[F.A],artist_scope:{root_artist_id:'3',mode:'artist'}});
  const mutation=controller.getSnapshot().mutation,receipt=mutation.data;assert.ok(receipt);assert.equal(receipt.request_key,F.id(101));assert.equal(mutation.refreshing,false);assert.equal(receipt.action,'create');
  t.after(()=>controller.dispose());return {controller,providers,calls,receipt,isCurrent:()=>{const now=controller.getSnapshot().mutation;return now.data===receipt&&now.command?.request_key===receipt.request_key&&!now.refreshing;}};
}
function top(h,ref=F.TOP){return {...A.artistView(),context_ref:STAMP,selected_artist:null,artist_page:null,artist_groups:[],primary_artist_groups:[],family_artist_groups:[],surface:{active:'album_tops'},surface_request:'album_tops',top_ref:ref};}
module.exports={...A,F,STAMP,wire,payload,fixture,form,acknowledgement,top,terminal};

// These direct-facade tests deliberately do not mount the automatic Top consumer.
// Add the real served destination host after native entry has completed its mount pass.
// No runtime-ready event is synthesized and no HTTP request is intercepted.
function destinationHost(h) {
 assert.equal(h.document.getElementById('album-tops-root'),null);
 const count=h.requests.length,host=h.document.createElement('section');host.id='album-tops-root';h.main.append(host);
 assert.equal(h.requests.length,count);return host;
}

// Browser layout facts for ordinary Gallery tests; real section/context owners remain intact.
function ordinaryGalleryLayout(h) {
 destinationHost(h);
 // Settle initial native reset/measurement before modeling a later user scroll.
 // The existing Loved Gallery fixture uses this same real frame boundary.
 h.frame();
 const sections=h.context.getGalleryMainContextSections();assert.ok(sections.length);
 function layout(){const contentOrigin=h.nodes.viewport.getBoundingClientRect().top-h.scroll.getBoundingClientRect().top+h.scroll.scrollTop;
  for(const node of h.document.querySelectorAll('[data-scroll-artist]')){const section=sections.find(row=>row.artist===node.dataset.scrollArtist),label=node.querySelector('.artist-name');if(!section||!label)continue;
   const contentTop=contentOrigin+section.top,height=h.grid.sectionHeaderHeight;label.getBoundingClientRect=()=>{const top=h.scroll.getBoundingClientRect().top+contentTop-h.scroll.scrollTop;return{x:0,y:top,top,bottom:top+height,left:0,right:200,width:200,height};};}
 }
 layout();const selected=h.context.getGalleryMainContextSections()[0],position=Math.max(13,selected.labelBottom+1);
 function scroll(top){h.scrollTo(top);layout();h.context.updateGalleryMainControls();}
 scroll(position);assert.equal(h.scroll.scrollTop,position,'actual user scroll survives initial native settlement');assert.equal(h.context.getGalleryMainContextSections()[0].labelBottom,selected.labelBottom);assert.equal(h.context.galleryArtistLovedHeaderContext().kind,'artist');return{position,scroll};
}
module.exports.ordinaryGalleryLayout=ordinaryGalleryLayout;
