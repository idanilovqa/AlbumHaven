const test = require('node:test');
const assert = require('node:assert/strict');
let project;
test.before(async () => {
  ({resolveTrackTableColumns: project} = await import('../../../music_app/static/js/playtables/track-table-presentation.mjs'));
});
const core=Object.freeze([{key:'number',label:'#',width:28,required:true},{key:'title',label:'Track',width:110,identity:true},{key:'love',label:'Love',width:36,required:true},{key:'duration',label:'Length',width:54,required:true}].map(Object.freeze));
const keys=core.map(c=>c.key);
test('auto extras preserve the approved flexible identity reserve at390',()=>{
 const columns=[...core,{key:'availability',label:'Availability',width:64}];
 const policy=Object.freeze({identityReserve:Math.min(240,390*.45)});
 assert.deepEqual(project(columns,390).visibleKeys,[...keys,'availability'],'Legacy no-policy projection stays compatible');
 const value=project(columns,390,{},policy);
 assert.deepEqual(value.visibleKeys,keys,'Auto Availability cannot consume reserved readable title space');
 assert.equal(value.minWidth,272,'Reserve guides auto-admission, not a new forced minimum');
 assert.match(value.gridTemplate,/minmax\(110px,\s*1fr\)/);
});
test('identity reserve budget has exact boundary and does not charge required widths twice',()=>{
 const columns=[...core,{key:'plays',label:'Plays',width:54}], policy={identityReserve:180};
 // Core272 + optional54 + gap8 + reserve delta70 = 404.
 assert.deepEqual(project(columns,403,{},policy).visibleKeys,keys);
 assert.deepEqual(project(columns,404,{},policy).visibleKeys,[...keys,'plays']);
 assert.equal(project(columns,404,{},policy).minWidth,334);
});
test('autoMinWidth admits metadata only at declared boundary without hiding required cells',()=>{
 const columns=[...core,{key:'availability',label:'Availability',width:64,autoMinWidth:641}];
 for(const width of [390,480,640])assert.deepEqual(project(columns,width).visibleKeys,keys);
 assert.deepEqual(project(columns,641).visibleKeys,[...keys,'availability']);
 const hostile=core.map(c=>({...c,autoMinWidth:2000}));
 assert.deepEqual(project(hostile,390,{love:false,duration:false,title:false}).visibleKeys,keys);
});
test('explicit narrow Rating overrides autoMinWidth and identity reserve without changing descriptor widths',()=>{
 const rating=Object.freeze({key:'rating',label:'Rating',width:80,autoMinWidth:481}), columns=Object.freeze([...core,rating]);
 assert.deepEqual(project(columns,480).visibleKeys,keys);
 assert.deepEqual(project(columns,481).visibleKeys,[...keys,'rating']);
 const explicit=project(columns,320,Object.freeze({rating:true}),Object.freeze({identityReserve:240}));
 assert.deepEqual(explicit.visibleKeys,[...keys,'rating']);assert.equal(explicit.minWidth,360);
 assert.match(explicit.gridTemplate,/minmax\(110px,\s*1fr\)/);assert.equal(rating.width,80);
 assert.deepEqual(project(columns,1440,{rating:false},{identityReserve:240}).visibleKeys,keys);
});
