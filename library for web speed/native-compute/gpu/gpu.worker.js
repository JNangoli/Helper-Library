// The dedicated GPU worker: owns WebGL contexts for compute and for every attached canvas.
import { defineWorker } from '../core/worker-runtime';
import { createGpuHost } from './host';

const scope = globalThis;
const schedule = (cb) => {
  // requestAnimationFrame in workers follows the display's refresh rate; fall back to a timer.
  if (typeof scope.requestAnimationFrame === 'function') scope.requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
};

export const handlers = defineWorker(createGpuHost({ makeCanvas: (w, h) => new OffscreenCanvas(w, h), schedule }));
