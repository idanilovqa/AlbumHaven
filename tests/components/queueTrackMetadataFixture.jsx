// Isolated component boundary: real React, QueuePanel and shared native owners.
// This API supplies public DTOs only; it is not a server or full-app fixture.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {QueueHeader, QueuePanel} from '../../music_app/static/js/home-friends/queue.jsx';

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
let scopeKey = 'own-session', setView;
const calls = {love: [], plays: [], reorders: [], retimes: [], removes: [], clears: [], selection: [], choices: [], refresh: [], confirms: []};
const publish = () => flushSync(() => {setView?.(old => old + 1); for (const listener of listeners) listener();});
const publishPreferences = () => flushSync(() => {for (const listener of preferenceListeners) listener();});
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
const root = createRoot(document.getElementById('fixture'));
function Fixture() {
  const [, update] = useState(0); setView = update;
  const [selectedIds, setSelectedIds] = useState([]);
  return <><QueueHeader runtime={runtime} api={api} value={value}/>
    <QueuePanel runtime={runtime} api={api} value={value} scopeKey={scopeKey} selectedIds={selectedIds}
      onSelect={ids => {calls.selection.push(ids); setSelectedIds(ids);}}/></>;
}
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
  unmount() {flushSync(() => root.unmount());},
  preferenceSubscribers: () => preferenceListeners.size,
};
flushSync(() => root.render(<Fixture/>));
