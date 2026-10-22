// Images: display-sized thumbnails with a persistent cache, and CPU photo processing
// (used when the GPU is missing or software-only).
import { DEFAULT_IMAGE_PARAMS } from '../../gpu/params';
import { encodeCanvas, fitRect } from '../../core/image';
import { unsupported } from '../../core/util';

async function openThumbCache() {
  try {
    return typeof caches !== 'undefined' ? await caches.open('native-compute-thumbs-v1') : null;
  } catch {
    return null; // e.g. not a secure context
  }
}

/** Radii of 3 box blurs that together approximate a gaussian with this sigma. */
function boxRadii(sigma) {
  const n = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return [0, 1, 2].map((i) => ((i < m ? wl : wu) - 1) / 2);
}

/** One box-blur pass along rows (step = 4) or columns (step = width * 4), O(1) per pixel. */
async function boxPass(src, dst, width, height, r, horizontal, ctx) {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const step = horizontal ? 4 : width * 4;
  const div = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    if ((line & 63) === 0) await ctx.checkpoint();
    const base = horizontal ? line * width * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[base + Math.min(length - 1, Math.max(0, k)) * step + c];
      for (let i = 0; i < length; i++) {
        dst[base + i * step + c] = acc / div;
        const add = Math.min(length - 1, i + r + 1);
        const sub = Math.max(0, i - r);
        acc += src[base + add * step + c] - src[base + sub * step + c];
      }
    }
  }
}

export const images = {
  /**
   * Fetch/decode an image and make a display-sized copy plus a tiny blurred placeholder,
   * all off the main thread. Results are kept in the Cache API, so revisits are instant.
   * input: { source: url | Blob, width, height, fit: 'cover'|'contain', type, quality, cacheKey }
   */
  async thumbnail(input, ctx) {
    const { source, width, height, fit = 'cover', type = 'image/webp', quality = 0.82, cacheKey } = input;
    if (typeof OffscreenCanvas === 'undefined') throw unsupported('OffscreenCanvas');
    const cache = cacheKey ? await openThumbCache() : null;
    const keyUrl = cacheKey && `https://thumbs.invalid/${encodeURIComponent(cacheKey)}`;
    if (cache) {
      const [full, ph] = await Promise.all([cache.match(keyUrl), cache.match(`${keyUrl}?ph`)]);
      if (full && ph) {
        return {
          blob: await full.blob(),
          placeholder: await ph.blob(),
          width: Number(full.headers.get('x-width')),
          height: Number(full.headers.get('x-height')),
          cached: true,
        };
      }
    }

    const blob = typeof source === 'string' ? await (await fetch(source, { signal: ctx.signal })).blob() : source;
    await ctx.checkpoint();
    const bitmap = await createImageBitmap(blob);
    const r = fitRect(bitmap.width, bitmap.height, width, height, fit);
    const canvas = new OffscreenCanvas(r.w, r.h);
    const c2d = canvas.getContext('2d');
    c2d.imageSmoothingQuality = 'high';
    c2d.drawImage(bitmap, r.sx, r.sy, r.sw, r.sh, 0, 0, r.w, r.h);
    const pw = Math.max(1, Math.round((16 * r.w) / Math.max(r.w, r.h)));
    const phh = Math.max(1, Math.round((16 * r.h) / Math.max(r.w, r.h)));
    const tiny = new OffscreenCanvas(pw, phh);
    tiny.getContext('2d').drawImage(canvas, 0, 0, pw, phh);
    bitmap.close();
    await ctx.checkpoint();

    const [out, placeholder] = await Promise.all([
      encodeCanvas(canvas, type, quality),
      tiny.convertToBlob({ type: 'image/jpeg', quality: 0.6 }),
    ]);
    if (cache) {
      const headers = { 'content-type': out.type, 'x-width': String(r.w), 'x-height': String(r.h) };
      await Promise.all([
        cache.put(keyUrl, new Response(out, { headers })),
        cache.put(`${keyUrl}?ph`, new Response(placeholder, { headers: { 'content-type': placeholder.type } })),
      ]).catch(() => {}); // quota full: still return the result
    }
    return { blob: out, placeholder, width: r.w, height: r.h, cached: false };
  },

  /** Same look as the GPU renderer, on the CPU: colour, gaussian blur (3 box passes), vignette. */
  async processImage(input, ctx) {
    const { width, height } = input;
    const p = { ...DEFAULT_IMAGE_PARAMS, ...input.params };
    let px = new Uint8ClampedArray(input.pixels);
    const gain = 2 ** p.exposure;
    const contrast = 1 + p.contrast;
    const saturation = 1 + p.saturation;
    const warm = 0.08 * 255 * p.temperature;
    const neutral = p.exposure === 0 && p.contrast === 0 && p.saturation === 0 && p.temperature === 0;

    if (!neutral) {
      for (let i = 0; i < px.length; i += 4) {
        if ((i & 0x3ffff) === 0) await ctx.checkpoint();
        let r = (px[i] * gain + warm - 127.5) * contrast + 127.5;
        let g = (px[i + 1] * gain - 127.5) * contrast + 127.5;
        let b = (px[i + 2] * gain - warm - 127.5) * contrast + 127.5;
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        px[i] = l + (r - l) * saturation;
        px[i + 1] = l + (g - l) * saturation;
        px[i + 2] = l + (b - l) * saturation;
      }
    }

    const radius = p.blur * (input.blurScale ?? 1);
    if (radius >= 0.5) {
      let tmp = new Uint8ClampedArray(px.length);
      for (const r of boxRadii(radius * 0.5)) {
        const rr = Math.max(0, Math.round(r));
        await boxPass(px, tmp, width, height, rr, true, ctx);
        await boxPass(tmp, px, width, height, rr, false, ctx);
      }
      tmp = null;
    }

    if (p.vignette > 0) {
      for (let y = 0; y < height; y++) {
        if ((y & 63) === 0) await ctx.checkpoint();
        const dy = (y + 0.5) / height - 0.5;
        for (let x = 0; x < width; x++) {
          const dx = (x + 0.5) / width - 0.5;
          const t = Math.min(1, Math.max(0, (Math.hypot(dx, dy) * 1.3 - 0.3) / 0.55));
          const v = 1 - p.vignette * t * t * (3 - 2 * t);
          const i = (y * width + x) * 4;
          px[i] *= v;
          px[i + 1] *= v;
          px[i + 2] *= v;
        }
      }
    }

    ctx.transfer(px.buffer);
    const out = { pixels: px.buffer, width, height };
    px = null;
    return out;
  },
};
