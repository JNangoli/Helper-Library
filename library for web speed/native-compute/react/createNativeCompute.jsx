// React bindings. Call createNativeCompute({ createWorker }) once; you get a Provider and hooks.
//   useTask / useAction    run one of your worker tasks (declarative / from event handlers)
//   useCompute             the engine picks page, worker, all workers or GPU, and learns
//   <FastImage>            fast image display: thumbnails made in workers, cached across visits
//   useDataView            search / filter / sort any rows; pair with <VirtualList>
//   useImagePipeline       live photo editing on the GPU, or CPU workers when that's better
// Add `cache: true` to useCompute / useTask to reuse results for the same input.
// GPU code is loaded on first use, so apps that never need it never download it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { WorkerPool } from '../core/worker-pool';
import { detectCapabilities } from '../core/capabilities';
import { whenIdle } from '../core/scheduler';
import { noop } from '../core/util';
import { Memo, cached, idOf, keyOf } from '../core/memo';
import { prepareRows } from '../data/query';
import { DEFAULT_IMAGE_PARAMS } from '../gpu/params';
import { Engine } from '../smart/engine';
import { createImagePipeline } from '../image/pipeline';
import { createImageLoader } from '../image/imageLoader';
import { useAsyncAction, useLatestTask, useNearScreen } from './hooks';

const EMPTY = new Uint32Array(0);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Exact device-pixel size where supported (Chrome/Firefox), DPR-rounded elsewhere; capped at 4096. */
function observeDevicePixels(canvas, onSize) {
  const observer = new ResizeObserver(([entry]) => {
    const exact = entry.devicePixelContentBoxSize?.[0];
    const dpr = window.devicePixelRatio || 1;
    const w = exact ? exact.inlineSize : entry.contentRect.width * dpr;
    const h = exact ? exact.blockSize : entry.contentRect.height * dpr;
    const cap = Math.min(1, 4096 / Math.max(w, h, 1));
    onSize(Math.max(1, Math.round(w * cap)), Math.max(1, Math.round(h * cap)));
  });
  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas);
  }
  return observer;
}

// Image pipelines per <canvas>, so StrictMode's mount/unmount/mount reuses instead of recreating
// (a canvas handed to a GPU worker can't be handed over twice).
const pipelines = new WeakMap();

export function createNativeCompute({ prewarm = true, ...poolOptions }) {
  const Context = createContext(null);

  function NativeComputeProvider({ children }) {
    const [pool] = useState(() => new WorkerPool(poolOptions));
    const [caps, setCaps] = useState(null);
    const gpu = useRef(null);
    const disposeTimer = useRef(undefined);
    const getGpu = useCallback(
      () =>
        (gpu.current ??= Promise.all([import('../gpu/GpuClient'), detectCapabilities()]).then(
          ([m, c]) => new m.GpuClient(c),
        )),
      [],
    );
    const [engine] = useState(() => new Engine({ pool, getGpu, getCaps: detectCapabilities }));
    const [images] = useState(() => createImageLoader(pool));
    const [taskCache] = useState(() => new Memo(200));

    useEffect(() => {
      clearTimeout(disposeTimer.current); // StrictMode remount: keep workers alive
      let alive = true;
      detectCapabilities().then((c) => alive && setCaps(c));
      const cancelIdle = prewarm ? whenIdle(() => pool.prewarm()) : noop;
      const onVisibility = () => {
        const visible = document.visibilityState === 'visible';
        gpu.current?.then((g) => g.run('setVisible', { visible })).catch(noop); // no rendering in background tabs
      };
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        alive = false;
        cancelIdle();
        document.removeEventListener('visibilitychange', onVisibility);
        disposeTimer.current = setTimeout(() => {
          images.clear();
          pool.terminate();
          gpu.current?.then((g) => g.dispose()).catch(noop);
          gpu.current = null;
        }, 0);
      };
    }, [pool, images]);

    const value = useMemo(
      () => ({ pool, caps, getGpu, engine, images, taskCache }),
      [pool, caps, getGpu, engine, images, taskCache],
    );
    return <Context.Provider value={value}>{children}</Context.Provider>;
  }

  function useCtx() {
    const ctx = useContext(Context);
    if (!ctx) throw new Error('Wrap your app in <NativeComputeProvider>');
    return ctx;
  }

  /** The worker pool, e.g. for pool.run(...) or pool.broadcast(...) outside React state. */
  const useWorkerPool = () => useCtx().pool;

  /** Device capabilities (null until detected, which takes a few ms). */
  const useCapabilities = () => useCtx().caps;

  /** The engine: engine.explain(op, input), engine.calibrate(...), engine.reset(), engine.subscribe(fn). */
  const useEngine = () => useCtx().engine;

  /** The engine's last `limit` decisions (for a status line or dev panel). */
  function useEngineLog(limit = 8) {
    const engine = useEngine();
    const [log, setLog] = useState([]);
    useEffect(() => engine.subscribe((d) => setLog((l) => [d, ...l].slice(0, limit))), [engine, limit]);
    return log;
  }

  /**
   * Run a worker task whenever deps change; the previous run is cancelled.
   * factory returns { payload, transfer? } or nothing to skip.
   * options: { debounceMs, timeoutMs, cache }
   */
  function useTask(type, factory, deps, { debounceMs = 0, timeoutMs, cache } = {}) {
    const { pool, taskCache } = useCtx();
    return useLatestTask(
      ({ signal, onProgress }) => {
        const input = factory();
        if (!input) return null;
        if (cache)
          return cached(taskCache, `${type}|${keyOf(input.payload)}`, () =>
            pool.run(type, input.payload, { timeoutMs }),
          );
        return pool.run(type, input.payload, { transfer: input.transfer, signal, onProgress, timeoutMs });
      },
      [pool, type, timeoutMs, cache, ...deps],
      debounceMs,
    );
  }

  /** Run a worker task from event handlers: const { run, cancel, data, isPending } = useAction('task'). */
  function useAction(type, { latestOnly = true, timeoutMs } = {}) {
    const { pool } = useCtx();
    return useAsyncAction(
      ({ signal, onProgress }, payload, transfer) =>
        pool.run(type, payload, { transfer, signal, timeoutMs, onProgress }),
      { latestOnly },
    );
  }

  /**
   * The engine picks where this runs (page, worker, all workers, GPU) and learns from every run.
   * `data` is the result; `decision` says where it ran, how long it took and why.
   * options: { prefer, force, precision: 'high', cache, debounceMs }
   */
  function useCompute(op, factory, deps, { debounceMs = 0, prefer, force, precision, cache } = {}) {
    const { engine } = useCtx();
    const state = useLatestTask(
      ({ signal }) => {
        const input = factory();
        return input ? engine.run(op, input, { signal, prefer, force, precision, cache }) : null;
      },
      [engine, op, prefer, force, precision, cache, ...deps],
      debounceMs,
    );
    const run = state.data;
    return {
      ...state,
      data: run?.value,
      decision: run && { backend: run.backend, ms: run.ms, reason: run.reason, options: run.options },
    };
  }

  /**
   * Fast image from a URL, File or Blob. Starts only near the screen, shows a tiny blurred
   * placeholder, then a display-sized copy made in a worker. width/height are CSS pixels.
   */
  function useFastImage(source, { width, height, fit = 'cover' } = {}) {
    const { images } = useCtx();
    const [ref, near] = useNearScreen();
    const [value, setValue] = useState(null);

    useEffect(() => setValue(null), [source]);
    useEffect(() => {
      if (!near || !source || !width || !height) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const { key, promise, value: ready } = images.acquire(source, { width: width * dpr, height: height * dpr, fit });
      let alive = true;
      if (ready) setValue(ready);
      else promise.then((v) => alive && setValue(v), noop);
      return () => {
        alive = false;
        images.release(key); // scrolled away before it finished: cancelled
      };
    }, [images, near, source, width, height, fit]);

    return {
      ref,
      src: value?.src,
      placeholder: value?.placeholder,
      cached: !!value?.cached,
      fallback: !!value?.fallback,
    };
  }

  /** <FastImage src={urlOrFile} width={240} height={160} alt="" fit="cover" /> */
  function FastImage({ src, width, height, alt = '', fit = 'cover', className, style, ...rest }) {
    const image = useFastImage(src, { width, height, fit });
    const [shown, setShown] = useState(false);
    useEffect(() => setShown(false), [image.src]);
    const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit };
    return (
      <div
        ref={image.ref}
        className={className}
        style={{ position: 'relative', overflow: 'hidden', aspectRatio: `${width} / ${height}`, ...style }}
      >
        {image.placeholder && (
          <img
            src={image.placeholder}
            alt=""
            aria-hidden="true"
            style={{ ...fill, filter: 'blur(12px)', transform: 'scale(1.08)' }}
          />
        )}
        {image.src && (
          <img
            src={image.src}
            alt={alt}
            decoding="async"
            onLoad={() => setShown(true)}
            style={{
              ...fill,
              opacity: shown || image.cached ? 1 : 0,
              transition: reducedMotion() ? undefined : 'opacity 200ms ease-out',
            }}
            {...rest}
          />
        )}
      </div>
    );
  }

  /**
   * Search / filter / sort any array of objects (query format: data/query.js).
   * Small arrays run on the page; big ones are loaded into ONE worker once, and each query then
   * sends only the query. Returns { indices, count, isPending, decision }: render rows[indices[i]].
   */
  function useDataView(rows, query = {}, { searchKeys, debounceMs = 0, inlineLimit = 20_000 } = {}) {
    const { pool } = useCtx();
    const keysId = searchKeys ? searchKeys.join('|') : '';
    const key = useMemo(() => (rows ? `view:${idOf(rows)}:${keysId}` : null), [rows, keysId]);
    const prepared = useMemo(
      () => (rows && rows.length <= inlineLimit ? prepareRows(rows, searchKeys) : null),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [rows, keysId, inlineLimit],
    );
    const [loadedKey, setLoadedKey] = useState(null);

    useEffect(() => {
      if (!rows || rows.length < 2000) return; // tiny lists never need a worker
      let alive = true;
      // replay: if that worker ever crashes, the rows are reloaded on its replacement.
      pool
        .run('viewLoad', { key, rows, searchKeys }, { affinity: key, replay: true })
        .then(() => alive && setLoadedKey(key), noop);
      return () => {
        alive = false;
        pool
          .run('viewDrop', { key }, { affinity: key })
          .catch(noop)
          .finally(() => pool.forget(key));
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pool, key]);

    const loaded = loadedKey === key;
    const result = useCompute(
      'dataView',
      () => rows && (prepared || loaded) && { key, count: rows.length, prepared, loaded, query },
      [key, prepared, loaded, keyOf(query)],
      { debounceMs },
    );
    const indices = result.data ?? EMPTY;
    return {
      indices,
      count: indices.length,
      isPending: result.isPending,
      decision: result.decision,
      error: result.error,
    };
  }

  /**
   * Live image editing on a <canvas>: GPU in a worker, GPU on the page, or CPU workers, picked
   * automatically (prefer: 'auto' | 'gpu' | 'cpu'). Give the <canvas> key={prefer} when switching.
   */
  function useImagePipeline({ maxSide, prefer = 'auto', initial } = {}) {
    const { pool, getGpu } = useCtx();
    const canvasRef = useRef(null);
    const handleRef = useRef(null);
    const sourceRef = useRef(null);
    const [params, setParamsState] = useState(() => ({ ...DEFAULT_IMAGE_PARAMS, ...initial }));
    const paramsRef = useRef(params);
    const pending = useRef(null);
    const frame = useRef(0);
    const [status, setStatus] = useState({ state: 'idle' });

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      let entry = pipelines.get(canvas);
      if (entry) clearTimeout(entry.disposeTimer);
      else {
        let observer;
        let disposed = false;
        const ready = detectCapabilities().then(async (caps) => {
          const handle = await createImagePipeline(canvas, { caps, getGpu, pool, prefer });
          if (!disposed) observer = observeDevicePixels(canvas, (w, h) => handle.resize(w, h));
          return handle;
        });
        ready.catch(noop);
        entry = {
          ready,
          dispose() {
            disposed = true;
            observer?.disconnect();
            ready.then((h) => h.dispose()).catch(noop);
          },
        };
        pipelines.set(canvas, entry);
      }
      const current = entry;
      let alive = true;
      setStatus((s) => ({ ...s, state: 'starting' }));
      current.ready.then(
        async (handle) => {
          if (!alive) return;
          handleRef.current = handle;
          handle.setParams(paramsRef.current, false);
          setStatus((s) => ({ ...s, state: 'ready', mode: handle.mode }));
          if (sourceRef.current) {
            // switched backend (new canvas): bring the current photo along
            const size = await handle.setImage(sourceRef.current, maxSide).catch(noop);
            if (alive && size) setStatus((s) => ({ ...s, image: size }));
          }
        },
        (error) => alive && setStatus({ state: 'unsupported', error }),
      );
      return () => {
        alive = false;
        handleRef.current = null;
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        current.disposeTimer = setTimeout(() => {
          pipelines.delete(canvas);
          current.dispose();
        }, 0);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getGpu, pool, prefer]);

    /** Coalesced to one update per display frame, however fast the slider fires. */
    const setParams = useCallback((patch) => {
      paramsRef.current = { ...paramsRef.current, ...patch };
      setParamsState(paramsRef.current);
      pending.current = { ...pending.current, ...patch };
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const next = pending.current;
        pending.current = null;
        if (next) handleRef.current?.setParams(next, true);
      });
    }, []);

    const reset = useCallback(() => setParams(DEFAULT_IMAGE_PARAMS), [setParams]);

    const setImage = useCallback(
      async (source) => {
        const handle = handleRef.current;
        if (!handle) throw new Error('The image editor is still starting');
        if (source instanceof Blob) sourceRef.current = source;
        const input =
          source instanceof Blob || source instanceof ImageBitmap ? source : await createImageBitmap(source);
        const size = await handle.setImage(input, maxSide);
        setStatus((s) => ({ ...s, image: size }));
        return size;
      },
      [maxSide],
    );

    const exportImage = useCallback(async (opts) => {
      if (!handleRef.current) throw new Error('No image editor');
      return handleRef.current.exportImage(opts);
    }, []);

    const getStats = useCallback(async () => handleRef.current?.stats() ?? null, []);

    return { canvasRef, params, setParams, reset, setImage, exportImage, getStats, ...status };
  }

  return {
    NativeComputeProvider,
    useWorkerPool,
    useCapabilities,
    useEngine,
    useEngineLog,
    useTask,
    useAction,
    useCompute,
    useFastImage,
    FastImage,
    useDataView,
    useImagePipeline,
  };
}
