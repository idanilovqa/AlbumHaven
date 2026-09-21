const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../../../music_app/static/js/runtime');
test('saved appearance event restyles mounted compound nodes without replacing their owners',()=>{
  let saved='capsule';const listeners={};const capabilities=[];
  const audio={currentTime:12,paused:false},range={start:3,end:8},timer={pending:true};
  const nodes=[{audio,range,timer,attributes:{},setAttribute(name,value){this.attributes[name]=value;}},{attributes:{},setAttribute(name,value){this.attributes[name]=value;}}];
  const context=vm.createContext({state:{loopCreateAllowed:true,utility:{}},
    window:{AlbumHavenAppearance:{instance:{getSavedLoopControlStyle:()=>saved,setLoopCreateAllowed:value=>capabilities.push(value)}},addEventListener:(name,fn)=>{listeners[name]=fn;}},
    document:{querySelectorAll:()=>nodes},updateWaveformAppearance(){}});
  vm.runInContext(fs.readFileSync(path.join(root,'appearance-backgrounds-bridge.js'),'utf8'),context);
  saved='companion';listeners['album-haven-appearance-change']();
  assert.equal(nodes[0].attributes['data-loop-control-style'],'companion');
  assert.equal(nodes[1].attributes['data-loop-control-style'],'companion');
  assert.equal(nodes[0].audio,audio);assert.equal(nodes[0].range,range);assert.equal(nodes[0].timer,timer);
  assert.deepEqual(audio,{currentTime:12,paused:false});
  saved='capsule';
  vm.runInContext(fs.readFileSync(path.join(root,'player-and-waveform.js'),'utf8'),context);
  context.getGlobalPlayerLoopControlOptions=()=>({});
  context.getPlayerElements=()=>({loopActions:{_loopActionController:timer},loopRange:{_loopRangeController:range}});
  context.document.querySelector=()=>null;
  context.mountGlobalPlayerLoopControls();
  assert.equal(nodes[0].attributes['data-loop-control-style'],'capsule','a normal main-player mount reads the saved style');
  vm.runInContext(fs.readFileSync(path.join(root,'player-loop-playback.js'),'utf8'),context);
  context.syncLoopCreateCapability();assert.equal(capabilities.at(-1),true);
  context.state.loopCreateAllowed=false;context.syncLoopCreateCapability();assert.equal(capabilities.at(-1),false);
});

test('new saved-player markup uses the saved preference without consulting a draft',()=>{
  const context=vm.createContext({window:{AlbumHavenAppearance:{instance:{getSavedLoopControlStyle:()=> 'companion'}}},
    buildLoopEditActionControl:()=>'',escapeHtml:value=>value});
  vm.runInContext(fs.readFileSync(path.join(root,'playback-control-cluster.js'),'utf8'),context);
  assert.match(context.window.renderPlaybackControlCluster({variant:'saved-loop',loopId:'new'}),/data-loop-control-style="companion"/);
});
