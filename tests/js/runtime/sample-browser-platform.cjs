'use strict';
// Sample-only browser/data support. Shared published platform helpers and every
// production owner remain unchanged. These ports do not make admission decisions.
const assert = require('node:assert/strict');

function installMouseEventDetail(c) {
  const Event = c.MouseEvent;
  c.MouseEvent = class MouseEvent extends Event {
    constructor(type, options = {}) {
      super(type, options);
      // UIEventInit.detail is a WebIDL long, whose default is zero.
      const detail = Number(options.detail ?? 0);
      Object.defineProperty(this, 'detail', {enumerable: true, value: Number.isFinite(detail) ? detail >> 0 : 0});
    }
  };
}

function installCommentPlatform(c, document) {
  const before = c.Element.prototype.before, replaceWith = c.Element.prototype.replaceWith;
  assert.equal(typeof before, 'function'); assert.equal(typeof replaceWith, 'function');
  class Comment extends c.Node {
    constructor(data = '') {super(8); this.data = data;}
    get data() {return this._data;}
    set data(value) {this._data = String(value);}
    get nodeName() {return '#comment';}
    get nodeValue() {return this.data;}
    set nodeValue(value) {this.data = value ?? '';}
    get textContent() {return this.data;}
    set textContent(value) {this.data = value ?? '';}
    get length() {return this.data.length;}
    get outerHTML() {return `<!--${this.data}-->`;}
    cloneNode() {return new Comment(this.data);}
    // The existing bounded implementations use generic ChildNode operations.
    // Forward with this Comment receiver, preserving exact node movement.
    before(...values) {return before.apply(this, values);}
    replaceWith(...values) {return replaceWith.apply(this, values);}
  }
  c.Comment = Comment; c.Node.COMMENT_NODE = 8;
  document.createComment = data => new Comment(String(data));
  // A container's textContent excludes Comment descendants; Comment's own
  // textContent still exposes CharacterData. Preserve the existing setter.
  const text = Object.getOwnPropertyDescriptor(c.Node.prototype, 'textContent');
  assert.equal(typeof text.get, 'function'); assert.equal(typeof text.set, 'function');
  Object.defineProperty(c.Node.prototype, 'textContent', {...text,
    get() {return this.childNodes.filter(node => node.nodeType !== 8).map(node => node.textContent).join('');}});
}

function installSampleModalSelectors(c) {
  // The actual modal lookup uses #track-modal > .track-modal-dialog >
  // .track-modal-header. Preserve existing grammar and reject unsupported
  // direct-child operands instead of silently broadening them to descendants.
  const query = c.Element.prototype.querySelectorAll;
  c.Element.prototype.querySelectorAll = function (selector) {
    if (!selector.includes('>')) return query.call(this, selector);
    const parts = selector.split('>').map(part => part.trim());
    assert.ok(parts.every(part => /^[#.][\w-]+$/.test(part)), 'bounded direct-child selector grammar');
    let nodes = query.call(this, parts[0]);
    for (const part of parts.slice(1)) nodes = nodes.flatMap(parent => [...parent.children].filter(child => child.matches(part)));
    return nodes;
  };
}

function installSampleStateDefaults(state) {
  // Exact empty data shapes from runtime/core-state-and-helpers.js:12-15,
  // 344-378. Do not replace the state object captured by actual owners.
  if (!Object.hasOwn(state, 'coverRefreshTokens')) state.coverRefreshTokens = {};
  if (!Object.hasOwn(state, 'coverFailures')) state.coverFailures = {localDisplayPaths: {}};
  if (!Object.hasOwn(state, 'coverLookup')) state.coverLookup = {
    drawerOpen: false, tasks: [], pollingTimer: 0, selectionTimer: 0,
    taskOpenSelectionGesture: null, suppressOpenTaskId: '', optimisticAlbumCovers: {},
    tasksSnapshot: '', appliedTaskUpdateSignatures: {},
    modal: {
      album: null, taskId: '', remoteCover: null, localCovers: [], pastedImages: [],
      manualImageAttachments: [], otherArt: [], pendingLocalPath: '', pendingPastedImageId: '',
      selectedRemoteId: '', possibleMatches: [], candidateSnapshot: null, candidateGeneration: '',
      activeLocalSelectionPath: '', remoteSelectionOverrideGeneration: '', seenCandidateImprovementToken: '',
      statusText: '', statusTone: 'neutral', loading: false, pendingDeletePath: '',
      manualUrlText: '', manualBusy: false,
    },
  };
  return state;
}

module.exports = {installMouseEventDetail, installCommentPlatform, installSampleModalSelectors, installSampleStateDefaults};
