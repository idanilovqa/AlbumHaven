#!/usr/bin/env node
'use strict';

// Regenerates bounded-interaction-platform-names.json: every function name the
// browser platform defines (global functions, static and prototype methods of
// every global constructor and object, inherited ones included), read from a
// real Chromium rather than listed by hand. Discovery uses it to recognize a
// call that resolves to no application code as platform work.
//
//   node scripts/ci/bounded-interaction-platform-names.cjs --write

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const OUTPUT = path.join(__dirname, 'bounded-interaction-platform-names.json');

function collectPlatformNames() {
  const names = new Set();
  const seen = new Set();
  const visit = (start) => {
    for (let object = start; object && !seen.has(object); object = Object.getPrototypeOf(object)) {
      seen.add(object);
      for (const name of Object.getOwnPropertyNames(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, name);
        if (typeof descriptor?.value === 'function') names.add(name);
      }
    }
  };
  visit(globalThis);
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    let value;
    try { value = globalThis[name]; } catch { continue; }
    if (!value || value === globalThis || (typeof value !== 'function' && typeof value !== 'object')) continue;
    visit(value);
    if (typeof value === 'function' && value.prototype) visit(value.prototype);
  }
  return [...names].sort();
}

async function main() {
  if (!process.argv.includes('--write')) {
    process.stderr.write('usage: node scripts/ci/bounded-interaction-platform-names.cjs --write\n');
    return 2;
  }
  const { chromium } = require('playwright');
  // A localhost page is a secure context, so secure-only APIs are included.
  const server = http.createServer((request, response) => response.end('<!doctype html><title>platform</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.address().port}/`);
    const names = await page.evaluate(collectPlatformNames);
    fs.writeFileSync(OUTPUT, `${JSON.stringify({ source: `chromium ${browser.version()}`, names }, null, 2)}\n`);
    process.stdout.write(`wrote ${names.length} platform function names to ${path.relative(process.cwd(), OUTPUT)}\n`);
  } finally {
    await browser.close();
    server.close();
  }
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
