// Jobs the engine can route, and defineOp() to add your own. Each job lists every way it can run;
// the engine predicts, picks the fastest, and learns:
//   inline  : on the page (only for tiny jobs: no messaging overhead)
//   worker  : one CPU worker
//   workers : split across all CPU workers, results merged
//   gpu     : WebGL2 (float32 precision)
import { math } from '../workers/tasks/math';
import { kernelDef, kernelLength, runKernel } from './kernels';
import { queryRows } from '../data/query';

export const OPS = {};

const INLINE_CTX = { signal: new AbortController().signal, transfer() {}, progress() {}, async checkpoint() {} };
const isShared = (a) => typeof SharedArrayBuffer !== 'undefined' && a?.buffer instanceof SharedArrayBuffer;
const asSpec = (value) => (typeof value === 'function' ? { run: value } : value);
const gpuUsable = (env) =>
  env.caps.webgl2 && env.caps.floatRenderTargets && !env.caps.softwareGPU && env.precision !== 'high';

/** Split [0, n) into `parts` contiguous ranges. */
export function ranges(n, parts) {
  const size = Math.ceil(n / parts);
  const out = [];
  for (let s = 0; s < n; s += size) out.push([s, Math.min(n, s + size)]);
  return out;
}

/** One worker's piece of an array: shared memory is sent whole (no copy), anything else is sliced. */
export const piece = (array, start, end) =>
  isShared(array) ? { data: array, start, end } : { data: array.slice(start, end), start: 0, end: end - start };

/** Buffers in a payload that were sliced just for this worker, so they can be transferred instead of copied. */
const ownBuffers = (...arrays) => arrays.filter((a) => ArrayBuffer.isView(a) && !isShared(a)).map((a) => a.buffer);

const defaultSize = (input) => input?.length ?? input?.size ?? input?.byteLength ?? 1;

/**
 * Teach the engine a job. Give any of these ways to run; it learns which is fastest.
 *
 * defineOp('countPrimes', {
 *   size: (input) => input.to - input.from,          // how big a job is (drives the predictions)
 *   cost: 3,                                         // optional: relative work per element (default 1)
 *   inline: (input) => countPrimes(input),           // on the page; only used for jobs predicted under ~3 ms
 *   task: 'countPrimes',                             // a task name in your worker file
 *   split: {                                         // across all workers, then merged
 *     parts: (input, n) => [...n payloads],
 *     merge: (results, input) => combined,
 *     minSize: 20_000,                               // don't split smaller jobs
 *     transfer: (payload) => [...buffers],           // optional
 *   },
 *   gpu: async (input, gpu, ctx) => ...,             // optional GPU version (gpu.run('map', ...))
 * });
 *
 * inline / task / gpu can also be objects with `when: (env) => boolean` (env = { n, input, caps,
 * workers, precision }). task can also set `payload: (input) => ...`, `transfer: (payload) => [...]`
 * and `affinity: (input) => key` (always the same worker, e.g. where the data was loaded).
 */
export function defineOp(name, spec) {
  const backends = {};
  const inline = asSpec(spec.inline);
  if (inline) backends.inline = { available: inline.when, run: (input) => inline.run(input) };

  const task = typeof spec.task === 'string' ? { name: spec.task } : spec.task;
  if (task) {
    backends.worker = {
      available: task.when,
      run(input, ctx) {
        const payload = task.payload ? task.payload(input) : input;
        return ctx.pool.run(task.name, payload, {
          signal: ctx.signal,
          transfer: task.transfer?.(payload),
          affinity: task.affinity?.(input),
        });
      },
    };
  }

  const split = spec.split;
  if (split) {
    const taskName = split.task ?? task?.name;
    if (!taskName) throw new Error(`defineOp("${name}"): split needs a task name`);
    backends.workers = {
      available: (env) => env.workers > 1 && env.n >= (split.minSize ?? 20_000) && (!split.when || split.when(env)),
      async run(input, ctx) {
        const results = await Promise.all(
          split
            .parts(input, ctx.workers)
            .map((p) => ctx.pool.run(taskName, p, { signal: ctx.signal, transfer: split.transfer?.(p) })),
        );
        return split.merge(results, input);
      },
    };
  }

  const gpu = asSpec(spec.gpu);
  if (gpu) {
    backends.gpu = {
      available: (env) => gpuUsable(env) && env.n >= (gpu.minSize ?? 4096) && (!gpu.when || gpu.when(env)),
      run: async (input, ctx) => gpu.run(input, await ctx.getGpu(), ctx),
    };
  }

  if (!Object.keys(backends).length) throw new Error(`defineOp("${name}") needs at least one way to run`);
  OPS[name] = { size: spec.size ?? defaultSize, cost: spec.cost ?? 1, backends };
  return name;
}

// ---- built-in jobs ----------------------------------------------------------------

/** Element-wise math: { kernel: 'normalize', inputs: { x }, uniforms: { u_min, u_max } } -> Float32Array */
defineOp('kernel', {
  size: kernelLength,
  inline: (input) => runKernel(input),
  task: 'kernel',
  split: {
    parts(input, n) {
      const names = kernelDef(input.kernel).inputs;
      const allShared = names.every((k) => isShared(input.inputs[k]));
      return ranges(kernelLength(input), n).map(([s, e]) => {
        if (allShared) return { ...input, start: s, end: e };
        const inputs = Object.fromEntries(names.map((k) => [k, input.inputs[k].slice(s, e)]));
        return { kernel: input.kernel, uniforms: input.uniforms, inputs, start: 0, end: e - s };
      });
    },
    transfer: (p) => ownBuffers(...Object.values(p.inputs)),
    merge(parts) {
      const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
      }
      return out;
    },
  },
  gpu(input, gpu, ctx) {
    const def = kernelDef(input.kernel);
    const inputs = {};
    const transfer = [];
    for (const name of def.inputs) {
      const array = input.inputs[name];
      // Float32Arrays are cloned (the caller keeps theirs); converted copies are ours to transfer.
      inputs[name] = array instanceof Float32Array ? array : Float32Array.from(array);
      if (inputs[name] !== array) transfer.push(inputs[name].buffer);
    }
    return gpu.run('map', { inputs, glsl: def.glsl, uniforms: input.uniforms }, { signal: ctx.signal, transfer });
  },
});

/** Summary statistics: array -> { count, min, max, mean, std } */
defineOp('stats', {
  size: (data) => data.length,
  cost: 1.5,
  inline: (data) => math.stats(data),
  task: 'stats',
  split: {
    minSize: 50_000,
    parts: (data, n) => ranges(data.length, n).map(([s, e]) => piece(data, s, e)),
    transfer: (p) => ownBuffers(p.data),
    merge(parts) {
      // Chan et al.: combine partial means and variances exactly.
      let count = 0;
      let mean = 0;
      let m2 = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const p of parts) {
        if (!p.count) continue;
        const total = count + p.count;
        const delta = p.mean - mean;
        mean += (delta * p.count) / total;
        m2 += p.m2 + (delta * delta * count * p.count) / total;
        count = total;
        min = Math.min(min, p.min);
        max = Math.max(max, p.max);
      }
      return { count, min, max, mean, m2, std: count > 1 ? Math.sqrt(m2 / (count - 1)) : 0 };
    },
  },
});

/** Histogram: { data, bins, min?, max? } -> { counts, min, max }. Splitting needs min and max. */
defineOp('histogram', {
  size: (input) => input.data.length,
  cost: 1.5,
  inline: (input) => math.histogram(input, INLINE_CTX),
  task: 'histogram',
  split: {
    minSize: 50_000,
    when: (env) => env.input.min !== undefined && env.input.max !== undefined,
    parts: (input, n) => ranges(input.data.length, n).map(([s, e]) => ({ ...input, ...piece(input.data, s, e) })),
    transfer: (p) => ownBuffers(p.data),
    merge(parts, input) {
      const counts = new Uint32Array(input.bins ?? 32);
      for (const p of parts) for (let i = 0; i < counts.length; i++) counts[i] += p.counts[i];
      return { counts, min: input.min, max: input.max };
    },
  },
});

/** Search / filter / sort rows (data/query.js). Small lists on the page; big ones in the worker holding them. */
defineOp('dataView', {
  size: (input) => input.count,
  cost: 3,
  inline: { when: (env) => !!env.input.prepared, run: (input) => queryRows(input.prepared, input.query) },
  task: {
    name: 'viewQuery',
    when: (env) => !!env.input.loaded,
    payload: (input) => ({ key: input.key, ...input.query }),
    affinity: (input) => input.key,
  },
});
