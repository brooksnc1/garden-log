import { put, get, uid } from './db.js';

async function decode(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function scaled(src, maxSide, quality) {
  const w = src.width, h = src.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.round(w * k), ch = Math.round(h * k);
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  canvas.getContext('2d').drawImage(src, 0, 0, cw, ch);
  return new Promise((res) => canvas.toBlob((b) => res({ blob: b, w: cw, h: ch }), 'image/jpeg', quality));
}

// Phone photos (~4 MB) become ~300 KB, plus a small thumbnail for lists.
export async function savePhoto(file) {
  const src = await decode(file);
  const full = await scaled(src, 1600, 0.8);
  const thumb = await scaled(src, 360, 0.7);
  if (src.close) src.close();
  const rec = { id: uid(), createdAt: new Date().toISOString(), blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h };
  await put('photos', rec);
  return rec.id;
}

const urlCache = new Map();
export async function photoURL(id, which = 'thumb') {
  const k = id + which;
  if (urlCache.has(k)) return urlCache.get(k);
  const rec = await get('photos', id);
  if (!rec) return null;
  const url = URL.createObjectURL(rec[which] || rec.blob);
  urlCache.set(k, url);
  return url;
}
