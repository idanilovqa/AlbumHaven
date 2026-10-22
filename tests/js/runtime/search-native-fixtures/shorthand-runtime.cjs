'use strict';
// Static-authored connected acceptance fixture. Reference head:
// eb72310cb9b04344cc3f6894a768a23406d67d71. The fixture loads the candidate ROOT,
// never a retained proposal or an implementation copied into these tests.
// Inspected unchanged dependencies (Git blobs): bootstrap-init.js
// c76edd9b4e6d1606c8ee738b8e4f337a9c0b90fd; native-controls.mjs
// 34d49cbc4f4cab9b6119a2955eafd53faa1e670e; track-table-presentation.mjs
// 685493965a0e5bff01e8500106899f326a0fff50. Backend pending_page witness:
// private_search_postgres.py d4ff31a5a8ebd466a89cc91bd7d0db64e950c6b2,
// read-only inspection at lines 602-675; it is never imported or run here.
// Existing native-home-harness and playlist-dom-platform are read-only platform
// dependencies. No production request, parser, admission, apply, navigation,
// Search controller, native renderer or consumer is substituted below.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../../../..'));
const {createNativeHomeRuntime} = require(path.join(ROOT, 'tests/js/runtime/native-home-harness.cjs'));
const {withPlaylistDomPlatform} = require(path.join(ROOT, 'tests/js/runtime/playlist-dom-platform.cjs'));
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const outcome = value => Promise.resolve(value).then(value => ({value}), error => ({error}));
const deferred = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject};};
async function drain() {for (let i=0; i<32; i++) await Promise.resolve();}
const A = 'a'.repeat(64), B = 'b'.repeat(64), ARTIST = 'Witness Artist';
const album = (id = 11, patch = {}) => ({album_ref:`inventory-album:9:${id}`, name:`Witness album ${id}`,
  year:2001, edition:'Original', allowed_actions:{can_read:true,can_view_details:true}, matches_search:true, ...patch});
const artist = name => ({artist:name,artist_display:name});
const sidebar = (names = [ARTIST], cursor = 'sealed-sidebar-A') => ({artists:names.map(artist),returned_count:names.length,has_more:cursor !== null,next_cursor:cursor});
const track = (id = 101, patch = {}) => ({inventory_track_ref:`inventory-track:9:${id}`,canonical_track_ref:null,
  title:`Witness track ${id}`,artist:ARTIST,album:'Witness album 11',duration_seconds:90,disc_number:1,track_number:1,
  parent_album:album(),allowed_actions:{can_read:true,can_select:true}, ...patch});
// Explicit wire examples, not a parser. Query text is always sent unchanged.
const criteria = query => ({subject:'self',predicate_domain:'tracks',love:query==='-love:obsessed'
  ? {include:[],exclude:['obsessed']} : {include:query===':loved :obsessed'?['loved','obsessed']:[[':obsessed','love:obsessed'].includes(query)?'obsessed':'loved'],exclude:[]},name_scopes:['artists','albums','tracks']});
function ready({query=':loved',presentation='albums',all=false,patch={}} = {}) {
  const tracks = presentation === 'tracks' ? [track(101),track(102,{parent_album:album(12),album:'Witness album 12'})] : [];
  return {status:'ready',private_search:true,contract_version:'own-love-v1',context_ref:A,query,criteria:criteria(query),presentation,
    selected_artist:all?null:ARTIST,selection_state:all?'all_artists':'selected',
    artist_groups:presentation === 'albums'?[{...artist(ARTIST),albums:[album()]}]:[],tracks,
    page:{limit:50,returned_count:presentation === 'albums'?1:tracks.length,has_more:true,next_cursor:'sealed-results-A'},sidebar:sidebar(),...patch};
}
function pending(parent = ready(), patch = {}) {return {...parent,status:'pending',selection_pending:true,artist_groups:[],tracks:[],
  page:{limit:50,returned_count:0,has_more:true,next_cursor:'sealed-results-pending'},sidebar:sidebar([],'sealed-sidebar-pending'),...patch};}
function firstWitness(presentation = 'albums', patch = {}) {return ready({presentation,patch:{selected_artist:null,selection_state:'pending_page',
  artist_groups:[],tracks:[],page:{limit:50,returned_count:0,has_more:true,next_cursor:'sealed-results-first'},sidebar:sidebar([],'sealed-sidebar-first'),...patch}});}
function child(parent = ready(), {names=['Second Artist'],cursor='sealed-sidebar-B',patch={}} = {}) {
  const {artist_groups,tracks,page,sidebar:previous,...envelope} = parent;
  return {...envelope,sidebar_only:true,sidebar:sidebar(names,cursor),...patch};
}
function ordinary(query = '') {return {ok:true,surface:{active:'albums'},query,selected_artist:'',artist_groups:[],primary_artist_groups:[],family_artist_groups:[],
  artists_sidebar:[artist('Ordinary Artist')],related_artists:[],non_album_tracks:[],visible_library_categories:['main_library'],gallery_scope:'all',
  artist_count:1,album_count:0,show_all_artists_sidebar_link:true,payload_tier:'full'};}
const mainUrl = (payload=ready(),extra={}) => '/view-data?'+new URLSearchParams({surface:'albums',q:payload.query,search_presentation:payload.presentation,
  ...(payload.selection_state==='all_artists'?{all_artists:'1'}:payload.selected_artist?{artist:payload.selected_artist}:{}),...extra});
let instance = 0;
function withSearchAttributePrefixPlatform(env) {
  const proto=env.context.Element.prototype,basicMatches=proto.matches;
  // Install beneath the existing compound/list/:not/closest compiler. Only a
  // standalone ID or lowercase data-* prefix with a quoted ASCII value is added;
  // other syntax retains
  // the protected primitive's explicit validation and unsupported failures.
  proto.matches=function(selector){
    const prefix=typeof selector==='string'&&selector.match(/^\[(id|data-[a-z][a-z0-9-]*)\^=(["'])([A-Za-z0-9_-]*)\2\]$/);
    if(!prefix)return basicMatches.call(this,selector);
    const value=this.nodeType===1?this.getAttribute(prefix[1]):null;
    return prefix[3]!==''&&value!==null&&value.startsWith(prefix[3]);
  };
  return env;
}
function fixture(t, {url='https://albumhaven.test/?surface=albums',initial=ordinary(),bootstrap={},holdRuntime=false}={}) {
  const env=withPlaylistDomPlatform(withSearchAttributePrefixPlatform(createNativeHomeRuntime())), c=env.context, doc=env.document;
  const requests=[],invocations=[],applications=[],historyCalls=[],storageCalls=[],redirects=[],loaded=[],listeners=[],observers=[],resizers=[],timers=new Map(),frames=new Map();
  let timer=0,frame=0,historyIndex=0;
  const location=new URL(url); location.assign=value=>redirects.push(String(value));
  const entries=[{url:location.href,state:null}];
  const emit=event=>{for(const capture of [true,false]) for(const row of [...listeners]) {
    if(row.type===event.type&&row.capture===capture&&!event.immediate) row.callback(event);
  } return !event.defaultPrevented;};
  const history={get state(){return entries[historyIndex].state;},pushState(value,_title,next){location.href=new URL(next,location).href;
    entries.splice(++historyIndex,Infinity,{url:location.href,state:structuredClone(value)});historyCalls.push({mode:'push',url:location.href,value:plain(value)});},
    replaceState(value,_title,next){if(next)location.href=new URL(next,location).href;entries[historyIndex]={url:location.href,state:structuredClone(value)};
      historyCalls.push({mode:'replace',url:location.href,value:plain(value)});},
    go(delta){if(historyIndex+delta<0||historyIndex+delta>=entries.length)return;historyIndex+=delta;location.href=entries[historyIndex].url;
      const event=new c.Event('popstate');event.state=history.state;emit(event);},back(){this.go(-1);},forward(){this.go(1);}};
  const storage=()=>{const values=new Map();return {getItem:key=>values.get(String(key))??null,setItem(key,value){values.set(String(key),String(value));storageCalls.push({key:String(key),value:String(value)});},removeItem:key=>values.delete(String(key)),clear:()=>values.clear()};};
  Object.assign(c,{URL,URLSearchParams,AbortController,structuredClone,location,history,crypto:require('node:crypto').webcrypto,
    __ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__:{initial_view:structuredClone(initial),bootstrap:structuredClone(bootstrap)},
    __ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__:{},innerWidth:1200,innerHeight:800,devicePixelRatio:1,
    navigator:{userAgent:'Native Search acceptance fixture',platform:'Linux',onLine:true},performance:{now:()=>0},
    localStorage:storage(),sessionStorage:storage(),CustomEvent:c.Event,PointerEvent:c.Event,KeyboardEvent:c.Event,
    getComputedStyle:()=>({display:'block',columnGap:'8px',overflowY:'visible',getPropertyValue:()=>''}),
    matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}}),
    addEventListener(type,callback,options=false){listeners.push({type,callback,capture:options===true||options?.capture===true});},
    removeEventListener(type,callback,options=false){const capture=options===true||options?.capture===true;const i=listeners.findIndex(x=>x.type===type&&x.callback===callback&&x.capture===capture);if(i>=0)listeners.splice(i,1);},
    dispatchEvent:emit,queueMicrotask,
    setTimeout(callback,delay=0){timers.set(++timer,{callback,delay});return timer;},clearTimeout:key=>timers.delete(key),
    setInterval(callback,delay=0){timers.set(++timer,{callback,delay,interval:true});return timer;},clearInterval:key=>timers.delete(key),
    requestAnimationFrame(callback){frames.set(++frame,callback);return frame;},cancelAnimationFrame:key=>frames.delete(key),
    requestIdleCallback(callback){timers.set(++timer,{callback,delay:0,idle:true});return timer;},cancelIdleCallback:key=>timers.delete(key),
    ResizeObserver:class {constructor(callback){this.callback=callback;this.nodes=new Set();this.retired=false;resizers.push(this);}observe(node){this.nodes.add(node);}unobserve(node){this.nodes.delete(node);}disconnect(){this.retired=true;this.nodes.clear();}},
    IntersectionObserver:class {observe(){}unobserve(){}disconnect(){}},
    MutationObserver:class {constructor(callback){this.callback=callback;this.records=[];this.targets=[];observers.push(this);}observe(target,options){this.targets.push({target,options});this.retired=false;}takeRecords(){return this.records.splice(0);}disconnect(){this.targets=[];this.records=[];this.retired=true;}},
    fetch(requestUrl,options={}){const work=deferred(),jsonStarted=deferred();const request={url:String(requestUrl),options,settled:false,jsonStarted:jsonStarted.promise,
      resolve(payload,status=200){assert.equal(this.settled,false,'network response settles once');this.settled=true;work.resolve({ok:status>=200&&status<300,status,headers:{get:()=> 'application/json'},json:async()=>{jsonStarted.resolve();return payload;}});},
      holdJson(status=200){assert.equal(this.settled,false);this.settled=true;const body=deferred();work.resolve({ok:status>=200&&status<300,status,headers:{get:()=> 'application/json'},json(){jsonStarted.resolve();return body.promise;}});return body;},
      reject(error){assert.equal(this.settled,false);this.settled=true;work.reject(error);}};requests.push(request);return work.promise;},
  });
  doc.defaultView=c;env.installWindow(c);doc.documentElement.clientWidth=1200;doc.visibilityState='visible';doc.hidden=false;
  for(const [name,tag]of Object.entries({HTMLFormElement:'FORM',HTMLInputElement:'INPUT',HTMLButtonElement:'BUTTON',HTMLImageElement:'IMG',HTMLTextAreaElement:'TEXTAREA'})){
    c[name]=class {static [Symbol.hasInstance](value){return value instanceof c.Element&&value.tagName===tag;}};
  }
  const proto=c.Element.prototype;
  // The protected platform covers descendants but deliberately rejects child
  // combinators. Real modal setup queries direct-child chains even with no modal.
  // Add that browser primitive here; never substitute the production modal owner.
  const queryAll=proto.querySelectorAll,basicMatch=proto.matches;
  function childBranches(selector){
    if(typeof selector!=='string')return null;
    let quote='',square=0,round=0,start=0,hasChild=false;const branches=[[]];
    for(let i=0;i<selector.length;i++){
      const ch=selector[i];
      if(quote){if(ch===quote&&selector[i-1]!=='\\')quote='';continue;}
      if(ch==='"'||ch==="'"){quote=ch;continue;}
      if(ch==='[')square++;if(ch===']')square--;
      if(ch==='(')round++;if(ch===')')round--;
      if(square<0||round<0)throw new SyntaxError('Unbalanced selector');
      if(!square&&!round&&(ch==='>'||ch===',')){
        branches.at(-1).push(selector.slice(start,i).trim());start=i+1;
        if(ch==='>')hasChild=true;else branches.push([]);
      }
    }
    if(!hasChild)return null;
    if(quote||square||round)throw new SyntaxError('Unbalanced selector');
    branches.at(-1).push(selector.slice(start).trim());
    const compound=value=>{
      if(!value)throw new SyntaxError('Empty child-selector compound');
      // Each child operand is one compound. Mixed descendant/child chains stay
      // explicitly unsupported rather than being broadened into descendants.
      let quote='',square=0,round=0,scopeFound=false;
      for(let i=0;i<value.length;i++){
        const ch=value[i];if(quote){if(ch===quote&&value[i-1]!=='\\')quote='';continue;}
        if(ch==='"'||ch==="'"){quote=ch;continue;}
        if(!square&&value.startsWith(':scope',i)){
          if(i!==0||round||scopeFound)throw new SyntaxError('Unsupported non-leading or nested :scope in child selector');
          scopeFound=true;
        }
        if(ch==='[')square++;if(ch===']')square--;if(ch==='(')round++;if(ch===')')round--;
        if(!square&&!round&&/\s/.test(ch))throw new SyntaxError('Unsupported mixed child/descendant selector');
      }
      const scoped=/^:scope(?=\.|#|\[|:|$)/.test(value),basic=scoped?value.slice(6)||'*':value;
      basicMatch.call(doc,basic); // Invalid syntax must still fail on empty DOM.
      return(node,scope)=>(!scoped||node===scope)&&basicMatch.call(node,basic);
    };
    return branches.map(parts=>parts.map(compound));
  }
  proto.querySelectorAll=function(selector){
    const branches=childBranches(selector);if(!branches)return queryAll.call(this,selector);
    const scope=this,result=[];
    const matches=node=>branches.some(parts=>{let cursor=node;
      for(let i=parts.length-1;i>=0;i--){if(!cursor||!parts[i](cursor,scope))return false;cursor=cursor.parentElement;}
      return true;});
    const visit=node=>{for(const child of node.children){if(matches(child))result.push(child);visit(child);}};
    visit(this);return result;
  };
  const selectorProbe=doc.createElement('div');
  selectorProbe.innerHTML='<section class="branch"><i class="leaf"></i><div class="middle"><i class="leaf"></i></div></section>';
  selectorProbe.querySelector('.leaf').setAttribute('data-probe','>');
  assert.equal(selectorProbe.querySelectorAll('.branch > .leaf').length,1,'child selection excludes nested descendants');
  assert.equal(selectorProbe.querySelectorAll('.branch > .middle > .leaf').length,1,'child chains retain exact parent edges');
  assert.deepEqual(selectorProbe.querySelectorAll('.branch > .leaf, .branch > .middle > .leaf'),
    [selectorProbe.firstElementChild.firstElementChild,selectorProbe.querySelector('.middle').firstElementChild],
    'selector lists retain document order without duplicates');
  assert.equal(selectorProbe.querySelectorAll(':scope > .branch').length,1,'scope binds the query root');
  assert.equal(selectorProbe.querySelector('.branch > .absent'),null,'valid absent child returns null');
  assert.equal(selectorProbe.querySelectorAll('[data-probe=">"]').length,1,'quoted greater-than remains an attribute value');
  assert.throws(()=>selectorProbe.querySelectorAll('.branch > > .leaf'),SyntaxError,'invalid child syntax is not suppressed');
  assert.throws(()=>selectorProbe.querySelectorAll('.branch:scope > .leaf'),SyntaxError,'non-leading scope cannot bind to each candidate');
  assert.throws(()=>selectorProbe.querySelectorAll(':not(:scope) > .leaf'),SyntaxError,'nested scope is explicitly unsupported');
  assert.throws(()=>selectorProbe.querySelectorAll(':scope:not(:scope) > .branch'),SyntaxError,'leading scope cannot conceal a nested scope');
  const prefixProbe=doc.createElement('div');
  prefixProbe.innerHTML='<button id="library-auto-move-main"><span></span></button><i id="other-library-auto-move-main"></i><i></i>';
  const prefixButton=prefixProbe.firstElementChild,prefixSelector='[id^="library-auto-move-"]';
  assert.equal(prefixButton.matches(prefixSelector),true,'ID prefix matches from the beginning');
  assert.equal(prefixButton.matches("[id^='library-auto-move-']"),true,'both CSS quote forms are supported');
  assert.equal(prefixButton.matches('[id^="Library-auto-move-"]'),false,'ID prefix matching is case sensitive');
  assert.equal(prefixProbe.querySelectorAll(prefixSelector).length,1,'missing IDs and mid-string occurrences do not match');
  assert.equal(prefixButton.firstElementChild.closest(prefixSelector),prefixButton,'actual closest compiler walks ancestors');
  assert.equal(prefixProbe.querySelector('[data-no-match], '+prefixSelector),prefixButton,'existing selector lists compose with prefix operands');
  assert.equal(prefixProbe.querySelectorAll(':not('+prefixSelector+')').length,3,'existing negation compiler retains prefix semantics');
  assert.equal(prefixProbe.querySelectorAll(':scope > '+prefixSelector).length,1,'direct-child compiler retains prefix semantics');
  assert.equal(prefixButton.matches('[id^=""]'),false,'an empty CSS prefix matches no element');
  assert.throws(()=>prefixProbe.querySelectorAll('[id^="library-auto-move-" i]'),/Unsupported fixture selector/,'unsupported prefix flags fail explicitly');
  assert.throws(()=>prefixProbe.querySelectorAll('[id^="library-auto-move-"'),SyntaxError,'invalid syntax is never suppressed');
  const dataPrefixProbe=doc.createElement('div');
  dataPrefixProbe.innerHTML='<section data-loop-action-owner="saved-loop-12"><button data-loop-action="play"><span></span></button></section><section data-loop-action-owner="other-saved-loop-12"><button data-loop-action="play"></button></section><i></i>';
  const loopOwner=dataPrefixProbe.firstElementChild,loopAction=loopOwner.firstElementChild,loopSelector='[data-loop-action-owner^="saved-loop-"]';
  assert.equal(loopOwner.matches(loopSelector),true,'data attribute prefix matches from the beginning');
  assert.equal(loopOwner.matches("[data-loop-action-owner^='saved-loop-']"),true,'data attribute prefix accepts either quote');
  assert.equal(loopOwner.matches('[data-loop-action-owner^="Saved-loop-"]'),false,'data attribute values remain case sensitive');
  assert.equal(dataPrefixProbe.querySelectorAll(loopSelector).length,1,'missing data attributes and mid-string values do not match');
  assert.equal(loopAction.firstElementChild.closest(loopSelector+' [data-loop-action]'),loopAction,'actual utility descendant selector reaches the correct action');
  assert.equal(loopAction.closest(loopSelector),loopOwner,'actual utility owner lookup walks ancestors');
  assert.equal(dataPrefixProbe.querySelector(loopSelector+' [data-loop-action]'),loopAction,'descendant queries preserve prefix ownership');
  assert.equal(dataPrefixProbe.querySelector('[data-absent], '+loopSelector),loopOwner,'data prefix composes with selector lists');
  assert.equal(loopOwner.matches(':not('+loopSelector+')'),false,'data prefix composes with negation');
  assert.equal(dataPrefixProbe.querySelector(':scope > '+loopSelector),loopOwner,'data prefix composes with direct children');
  assert.equal(loopOwner.matches('[data-loop-action-owner^=""]'),false,'empty data prefix matches no element');
  assert.throws(()=>dataPrefixProbe.querySelectorAll('[data-loop-action-owner^="saved-loop-" i]'),/Unsupported fixture selector/,'data prefix flags remain unsupported');
  assert.throws(()=>dataPrefixProbe.querySelectorAll('[title^="saved-loop-"]'),/Unsupported fixture selector/,'unrelated attribute-prefix syntax is not broadened');
  assert.throws(()=>dataPrefixProbe.querySelectorAll('[data-^="saved-loop-"]'),/Unsupported fixture selector/,'empty data names remain unsupported');
  assert.throws(()=>dataPrefixProbe.querySelectorAll('[data-loop-action-owner^="saved-loop-"'),SyntaxError,'invalid data prefix syntax is never suppressed');
  proto.blur=function(){if(doc.activeElement===this)doc.activeElement=doc.body;};
  proto.focus=function(){if(!this.isConnected||this.disabled)return;doc.activeElement=this;this.dispatchEvent(new c.Event('focusin'));};
  proto.scrollIntoView=function(){};
  proto.select=function(){this.selectionStart=0;this.selectionEnd=String(this.value||'').length;};
  // Template.content is the harness's DocumentFragment, not an attribute.
  for(const name of ['name','type'])Object.defineProperty(proto,name,{configurable:true,get(){return this.getAttribute(name)||'';},set(value){this.setAttribute(name,value);}});
  Object.defineProperty(proto,'href',{configurable:true,get(){return this.getAttribute('href')===null?'':new URL(this.getAttribute('href'),location).href;},set(value){this.setAttribute('href',value);}});
  Object.defineProperty(proto,'tabIndex',{configurable:true,get(){return this.hasAttribute('tabindex')?Number(this.getAttribute('tabindex')):(['BUTTON','INPUT','SELECT','TEXTAREA'].includes(this.tagName)?0:-1);},set(value){this.setAttribute('tabindex',value);}});
  const mutation=record=>{for(const observer of observers){if(!observer.targets.some(entry=>(entry.target===record.target||entry.options.subtree&&entry.target.contains(record.target))
    && (record.type==='attributes'?entry.options.attributes&&(!entry.options.attributeFilter||entry.options.attributeFilter.includes(record.attributeName)):entry.options.childList)))continue;
    observer.records.push(record);if(observer.scheduled)continue;observer.scheduled=true;queueMicrotask(()=>{observer.scheduled=false;const records=observer.takeRecords();if(records.length&&!observer.retired)observer.callback(records,observer);});}};
  const mutate=(target,name,oldValue)=>mutation({type:'attributes',target,attributeName:name,oldValue});
  const set=proto.setAttribute,remove=proto.removeAttribute;
  proto.setAttribute=function(name,value){const previous=this.getAttribute(name);set.call(this,name,value);mutate(this,String(name),previous);};
  proto.removeAttribute=function(name){const previous=this.getAttribute(name);remove.call(this,name);if(previous!==null)mutate(this,String(name),previous);};
  const insert=proto.insertBefore,removeChild=proto.removeChild;
  proto.insertBefore=function(node,before){const result=insert.call(this,node,before);mutation({type:'childList',target:this,addedNodes:[node],removedNodes:[]});return result;};
  proto.removeChild=function(node){const result=removeChild.call(this,node);mutation({type:'childList',target:this,addedNodes:[],removedNodes:[node]});return result;};
  const add=(tag,id,parent=doc.body)=>{const node=doc.createElement(tag);if(id)node.id=id;parent.append(node);return node;};
  const shell=add('div','app-shell');Object.assign(shell.dataset,{nativeAccountId:'7',nativeLibraryId:'9',privateUiContext:A});
  const settings=add('section');settings.setAttribute('data-settings-host','');settings.hidden=true;
  add('div',null,settings).setAttribute('data-settings-outlet','');add('nav',null,settings).setAttribute('data-settings-nav','');
  const main=add('main','shell-main-surface',shell),scroll=add('div','albums-scroll',main);Object.assign(scroll,{clientHeight:800,clientWidth:1000,scrollHeight:800,scrollTop:0});
  // The actual grid caches both spacer nodes at construction, including for an
  // empty private shell. Instantiate its served viewport, not a grid substitute.
  const viewportMarkup=read('music_app/templates/index.html').match(/<div class="albums-viewport" id="albums-viewport" data-shell-horizontal-align="gallery-body">[\s\S]*?<div id="albums-spacer-bottom"><\/div>\s*<\/div>/)?.[0];
  assert.ok(viewportMarkup,'actual served gallery viewport exists');
  const viewportHtml=viewportMarkup.replace('{{ startup_preview.mode }}','empty_shell').replace('{{ startup_preview.gallery_html|safe }}','');
  assert.doesNotMatch(viewportHtml,/{%|{{/,'only explicit empty-shell template inputs are substituted');
  scroll.className='albums-scroll';scroll.innerHTML=viewportHtml;
  const viewport=doc.getElementById('albums-viewport'),topSpacer=doc.getElementById('albums-spacer-top'),bottomSpacer=doc.getElementById('albums-spacer-bottom');
  assert.equal(topSpacer.parentElement,viewport);assert.equal(bottomSpacer.parentElement,viewport);
  assert.equal(doc.getElementById('artist-groups').parentElement,viewport);
  const sidebarNode=add('aside','sidebar-list',shell);
  const host=add('section','search-results-root',main);host.hidden=true;host.clientWidth=1000;env.setRect(host,{width:1000,height:700});
  const form=add('form','search-form',shell);let input=add('input','search-input',form);input.type='search';input.value='';input.name='q';

  const navigationTemplate=add('script','navigation-tree-item-template');navigationTemplate.textContent=read('music_app/templates/components/navigation-tree-item.html');
  const macro=read('music_app/templates/partials/search-input.html').match(/{% macro search_input\([\s\S]*?-\s*%}([\s\S]*?){%- endmacro %}/);
  assert.ok(macro,'actual SearchInput template exists');
  const indexSource=read('music_app/templates/index.html');
  const exactlyOne=(matches,label)=>{assert.equal(matches.length,1,label);return matches[0];};
  const servedForm=exactlyOne([...indexSource.matchAll(/<form\b[^>]*id="search-form"[^>]*>([\s\S]*?)<\/form>/g)],'one served global Search form')[1];
  const globalCall=exactlyOne([...servedForm.matchAll(/{% call\(action_class\) search_input\("([^"\n]+)", value=query, suggestions_id="([^"\n]+)", suggestions_label="([^"\n]+)"\) %}([\s\S]*?){% endcall %}/g)],'one supported global Search call block');
  assert.equal(globalCall[1],'search-input');assert.equal(globalCall[2],'recent-search-popover');
  assert.equal(globalCall[3],'Search suggestions');
  assert.equal([...servedForm.matchAll(/search_input\(/g)].length,1,'no duplicate or unsupported global macro call');
  const caller=globalCall[4].trim();
  assert.match(caller,/^<button class="{{ action_class }}"[^>]*id="search-advanced-toggle"[^>]*>{{ search_filter_icon\(\) }}<\/button>$/,'filter button is the entire actual caller content');
  assert.equal([...indexSource.matchAll(/id="search-advanced-toggle"/g)].length,1,'no duplicate filter snippet');
  const nativeTemplate=exactlyOne([...indexSource.matchAll(/<template id="native-search-field-template">([\s\S]*?)<\/template>/g)],'one native shared-input template')[1];
  const nativeCall=nativeTemplate.match(/^\s*{{ search_input\("([^"\n]+)", name="([^"\n]*)", placeholder="([^"\n]*)", label="([^"\n]*)", button_type="([^"\n]*)"\) }}\s*$/);
  assert.ok(nativeCall,'native shared-input is exactly one supported caller-free invocation');
  assert.equal(nativeCall[1],'native-search-template-input');assert.equal(nativeCall[5],'button');
  const partialSource=read('music_app/templates/partials/search-input.html');
  const signature=partialSource.match(/{% macro search_input\(([\s\S]*?)\) -%}/)?.[1];assert.ok(signature);
  const values={};
  for(const [,name,value]of signature.matchAll(/(\w+)=(?:'([^']*)'|none)/g))values[name]=value??null;
  assert.equal(signature.replace(/(\w+)=(?:'[^']*'|none)/g,'').replace(/\binput_id\b|[,\s]/g,''),'','only literal supported macro defaults');
  const icon=partialSource.match(/{% macro search_filter_icon\(\) -%}([\s\S]*?){%- endmacro %}/)?.[1];
  const panel=exactlyOne([...servedForm.matchAll(/<div id="search-advanced-panel"[^>]*><\/div>/g)],'one actual global help panel')[0];
  assert.ok(icon,'served filter icon exists');
  function renderSearch(bindings,callerContent=''){
    const html=macro[1].replace(/{% if suggestions_id %}([\s\S]*?){% endif %}/g,(_,body)=>bindings.suggestions_id?body:'')
      .replace(/{% if caller is defined %}([\s\S]*?){% endif %}/g,()=>callerContent.replace('{{ action_class }}','search-field-button').replace('{{ search_filter_icon() }}',icon))
      .replace(/{{\s*(\w+)\s*}}/g,(_,key)=>{assert.ok(Object.hasOwn(bindings,key),key);return bindings[key];});
    assert.doesNotMatch(html,/{%|{{/,'finite macro projection rejects unsupported syntax');return html;
  }
  const template=add('template','native-search-field-template');
  assert.equal(template.content?.nodeType,11);
  template.innerHTML=renderSearch({...values,input_id:nativeCall[1],name:nativeCall[2],placeholder:nativeCall[3],label:nativeCall[4],button_type:nativeCall[5]});
  // query is the explicit empty initial server query in this bounded fixture.
  form.innerHTML=renderSearch({...values,input_id:globalCall[1],value:'',suggestions_id:globalCall[2],suggestions_label:globalCall[3]},caller)+panel;
  input=form.querySelector('#search-input');input.value='';input.selectionStart=input.selectionEnd=0;
  // Browser-only primitive: clamp UTF-16 selection offsets, never product logic.
  proto.setSelectionRange=function(start,end){const length=String(this.value||'').length;
    this.selectionEnd=Math.max(0,Math.min(length,Number(end)||0));
    this.selectionStart=Math.min(this.selectionEnd,Math.max(0,Math.min(length,Number(start)||0)));};
  // Use the canonical server-owned modal DOM for actual app-form deferral.
  const modalSource=read('music_app/templates/partials/confirm-modals.html').replace('{% include "partials/app-form-modal.html" %}',read('music_app/templates/partials/app-form-modal.html').replace("{% from 'partials/button.html' import action_button %}",''));
  const marker='<div class="confirm-modal" id="app-confirm-modal" hidden>';assert.ok(modalSource.includes(marker));
  const modalHtml=modalSource.slice(modalSource.indexOf(marker)).replace("{{ action_button('Close dialog', id='app-form-close', icon='close', hidden=true) }}",c.ButtonComponent.renderActionButton({attributes:{id:'app-form-close'},icon:'close',ariaLabel:'Close dialog',hidden:true}));
  assert.doesNotMatch(modalHtml,/{%|{{/);doc.body.insertAdjacentHTML('beforeend',modalHtml);
  const preloaded=new Set(['js/runtime/markup-format-helpers.js','js/runtime/loader-status-helpers.js','js/runtime/alert-components.js','js/runtime/album-artbox.js',
    'js/runtime/gallery-main-components.js','js/runtime/gallery-card-component.js','js/runtime/album-details-components.js']);
  const loadFile=relative=>{assert.ok(!relative.endsWith('config.py'));vm.runInContext(read(relative),c,{filename:relative});loaded.push(relative);};
  for(const name of ['navigation-tree.js','surface-dismissal.js','settings-navigation.js'])loadFile('music_app/static/js/'+name);
  const build=read('scripts/build-runtime-bundle.cjs'),list=build.match(/const RUNTIME_SCRIPT_PATHS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(list,'actual runtime build manifest exists');
  const runtimeFiles=[...list[1].matchAll(/['"](js\/runtime\/[^'"]+\.js)['"]/g)].map(match=>match[1]);
  assert.ok(runtimeFiles.includes('js/runtime/search-results-runtime.js'),'candidate build includes native Search owner');
  let runtimeLoaded=false,booted=false;
  for(const file of runtimeFiles){if(preloaded.has(file)||file==='js/runtime/bootstrap-init.js'||holdRuntime&&file==='js/runtime/search-results-runtime.js')continue;loadFile('music_app/static/'+file);if(file==='js/runtime/search-results-runtime.js')runtimeLoaded=true;}
  const state=env.owner('state');assert.ok(state?.ui,'actual core state loaded');
  const grid=env.owner('virtualGrid');
  assert.equal(grid.topSpacerEl,topSpacer,'real grid constructor owns the served top spacer');
  assert.equal(grid.bottomSpacerEl,bottomSpacer,'real grid constructor owns the served bottom spacer');
  assert.equal(grid.containerEl,doc.getElementById('artist-groups'),'real grid owns the served content node');
  // Transparent observers delegate every invocation to the actual owner.
  const fetchOwner=c.fetchAndRender,applyOwner=c.applyViewPayload;
  c.fetchAndRender=function(...args){const promise=fetchOwner.apply(this,args);invocations.push({args,promise,outcome:outcome(promise)});return promise;};
  c.applyViewPayload=function(...args){const result=applyOwner.apply(this,args);applications.push({args,result});return result;};
  const saved=new Map();for(const [name,value]of Object.entries({window:c,document:doc,Event:c.Event,HTMLElement:c.HTMLElement,Element:c.Element,Node:c.Node,crypto:c.crypto,MutationObserver:c.MutationObserver,ResizeObserver:c.ResizeObserver})){
    saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});}
  let consumer=null;
  const mount=async(target=host)=>{const module=await import(pathToFileURL(path.join(ROOT,'music_app/static/js/search-results/native.mjs')).href);consumer=module.mountSearchResults({host:target,runtime:c.AlbumHavenSearchRuntime});return consumer;};
  const entry=()=>import(pathToFileURL(path.join(ROOT,'music_app/static/js/home-friends/index-native.mjs')).href+'?native-search-test='+ ++instance);
  const boot=()=>{assert.equal(booted,false);booted=true;loadFile('music_app/static/js/runtime/bootstrap-init.js');};
  const loadRuntime=()=>{assert.equal(runtimeLoaded,false);runtimeLoaded=true;loadFile('music_app/static/js/runtime/search-results-runtime.js');};
  // Simulate delivery of a genuinely new owner, not a runtime-shaped double.
  // A fresh script realm avoids redeclaring its top-level const; every helper,
  // native state, browser node and foreground dispatcher is the actual owner.
  const replaceRuntime=()=>{const realm=vm.createContext({...c,state,window:c});vm.runInContext(read('music_app/static/js/runtime/search-results-runtime.js'),realm,
    {filename:'music_app/static/js/runtime/search-results-runtime.js'});return c.AlbumHavenSearchRuntime;};
  const dispatch=(target,type,values={})=>{const event=new c.Event(type);Object.assign(event,values);target.dispatchEvent(event);return event;};
  const readView=(url,options={},push=false)=>outcome(c.fetchAndRender(url,push,options));
  const submit=query=>{input.value=query;c.handleGalleryBootstrapSearchInput(query);c.handleGalleryBootstrapSearchSubmit({preventDefault(){}});return invocations.at(-1)?.outcome;};
  const commit=(query,options={})=>{c.commitGallerySearchQuery(query,{recordRecentSearch:false,...options});return invocations.at(-1)?.outcome;};
  const reply=(index,payload,status)=>{assert.ok(requests[index],`actual request ${index} dispatched`);requests[index].resolve(payload,status);};
  const change=(kind,value)=>{if(kind==='actor')shell.dataset.nativeAccountId=value??'8';else if(kind==='library')shell.dataset.nativeLibraryId=value??'10';else shell.dataset.privateUiContext=value??B;c.AlbumHavenPrivateUITransport.generation();};
  const flushFrames=()=>{const work=[...frames];frames.clear();for(const [,callback]of work)callback(0);};
  const resize=width=>{host.clientWidth=width;env.setRect(host,{width,height:700});for(const observer of resizers)if(!observer.retired){for(const node of observer.nodes){node.clientWidth=width;env.setRect(node,{width,height:700});}observer.callback([...observer.nodes].map(target=>({target,contentRect:{width}})));}flushFrames();};
  const button=(pattern,root=host)=>{const found=[...root.querySelectorAll('button')].find(node=>pattern.test(node.getAttribute('aria-label')||node.textContent.trim())&&!node.closest('[hidden],[inert]'));assert.ok(found,`visible native button ${pattern}`);return found;};
  t.after(async()=>{consumer?.dispose();for(const request of requests)if(!request.settled)request.reject(Object.assign(new Error('fixture teardown'),{name:'AbortError'}));await drain();for(const [name,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  return {...env,c,state,host,shell,main,input,form,sidebar:sidebarNode,scroll,requests,invocations,applications,loaded,history,historyCalls,storageCalls,redirects,entries,location,
    timers,frames,observers,resizers,read:readView,submit,commit,reply,change,dispatch,button,resize,flushFrames,mount,entry,boot,loadRuntime,replaceRuntime,
    runtime:()=>c.AlbumHavenSearchRuntime,flush:drain};
}
async function admit(h,payload=ready(),{push=false}={}){const index=h.requests.length,work=h.read(mainUrl(payload),{},push);assert.equal(h.requests.length,index+1);h.reply(index,payload);
  const result=await work;assert.equal(result.error,undefined,result.error?.stack);assert.equal(result.value,true,'actual foreground admission completed');
  const snapshot=h.runtime().snapshot();assert.equal(snapshot.status,payload.status==='pending'||payload.selection_state==='pending_page'?'pending':'ready');return snapshot;}
function source(h,snapshot=h.runtime().snapshot()) {const rows=snapshot.result.tracks;const lease=h.runtime().createPlaytableSource({rows,context:{scopeKey:snapshot.scopeKey,resultId:snapshot.resultId},instance:snapshot.sourceIdentity,revision:snapshot.sourceIdentity,isCurrent:()=>true});assert.ok(lease);return lease;}
function foreground(h){return {id:h.state.ui.activeViewRequestId,url:h.state.ui.activeViewRequestUrl,controller:h.state.ui.activeViewRequestController,view:h.state.view,busy:h.state.busy};}
module.exports={ROOT,read,plain,outcome,deferred,drain,A,B,ARTIST,album,artist,sidebar,track,criteria,ready,pending,firstWitness,child,ordinary,mainUrl,fixture,admit,source,foreground};
