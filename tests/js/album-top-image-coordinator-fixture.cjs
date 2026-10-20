'use strict';
// Browser/platform doubles only. Product coordinator, renderer, layout, native
// Dialog, Button and Choice are imported from the candidate tree unchanged.
// PNG fixtures contain a genuine signature/complete CRC-correct IHDR, not a
// decoded raster. Synthetic decode/metrics cannot establish browser acceptance.
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../..'));
const {fixture: actualRuntime, drain} = require(path.join(ROOT, 'tests/js/runtime/search-native-fixtures/actual-runtime.cjs'));
const {id, TOP, permissions} = require(path.join(ROOT, 'tests/js/runtime/album-tops-native-fixtures/actual-native-runtime.cjs'));
async function settle(){await drain();await new Promise(resolve=>setImmediate(resolve));await drain();}
const load = name => import(pathToFileURL(path.join(ROOT, 'music_app/static/js/album-tops', name)).href);
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const frozen = value => {if (value && typeof value === 'object') {for (const item of Object.values(value)) frozen(item); Object.freeze(value);} return value;};
const NativeBlob = globalThis.Blob;
const NativeDate = globalThis.Date;
function pngBytes(width, height) {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137,80,78,71,13,10,26,10]); view.setUint32(8, 13);
  bytes.set([73,72,68,82], 12); view.setUint32(16, width); view.setUint32(20, height);
  bytes.set([8,6,0,0,0], 24);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(12,29)) {crc ^= byte; for (let n=0; n<8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));}
  view.setUint32(29, (crc ^ 0xffffffff) >>> 0); return bytes;
}
function observe(promise) {const status = {state: 'pending'}; promise.then(value => {status.state='resolved'; status.value=value;}, error => {status.state='rejected'; status.error=error;}); return status;}
const visible = node => Boolean(node?.isConnected && !node.closest('[hidden],[inert]'));
function name(node) {
  if (node.getAttribute('aria-label')) return node.getAttribute('aria-label');
  const ids = node.getAttribute('aria-labelledby');
  if (ids) return ids.split(/\s+/).map(id => node.ownerDocument.getElementById(id)?.textContent || '').join(' ').trim();
  const labels = node.ownerDocument.querySelectorAll('label');
  const label = labels.find(label => label.getAttribute('for') === node.id && node.id || label.contains(node));
  return (label?.textContent || node.textContent || '').trim();
}
function findControl(root, pattern, selector = 'input,button,select') {
  const found = [...root.querySelectorAll(selector)].filter(visible).find(node => pattern.test(name(node)));
  assert.ok(found, `accessible control ${pattern} exists`); return found;
}
function button(root, pattern = /^Download(?: PNG| image)?$/i) {return findControl(root, pattern, 'button');}
function disabled(node) {return node.disabled === true || node.getAttribute('aria-disabled') === 'true';}
function assertDisabled(node) {assert.equal(node.disabled, true, 'native disabled behavior'); assert.equal(disabled(node), true, 'unavailable presentation');}
function click(node) {assert.ok(node); if (node.disabled) return false; return node.dispatchEvent(new node.ownerDocument.defaultView.Event('click'));}
function input(node, value) {node.value=String(value); node.dispatchEvent(new node.ownerDocument.defaultView.Event('input'));}
function toggle(root, pattern, value) {
  const node = findControl(root, pattern);
  if (node.tagName === 'INPUT') {
    assert.equal(node.type, 'checkbox', 'boolean option uses an accessible native checkbox');
    node.checked=value; node.dispatchEvent(new node.ownerDocument.defaultView.Event('change')); return node;
  }
  const pressed = node.getAttribute('aria-pressed'), checked = node.getAttribute('aria-checked');
  if (pressed !== null || checked !== null) {if ((pressed || checked) !== String(value)) click(node); return node;}
  click(node);
  const rows = node.ownerDocument.querySelectorAll('[role="menu"] [data-foobar-format]');
  const target = rows.find(row => (value ? /^(on|yes|show|enabled)$/i : /^(off|no|hide|disabled)$/i).test(row.textContent.trim()));
  assert.ok(target, 'canonical boolean Choice menu has explicit on/off alternatives'); click(target); return node;
}

async function fixture(t, config = {}) {
  const underlyingCleanup=[];let windowListeners;
  let teardown=async()=>{for(const cleanup of underlyingCleanup)await cleanup();};
  t.after(()=>teardown());
  const actual=actualRuntime({after(callback){underlyingCleanup.push(callback);}},{
    url:'https://albumhaven.test/?surface=album_tops',
    beforeRuntimePlatform({listeners}){windowListeners=listeners;},
  });
  const doc=actual.document,win=actual.c,runtime=actual.owner('AlbumTopsRuntime');
  assert.ok(runtime,'complete candidate manifest supplies the genuine AlbumTopsRuntime');
  const host=doc.createElement('section');host.id='album-tops-root';actual.main.append(host);
  actual.state.view={surface:{active:'album_tops'},top_ref:TOP};actual.state.ui.pendingViewTransition=false;
  runtime.sync();
  for(const id of ['app-form-modal','app-confirm-modal'])actual.owner('bindOverlayPointerOrigin')(doc.getElementById(id));
  const baselineListeners=actual.listeners().filter(row=>row.target.isConnected),baselineWindow=[...windowListeners];
  const baselineFrames=new Set(actual.frames.keys());
  const native={...actual,document:doc,context:win,runtime,host,content:()=>doc.getElementById('app-form-content'),modal:()=>doc.getElementById('app-form-modal'),
    assertClean(){
      const connected=actual.listeners().filter(row=>row.target.isConnected);
      assert.ok(connected.length===baselineListeners.length&&connected.every(row=>baselineListeners.includes(row)),'native connected listeners restored');
      assert.ok(windowListeners.length===baselineWindow.length&&windowListeners.every(row=>baselineWindow.includes(row)),'native window listeners restored');
      assert.ok([...actual.frames.keys()].every(key=>baselineFrames.has(key)),'no image/designer animation frame survives close');
      assert.equal(doc.fonts?.listeners?.length||0,0,'font generation subscriptions are retired');
    },
  };
  const savedGlobals = new Map(), originalCreateElement = doc.createElement.bind(doc);
  let coordinator=null,env=null,prototype=null,oldClick;
  const handles=[];
  // Register restoration before the first candidate import. Missing source is
  // an intentional red control, not permission to contaminate following tests.
  teardown=async()=>{
    try {
      for(const handle of handles)handle.close();coordinator?.dispose();await settle();env?.advance(60000);await settle();native.assertClean();
    } finally {
      if(prototype)prototype.click=oldClick;doc.createElement=originalCreateElement;native.host.remove();
      for(const[key,descriptor]of savedGlobals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
      for(const cleanup of underlyingCleanup)await cleanup();
    }
  };
  const installGlobal = (key,value) => {savedGlobals.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
  const dimensions = new WeakMap(), urls = new Map(), revoked = [], urlEvents = [], downloads = [], imageDecodes = [], bitmaps = [], canvases = [], encodes = [], fontLoads = [];
  const timers = new Map(); let timerId=0, now=0, urlId=0, imageActive=0, imagePeak=0, bitmapActive=0, bitmapPeak=0;
  const timeOrigin=NativeDate.now();
  // Timer callbacks and defensive lease-deadline checks share one clock.
  // Keep Date callable and constructible, including explicit constructor args.
  function BrowserDate(...args) {
    if(!new.target)return new NativeDate(timeOrigin+now).toString();
    return Reflect.construct(NativeDate,args.length?args:[timeOrigin+now],new.target);
  }
  Object.setPrototypeOf(BrowserDate,NativeDate);BrowserDate.prototype=NativeDate.prototype;
  Object.defineProperty(BrowserDate,'now',{value:()=>timeOrigin+now});
  const settings = {autoImage:true,autoBitmap:true,autoEncode:true,autoFont:true,failMetrics:false,missingRoundRect:false,failEvenOdd:false,...config};
  const fontReady = deferred(), fonts = originalCreateElement('font-set');
  fonts.status='loaded'; fonts.ready=fontReady.promise;
  fonts.check=() => settings.fontCheck !== false;
  fonts.load=(font,text) => {const gate=deferred(), record={font,text,gate}; fontLoads.push(record);if(settings.fontLoadThrow)throw new Error('PRIVATE_PATH synchronous font failure');if(settings.autoFont) queueMicrotask(()=>gate.resolve([])); return gate.promise;};
  if (!settings.holdFontReady) fontReady.resolve(fonts);
  doc.fonts=fonts;
  function blob(width,height,{size=null,headerGate=null}={}) {
    const bytes=pngBytes(width,height);
    // Accounting-only optional size follows the protected core SizedBlob seam:
    // no claim that a synthetic 192 MiB retention test allocates those pixels.
    class HeaderBlob extends NativeBlob {
      get size(){return size??super.size;}
      arrayBuffer() {return headerGate ? headerGate.promise.then(()=>super.arrayBuffer()) : super.arrayBuffer();}
      slice(...args) {const result=super.slice(...args); if(!headerGate) return result; return new HeaderBlob([result],{type:result.type});}
    }
    const value=new HeaderBlob([bytes],{type:'image/png'}); dimensions.set(value,{width,height}); return value;
  }
  function makeImage() {
    const element=originalCreateElement('img'); let current=null;
    Object.defineProperties(element,{
      src:{configurable:true,get(){return element.getAttribute('src')||'';},set(value){element.setAttribute('src',String(value));}},
      naturalWidth:{configurable:true,get(){return current?.width||0;}},
      naturalHeight:{configurable:true,get(){return current?.height||0;}},
      complete:{configurable:true,get(){return current?.settled===true;}},
    });
    element.decode=()=>{
      const url=element.src, resource=urls.get(url), gate=deferred();
      assert.ok(resource && !resource.revoked, 'image decode uses a live object URL');
      const size=dimensions.get(resource.blob); assert.ok(size,'synthetic decoder requires known PNG dimensions');
      const record={element,url,blob:resource.blob,...size,gate,settled:false}; current=record; imageDecodes.push(record);
      imageActive++; imagePeak=Math.max(imagePeak,imageActive);
      const result=gate.promise.then(()=>{record.settled=true; imageActive--;},error=>{record.settled=true; imageActive--; throw error;});
      if(settings.autoImage) queueMicrotask(()=>gate.resolve()); return result;
    };
    return element;
  }
  function makeCanvas() {
    const element=originalCreateElement('canvas'), trace=[]; let width=300,height=150;
    const record={element,trace,paint:[],encoded:false}; canvases.push(record);
    Object.defineProperties(element,{width:{configurable:true,get:()=>width,set(value){width=Number(value);trace.push(['width',width]);}},
      height:{configurable:true,get:()=>height,set(value){height=Number(value);trace.push(['height',height]);}}});
    const context={canvas:element, measureText(text) {
      if(settings.failMetrics) return {width:String(text).length*7};
      const size=Number(String(this.font).match(/([\d.]+)px/)?.[1]||16), advance=String(text).length*size*0.45;
      return {width:advance,actualBoundingBoxLeft:0,actualBoundingBoxRight:advance,actualBoundingBoxAscent:size*0.72,actualBoundingBoxDescent:size*0.2};
    }};
    for(const method of ['setTransform','clearRect','fillRect','save','restore','beginPath','rect','roundRect','clip','fill','drawImage','fillText']) {
      context[method]=(...args)=>{trace.push([method,...args]);record.paint.push({method,args,fillStyle:context.fillStyle,font:context.font});if(method==='fill'&&args[0]==='evenodd'&&settings.failEvenOdd) throw new Error('synthetic missing evenodd');};
    }
    if(settings.missingRoundRect) delete context.roundRect;
    element.getContext=kind=>kind==='2d'?context:null;
    element.toBlob=(callback,type,...rest)=>{
      assert.equal(type,'image/png'); assert.equal(rest.length,0,'no encoder quality/format alternatives');
      const record={element,callback,width,height,settled:false}; encodes.push(record);
      record.finish=value=>{assert.equal(record.settled,false);record.settled=true;record.blob=value;callback(value);};
      if(settings.autoEncode) queueMicrotask(()=>record.finish(blob(width,height,{size:settings.outputBytes??null})));
    };
    return element;
  }
  doc.createElement=name=>String(name).toLowerCase()==='canvas'?makeCanvas():String(name).toLowerCase()==='img'?makeImage():originalCreateElement(name);
  prototype=win.Element.prototype;oldClick=prototype.click;
  for(const property of ['min','max','step'])Object.defineProperty(prototype,property,{configurable:true,get(){return this.getAttribute(property)||'';},set(value){this.setAttribute(property,String(value));}});
  const liveValues=new WeakMap(),liveChecked=new WeakMap();
  Object.defineProperty(prototype,'value',{configurable:true,get(){return liveValues.get(this)??this.getAttribute('value')??'';},set(value){liveValues.set(this,String(value));}});
  Object.defineProperty(prototype,'checked',{configurable:true,get(){return liveChecked.get(this)??this.hasAttribute('checked');},set(value){liveChecked.set(this,Boolean(value));}});
  prototype.stepUp=function(count=1){assert.equal(this.type,'range','bounded stepping fixture supports range only');const min=Number(this.min||0),max=Number(this.max||100),step=Number(this.step||1);this.value=Math.max(min,Math.min(max,Number(this.value)+Number(count)*step));};
  prototype.stepDown=function(count=1){this.stepUp(-count);};
  prototype.click=function(){
    if(this.tagName==='A' && this.hasAttribute('download')) {
      const url=this.getAttribute('href'), resource=urls.get(url);
      assert.ok(resource&&!resource.revoked,'download starts with a live dedicated URL');
      downloads.push({element:this,url,blob:resource.blob,filename:this.getAttribute('download'),at:now});
    }
    return click(this);
  };
  for(const property of ['src','href','download']) if(!Object.getOwnPropertyDescriptor(prototype,property)) Object.defineProperty(prototype,property,{configurable:true,get(){return this.getAttribute(property)||'';},set(value){this.setAttribute(property,String(value));}});
  const BrowserURL=class extends URL {};
  BrowserURL.createObjectURL=value=>{
    assert.ok(value instanceof NativeBlob,'only a Blob receives an object URL');
    const url=`blob:https://albumhaven.test/synthetic-image-${++urlId}`;
    urls.set(url,{url,blob:value,revoked:false,at:now});urlEvents.push({type:'create',url,blob:value});
    settings.onCreateURL?.(value,url);return url;
  };
  BrowserURL.revokeObjectURL=url=>{const row=urls.get(url);assert.ok(row,'revoke only an owned URL'); assert.equal(row.revoked,false,'no double revocation'); row.revoked=true;revoked.push(url);urlEvents.push({type:'revoke',url,blob:row.blob});if(settings.revokeThrow) throw new Error('synthetic revoke failure');};
  const browser={document:doc,window:win,URL:BrowserURL,Blob:NativeBlob,Date:BrowserDate,performance:{timeOrigin,now:()=>now},Image:function(){return makeImage();},Event:win.Event,CustomEvent:win.Event,
    Element:win.Element,HTMLElement:win.HTMLElement,Node:win.Node,AbortController,TextEncoder,TextDecoder,
    createImageBitmap(value,...args) {
      assert.equal(args.length,0,'bitmap decoder has no resize or alternate options'); assert.ok(value instanceof NativeBlob);
      const size=dimensions.get(value);assert.ok(size,'only admitted prepared PNGs are decoded');
      const gate=deferred(), record={blob:value,...size,gate,closed:0}; bitmaps.push(record); bitmapActive++;bitmapPeak=Math.max(bitmapPeak,bitmapActive);
      const result=gate.promise.then(patch=>{bitmapActive--; return {width:patch?.width??record.width,height:patch?.height??record.height,close(){record.closed++;if(settings.bitmapCloseThrow)throw new Error('synthetic release failure');}};},error=>{bitmapActive--;throw error;});
      if(settings.autoBitmap)queueMicrotask(()=>gate.resolve());return result;
    },
    requestAnimationFrame:win.requestAnimationFrame,cancelAnimationFrame:win.cancelAnimationFrame,
    setTimeout(callback,delay=0){const key=++timerId;timers.set(key,{callback,delay:Number(delay),due:now+Number(delay)});return key;},
    clearTimeout:key=>timers.delete(key),
    getComputedStyle:win.getComputedStyle,
    fetch(){assert.fail('coordinator must obtain artwork through the admitted access port, not ambient fetch');},
  };
  for(const [key,value]of Object.entries(browser)){installGlobal(key,value);win[key]=value;}
  for(const [key,tag]of Object.entries({HTMLCanvasElement:'CANVAS',HTMLImageElement:'IMG',HTMLInputElement:'INPUT',HTMLAnchorElement:'A'})) {const type=class{static [Symbol.hasInstance](value){return value instanceof win.Element&&value.tagName===tag;}};installGlobal(key,type);win[key]=type;}
  if(!globalThis.crypto) installGlobal('crypto',require('node:crypto').webcrypto);
  const accesses=[], captureKeys=[], preparations=[], reads=[], releases=[], watches=[], unsubscriptions=[], comparisons=[], closeNotices=[];
  let count=config.count??7, title=config.title??'Synthetic Album Top';
  const rows=()=>Array.from({length:count},(_,n)=>({item_ref:id(100+n),album_ref:id(200+n),title:`Album ${n+1}`,artist:`Artist ${n+1}`,year:2001+n}));
  const scopeKey=runtime.snapshot().scopeKey;
  let state={scopeKey,selectedTopRef:TOP,directory:{status:'ready',data:{tops:[]}},detail:{status:'ready',data:{top_ref:TOP,revision:'7',title,description:'Synthetic complete collection',items:rows(),allowed_actions:permissions()}},mutation:{status:'idle',refreshing:false}};
  const subscribers=new Set(),controller={getSnapshot:()=>state,subscribe(callback){subscribers.add(callback);return()=>subscribers.delete(callback);}};
  const providers=Object.freeze({resolveNativeAlbum(){assert.fail('coordinator must use access.readOwnRatings rather than bypass it');}});
  const makeRatings=(capture,{rating=7,revision='preference-1'}={})=>{
    const result=frozen({binding:{...capture.source.binding},items:capture.source.items.map(row=>({item_ref:row.item_ref,rating}))});
    ratingReceipts.set(result,{capture,revision,released:false});return result;
  };
  const ratingReceipts=new WeakMap();
  let retainedCoordinator=null,coordinatorFactoryCalled=false;
  const bridge=Object.freeze({
    coordinator(factory){assert.equal(typeof factory,'function');if(!coordinatorFactoryCalled){coordinatorFactoryCalled=true;retainedCoordinator=factory();}return retainedCoordinator;},
    createAccess(options) {
      assert.deepEqual(Object.keys(options).sort(),['attribution','controller','onRetired','providers']);
      assert.equal(options.controller,controller);assert.equal(options.providers,providers);assert.equal(typeof options.onRetired,'function');
      if(settings.createAccessThrow)throw Object.assign(new Error('PRIVATE_PATH synchronous access failure'),{code:'unavailable'});
      const record={options,disposed:false,captures:[]};accesses.push(record);
      const retired=new WeakSet(),capturedStates=new WeakMap();
      const current=capture=>{
        if(!record.captures.includes(capture))return false;
        if(record.disposed||retired.has(capture)||capturedStates.get(capture)!==state){retired.add(capture);return false;}
        return true;
      };
      const api=Object.freeze({
        capture({sourceKey}) {
          assert.equal(typeof sourceKey,'string');assert.ok(sourceKey.length>0&&sourceKey.length<=4096);captureKeys.push(sourceKey);
          const detail=state.detail.data;
          const token=frozen({source:{binding:{scopeKey,topRef:TOP,revision:detail.revision,sourceKey},complete:true,total:detail.items.length,
            title:detail.title,description:detail.description,attribution:options.attribution,items:detail.items.map(({item_ref,album_ref,title,artist,year})=>({item_ref,album_ref,title,artist,year}))}});
          capturedStates.set(token,state);record.captures.push(token);return token;
        },
        isCurrent:current,
        readOwnRatings(capture,options) {
          assert.ok(current(capture));assert.ok(options.signal instanceof AbortSignal);const gate=deferred(),row={capture,options,gate,record};reads.push(row);
          if(settings.readRatingsThrow)throw Object.assign(new Error('SECRET_CONTEXT synchronous taste failure'),{code:'own_ratings_unavailable'});
          if(settings.autoRatings!==false)queueMicrotask(()=>gate.resolve(makeRatings(capture)));return gate.promise;
        },
        watchOwnRatings(capture,ratings,onChange) {
          const receipt=ratingReceipts.get(ratings);assert.ok(receipt&&!receipt.released&&receipt.capture===capture);
          const watch={capture,ratings,onChange,retired:false,change(){if(watch.retired)return;watch.retired=true;retired.add(capture);onChange();}};
          watches.push(watch);return()=>{if(watch.retired)return;watch.retired=true;unsubscriptions.push(watch);};
        },
        releaseOwnRatings(ratings) {
          const receipt=ratingReceipts.get(ratings);assert.ok(receipt,'release only genuine result');if(receipt.released)return;receipt.released=true;releases.push(ratings);
          for(const watch of watches)if(watch.ratings===ratings)watch.retired=true;
          if(settings.ratingReleaseThrow)throw new Error('synthetic rating cleanup failure');
        },
        sameOwnRatings(previous,next) {
          comparisons.push({previous,next});const a=ratingReceipts.get(previous),b=ratingReceipts.get(next);
          return Boolean(a&&b&&!a.released&&!b.released&&a.capture===b.capture&&current(a.capture)&&a.revision===b.revision&&JSON.stringify(previous.items)===JSON.stringify(next.items));
        },
        prepareCover(capture,request){return prepare(record,capture,request,'cover');},
        prepareBrand(capture,request){return prepare(record,capture,request,'brand');},
        dispose(){if(record.disposed)return;record.disposed=true;for(const watch of watches)if(record.captures.includes(watch.capture))watch.retired=true;if(settings.accessDisposeThrow)throw new Error('synthetic access cleanup failure');},
      });
      record.api=api;record.retire=(capture=record.captures.at(-1),reason='source_retired')=>{if(retired.has(capture))return;retired.add(capture);options.onRetired(capture,reason);};return api;
    },
  });
  function prepare(record,capture,request,kind) {
    assert.equal(record.api.isCurrent(capture),true);assert.equal(request.kind,kind);assert.deepEqual(request.binding,capture.source.binding);
    assert.equal(request.maxEncodedBytes,20971520);assert.equal(request.maxWidth,2048);assert.equal(request.maxHeight,2048);
    if(kind==='brand'){assert.equal(request.itemRef,null);assert.equal(request.albumRef,null);}
    const gate=deferred(),row={record,capture,request,gate,released:0};preparations.push(row);
    row.value=()=>({blob:blob(kind==='brand'?245:31,kind==='brand'?230:17),width:kind==='brand'?245:31,height:kind==='brand'?230:17,
      release(){row.released++;if(settings.prepareReleaseThrow)throw new Error('synthetic preparation cleanup failure');}});
    if(settings.autoPrepare!==false)queueMicrotask(()=>gate.resolve(row.value()));return gate.promise;
  }
  const {createAlbumTopImageCoordinator}=await load('image-export-coordinator.mjs');
  assert.equal(typeof createAlbumTopImageCoordinator,'function','R3 public coordinator export exists');
  coordinator=createAlbumTopImageCoordinator({runtime,bridge});
  env={...native,runtime,bridge,coordinator,settings,fonts,fontReady,fontLoads,canvases,encodes,bitmaps,imageDecodes,urls,revoked,urlEvents,downloads,timers,
    accesses,captureKeys,preparations,reads,releases,watches,comparisons,unsubscriptions,closeNotices,controller,providers,blob,makeRatings,
    get imageActive(){return imageActive;},get imagePeak(){return imagePeak;},get bitmapActive(){return bitmapActive;},get bitmapPeak(){return bitmapPeak;},
    open(extra={}) {const handle=coordinator.open({controller,providers,attribution:'Synthetic curator',returnFocus:()=>native.host.focus(),fallbackHost:native.host,
      onClose(){closeNotices.push(handles.length);extra.onClose?.();}});handles.push(handle);return handle;},
    changeState(patch) {state={...state,...patch};for(const listener of [...subscribers])listener();return state;},
    get state(){return state;},
    advance(ms) {now+=ms;for(const[key,row]of [...timers])if(row.due<=now){timers.delete(key);row.callback();}},
    frame() {for(const[key,callback]of [...native.frames]){native.frames.delete(key);callback(now);}},
    async pump(rounds=6) {for(let i=0;i<rounds;i++){await settle();env.advance(0);env.frame();}await settle();},
    liveUrls(){return [...urls.values()].filter(row=>!row.revoked);},
    preview(){return [...doc.querySelectorAll('img')].find(node=>visible(node)&&node.src?.startsWith('blob:'))||null;},
    text(){return native.content().textContent;},
  };
  return env;
}
module.exports={fixture,load,settle,deferred,observe,visible,name,findControl,button,disabled,assertDisabled,click,input,toggle,pngBytes};
