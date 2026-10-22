// Browser primitives only. Source authority and generation ownership remain
// outside this adapter. No fallback decoder, screenshot or secondary canvas.
export const IMAGE_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export async function prepareAlbumTopImageFonts(doc, current) {
  const fonts = doc.fonts;
  if (!fonts || typeof fonts.load !== 'function' || typeof fonts.check !== 'function' || !fonts.ready) throw 'font_unavailable';
  await fonts.ready;
  if (!current()) return false;
  for (const [weight, size] of [[700,28],[400,14],[600,16],[700,16],[400,12]]) {
    const font = `${weight} ${size}px ${IMAGE_FONT}`;
    await fonts.load(font);
    if (!current()) return false;
    if (!fonts.check(font)) throw 'font_unavailable';
  }
  return current();
}
export function createAlbumTopImageSurface(doc) {
  let canvas = doc.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context || typeof context.roundRect !== 'function') {canvas.width = canvas.height = 0; throw 'surface_unavailable';}
  return {context, resize(width,height) {canvas.width = width; canvas.height = height;}, release() {if (!canvas) return; canvas.width = canvas.height = 0; canvas = null;}};
}
export async function decodeAlbumTopImageResource(prepared) {
  if (typeof createImageBitmap !== 'function') throw 'resource_unavailable';
  const image = await createImageBitmap(prepared.blob);
  let closed = false;
  return {image,width:image.width,height:image.height,release() {if (closed) return; closed = true; image.close();}};
}
export function encodeAlbumTopImagePng(surface) {
  return new Promise((resolve,reject) => {try {surface.context.canvas.toBlob(resolve,'image/png');} catch {reject('encode_failed');}});
}
export async function readAlbumTopImagePngHeader(blob, width, height) {
  const buffer = await blob.slice(0,33).arrayBuffer();
  if (buffer.byteLength !== 33) throw 'invalid_png';
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if ([137,80,78,71,13,10,26,10].some((v,i)=>bytes[i]!==v) || view.getUint32(8)!==13
    || [73,72,68,82].some((v,i)=>bytes[12+i]!==v)) throw 'invalid_png';
  let crc=0xffffffff;
  for (const byte of bytes.subarray(12,29)) {crc^=byte; for(let n=0;n<8;n++) crc=(crc>>>1)^(0xedb88320&-(crc&1));}
  if (((crc^0xffffffff)>>>0)!==view.getUint32(29)) throw 'invalid_png';
  const w=view.getUint32(16),h=view.getUint32(20),depth=bytes[24],color=bytes[25];
  const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
  if (!w || !h || w>16384 || h>16384 || w*h>32000000 || !depths[color]?.includes(depth)
    || bytes[26]!==0 || bytes[27]!==0 || bytes[28]>1 || w!==width || h!==height) throw 'invalid_png';
  return {width:w,height:h};
}
export function albumTopImageFilename(title) {
  let name=[...String(title).replace(/[\ud800-\udfff]/gu,'\ufffd')].slice(0,100).join('').replace(/[\\/\u0000-\u001f\u007f-\u009f:*?"<>|]/g,'-').replace(/[ .]+$/g,'');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name='Album Top';
  return name+'.png';
}
