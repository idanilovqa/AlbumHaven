// Plain ES module retained at the historical fixture path; no JSX parser.
import {mountQueueHeader, mountQueuePanel} from '/music_app/static/js/home-friends/queue.mjs';

const listeners = new Set(), preferenceListeners = new Set(), pending = [];
const identities = new Map([['one', 'opaque:shared'], ['two', 'opaque:shared'], ['other', 'opaque:other'], ['missing', 'opaque:missing']]);
const preference = (identity, love_tier = 'off') => ({identity, love_tier, rating: null, allowed_actions: {can_set_love_tier: true}});
const preferences = new Map([...identities.values()].map(identity => [identity, preference(identity)]));
let value = {enabled: true, revision: 1, entries: [
  {id: 'one', title: 'Same title', artist: 'Artist', album: 'Album A', duration_seconds: 125, timing: 'next', sourceReadable: true, canPlay: true, ready: true, availability: 'local', current: true},
  {id: 'two', title: 'Same title', artist: 'Artist', album: 'Album A', duration_seconds: 125, timing: 'next', sourceReadable: true, canPlay: true, ready: true, availability: 'local'},
  {id: 'other', title: 'Same title', artist: 'Another artist', album: 'Album B', duration_seconds: 0, timing: 'next', sourceReadable: true, canPlay: true, ready: true, availability: 'local'},
  {id: 'missing', title: 'Readable missing', artist: 'Artist', album: 'Known album', duration_seconds: null, timing: 'next', sourceReadable: true, canPlay: false, ready: false, availability: 'missing'},
]};
let scopeKey = 'own-session', disposed = false, selectedIds = [], header, panel;
const calls = {love: [], plays: [], reorders: [], retimes: [], removes: [], clears: [], selection: [], choices: [], refresh: [], confirms: []};
const publish = () => {render(); for (const listener of listeners) listener();};
const publishPreferences = () => {for (const listener of preferenceListeners) listener();};
const api = {
  getSnapshot: () => value,
  subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
  subscribeTrackPreferences(listener) {preferenceListeners.add(listener); return () => preferenceListeners.delete(listener);},
  trackPreference(row) {
    const current = value.entries.find(entry => entry.id === row.id);
    return current?.sourceReadable === true ? preferences.get(identities.get(row.id)) || null : null;
  },
  setTrackLove(request) {
    calls.love.push(request);
    return new Promise((resolve, reject) => pending.push({resolve, reject, request}));
  },
  refresh(options) {calls.refresh.push(options); return Promise.resolve();},
  timingOptions: () => [{value: 'next', label: 'Next', enabled: true}, {value: 'later', label: 'Later', enabled: true}],
  play: (id, options) => {calls.plays.push({id, options}); return Promise.resolve();},
  reorder: ids => calls.reorders.push(ids), retime: (id, timing) => calls.retimes.push([id, timing]),
  remove: id => calls.removes.push(id), clear: ids => calls.clears.push(ids), setEnabled: enabled => {value = {...value, enabled}; publish();},
};
const runtime = {
  escapeHtml: window.escapeHtml, tableHtml: window.buildCompactDataTable,
  buttonHtml: config => window.ButtonComponent.renderButton(config),
  actionHtml: config => window.ButtonComponent.renderActionButton(config),
  iconHtml: (name, options) => window.ButtonComponent.renderIconSvg(name, options),
  snapshot: () => ({scopeKey}),
  confirm: message => {calls.confirms.push(message); return Promise.resolve(true);},
  openChoice(anchor, config) {
    const entry = {anchor, config, closed: false}; calls.choices.push(entry);
    return {close: () => {entry.closed = true;}, isOpen: true};
  },
};
const root = document.getElementById('fixture'), headerHost = document.createElement('div'), panelHost = document.createElement('div');
root.append(headerHost, panelHost);
function panelProps() {return {api, value, scopeKey, selectedIds, onSelect: ids => {calls.selection.push(ids); selectedIds = ids; render();}};}
function render() {if (disposed) return; header?.update({api, value}); panel?.update(panelProps());}
function unmount() {if (disposed) return; disposed = true; try {panel?.dispose();} finally {try {header?.dispose();} finally {root.replaceChildren();}}}
window.queueFixture = {
  calls, api,
  acknowledge(index, tier) {
    const operation = pending[index], identity = identities.get(operation.request.row.id);
    const result = preference(identity, tier);
    if (!operation.request.signal.aborted) {
      preferences.set(identity, result);
      value = {...value, entries: value.entries.map(row => ({...row}))};
      publish(); publishPreferences();
    }
    operation.resolve(result);
  },
  reject(index) {pending[index].reject(new Error('Late component-boundary rejection'));},
  repaint() {value = {...value, entries: value.entries.map(row => ({...row}))}; publish();},
  patch(id, patch) {value = {...value, entries: value.entries.map(row => row.id === id ? {...row, ...patch} : row)}; publish(); publishPreferences();},
  revoke(id) {preferences.delete(identities.get(id)); publishPreferences();},
  changeScope() {scopeKey = 'replacement-session'; publish();},
  unmount,
  preferenceSubscribers: () => preferenceListeners.size,
};
try {header = mountQueueHeader(headerHost, runtime, {api, value}); panel = mountQueuePanel(panelHost, runtime, panelProps());} catch (error) {unmount(); throw error;}
