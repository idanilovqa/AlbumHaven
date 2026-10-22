'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load, settle} = require('./home-friends-native-app-fixture.cjs');

test('controlled Activity clearing and restoring native row IDs never republishes programmatic selection as intent', async t => {
  const h = fixture(t), {mountActivityPanel} = await load('activity.mjs'), publications = [];
  const row = {id: 'a', kind: 'track', title: 'Track a', artist: 'Artist', album_title: 'Album',
    availability: 'local', source_readable: true, listen_count: 1, duration_seconds: 123, rating: 4,
    taste_state: 'available', love_tier: 'off', allowed_actions: {can_view_details: false}};
  let owner, props = {scopeKey: 'scope:one', kind: 'tracks', view: 'rows',
    value: {status: 'ready', data: {rows: [row]}}, selectedTrackIds: ['a'],
    onTracksSelect(ids, options) {
      publications.push({ids: [...ids], inspect: options?.inspect === true});
      props = {...props, selectedTrackIds: [...ids]}; owner.update(props);
    }};
  owner = h.own(mountActivityPanel(h.host, h.runtime, props));
  const selected = () => h.host.querySelectorAll('[data-home-activity-row][aria-selected="true"]').map(element => element.dataset.homeActivityRow);
  assert.deepEqual(selected(), ['a']); assert.deepEqual(publications, []);
  props = {...props, selectedTrackIds: []}; owner.update(props); await settle();
  assert.deepEqual(selected(), []); assert.deepEqual(publications, [], 'clearing authority cannot replay the retained old native selection');
  owner.update({...props}); await settle();
  assert.deepEqual(selected(), []); assert.deepEqual(publications, []);
  props = {...props, selectedTrackIds: ['a']}; owner.update(props); await settle();
  assert.deepEqual(selected(), ['a']); assert.deepEqual(publications, [], 'controlled restoration is also not a user activation');
  props = {...props, selectedTrackIds: []}; owner.update(props);
  const trigger = h.host.querySelector('[data-home-activity-row="a"]'); assert.ok(trigger);
  h.click(trigger); await settle();
  assert.deepEqual(selected(), ['a']); assert.ok(publications.length > 0, 'a deliberate real native click remains usable');
  assert.ok(publications.every(value => value.ids.length === 1 && value.ids[0] === 'a'));
  owner.dispose(); const count = publications.length; h.click(trigger); owner.update(props); await settle();
  assert.equal(publications.length, count); assert.equal(h.host.childNodes.length, 0);
});

test('native fixture gallery view icons come from the production gallery renderer', t => {
  const h = fixture(t), gallery = h.document.createElement('div');
  gallery.innerHTML = h.c.buildGalleryBarHtml({});
  for (const mode of ['list', 'cards', 'covers']) {
    const expected = gallery.querySelector(`[data-gallery-view-choice="${mode}"] svg`); assert.ok(expected);
    assert.equal(h.runtime.viewIconHtml(mode), expected.outerHTML);
  }
  assert.equal(h.runtime.viewIconHtml('unsupported'), '');
});

test('additive scrollIntoView support records and bounds nearest vertical scrolling without changing focus', t => {
  const h = fixture(t), container = h.document.createElement('div'), target = h.document.createElement('button');
  h.host.append(container); container.append(target); container.scrollTop = 0;
  Object.defineProperties(container, {clientHeight: {value: 100, configurable: true}, scrollHeight: {value: 300, configurable: true}});
  h.setRect(container, {x: 0, y: 0, width: 100, height: 100});
  h.setRect(target, {x: 0, y: 180, width: 20, height: 20});
  const focused = h.document.activeElement; target.scrollIntoView({block: 'nearest'});
  assert.equal(container.scrollTop, 100); assert.equal(h.document.activeElement, focused);
  assert.equal(h.scrollCalls.length, 1); assert.equal(h.scrollCalls[0].target, target);
  assert.deepEqual(h.scrollCalls[0].options, {block: 'nearest'});
  h.setRect(target, {x: 0, y: 1000, width: 20, height: 20}); target.scrollIntoView({block: 'nearest'});
  assert.equal(container.scrollTop, 200, 'scrolling is clamped to the available range');
});
