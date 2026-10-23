// GPU-friendly CSS helpers. The browser can move and fade layers on the GPU (compositor) without
// redoing layout or repainting, but only for `transform` and `opacity`, and every GPU layer
// costs memory. These helpers make the fast path the easy default.
import { useEffect, useRef } from 'react';

/**
 * Promote an element to its own GPU layer only while it's animating, then release it.
 * Permanent will-change wastes GPU memory (a real problem on cheap phones).
 *
 *   const ref = useWillChange(isDragging || isOpen, 'transform');
 *   <div ref={ref} style={{ transform: `translateX(${x}px)` }} />
 *
 * releaseMs keeps the layer a little after `active` turns false, so an ending transition stays smooth.
 */
export function useWillChange(active, value = 'transform', { releaseMs = 300 } = {}) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (active) {
      el.style.willChange = value;
      return;
    }
    const timer = setTimeout(() => {
      if (el.style.willChange === value) el.style.willChange = '';
    }, releaseMs);
    return () => clearTimeout(timer);
  }, [active, value, releaseMs]);
  return ref;
}

/**
 * A section the browser skips rendering while it's off screen (content-visibility: auto).
 * Often the single biggest win on long pages. estimatedHeight keeps the scrollbar stable before
 * the section is first rendered; afterwards the browser remembers its real size.
 * Browsers without content-visibility simply render it normally.
 */
export function LazySection({ as: Tag = 'section', estimatedHeight = 600, style, children, ...rest }) {
  return (
    <Tag style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${estimatedHeight}px`, ...style }} {...rest}>
      {children}
    </Tag>
  );
}

// Properties that force layout on every animation frame (the browser can't hand them to the GPU).
const LAYOUT =
  /^(width|height|top|left|right|bottom|inset|margin|padding|border(-\w+)?-width|font-size|line-height|min-|max-|flex-basis|grid-template|gap)/;

const animatedProperties = (animation) => {
  if (animation.transitionProperty) return [animation.transitionProperty]; // CSS transition
  const keyframes = animation.effect?.getKeyframes?.() ?? [];
  const props = new Set();
  for (const frame of keyframes) {
    for (const key of Object.keys(frame)) {
      if (!['offset', 'easing', 'composite', 'computedOffset'].includes(key)) props.add(key);
    }
  }
  return [...props].map((p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
};

const describe = (el) => {
  if (!el || el.nodeType !== 1) return String(el);
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
};

/**
 * Development check for GPU-unfriendly CSS. Returns a list of problems (and logs them):
 *   - animations/transitions on layout properties (use transform/opacity instead)
 *   - too many elements with will-change (each one is a GPU layer held in memory)
 *   - many blur / backdrop-filter effects (expensive even on the GPU, especially on phones)
 * Scans at most `maxElements` elements, so it stays quick. Don't run it in production.
 */
export function auditGpuCss({
  root = document.body,
  maxElements = 5000,
  maxLayers = 30,
  maxBlurs = 10,
  log = true,
} = {}) {
  const problems = [];

  if (typeof document.getAnimations === 'function') {
    for (const animation of document.getAnimations()) {
      const slow = animatedProperties(animation).filter((p) => LAYOUT.test(p));
      if (slow.length) {
        problems.push({
          kind: 'layout-animation',
          element: animation.effect?.target,
          message: `${describe(animation.effect?.target)} animates ${slow.join(', ')}: use transform / opacity instead`,
        });
      }
    }
  }

  const elements = root.querySelectorAll('*');
  const layers = [];
  const blurs = [];
  const count = Math.min(elements.length, maxElements);
  for (let i = 0; i < count; i++) {
    const style = getComputedStyle(elements[i]);
    if (style.willChange && style.willChange !== 'auto') layers.push(elements[i]);
    if (/blur\(/.test(style.filter) || (style.backdropFilter && style.backdropFilter !== 'none'))
      blurs.push(elements[i]);
  }
  if (layers.length > maxLayers) {
    problems.push({
      kind: 'too-many-layers',
      elements: layers,
      message: `${layers.length} elements have will-change (over ${maxLayers}); add it only while animating (useWillChange)`,
    });
  }
  if (blurs.length > maxBlurs) {
    problems.push({
      kind: 'many-blurs',
      elements: blurs,
      message: `${blurs.length} elements use blur / backdrop-filter (over ${maxBlurs}); these are costly on phones`,
    });
  }

  if (log && problems.length) {
    console.groupCollapsed(`[native-compute] ${problems.length} GPU/CSS issue(s)`);
    problems.forEach((p) => console.warn(p.message, p.element ?? p.elements));
    console.groupEnd();
  }
  return problems;
}

/** Re-run auditGpuCss every few seconds while `enabled`. Use in development only. */
export function useGpuCssAudit(enabled, { intervalMs = 5000, ...options } = {}) {
  const seen = useRef(new Set());
  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      const fresh = auditGpuCss({ ...options, log: false }).filter((p) => !seen.current.has(p.message));
      fresh.forEach((p) => {
        seen.current.add(p.message);
        console.warn(`[native-compute] ${p.message}`, p.element ?? p.elements);
      });
    };
    const first = setTimeout(run, 1000);
    const timer = setInterval(run, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs]);
}
