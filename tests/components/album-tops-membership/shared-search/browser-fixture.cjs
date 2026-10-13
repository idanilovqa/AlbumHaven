const fs=require('node:fs'),path=require('node:path');
const {buildSync}=require('esbuild');
const {ROOT:root}=require('../../../js/runtime/album-tops-membership-fixtures/top-builder-fixtures.cjs');
const scripts=['button-component.js','runtime/markup-format-helpers.js','runtime/loader-status-helpers.js','runtime/alert-components.js','runtime/album-artbox.js',
  'runtime/gallery-main-components.js','runtime/gallery-card-component.js','runtime/in-page-tabs.js','runtime/search-input.js','runtime/compact-data-table.js','runtime/album-track-table.js'];
const searchTemplate='<template id="native-search-field-template"><div class="search-input-wrap search-field"><div class="search-field-control ui-input-action"><input type="search" autocomplete="off"><span class="search-field-action"><button type="button" data-search-clear aria-label="Clear search" hidden>Clear</button><button type="button" data-search-submit>Search</button></span></div></div></template>';
let bundle;
async function mount(page,kind,options={}){
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  if(!bundle)bundle=buildSync({stdin:{contents:fs.readFileSync(path.join(__dirname,'fixture-entry.jsx'),'utf8'),resolveDir:root,loader:'jsx'},bundle:true,write:false,platform:'browser',format:'iife'}).outputFiles[0].text;
  await page.setContent('<!doctype html><html><body><button id="opener">Open Top builder</button><main id="mount"></main>'+searchTemplate+'</body></html>');
  for(const file of scripts)await page.addScriptTag({content:fs.readFileSync(path.join(root,'music_app/static/js',file),'utf8')});
  const template=fs.readFileSync(path.join(root,'music_app/templates/index.html'),'utf8');
  for(const file of new Set(['button-component.css',...[...template.matchAll(/css\/([a-zA-Z0-9_/-]+\.css)/g)].map(match=>match[1])]))await page.addStyleTag({content:fs.readFileSync(path.join(root,'music_app/static/css',file),'utf8')});
  await page.addStyleTag({content:'body{margin:0;overflow:auto;height:auto}#mount{width:100%;min-width:0}[role=dialog]{box-sizing:border-box;width:100%;padding:12px}'});
  await page.addScriptTag({content:bundle});await page.evaluate(({kind,options})=>startReviewFixture(kind,options),{kind,options});
  await page.locator('input').first().waitFor({state:'visible'});
  return {errors,search:page.getByRole('searchbox')};
}
module.exports={mount,root,scripts,searchTemplate};
