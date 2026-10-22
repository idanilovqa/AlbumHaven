// Pure display projection and measured geometry. Binding consistency is not
// authorization: the caller owns complete membership, current scope and taste.
const FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const BINDING_KEYS = Object.freeze(['scopeKey', 'topRef', 'revision', 'sourceKey']);
const DEFAULTS = Object.freeze({columns: 4, showTitle: true, showInfo: true,
  showArtist: true, showAlbum: true, showYear: true, showNumber: true,
  showOwnRating: false, numberPlacement: 'on', backgroundColor: '#ffffff',
  textColor: '#111111', frameColor: '#111111', frameWidth: 1, roundedCorners: false});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const fail = code => {throw code;};
const invalid = code => Object.freeze({status: 'invalid', code});
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function opaque(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !/[\ud800-\udfff]/u.test(value);
}
function binding(value) {
  if (!record(value)) fail('invalid_binding');
  const result = {};
  for (const key of BINDING_KEYS) {
    const field = value[key];
    if (!opaque(field, 4096)) fail('invalid_binding');
    result[key] = field;
  }
  return result;
}
function cleanText(value) {
  if (typeof value !== 'string') fail('invalid_text');
  let count = 0;
  for (const point of value) {if (++count > 1000) fail('invalid_text');}
  return value.replace(/[\p{White_Space}\ufeff]+/gu, ' ').trim()
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/[\ud800-\udfff]/gu, '\ufffd').replace(/ +/g, ' ').trim();
}
function optionsFrom(value) {
  if (!record(value)) fail('invalid_options');
  const result = {...DEFAULTS};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.hasOwn(DEFAULTS, key)) fail('invalid_options');
    const field = value[key];
    if (key === 'columns' || key === 'frameWidth') {
      if (!integer(field, 1, key === 'columns' ? 10 : 12)) fail('invalid_options');
    } else if (key === 'numberPlacement') {
      if (field !== 'on' && field !== 'below') fail('invalid_options');
    } else if (key.endsWith('Color')) {
      if (typeof field !== 'string' || !/^#[0-9a-f]{6}$/iu.test(field)) fail('invalid_options');
    } else if (typeof field !== 'boolean') fail('invalid_options');
    result[key] = key.endsWith('Color') ? field.toLowerCase() : field;
  }
  return result;
}
export function projectAlbumTopImage(source, options = {}, ownRatings = null) {
  let phase = 'invalid_source';
  try {
    if (!record(source) || !Object.hasOwn(source, 'binding') || !Object.hasOwn(source, 'items')) fail(phase);
    phase = 'invalid_binding';
    const capture = binding(source.binding);
    phase = 'incomplete_source';
    const total = source.total, rows = source.items;
    if (source.complete !== true || !integer(total, 0, 5000) || !Array.isArray(rows) || rows.length !== total) fail(phase);
    for (let i = 0; i < total; i++) if (!Object.hasOwn(rows, i)) fail(phase);
    phase = 'invalid_text';
    const title = cleanText(source.title), info = cleanText(source.description), attribution = cleanText(source.attribution);
    if (!attribution) fail(phase);
    const members = new Set(), albums = new Set(), items = [];
    for (const row of rows) {
      if (!record(row)) fail('invalid_source');
      const itemRef = row.item_ref, albumRef = row.album_ref, year = row.year;
      if (!opaque(itemRef, 256) || !opaque(albumRef, 256) || !(year === null || integer(year, 1, 9999))) fail('invalid_source');
      if (members.has(itemRef) || albums.has(albumRef)) fail('duplicate_member');
      members.add(itemRef); albums.add(albumRef);
      items.push({itemRef, albumRef, number: items.length + 1, artist: cleanText(row.artist), album: cleanText(row.title), year});
    }
    phase = 'invalid_options';
    const settings = optionsFrom(options);
    if (settings.showOwnRating) {
      phase = 'invalid_own_ratings';
      if (!record(ownRatings)) fail(phase);
      const ownBinding = ownRatings.binding, ownItems = ownRatings.items;
      if (!record(ownBinding) || BINDING_KEYS.some(key => ownBinding[key] !== capture[key])
        || !Array.isArray(ownItems) || ownItems.length !== total) fail(phase);
      const ratings = new Map();
      for (let i = 0; i < total; i++) {
        if (!Object.hasOwn(ownItems, i)) fail(phase);
        const row = ownItems[i];
        if (!record(row)) fail(phase);
        const ref = row.item_ref, rating = row.rating;
        if (!members.has(ref) || ratings.has(ref) || !(rating === null || integer(rating, 1, 10))) fail(phase);
        ratings.set(ref, rating);
      }
      for (const item of items) item.ownRating = ratings.get(item.itemRef);
    }
    return freeze({status: 'ready', model: {binding: capture, title, info, attribution, branding: 'AlbumHaven', options: settings, items}});
  } catch (error) {
    const codes = ['invalid_source', 'invalid_binding', 'incomplete_source', 'duplicate_member', 'invalid_text', 'invalid_options', 'invalid_own_ratings'];
    return invalid(codes.includes(error) ? error : phase);
  }
}
export function albumTopImageRowSteps(count) {
  if (!integer(count, 0, 5000)) throw new TypeError('Invalid count');
  const steps = new Set();
  for (let columns = 1; columns <= Math.min(10, count); columns++) steps.add(Math.ceil(count / columns));
  return Object.freeze([...steps].sort((a, b) => a - b));
}
export function albumTopImageGrid(count, selection) {
  const rowSteps = albumTopImageRowSteps(count);
  if (!record(selection) || Reflect.ownKeys(selection).length !== 1) throw new TypeError('Invalid selection');
  let columns;
  if (Object.hasOwn(selection, 'columns') && integer(selection.columns, 1, 10)) columns = Math.min(selection.columns, count);
  else if (Object.hasOwn(selection, 'rowIndex') && integer(selection.rowIndex, 0, rowSteps.length - 1)) columns = Math.ceil(count / rowSteps[selection.rowIndex]);
  else throw new TypeError('Invalid selection');
  const rows = count ? Math.ceil(count / columns) : 0;
  return freeze({columns, rows, rowIndex: count ? rowSteps.indexOf(rows) : null, rowSteps});
}
// Only frozen data descriptors are accepted, not frozen accessor lookalikes.
function frozenRecord(value, keys) {
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) fail('invalid_source');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) fail('invalid_source');
  for (const key of keys) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) fail('invalid_source');
}
function validatedModel(model) {
  frozenRecord(model, ['binding', 'title', 'info', 'attribution', 'branding', 'options', 'items']);
  frozenRecord(model.binding, BINDING_KEYS);
  frozenRecord(model.options, Object.keys(DEFAULTS));
  if (!Array.isArray(model.items) || !Object.isFrozen(model.items) || !integer(model.items.length, 0, 5000)
    || Reflect.ownKeys(model.items).length !== model.items.length + 1) fail('invalid_source');
  const rows = [], own = [];
  for (let i = 0; i < model.items.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(model.items, i);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_source');
    const item = descriptor.value;
    frozenRecord(item, ['itemRef', 'albumRef', 'number', 'artist', 'album', 'year', ...(model.options.showOwnRating ? ['ownRating'] : [])]);
    if (item.number !== i + 1) fail('invalid_source');
    rows.push({item_ref: item.itemRef, album_ref: item.albumRef, title: item.album, artist: item.artist, year: item.year});
    if (model.options.showOwnRating) own.push({item_ref: item.itemRef, rating: item.ownRating});
  }
  const result = projectAlbumTopImage({binding: model.binding, complete: true, total: rows.length, items: rows,
    title: model.title, description: model.info, attribution: model.attribution}, model.options, {binding: model.binding, items: own});
  if (result.status !== 'ready' || model.branding !== 'AlbumHaven') fail('invalid_source');
  const copy = result.model;
  for (const key of ['title', 'info', 'attribution']) if (copy[key] !== model[key]) fail('invalid_source');
  for (const key of Object.keys(DEFAULTS)) if (copy.options[key] !== model.options[key]) fail('invalid_source');
  for (let i = 0; i < rows.length; i++) {
    if (copy.items[i].album !== model.items[i].album || copy.items[i].artist !== model.items[i].artist) fail('invalid_source');
  }
  return copy;
}
const finite = value => {if (!Number.isFinite(value)) fail('invalid_metrics'); return value;};
function capacity(width, height) {
  finite(width); finite(height);
  if (width > 16384 || height > 16384) fail('side_limit');
  if (width * height > 32000000) fail('pixel_limit');
}
function displayBlocks(model) {
  const o = model.options;
  const block = (kind, text, size, weight = 400) => ({kind, text, fontSize: size, fontWeight: weight});
  const header = [];
  if (o.showTitle && model.title) header.push(block('title', model.title, 28, 700));
  if (o.showInfo && model.info) header.push(block('info', model.info, 14));
  const cards = model.items.map(item => {
    const captions = [], number = o.showNumber ? block('number', String(item.number), 16, 700) : null;
    if (number && o.numberPlacement === 'below') captions.push(number);
    if (o.showArtist && item.artist) captions.push(block('artist', item.artist, 14));
    if (o.showAlbum && item.album) captions.push(block('album', item.album, 16, 600));
    if (o.showYear && item.year !== null) captions.push(block('year', String(item.year), 14));
    if (o.showOwnRating && item.ownRating !== null) captions.push(block('rating', `Rating: ${item.ownRating}/10`, 14));
    return {captions, badge: o.numberPlacement === 'on' ? number : null};
  });
  return {header, cards, brand: block('brand', 'AlbumHaven', 16, 700), credit: block('attribution', model.attribution, 12)};
}
function textEngine(blocks, columns, measureText) {
  let points = 0, blockCount = 0;
  for (const block of blocks) {
    let length = 0;
    for (const point of block.text) {if (++length > 1000) fail('invalid_text');}
    points += length; blockCount++;
  }
  const callLimit = Math.min(65536, 4 * points + 4 * blockCount + 64);
  const segmentLimit = Math.min(131072, points);
  const lineLimit = Math.min(8192, points, (columns + 1) * Math.floor(16384 / 16));
  let calls = 0, segments = 0, lines = 0, segmenter;
  if (typeof measureText !== 'function') fail('invalid_metrics');
  try {segmenter = new Intl.Segmenter('und', {granularity: 'grapheme'});}
  catch {fail('segmentation_unavailable');}
  function measure(text, block) {
    if (calls >= callLimit) fail('text_budget');
    calls++;
    let advance, left, right, ascent, descent;
    try {
      const metrics = measureText(text, Object.freeze({fontFamily: FONT, fontSize: block.fontSize, fontWeight: block.fontWeight}));
      ({advance, left, right, ascent, descent} = metrics);
    } catch {fail('invalid_metrics');}
    for (const value of [advance, left, right, ascent, descent]) finite(value);
    if (advance < 0 || ascent < 0 || descent < 0 || left > right || ascent + descent <= 0) fail('invalid_metrics');
    return {width: finite(Math.max(advance, right) - Math.min(0, left)),
      height: finite(Math.max(Math.ceil(1.3 * block.fontSize), Math.ceil(finite(ascent + descent)))),
      bearing: Math.min(0, left), ascent};
  }
  function segment(text) {
    const parts = [];
    let offset = 0, malformed = false;
    try {
      const iterator = segmenter.segment(text)[Symbol.iterator]();
      if (!iterator || typeof iterator.next !== 'function') fail('segmentation_unavailable');
      while (true) {
        const next = iterator.next();
        if (!record(next) || typeof next.done !== 'boolean') fail('segmentation_unavailable');
        if (next.done) break;
        if (segments >= segmentLimit) fail('text_budget');
        segments++;
        const part = next.value?.segment;
        if (typeof part !== 'string' || !part) fail('segmentation_unavailable');
        // Drain a malformed extra suffix within the same bounded budget: a
        // finite bad stream is a segmentation error; an endless one is budget.
        if (malformed || text.slice(offset, offset + part.length) !== part) malformed = true;
        else {parts.push(part); offset += part.length;}
      }
    } catch (error) {fail(error === 'text_budget' ? error : 'segmentation_unavailable');}
    if (malformed || offset !== text.length) fail('segmentation_unavailable');
    return parts;
  }
  function emit(text, metrics, accept) {
    if (lines >= lineLimit) fail('text_budget');
    // The caller raises its monotonic occupied-height bound before allocation.
    accept(text, metrics); lines++;
  }
  function wrap(block, width, accept, single = false) {
    const parts = segment(block.text);
    if (single) {
      const metrics = measure(block.text, block);
      if (metrics.width > width) fail('unreadable_text');
      emit(block.text, metrics, accept); return;
    }
    let start = 0;
    while (start < parts.length) {
      let end = start, lastSpace = -1, text = '', metrics = null;
      while (end < parts.length) {
        const candidate = text + parts[end], measured = measure(candidate, block);
        if (measured.width > width) break;
        text = candidate; metrics = measured;
        if (/^\s+$/u.test(parts[end])) lastSpace = end;
        end++;
      }
      if (end === start) fail('unreadable_text');
      let nextStart = end;
      if (end < parts.length && !/^\s+$/u.test(parts[end]) && lastSpace >= start) {
        text = parts.slice(start, lastSpace).join('');
        nextStart = lastSpace + 1;
        if (!text) {start = nextStart; continue;}
        metrics = measure(text, block);
        if (metrics.width > width) fail('unreadable_text');
      } else if (text.endsWith(' ')) {
        text = text.trimEnd();
        if (text) metrics = measure(text, block);
      }
      if (text) emit(text, metrics, accept);
      start = nextStart;
      while (start < parts.length && /^\s+$/u.test(parts[start])) start++;
    }
  }
  return {wrap};
}
export function layoutAlbumTopImage(input, measureText, engineOptions = {}) {
  let phase = 'invalid_source';
  try {
    const model = validatedModel(input), o = model.options;
    phase = 'invalid_options';
    if (!record(engineOptions) || Reflect.ownKeys(engineOptions).some(key => key !== 'coverSize')) fail(phase);
    const coverSize = Object.hasOwn(engineOptions, 'coverSize') ? engineOptions.coverSize : 256;
    if (!integer(coverSize, 128, 16384)) fail(phase);
    if (!model.items.length) fail('empty_source');
    const grid = albumTopImageGrid(model.items.length, {columns: o.columns});
    const gridWidth = grid.columns * coverSize + (grid.columns - 1) * 16, width = gridWidth + 48;
    const rowHeights = Array(grid.rows).fill(coverSize);
    let headerHeight = 0, groupHeight = 24, creditHeight = 16;
    const lowerBound = () => {
      const height = 24 + headerHeight + (headerHeight ? 16 : 0)
        + rowHeights.reduce((sum, h) => finite(sum + h), 0) + (grid.rows - 1) * 16
        + 24 + groupHeight + 8 + creditHeight + 24;
      capacity(width, height);
    };
    lowerBound();
    const blocks = displayBlocks(model);
    const allBlocks = [...blocks.header];
    for (const card of blocks.cards) {if (card.badge) allBlocks.push(card.badge); allBlocks.push(...card.captions);}
    allBlocks.push(blocks.brand, blocks.credit);
    phase = 'invalid_metrics';
    const engine = textEngine(allBlocks, grid.columns, measureText), texts = [], items = [];
    function draw(block, itemRef, text, metrics, x, y) {
      const line = {kind: block.kind, itemRef, text, x, y, width: metrics.width, height: metrics.height,
        baselineX: finite(x - metrics.bearing), baseline: finite(y + metrics.ascent),
        fontSize: block.fontSize, fontWeight: block.fontWeight, color: o.textColor};
      for (const value of [x, y, finite(x + metrics.width), finite(y + metrics.height)]) {
        if (value < 0) fail('invalid_metrics');
      }
      texts.push(line);
    }
    for (const block of blocks.header) {
      if (headerHeight) {headerHeight += 8; lowerBound();}
      engine.wrap(block, gridWidth, (text, metrics) => {
        const y = 24 + headerHeight;
        headerHeight = finite(headerHeight + metrics.height); lowerBound();
        draw(block, null, text, metrics, 24 + (gridWidth - metrics.width) / 2, y);
      });
    }
    const gridY = 24 + headerHeight + (headerHeight ? 16 : 0);
    let rowY = gridY;
    for (let row = 0; row < grid.rows; row++) {
      const occupied = Math.min(grid.columns, model.items.length - row * grid.columns);
      const rowWidth = occupied * coverSize + (occupied - 1) * 16;
      for (let column = 0; column < occupied; column++) {
        const index = row * grid.columns + column, member = model.items[index], card = blocks.cards[index];
        const x = 24 + (gridWidth - rowWidth) / 2 + column * (coverSize + 16), y = rowY;
        let cardHeight = coverSize, numberBadge = null;
        if (card.badge) {
          const inset = o.frameWidth + 8, available = coverSize - 2 * inset;
          engine.wrap(card.badge, available - 12, (text, metrics) => {
            const badgeWidth = metrics.width + 12, badgeHeight = finite(metrics.height + 8);
            if (badgeHeight > available) fail('unreadable_text');
            numberBadge = {x: x + inset, y: y + coverSize - inset - badgeHeight,
              width: badgeWidth, height: badgeHeight, color: o.backgroundColor};
            draw(card.badge, member.itemRef, text, metrics, numberBadge.x + 6, numberBadge.y + 4);
          }, true);
        }
        for (const block of card.captions) {
          cardHeight = finite(cardHeight + 8);
          rowHeights[row] = Math.max(rowHeights[row], cardHeight); lowerBound();
          engine.wrap(block, coverSize, (text, metrics) => {
            const textY = finite(y + cardHeight);
            cardHeight = finite(cardHeight + metrics.height);
            rowHeights[row] = Math.max(rowHeights[row], cardHeight); lowerBound();
            draw(block, member.itemRef, text, metrics, x + (coverSize - metrics.width) / 2, textY);
          });
        }
        items.push({itemRef: member.itemRef, albumRef: member.albumRef, number: member.number,
          row, column, x, y, width: coverSize, height: cardHeight,
          cover: {x, y, width: coverSize, height: coverSize, radius: o.roundedCorners ? Math.min(12, Math.floor(coverSize / 8)) : 0,
            frameWidth: o.frameWidth, frameColor: o.frameColor, opacity: 1, filter: 'none'}, numberBadge});
      }
      rowY = finite(rowY + rowHeights[row] + (row + 1 < grid.rows ? 16 : 0));
    }
    const gridHeight = rowY - gridY, groupY = rowY + 24;
    let branding;
    engine.wrap(blocks.brand, gridWidth - 32, (text, metrics) => {
      groupHeight = Math.max(24, metrics.height); lowerBound();
      const groupX = 24 + (gridWidth - 32 - metrics.width) / 2;
      branding = {x: groupX, y: groupY + (groupHeight - 24) / 2, width: 24, height: 24};
      draw(blocks.brand, null, text, metrics, groupX + 32, groupY + (groupHeight - metrics.height) / 2);
    }, true);
    const creditY = groupY + groupHeight + 8;
    let usedCredit = 0;
    engine.wrap(blocks.credit, gridWidth, (text, metrics) => {
      const y = creditY + usedCredit;
      usedCredit = finite(usedCredit + metrics.height); creditHeight = Math.max(16, usedCredit); lowerBound();
      draw(blocks.credit, null, text, metrics, 24 + (gridWidth - metrics.width) / 2, y);
    });
    const height = Math.ceil(creditY + usedCredit + 24);
    capacity(width, height);
    const layout = {binding: {...model.binding}, width, height, pixelCount: width * height,
      grid: {...grid, x: 24, y: gridY, width: gridWidth, height: gridHeight}, options: {...o}, fontFamily: FONT,
      texts, items, branding};
    // Check every finished rectangle again, independent of the capacity bound.
    const rectangles = [layout.grid, branding, ...texts];
    for (const item of items) {rectangles.push(item, item.cover); if (item.numberBadge) rectangles.push(item.numberBadge);}
    for (const rect of rectangles) {
      for (const key of ['x', 'y', 'width', 'height']) if (finite(rect[key]) < 0) fail('invalid_metrics');
      if (finite(rect.x + rect.width) > width || finite(rect.y + rect.height) > height) fail('invalid_metrics');
    }
    return freeze({status: 'ready', layout});
  } catch (error) {
    const codes = ['invalid_source', 'invalid_options', 'invalid_text', 'empty_source', 'invalid_metrics',
      'segmentation_unavailable', 'unreadable_text', 'text_budget', 'side_limit', 'pixel_limit'];
    return invalid(codes.includes(error) ? error : phase);
  }
}

// Synchronous admission for consumers that do not own a measuring surface.
// The existing layout path deliberately keeps its original error semantics.
export function validateAlbumTopImageModel(input) {
  try {return Object.freeze({status: 'ready', model: validatedModel(input)});}
  catch {return invalid('invalid_source');}
}
