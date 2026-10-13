const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
const {buildSync}=require('esbuild');
const F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
test('the existing AlbumPicker owner is available as an unchanged mountable component',()=>{
  const result=buildSync({entryPoints:[F.source('album-tops/builder.jsx')],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom','react-dom/client']});
  const loaded=new Module(__filename+'.fixture.cjs',module);loaded.filename=__filename+'.fixture.cjs';loaded.paths=module.paths;loaded._compile(result.outputFiles[0].text,loaded.filename);
  assert.equal(typeof loaded.exports.AlbumPicker,'function','Missing existing AlbumPicker export: this is a mount-seam gate, not capacity UI evidence');
  assert.equal(typeof loaded.exports.AlbumTopBuilder,'function');assert.equal(typeof loaded.exports.InlineAlbumTopEdit,'function');
});
