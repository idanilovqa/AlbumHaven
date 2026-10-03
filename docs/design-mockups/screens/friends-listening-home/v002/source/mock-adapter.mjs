import {buildBootstrap, handleFixtureRequest} from './fixture-data.mjs';

// Standalone design preview only. This module is never imported by AlbumHaven.
const originalFetch=window.fetch.bind(window);
const entryUrl=new URL(location.href);
if(innerWidth<=900&&entryUrl.searchParams.get('mock')==='album'&&!entryUrl.searchParams.has('mobile_page')){
  const id=entryUrl.searchParams.get('album')||'a1';
  entryUrl.searchParams.set('mobile_page','album');entryUrl.searchParams.set('mobile_album',id.startsWith('mock-album:')?id:`mock-album:${id}`);
  history.replaceState(history.state,'',entryUrl);
}
window.MockViewContext=entryUrl.searchParams.get('mock')==='recent'?{source:'recent',person:entryUrl.searchParams.get('mock_person')||'me'}:{source:'library'};
window.MockBuildBootstrap=()=>buildBootstrap(location.search,window.MockViewContext);
window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__=window.MockBuildBootstrap();
window.__FRIENDS_REAL_UI_MOCK__=true;
window.fetch=async function(input,init={}) {
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.origin!==location.origin) return new Response(JSON.stringify({ok:false,error:'External services are unavailable in this fictional design preview.'}),{status:503,headers:{'Content-Type':'application/json'}});
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
  if(typeof showToast==='function')showToast('Visual preview: playback is unavailable. No audio or server connection is used.','info',3400);
},true);
