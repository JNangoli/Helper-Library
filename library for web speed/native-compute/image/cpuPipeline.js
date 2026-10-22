// CPU fallback for the image editor: same API and same look as the GPU renderer,
// processed in the worker pool and drawn with a 2D canvas on the page.
// Native-feel tricks kept: latest-wins (old frames are cancelled), a half-size preview
// while dragging, and one full-quality render when the drag settles.
import { DEFAULT_IMAGE_PARAMS } from '../gpu/params';
import { encodePixels } from '../core/image';
import { createSettle, isAbort } from '../core/util';

let ids = 0;

function imageDataFrom(bitmap, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

export class CpuImagePipeline {
  constructor(canvas, pool) {
    this.mode = 'cpu-workers';
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pool = pool;
    this.key = `cpu-image-${++ids}`;
    this.params = { ...DEFAULT_IMAGE_PARAMS };
    this.source = null; // the original bitmap (for export)
    this.full = null; // fitted to the screen
    this.preview = null; // half size, used while dragging
    this.scratch = document.createElement('canvas');
    this.interactive = false;
    // One full-quality render 160 ms after the last slider move.
    this.settle = createSettle(160, () => {
      this.interactive = false;
      this.render();
    });
    this.frames = 0;
    this.lastScale = 1;
  }

  async setImage(source, maxSide = 4096) {
    const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
    const limit = Math.min(maxSide, 1600); // CPU work scales with pixels: cap the working size
    const s = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * s));
    const h = Math.max(1, Math.round(bitmap.height * s));
    this.source?.close?.();
    this.source = bitmap;
    this.full = imageDataFrom(bitmap, w, h);
    this.preview = imageDataFrom(bitmap, Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    this.last = null;
    this.render();
    return { width: bitmap.width, height: bitmap.height };
  }

  setParams(patch, interactive = true) {
    Object.assign(this.params, patch);
    if (interactive) {
      this.interactive = true;
      this.settle.poke();
    }
    this.render();
  }

  resize(width, height) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.draw();
  }

  render() {
    const image = this.interactive ? this.preview : this.full;
    if (!image || !this.source) return;
    const pixels = new Uint8ClampedArray(image.data).buffer; // a copy we can give away
    const scale = image.width / this.source.width;
    this.pool
      .run(
        'processImage',
        { pixels, width: image.width, height: image.height, params: this.params, blurScale: scale },
        { key: this.key, transfer: [pixels] }, // latest wins: older frames are dropped
      )
      .then((out) => {
        this.last = new ImageData(new Uint8ClampedArray(out.pixels), out.width, out.height);
        this.lastScale = image === this.preview ? 0.5 : 1;
        this.frames++;
        this.draw();
      })
      .catch((err) => {
        if (!isAbort(err)) console.error(err);
      });
  }

  draw() {
    const { canvas, ctx, last } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!last) return;
    this.scratch.width = last.width;
    this.scratch.height = last.height;
    this.scratch.getContext('2d').putImageData(last, 0, 0);
    const fit = Math.min(canvas.width / last.width, canvas.height / last.height);
    const w = last.width * fit;
    const h = last.height * fit;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.scratch, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }

  async exportImage({ type = 'image/png', quality = 0.92, maxSide = 4096 } = {}) {
    if (!this.source) throw new Error('No image loaded');
    const s = Math.min(1, maxSide / Math.max(this.source.width, this.source.height));
    const w = Math.max(1, Math.round(this.source.width * s));
    const h = Math.max(1, Math.round(this.source.height * s));
    const image = imageDataFrom(this.source, w, h);
    const out = await this.pool.run(
      'processImage',
      { pixels: image.data.buffer, width: w, height: h, params: this.params, blurScale: s },
      { transfer: [image.data.buffer] },
    );
    return encodePixels(new Uint8ClampedArray(out.pixels), out.width, out.height, type, quality);
  }

  stats() {
    return {
      scale: this.lastScale,
      interactive: this.interactive,
      frames: this.frames,
      skipped: 0,
      work: this.last ? [this.last.width, this.last.height] : [0, 0],
      image: this.source ? [this.source.width, this.source.height] : null,
      canvas: [this.canvas.width, this.canvas.height],
    };
  }

  dispose() {
    this.settle.cancel();
    this.pool.cancel(this.key);
    this.source?.close?.();
    this.source = this.full = this.preview = this.last = null;
  }
}
