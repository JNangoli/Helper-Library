// Number crunching: stats, histograms and element-wise kernels.
import { kernelLength, runKernel } from '../../smart/kernels';

/** Accepts an array, or { data, start, end } (used when work is split across workers). */
export const range = (input) =>
  ArrayBuffer.isView(input) || Array.isArray(input)
    ? { data: input, start: 0, end: input.length }
    : { data: input.data, start: input.start ?? 0, end: input.end ?? input.data.length };

export const math = {
  /** count/min/max/mean/std in one pass (Welford), NaN ignored. m2 lets partial results be merged. */
  stats(input) {
    const { data, start, end } = range(input);
    let count = 0;
    let mean = 0;
    let m2 = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < end; i++) {
      const x = data[i];
      if (Number.isNaN(x)) continue;
      count++;
      const delta = x - mean;
      mean += delta / count;
      m2 += delta * (x - mean);
      if (x < min) min = x;
      if (x > max) max = x;
    }
    return { count, min, max, mean, m2, std: count > 1 ? Math.sqrt(m2 / (count - 1)) : 0 };
  },

  histogram(input, ctx) {
    const { data, start, end } = range(input);
    const bins = input.bins ?? 32;
    let { min, max } = input;
    if (min === undefined || max === undefined) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = start; i < end; i++) {
        const x = data[i];
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      min ??= lo;
      max ??= hi;
    }
    const counts = new Uint32Array(bins);
    const scale = max > min ? bins / (max - min) : 0;
    for (let i = start; i < end; i++) {
      const x = data[i];
      if (Number.isNaN(x) || x < min || x > max) continue;
      counts[Math.min(bins - 1, Math.floor((x - min) * scale))]++;
    }
    ctx.transfer(counts.buffer);
    return { counts, min, max };
  },

  /** Element-wise kernel from smart/kernels.js over a range, cancellable between chunks. */
  async kernel(input, ctx) {
    const start = input.start ?? 0;
    const end = input.end ?? kernelLength(input);
    const out = new Float32Array(end - start);
    const CHUNK = 1 << 18;
    for (let s = start; s < end; s += CHUNK) {
      await ctx.checkpoint();
      runKernel({ ...input, start: s, end: Math.min(end, s + CHUNK) }, out, s - start);
    }
    ctx.transfer(out.buffer);
    return out;
  },
};
