import { EventEmitter } from 'node:events';

// One passive protocol session owns commit and request loader attribution.
export class CDPDocumentEvents extends EventEmitter {
  constructor(page) {
    super();
    this.page = page;
    this.records = new Map();
    this.knownLoaders = new Set();
    this.loaderId = null;
    this.frameId = null;
    this.closed = false;
    this.observationError = null;
    this.closeListener = () => { void this.close().catch(error => { this.observationError = error; }); };
  }
  async initialize() {
    if (!this.initializing) this.initializing = this.start();
    return this.initializing;
  }
  async start() {
    this.session = await this.page.context().newCDPSession(this.page);
    this.session.on('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      this.frameId = frame.id;
      if (frame.loaderId === this.loaderId) return;
      this.loaderId = frame.loaderId;
      this.knownLoaders.add(frame.loaderId);
      this.emit('documentcommitted');
      for (const record of this.records.values()) {
        if (record.loaderId === this.loaderId && !record.dispatched) this.dispatch(record);
      }
    });
    this.session.on('Network.requestWillBeSent', event => this.requestStarted(event));
    this.session.on('Network.responseReceived', event => {
      const record = this.records.get(event.requestId);
      if (!record) return;
      record.response = event.response;
      this.queue(record, 'response', this.responseFor(record));
    });
    this.session.on('Network.loadingFinished', event => this.finish(event.requestId, null));
    this.session.on('Network.loadingFailed', event => this.finish(event.requestId, event.errorText || 'Network request failed'));
    this.page.once('close', this.closeListener);
    await this.session.send('Page.enable');
    await this.session.send('Network.enable');
    const { frameTree } = await this.session.send('Page.getFrameTree');
    if (!this.frameId) this.frameId = frameTree.frame.id;
    if (!this.loaderId) {
      this.loaderId = frameTree.frame.loaderId;
      this.knownLoaders.add(this.loaderId);
    }
  }
  requestStarted(event) {
    if (event.frameId !== this.frameId) return;
    const previous = this.records.get(event.requestId);
    if (previous && event.redirectResponse) {
      previous.response = event.redirectResponse;
      this.queue(previous, 'response', this.responseFor(previous));
      this.finish(event.requestId, null);
    }
    const url = new URL(event.request.url);
    if (!['/view-data', '/home-data'].includes(url.pathname)
      && !/^\/utilities\/save-task\/[^/]+$/u.test(url.pathname)) return;
    // Late events from a retired document never become new-document authority.
    if (event.loaderId !== this.loaderId && this.knownLoaders.has(event.loaderId)) return;
    let complete;
    const completion = new Promise(resolve => { complete = resolve; });
    const record = { id: event.requestId, loaderId: event.loaderId, url: event.request.url,
      method: event.request.method, events: [], dispatched: false, terminal: false,
      completion, complete, error: null, response: null };
    record.request = { url: () => record.url, method: () => record.method,
      resourceType: () => 'fetch', isNavigationRequest: () => false };
    this.records.set(event.requestId, record);
    record.events.push(['request', record.request]);
    if (record.loaderId === this.loaderId) this.dispatch(record);
  }
  dispatch(record) {
    record.dispatched = true;
    for (const [name, value] of record.events.splice(0)) this.emit(name, value);
    if (record.terminal && this.records.get(record.id) === record) this.records.delete(record.id);
  }
  queue(record, name, value) {
    if (record.dispatched) this.emit(name, value);
    else record.events.push([name, value]);
  }
  responseFor(record) {
    const response = record.response;
    return { request: () => record.request, status: () => response.status,
      ok: () => response.status >= 200 && response.status < 300,
      json: async () => {
        await record.completion;
        if (record.error) throw new Error(record.error);
        const body = await this.session.send('Network.getResponseBody', { requestId: record.id });
        return JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
      } };
  }
  finish(id, error) {
    const record = this.records.get(id);
    if (!record) return;
    record.error = error;
    record.terminal = true;
    record.complete();
    this.queue(record, error ? 'requestfailed' : 'requestfinished', record.request);
    if (record.dispatched) this.records.delete(id);
  }
  close() {
    if (!this.closing) this.closing = this.stop();
    return this.closing;
  }
  async stop() {
    this.closed = true;
    this.page.off('close', this.closeListener);
    for (const record of this.records.values()) {
      record.error = 'Observation closed'; record.complete();
    }
    this.records.clear();
    this.removeAllListeners();
    if (this.session) {
      try { await this.session.detach(); }
      catch (error) { if (!this.page.isClosed()) throw error; }
    }
  }
}
