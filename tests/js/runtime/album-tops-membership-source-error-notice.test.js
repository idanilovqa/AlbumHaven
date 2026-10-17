const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
const {load,nativeEnvironment}=require('./album-tops-native-fixtures/actual-native-runtime.cjs');
for(const code of ['evidence_unavailable','evidence_stale'])test(`real mutation notice explains ${code} from a generic transport error`,async t=>{
  const native=nativeEnvironment(),{host,runtime}=native;
  const {mountMutationNotice}=await load('album-tops/mutation-notice.mjs');
  const value={status:'error',action:'save',error:Object.assign(new Error('The request could not be completed.'),{status:409,code})};
  const controller={getSnapshot:()=>({scopeKey:F.SCOPE,mutation:value}),canRetryMutation:()=>false};
  const owner=mountMutationNotice(host,runtime,{controller,value});
  t.after(()=>{owner.dispose();assert.equal(host.childNodes.length,0);native.assertClean();});
  const text=host.textContent;
  assert.match(text,/source|metadata/i);assert.match(text,code==='evidence_stale'?/chang|stale/i:/unavailable|cannot|could not/i);
  assert.match(text,/draft/i);assert.match(text,/preserv|retain|kept|still/i);assert.match(text,/cancel/i);assert.match(text,/saved/i);
  assert.doesNotMatch(text,/select a source|choose a source|open the source selector/i);
});
