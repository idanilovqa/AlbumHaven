const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./playlist-native-review-fixture.cjs');
test('F1 match candidate/Accept controls retain identity and focus across selection, reorder and playback-only refresh',async()=>{
 const {mountPlaylistMatchReview}=await import('../../../music_app/static/js/playlists/native-integrations.mjs'),h=fixture();
 const a={candidate_ref:'a',title:'Candidate A'},b={candidate_ref:'b',title:'Candidate B'};
 let state={scopeKey:'scope',detail:{playlist_id:'p',track_rows:[{playlist_item_id:'item',source_readable:true,title:'Original',availability:'unresolved'}]},selectedItemId:'item',matches:{status:'ready',data:{candidates:[a,b]}},matchMutation:{status:'idle'},available:{acceptMatch:true},candidateRef:null},owner,accepted=0;
 const props=()=>({controller,state,onAccepted:()=>accepted++}),controller={chooseCandidate(key){state={...state,candidateRef:key};owner.update(props());},acceptMatch:async()=>true};owner=mountPlaylistMatchReview(h.host,h.runtime,props());
 const candidates=()=>[...h.host.querySelectorAll('.playlists__match-candidates button')],first=candidates()[0],second=candidates()[1],accept=h.host.querySelector('[data-playlists-accept-match]');first.focus();h.click(first);assert.equal(candidates()[0],first);assert.equal(h.document.activeElement,first);assert.equal(first.getAttribute('aria-pressed'),'true');
 state={...state,playback:{status:'ready'},matches:{status:'ready',data:{candidates:[b,a]}}};owner.update(props());assert.deepEqual(candidates(),[second,first]);assert.equal(h.document.activeElement,first);assert.equal(h.host.querySelector('[data-playlists-accept-match]'),accept);
 h.click(accept);await h.settle();assert.equal(accepted,1);state={...state,matches:{status:'ready',data:{candidates:[b]}}};owner.update(props());assert.equal(first.isConnected,false);assert.equal(candidates()[0],second);owner.dispose();assert.equal(second.isConnected,false);
});
test('N1 unavailable playback renders one specific provider notice without generic duplicate',async()=>{
 const {mountPlaylistPlaybackControls}=await import('../../../music_app/static/js/playlists/native-integrations.mjs'),h=fixture(),controller={getSnapshot:()=>state,loadPlayback(){},playbackIntent(){}},state={scopeKey:'s',detail:{playlist_id:'p',track_rows:[]},playback:{status:'unavailable'},playbackMutation:{status:'idle'},available:{}};
 const owner=mountPlaylistPlaybackControls(h.host,h.runtime,{controller,state});const statuses=[...h.host.querySelectorAll('[role="status"]')].filter(node=>h.visible(node));assert.equal(statuses.filter(node=>node.textContent.includes('no authorized queue provider')).length,1);assert.equal(statuses.filter(node=>node.textContent.includes('not available on this server')).length,0);owner.update({controller,state:{...state}});assert.equal([...h.host.querySelectorAll('[role="status"]')].filter(node=>h.visible(node)&&node.textContent.includes('no authorized queue provider')).length,1);owner.dispose();
});

for (const kind of ['playback', 'match']) {
  test(`${kind} integration constructor releases successful controls after a later renderer throws`, async () => {
    const {mountPlaylistPlaybackControls, mountPlaylistMatchReview} = await import('../../../music_app/static/js/playlists/native-integrations.mjs');
    const h = fixture(), baseline = h.listeners().length, original = h.runtime.buttonHtml;
    let calls = 0;
    h.runtime.buttonHtml = value => {
      if (++calls === 3) throw new Error('late integration control failure');
      return original(value);
    };
    const state = {
      scopeKey: 's', detail: {playlist_id: 'p', track_rows: [{
        playlist_item_id: 'one', source_readable: true, availability: 'missing', title: 'Original'
      }]}, selectedItemId: 'one', matches: {status: 'ready', data: {candidates: [
        {candidate_ref: 'a', title: 'A'}, {candidate_ref: 'b', title: 'B'}
      ]}}, matchMutation: {status: 'idle'}, playback: {status: 'unavailable'},
      playbackMutation: {status: 'idle'}, available: {}
    };
    const mount = kind === 'playback' ? mountPlaylistPlaybackControls : mountPlaylistMatchReview;
    assert.throws(() => mount(h.host, h.runtime, {state, controller: {}}), /late integration control failure/);
    assert.equal(h.listeners().length, baseline);
    assert.equal(h.host.childNodes.length, 0);
  });
}
