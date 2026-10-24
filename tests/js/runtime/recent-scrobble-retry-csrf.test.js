'use strict';
// UNRUN: actual shared CSRF wrapper, synthetic cookie, no real network.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
test('shared same-origin wrapper attaches CSRF and does not retry a failed scrobble POST',async()=>{
  const calls=[], failure=new TypeError('synthetic network failure');
  const window={location:new URL('https://albumhaven.test/home'),fetch:async(...args)=>{calls.push(args);throw failure;}};
  const context=vm.createContext({window,document:{cookie:'__Host-album_haven_csrf=synthetic-csrf'},URL,Headers});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/js/runtime/session-csrf-fetch.js'),'utf8'),context);
  await assert.rejects(window.fetch('/home/activity/scrobbles/retry',{method:'POST',headers:{'X-AlbumHaven-Context':'a'.repeat(64)},body:'{}'}));
  assert.equal(calls.length,1);
  assert.equal(calls[0][1].credentials,'same-origin');
  assert.equal(calls[0][1].headers.get('X-Album-Haven-CSRF'),'synthetic-csrf');
  assert.equal(calls[0][1].headers.get('X-AlbumHaven-Context'),'a'.repeat(64));
});
