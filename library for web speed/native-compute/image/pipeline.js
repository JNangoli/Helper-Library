// Picks the best way to run the image editor on this device and returns one handle:
//   'gpu-worker' : WebGL2 in a worker (best: the page never draws)
//   'gpu-main'   : WebGL2 on the page (older Safari)
//   'cpu-workers': CPU worker pool + 2D canvas (no GPU, or a slow software GPU)
// Every handle has: mode, setImage, setParams, resize, exportImage, stats, dispose.
import { CpuImagePipeline } from './cpuPipeline';

let ids = 0;
const noop = () => {};

export function chooseImageBackend(caps, prefer = 'auto') {
  if (prefer === 'cpu') return 'cpu';
  if (prefer === 'gpu') return caps.webgl2 ? 'gpu' : 'cpu';
  return caps.webgl2 && !caps.softwareGPU ? 'gpu' : 'cpu';
}

async function gpuHandle(canvas, gpu, caps) {
  const id = `gpu-image-${++ids}`;
  await gpu.attachCanvas(id, canvas, caps.tier);
  return {
    mode: gpu.mode === 'worker' ? 'gpu-worker' : 'gpu-main',
    setImage: (source, maxSide) =>
      gpu.run(
        'setImage',
        { id, source, maxSide },
        { transfer: source instanceof ImageBitmap ? [source] : [], key: `image:${id}` },
      ),
    setParams: (params, interactive = true) => gpu.run('setParams', { id, params, interactive }).catch(noop),
    resize: (width, height) => gpu.run('resize', { id, width, height }, { key: `resize:${id}` }).catch(noop),
    exportImage: (options = {}) => gpu.run('exportImage', { id, ...options }),
    stats: () => gpu.run('stats', { id }),
    dispose: () => gpu.run('detach', { id }).catch(noop),
  };
}

export async function createImagePipeline(canvas, { caps, getGpu, pool, prefer = 'auto' }) {
  if (chooseImageBackend(caps, prefer) === 'gpu') {
    const gpu = await getGpu();
    if (gpu.mode !== 'none') return gpuHandle(canvas, gpu, caps);
  }
  return new CpuImagePipeline(canvas, pool);
}
