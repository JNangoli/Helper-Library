// Picks the best GPU path for this device and exposes one API for all of them:
//   'worker' : WebGL2 in a dedicated worker via OffscreenCanvas (main thread stays free)
//   'main'   : WebGL2 on the main thread (older Safari), same code, same API
//   'none'   : no WebGL2; calls reject with GpuUnavailableError so callers can fall back
import { WorkerPool, TaskCancelledError } from '../core/worker-pool';
import { yieldToMain } from '../core/scheduler';
import { GpuUnavailableError } from './gl';
import { createGpuHost } from './host';

const defaultGpuWorker = () => new Worker(new URL('./gpu.worker.js', import.meta.url), { type: 'module' });

export class GpuClient {
  mode;
  pool;
  host;

  constructor(caps, createWorker = defaultGpuWorker) {
    if (caps.offscreenWebGL2 && caps.workers) {
      this.mode = 'worker';
      this.pool = new WorkerPool({ createWorker, size: 1, maxInFlightPerWorker: 1024, maxBatchSize: 64 });
    } else if (caps.webgl2) {
      this.mode = 'main';
      this.host = createGpuHost({
        makeCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
        schedule: (cb) => requestAnimationFrame(() => cb()),
      });
    } else {
      this.mode = 'none';
    }
  }

  run(type, payload, options = {}) {
    if (this.pool) return this.pool.run(type, payload, options);
    if (!this.host) return Promise.reject(new GpuUnavailableError('WebGL2 is not available on this device'));
    const fn = this.host[type];
    return runLocally(fn, payload, options);
  }

  async attachCanvas(id, canvas, tier) {
    if (this.mode === 'worker') {
      const offscreen = canvas.transferControlToOffscreen();
      await this.run('attach', { id, canvas: offscreen, tier }, { transfer: [offscreen] });
    } else {
      await this.run('attach', { id, canvas, tier });
    }
  }

  dispose() {
    this.pool?.terminate();
  }
}

async function runLocally(fn, payload, options) {
  const { signal, timeoutMs, onProgress } = options;
  if (signal?.aborted) throw new TaskCancelledError('aborted');
  const controller = new AbortController();
  let reason = 'aborted';
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const onTimeout = () => {
    reason = 'timeout';
    controller.abort();
  };
  const timer = timeoutMs !== undefined ? setTimeout(onTimeout, timeoutMs) : undefined;
  const ctx = {
    signal: controller.signal,
    transfer() {},
    async checkpoint() {
      await yieldToMain();
      if (controller.signal.aborted) throw new TaskCancelledError(reason);
    },
    progress: (value) => onProgress?.(value),
  };
  try {
    const result = await fn(payload, ctx);
    if (controller.signal.aborted) throw new TaskCancelledError(reason);
    return result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    clearTimeout(timer);
  }
}
