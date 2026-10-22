// Shared React hooks, also useful in your own components.
import { useEffect, useRef, useState } from 'react';
import { isAbort } from '../core/util';

const make = (status, data, error, progress) => ({ status, data, error, progress, isPending: status === 'pending' });

/** Cancellation is expected and never shown as an error; a timeout is a real failure. */
const reportable = (err) => !isAbort(err) || err.reason === 'timeout';

/**
 * Runs start({ signal, onProgress }) whenever deps change and aborts the previous run (latest wins).
 * start returns a promise, or nothing to skip. Returns { status, data, error, progress, isPending };
 * the last result stays in `data` while a newer one is pending, so nothing flickers.
 */
export function useLatestTask(start, deps, debounceMs = 0) {
  const [state, setState] = useState(() => make('idle'));
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    const controller = new AbortController();
    let shown = -1;
    const onProgress = (value) => {
      const pct = Math.round(value * 100);
      if (pct === shown) return; // at most 100 re-renders per run
      shown = pct;
      setState((s) => (s.status === 'pending' ? { ...s, progress: value } : s));
    };
    const go = () => {
      let promise;
      try {
        promise = startRef.current({ signal: controller.signal, onProgress });
      } catch (error) {
        setState((s) => make('error', s.data, error));
        return;
      }
      if (!promise) {
        setState((s) => (s.status === 'idle' ? s : make('idle', s.data)));
        return;
      }
      setState((s) => make('pending', s.data));
      promise.then(
        (data) => !controller.signal.aborted && setState(make('success', data)),
        (error) => !controller.signal.aborted && reportable(error) && setState((s) => make('error', s.data, error)),
      );
    };
    let timer;
    if (debounceMs > 0) timer = setTimeout(go, debounceMs);
    else go();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounceMs, ...deps]);

  return state;
}

/** Imperative version for event handlers: run(...) never rejects; errors land in state. */
export function useAsyncAction(runFn, { latestOnly = true } = {}) {
  const [state, setState] = useState(() => make('idle'));
  const active = useRef(new Set());

  useEffect(() => {
    const controllers = active.current;
    return () => controllers.forEach((c) => c.abort());
  }, []);

  const cancel = () => {
    active.current.forEach((c) => c.abort());
    active.current.clear();
    setState((s) => (s.status === 'pending' ? make('idle', s.data) : s));
  };

  const runRef = useRef(null);
  runRef.current = async (...args) => {
    if (latestOnly) cancel();
    const controller = new AbortController();
    active.current.add(controller);
    setState((s) => make('pending', s.data, undefined, 0));
    const onProgress = (p) => setState((s) => (s.status === 'pending' ? { ...s, progress: p } : s));
    try {
      const data = await runFn({ signal: controller.signal, onProgress }, ...args);
      active.current.delete(controller);
      setState(make(active.current.size ? 'pending' : 'success', data));
      return data;
    } catch (error) {
      active.current.delete(controller);
      if (reportable(error)) setState((s) => make('error', s.data, error));
      return undefined;
    }
  };
  // Stable functions: safe to pass to children or list in effect deps.
  const [stable] = useState(() => ({ run: (...a) => runRef.current(...a), cancel: () => cancelRef.current() }));
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  return { ...state, ...stable };
}

/** [ref, near]: near is true while the element is within `margin` of the screen. */
export function useNearScreen(margin = '600px 0px') {
  const ref = useRef(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: margin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [margin]);
  return [ref, near];
}

/** [ref, { width, height }]: the element's content size, kept up to date. */
export function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}
