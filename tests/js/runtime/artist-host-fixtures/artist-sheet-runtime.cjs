'use strict';
// Additive browser inputs only. The accepted Artist fixture and every product
// owner remain unchanged. Candidate sources are resolved by its existing ROOT.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {fixture: artistFixture, artistView, album, group, ARTIST, drain, ROOT} = require('./actual-artist-runtime.cjs');
const {read} = require('../search-native-fixtures/actual-runtime.cjs');
function sheetPlatform(h) {
  const c = h.context, doc = h.document, proto = c.Element.prototype;
  const styled = new WeakSet(), captured = new WeakMap(), cssName = key => String(key).replace(/[A-Z]/g, x => '-' + x.toLowerCase());
  // Bounded CSSOM serialization input. This is not a style/layout engine:
  // supported px lengths use six significant digits; translate3d accepts three
  // px lengths or unitless zero and serializes zero lengths with px units.
  const cssNumber=value=>String(Number(Number(value).toPrecision(6)));
  const cssLength=value=>{const text=String(value).trim();if(/^[-+]?0(?:\.0+)?$/.test(text))return '0px';
    const match=text.match(/^([-+]?(?:\d+(?:\.\d*)?|\.\d+))px$/);return match?cssNumber(match[1])+'px':null;};
  function canonicalCss(key,value){
    const text=String(value).trim();if(['top','height','left','right','bottom','width'].includes(key))return cssLength(text)||text;
    if(key==='transform'){
      const match=text.match(/^translate3d\(\s*([^,]+),\s*([^,]+),\s*([^,)]+)\s*\)$/);
      if(match){const values=match.slice(1).map(cssLength);if(values.every(value=>value!==null))return 'translate3d('+values.join(', ')+')';}
    }return text;
  }
  function styleNode(node) {
    if (!node?.style || styled.has(node)) return node;
    styled.add(node);
    const original = node.style, priorities = new Map();
    node.style = new Proxy({
      getPropertyValue: key => original.getPropertyValue(key),
      getPropertyPriority: key => priorities.get(key) || '',
      setProperty(key, value, priority = '') {if(value==null||String(value)===''){priorities.delete(key);original.removeProperty(key);return;}const p=String(priority).toLowerCase();if(p&&p!=='important')return;priorities.set(key,p);original.setProperty(key,canonicalCss(key,value));},
      removeProperty(key) {priorities.delete(key); return original.removeProperty(key);},
    }, {get(target,key) {return key in target ? target[key] : original.getPropertyValue(cssName(key));},
      set(target,key,value) {target.setProperty(cssName(key), value); return true;}});
    return node;
  }
  const create = doc.createElement.bind(doc); doc.createElement = name => styleNode(create(name));
  for (const node of [doc.documentElement, ...doc.querySelectorAll('*')]) styleNode(node);
  // Platform image allocation only: requests never leave the synthetic DOM and
  // no load/decode completion is invented. Actual lightbox lifecycle owns it.
  c.Image = function Image() {const node=doc.createElement('img');node.complete=false;node.naturalWidth=0;node.naturalHeight=0;return node;};
  proto.setPointerCapture = function(id) {if (!this.isConnected) throw new Error('Disconnected pointer capture'); captured.set(this,id);};
  proto.hasPointerCapture = function(id) {return captured.get(this) === id;};
  proto.releasePointerCapture = function(id) {if (captured.get(this) === id) captured.delete(this);};
  if (!proto.compareDocumentPosition) proto.compareDocumentPosition = function(other) {
    if (this === other) return 0;
    if (!this.isConnected || !other?.isConnected) return 1;
    if (this.contains(other)) return 20;
    if (other.contains(this)) return 10;
    const nodes=[doc,...doc.querySelectorAll('*')];return nodes.indexOf(this)<nodes.indexOf(other)?4:2;
  };
  const insert=proto.insertBefore;
  proto.insertBefore=function(node,before){const result=insert.call(this,node,before);
    for(const item of [node,...(node.querySelectorAll?.('*') || [])]) {
      styleNode(item);
      if(item.matches?.('.confirm-modal,.tag-editor-modal,.cover-lookup-modal,.image-lightbox'))
        h.setRect(item,{x:0,y:0,width:390,height:800});
    } return result;
  };
  const computed = c.getComputedStyle;
  const sheetCss=read('music_app/static/css/runtime/bottom-sheet.css');
  const sheetLayer=sheetCss.match(/\.track-modal\.is-artist-discography-sheet\s*\{[^}]*z-index:\s*(\d+)/)?.[1];
  assert.ok(sheetLayer,'served stylesheet declares the sheet layer');
  c.getComputedStyle = node => ({...computed(node), zIndex: node.style.zIndex || (node.classList.contains('is-artist-discography-sheet') ? sheetLayer : 'auto'),
    overflowY: node.style.overflowY || 'visible', display: node.hidden ? 'none' : node.style.display || 'block',
    getPropertyValue: key => node.style.getPropertyValue(key)});
  const focusAttempts=[],nativeFocus=proto.focus;
  proto.focus=function(options){
    const connected=this.isConnected,blocked=this.closest('[hidden],[inert]');
    let displayBlocked=false;for(let node=this;node;node=node.parentElement){const css=c.getComputedStyle(node);if(css.display==='none'||css.visibility==='hidden')displayBlocked=true;}
    const foreground=typeof c.getTopmostOpenModal==='function'?c.getTopmostOpenModal():null;
    const accepted=connected&&!this.disabled&&!blocked&&!displayBlocked;
    const bounds=this.getBoundingClientRect(),viewport=h.scroll.getBoundingClientRect(),lease=h.grid?._artistPageLease;
    const record=lease&&[...lease.mounted.values()].find(record=>record.element.contains(this));
    const candidate=this.closest('[data-album-key]');
    focusAttempts.push({node:this,options,connected,blocked,displayBlocked,foreground,accepted,
      bounds:{left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom},
      viewport:{left:viewport.left,right:viewport.right,top:viewport.top,bottom:viewport.bottom},
      intersectsViewport:bounds.bottom>viewport.top&&bounds.top<viewport.bottom&&bounds.right>viewport.left&&bounds.left<viewport.right,
      clientRects:this.getClientRects().length,disabled:this.disabled,lease,record,
      sectionKey:record&&h.grid.sections.find(section=>h.grid.getRenderedSectionKey(section)===record.key)?.sectionKey,
      albumKey:candidate?.getAttribute('data-album-key'),versionKey:candidate?.getAttribute('data-album-version-key'),
      trigger:candidate?(candidate.classList.contains('cover')?'cover':'tracklist'):null,
      foregroundEligible:!foreground||foreground===this||foreground.contains(this)});
    if(accepted)return nativeFocus.call(this,options);
  };
  let now = 0; c.performance = {now: () => now};
  // Window listeners registered by actual owners after fixture construction get
  // browser capture-before-target ordering. Existing history listeners keep the
  // accepted fixture's history/popstate implementation, unchanged.
  const manualEvents=new WeakSet();
  const windowListeners = [], baseAdd = c.addEventListener, baseRemove = c.removeEventListener, baseDispatch = c.dispatchEvent;
  c.addEventListener = (type, callback, options = false) => {
    const capture=options===true||options?.capture===true;
    if(windowListeners.some(row=>row.type===type&&row.callback===callback&&row.capture===capture))return;
    const row={type,callback,capture,once:options?.once===true};
    row.forward=event=>{if(manualEvents.has(event))return;if(row.once)c.removeEventListener(type,callback,capture);callback.call(c,event);};
    windowListeners.push(row);baseAdd(type,row.forward,options);
  };
  c.removeEventListener = (type, callback, options = false) => {const capture = options === true || options?.capture === true;
    const i = windowListeners.findIndex(row => row.type === type && row.callback === callback && row.capture === capture);
    if (i >= 0) {const [row]=windowListeners.splice(i,1);baseRemove(type,row.forward,options);} else baseRemove(type,callback,options);};
  function invoke(event, capture) {
    for (const row of [...windowListeners]) if (row.type === event.type && row.capture === capture
      && windowListeners.includes(row) && !event.immediate) {
      if (row.once) c.removeEventListener(row.type,row.callback,row.capture);
      row.callback.call(c,event);
    }
  }
  c.dispatchEvent = event => {if (!event.target) event.target = c;manualEvents.add(event);
    try {invoke(event,true);if(!event.immediate)baseDispatch(event);if(!event.immediate)invoke(event,false);return !event.defaultPrevented;}
    finally {manualEvents.delete(event);}};
  const viewportListeners = [];
  c.visualViewport = {offsetTop: 0, height: 800, width: 390,
    addEventListener(type, callback) {viewportListeners.push({type,callback});},
    removeEventListener(type, callback) {const i = viewportListeners.findIndex(row => row.type === type && row.callback === callback); if (i >= 0) viewportListeners.splice(i,1);},
    dispatchEvent(event) {event.target = this; for (const row of [...viewportListeners]) if (row.type === event.type) row.callback(event);}};
  function send(target, type, values = {}) {
    const event = new c.Event(type, {cancelable: values.cancelable !== false}); Object.assign(event, values); event.target = target;
    if (target === c) {c.dispatchEvent(event); return event;}
    if (target === c.visualViewport) {target.dispatchEvent(event); return event;}
    invoke(event,true); if (!event.stopped) target.dispatchEvent(event);
    if (!event.stopped && event.bubbles) invoke(event,false); return event;
  }
  const pointer = (target,type,x,y,extra = {}) => send(target,type,{pointerId: 1,isPrimary: true,pointerType:'touch',button:0,clientX:x,clientY:y,...extra});
  const touch = (target,type,points,extra = {}) => send(target,type,{touches:points.map(([x,y,id = 1])=>({clientX:x,clientY:y,identifier:id})),...extra});
  return {send,pointer,touch,focusAttempts,canonicalCss,advance: ms => {now += ms;},windowListeners,viewportListeners,
    styleNode, tick: () => h.flushFrames(), captured: node => captured.get(node),
    viewport(patch,type='resize') {Object.assign(c.visualViewport,patch); send(c.visualViewport,type);},
    restoreWindow() {c.addEventListener=baseAdd;c.removeEventListener=baseRemove;c.dispatchEvent=baseDispatch;}};
}
function servedAlbumMarkup(c) {
  const source = read('music_app/templates/partials/primary-modals.html');
  const start = source.indexOf('  <div class="track-modal" id="track-modal" hidden>');
  const end = source.indexOf('  <div class="cover-lookup-modal"',start);
  assert.ok(start >= 0 && end > start, 'actual complete served album shell is delimited');
  const markup = source.slice(start,end).replace(/{% call action_button\('([^']+)'([\s\S]*?)\) %}([\s\S]*?){% endcall %}/g,
    (_,label,args,contents) => {
      const id = args.match(/\bid='([^']+)'/)?.[1]; assert.ok(id, 'served action has its original ID');
      const attributes = {id};
      const dictionary = args.match(/attributes=\{([^}]+)\}/)?.[1];
      if (dictionary) for (const match of dictionary.matchAll(/'([^']+)': '([^']*)'/g)) attributes[match[1]]=match[2];
      const html = c.ButtonComponent.renderActionButton({ariaLabel:label,title:args.match(/\btitle='([^']+)'/)?.[1],
        className:args.match(/class_name='([^']+)'/)?.[1],disabled:/disabled=true/.test(args),attributes});
      // Only macro slot content is supplied; the actual ActionButton renderer
      // owns the button itself. No album markup or component is synthesized.
      return html.replace(/<\/button>$/,contents+'</button>');
    });
  assert.doesNotMatch(markup,/{%|{{/, 'unrecognized template instructions fail rather than silently disappear');
  return markup;
}
function fixture(t, options = {}) {
  const h = artistFixture(t,{mobile:true,...options}), c=h.context;
  // Existing pre-runtime client classifier is an actual product owner, not a
  // stubbed mobile flag. With no preference-bootstrap element this only exports
  // its API; it creates no store, writes no preference and sends no request.
  const profilePath='music_app/static/js/client-device-preferences.js';
  vm.runInContext(read(profilePath),c,{filename:profilePath});h.loaded.push(profilePath);
  const platform=sheetPlatform(h);
  h.document.getElementById('track-modal').remove();
  const primary=read('music_app/templates/partials/primary-modals.html');
  const tagStart=primary.indexOf('  <div class="tag-editor-modal"');
  const trackStart=primary.indexOf('  <div class="track-modal"');
  const coverStart=primary.indexOf('  <div class="cover-lookup-modal"');
  const nonAlbumStart=primary.indexOf('  <div class="non-album-modal"');
  assert.ok(tagStart>=0 && trackStart>tagStart && coverStart>trackStart && nonAlbumStart>coverStart);
  const plainMarkup=primary.slice(tagStart,trackStart)+primary.slice(coverStart,nonAlbumStart);
  assert.doesNotMatch(plainMarkup,/{%|{{/);
  const overlays=read('music_app/templates/partials/overlay-shells.html');
  assert.doesNotMatch(overlays,/{%|{{/);
  const confirms=read('music_app/templates/partials/confirm-modals.html');
  const confirmStart=confirms.indexOf('  <div class="confirm-modal" id="tag-edit-confirm-modal"');
  const confirmEnd=confirms.indexOf('  <div class="confirm-modal" id="cover-lookup-delete-confirm-modal"',confirmStart);
  assert.ok(confirmStart>=0&&confirmEnd>confirmStart);
  const tagConfirm=confirms.slice(confirmStart,confirmEnd).replace(
    "{{ on_page_alert('Applying non-album rarity exception to this track will remove it from the album. You sure?', severity='warning', title='Track will leave this album') }}",
    c.buildOnPageAlertHtml({message:'Applying non-album rarity exception to this track will remove it from the album. You sure?',severity:'warning',title:'Track will leave this album'}));
  assert.doesNotMatch(tagConfirm,/{%|{{/);
  h.document.body.insertAdjacentHTML('beforeend',servedAlbumMarkup(c)+plainMarkup+overlays+tagConfirm);
  for (const node of h.document.querySelectorAll('*')) platform.styleNode(node);
  const overlay=h.document.getElementById('track-modal'), panel=overlay.querySelector('[role="dialog"]');
  const scroller=overlay.querySelector('.track-modal-body'),handle=h.document.getElementById('track-modal-sheet-handle'),toggle=h.document.getElementById('track-modal-sheet-toggle');
  assert.ok(panel && scroller && handle && toggle);
  // A persistent player slot is a browser shell input. Its playback owner is the
  // actual runtime state. No Audio/media APIs are called by these tests.
  const player=h.document.createElement('div');player.className='global-player shell-bottom-player';
  player.setAttribute('data-shell-is-persistent','true');h.document.body.append(player);
  h.document.getElementById('image-lightbox').style.zIndex='4600';
  const playerButton=h.document.createElement('button');playerButton.textContent='Player control';player.append(playerButton);
  h.setRect(overlay,{x:0,y:0,width:390,height:800});
  h.setRect(h.header,{x:0,y:0,width:390,height:120});h.setRect(panel,{x:0,y:120,width:390,height:680});
  Object.assign(scroller,{scrollTop:0,clientHeight:400,scrollHeight:1200});
  for (const button of overlay.querySelectorAll('button')) h.setRect(button,{x:10,y:150,width:44,height:44});
  return {...h,...platform,overlay,panel,scroller,handle,toggle,player,playerButton};
}
async function mounted(t, options = {}) {
  const {view=artistView({artist_groups:[group(ARTIST,[fullAlbum(1)])],primary_artist_groups:[group(ARTIST,[fullAlbum(1)])]}),...settings}=options;
  const h=fixture(t,settings);await h.entry();await h.admit(view);h.frame();return h;
}
function fullAlbum(id, patch = {}) {return album(id,{tracks:[{path:`/library/${id}/01.flac`,name:'Track one',title:'Track one',track_number:1,duration:90}],...patch});}
function opener(h, kind='tracklist') {
  const nodes=[...h.nodes.container.querySelectorAll('[data-album-key]')];
  const button=nodes.find(node=>kind==='cover'?node.classList.contains('cover'):node.getAttribute('data-open-tracklist')==='1'&&!node.classList.contains('cover'));
  assert.ok(button,'real current Discography button exists');h.setRect(button,{x:20,y:200,width:120,height:44});
  const indexed=h.context.resolveTrackModalActionAlbum(button);assert.ok(indexed);return {button,indexed};
}
async function opened(t,options={}) {const h=await mounted(t,options),origin=opener(h);assert.equal(h.context.openTrackModalForButton(origin.button),true);await drain();h.frame();return {...h,opener:origin};}
module.exports={fixture,mounted,opened,opener,fullAlbum,sheetPlatform,artistView,group,ARTIST,drain,read,ROOT};
