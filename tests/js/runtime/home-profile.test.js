const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {File} = require('node:buffer');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
const output = path.join(repo, 'tests/js/runtime/home-profile-fixture.cjs');
// Source-only SSR and lifecycle fixtures. No upload, browser, or API is mocked.
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/home-friends/profile.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react']});
const Module = require('node:module');
const loaded = new Module(output, module);
loaded.filename = output; loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, output);
const {ProfileIdentity, ProfileEditor, createAvatarDraft} = loaded.exports;
const native = createNativeHomeRuntime();
vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime/album-artbox.js'), 'utf8'), native.context);
const runtime = {
  buttonHtml: config => native.context.ButtonComponent.renderButton(config),
  actionHtml: config => native.context.ButtonComponent.renderActionButton(config),
  alertHtml: config => native.context.buildOnPageAlertHtml(config),
  artboxHtml: config => native.context.buildAlbumArtboxHtml(config),
};
const profile = {display_name: 'Alex <safe>', handle: 'alex', bio: 'My listening', avatar_url: '/avatars/alex.webp',
  allowed_actions: {can_edit: true, can_upload_avatar: true}};
const snapshot = {scopeKey: 'self', mutation: {status: 'idle'}, friends: {status: 'ready', data: {profile}}};
const controller = {getSnapshot: () => snapshot, subscribe: () => () => {}};
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, {runtime, ...props}));
const pngBytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0];
const file = (bytes = pngBytes, type = 'image/png') => new File([new Uint8Array(bytes)], 'avatar.png', {type});

function avatarFixture() {
  const readers = [], created = [], revoked = [], changes = [];
  const draft = createAvatarDraft(value => changes.push(value), {
    createReader() {
      const reader = {readyState: 0, aborted: false, readAsArrayBuffer(value) { this.value = value; this.readyState = 1; },
        abort() { this.aborted = true; this.readyState = 2; this.onabort?.(); },
        complete(bytes = pngBytes) { this.result = new Uint8Array(bytes).buffer; this.readyState = 2; this.onload?.(); }};
      readers.push(reader); return reader;
    },
    createObjectURL(value) { created.push(value); return `blob:owned-${created.length}`; },
    revokeObjectURL(url) { revoked.push(url); },
  });
  return {draft, readers, created, revoked, changes};
}

test('identity renders truthful server values and own edit grant with native artwork', () => {
  const html = render(ProfileIdentity, {profile, own: true, onEdit() {}});
  assert.match(html, /Alex &lt;safe&gt;/); assert.match(html, /@alex/); assert.match(html, /My listening/);
  assert.match(html, /src="\/avatars\/alex.webp"/); assert.match(html, /Edit profile/);
  assert.doesNotMatch(html, /<safe>|mountain|forest|data-track-path/);
});

test('friend identity is read-only even with an irrelevant edit grant', () => {
  const html = render(ProfileIdentity, {profile: {...profile, relationship: 'accepted'}, own: false, heading: 'h2', onEdit() {}});
  assert.match(html, /<h2>/); assert.match(html, />Friend</);
  assert.doesNotMatch(html, /Edit profile|type="file"/);
});

test('identity artwork and name remain top-aligned, including the native empty avatar', () => {
  const css = fs.readFileSync(path.join(repo, 'music_app/static/css/runtime/home-profile.css'), 'utf8');
  assert.match(css, /\.home-profile__identity\s*\{[^}]*align-items:\s*flex-start/);
  const html = render(ProfileIdentity, {profile: {...profile, avatar_url: null}});
  assert.match(html, /home-profile__identity/); assert.match(html, /album-artbox--empty/); assert.match(html, /<h1>Alex/);
});

test('missing and unsafe avatars use native empty artwork without an enabled view action', () => {
  for (const avatar_url of [null, '', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'blob:foreign', '//third.example/photo', 'file:///tmp/avatar']) {
    const html = render(ProfileIdentity, {profile: {...profile, avatar_url}});
    assert.match(html, /album-artbox--empty/); assert.match(html, /No profile image for Alex/);
    assert.doesNotMatch(html, /<img|View .*avatar/);
  }
});

test('profile editor uses an explicit save boundary and local-only image preview notice', () => {
  const html = render(ProfileEditor, {profile, controller, onClose() {}});
  assert.match(html, /aria-label="Edit profile"/); assert.match(html, /Save profile/); assert.match(html, />Cancel</);
  assert.match(html, /type="file"/); assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(html, /until you save/); assert.match(html, /5 MiB/); assert.match(html, /Edit name:/);
  assert.doesNotMatch(html, /presets|localStorage|uploaded successfully/);
});

test('missing upload or edit grants do not expose a file picker', () => {
  for (const allowed_actions of [{can_edit: true}, {can_upload_avatar: true}, {can_edit: 'true', can_upload_avatar: true}]) {
    const own = {...profile, allowed_actions}, ownSnapshot = {...snapshot, friends: {status: 'ready', data: {profile: own}}};
    const html = render(ProfileEditor, {profile: own, controller: {...controller,
      getSnapshot: () => ownSnapshot}, onClose() {}});
    assert.doesNotMatch(html, /type="file"|Choose image/);
  }
});

test('avatar selection stays local and creates a preview only after signature validation', () => {
  const f = avatarFixture(), value = file();
  f.draft.select(value); assert.equal(f.changes.at(-1).status, 'loading'); assert.equal(f.created.length, 0);
  assert.equal(f.readers[0].value.size, 12);
  f.readers[0].complete();
  assert.equal(f.changes.at(-1).file, value); assert.equal(f.changes.at(-1).url, 'blob:owned-1');
  assert.equal(f.changes.at(-1).status, 'ready');
  f.draft.dispose(); assert.deepEqual(f.revoked, ['blob:owned-1']);
});

test('replacement aborts stale reads and ignores a late load even if the reader ignores abort', () => {
  const f = avatarFixture();
  f.draft.select(file()); const oldLoad = f.readers[0].onload;
  f.draft.select(file()); assert.equal(f.readers[0].aborted, true);
  f.readers[0].result = new Uint8Array(pngBytes).buffer; oldLoad(); assert.equal(f.created.length, 0);
  f.readers[1].complete(); assert.equal(f.created.length, 1);
  f.draft.select(file()); assert.deepEqual(f.revoked, ['blob:owned-1']);
  f.readers[2].complete(); f.draft.clear(); assert.deepEqual(f.revoked, ['blob:owned-1', 'blob:owned-2']);
  assert.equal(f.changes.at(-1).file, null); assert.equal(f.changes.at(-1).url, '');
});

test('cancel and disposal revoke owned URLs once and make stale reads inert', () => {
  const f = avatarFixture();
  f.draft.select(file()); f.readers[0].complete(); f.draft.clear(); f.draft.clear();
  assert.deepEqual(f.revoked, ['blob:owned-1']);
  f.draft.select(file()); const lateLoad = f.readers[1].onload;
  f.draft.dispose(); assert.equal(f.readers[1].aborted, true);
  const count = f.changes.length; f.readers[1].result = new Uint8Array(pngBytes).buffer; lateLoad();
  f.draft.select(file()); f.draft.dispose(); assert.equal(f.changes.length, count); assert.equal(f.created.length, 1);
});

test('unsupported, empty, oversized and misleading files never obtain a preview URL', () => {
  const f = avatarFixture();
  for (const value of [null, {type: 'image/png', size: 12, name: 'fake'}, file([], 'image/png'), file(pngBytes, 'image/svg+xml'),
    new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', {type: 'image/png'})]) {
    f.draft.select(value); assert.equal(f.changes.at(-1).status, 'error');
  }
  assert.equal(f.readers.length, 0);
  f.draft.select(file(pngBytes, 'image/jpeg')); f.readers[0].complete();
  assert.equal(f.changes.at(-1).status, 'error'); assert.equal(f.created.length, 0);
});

test('JPEG and WebP headers are accepted while errors clear pending reads safely', () => {
  for (const [bytes, type] of [[[255, 216, 255, 224], 'image/jpeg'],
    [[82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80], 'image/webp']]) {
    const f = avatarFixture(); f.draft.select(file(bytes, type)); f.readers[0].complete(bytes);
    assert.equal(f.changes.at(-1).status, 'ready'); f.draft.dispose();
  }
  const f = avatarFixture(); f.draft.select(file()); f.readers[0].onerror();
  assert.equal(f.changes.at(-1).status, 'error'); assert.equal(f.created.length, 0); f.draft.dispose();
});

test('a stale image decode error cannot discard a newer image draft', () => {
  const f = avatarFixture();
  f.draft.select(file()); f.readers[0].complete();
  f.draft.select(file()); f.readers[1].complete();
  const latest = f.changes.at(-1), count = f.changes.length;
  f.draft.rejectPreview('blob:owned-1', 'Old image failed');
  assert.equal(f.changes.length, count); assert.equal(f.changes.at(-1), latest);
  f.draft.rejectPreview('blob:owned-2', 'This image could not be displayed.');
  assert.equal(f.changes.at(-1).status, 'error'); assert.equal(f.changes.at(-1).file, null);
  assert.deepEqual(f.revoked, ['blob:owned-1', 'blob:owned-2']);
});
