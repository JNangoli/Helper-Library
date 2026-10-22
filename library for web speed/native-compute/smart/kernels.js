// Element-wise kernels: ONE definition that runs anywhere.
//   glsl : used on the GPU (each input is a vec4 of 4 consecutive elements)
//   js   : used in workers and on the main thread
// This module is imported by both the page and the workers, so add your own kernels here.
// Uniform names start with u_ and are plain numbers.

export const KERNELS = {
  normalize: {
    inputs: ['x'],
    glsl: '(x - u_min) / max(u_max - u_min, 1e-9)',
    js: (x, u) => (x - u.u_min) / Math.max(u.u_max - u.u_min, 1e-9),
  },
  zscore: {
    inputs: ['x'],
    glsl: '(x - u_mean) / max(u_std, 1e-9)',
    js: (x, u) => (x - u.u_mean) / Math.max(u.u_std, 1e-9),
  },
  scale: {
    inputs: ['x'],
    glsl: 'x * u_k + u_b',
    js: (x, u) => x * u.u_k + u.u_b,
  },
  clamp: {
    inputs: ['x'],
    glsl: 'clamp(x, u_lo, u_hi)',
    js: (x, u) => Math.min(u.u_hi, Math.max(u.u_lo, x)),
  },
  log1p: {
    inputs: ['x'],
    glsl: 'log(1.0 + x)',
    js: (x) => Math.log1p(x),
  },
  add: {
    inputs: ['a', 'b'],
    glsl: 'a + b',
    js: (a, b) => a + b,
  },
  multiply: {
    inputs: ['a', 'b'],
    glsl: 'a * b',
    js: (a, b) => a * b,
  },
};

export function kernelDef(name) {
  const def = KERNELS[name];
  if (!def) throw new Error(`Unknown kernel "${name}". Add it to smart/kernels.js`);
  return def;
}

/** Number of elements a kernel request produces. */
export function kernelLength(input) {
  if (input.length !== undefined) return input.length;
  const first = input.inputs?.[kernelDef(input.kernel).inputs[0]];
  return first ? first.length : 0;
}

/**
 * Runs a kernel in plain JS over [start, end) and writes into out[offset...].
 * input: { kernel, inputs: { name: array }, uniforms, start?, end? }
 */
export function runKernel(input, out, offset = 0) {
  const def = kernelDef(input.kernel);
  const arrays = def.inputs.map((name) => {
    const array = input.inputs?.[name];
    if (!array) throw new Error(`Kernel "${input.kernel}" needs input "${name}"`);
    return array;
  });
  const start = input.start ?? 0;
  const end = input.end ?? kernelLength(input);
  const result = out ?? new Float32Array(end - start);
  const u = input.uniforms ?? {};
  const f = def.js;
  // Specialised loops: no per-element allocation in the common cases.
  if (arrays.length === 1) {
    const a = arrays[0];
    for (let i = start; i < end; i++) result[offset + i - start] = f(a[i], u);
  } else if (arrays.length === 2) {
    const a = arrays[0];
    const b = arrays[1];
    for (let i = start; i < end; i++) result[offset + i - start] = f(a[i], b[i], u);
  } else {
    for (let i = start; i < end; i++) result[offset + i - start] = f(...arrays.map((arr) => arr[i]), u);
  }
  return result;
}
