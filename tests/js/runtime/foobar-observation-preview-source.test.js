'use strict';
// Source-composition assertions only. These do not run or qualify Python/SQL.
const test=require('node:test'),assert=require('node:assert/strict');
const {F}=require('./foobar-observation-preview-fixture.cjs');
test('OS01 actual import entry owns full observation panel controller contract and retained maintenance',()=>{
 const entry=F.read('music_app/static/js/foobar-import/index.mjs'),controller=F.read('music_app/static/js/foobar-import/controller.mjs'),contract=F.read('music_app/static/js/foobar-import/contract.mjs');
 assert.match(entry,/import \{mountObservationPreview\} from '\.\/observation-panel\.mjs'/);assert.match(entry,/observationPanel=mountObservationPreview\(observationHost/);assert.match(entry,/controller\.inspectObservations\(after,raw\)/);assert.match(entry,/controller\.setCountFamily\(value\)/);assert.match(entry,/onReturn:.*controller\.preview\(\)/);assert.match(entry,/maintenance=mountMaintenance/);assert.match(entry,/observationPanel\?\.dispose\(\)/);
 assert.match(controller,/import \{OBSERVATION_RESPONSE_BYTES,validateRawFieldRequest\}/);assert.match(contract,/import \{validateObservationPage,OBSERVATION_RESPONSE_BYTES\} from '\.\/observation-contract\.mjs'/);
 assert.match(contract,/maximum!==MAX_RESPONSE_BYTES&&maximum!==MAX_REVIEW_RESPONSE_BYTES&&maximum!==OBSERVATION_RESPONSE_BYTES/);
 assert.match(contract,/validateObservationPage\(p\.observations,command,p\.start_offset\)/);
});
test('OS02 genuine observation owner and serializer retain bounded raw presentation without native handles',()=>{
 const owner=F.read('music_app/services/foobar_account_observation_preview.py'),route=F.read('music_app/routes/foobar_account_import_asgi.py'),contract=F.read('music_app/static/js/foobar-import/observation-contract.mjs');
 assert.match(owner,/MAX_ROWS = 20/);assert.match(owner,/RAW_PREFIX_CHARACTERS = 8/);assert.match(owner,/RAW_CHUNK_CHARACTERS = 512/);assert.match(owner,/CONTROL_BYTES = 1048576/);assert.ok(owner.indexOf('admit(len(encoded)//2)')<owner.indexOf('payload=bytes.fromhex(encoded)'));assert.match(owner,/fields=evidence\.decode_evidence\(payload\)/);assert.match(owner,/del fields/);
 assert.match(route,/def _observation_wire\(progress\)/);assert.match(route,/result\['review'\]\['observations'\]=_observation_wire\(progress\)/);assert.match(contract,/OBSERVATION_RESPONSE_BYTES=131072/);assert.match(contract,/items\.length>20/);assert.match(contract,/c\.offset%512/);assert.doesNotMatch(contract,/native_track_id|file_path|access_token/);
});
test('OS03 observation continuation preserves genuine cached semantic review and fresh whole-file path',()=>{
 const controller=F.read('music_app/static/js/foobar-import/controller.mjs'),review=F.read('music_app/services/foobar_account_import_review.py'),service=F.read('music_app/services/foobar_account_import_service.py');
 assert.match(controller,/file!==reviewFile/);assert.match(controller,/p\.review_sha256!==continuationReview\.review_sha256/);assert.match(controller,/p\.inventory_sha256!==continuationReview\.inventory_sha256/);assert.match(controller,/Object\.keys\(continuationReview\.command\)/);assert.match(controller,/view\.after!==observationRequest\.after/);assert.match(controller,/request\('\/review\/start'/);assert.match(controller,/body:chosen/);
 assert.match(review,/def checked_observation_continuation\(request,cached\)/);assert.match(service,/checked_observation_continuation/);assert.match(review,/conflict_after=None if is_enhanced or request\.observation_after is not None/);assert.match(review,/problem_after=None if is_enhanced or request\.observation_after is not None/);
});
test('OS04 family choice is page-local text presentation while Enhanced import and job wire remain separate',()=>{
 const panel=F.read('music_app/static/js/foobar-import/observation-panel.mjs'),controller=F.read('music_app/static/js/foobar-import/controller.mjs'),entry=F.read('music_app/static/js/foobar-import/index.mjs');
 assert.match(panel,/rawText\.textContent=displayRawEvidence\(c\.text\)/);assert.match(panel,/family\.value==='enhanced'\?'play_count_enhanced':'play_count'/);assert.match(panel,/No families or providers are summed/);assert.doesNotMatch(panel,/localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(/);
 assert.match(controller,/countFamily:value,review:state\.review\?Object\.freeze\(\{\.\.\.state\.review\}\):null/);assert.match(entry,/not a persisted job preference or a change to confirmed import counters/);assert.match(entry,/timestamp-vector evidence, not lifetime play counts/);assert.match(entry,/currentReview && !state\.review\.observations/);
});
