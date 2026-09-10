const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  const source = path.join(__dirname, '../../../music_app/static/js/selection-accent.js');
  assert.ok(fs.existsSync(source), 'Selection accent controller must exist');
  const window = {NavigationTree:{renderItem(){return '';}}};
  vm.runInNewContext(fs.readFileSync(source,'utf8'), {window,console,document:{activeElement:null}});
  const responses=[], requests=[], applied=[];
  const controller = window.AlbumHavenSelectionAccent.create({
    async fetch(url,options={}) {
      requests.push({url,options});
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return {ok: response.status < 400, status: response.status, async json(){return response.body;}};
    },
    apply(value){applied.push(plain(value));},
    getCsrfToken(){return 'session-csrf';}
  });
  return {api:window.AlbumHavenSelectionAccent,controller,requests,applied, respond(value,status=200){responses.push({status,body:{selection_accent:value}});}};
}

test('unconfigured account keeps mixed baseline until first explicit save', async () => {
  const app = harness();
  app.respond(null);
  await app.controller.load();
  assert.equal(app.controller.getState().saved,null);
  assert.deepEqual(plain(app.controller.getState().draft), {enabled:true,color:'#34ca78'});
  assert.deepEqual(app.applied,[null]);
  app.controller.setDraft({enabled:true,color:'#7f00ff'});
  assert.deepEqual(app.applied,[null]);
  app.controller.cancel();
  assert.deepEqual(plain(app.controller.getState().draft),{enabled:true,color:'#34ca78'});
  assert.equal(app.controller.getState().saved,null);
});

test('save sends session CSRF and applies returned preference, reload restores it', async () => {
  const app = harness();
  const preference={enabled:true,color:'#7f00ff'};
  app.respond(null);
  await app.controller.load();
  app.controller.setDraft(preference);
  app.respond(preference);
  await app.controller.save();
  const request=app.requests.at(-1);
  assert.equal(request.url,'/api/account/appearance/selection-accent');
  assert.equal(request.options.method,'PUT');
  assert.deepEqual(JSON.parse(request.options.body),preference);
  const headers = Object.fromEntries(Object.entries(request.options.headers).map(([key,value])=>[key.toLowerCase(),value]));
  assert.equal(headers['x-album-haven-csrf'],'session-csrf');
  assert.deepEqual(app.applied.at(-1),preference);
  app.respond(preference);
  await app.controller.load();
  assert.deepEqual(plain(app.controller.getState().saved),preference);
});

test('failed save keeps draft retryable and cancel restores saved values', async () => {
  const app = harness();
  const saved={enabled:true,color:'#34ca78'};
  const draft={enabled:false,color:'#abcdef'};
  app.respond(saved);
  await app.controller.load();
  app.controller.setDraft(draft);
  app.respond(null,503);
  await app.controller.save();
  assert.deepEqual(plain(app.controller.getState().draft),draft);
  assert.deepEqual(plain(app.controller.getState().saved),saved);
  assert.ok(app.controller.getState().error);
  assert.equal(app.controller.getState().saving,false);
  assert.deepEqual(app.applied,[saved]);
  app.controller.cancel();
  assert.deepEqual(plain(app.controller.getState().draft),saved);
  app.controller.setDraft(draft);
  app.respond(draft);
  await app.controller.save();
  assert.deepEqual(plain(app.controller.getState().saved),draft);
  assert.deepEqual(app.applied.at(-1),draft);
});


test('load failure keeps the preference unloaded and offers an explicit retry', async () => {
  const app = harness();
  app.respond(null,503);
  await app.controller.load();
  assert.equal(app.controller.getState().loaded,false);
  assert.equal(app.controller.getState().loading,false);
  assert.ok(app.controller.getState().error);
  assert.deepEqual(app.applied,[]);
  app.respond({enabled:false,color:'#112233'});
  await app.controller.load();
  assert.equal(app.controller.getState().loaded,true);
  assert.deepEqual(app.applied,[{enabled:false,color:'#112233'}]);
});


test('malformed draft keeps the saved draft and cannot silently save its earlier value', async () => {
  const app = harness();
  const saved={enabled:true,color:'#34ca78'};
  app.respond(saved);
  await app.controller.load();
  for (const patch of [{enabled:'false'}, {enabled:1}, {color:'#fff'}, {color:'red'}, {color:'#abcdef00'}]) {
    app.controller.cancel();
    app.controller.setDraft(patch);
    assert.ok(app.controller.getState().error);
    assert.deepEqual(plain(app.controller.getState().draft),saved);
    const requestsBefore=app.requests.length;
    await app.controller.save();
    assert.equal(app.requests.length,requestsBefore);
  }
  assert.deepEqual(app.applied,[saved]);
});

test('malformed persisted response is not applied or treated as loaded', async () => {
  for (const preference of [{enabled:'false',color:'#34ca78'}, {enabled:true,color:'red'}]) {
    const app = harness();
    app.respond(preference);
    await app.controller.load();
    assert.equal(app.controller.getState().loaded,false);
    assert.ok(app.controller.getState().error);
    assert.deepEqual(app.applied,[]);
  }
});




test('editor disables both color inputs when off and preserves the aggregate draft on unmount', async () => {
  const app = harness();
  const saved={enabled:true,color:'#34ca78'};
  app.respond(saved);
  await app.controller.load();
  function editorFixture() {
    const nodes = new Map(), listeners = new Map();
    const node = selector => {
      if (!nodes.has(selector)) nodes.set(selector,{
        value:'', disabled:false, checked:false, textContent:'',
        classList:{toggle(){}}, setAttribute(){},
      });
      return nodes.get(selector);
    };
    const editor = {
      querySelector:node, querySelectorAll(){return [];},
      addEventListener(name,handler){listeners.set(name,handler);},
      removeEventListener(name){listeners.delete(name);},
    };
    return {container:{innerHTML:'',contains(candidate){return candidate === editor;},querySelector(){return editor;}},node,listeners};
  }
  const first=editorFixture();
  const dispose=app.api.mount(first.container,app.controller);
  app.controller.setDraft({enabled:false,color:'#abcdef'});
  app.api.mount(first.container,app.controller);
  assert.deepEqual(plain(app.controller.getState().draft),{enabled:false,color:'#abcdef'});
  assert.equal(first.node('[data-selection-accent-color]').disabled,true);
  assert.equal(first.node('[data-selection-accent-hex]').disabled,true);
  assert.equal(first.node('[data-selection-accent-enabled]').disabled,false);
  dispose();
  assert.equal(first.listeners.size,0);
  assert.deepEqual(plain(app.controller.getState().draft),{enabled:false,color:'#abcdef'});
  const oldValue=first.node('[data-selection-accent-color]').value;
  app.controller.setDraft({color:'#112233'});
  assert.equal(first.node('[data-selection-accent-color]').value,oldValue);
  app.controller.cancel();
  const second=editorFixture();
  const disposeSecond=app.api.mount(second.container,app.controller);
  assert.equal(second.node('[data-selection-accent-color]').value,saved.color);
  assert.equal(second.node('[data-selection-accent-color]').disabled,false);
  assert.equal(second.node('[data-selection-accent-hex]').disabled,false);
  disposeSecond();
  assert.equal(second.listeners.size,0);
});

test('Appearance uses the aggregate controller for Selection accent instead of a section-level Save', () => {
  const appearance = require('../../../music_app/static/js/appearance-backgrounds.js');
  assert.ok(appearance.selectionAccentColors.includes('#34CA78'), 'the original green accent remains a curated option');
  const initial = {
    main_surface_color:null,panel_background_color:null,palette_id:null,panel_index:0,
    player_override:null,compact_player_style:'docked',revision:2,interaction_overrides:{
      item_hover:null,item_selected:null,button_hover_background:null,button_pressed:null,
      item_outline:{source:'automatic',color:null},
    },
    selection_accent:{enabled:true,color:'#6E9BD0'},player_style_override:null,player_recent_sets:[],
  };
  const controller = appearance.createController({initial,request:async()=>initial});
  assert.equal(typeof controller.setSelectionAccent,'function','Selection accent must be part of the aggregate Appearance draft');
  controller.setSelectionAccent({enabled:true,color:'#526B8B'});
  assert.deepEqual(plain(controller.getState().draft.selection_accent),{enabled:true,color:'#526B8B'});
  assert.equal(controller.getState().dirty,true);
});

test('aggregate Appearance bootstrap suppresses the legacy selection-accent request', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../../music_app/static/js/selection-accent.js'),
    'utf8',
  );
  assert.match(
    source,
    /!document\.getElementById\('appearance-bootstrap'\)/,
    'the compatibility controller must not issue a second request when aggregate Appearance owns the page',
  );
});
