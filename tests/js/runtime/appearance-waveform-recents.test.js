const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../../../music_app/static/js/appearance-backgrounds.js');
const defaults = () => ({main_surface_color:null,panel_background_color:null,palette_id:null,panel_index:0,player_override:null,compact_player_style:'docked',album_details_layout:'classic_bar',album_playing_row_animation:'enabled',alert_family:'ember'});
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

test('Album page choices stay in the shared draft and apply only after Save',async()=>{
  const {controller,requests,applied}=setup();
  assert.equal(typeof controller.setAlbumDetailsLayout,'function');
  assert.equal(typeof controller.setAlbumPlayingRowAnimation,'function');
  controller.setAlbumDetailsLayout('stacked_bar');
  controller.setAlbumPlayingRowAnimation('disabled');
  assert.equal(controller.getState().draft.album_details_layout,'stacked_bar');
  assert.equal(controller.getState().draft.album_playing_row_animation,'disabled');
  assert.deepEqual(applied,[]);
  assert.equal(await controller.save(),true);
  assert.equal(requests[0].payload.album_details_layout,'stacked_bar');
  assert.equal(requests[0].payload.album_playing_row_animation,'disabled');
  assert.equal(applied[0].album_details_layout,'stacked_bar');
});

test('Album page choices validate their closed values and apply document attributes',()=>{
  const {controller}=setup();
  assert.throws(()=>controller.setAlbumDetailsLayout('poster'));
  assert.throws(()=>controller.setAlbumPlayingRowAnimation('sometimes'));
  const attrs={};
  const root={style:{setProperty(){},removeProperty(){}},setAttribute(name,value){attrs[name]=value;},removeAttribute(name){delete attrs[name];}};
  api.applyTheme({...custom(),album_details_layout:'editorial_canvas',album_playing_row_animation:'disabled'},root);
  assert.equal(attrs['data-album-details-layout'],'editorial_canvas');
  assert.equal(attrs['data-album-playing-row-animation'],'disabled');
});

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

for(const [from,to] of [
  ['backgrounds','seekbar'],['seekbar','backgrounds'],
  ['backgrounds','selection-accent'],['selection-accent','backgrounds'],
  ['seekbar','selection-accent'],['selection-accent','seekbar'],
]) test(`${from} to ${to} keeps one unsaved Appearance draft without prompting`,async()=>{
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
  assert.equal(typeof mounts[0].options.getSeekbarMode,'function');
  assert.equal(mounts[0].options.getSeekbarMode(),'waveform');
  assert.equal(storageReads,0,'Rendering must not inspect previous browser colors');
  assert.equal(unmounts,1);
  assert.equal(controller.getState().draft.player_override.background,'#112233');
  assert.doesNotMatch(detail.innerHTML,/data-appearance-seekbar-mode/,'The shared editor owns the mode selector');
});

const classicGreenSet = () => ({
  surface:{mode:'gradient',angle:0,start:'#0A2F24',end:'#0A1422'},
  controls:{fill:'#24B86B',border:'#86EFAC'},
  waveform:{fill:'#387F68',edge:'#AFD8C2'},
  handles:{color:'#AFD8C2'},
});
const completeSet = color => ({
  surface:{mode:'solid',angle:0,start:color,end:color},
  controls:{fill:color,border:color},waveform:{fill:color,edge:color},handles:{color},
});
const aggregateInitial = overrides => ({...defaults(),revision:3,interaction_overrides:{
  item_hover:null,item_selected:null,button_hover_background:null,button_pressed:null,
  item_outline:{source:'automatic',color:null},
},
  selection_accent:{enabled:true,color:'#6E9BD0'},player_style_override:classicGreenSet(),
  player_recent_sets:[classicGreenSet()],...overrides});

test('Classic green defines reversible control and waveform shade pairs',()=>{
  assert.deepEqual(api.derivePairedPlayerColor('controls.fill','#24B86B'),{role:'waveform.fill',color:'#387F68'});
  assert.deepEqual(api.derivePairedPlayerColor('waveform.fill','#387F68'),{role:'controls.fill',color:'#24B86B'});
  assert.deepEqual(api.derivePairedPlayerColor('controls.border','#86EFAC'),{role:'waveform.edge',color:'#AFD8C2'});
  assert.deepEqual(api.derivePairedPlayerColor('waveform.edge','#AFD8C2'),{role:'controls.border',color:'#86EFAC'});
});

test('direct control edits pair waveform shades and preserve an independently edited handle',()=>{
  const controller=api.createController({initial:aggregateInitial({player_style_override:completeSet('#234567')}),request:async()=>{}});
  api.setPlayerStylePath(controller,'controls.fill','#24B86B');
  assert.equal(controller.getState().draft.player_style_override.controls.fill,'#24B86B');
  assert.equal(controller.getState().draft.player_style_override.waveform.fill,'#387F68');

  api.setPlayerStylePath(controller,'controls.border','#86EFAC');
  assert.equal(controller.getState().draft.player_style_override.controls.border,'#86EFAC');
  assert.equal(controller.getState().draft.player_style_override.waveform.edge,'#AFD8C2');
  assert.equal(controller.getState().draft.player_style_override.handles.color,'#AFD8C2');

  api.setPlayerStylePath(controller,'handles.color','#FF00FF');
  api.setPlayerStylePath(controller,'controls.border','#A7CAE8');
  assert.equal(controller.getState().draft.player_style_override.handles.color,'#FF00FF');
});

test('direct waveform edits pair control shades and update player-linked outlines',()=>{
  const controller=api.createController({initial:aggregateInitial({
    player_style_override:completeSet('#234567'),
    interaction_overrides:{...aggregateInitial().interaction_overrides,item_outline:{source:'player',color:null}},
  }),request:async()=>{}});
  controller.setWaveformColor('fill','#387F68');
  controller.setWaveformColor('edge','#AFD8C2');
  const state=controller.getState();
  assert.equal(state.draft.player_style_override.waveform.fill,'#387F68');
  assert.equal(state.draft.player_style_override.controls.fill,'#24B86B');
  assert.equal(state.draft.player_style_override.waveform.edge,'#AFD8C2');
  assert.equal(state.draft.player_style_override.controls.border,'#86EFAC');
  assert.equal(state.draft.player_style_override.handles.color,'#AFD8C2');
  assert.equal(api.resolveInteractionOutline(state.draft,state.effective),'#86EFAC');
});

test('permanent player themes stay outside the five recent saved sets',()=>{
  assert.deepEqual(api.playerThemes.map(theme=>theme.name),[
    'Classic green','Slate mint','Midnight blue','Graphite moss','Soft black',
  ]);
  assert.deepEqual(api.playerThemes[0].style,classicGreenSet());
  const controller=api.createController({initial:aggregateInitial({player_recent_sets:[]}),request:async()=>{}});
  controller.setPlayerStyle(api.playerThemes[0].style);
  assert.deepEqual(controller.getState().draft.player_style_override,classicGreenSet());
  assert.deepEqual(controller.getState().playerRecentSets,[],'A permanent suggestion must not consume a recent-set slot before Save');

  const markup=api.seekbarMarkup();
  assert.match(markup,/>Player themes</);
  assert.match(markup,/data-player-theme="classic-green"/);
  assert.match(markup,/>Recent sets</);
  assert.match(markup,/five latest saved player configurations/);
  assert.doesNotMatch(markup,/Applied set history/);
});

test('complete player-set history is restored as one atomic style instead of separate color swatches',()=>{
  const current=completeSet('#234567');
  const controller=api.createController({initial:aggregateInitial({player_style_override:current,player_recent_sets:[current,classicGreenSet()]}),request:async()=>{}});
  assert.equal(typeof controller.restorePlayerSet,'function','Player history must restore complete applied sets');
  controller.restorePlayerSet(classicGreenSet());
  assert.deepEqual(controller.getState().draft.player_style_override,classicGreenSet());
  assert.deepEqual(controller.getState().playerRecentSets,[current,classicGreenSet()]);
});

test('recent waveform swatches update the structured player style used by the live preview',()=>{
  const controller=api.createController({initial:aggregateInitial(),request:async()=>{}});
  assert.equal(typeof controller.setWaveformColor,'function');
  controller.setWaveformColor('edge','#005C20');
  const state=controller.getState();
  assert.equal(state.draft.player_style_override.waveform.edge,'#005C20');
  assert.equal(state.draft.player_override,null,'Structured Appearance must not write the superseded player override');
  assert.deepEqual(state.waveformColorUpdates,['#005C20']);
  assert.equal(state.canSave,true);
});

test('Edges and handles shows thin loop handles in the player preview using the selected handle color',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/appearance-backgrounds.js'),'utf8');
  const css=fs.readFileSync(path.join(__dirname,'../../../music_app/static/css/appearance-backgrounds.css'),'utf8');
  assert.match(source,/class="player-preview-loop-handles"/);
  assert.match(source,/--preview-handle-color', style\.handles\.color/);
  assert.match(source,/data-show-handles', String\(waveformSelected && activeWaveformTab === 'handles'\)/);
  assert.match(css,/\.player-live-preview\[data-show-handles='true'\] \.player-preview-loop-handles/);
  assert.match(css,/\.player-preview-loop-handles line \{[^}]*stroke-width: 1\.5/s);
});

test('Save emits one complete applied_player_set and trusts the server-owned newest five distinct sets',async()=>{
  const newest=completeSet('#666666');
  const history=[newest,completeSet('#555555'),completeSet('#444444'),completeSet('#333333'),classicGreenSet()];
  const requests=[];
  const controller=api.createController({initial:aggregateInitial({player_recent_sets:[completeSet('#555555'),newest,completeSet('#444444'),completeSet('#333333'),classicGreenSet()]}),request:async(method,payload)=>{
    requests.push({method,payload});
    const {expected_revision,applied_player_set,...draft}=payload;
    return {...aggregateInitial(),...draft,revision:expected_revision+1,player_recent_sets:history};
  }});
  assert.equal(typeof controller.setPlayerStyle,'function','Player editor must update one structured style');
  controller.setPlayerStyle(newest);
  assert.equal(await controller.save(),true);
  assert.deepEqual(requests[0].payload.applied_player_set,newest);
  assert.equal(Object.hasOwn(requests[0].payload,'player_recent_sets'),false);
  assert.deepEqual(controller.getState().playerRecentSets,history);
  assert.equal(new Set(history.map(item=>JSON.stringify(item))).size,5);
});

test('aggregate Save submits deliberate waveform updates without writing server-owned recent history',async()=>{
  const requests=[];
  const initial=aggregateInitial();
  const controller=api.createController({initial,request:async(_method,payload)=>{
    requests.push(payload);
    const {expected_revision,applied_player_set,waveform_color_updates,...draft}=payload;
    return {...initial,...draft,revision:expected_revision+1,waveform_recent_colors:waveform_color_updates};
  }});
  controller.setWaveformColor('fill','#123456');
  assert.equal(await controller.save(),true);
  assert.deepEqual(requests[0].waveform_color_updates,['#123456']);
  assert.equal(Object.hasOwn(requests[0],'waveform_recent_colors'),false);
  assert.deepEqual(controller.getState().recentColors,['#123456']);
});

test('Match player preserves custom set history and Customize routes to Player & Seekbar without changing the draft',()=>{
  const history=[classicGreenSet(),completeSet('#234567')];
  const controller=api.createController({initial:aggregateInitial({player_recent_sets:history}),request:async()=>{}});
  controller.setPlayerMode('palette');
  const draft=controller.getState().draft;
  assert.equal(typeof controller.setActiveSection,'function','Customize must route through the aggregate workspace');
  controller.setActiveSection('seekbar');
  assert.equal(controller.getState().activeSection,'seekbar');
  assert.deepEqual(controller.getState().draft,draft);
  assert.deepEqual(controller.getState().playerRecentSets,history);
});

test('Custom player colors creates an editable structured set on the Player & Seekbar page',()=>{
  const controller=api.createController({initial:aggregateInitial({palette_id:'black',player_style_override:null}),request:async()=>{}});
  controller.setActiveSection('seekbar');
  controller.setPlayerMode('custom');
  assert.deepEqual(controller.getState().draft.player_style_override,{
    surface:{mode:'gradient',angle:0,start:'#050505',end:'#050505'},
    controls:{fill:'#1DB954',border:'#BDBDBD'},
    waveform:{fill:'#1DB954',edge:'#BDBDBD'},
    handles:{color:'#BDBDBD'},
  });
  assert.equal(controller.getState().dirty,true);
  assert.equal(controller.getState().canSave,true);
});
