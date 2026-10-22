const {expect} = require('@playwright/test');
const countsFor = count => ({galleryCardHtml: count, artboxHtml: count, rowButtonHtml: count * 2});
const delta = (after, before) => Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
const NONE = {galleryCardHtml: 0, artboxHtml: 0, rowButtonHtml: 0};
class Full5000NativePicker {
  constructor(page, expected, source) {
    this.page = page; this.expected = expected; this.source = source;
    this.indices = expected.map((_, index) => index);
    this.region = page.getByRole('region', {name: 'Choose albums', exact: true});
    this.search = this.region.getByRole('searchbox', {name: 'Search albums', exact: true});
    this.selected = this.region.getByRole('tab', {name: /^Selected \(/});
    this.announcement = this.region.locator('[role="status"][aria-live="polite"]');
    this.simulation = page.getByRole('navigation', {name: 'Explicit component-fixture simulations', exact: true});
  }
  move(title) {return this.region.getByRole('button', {name: `Reorder ${title}`, exact: true});}
  remove(title) {return this.region.getByRole('button', {name: `Remove ${title}`, exact: true});}
  read() {return this.page.evaluate(() => window.readFull5000NativeComponent());}
  async settle() {await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));}
  renderedRefs() {return this.region.locator('[data-album-draft-key]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-album-draft-key')));}
  async sameNode(locator, before) {expect(await locator.evaluate((node, original) => node === original, before)).toBe(true);}
  async remember(locator) {const handle = await locator.elementHandle(); expect(handle).not.toBeNull(); return handle;}
  unchangedSource(value) {expect(value.source).toEqual(this.source); expect(value.original).toEqual(this.source); expect(value.writes).toEqual([]);}
  async ready() {
    await expect(this.search).toBeEnabled();
    await expect(this.selected).toHaveText(`Selected (${this.expected.length})`);
    await expect(this.selected).toHaveAttribute('aria-selected', 'true');
    const value = await this.read();
    expect(value.counts).toEqual(countsFor(this.expected.length));
    expect(value.items).toEqual(this.expected);
    expect(value.rowIdentities).toEqual(this.indices);
    this.unchangedSource(value);
  }
  async queryPreservesNativeRows() {
    const before = await this.read(), input = await this.remember(this.search);
    const move = await this.remember(this.move('Retained 1')), remove = await this.remember(this.remove('Retained 1'));
    await this.search.fill('Needle'); await this.settle();
    const after = await this.read();
    expect(after.query).toBe('Needle'); expect(after.searchStatus).toBe('ready'); expect(after.tab).toBe('selected');
    expect(after.initialItemsSame).toBe(true); expect(after.items).toEqual(this.expected);
    await this.sameNode(this.search, input); await expect(this.search).toBeFocused();
    await this.sameNode(this.move('Retained 1'), move); await this.sameNode(this.remove('Retained 1'), remove);
    this.unchangedSource(after); expect(after.searches).toHaveLength(1);
    expect(delta(after.counts, before.counts)).toEqual(NONE);
  }
  async removePreservesSurvivors() {
    const before = await this.read(), remove = await this.remember(this.remove('Retained 2'));
    const move = await this.remember(this.move('Retained 2'));
    await this.remove('Retained 1').click(); await this.settle();
    const after = await this.read();
    expect(after.items).toEqual(this.expected.slice(1)); expect(after.rowIdentities).toEqual(this.indices.slice(1));
    await expect(this.remove('Retained 1')).toHaveCount(0);
    await this.sameNode(this.remove('Retained 2'), remove); await this.sameNode(this.move('Retained 2'), move);
    await expect(this.remove('Retained 2')).toBeFocused(); await expect(this.selected).toHaveText('Selected (23)');
    this.unchangedSource(after); expect(delta(after.counts, before.counts)).toEqual(NONE);
  }
  async endHomePreservesHandle() {
    const handle = await this.remember(this.move('Retained 1')), other = await this.remember(this.move('Retained 2'));
    const moved = [...this.expected.slice(1), this.expected[0]], order = moved.map(row => row.album_ref);
    await this.move('Retained 1').press('End'); await this.settle();
    let after = await this.read();
    expect(after.items.map(row => row.album_ref)).toEqual(order); expect(await this.renderedRefs()).toEqual(order);
    expect(after.items).toEqual(moved); expect(after.rowIdentities).toEqual([...this.indices.slice(1), 0]);
    await this.sameNode(this.move('Retained 1'), handle); await this.sameNode(this.move('Retained 2'), other);
    await expect(this.move('Retained 1')).toBeFocused(); await expect(this.announcement).toHaveText('Moved to position 24 of 24.');
    await this.move('Retained 1').press('Home'); await this.settle();
    after = await this.read();
    expect(after.items.map(row => row.album_ref)).toEqual(this.expected.map(row => row.album_ref));
    expect(await this.renderedRefs()).toEqual(this.expected.map(row => row.album_ref));
    expect(after.items).toEqual(this.expected); expect(after.rowIdentities).toEqual(this.indices);
    await this.sameNode(this.move('Retained 1'), handle); await this.sameNode(this.move('Retained 2'), other);
    await expect(this.move('Retained 1')).toBeFocused(); await expect(this.announcement).toHaveText('Moved to position 1 of 24.');
    expect(after.dirty).toBe(false); this.unchangedSource(after);
  }
  async controlsDisabled(disabled) {
    for (const control of [this.remove('Retained 1'), this.move('Retained 1')]) {
      if (disabled) {await expect(control).toBeDisabled(); await expect(control).toHaveAttribute('aria-disabled', 'true');}
      else {await expect(control).toBeEnabled(); expect(await control.getAttribute('aria-disabled')).toBeNull();}
    }
  }
  async disabledRecovery(reason) {
    const remove = await this.remember(this.remove('Retained 1')), move = await this.remember(this.move('Retained 1'));
    const nextRemove = await this.remember(this.remove('Retained 2'));
    await this.controlsDisabled(false);
    await this.simulation.getByRole('button', {name: reason === 'busy' ? 'Simulate controller busy' : 'Simulate metadata authority revocation', exact: true}).click();
    await this.settle(); let value = await this.read();
    expect(value[reason === 'busy' ? 'busy' : 'denied']).toBe(true);
    await this.sameNode(this.remove('Retained 1'), remove); await this.sameNode(this.move('Retained 1'), move);
    await this.controlsDisabled(true); await expect(this.search).toBeDisabled();
    await this.simulation.getByRole('button', {name: 'Synthetic probe: disabled Remove click', exact: true}).click();
    await this.simulation.getByRole('button', {name: 'Synthetic probe: disabled End event', exact: true}).click();
    await this.settle(); value = await this.read();
    expect(value.blockedSnapshotSame).toBe(true);
    expect(value.items.map(row => row.album_ref)).toEqual(this.expected.map(row => row.album_ref));
    expect(await this.renderedRefs()).toEqual(this.expected.map(row => row.album_ref)); expect(value.writes).toEqual([]);
    await this.simulation.getByRole('button', {name: 'Restore initial controller state', exact: true}).click();
    await this.settle(); value = await this.read();
    expect(value.busy).toBe(false); expect(value.denied).toBe(false);
    await this.sameNode(this.remove('Retained 1'), remove); await this.sameNode(this.move('Retained 1'), move);
    await this.sameNode(this.remove('Retained 2'), nextRemove);
    await this.controlsDisabled(false); await expect(this.search).toBeEnabled(); expect(value.rowIdentities).toEqual(this.indices);
    await this.remove('Retained 1').click(); await this.settle(); value = await this.read();
    await expect(this.remove('Retained 1')).toHaveCount(0); await this.sameNode(this.remove('Retained 2'), nextRemove);
    await expect(this.remove('Retained 2')).toBeFocused(); expect(value.items).toEqual(this.expected.slice(1));
    expect(value.items.map(row => row.album_ref)).toEqual(this.expected.slice(1).map(row => row.album_ref));
    expect(await this.renderedRefs()).toEqual(this.expected.slice(1).map(row => row.album_ref)); this.unchangedSource(value);
  }
}
module.exports = {Full5000NativePicker};
