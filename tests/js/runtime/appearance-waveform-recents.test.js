const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../../../music_app/static/js/appearance-backgrounds.js');
const defaults = () => ({main_surface_color:null,panel_background_color:null,palette_id:null,panel_index:0,player_override:null,compact_player_style:'docked'});
const custom = () => ({...defaults(),palette_id:'steelblue',player_override:{background:'#14283B',fill:'#8BAED1',edge:'#B9CADD'}});
function setup(options={}) {
  const requests=[],applied=[];
  const controller=api.createController({initial:custom(),request:async(method,payload)=>{
    requests.push({method,payload});
    if(method==='GET') return {...custom(),waveform_recent_colors:['#112233','#445566']};
    const {waveform_color_updates,...preference}=payload;
    return {...preference,waveform_recent_colors:waveform_color_updates||[]};
  },apply:value=>applied.push(value),...options});
  return {controller,requests,applied};
}

test('loaded recent colors are account response metadata, not writable appearance fields',async()=>{
  const {controller,requests}=setup();
  await controller.load();
  assert.deepEqual(controller.getState().recentColors,['#112233','#445566']);
  assert.deepEqual(controller.getState().saved,custom());
  controller.setPlayerColor('background','#123456');
  assert.equal(await controller.save(),true);
  assert.equal(Object.hasOwn(requests[1].payload,'waveform_recent_colors'),false);
  assert.equal(Object.hasOwn(requests[1].payload,'waveform_color_updates'),false);
});

test('explicit waveform selections track five newest distinct colors and apply only after Save',async()=>{
  const {controller,requests,applied}=setup();
  await controller.load(); applied.length=0;
  for(const color of ['#111111','#222222','#333333','#444444','#555555','#666666','#333333']) controller.setPlayerColor('fill',color);
  const updates=['#333333','#666666','#555555','#444444','#222222'];
  assert.deepEqual(controller.getState().waveformColorUpdates,updates);
  assert.deepEqual(controller.getState().recentColors,['#112233','#445566']);
  assert.deepEqual(applied,[]);
  assert.equal(await controller.save(),true);
  assert.deepEqual(requests[1].payload.waveform_color_updates,updates);
  assert.deepEqual(controller.getState().recentColors,updates);
  assert.deepEqual(controller.getState().waveformColorUpdates,[]);
  assert.equal(Object.hasOwn(controller.getState().saved,'waveform_color_updates'),false);
  assert.equal(applied[0].player_override.fill,'#333333');
});

test('Cancel discards pending colors and invalid errors while preserving saved recents',async()=>{
  const {controller,requests}=setup(); await controller.load();
  controller.setPlayerColor('fill','#abcdef');
  controller.setPlayerColor('edge','invalid');
  assert.equal(controller.getState().canSave,false);
  assert.deepEqual(controller.getState().waveformColorUpdates,['#ABCDEF']);
  controller.cancel();
  assert.deepEqual(controller.getState().draft,custom());
  assert.deepEqual(controller.getState().recentColors,['#112233','#445566']);
  assert.deepEqual(controller.getState().waveformColorUpdates,[]);
  assert.deepEqual(controller.getState().errors,{});
  assert.equal(requests.length,1);
});

test('failed save keeps selections for retry and trusts server history on successful retry',async()=>{
  let fail=true; const applied=[];
  const {controller}=setup({initial:{...custom(),waveform_recent_colors:['#123456']},apply:value=>applied.push(value),request:async(_method,payload)=>{
    if(fail) throw Error('Unavailable');
    const {waveform_color_updates,...preference}=payload;
    return {...preference,waveform_recent_colors:['#112233','#123456']};
  }});
  controller.setPlayerColor('edge','#112233');
  assert.equal(await controller.save(),false);
  assert.deepEqual(controller.getState().waveformColorUpdates,['#112233']);
  assert.deepEqual(controller.getState().recentColors,['#123456']);
  assert.deepEqual(applied,[]);
  fail=false;
  assert.equal(await controller.save(),true);
  assert.deepEqual(controller.getState().recentColors,['#112233','#123456']);
  assert.deepEqual(controller.getState().waveformColorUpdates,[]);
});

test('old pair-only and five-field responses remain compatible without writable history metadata',async()=>{
  for(const initial of [{main_surface_color:null,panel_background_color:null},defaults()]) {
    const {controller,requests}=setup({initial});
    assert.deepEqual(controller.getState().recentColors,[]);
    controller.setColor('main_surface_color','#112233');
    assert.equal(await controller.save(),true);
    assert.deepEqual(requests[0].payload,{...initial,main_surface_color:'#112233'});
  }
});

test('session clear drops recent and pending colors and prevents a late response restoring them',async()=>{
  let resolve; const pending=new Promise(done=>resolve=done);
  const {controller}=setup({initial:{...custom(),waveform_recent_colors:['#123456']},request:()=>pending});
  controller.setPlayerColor('fill','#112233'); const saving=controller.save();
  controller.clear(); resolve({...custom(),waveform_recent_colors:['#112233','#123456']});
  assert.equal(await saving,false);
  assert.deepEqual(controller.getState().recentColors,[]);
  assert.deepEqual(controller.getState().waveformColorUpdates,[]);
  assert.equal(controller.getState().loadFailed,true);
});

test('explicit recovery restores the exact supplied browser colors to the draft and keeps player background',async()=>{
  const {controller,requests,applied}=setup();
  assert.equal(typeof controller.restoreWaveformColors,'function','Recovery must be an explicit supported action');
  const previous={fill:'#387f68',edge:'#afd8c2'};
  assert.deepEqual(controller.getState().draft,custom());
  controller.restoreWaveformColors(previous);
  assert.deepEqual(controller.getState().draft.player_override,{background:'#14283B',fill:'#387F68',edge:'#AFD8C2'});
  assert.deepEqual(controller.getState().waveformColorUpdates,['#AFD8C2','#387F68']);
  assert.deepEqual(applied,[]); assert.deepEqual(requests,[]);
  assert.equal(await controller.save(),true);
  assert.equal(applied[0].player_override.fill,'#387F68');
  assert.equal(applied[0].player_override.edge,'#AFD8C2');
});

test('recovery rejects incomplete or invalid pairs atomically without changing pending selections',()=>{
  const {controller}=setup();
  assert.equal(typeof controller.restoreWaveformColors,'function','Recovery must be validated before changing either field');
  controller.setPlayerColor('fill','#112233');
  const before=controller.getState();
  for(const invalid of [{fill:'#123456'}, {fill:'#123456',edge:'bad'}, {fill:'#123456',edge:'#234567',extra:'invalid'}]) assert.throws(()=>controller.restoreWaveformColors(invalid),TypeError);
  assert.deepEqual(controller.getState().draft,before.draft);
  assert.deepEqual(controller.getState().waveformColorUpdates,before.waveformColorUpdates);
});

for(const [from,to] of [['backgrounds','seekbar'],['seekbar','backgrounds']]) test(`${from} to ${to} keeps one unsaved appearance draft without prompting`,async()=>{
  const {controller}=setup(); controller.setPlayerColor('background','#112233'); controller.setPlayerColor('fill','#345678');
  const before=controller.getState().draft; let guards=0,renders=0;
  const context=vm.createContext({state:{utility:{appearanceKey:from},coverLookup:{}},document:{querySelectorAll:()=>[]},console,
    confirmBackgroundAppearanceLeave:()=>{guards++;return false;},renderUtilityModalContent:()=>{renders++;}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/bootstrap-utility-event-handlers.js'),'utf8'),context);
  const button={getAttribute:()=>to};
  await context.handleUtilityBootstrapClick({target:{closest:selector=>selector==='[data-utility-appearance-key]'?button:null},preventDefault(){}});
  assert.equal(context.state.utility.appearanceKey,to);
  assert.equal(guards,0);
  assert.equal(renders,1);
  assert.deepEqual(controller.getState().draft,before);
});

test('leaving shared Backgrounds and Seekbar edits for another section still honors discard guard',async()=>{
  let guards=0;
  const context=vm.createContext({state:{utility:{appearanceKey:'seekbar'},coverLookup:{}},document:{querySelectorAll:()=>[]},console,
    confirmBackgroundAppearanceLeave:()=>{guards++;return false;},renderUtilityModalContent(){throw Error('Must not navigate');}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/bootstrap-utility-event-handlers.js'),'utf8'),context);
  await context.handleUtilityBootstrapClick({target:{closest:selector=>selector==='[data-utility-appearance-key]'?{getAttribute:()=> 'selection-accent'}:null},preventDefault(){}});
  assert.equal(context.state.utility.appearanceKey,'seekbar'); assert.equal(guards,1);
});

test('picker drag previews do not crowd out the five deliberate recent selections',()=>{
  const {controller}=setup();
  controller.setPlayerColor('fill','#123456');
  for(const color of ['#234567','#345678','#456789','#567890','#678901']) controller.setPlayerColor('fill',color,{recordRecent:false});
  assert.equal(controller.getState().draft.player_override.fill,'#678901');
  assert.deepEqual(controller.getState().waveformColorUpdates,['#123456']);
  controller.setPlayerColor('fill','#678901');
  assert.deepEqual(controller.getState().waveformColorUpdates,['#678901','#123456']);
});

test('selecting the current color can save recency without changing the preference value',async()=>{
  const {controller,requests}=setup();
  controller.setPlayerColor('fill',custom().player_override.fill);
  assert.deepEqual(controller.getState().draft,custom());
  assert.equal(controller.getState().canSave,true);
  assert.equal(await controller.save(),true);
  assert.deepEqual(requests[0].payload.waveform_color_updates,[custom().player_override.fill]);
});

test('browser recovery uses the exact previously persisted pair only on explicit invocation',()=>{
  const valid=JSON.stringify({seekbarMode:'waveform',waveformFillColor:'#387f68',waveformEdgeColor:'#afd8c2'});
  let raw=valid,reads=0;
  const context=vm.createContext({window:{addEventListener(){}},PLAYER_APPEARANCE_STORAGE_KEY:'known-player-key',
    getLocalStorageItem:key=>{assert.equal(key,'known-player-key');reads++;return raw;},
    state:{player:{appearance:{waveformFillColor:'#FFFFFF',waveformEdgeColor:'#000000'}}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/appearance-backgrounds-bridge.js'),'utf8'),context);
  assert.equal(reads,0,'Module load must not read or import historical browser colors');
  assert.equal(typeof context.getPreviousBrowserWaveformColors,'function','Bridge must distinguish stored colors from synthesized defaults');
  assert.deepEqual(JSON.parse(JSON.stringify(context.getPreviousBrowserWaveformColors())),{fill:'#387F68',edge:'#AFD8C2'});
  assert.equal(reads,1);
  assert.equal(raw,valid,'Recovery must not overwrite its historical source');
  for(const invalid of [null,'not-json','{}',JSON.stringify({waveformFillColor:'#123456'}),JSON.stringify({waveformFillColor:'#123456',waveformEdgeColor:'invalid'})]){
    raw=invalid;
    assert.equal(context.getPreviousBrowserWaveformColors(),null);
  }
});

test('actual Seekbar renderer supplies its color editor host to the shared instance with lazy recovery',()=>{
  const {controller}=setup(); controller.setPlayerColor('background','#112233');
  const host={id:'waveform-editor-host'},mounts=[];
  let storageReads=0,unmounts=0;
  const detail={innerHTML:'',querySelector(selector){return selector==='[data-appearance-seekbar-editor]' && this.innerHTML.includes('data-appearance-seekbar-editor') ? host:null;}};
  const elements={overlay:{},list:{},count:{},detail};
  const instance={controller,unmount(){unmounts++;},mountSeekbar(target,options){mounts.push({target,options});}};
  const context=vm.createContext({state:{utility:{appearanceKey:'seekbar'},player:{appearance:{seekbarMode:'waveform'}}},
    window:{AlbumHavenAppearance:{instance},addEventListener(){}},getUtilityModalElements:()=>elements,
    escapeHtml:value=>String(value),PLAYER_APPEARANCE_STORAGE_KEY:'known-player-key',getLocalStorageItem(){storageReads++;return null;}});
  for(const name of ['utility-list-builders.js','utility-renderers-and-actions.js','appearance-backgrounds-bridge.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime',name),'utf8'),context);
  context.renderUtilityAppearance();
  assert.equal(mounts.length,1,'The live Seekbar route must mount the shared editor');
  assert.equal(mounts[0].target,host);
  assert.equal(typeof mounts[0].options.getLegacyColors,'function');
  assert.equal(storageReads,0,'Rendering must not inspect previous browser colors');
  assert.equal(unmounts,1);
  assert.equal(controller.getState().draft.player_override.background,'#112233');
  assert.match(detail.innerHTML,/data-appearance-seekbar-mode="waveform"/);
});
