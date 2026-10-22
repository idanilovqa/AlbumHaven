'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm');
const base=require('./popularity-search.cjs');
const ALBUM='popular_album_'+'c'.repeat(64);
const lifetime=(server_now=1000)=>({issued_at:1000,expires_at:2800,server_now});
function gallery(){const p=base.ready();delete p.tracks;return {...p,contract_version:'popularity-search-albums-v1',presentation:'albums',albums:[{id:ALBUM,kind:'album',name:'Signals',artist:'Rush',year:1982,edition:'Original',matches_search:true,allowed_actions:{can_read:true,can_view_details:true}}],page:{limit:100,returned_count:1,has_more:false,next_cursor:null,total_matches:1},lifetime:lifetime()};}
async function fixture(t){const h=await base.actionFixture(t);let mono=0,wall=1000000;h.c.performance.now=()=>mono;h.c.Date=class extends Date {static now(){return wall;}};return {...h,advance(ms,{monotonic=true,wallClock=true}={}){if(monotonic)mono+=ms;if(wallClock)wall+=ms;},provenance:vm.runInContext('SearchAlbumPresentationProvenance',h.c)};}
function albumRows(count=3){const tracks=Array.from({length:count},(_,i)=>({path:`/library/g1/${i+1}.flac`,title:':popular title '+(i+1),artist:'Rush',album:'Signals',track_number:i+1,disc_number:1,duration_seconds:90,inventory_track_ref:`inventory-track:9:${i+1}`}));return base.fullAlbum('native-album-eleven',{tracks,track_rows:tracks.map(x=>({...x}))});}
async function open(h,album=albumRows()){
 const s=await base.submit(h),start=h.requests.length,work=base.outcome(h.runtime().openAlbum(s,s.result.tracks[0]));
 h.reply(start,base.nativeReply(h,start));await h.flush();h.reply(start+1,base.nativeReply(h,start+1));await h.flush();
 h.reply(start+2,{ok:true,album});const result=await work;assert.equal(result.error,undefined,result.error?.stack);await h.flush();
 const current=h.c.getCurrentTrackModalAlbum(),list=h.document.getElementById('track-modal-list'),nodes=[...list.querySelectorAll('.album-track-table__row')],attempt=h.provenance.attempt(current);
 assert.ok(attempt,'actual post-hydration wrapper retains witness attempt');assert.ok(attempt.isCommitted(),'actual visible native open explicitly commits');
 return {album:current,list,nodes,attempt,source:s};
}
function visible(h,view,indexes=view.nodes.map((_,i)=>i)){
 const selected=new Set(indexes);for(let i=0;i<view.nodes.length;i++){const y=selected.has(i)?10+i%10*20:2000;h.setRect(view.nodes[i],{x:10,y,width:500,height:18});const rect=view.nodes[i].getBoundingClientRect();assert.equal(rect.left,10,'fixture x must become left');assert.equal(rect.top,y,'fixture y must become top');assert.equal(rect.bottom,y+18,'fixture bottom must preserve intended offscreen geometry');}
 h.setRect(view.list,{x:0,y:0,width:1000,height:750});const dialog=view.list.closest('.track-modal-dialog');h.setRect(dialog,{x:0,y:0,width:1000,height:750});
}
const matchRequests=h=>h.requests.filter(r=>r.url==='/search/popularity-album-matches');
function reply(h,request,states,patch={}){const body=JSON.parse(request.options.body);request.resolve({private_search:true,contract_version:'popularity-search-album-matches-v1',context_ref:base.A,page_key:body.page_key,data:{items:body.rows.map((row,i)=>({slot:row.slot,match_state:states?.[i]===null?'unavailable':'known',matches_search:states?.[i]??(states?.[i]===null?null:true)}))},lifetime:lifetime(),...patch});}
const marked=view=>view.nodes.filter(n=>n.classList.contains('album-track-table__row--search-match'));
async function frame(h){h.flushFrames();await h.flush();}
async function gallerySource(h,p=gallery()) {
 const i=h.requests.length,work=h.read('/view-data?surface=albums&q=%3Apopular&search_presentation=albums&search_page_size=100');
 h.reply(i,p);const result=await work;assert.equal(result.error,undefined,result.error?.stack);assert.equal(result.value,true);await h.flush();return h.runtime().snapshot();
}
function albumTarget(request,patch={}) {const body=JSON.parse(request.options.body);assert.equal(request.url,'/search/popularity-album-target');assert.deepEqual(body,{result_token:base.TOKEN,album_ref:ALBUM});return {private_search:true,contract_version:'popularity-search-album-native-v1',context_ref:base.A,result_token:body.result_token,data:{album_ref:body.album_ref,status:'ready',native_target:{album_ref:'native-album-eleven',allowed_actions:{can_view_details:true,can_play_album:true}}},lifetime:lifetime(),...patch};}
async function openGallery(h,album=albumRows()) {
 const s=await gallerySource(h),start=h.requests.length,work=base.outcome(h.runtime().openAlbum(s,s.result.albums[0]));
 h.reply(start,albumTarget(h.requests[start]));await h.flush();h.reply(start+1,albumTarget(h.requests[start+1]));await h.flush();
 assert.equal(h.requests[start+2].url,'/album-details?album_key=native-album-eleven');h.reply(start+2,{ok:true,album});const result=await work;assert.equal(result.error,undefined,result.error?.stack);await h.flush();
 const current=h.c.getCurrentTrackModalAlbum(),list=h.document.getElementById('track-modal-list'),nodes=[...list.querySelectorAll('.album-track-table__row')],attempt=h.provenance.attempt(current);assert.ok(attempt?.isCommitted());return {album:current,list,nodes,attempt,source:s};
}
module.exports={...base,fixture,gallerySource,albumTarget,openGallery,gallery,ALBUM,lifetime,albumRows,open,visible,matchRequests,reply,marked,frame};
