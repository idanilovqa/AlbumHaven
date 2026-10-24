'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const O=require('./foobar-observation-preview-fixture.cjs'),{F}=O;
const decode=async(view=O.page(),command=F.command(),start=0)=>(await F.load('observation-contract.mjs')).validateObservationPage(view,command,start);
async function reject(mutator){const view=O.page();mutator(view);await assert.rejects(()=>decode(view),/observation review could not be verified/);}
test('OV01 observation decoder preserves both original and effective count families without addition',async()=>{
 const view=O.page();O.fieldAt(view,'effective').count='5';O.fieldAt(view,'effective').raw_prefix='5';const actual=await decode(view);
 assert.equal(actual.items[0].incoming[0].count,'2');assert.equal(actual.items[0].effective[0].count,'5');assert.equal(actual.items[0].incoming[1].count,'9');assert.equal(actual.items[0].effective[1].count,'9');assert.equal(actual.families_are_not_added,true);
});
test('OV02 observation decoder distinguishes zero absent empty unavailable and invalid counts',async()=>{
 const view=O.page();const variants=[{state:'valid',count:'0',raw_prefix:'0',raw_characters:1},{state:'absent',count:null,origin:null,raw_prefix:null,raw_characters:0},{state:'empty',count:null,raw_prefix:'',raw_characters:0},{state:'unavailable',count:null,raw_prefix:'N/A',raw_characters:3},{state:'invalid',count:null,code:'invalid_count',raw_prefix:'oops',raw_characters:4}];
 for(const v of variants){Object.assign(O.fieldAt(view),O.field('play_count',1),v);assert.deepEqual((await decode(view)).items[0].incoming[0],O.fieldAt(view));}
});
test('OV03 observation decoder retains previous effective origin alongside unavailable original evidence',async()=>{
 const view=O.page();Object.assign(O.fieldAt(view),{state:'unavailable',count:null,raw_prefix:'N/A',raw_characters:3});Object.assign(O.fieldAt(view,'effective'),{count:'7',raw_prefix:'7',origin:[O.OLDER,75,11]});const actual=await decode(view);
 assert.equal(actual.items[0].incoming[0].state,'unavailable');assert.deepEqual(actual.items[0].effective[0].origin,[O.OLDER,75,11]);assert.equal(actual.items[0].effective[0].count,'7');
});
test('OV04 observation decoder retains contradictory and unparseable raw date evidence without normalization',async()=>{
 const view=O.page();Object.assign(O.fieldAt(view,'incoming','first_played'),O.rawField('first_played',1,'2099-12-31'));Object.assign(O.fieldAt(view,'incoming','last_played'),O.rawField('last_played',1,'not a timestamp'));const actual=await decode(view);
 assert.equal(actual.items[0].incoming[2].raw_prefix,'2099-12-');assert.equal(actual.items[0].incoming[3].raw_prefix,'not a ti');assert.equal(actual.items[0].incoming[3].count,null);assert.equal(actual.date_state_is_raw_parser_evidence,true);
});
test('OV05 observation decoder accepts exact signed64 maximum as a decimal string not Number',async()=>{
 const view=O.page();Object.assign(O.fieldAt(view),{count:'9223372036854775807',raw_prefix:'92233720',raw_characters:19});assert.equal((await decode(view)).items[0].incoming[0].count,'9223372036854775807');
});
test('OV06 observation decoder rejects numeric negative padded overflowing and nondecimal counts',async()=>{
 for(const value of [0,2,-1,'-1','01','1.0','1e3','9223372036854775808','9'.repeat(20),null])await reject(v=>O.fieldAt(v).count=value);
});
test('OV07 observation decoder rejects extra private fields at every closed DTO level',async()=>{
 for(const mutate of [v=>v.path='/private',v=>v.items[0].native_track_id=11,v=>O.fieldAt(v).token='secret'])await reject(mutate);
});
test('OV08 observation decoder rejects omitted field summaries reordered names and extra families',async()=>{
 await reject(v=>v.items[0].incoming.pop());await reject(v=>v.items[0].effective.reverse());await reject(v=>v.items[0].incoming.push(O.field('lastfm_play_count')));
});
test('OV09 observation decoder rejects invalid state code and count tuples',async()=>{
 for(const patch of [{state:'unknown'},{state:'invalid',count:null,code:null},{state:'valid',code:'invalid_count'},{state:'unavailable',count:'2'},{state:'valid',count:null}])await reject(v=>Object.assign(O.fieldAt(v),patch));
 await reject(v=>Object.assign(O.fieldAt(v,'incoming','first_played'),{state:'invalid',code:'invalid_count'}));
});
test('OV10 observation decoder rejects wrong incoming upload row and malformed origin tuples',async()=>{
 for(const origin of [[O.OLDER,1,11],['b'.repeat(64),2,11],['b'.repeat(64),1,256],['b'.repeat(64),0,11],['B'.repeat(64),1,11],null,['b'.repeat(64),1]])await reject(v=>O.fieldAt(v).origin=origin);
});
test('OV11 observation decoder rejects fabricated raw prefixes lengths and absent origins',async()=>{
 await reject(v=>O.fieldAt(v).raw_prefix='long');await reject(v=>O.fieldAt(v).raw_characters=65537);await reject(v=>O.fieldAt(v).raw_characters=-1);await reject(v=>Object.assign(O.fieldAt(v),{state:'absent',count:null}));await reject(v=>O.fieldAt(v).raw_prefix='\ud800');
});
test('OV12 observation decoder enforces sanitized UTF8 label bounds while allowing literal angle brackets',async()=>{
 for(const [name,value] of [['source_artist','é'.repeat(25)],['source_title','x'.repeat(97)],['source_album','x\u202ey'],['source_title','line\nnext'],['source_artist','x\u2028y']])await reject(v=>v.items[0][name]=value);
 const view=O.page();view.items[0].source_title='<img src=x>';assert.equal((await decode(view)).items[0].source_title,'<img src=x>');
});
test('OV13 observation decoder validates exact twenty row pages and final remaining ordinal',async()=>{
 const first=await decode(O.page({total:41}),F.command({total_rows:41}));assert.equal(first.items.length,20);assert.equal(first.next,20);assert.equal(first.remaining,21);
 const second=await decode(O.page({total:41,after:20}),F.command({total_rows:41}));assert.equal(second.items[0].row,21);assert.equal(second.next,40);assert.equal(second.remaining,1);
 const last=await decode(O.page({total:41,after:40}),F.command({total_rows:41}));assert.equal(last.items.length,1);assert.equal(last.next,null);assert.equal(last.remaining,0);
});
test('OV14 observation decoder rejects skipped duplicated reordered oversized and short nonterminal pages',async()=>{
 await reject(v=>v.items[1].row=1);await reject(v=>v.items[0].row=2);await reject(v=>v.remaining=1);await reject(v=>v.next=4);
 const v=O.page({total:40});v.items.pop();v.remaining++;await assert.rejects(()=>decode(v,F.command({total_rows:40})));
 const large=O.page({total:21,rows:Array.from({length:21},(_,i)=>O.row(i+1))});await assert.rejects(()=>decode(large,F.command({total_rows:21})));
});
test('OV15 observation decoder starts only after the confirmed prefix and accepts exact terminal empty page',async()=>{
 const cmd=F.command({total_rows:41});assert.equal((await decode(O.page({total:41,after:20}),cmd,20)).after,20);await assert.rejects(()=>decode(O.page({total:41}),cmd,20));const last=await decode(O.page({total:41,after:41}),cmd,20);assert.equal(last.items.length,0);assert.equal(last.next,null);
});
test('OV16 observation decoder freezes nested rows sides fields origins and raw chunk copies',async()=>{
 const view=O.page();view.raw_chunk=O.chunk('2');const actual=await decode(view);
 for(const x of [actual,actual.items,actual.items[0],actual.items[0].incoming,actual.items[0].incoming[0],actual.items[0].incoming[0].origin,actual.raw_chunk])assert.equal(Object.isFrozen(x),true);
 O.fieldAt(view).origin[0]=O.OLDER;view.raw_chunk.text='9';assert.equal(actual.items[0].incoming[0].origin[0],'b'.repeat(64));assert.equal(actual.raw_chunk.text,'2');
});
test('OV17 observation raw chunk uses exactly512 Unicode codepoints not UTF16 units',async()=>{
 const raw='😀'.repeat(513),view=O.page();Object.assign(O.fieldAt(view),O.rawField('play_count',1,raw,{state:'invalid',count:null,code:'invalid_count'}));view.raw_chunk=O.chunk(raw);const actual=await decode(view);
 assert.equal(actual.raw_chunk.text.length,1024);assert.equal(Array.from(actual.raw_chunk.text).length,512);assert.equal(actual.raw_chunk.next_offset,512);
 view.raw_chunk=O.chunk(raw,{offset:512});const last=await decode(view);assert.equal(last.raw_chunk.text,'😀');assert.equal(last.raw_chunk.next_offset,null);
});
test('OV18 observation decoder rejects wrong raw field row side prefix length offset and continuation',async()=>{
 const raw='x'.repeat(1025);for(const patch of [{ordinal:5},{side:'stored'},{field:'path'},{offset:1},{text:'x'.repeat(513)},{next_offset:513},{total_characters:1024},{extra:true}]){
 const view=O.page();Object.assign(O.fieldAt(view),O.rawField('play_count',1,raw,{state:'invalid',count:null,code:'invalid_count'}));view.raw_chunk={...O.chunk(raw),...patch};await assert.rejects(()=>decode(view));}
 const view=O.page();view.raw_chunk=O.chunk('9');await assert.rejects(()=>decode(view));
});
test('OV19 observation decoder rejects lone surrogates and terminal nonzero empty chunks',async()=>{
 const view=O.page();view.raw_chunk={...O.chunk('2'),text:'\ud800'};await assert.rejects(()=>decode(view));
 const raw='x'.repeat(512);Object.assign(O.fieldAt(view),O.rawField('play_count',1,raw,{state:'invalid',count:null,code:'invalid_count'}));view.raw_chunk=O.chunk(raw,{offset:512});await assert.rejects(()=>decode(view));
});
test('OV20 observation decoder permits explicit absent and empty raw inspections without invented characters',async()=>{
 for(const patch of [{state:'absent',origin:null,raw_prefix:null},{state:'empty',raw_prefix:''}]){const view=O.page();Object.assign(O.fieldAt(view),{count:null,raw_characters:0,...patch});view.raw_chunk=O.chunk('');const actual=await decode(view);assert.equal(actual.raw_chunk.text,'');assert.equal(actual.raw_chunk.total_characters,0);assert.equal(actual.raw_chunk.next_offset,null);}
});
test('OV21 raw request decoder allows beginning any visible field and only exact returned next chunk',async()=>{
 const C=await F.load('observation-contract.mjs'),raw='x'.repeat(1025),view=O.page();Object.assign(O.fieldAt(view),O.rawField('play_count',1,raw,{state:'invalid',count:null,code:'invalid_count'}));view.raw_chunk=O.chunk(raw);
 assert.equal(C.validateRawFieldRequest(null,view),null);const request={ordinal:1,side:'incoming',field:'play_count',offset:512};assert.deepEqual(C.validateRawFieldRequest(request,view),request);assert.equal(Object.isFrozen(C.validateRawFieldRequest(request,view)),true);
 assert.deepEqual(C.validateRawFieldRequest({ordinal:2,side:'effective',field:'last_played',offset:0},view),{ordinal:2,side:'effective',field:'last_played',offset:0});
});
test('OV22 raw request decoder rejects unseen row side field skipped offset and stale tuple',async()=>{
 const C=await F.load('observation-contract.mjs'),view=O.page(),valid={ordinal:1,side:'incoming',field:'play_count',offset:0};
 for(const patch of [{ordinal:5},{side:'native'},{field:'rating'},{offset:1},{offset:512},{path:'private'}])assert.throws(()=>C.validateRawFieldRequest({...valid,...patch},view));assert.throws(()=>C.validateRawFieldRequest(valid,null));
});
test('OV23 raw display escapes every control bidi and line separator without dropping visible Unicode',async()=>{
 const C=await F.load('observation-contract.mjs');assert.equal(C.displayRawEvidence(null),'No supplied field');assert.equal(C.displayRawEvidence('a\n\t\0\u202e\u2028😀<img>'),'a\\u{a}\\u{9}\\u{0}\\u{202e}\\u{2028}😀<img>');
});
test('OV24 actual review decoder accepts optional observation DTO but preserves ordinary exact wire shape',async()=>{
 const C=await F.load('contract.mjs');const plain=C.validateReview(F.review({review:O.base()}),F.STAMP,'status',F.SOURCE,F.JOBREF);assert.equal(Object.hasOwn(plain.review,'observations'),false);
 const review=C.validateReview(F.review({review:O.proposal()}),F.STAMP,'status',F.SOURCE,F.JOBREF);assert.equal(review.review.observations.items.length,4);assert.equal(Object.isFrozen(review.review.observations),true);
});
test('OV25 actual review decoder rejects observations on Enhanced SQLite mapping and malformed envelopes',async()=>{
 const C=await F.load('contract.mjs');assert.throws(()=>C.validateReview(F.review({review:O.E.proposal({observations:O.page()})}),F.STAMP,'status',F.SOURCE,F.JOBREF));
 for(const patch of [{context_ref:'c'.repeat(64)},{context_scope:'foreign'},{operation:'start'}])assert.throws(()=>C.validateReview({...F.review({review:O.proposal()}),...patch},F.STAMP,'status',F.SOURCE,F.JOBREF));
});
test('OV26 observation decoder requires honest raw date and nonaddition declarations',async()=>{
 await reject(v=>v.date_state_is_raw_parser_evidence=false);await reject(v=>v.families_are_not_added=false);await reject(v=>delete v.families_are_not_added);
});
test('OV27 genuine bounded JSON reader admits exact131072-byte observation budget and rejects one extra byte',async()=>{
 const C=await F.load('contract.mjs'),V=await F.load('observation-contract.mjs'),signal=new AbortController().signal;assert.equal(V.OBSERVATION_RESPONSE_BYTES,131072);const exact='x'.repeat(131070);
 assert.equal(await C.readBoundedJSON(F.response(exact),signal,V.OBSERVATION_RESPONSE_BYTES),exact);await assert.rejects(()=>C.readBoundedJSON(F.response(exact+'x'),signal,V.OBSERVATION_RESPONSE_BYTES));
});
test('OV28 genuine bounded JSON reader retains old budgets and rejects unrecognized allowances',async()=>{
 const C=await F.load('contract.mjs'),signal=new AbortController().signal;for(const max of [C.MAX_RESPONSE_BYTES,C.MAX_REVIEW_RESPONSE_BYTES]){const exact='x'.repeat(max-2);assert.equal(await C.readBoundedJSON(F.response(exact),signal,max),exact);await assert.rejects(()=>C.readBoundedJSON(F.response(exact+'x'),signal,max));}
 for(const max of [0,65537,131073,Infinity])await assert.rejects(()=>C.readBoundedJSON(F.response({}),signal,max));
});
// The following is an instrumented transport reader, never a product decoder.
function stream(chunks,onRead=()=>{}){let reads=0,cancels=0,releases=0;return {response:{redirected:false,headers:new Headers({'Content-Type':'application/json'}),body:{getReader(){return {async read(){onRead(reads);return reads<chunks.length?{done:false,value:chunks[reads++]}:{done:true};},async cancel(){cancels++;},releaseLock(){releases++;}};}}},counts:()=>({reads,cancels,releases})};}
test('OV29 observation allowance preserves MIME redirect and advertised-size rejection before stream access',async()=>{
 const C=await F.load('contract.mjs'),V=await F.load('observation-contract.mjs'),signal=new AbortController().signal;
 for(const patch of [{redirected:true},{headers:new Headers({'Content-Type':'text/html'})},{headers:new Headers({'Content-Type':'application/json','Content-Length':'131073'})},{headers:new Headers({'Content-Type':'application/json','Content-Length':'bogus'})}]){const wire=stream([new Uint8Array([123,125])]);await assert.rejects(()=>C.readBoundedJSON({...wire.response,...patch},signal,V.OBSERVATION_RESPONSE_BYTES));assert.deepEqual(wire.counts(),{reads:0,cancels:0,releases:0});}
});
test('OV30 observation allowance enforces cumulative streamed bytes and releases reader on overflow',async()=>{
 const C=await F.load('contract.mjs'),V=await F.load('observation-contract.mjs'),signal=new AbortController().signal,bytes=new TextEncoder().encode(JSON.stringify('x'.repeat(131070)));
 const exact=stream([bytes.slice(0,65536),bytes.slice(65536)]);assert.equal((await C.readBoundedJSON(exact.response,signal,V.OBSERVATION_RESPONSE_BYTES)).length,131070);assert.deepEqual(exact.counts(),{reads:2,cancels:1,releases:1});
 const over=stream([bytes.slice(0,65536),bytes.slice(65536),new Uint8Array([32])]);await assert.rejects(()=>C.readBoundedJSON(over.response,signal,V.OBSERVATION_RESPONSE_BYTES));assert.deepEqual(over.counts(),{reads:3,cancels:1,releases:1});
});
test('OV31 observation stream preserves split astral UTF8 and rejects malformed or incomplete sequences',async()=>{
 const C=await F.load('contract.mjs'),V=await F.load('observation-contract.mjs'),signal=new AbortController().signal,bytes=new TextEncoder().encode(JSON.stringify('😀𐐷'));
 const good=stream([bytes.slice(0,3),bytes.slice(3,7),bytes.slice(7)]);assert.equal(await C.readBoundedJSON(good.response,signal,V.OBSERVATION_RESPONSE_BYTES),'😀𐐷');assert.deepEqual(good.counts(),{reads:3,cancels:1,releases:1});
 for(const chunks of [[new Uint8Array([34,0xc3,0x28,34])],[new Uint8Array([34,0xf0,0x9f])]]){const bad=stream(chunks);await assert.rejects(()=>C.readBoundedJSON(bad.response,signal,V.OBSERVATION_RESPONSE_BYTES));assert.equal(bad.counts().cancels,1);assert.equal(bad.counts().releases,1);}
});
test('OV32 observation reader honors preexisting and midstream abort and always cancels and unlocks',async()=>{
 const C=await F.load('contract.mjs'),V=await F.load('observation-contract.mjs'),early=new AbortController();early.abort();const first=stream([new Uint8Array([123,125])]);await assert.rejects(()=>C.readBoundedJSON(first.response,early.signal,V.OBSERVATION_RESPONSE_BYTES),{name:'AbortError'});assert.deepEqual(first.counts(),{reads:0,cancels:1,releases:1});
 const mid=new AbortController(),second=stream([new Uint8Array([123]),new Uint8Array([125])],()=>mid.abort());await assert.rejects(()=>C.readBoundedJSON(second.response,mid.signal,V.OBSERVATION_RESPONSE_BYTES),{name:'AbortError'});assert.deepEqual(second.counts(),{reads:1,cancels:1,releases:1});
});
test('OV33 observation allowance preserves JSON and byte-chunk validation with reader cleanup',async()=>{
 const C=await F.load('contract.mjs'),V=await F.load('observation-contract.mjs'),signal=new AbortController().signal;
 for(const chunks of [[new TextEncoder().encode('not JSON')],['not bytes']]){const wire=stream(chunks);await assert.rejects(()=>C.readBoundedJSON(wire.response,signal,V.OBSERVATION_RESPONSE_BYTES));assert.equal(wire.counts().cancels,1);assert.equal(wire.counts().releases,1);}
});
