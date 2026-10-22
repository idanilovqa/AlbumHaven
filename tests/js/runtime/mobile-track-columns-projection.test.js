const test = require('node:test');
const assert = require('node:assert/strict');
let project;
test.before(async () => {
  ({resolveTrackTableColumns: project} = await import('../../../music_app/static/js/playtables/track-table-presentation.mjs'));
});
const columns = Object.freeze([
 {key:'number',label:'#',width:36,required:true},
 {key:'title',label:'Track',width:140,identity:true},
 {key:'artist',label:'Artist',width:112},
 {key:'love',label:'Love',width:44,required:true},
 {key:'rating',label:'Rating',width:64},
 {key:'duration',label:'Length',width:56,required:true},
].map(Object.freeze));
const required = ['number','title','love','duration'];
test('required identity, Love, Length and native number survive zero and hostile choices',()=>{
 for (const width of [0,-1,NaN,Infinity,200,320]) {
  const value=project(columns,width,{number:false,title:false,love:false,duration:false,artist:false,rating:false});
  assert.deepEqual(value.visibleKeys,required); assert.equal(value.minWidth,320);
  assert.match(value.gridTemplate,/minmax\(140px,\s*1fr\)/);
 }
});
test('fit budget includes padding and every gap with one shared ordered projection',()=>{
 assert.deepEqual(project(columns,439,{rating:false}).visibleKeys,required);
 assert.deepEqual(project(columns,440,{rating:false}).visibleKeys,['number','title','artist','love','duration']);
 assert.deepEqual(project(columns,511).visibleKeys,['number','title','artist','love','duration']);
 assert.deepEqual(project(columns,512).visibleKeys,columns.map(c=>c.key));
 assert.equal(project(columns,512).minWidth,512);
});
test('explicit Rating survives below480 without displacing required fields or inventing unavailable fields',()=>{
 const out=project(columns,320,{rating:true,artist:false,private_identity:true,globalRating:true});
 assert.deepEqual(out.visibleKeys,['number','title','love','rating','duration']);
 assert.equal(out.minWidth,392);assert.match(out.gridTemplate,/64px/);
 assert.deepEqual(project(columns.filter(c=>c.key!=='rating'),320,{rating:true}).visibleKeys,required);
});
test('choices and descriptors remain immutable and independent between resources',()=>{
 const a=Object.freeze({rating:true,artist:false}), b=Object.freeze({rating:false,artist:true});
 const before=JSON.stringify(columns);
 assert.deepEqual(project(columns,320,a).visibleKeys,['number','title','love','rating','duration']);
 assert.deepEqual(project(columns,320,b).visibleKeys,['number','title','artist','love','duration']);
 assert.deepEqual(project(columns,320).visibleKeys,required);
 assert.equal(JSON.stringify(columns),before);assert.deepEqual(a,{rating:true,artist:false});
});
test('non-track projected metrics remain source-provided and an empty source stays empty',()=>{
 assert.deepEqual(project([],390,{rating:true}).visibleKeys,[]);
 const restricted=[{key:'title',label:'Unavailable track',width:140,identity:true},{key:'duration',label:'Length',width:56,required:true}];
 assert.deepEqual(project(restricted,1440,{love:true,rating:true}).visibleKeys,['title','duration']);
});
