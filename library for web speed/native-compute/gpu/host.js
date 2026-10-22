// Everything the GPU side can do, written once. It runs inside the GPU worker
// (OffscreenCanvas) or, on browsers without it, directly on the main thread.

import { encodePixels, toBitmap } from '../core/image';
import { GpuCompute } from './GpuCompute';
import { ImageRenderer } from './ImageRenderer';
export function createGpuHost(env) {
  let compute = null;
  const renderers = new Map();
  let visible = true;

  const getCompute = () => (compute ??= new GpuCompute(env.makeCanvas(1, 1)));
  const renderer = (id) => {
    const r = renderers.get(id);
    if (!r) throw new Error(`No canvas attached with id "${id}"`);
    return r;
  };

  return {
    info() {
      const c = getCompute();
      return { webgl2: c.hasWebGL2, floatCompute: c.available, maxTextureSize: c.maxTextureSize };
    },

    map(request, ctx) {
      const out = getCompute().map(request);
      ctx.transfer(out.buffer);
      return out;
    },

    attach(input) {
      const r = new ImageRenderer(input.canvas, { schedule: env.schedule, tier: input.tier });
      r.setVisible(visible);
      renderers.set(input.id, r);
      return { maxTextureSize: r.maxTextureSize };
    },

    detach(input) {
      renderers.get(input.id)?.dispose();
      renderers.delete(input.id);
    },

    resize(input) {
      renderer(input.id).resize(input.width, input.height);
    },

    async setImage(input) {
      const r = renderer(input.id);
      const bitmap = await toBitmap(
        input.source,
        Math.min(input.maxSide ?? Infinity, r.maxTextureSize),
        env.makeCanvas,
      );
      if (!renderers.has(input.id)) {
        bitmap.close(); // detached while decoding
        throw new Error('Canvas was detached');
      }
      r.setImage(bitmap);
      return { width: bitmap.width, height: bitmap.height };
    },

    setParams(input) {
      renderer(input.id).setParams(input.params, input.interactive ?? true);
    },

    setVisible(input) {
      visible = input.visible;
      renderers.forEach((r) => r.setVisible(visible));
    },

    stats(input) {
      return renderer(input.id).stats;
    },

    async exportImage(input) {
      const { pixels, width, height } = renderer(input.id).exportPixels(input.maxSide);
      return encodePixels(pixels, width, height, input.type, input.quality, env.makeCanvas);
    },
  };
}
