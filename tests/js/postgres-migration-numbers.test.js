const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Owner rule (2026-11-10, AGENTS.md): migrations may be applied out of order, but no two share a number.
test('every Postgres migration has its own number', () => {
  const directory = path.join(__dirname, '..', '..', 'migrations', 'postgres');
  const names = fs.readdirSync(directory).filter((name) => name.endsWith('.sql'));
  const byNumber = new Map();
  for (const name of names) {
    assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/, `${name} must be NNNN_name.sql`);
    const number = name.slice(0, 4);
    byNumber.set(number, [...(byNumber.get(number) || []), name]);
  }
  const duplicates = [...byNumber.values()].filter((files) => files.length > 1);
  assert.deepEqual(duplicates, [], 'renumber the newer migration so each number is used once');
});
