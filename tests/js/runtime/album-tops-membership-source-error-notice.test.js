const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{buildSync}=require('esbuild');
const F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
const {createNativeHomeRuntime}=require(path.join(F.ROOT,'tests/js/runtime/native-home-harness.cjs'));
let MutationNotice;
test.before(()=>{const result=buildSync({entryPoints:[F.source('album-tops/mutation-notice.jsx')],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom']});
  const loaded=new Module(__filename+'.fixture.cjs',module);loaded.filename=__filename+'.fixture.cjs';loaded.paths=module.paths;loaded._compile(result.outputFiles[0].text,loaded.filename);MutationNotice=loaded.exports.MutationNotice;});
for(const code of ['evidence_unavailable','evidence_stale'])test(`real mutation notice explains ${code} from a generic transport error`,()=>{
  const native=createNativeHomeRuntime(),runtime={alertHtml:value=>native.context.buildOnPageAlertHtml(value)};
  const value={status:'error',action:'save',error:Object.assign(new Error('The request could not be completed.'),{status:409,code})};
  const controller={getSnapshot:()=>({scopeKey:F.SCOPE,mutation:value}),canRetryMutation:()=>false};
  const html=renderToStaticMarkup(React.createElement(MutationNotice,{runtime,controller,value}));
  const host=native.document.createElement('section');host.innerHTML=html;const text=host.textContent;
  assert.match(text,/source|metadata/i);assert.match(text,code==='evidence_stale'?/chang|stale/i:/unavailable|cannot|could not/i);
  assert.match(text,/draft/i);assert.match(text,/preserv|retain|kept|still/i);assert.match(text,/cancel/i);assert.match(text,/saved/i);
  assert.doesNotMatch(text,/select a source|choose a source|open the source selector/i);
});
