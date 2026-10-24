'use strict';
// UNRUN. Actual Home JSX render + real selection lease; bounded hook fixture.
// Layout effects and DOM geometry are not claimed by this source regression.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {viewFixture,find}=require('./home-foobar-react-app-fixture.cjs');
const helpers=import(pathToFileURL(path.resolve(__dirname,'../../../music_app/static/js/home-friends/selection-presentation.mjs')));
async function selectedFixture(){
 const {selectionDescriptor,updateSelectionEntry}=await helpers;
 const query={section:'recent',account_ref:null,kind:'artists',period:'week'};
 const target={kind:'artist',ref:'artist:one',allowed_actions:{can_view_details:true},
  origin:{source:'activity',account_ref:null,kind:'artists',period:'week'}};
 const row={id:'row:one',kind:'artist',title:'Artist',source_readable:true,artist_target:target,allowed_actions:{can_view_details:true}};
 const source={status:'ready',data:{rows:[row],snapshot_ref:null}};
 const selected=selectionDescriptor(row,target,source);
 assert.ok(selected);
 const f=viewFixture({authenticated:true,accountRoot:{isConnected:true,dataset:{accountFoobarContext:'a'.repeat(64),
  accountFoobarScope:'account-foobar-v1',accountFoobarHistoryAllowed:'true'}},
  activity:{account_ref:null,kind:'artists',period:'week'},presentation:{kind:'artists',kindExplicit:true,
   selectionPresentation:updateSelectionEntry([],query,{selected,pane:'artist'})}});
 f.state.activity=source;
 const detail=tree=>find(tree,e=>e.type?.name==='ResourceDetail'&&e.props.selection?.kind==='artist');
 const switchTo=value=>{find(f.render(),e=>e.props.id==='home-recent-sections').props.onChange(value);return f.render();};
 return {f,row,source,detail,switchTo};
}
test('Home Foobar source switch preserves unchanged selected Recent resource on return',async()=>{
 const {f,detail,switchTo}=await selectedFixture();try{
  assert.equal(detail(f.render()).props.selection.ref,'artist:one');
  assert.ok(find(switchTo('foobar'),e=>e.type?.name==='FoobarHistory'));
  assert.equal(detail(switchTo('recent')).props.selection.ref,'artist:one');
 }finally{f.dispose();}
});
test('Home Foobar return revalidates revoked selection and never revives retired source',async()=>{
 const {f,row,detail,switchTo}=await selectedFixture();try{
  assert.equal(detail(f.render()).props.selection.ref,'artist:one');switchTo('foobar');
  row.artist_target.allowed_actions.can_view_details=false;
  assert.equal(detail(switchTo('recent')),undefined);
  row.artist_target.allowed_actions.can_view_details=true;
  assert.equal(detail(f.render()),undefined,'restoring old grant is not another selection gesture');
 }finally{f.dispose();}
});
