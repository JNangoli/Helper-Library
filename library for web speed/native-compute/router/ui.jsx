// Navigation UI: <Link>, <NavigationProgress>, <DelayedIndicator>.
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigation, useRouter } from './router';
import { whenIdle } from '../core/scheduler';

const HOVER_DELAY_MS = 60; // ignore the mouse just passing over a link

/**
 * <Link to="/products/42">: navigates without reloading the page and starts loading the next
 * screen early. prefetch: 'intent' (touch / hover / keyboard focus, default), 'viewport'
 * (when visible and the browser is idle), or 'none'. Ctrl/Cmd/middle-click, target and
 * download links behave like normal links.
 */
export function Link({
  to,
  replace,
  scroll,
  prefetch = 'intent',
  onClick,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onFocus,
  children,
  ...rest
}) {
  const router = useRouter();
  const location = useLocation();
  const ref = useRef(null);
  const hoverTimer = useRef(0);
  const done = useRef(false);

  const warm = () => {
    if (done.current || prefetch === 'none') return;
    done.current = true;
    router.prefetch(to);
  };
  useEffect(() => {
    done.current = false;
  }, [to]);

  useEffect(() => {
    if (prefetch !== 'viewport' || typeof IntersectionObserver === 'undefined') return;
    const el = ref.current;
    let cancelIdle = () => {};
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      cancelIdle = whenIdle(warm);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelIdle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetch, to]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const href = typeof to === 'string' && to.startsWith('/') && router.basename ? router.basename + to : to;
  // Compared without `window`, so links also render on a server.
  const targetPath = typeof href === 'string' ? href.split(/[?#]/)[0] : '';
  const current = !!location && targetPath === (router.basename || '') + location.pathname;

  return (
    <a
      ref={ref}
      href={href}
      aria-current={current ? 'page' : undefined}
      onPointerEnter={(e) => {
        onPointerEnter?.(e);
        if (e.pointerType === 'mouse') hoverTimer.current = setTimeout(warm, HOVER_DELAY_MS);
      }}
      onPointerLeave={(e) => {
        onPointerLeave?.(e);
        clearTimeout(hoverTimer.current);
      }}
      onPointerDown={(e) => {
        onPointerDown?.(e);
        warm(); // a finger touching the link: ~100-300 ms head start before the click
      }}
      onFocus={(e) => {
        onFocus?.(e);
        warm();
      }}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if ((rest.target && rest.target !== '_self') || rest.download !== undefined) return;
        if (new URL(href, window.location.href).origin !== window.location.origin) return;
        e.preventDefault();
        router.navigate(to, { replace, scroll });
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/**
 * true only if `active` lasts longer than `delay` ms, and then stays true for at least
 * `minDuration` ms, so fast operations never flash a spinner and slow ones don't flicker.
 */
export function useDelayedFlag(active, { delay = 300, minDuration = 400 } = {}) {
  const [shown, setShown] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (active && !shown) {
      const timer = setTimeout(() => {
        since.current = performance.now();
        setShown(true);
      }, delay);
      return () => clearTimeout(timer);
    }
    if (!active && shown) {
      const left = minDuration - (performance.now() - since.current);
      const timer = setTimeout(() => setShown(false), Math.max(0, left));
      return () => clearTimeout(timer);
    }
  }, [active, shown, delay, minDuration]);
  return shown;
}

/** Renders children only for slow operations: <DelayedIndicator active={loading}><Spinner /></DelayedIndicator> */
export function DelayedIndicator({ active, delay, minDuration, children }) {
  return useDelayedFlag(active, { delay, minDuration }) ? children : null;
}

/** A thin top progress bar that appears only when a navigation is slow. GPU-only animation (transform/opacity). */
export function NavigationProgress({ delay = 250, color = 'currentColor', height = 3, label = 'Loading page' }) {
  const { state } = useNavigation();
  const loading = state === 'loading';
  const visible = useDelayedFlag(loading, { delay, minDuration: 300 });
  const [phase, setPhase] = useState('idle'); // idle -> start -> running -> done -> idle

  useEffect(() => {
    if (visible) {
      setPhase('start');
      const frame = requestAnimationFrame(() => setPhase('running'));
      return () => cancelAnimationFrame(frame);
    }
    setPhase((p) => (p === 'idle' ? p : 'done'));
    const timer = setTimeout(() => setPhase('idle'), 450);
    return () => clearTimeout(timer);
  }, [visible]);

  const scale = { idle: 0, start: 0, running: 0.85, done: 1 }[phase];
  const transition = {
    running: 'transform 8s cubic-bezier(0.1, 0.7, 0.2, 1)', // fast at first, then crawls: feels like progress
    done: 'transform 200ms ease-out, opacity 250ms ease-out 150ms',
  }[phase];

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-hidden={phase === 'idle' || phase === 'done'}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height,
        background: color,
        transformOrigin: '0 50%',
        transform: `scaleX(${scale})`,
        opacity: phase === 'idle' || phase === 'done' ? 0 : 1,
        transition,
        pointerEvents: 'none',
        zIndex: 2147483647,
      }}
    />
  );
}
