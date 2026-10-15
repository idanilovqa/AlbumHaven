const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {appFixture,visible,settle}=require('./home-history-header-native-fixture.cjs');

const source = path.resolve(__dirname, '../../../music_app/static/js/home-friends');
const model = import(pathToFileURL(path.join(source, 'model.mjs')));
const presentation = import(pathToFileURL(path.join(source, 'history-presentation.mjs')));
const query = {account_ref: null, kind: 'listens', period: 'week'};
const row = id => ({id, kind: 'listen', title: 'Repeated track', artist: 'Artist'});
const progressive = (ids, next_cursor = null) => ({rows: ids.map(row), next_cursor});
function numbered(page = 1, total_rows = 243) {
  const start = (page - 1) * 100;
  return {rows: Array.from({length: Math.min(100, Math.max(0, total_rows - start))}, (_, i) => row(`event:${start + i}`)),
    next_cursor: null, pagination: {mode: 'numbered', page, page_size: 100, total_rows}};
}
const friends = () => ({friends: ['friend:one', 'friend:two'].map(account_ref => ({account_ref,
  relationship: 'accepted', allowed_actions: {can_view_activity: true, can_compare: true}})), requests: [], profile: null});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

// Only provider DTOs are faked. Requests, retirement, publication and ownership
// all pass through the production controller and presentation boundary.
async function setup(t, {accountRef = null, initial = numbered(), readComparison} = {}) {
  const {createHomeFriendsController} = await model;
  const h = {calls: [], requests: [], scrolls: 0, intents: 0};
  h.providers = {readFriends: friends, readComparison, readActivity: args => {
    h.calls.push(args);
    if (h.blockedPeriod?.period === args.period) return h.blockedPeriod.promise;
    if (!args.pagination && !args.cursor) return initial;
    const result = deferred(); h.requests.push({args, ...result}); return result.promise;
  }};
  h.controller = createHomeFriendsController({providers: h.providers});
  t.after(() => h.controller.dispose());
  h.controller.setScope('actor:one/library:one');
  if (accountRef) {await h.controller.loadFriends(); assert.equal(h.controller.selectFriend(accountRef), true);}
  await h.controller.loadActivity(query);
  const {navigateActivityHistory} = await presentation;
  h.navigate = options => {
    const snapshot = h.controller.getSnapshot();
    return navigateActivityHistory({controller: h.controller, snapshot, query: snapshot.activityNavigation.query,
      method: 'loadActivityPage', target: 2, isCurrent: () => true,
      onIntent: () => {h.intents += 1;}, onPageCommitted: () => {h.scrolls += 1;}, ...options});
  };
  return h;
}

test('ready and empty results are hidden for a new UI query before its loading effect runs', async t => {
  const {activityForQuery} = await presentation;
  for (const initial of [numbered(), numbered(1, 0)]) {
    const h = await setup(t, {initial}), snapshot = h.controller.getSnapshot();
    assert.equal(activityForQuery(snapshot, {...query}), snapshot.activity);
    for (const next of [{...query, kind: 'tracks'}, {...query, period: 'month'}, {...query, account_ref: 'friend:one'}]) {
      assert.deepEqual(activityForQuery(snapshot, next), {status: 'loading', data: null});
    }
    assert.equal(h.controller.getSnapshot(), snapshot);
    assert.equal(h.calls.length, 1, 'rendering a changed heading must not issue a provider request');
  }
});

test('nonready activity keeps its truthful loading, failure and access state', async () => {
  const {activityForQuery} = await presentation;
  for (const status of ['loading', 'error', 'denied', 'unavailable']) {
    const activity = {status, data: null};
    assert.equal(activityForQuery({activity, activityNavigation: {query}}, {...query, period: 'year'}), activity);
  }
});

test('history actions reject another kind, period or friend without touching the provider', async t => {
  const h = await setup(t);
  for (const method of ['loadActivityPage', 'loadMoreActivity', 'retryActivityNavigation']) {
    for (const next of [{...query, kind: 'tracks'}, {...query, period: 'month'}, {...query, account_ref: 'friend:one'}]) {
      assert.equal(await h.navigate({method, query: next}), false);
    }
  }
  assert.equal(h.calls.length, 1); assert.equal(h.intents, 0); assert.equal(h.scrolls, 0);
});

test('the history dispatch boundary is closed to unrelated controller methods', async t => {
  const h = await setup(t), snapshot = h.controller.getSnapshot();
  for (const method of ['loadActivity', 'loadComparison', 'selectFriend', 'setScope', 'configure', 'dispose', 'getSnapshot', 'missing']) {
    assert.equal(await h.navigate({method}), false);
  }
  assert.equal(h.controller.getSnapshot(), snapshot);
  assert.equal(h.calls.length, 1); assert.equal(h.intents, 0);
});

test('stale snapshots cannot navigate after kind, period, friend, actor or provider replacement', async t => {
  for (const change of ['kind', 'period', 'friend', 'actor', 'provider']) {
    await t.test(change, async t => {
      const h = await setup(t), snapshot = h.controller.getSnapshot();
      if (change === 'friend') {await h.controller.loadFriends(); h.controller.selectFriend('friend:one');}
      if (change === 'actor') h.controller.setScope('actor:two/library:one');
      if (change === 'provider') h.controller.configure({...h.providers, readActivity: () => numbered()});
      await h.controller.loadActivity({...query, ...(change === 'kind' ? {kind: 'tracks'} : {}),
        ...(change === 'period' ? {period: 'month'} : {})});
      const calls = h.calls.length;
      for (const method of ['loadActivityPage', 'loadMoreActivity', 'retryActivityNavigation']) {
        assert.equal(await h.navigate({snapshot, query, method}), false);
      }
      assert.equal(h.calls.length, calls); assert.equal(h.intents, 0); assert.equal(h.scrolls, 0);
    });
  }
});

test('synchronous onIntent retirement is checked again before dispatch', async t => {
  for (const change of ['UI route', 'scope', 'query', 'provider']) {
    await t.test(change, async t => {
      const h = await setup(t); let current = true, replacement;
      const result = await h.navigate({isCurrent: () => current, onIntent() {
        if (change === 'UI route') current = false;
        if (change === 'scope') h.controller.setScope('actor:two/library:one');
        if (change === 'query') replacement = h.controller.loadActivity({...query, period: 'month'});
        if (change === 'provider') h.controller.configure({...h.providers, readActivity: () => numbered()});
      }});
      await replacement;
      assert.equal(result, false); assert.equal(h.requests.length, 0); assert.equal(h.scrolls, 0);
    });
  }
});

test('a committed numbered page resets scroll once and inert page selections never reset it', async t => {
  const h = await setup(t), before = h.controller.getSnapshot();
  assert.equal(await h.navigate({target: 1}), false);
  assert.equal(h.scrolls, 0); assert.equal(h.requests.length, 0);
  const pending = h.navigate();
  assert.equal(h.controller.getSnapshot().activity, before.activity, 'old rows remain authoritative while loading');
  assert.equal(h.scrolls, 0);
  assert.equal(await h.navigate(), false, 'duplicate pending target is inert');
  await h.controller.loadRecent();
  h.requests[0].resolve(numbered(2));
  const result = await pending;
  assert.equal(result.status, 'ready'); assert.equal(h.scrolls, 1);
  assert.equal(h.controller.getSnapshot().activityNavigation.query, before.activityNavigation.query);
  assert.equal(await h.navigate(), false, 'reselecting the committed page is inert');
  assert.equal(h.requests.length, 1); assert.equal(h.scrolls, 1);
});

test('load more appends the exact cursor and preserves scroll on success and retry', async t => {
  const h = await setup(t, {initial: progressive(['event:one'], 'opaque:next')});
  const first = h.navigate({method: 'loadMoreActivity'});
  assert.equal(h.requests[0].args.cursor, 'opaque:next');
  assert.equal(await h.navigate({method: 'loadMoreActivity'}), false);
  h.requests[0].reject(new Error('temporary failure'));
  assert.equal((await first).status, 'error'); assert.equal(h.scrolls, 0);
  const retry = h.navigate({method: 'retryActivityNavigation'});
  assert.equal(h.requests[1].args.cursor, 'opaque:next');
  h.requests[1].resolve(progressive(['event:two']));
  assert.equal((await retry).status, 'ready');
  assert.deepEqual(h.controller.getSnapshot().activity.data.rows.map(value => value.id), ['event:one', 'event:two']);
  assert.equal(h.scrolls, 0);
  assert.equal(await h.navigate({method: 'loadMoreActivity'}), false); assert.equal(h.scrolls, 0);
});

test('a failed numbered page cannot scroll until its explicit retry commits', async t => {
  const h = await setup(t), pending = h.navigate();
  h.requests[0].reject(new Error('temporary failure'));
  assert.equal((await pending).status, 'error'); assert.equal(h.scrolls, 0);
  assert.equal(h.controller.getSnapshot().activityNavigation.page, 1);
  const retry = h.navigate({method: 'retryActivityNavigation'});
  assert.equal(h.requests[1].args.pagination.page, 2);
  h.requests[1].resolve(numbered(2));
  assert.equal((await retry).status, 'ready'); assert.equal(h.scrolls, 1);
  assert.equal(await h.navigate({method: 'retryActivityNavigation'}), false); assert.equal(h.scrolls, 1);
});

test('a completed request cannot reset scroll after the visible UI route changes', async t => {
  const h = await setup(t); let current = true;
  const pending = h.navigate({isCurrent: () => current}); current = false;
  h.requests[0].resolve(numbered(2)); await pending;
  assert.equal(h.controller.getSnapshot().activityNavigation.page, 2);
  assert.equal(h.scrolls, 0);
});

test('only the newest page request may scroll even when it returns to an older target', async t => {
  const h = await setup(t), oldPageTwo = h.navigate(), pageThree = h.navigate({target: 3}), newestPageTwo = h.navigate();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[0].args.signal.aborted, true); assert.equal(h.requests[1].args.signal.aborted, true);
  h.requests[2].resolve(numbered(2)); await newestPageTwo;
  assert.equal(h.scrolls, 1);
  h.requests[0].resolve(numbered(2)); assert.equal(await oldPageTwo, false);
  h.requests[1].reject(Object.assign(new Error('aborted'), {name: 'AbortError'})); assert.equal(await pageThree, false);
  assert.equal(h.controller.getSnapshot().activityNavigation.page, 2); assert.equal(h.scrolls, 1);
});

test('query, scope, friend and provider roundtrips cannot revive an old page scroll', async t => {
  for (const change of ['query', 'scope', 'friend', 'provider']) {
    await t.test(change, async t => {
      const h = await setup(t, {accountRef: change === 'friend' ? 'friend:one' : null});
      const originalQuery = h.controller.getSnapshot().activityNavigation.query, old = h.navigate();
      if (change === 'query') await h.controller.loadActivity({...query, period: 'month'});
      if (change === 'scope') {h.controller.setScope('actor:two/library:one'); h.controller.setScope('actor:one/library:one');}
      if (change === 'friend') {h.controller.selectFriend('friend:two'); h.controller.selectFriend('friend:one');}
      if (change === 'provider') {
        h.controller.configure({...h.providers, readActivity: () => numbered()}); h.controller.configure(h.providers);
      }
      await h.controller.loadActivity(query);
      assert.notEqual(h.controller.getSnapshot().activityNavigation.query, originalQuery);
      const newest = h.navigate(); h.requests[1].resolve(numbered(2)); await newest;
      assert.equal(h.scrolls, 1);
      h.requests[0].resolve(numbered(2)); assert.equal(await old, false);
      assert.equal(h.scrolls, 1); assert.equal(h.controller.getSnapshot().activityNavigation.page, 2);
    });
  }
});

test('denial, unavailability, disposal and synchronous subscriber retirement never scroll', async t => {
  for (const outcome of ['denied', 'unavailable', 'dispose', 'subscriber']) {
    await t.test(outcome, async t => {
      const h = await setup(t);
      if (outcome === 'subscriber') h.controller.subscribe(() => {
        if (h.controller.getSnapshot().activityNavigation.status === 'loading') h.controller.setScope('actor:two/library:one');
      });
      const pending = h.navigate();
      if (outcome === 'subscriber') assert.equal(h.requests.length, 0);
      else {
        if (outcome === 'dispose') h.controller.dispose();
        h.requests[0].resolve(outcome === 'dispose' ? numbered(2) : {status: outcome});
      }
      await pending; assert.equal(h.scrolls, 0);
      assert.equal(h.controller.getSnapshot().activityNavigation.query, null);
    });
  }
});

const shellPresentation={kind:'tracks',kindExplicit:true,views:{tracks:'history'},friendKind:'tracks',friendViews:{tracks:'history'}};

test('HomeFriendsView wires own and friend history through the guarded controller boundary',async t=>{
  for(const accountRef of [null,'friend:one'])await t.test(accountRef||'own',async t=>{
    const h=await setup(t,{accountRef}),friend=accountRef?h.controller.getSnapshot().friends.data.friends.find(p=>p.account_ref===accountRef):null;
    const app=await appFixture(t,{controller:h.controller,section:accountRef?'friends':'recent',friend,presentation:shellPresentation});
    const widget=app.host.querySelector(`[data-home-widget="${accountRef?'friends':'recent'}"]`);
    assert.ok(widget.querySelector('[data-home-activity-row]'),'actual activity panel has rows');
    let controls=[...widget.querySelectorAll('.home-history-navigation')].filter(visible);assert.equal(controls.length,1);assert.match(controls[0].textContent,/Page 1 of 3/);
    app.click(app.named('Next history page',widget));assert.equal(h.requests.length,1);assert.equal(h.requests[0].args.account_ref,accountRef);assert.equal(h.requests[0].args.kind,'listens');assert.equal(h.requests[0].args.period,'week');
    h.requests[0].resolve(numbered(2));await settle();assert.equal(h.controller.getSnapshot().activityNavigation.page,2);
    const retired=app.named('Next history page',widget);assert.ok(retired);
    // Hold the changed-period provider read so the synchronous native update can
    // be inspected before any replacement data returns.
    const pending=deferred();h.blockedPeriod={period:'month',promise:pending.promise};
    assert.equal(h.controller.getSnapshot().selectedFriendRef,accountRef);
    assert.equal(h.controller.getSnapshot().activityNavigation.page,2);
    app.choosePeriod('Last month',widget);
    assert.equal(widget.querySelector('[data-home-activity-row]'),null);assert.equal([...widget.querySelectorAll('.home-history-navigation')].filter(visible).length,0);
    assert.doesNotMatch(widget.textContent,/Repeated track|Items 101–200/,'new heading cannot retain private old rows even in hidden DOM');app.click(retired);assert.equal(h.requests.length,1);
    pending.resolve(numbered());await settle();
  });
});

test('comparison keeps its existing replacement cursor pager and never uses history navigation',async t=>{
  const calls=[],h=await setup(t,{accountRef:'friend:one',readComparison:args=>{calls.push(args);return progressive([args.cursor?'comparison:second':'comparison:first'],args.cursor?null:'comparison:next');}});
  await h.controller.loadComparison({kind:'tracks',period:'week'});
  const friend=h.controller.getSnapshot().friends.data.friends.find(p=>p.account_ref==='friend:one');
  const app=await appFixture(t,{controller:h.controller,section:'friends',friend,presentation:{...shellPresentation,friendMode:'comparison'}});
  assert.equal([...app.host.querySelectorAll('.home-history-navigation')].filter(visible).length,0);
  const before=calls.length,next=app.named('Next page');assert.ok(next);app.click(next);await settle();assert.equal(calls.length,before+1);assert.equal(calls.at(-1).cursor,'comparison:next');assert.equal(calls.at(-1).account_ref,'friend:one');assert.equal(calls.at(-1).pagination,undefined);
  assert.deepEqual(h.controller.getSnapshot().comparison.data.rows.map(value=>value.id),['comparison:second']);assert.equal(h.requests.length,0);
});
