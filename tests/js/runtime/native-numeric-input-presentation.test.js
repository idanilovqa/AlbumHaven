'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const root=path.resolve(process.env.ALBUM_TOP_TEST_ROOT||path.join(__dirname,'../../..'));
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const digest=value=>createHash('sha256').update(value).digest('hex');
const compact=value=>value.replace(/[\t\n\v\f\r ]/g,'');

test('Tag Editor whole template changes only the shared class and keeps its original numeric/footer owner',()=>{
  const source=read('music_app/templates/partials/primary-modals.html'),tag=source.match(/<input\b[^>]*\bid="tag-editor-auto-number-start"[^>]*>/)?.[0];assert.ok(tag);
  for(const attribute of ['type="number"','min="1"','step="1"','inputmode="numeric"'])assert.ok(tag.includes(attribute),attribute);
  assert.match(tag,/class="ui-numeric-input"/);const restored=source.replace(tag,tag.replace(/\sclass="ui-numeric-input"/,''));
  assert.equal(digest(restored),'71e48e91476be1a15b6559b6db4fa2d83a4fc9f3f48aa17cde8de30fec2b209a');
});

test('shared numeric aliases retain all three exact legacy declaration bodies',()=>{
  const css=read('music_app/static/css/runtime/utilities.css'),rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match=>match[1].includes('.ui-numeric-input'));
  assert.equal(rules.length,3);const plain=rules.find(match=>match[1].split(',').some(value=>['.ui-numeric-input','input.ui-numeric-input'].includes(value.trim()))&&match[2].includes('width:'));
  const focus=rules.find(match=>match[1].includes('.ui-numeric-input:focus-visible')),motion=rules.find(match=>match[2].includes('scroll-behavior:'));
  assert.ok(plain);assert.ok(focus);assert.ok(motion);
  assert.ok(plain[1].includes('.tag-editor-auto-number-controls input'));assert.equal(compact(plain[2]),compact('width:64px;min-width:64px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,0.03);color:var(--text);padding:8px;text-align:center;'));
  assert.ok(focus[1].includes('.tag-editor-auto-number-controls input:focus-visible'));assert.ok(focus[1].includes('.tag-editor-auto-number-controls button:focus-visible'));assert.equal(compact(focus[2]),'outline:3pxsolid#8ac8ff;outline-offset:2px;');
  assert.ok(motion[1].includes('.tag-editor-actions'));assert.ok(motion[1].includes('.tag-editor-auto-number-controls button'));assert.equal(compact(motion[2]),'scroll-behavior:auto!important;transition:none!important;');
  assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.ui-numeric-input/);
});

test('removing only the new aliases recovers all original CSS declarations including mobile footer layout',()=>{
  const css=read('music_app/static/css/runtime/utilities.css');const restored=css
    .replace(/(?:input)?\.ui-numeric-input(?::focus-visible)?\s*,\s*/g,'')
    .replace(/,\s*(?:input)?\.ui-numeric-input(?::focus-visible)?(?=\s*\{)/g,'');
  assert.equal(digest(compact(restored)),'f344b1e56a8998674210c8d2ab8d3933e7f593408d16be56e7affd2daa6151b2');
});
