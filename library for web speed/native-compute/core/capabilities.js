// One-shot feature detection. Everything else picks its fast path from this.
import { canTransferStreams } from './transfer';

function probeWebGL2(canvas) {
  const gl = canvas.getContext('webgl2');
  if (!gl) return null;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  const info = {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    floatRenderTargets: !!gl.getExtension('EXT_color_buffer_float'),
    renderer,
    // Software rasterisers are slower than CPU workers for our work: treat them as "no GPU".
    softwareGPU: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer),
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext(); // free the context right away
  return info;
}

async function detect() {
  const nav = navigator;
  const cores = nav.hardwareConcurrency || 4;
  const deviceMemoryGB = nav.deviceMemory;
  const gl = probeWebGL2(document.createElement('canvas'));

  let offscreenWebGL2 = false;
  if (typeof OffscreenCanvas !== 'undefined' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype) {
    try {
      offscreenWebGL2 = !!probeWebGL2(new OffscreenCanvas(1, 1));
    } catch {
      offscreenWebGL2 = false;
    }
  }

  let webgpu = false;
  try {
    const timeout = new Promise((r) => setTimeout(() => r(null), 800));
    webgpu = !!(await Promise.race([nav.gpu?.requestAdapter() ?? null, timeout]));
  } catch {
    webgpu = false;
  }

  const saveData = !!nav.connection?.saveData;
  const floatRenderTargets = !!gl?.floatRenderTargets;
  const memory = deviceMemoryGB ?? 8;
  const tier =
    cores <= 4 || memory <= 4 || saveData || !gl
      ? 'low'
      : cores >= 8 && memory >= 8 && floatRenderTargets
        ? 'high'
        : 'mid';

  return {
    cores,
    deviceMemoryGB,
    workers: typeof Worker !== 'undefined',
    webgl2: !!gl,
    offscreenWebGL2,
    floatRenderTargets,
    maxTextureSize: gl?.maxTextureSize ?? 0,
    gpuRenderer: gl?.renderer ?? '',
    softwareGPU: !!gl?.softwareGPU,
    webgpu,
    sharedMemory: typeof SharedArrayBuffer !== 'undefined' && !!globalThis.crossOriginIsolated,
    transferableStreams: canTransferStreams(),
    compressionStreams: typeof CompressionStream !== 'undefined',
    schedulerYield: typeof globalThis.scheduler?.yield === 'function',
    reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    saveData,
    tier,
  };
}

let cached;
export const detectCapabilities = () => (cached ??= detect());
