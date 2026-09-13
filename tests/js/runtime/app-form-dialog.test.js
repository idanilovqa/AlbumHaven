const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function setup() {
  const nodes = new Map();
  for (const id of ['app-form-modal', 'app-form-title', 'app-form-content', 'app-form-error', 'app-form-cancel', 'app-form-submit']) nodes.set(id, { hidden: true, disabled: false, style: {}, listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name) { this.listeners.delete(name); }, focus() {}, querySelectorAll() { return []; } });
  const focus = [];
  const document = { getElementById: id => nodes.get(id), activeElement: { focus: options => focus.push(options) } };
  const context = vm.createContext({ document, window: {}, Promise });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/browser-dialog-helpers.js'), 'utf8'), context);
  const fire = (id, name) => nodes.get(id).listeners.get(name)?.({ preventDefault() {}, stopPropagation() {} });
  return { context, nodes, focus, fire };
}

test('shared form keeps unavailable submission disabled through navigation and ignores closed-owner controls', async () => {
  const h = setup(); let controls, calls = 0;
  const pending = h.context.showAppFormDialog({ submitEnabled: false,
    onMount(_content, value) { controls = value; }, onSubmit() { calls++; return 'chosen'; } });
  assert.equal(h.nodes.get('app-form-submit').disabled, true);
  await h.fire('app-form-submit', 'click'); assert.equal(calls, 0);
  controls.setSubmitEnabled(true);
  assert.equal(h.nodes.get('app-form-submit').disabled, false);
  await h.fire('app-form-submit', 'click'); assert.equal(await pending, 'chosen');
  const next = h.context.showAppFormDialog({ submitEnabled: false });
  controls.setSubmitEnabled(true);
  assert.equal(h.nodes.get('app-form-submit').disabled, true);
  h.fire('app-form-cancel', 'click'); await next;
});

test('late form submission cannot enable a replacement dialog', async () => {
  const h = setup(); let finish;
  const pending = h.context.showAppFormDialog({ onSubmit: () => new Promise(resolve => { finish = resolve; }) });
  const applying = h.fire('app-form-submit', 'click');
  h.fire('app-form-cancel', 'click'); await pending;
  const replacement = h.context.showAppFormDialog({ submitEnabled: false });
  finish('late'); await applying;
  assert.equal(h.nodes.get('app-form-submit').disabled, true);
  h.fire('app-form-cancel', 'click'); await replacement;
});
test('shared form cancel restores focus without applying the draft', async () => {
  const h = setup(); let submitted = 0;
  assert.equal(typeof h.context.showAppFormDialog, 'function');
  const pending = h.context.showAppFormDialog({ title: 'Export', contentHtml: '<input>', onSubmit: async () => { submitted++; } });
  h.fire('app-form-cancel', 'click'); assert.equal(await pending, null);
  assert.equal(submitted, 0); assert.equal(h.nodes.get('app-form-modal').hidden, true);
  assert.equal(h.focus[0].preventScroll, true);
});
test('shared form validation failure retains draft and permits a corrected submission', async () => {
  const h = setup(); let calls = 0;
  assert.equal(typeof h.context.showAppFormDialog, 'function');
  const pending = h.context.showAppFormDialog({ title: 'Export', contentHtml: '<input>', onSubmit: async () => { if (++calls === 1) throw new Error('Invalid date'); return 'saved'; } });
  await h.fire('app-form-submit', 'click');
  assert.equal(h.nodes.get('app-form-modal').hidden, false); assert.match(h.nodes.get('app-form-error').textContent, /Invalid/);
  await h.fire('app-form-submit', 'click'); assert.equal(await pending, 'saved'); assert.equal(calls, 2);
});

test('anchored form fits the containing Settings panel and available height with a stationary footer', async () => {
  const h=setup();
  const panel={style:{},setAttribute(){},removeAttribute(){}};
  const modal=h.nodes.get('app-form-modal');
  modal.querySelector=()=>panel;modal.classList={add(){},remove(){}};
  h.context.window.innerWidth=1920;h.context.window.innerHeight=927;
  h.context.syncTriggerAnchor=()=>{};h.context.clearTriggerAnchor=()=>{};
  const anchor={getBoundingClientRect:()=>({left:649,right:717,bottom:128}),closest:()=>({getBoundingClientRect:()=>({left:410,right:1510,bottom:825})})};
  const pending=h.context.showAppFormDialog({anchor});
  assert.ok(parseFloat(panel.style.left)>=418,'the popup must not extend under the Settings clipping boundary');
  assert.ok(parseFloat(panel.style.top)+parseFloat(panel.style.maxHeight)<=817,'footer must fit above the Settings bottom');
  const css=fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/css/runtime/non-album-and-player.css'),'utf8');
  assert.match(css,/#app-form-content\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css,/#app-form-modal \.confirm-modal-dialog\s*\{[^}]*display:\s*flex[^}]*overflow:\s*visible/s);
  h.fire('app-form-cancel','click');await pending;
});

test('query controls shrink to the form body without a horizontal scrollbar', () => {
  const css=fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/css/runtime/non-album-and-player.css'),'utf8');
  assert.match(css,/\.utility-log-query-form\s*\{[^}]*width:\s*100%/s);
  assert.match(css,/\.utility-log-query-form input[^}]*box-sizing:\s*border-box/s);
  assert.match(css,/\.utility-log-query-form h4[^}]*margin:\s*0/s);
});


test('reading form has one Close action and restores normal form controls afterward', async () => {
 const h=setup();const modes=new Set();h.nodes.get('app-form-modal').classList={add:value=>modes.add(value),remove:value=>modes.delete(value)};
 const pending=h.context.showAppFormDialog({mode:'reading',title:'Guide',contentHtml:'<article>Instructions</article>'});
 assert.equal(h.nodes.get('app-form-submit').hidden,true);assert.equal(h.nodes.get('app-form-cancel').textContent,'Close');
 assert.ok(modes.has('app-form-reading'));h.fire('app-form-cancel','click');await pending;
 assert.ok(!modes.has('app-form-reading'));
 const ordinary=h.context.showAppFormDialog({title:'Normal'});assert.equal(h.nodes.get('app-form-submit').hidden,false);
 assert.equal(h.nodes.get('app-form-cancel').textContent,'Cancel');h.fire('app-form-cancel','click');await ordinary;
});


test('active anchored form repositions on viewport and Settings resize and releases its observers',async()=>{
 const h=setup();const events=new Map();let observer;
 Object.assign(h.context.window,{innerWidth:1920,innerHeight:927,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)});
 h.context.ResizeObserver=class {constructor(callback){this.callback=callback;this.observed=[];observer=this;}observe(node){this.observed.push(node);}disconnect(){this.disconnected=true;}};
 const panel={style:{},setAttribute(){},removeAttribute(name){if(name==='style')this.style={};}};
 const modal=h.nodes.get('app-form-modal');modal.querySelector=()=>panel;modal.classList={add(){},remove(){}};
 let bounds={left:410,right:1510,bottom:825};let trigger={left:649,right:717,bottom:128};
 const boundary={getBoundingClientRect:()=>bounds};const anchor={getBoundingClientRect:()=>trigger,closest:()=>boundary};
 h.context.syncTriggerAnchor=()=>{};h.context.clearTriggerAnchor=()=>{};
 const pending=h.context.showAppFormDialog({anchor});assert.equal(parseFloat(panel.style.left),418);
 h.context.window.innerWidth=390;h.context.window.innerHeight=640;bounds={left:8,right:382,bottom:632};trigger={left:298,right:366,bottom:112};
 events.get('resize')?.();
 assert.ok(parseFloat(panel.style.left)+parseFloat(panel.style.width)<=374,'open form follows the narrowed viewport');
 assert.ok(observer?.observed.includes(boundary),'Settings resize is observed even without a viewport resize');
 bounds={left:40,right:340,bottom:500};observer.callback();
 assert.ok(parseFloat(panel.style.left)>=48);assert.ok(parseFloat(panel.style.left)+parseFloat(panel.style.width)<=332);
 assert.ok(parseFloat(panel.style.top)+parseFloat(panel.style.maxHeight)<=492);
 const late=observer.callback;h.fire('app-form-cancel','click');await pending;
 assert.equal(events.size,0);assert.equal(observer.disconnected,true);
 late();assert.deepEqual(panel.style,{},'queued observer callback cannot revive a closed form');
});
