'use strict';
// Finite browser primitives only. No real audio, sockets, BroadcastChannel,
// application owner replacements or automatic server response synthesis.
const assert=require('node:assert/strict');
const listener=require('./listener-search.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const clone=value=>structuredClone(value);
function world(){
  let now=1000000,next=0;const timers=new Map(),tabs=[],channels=[],deliveries=[],writes=[],messages=[],local=new Map();
  function timer(tab,callback,delay,repeat=false){assert.equal(typeof callback,'function');delay=Number(delay)||0;assert.ok(delay>=0&&Number.isFinite(delay));const id=++next;timers.set(id,{tab,callback,due:now+Math.max(1,delay),delay:Math.max(1,delay),repeat});return id;}
  function advance(ms){assert.ok(ms>=0&&ms<=60000,'bounded explicit clock advancement');const target=now+ms;let count=0;
    for(;;){const due=[...timers].filter(([,x])=>x.due<=target).sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];if(!due)break;
      assert.ok(++count<=2000,'bounded timer delivery');const [id,row]=due;now=row.due;if(row.repeat)row.due+=row.delay;else timers.delete(id);row.callback();}
    now=target;
  }
  function flush(){let count=0;while(deliveries.length){assert.ok(++count<=2000,'bounded channel/storage delivery');deliveries.shift()();}}
  function createTab({broadcast=true}={}){
    const session=new Map(),tab={c:null,session,images:[],contexts:[],nodes:[],sockets:[],holds:{},storageReads:[],storageHook:null};tabs.push(tab);
    function storage(kind,map){return {getItem(key){key=String(key);tab.storageReads.push({kind,key});tab.storageHook?.({op:'get',kind,key,map});return map.get(key)??null;},
      setItem(key,value){key=String(key);value=String(value);tab.beforeStorageWrite?.({kind,key,value,map});const oldValue=map.get(key)??null;map.set(key,value);writes.push({tab,kind,op:'set',key,value});tab.storageCalls?.push({key,value,kind});
        if(kind==='local')for(const peer of tabs)if(peer!==tab&&peer.c)deliveries.push(()=>{const e=new peer.c.Event('storage');Object.assign(e,{key,oldValue,newValue:value});peer.c.dispatchEvent(e);});
        tab.storageHook?.({op:'set',kind,key,value,map});},
      removeItem(key){key=String(key);const oldValue=map.get(key)??null;map.delete(key);writes.push({tab,kind,op:'remove',key});
        if(kind==='local')for(const peer of tabs)if(peer!==tab&&peer.c)deliveries.push(()=>{const e=new peer.c.Event('storage');Object.assign(e,{key,oldValue,newValue:null});peer.c.dispatchEvent(e);});},
      clear(){for(const key of [...map.keys()])this.removeItem(key);}};}
    tab.install=({c,storageCalls})=>{
      tab.c=c;tab.storageCalls=storageCalls;
      class ClockDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
      Object.assign(c,{Date:ClockDate,performance:{now:()=>now},localStorage:storage('local',local),sessionStorage:storage('session',session),
        setTimeout:(fn,delay)=>timer(tab,fn,delay),clearTimeout:id=>timers.delete(id),setInterval:(fn,delay)=>timer(tab,fn,delay,true),clearInterval:id=>timers.delete(id),
        BroadcastChannel:broadcast?class {
          constructor(name){this.name=String(name);this.listeners=[];this.closed=false;this.tab=tab;channels.push(this);}
          addEventListener(type,fn){assert.equal(type,'message');this.listeners.push(fn);}
          removeEventListener(type,fn){assert.equal(type,'message');this.listeners=this.listeners.filter(x=>x!==fn);}
          postMessage(data){assert.equal(this.closed,false);messages.push({channel:this.name,tab,data:clone(data)});for(const peer of channels)if(peer!==this&&!peer.closed&&peer.name===this.name){const callbacks=peer.listeners.slice(),packet=clone(data);deliveries.push(()=>{if(!peer.closed)for(const callback of callbacks)callback({data:packet});});}}
          close(){this.closed=true;this.listeners=[];}
        }:undefined,
        Image:class {constructor(){this.onload=null;this.onerror=null;tab.images.push(this);}set src(value){this.url=String(value);}get src(){return this.url;}},
      });
    };
    tab.installAudio=()=>{
      const c=tab.c;
      c.AudioContext=class {
        constructor(){this.state='suspended';this.sampleRate=48000;this.destination={};this.closeCount=0;this.resumeCount=0;
          this.module=deferred();this.audioWorklet={addModule:url=>{this.moduleURL=url;if(!tab.holds.module)this.module.resolve();return this.module.promise;}};tab.contexts.push(this);tab.onContextCreate?.(this);}
        resume(){this.resumeCount++;this.resumeGate=deferred();if(!tab.holds.resume){this.state='running';this.resumeGate.resolve();}return this.resumeGate.promise;}
        suspend(){this.state='suspended';return Promise.resolve();}
        close(){this.closeCount++;this.state='closed';this.closeGate=deferred();if(!tab.holds.close)this.closeGate.resolve();return this.closeGate.promise;}
      };
      c.AudioWorkletNode=class {
        constructor(context,name,options){this.context=context;this.name=name;this.options=options;this.sent=[];this.disconnectCount=0;this.port={onmessage:null,postMessage:data=>{this.sent.push(clone(data));tab.onPortPost?.(this,data);}};tab.nodes.push(this);}
        connect(destination){assert.equal(destination,this.context.destination);}
        disconnect(){this.disconnectCount++;tab.onDisconnect?.(this);}
        emit(data){assert.equal(typeof this.port.onmessage,'function');this.port.onmessage({data:clone(data)});}
      };
      c.WebSocket=class {
        static OPEN=1;static CONNECTING=0;static CLOSED=3;
        constructor(url){assert.match(url,/^wss:\/\/albumhaven\.test\/playback\/pcm$/);this.url=url;this.readyState=0;this.sent=[];this.closeCount=0;tab.sockets.push(this);}
        open(){this.readyState=1;this.onopen?.({});}
        send(data){assert.equal(this.readyState,1);this.sent.push(JSON.parse(data));tab.onSocketSend?.(this,JSON.parse(data));}
        close(){this.closeCount++;this.readyState=3;this.onclose?.({code:1000,reason:'bounded fixture close'});}
        emit(data){this.onmessage?.({data:JSON.stringify(data)});}
      };
    };
    tab.dispose=()=>{for(const [id,row]of timers)if(row.tab===tab)timers.delete(id);for(const channel of channels)if(channel.tab===tab)channel.close();};
    return tab;
  }
  return {createTab,advance,flush,timers,tabs,channels,deliveries,writes,messages,local,now:()=>now};
}
function installPlayerMarkup(h){
  const source=listener.read('music_app/templates/index.html'),begin=source.indexOf('<div class="global-player shell-bottom-player"'),end=source.indexOf('<div class="toast-layer"',begin);
  assert.ok(begin>=0&&end>begin,'actual full and compact served player section');
  let markup=source.slice(begin,end)
    .replace("{{ shell_bottom_player.content_kind or 'global_player' }}",'global_player')
    .replace("{{ 'true' if shell_bottom_player.is_persistent else 'false' }}",'true');
  markup=markup.replace(/{% call ui_button\((.*?)\) %}([\s\S]*?){% endcall %}/g,(_,args,label)=>{
    const entries=[...args.matchAll(/([a-z_]+)='([^']*)'/g)];assert.equal(args.replace(/([a-z_]+)='([^']*)'/g,'').replace(/[,\s]/g,''),'');
    const names={class_name:'className',aria_label:'ariaLabel'};const options={label};for(const [,key,value]of entries)options[names[key]||key]=value;return h.c.ButtonComponent.renderButton(options);
  });
  markup=markup.replace("{{ playback_control_cluster('expanded-player', owner_id='global-player') }}",h.c.renderPlaybackControlCluster({variant:'expanded-player',ownerId:'global-player'}))
    .replace("{{ playback_control_cluster('compact-player') }}",h.c.renderPlaybackControlCluster({variant:'compact-player'}));
  assert.doesNotMatch(markup,/{%|{{/);assert.equal(h.document.querySelector('.global-player'),null);h.document.body.insertAdjacentHTML('beforeend',markup);
  const els=h.c.getPlayerElements();for(const key of ['player','coverButton','play','title','artist','albumLink','timeline','waveformCanvas'])assert.ok(els[key],`real served ${key}`);
  els.waveformCanvas.getContext=type=>{assert.equal(type,'2d');return null;}; // unavailable canvas rendering boundary
  h.setRect(els.timeline,{x:0,y:100,width:300,height:20});
  assert.equal(els.timeline.getBoundingClientRect().top,100,'bounded timeline geometry uses DOM platform x/y coordinates');
  const captured=new Set();els.player.setPointerCapture=id=>captured.add(id);els.player.releasePointerCapture=id=>captured.delete(id);els.player.hasPointerCapture=id=>captured.has(id);h.pointerCaptures=captured;
}
async function fixture(t,w=world(),options={}){
  const platform=w.createTab(options),h=await listener.queueFixture(t,{media:options.media!==false,beforeRuntimePlatform:platform.install});platform.installAudio();
  installPlayerMarkup(h);
  // Seed the browser before the real attach path consumes its one-shot restore.
  Object.assign(platform.holds,options.holds);
  if(options.readyState)h.document.readyState=options.readyState;
  if(options.savedPlayerState)h.c.localStorage.setItem('albumhaven.playerState.v1',JSON.stringify(options.savedPlayerState));
  h.c.initPlaybackOwnershipCoordinator();h.c.attachPlayerEvents();h.c.initCompactPlayer();
  t.after(()=>platform.dispose());return Object.assign(h,{platform,world:w,engine:()=>h.c.streamingEngineState(),queueOwner:()=>h.owner('ExplicitQueueRuntime')});
}
const track=(suffix='A')=>({path:`/library/private-${suffix}.flac`,src:`/track?path=${encodeURIComponent(`/library/private-${suffix}.flac`)}`,
  title:`Title ${suffix}`,artist:`Artist ${suffix}`,album:`Album ${suffix}`,coverPath:`/library/art-${suffix}.jpg`,durationSeconds:90});
async function start(h,payload=track(),options={}){
  const work=h.c.playTrackFromPayload(payload,options);await h.flush();
  for(const socket of h.platform.sockets)if(socket.readyState===0)socket.open();await h.flush();return {work,role:h.engine().roles.current,payload};
}
function frame(h,role=h.engine().roles.current,patch={}){
  assert.ok(role,'real engine must create a role before frame input');h.platform.nodes.at(-1).emit({type:'first-frame',generation:role.generation,streamId:role.streamId,renderedFrame:1,contextTime:1,...patch});
}
const displayMessages=w=>w.messages.filter(row=>row.channel.startsWith('albumhaven.playbackDisplay.v1.'));
module.exports={world,fixture,track,start,frame,displayMessages,deferred};
