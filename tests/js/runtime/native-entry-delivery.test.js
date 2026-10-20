const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repository = path.resolve(__dirname, '../../..');
const staticRoot = path.join(repository, 'music_app/static/js');
const entry = 'home-friends/index-native.mjs';
const template = () => fs.readFileSync(path.join(repository, 'music_app/templates/index.html'), 'utf8');

const {moduleImports} = require('./native-module-reader.cjs');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function moduleTarget(root, importer, specifier) {
  assert.match(specifier, /^\.\.?\//, 'Only relative native module imports are allowed');
  assert.ok(!/[\\?#%]/.test(specifier), 'Module specifiers must use plain relative paths');
  assert.equal(path.posix.extname(specifier), '.mjs', 'Native imports must target .mjs files');
  const target = path.resolve(path.dirname(importer), specifier);
  assert.ok(inside(root, target), 'Module import escapes static JS root');
  return target;
}

function closure(root, initial, read = filename => fs.readFileSync(filename, 'utf8'), canonical = filename => {
  assert.ok(fs.statSync(filename).isFile(), 'Module target must be a regular file');
  return fs.realpathSync(filename);
}) {
  const reached = new Set(), pending = [path.resolve(root, initial)];
  while (pending.length) {
    const filename = pending.pop();
    assert.ok(inside(root, filename), 'Module path escapes static JS root');
    const real = canonical(filename);
    assert.ok(inside(root, real), 'Module symlink escapes static JS root');
    assert.equal(path.extname(real), '.mjs', 'Native module target must remain .mjs');
    if (reached.has(filename)) continue;
    reached.add(filename);
    for (const dependency of moduleImports(read(filename))) pending.push(moduleTarget(root, filename, dependency));
  }
  return new Set([...reached].map(filename => path.relative(root, filename).split(path.sep).join('/')));
}

function scriptTags(html) {
  return [...html.matchAll(/<script\b([^>]*)>/gi)].map(match => {
    const attributes = new Map();
    for (const attribute of match[1].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = attribute[1].toLowerCase();
      assert.ok(!attributes.has(name), 'Duplicate script attribute: ' + name);
      attributes.set(name, attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    return {attributes, index: match.index};
  });
}

test('production template selects one versioned native module and no legacy bundle', () => {
  const scripts = scriptTags(template());
  const native = scripts.filter(script => script.attributes.get('src')?.includes('js/' + entry));
  assert.equal(native.length, 1);
  assert.equal(native[0].attributes.get('type'), 'module');
  assert.equal(native[0].attributes.has('async'), false);
  assert.match(native[0].attributes.get('src'), /url_for\(\s*'static'\s*,\s*filename\s*=\s*'js\/home-friends\/index-native\.mjs'\s*\)/);
  assert.match(native[0].attributes.get('src'), /\?v=\{\{\s*runtime_asset_version\s*\}\}$/);
  for (const script of scripts) assert.doesNotMatch(script.attributes.get('src') || '', /home-friends-bundle\.js|\.jsx(?:[?'"\s}]|$)/);
});

test('production template preserves classic runtime and bootstrap ordering', () => {
  const html = template(), scripts = scriptTags(html);
  function one(fragment) {
    const matches = scripts.filter(script => fragment.test(script.attributes.get('src') || ''));
    assert.equal(matches.length, 1, String(fragment));
    return matches[0];
  }
  const app = one(/filename\s*=\s*'app\.js'/), runtime = one(/js\/runtime-bundle\.js/), native = one(/js\/home-friends\/index-native\.mjs/);
  assert.ok(app.index < runtime.index && runtime.index < native.index);
  for (const script of [app, runtime]) {
    assert.ok(script.attributes.has('defer'));
    assert.equal(script.attributes.has('async'), false);
  }
  const condition = html.lastIndexOf('{% if bootstrap_payload %}', runtime.index);
  assert.ok(condition >= 0);
  assert.ok(html.indexOf('{% endif %}', condition) > runtime.index);
  assert.ok(html.indexOf('{% endif %}', condition) < native.index);
  const version = html.indexOf('window.__ALBUM_HAVEN_RUNTIME_ASSET_VERSION__');
  const payload = html.indexOf('window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__');
  assert.ok(version >= 0 && version < app.index);
  assert.ok(payload > native.index && payload < html.lastIndexOf('</body>'));
});

test('native production entry has a complete confined checked-in module closure', () => {
  const reached = closure(fs.realpathSync(staticRoot), entry);
  for (const required of [entry, 'home-friends/app.mjs', 'home-friends/friend-notifications-ui.mjs',
    'playlists/native.mjs', 'playlists/native-headers.mjs', 'playlists/native-library-mix.mjs',
    'playtables/native-selection.mjs', 'album-tops/index.mjs', 'home-friends/library-navigation.mjs']) {
    assert.ok(reached.has(required), 'Missing native surface owner: ' + required);
  }
});

test('dependency reader recognizes multiline, side-effect and re-export dependencies', () => {
  assert.deepEqual(moduleImports(`import Default, {a,
    b as c} from './a.mjs';
    import './b.mjs'; export {c as d} from './c.mjs';
    export * from './d.mjs'; export * as other from './e.mjs'; export {c};`),
  ['./a.mjs', './b.mjs', './c.mjs', './d.mjs', './e.mjs']);
});

test('dependency reader ignores inert text but catches template interpolation imports', () => {
  const inert = "// import './fake.mjs';\n/* export * from './fake.mjs'; */\n"
    + "const text = \"import('./fake.mjs')\"; const pattern = /import\\(['\"]/; const markup = `import('./fake.mjs')`;";
  assert.deepEqual(moduleImports(inert), []);
  assert.throws(() => moduleImports('const text = `${import("./hidden.mjs")}`;'), /Dynamic imports/);
});

test('dependency reader fails closed on unsupported imports', () => {
  for (const source of ['import("./a.mjs")', 'import.meta.url', 'import value;',
    'import data from "./a.mjs" with {type: "json"};', 'import "./a\\u002emjs";', 'require("react")']) {
    assert.throws(() => moduleImports(source));
  }
});

test('division after quoted operands or keyword-named properties cannot hide dynamic imports', () => {
  for (const operand of ['"return"', '"="', "'throw'", 'object.return', 'object.throw', 'object.case',
    'object?.return', 'object["return"]', '`return`']) {
    assert.throws(() => moduleImports(`const value = ${operand} / import("./hidden.mjs") / 2;`),
      /Dynamic imports/, operand);
  }
});

test('division after operands remains visible and ambiguous regexp contexts fail closed', () => {
  for (const operand of ['value', '2', 'items[0]', 'call()', '(value)', 'value++']) {
    assert.throws(() => moduleImports(`const result = ${operand} / import("react") / 2;`),
      /Dynamic imports/, operand);
  }
  assert.throws(() => moduleImports('if (ready) /import("./hidden.mjs")/.test(text);'), /Dynamic imports/);
  assert.deepEqual(moduleImports('function pattern() { return /import\\("inert"\\)/; }'), []);
  assert.deepEqual(moduleImports('const ratio = "return" / 2; const other = object.return / 3;'), []);
});

test('module targets reject bare dependencies, JSX, URLs and lexical escapes', () => {
  const root = path.resolve('native-delivery-fixture'), importer = path.join(root, 'entry.mjs');
  for (const specifier of ['react', 'react-dom/client', 'esbuild', './view.jsx', '/absolute.mjs',
    'https://example.test/a.mjs', '../outside.mjs', './a.mjs?v=1', './a%2emjs', '.\\a.mjs']) {
    assert.throws(() => moduleTarget(root, importer, specifier), specifier);
  }
  assert.equal(moduleTarget(root, importer, './child.mjs'), path.join(root, 'child.mjs'));
});

test('closure handles cycles and rejects missing files and symlink escapes', () => {
  const root = path.resolve('native-delivery-fixture');
  const files = new Map([[path.join(root, 'entry.mjs'), "import './child.mjs';"],
    [path.join(root, 'child.mjs'), "export * from './entry.mjs';"]]);
  const read = filename => {assert.ok(files.has(filename), 'Missing module'); return files.get(filename);};
  const identity = filename => filename;
  assert.deepEqual([...closure(root, 'entry.mjs', read, identity)].sort(), ['child.mjs', 'entry.mjs']);
  assert.throws(() => closure(root, 'missing.mjs', read, identity), /Missing module/);
  const missingChild = filename => filename.endsWith('entry.mjs') ? "import './missing.mjs';" : read(filename);
  assert.throws(() => closure(root, 'entry.mjs', missingChild, identity), /Missing module/);
  assert.throws(() => closure(root, 'entry.mjs', read, () => path.resolve(root, '../outside.mjs')), /symlink escapes/);
});


// First Artist host delivery. These checks extend the existing static delivery
// reader; they neither import the product entry nor invoke the build CLI.
test('Artist uses the actual confined native entry closure and no React alternative', () => {
  const reached = closure(fs.realpathSync(staticRoot), entry);
  assert.ok(reached.has('artist-page/native.mjs'));
  const imports = moduleImports(fs.readFileSync(path.join(staticRoot, entry), 'utf8'));
  assert.equal(imports.filter(value => value === '../artist-page/native.mjs').length, 1);
  assert.deepEqual(moduleImports(fs.readFileSync(path.join(staticRoot, 'artist-page/native.mjs'), 'utf8')),
    ['../home-friends/native-controls.mjs']);
  for (const name of reached) assert.doesNotMatch(name, /(?:react|bundle|\.jsx$)/i);
});

test('each exclusive served gallery branch contains exactly one root at the original viewport dock', () => {
  const html = template();
  const docks = [...html.matchAll(/<div\b[^>]*\bid="albums-scroll"[^>]*>\s*(<[^>]*\bid="artist-page-root"[^>]*>[\s\S]*?<\/[^>]+>)\s*<div\b[^>]*\bid="albums-viewport"/g)];
  assert.equal(docks.length, 2, 'both existing mutually exclusive startup/template branches');
  assert.equal((html.match(/\bid="albums-scroll"/g) || []).length, 2);
  assert.equal((html.match(/\bid="artist-page-root"/g) || []).length, 2);
  for (const dock of docks) assert.match(dock[1], /\bhidden\b/);
  const css = [...html.matchAll(/<link\b[^>]*href="([^"]*css\/runtime\/artist-page\.css[^"]*)"[^>]*>/g)];
  assert.equal(css.length, 1); assert.match(css[0][1], /\?v=\{\{\s*runtime_asset_version\s*\}\}$/);
  const mobileLayout = html.indexOf('css/mobile-layout.css');
  assert.ok(mobileLayout >= 0, 'actual mobile-layout predecessor exists');
  assert.ok(mobileLayout < css[0].index, 'scoped Artist CSS follows mobile layout');
  assert.equal((html.match(/data-artist-page-action-slot="loved"/g) || []).length, 1,
    'one action slot in the ordinary outer GalleryBar template');
});

test('Artist bridge follows actual dependencies and precedes bootstrap in the runtime manifest', () => {
  const source = fs.readFileSync(path.join(repository, 'scripts/build-runtime-bundle.cjs'), 'utf8');
  const match = source.match(/const RUNTIME_SCRIPT_PATHS\s*=\s*\[([\s\S]*?)\];/); assert.ok(match);
  const files = [...match[1].matchAll(/['"](js\/runtime\/[^'"]+\.js)['"]/g)].map(row => row[1]);
  const bridge = files.indexOf('js/runtime/artist-page-bridge.js'); assert.ok(bridge >= 0);
  assert.equal(files.filter(file => file === 'js/runtime/artist-page-bridge.js').length, 1);
  assert.equal(files[bridge - 1], 'js/runtime/search-results-runtime.js');
  for (const dependency of ['virtual-artist-grid', 'intrinsic-disclosure', 'mobile-navigation', 'response-state-helpers'])
    assert.ok(files.indexOf(`js/runtime/${dependency}.js`) < bridge && files.indexOf(`js/runtime/${dependency}.js`) >= 0);
  assert.ok(bridge < files.indexOf('js/runtime/bootstrap-event-handlers.js'));
  assert.ok(bridge < files.indexOf('js/runtime/bootstrap-init.js'));
});

test('root-provided generated runtime exactly matches composed sources', {
  skip: process.env.ARTIST_HOST_GENERATED_BUNDLE_GATE !== '1' ? 'Root has not opened the generated-output validation gate' : false,
}, () => {
  const {buildRuntimeBundle} = require(path.join(repository, 'scripts/build-runtime-bundle.cjs'));
  const delivered = fs.readFileSync(path.join(staticRoot, 'runtime-bundle.js'), 'utf8');
  assert.equal(delivered, buildRuntimeBundle(), 'read-only generator comparison; no build output is written');
});
