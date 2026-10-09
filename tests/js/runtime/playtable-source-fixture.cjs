const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Consumer tests use the production private source adapter. Only the native
// account/library scope and authorized provider records are supplied fixtures.
function createSourceFactory(created = []) {
  const scope = {token: {}, actor: 'fixture-actor', library: 'fixture-library'};
  const context = vm.createContext({window: {addEventListener() {}, removeEventListener() {}},
    TrackActionsRuntime: {scope: () => scope}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/playtable-source.js'), 'utf8'), context);
  return ({rows, context: sourceContext, instance, revision, isCurrent}) => {
    const source = context.createPrivatePlaytableSource({scopeKey: sourceContext.scopeKey, rows, instance, revision, isCurrent,
      resolveRow: row => ({source_readable: true, track_ref: `fixture-private:${row.row_key || row.id}`})});
    created.push(source); return source;
  };
}
module.exports = {createSourceFactory};
