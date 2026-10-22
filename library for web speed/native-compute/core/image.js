// Image decoding/resizing/encoding that works on the main thread and in workers.

export function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas) {
  return canvas.getContext('2d');
}

/** Decode (off the main thread when called in a worker) and fit within maxSide. */
export async function toBitmap(source, maxSide, create = makeCanvas) {
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  const scale = maxSide / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) return bitmap;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  try {
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
    if (resized.width === width && resized.height === height) {
      bitmap.close();
      return resized;
    }
    resized.close(); // resize options ignored by this browser: fall through
  } catch {
    /* fall through */
  }
  const canvas = create(width, height);
  const ctx = context2d(canvas);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return createImageBitmap(canvas);
}

/** Encode RGBA pixels (straight alpha) to PNG/JPEG/WebP. */
export async function encodePixels(pixels, width, height, type = 'image/png', quality = 0.92, create = makeCanvas) {
  const canvas = create(width, height);
  context2d(canvas).putImageData(new ImageData(pixels, width, height), 0, 0);
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))), type, quality),
  );
}

/** Source rectangle + output size for fitting an image into width x height. */
export function fitRect(iw, ih, width, height, fit) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (fit === 'contain') {
    const s = Math.min(1, w / iw, h / ih);
    return { sx: 0, sy: 0, sw: iw, sh: ih, w: Math.max(1, Math.round(iw * s)), h: Math.max(1, Math.round(ih * s)) };
  }
  // cover: crop the centre to the target aspect ratio, never upscale
  const scale = Math.min(1, Math.max(w / iw, h / ih));
  const sw = Math.min(iw, w / scale);
  const sh = Math.min(ih, h / scale);
  return { sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh, w: Math.round(sw * scale), h: Math.round(sh * scale) };
}

export async function encodeCanvas(canvas, type, quality) {
  const blob = await canvas.convertToBlob({ type, quality });
  // Safari can't encode WebP and silently returns PNG: use JPEG instead (much smaller).
  return blob.type === type ? blob : canvas.convertToBlob({ type: 'image/jpeg', quality });
}
