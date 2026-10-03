import {buildBootstrap, handleFixtureRequest} from './fixture-data.mjs';

// Standalone design preview only. This module is never imported by AlbumHaven.
const originalFetch=window.fetch.bind(window);
const entryUrl=new URL(location.href);
if(innerWidth<=900&&entryUrl.searchParams.get('mock')==='album'&&!entryUrl.searchParams.has('mobile_page')){
  const id=entryUrl.searchParams.get('album')||'a1';
  entryUrl.searchParams.set('mobile_page','album');entryUrl.searchParams.set('mobile_album',id.startsWith('mock-album:')?id:`mock-album:${id}`);
  history.replaceState(history.state,'',entryUrl);
}
// The v003 Recent consumer projects each person's activity from the same
// canonical fictional browse inventory. A deep link must not pre-filter native
// Gallery keys to a different person's four-album preview.
window.MockViewContext={source:'library'};
window.MockBuildBootstrap=()=>buildBootstrap(location.search,window.MockViewContext);
window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__=window.MockBuildBootstrap();
window.__FRIENDS_REAL_UI_MOCK__=true;

/* Native Appearance preview contract (accepted appearance-backgrounds.js):
 * GET /account/appearance returns a complete canonical aggregate + synthetic CSRF.
 * PUT accepts the native full draft with expected_revision, but only Album layout,
 * playing-row animation and Mobile Album Follow/Custom may change. Other edits
 * return 501 MOCK_UNAVAILABLE. Stale revisions return the native 409 conflict shape.
 * The snapshot exists only in this module; refresh resets it. No request reaches
 * originalFetch, an account service, localStorage, IndexedDB or a filesystem.
 * Install before appearance-backgrounds.js, which captures its fetch dependency.
 * Native mountAlbumPage/controller retain draft, Save, Cancel and retry ownership.
 * The consumer must label native saved status “Applied in this preview only”;
 * response mock/persistence metadata must never be presented as an account write.
 */
const appearanceLayouts=['classic_bar','stacked_bar','editorial_canvas'];
const appearanceAnimations=['enabled','disabled'];
const appearanceSections=['main','player','interaction','alerts','album'];
const appearanceDefaults={
  main_surface_color:null,panel_background_color:null,palette_id:null,panel_index:0,player_override:null,
  compact_player_style:'docked',docked_compact_player_behavior:'follow_sidebar',docked_compact_player_regular_style:false,
  compact_player_motion:'normal',floating_player_edge:{source:'player',color:null},
  album_details_layout:'classic_bar',album_playing_row_animation:'enabled',alert_family:'ember',loop_control_style:'capsule',
  action_button_outlines:true,
  interaction_overrides:{item_hover:null,item_selected:null,button_hover_background:null,button_pressed:null,item_outline:{source:'automatic',color:null}},
  selection_accent:{enabled:true,color:'#34CA78'},player_style_override:null,player_recent_sets:[],waveform_recent_colors:[],
};
const appearanceCopy=value=>JSON.parse(JSON.stringify(value));
const appearanceObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const appearanceSame=(left,right)=>{
  const stable=value=>JSON.stringify(value,(_key,item)=>appearanceObject(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
  return stable(left)===stable(right);
};
let previewAppearance=null;
function readPreviewAppearance(){
  if(previewAppearance)return previewAppearance;
  let bootstrap={};
  try{bootstrap=JSON.parse(document.getElementById('appearance-bootstrap')?.textContent||'{}');}catch{}
  const initial=appearanceCopy(appearanceDefaults);
  if(appearanceObject(bootstrap))for(const key of Object.keys(initial))if(Object.hasOwn(bootstrap,key))initial[key]=appearanceCopy(bootstrap[key]);
  if(!appearanceLayouts.includes(initial.album_details_layout))initial.album_details_layout='classic_bar';
  if(!appearanceAnimations.includes(initial.album_playing_row_animation))initial.album_playing_row_animation='enabled';
  const profiles=Object.fromEntries(['mobile','tv'].map(profile=>[profile,{sections:Object.fromEntries(appearanceSections.map(section=>[section,{mode:'follow',values:{}}]))}]));
  // A fictional custom Album baseline makes all three native phone choices usable.
  // Other phone sections and TV remain unchanged, following the desktop defaults.
  profiles.mobile.sections.album={mode:'custom',values:{album_details_layout:initial.album_details_layout,album_playing_row_animation:initial.album_playing_row_animation}};
  previewAppearance={...initial,device_profiles:profiles,revision:0};
  return previewAppearance;
}
function appearanceResponse(status,body){
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
function appearanceUnavailable(){
  return appearanceResponse(501,{ok:false,code:'MOCK_UNAVAILABLE',mock:true,error:'Only Album page layout and playing-row animation can be applied in this preview. No account change was made.'});
}
async function handlePreviewAppearance(input,init){
  const method=String(init.method||input?.method||'GET').toUpperCase();
  if(!['GET','PUT'].includes(method))return appearanceUnavailable();
  const saved=readPreviewAppearance();
  if(method==='GET')return appearanceResponse(200,{...appearanceCopy(saved),csrf_token:'mock-preview-only',mock:true,persistence:'memory'});
  let payload;
  try{
    const raw=init.body!==undefined?init.body:typeof input?.clone==='function'?await input.clone().text():'';
    if(typeof raw!=='string'||raw.length>65536)return appearanceResponse(400,{error:'invalid_appearance',mock:true});
    payload=JSON.parse(raw);
  }catch{return appearanceResponse(400,{error:'invalid_appearance',mock:true});}
  if(!appearanceObject(payload)||!Number.isSafeInteger(payload.expected_revision)||payload.expected_revision<0)return appearanceResponse(400,{error:'invalid_appearance',mock:true});
  // Re-read after a possible Request-body await: concurrent saves share one revision.
  const current=readPreviewAppearance();
  if(payload.expected_revision!==current.revision)return appearanceResponse(409,{error:'appearance_conflict',appearance:appearanceCopy(current),mock:true});
  const allowedKeys=new Set([...Object.keys(current),'expected_revision','applied_player_set','waveform_color_updates']);
  if(Object.keys(payload).some(key=>!allowedKeys.has(key)))return appearanceUnavailable();
  if(payload.applied_player_set!=null||(Object.hasOwn(payload,'waveform_color_updates')&&!appearanceSame(payload.waveform_color_updates,[])))return appearanceUnavailable();
  if(!appearanceLayouts.includes(payload.album_details_layout)||!appearanceAnimations.includes(payload.album_playing_row_animation))return appearanceResponse(400,{error:'invalid_appearance',mock:true});
  for(const key of Object.keys(current)){
    if(['album_details_layout','album_playing_row_animation','device_profiles'].includes(key))continue;
    if(Object.hasOwn(payload,key)&&!appearanceSame(payload[key],current[key]))return appearanceUnavailable();
  }
  const profiles=payload.device_profiles;
  if(!appearanceObject(profiles)||!appearanceSame(Object.keys(profiles).sort(),['mobile','tv']))return appearanceResponse(400,{error:'invalid_appearance',mock:true});
  if(!appearanceSame(profiles.tv,current.device_profiles.tv))return appearanceUnavailable();
  const mobile=profiles.mobile;
  if(!appearanceObject(mobile)||!appearanceSame(Object.keys(mobile),['sections'])||!appearanceObject(mobile.sections)||!appearanceSame(Object.keys(mobile.sections).sort(),[...appearanceSections].sort()))return appearanceResponse(400,{error:'invalid_appearance',mock:true});
  for(const section of appearanceSections.filter(section=>section!=='album'))if(!appearanceSame(mobile.sections[section],current.device_profiles.mobile.sections[section]))return appearanceUnavailable();
  const album=mobile.sections.album;
  if(!appearanceObject(album)||!appearanceSame(Object.keys(album).sort(),['mode','values'])||!['follow','custom'].includes(album.mode)||!appearanceObject(album.values))return appearanceResponse(400,{error:'invalid_appearance',mock:true});
  const valueKeys=Object.keys(album.values);
  if(valueKeys.some(key=>!['album_details_layout','album_playing_row_animation'].includes(key)))return appearanceUnavailable();
  if((album.mode==='custom'||valueKeys.length>0)&&(!appearanceSame(valueKeys.sort(),['album_details_layout','album_playing_row_animation'])||!appearanceLayouts.includes(album.values.album_details_layout)||!appearanceAnimations.includes(album.values.album_playing_row_animation)))return appearanceResponse(400,{error:'invalid_appearance',mock:true});
  previewAppearance={...current,album_details_layout:payload.album_details_layout,album_playing_row_animation:payload.album_playing_row_animation,device_profiles:appearanceCopy(profiles),revision:current.revision+1};
  return appearanceResponse(200,{...appearanceCopy(previewAppearance),mock:true,persistence:'memory'});
}

window.fetch=async function(input,init={}) {
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.origin!==location.origin) return new Response(JSON.stringify({ok:false,error:'External services are unavailable in this fictional design preview.'}),{status:503,headers:{'Content-Type':'application/json'}});
  if(url.pathname==='/account/appearance')return handlePreviewAppearance(input,init);
  if(url.pathname==='/cover') {
    const asset=url.searchParams.get('path')||'';
    if(/^\/mock-assets\/(mountain|ocean|desert|forest)\.jpg$/.test(asset)) return originalFetch(asset);
  }
  if(url.pathname.startsWith('/static/')||url.pathname.startsWith('/mock-assets/')||url.pathname.startsWith('/mock-')) return originalFetch(input,init);
  const fixture=handleFixtureRequest(url.href,{...init,fixtureOptions:window.MockViewContext||{}});
  if(fixture) return new Response(JSON.stringify(fixture.body),{status:fixture.status||200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  return new Response(JSON.stringify({ok:false,error:'This action is unavailable in the fictional UI preview. No server change was made.'}),{status:503,headers:{'Content-Type':'application/json'}});
};

// The real player DOM stays intact. No PCM socket may reach a real service.
// Initial engine preparation remains pending; visible playback is intercepted
// below with an honest message instead of inventing successful audio.
const NativeSocket=window.WebSocket;
class PreviewSocket extends EventTarget {
  constructor(url){super();this.url=String(url);this.readyState=0;this.bufferedAmount=0;this.extensions='';this.protocol='';this.binaryType='arraybuffer';}
  send(){}
  close(){this.readyState=3;this.dispatchEvent(new CloseEvent('close',{code:1000,reason:'Visual preview has no audio stream'}));}
}
Object.assign(PreviewSocket,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});
window.WebSocket=function(url,protocols){const u=new URL(url,location.href);if(u.pathname==='/playback/pcm')return new PreviewSocket(url);throw new Error('External socket connections are unavailable in this preview');};
Object.assign(window.WebSocket,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});
window.WebSocket.prototype=NativeSocket.prototype;
document.addEventListener('click',event=>{
  const play=event.target.closest('.play-track-button,[data-playback-control-action="play-pause"],[data-playback-control-action="previous"],[data-playback-control-action="next"],#player-play');
  if(!play)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(play.matches('.play-track-button')&&window.MockRealLayout?.previewTrack){window.MockRealLayout.previewTrack(play);return;}
  if(typeof showToast==='function')showToast('Audio is unavailable in this preview. No stream has started.','info',3400);
},true);
