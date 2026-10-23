// autoNative(): everything the library does by itself in the browser, so apps don't have to.
// Called automatically by <NativeComputeProvider> and <Router>; safe to call more than once
// (the first call's options win, so call it yourself first to change them).
//
//   - adds native-feel.css to the page (unless it's already there)
//   - tells CSS how the user is interacting: html[data-nc-input="touch" | "mouse" | "keyboard"]
//   - fills gaps in older browsers with small JavaScript fallbacks:
//       * exact full-height screens without dvh units (sets --nc-vh)
//       * fade-in-on-scroll without scroll-driven animations (IntersectionObserver)
//   - lite mode (html[data-nc-lite]) on low-end devices, data-saver, or when the page keeps
//     dropping frames: expensive effects (blur, shadows, long animations) are turned down
//   - in development only: warns about accessibility and GPU-unfriendly CSS problems
import { nativeFeelCss } from '../styles/nativeFeelCss';

let started = false;
const cleanups = [];

function isDevelopment() {
  try {
    return process.env.NODE_ENV !== 'production'; // replaced by the bundler at build time
  } catch {
    return false;
  }
}

const supports = (rule) => typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports(rule);
const media = (query) => typeof matchMedia === 'function' && matchMedia(query).matches;
const listen = (target, type, fn, options) => {
  target.addEventListener(type, fn, options);
  cleanups.push(() => target.removeEventListener(type, fn, options));
};

function injectCss() {
  const root = document.documentElement;
  if (getComputedStyle(root).getPropertyValue('--nc-native-feel').trim()) return; // imported already
  if (document.getElementById('nc-native-feel')) return;
  const style = document.createElement('style');
  style.id = 'nc-native-feel';
  style.textContent = nativeFeelCss;
  document.head.prepend(style); // first, so the app's own styles come after it
}

function trackInput() {
  const root = document.documentElement;
  const set = (value) => {
    if (root.dataset.ncInput !== value) root.dataset.ncInput = value;
  };
  set(media('(pointer: coarse)') ? 'touch' : 'mouse');
  listen(window, 'pointerdown', (e) => set(e.pointerType === 'mouse' ? 'mouse' : 'touch'), {
    capture: true,
    passive: true,
  });
  listen(
    window,
    'keydown',
    (e) => {
      if (e.key === 'Tab' || e.key.startsWith('Arrow')) set('keyboard');
    },
    { capture: true },
  );
}

function viewportHeightFallback() {
  if (supports('height: 100dvh')) return;
  const update = () => document.documentElement.style.setProperty('--nc-vh', `${window.innerHeight / 100}px`);
  update();
  listen(window, 'resize', update, { passive: true });
  listen(window, 'orientationchange', update);
}

function revealFallback() {
  if (supports('animation-timeline: view()') || media('(prefers-reduced-motion: reduce)')) return;
  if (typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') return;
  document.documentElement.dataset.ncReveal = 'observer';
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute('data-nc-revealed', '');
        io.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px' },
  );
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches('.nc-reveal:not([data-nc-revealed])')) io.observe(node);
    for (const el of node.querySelectorAll?.('.nc-reveal:not([data-nc-revealed])') ?? []) io.observe(el);
  };
  scan(document.body);
  const mo = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(scan)));
  mo.observe(document.body, { childList: true, subtree: true });
  cleanups.push(() => {
    io.disconnect();
    mo.disconnect();
  });
}

function liteMode(setting) {
  const root = document.documentElement;
  const enable = () => {
    root.dataset.ncLite = '';
  };
  if (setting === false) return;
  if (setting === true) return enable();
  const nav = navigator;
  const lowEnd = (nav.hardwareConcurrency || 8) <= 2 || (nav.deviceMemory ?? 8) <= 2;
  if (lowEnd || nav.connection?.saveData || media('(prefers-reduced-transparency: reduce)')) return enable();
  // Dropping frames? Five long tasks (over 100 ms) within 10 seconds turns lite mode on.
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask'))
    return;
  let recent = [];
  const po = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < 100) continue;
      const now = performance.now();
      recent = [...recent.filter((t) => now - t < 10_000), now];
      if (recent.length >= 5) {
        enable();
        po.disconnect();
      }
    }
  });
  po.observe({ type: 'longtask', buffered: true });
  cleanups.push(() => po.disconnect());
}

function devChecks() {
  const seen = new Set();
  let timer;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      Promise.all([import('./a11yAudit'), import('../react/gpuCss')]).then(([a11y, gpu]) => {
        const all = [...a11y.auditA11y({ log: false }), ...gpu.auditGpuCss({ log: false })];
        const fresh = all.filter((p) => !seen.has(p.message));
        if (!fresh.length) return;
        fresh.forEach((p) => seen.add(p.message));
        console.groupCollapsed(`[native-compute] ${fresh.length} issue(s) to look at (development only)`);
        fresh.forEach((p) => console.warn(p.message, p.element ?? p.elements ?? ''));
        console.groupEnd();
      });
    }, 1500);
  };
  if (document.readyState === 'complete') run();
  else listen(window, 'load', run, { once: true });
  listen(window, 'nc:navigate', run); // after every <Router> navigation
  cleanups.push(() => clearTimeout(timer));
}

/**
 * options: { css: true, lite: 'auto' | true | false, devChecks: true in development }
 */
export function autoNative({ css = true, lite = 'auto', devChecks: checks = isDevelopment() } = {}) {
  if (started || typeof document === 'undefined') return;
  started = true;
  if (css) injectCss();
  trackInput();
  viewportHeightFallback();
  revealFallback();
  liteMode(lite);
  if (checks) devChecks();
}

/** Undo autoNative (mainly for tests). */
export function stopAutoNative() {
  cleanups.splice(0).forEach((fn) => fn());
  started = false;
}

/** True while lite mode is on (components use it to skip expensive effects). */
export const isLite = () => typeof document !== 'undefined' && 'ncLite' in document.documentElement.dataset;
