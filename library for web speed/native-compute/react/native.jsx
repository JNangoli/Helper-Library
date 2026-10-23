// Native-style components built on modern CSS (styles/native-feel.css) with very little JavaScript.
import { Children, useEffect, useRef, useState } from 'react';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// Can the browser keep a closing <dialog> on screen while it animates? (Chrome can; Safari and Firefox can't yet.)
const nativeExitAnimation = () => typeof CSS !== 'undefined' && CSS.supports?.('overlay: auto');

/**
 * Bottom sheet, like iOS/Android: slides up, dims the page, swipe down (or tap outside, or Esc) to close.
 * Built on <dialog>, so focus is trapped inside and the rest of the page is inert for screen readers.
 * Has a Close button for screen-reader and keyboard users (closeLabel={false} hides it).
 *
 *   <Sheet open={open} onClose={() => setOpen(false)} label="Filters">...</Sheet>
 */
export function Sheet({ open, onClose, label, closeLabel = 'Close', children, className = '', ...rest }) {
  const ref = useRef(null);
  const drag = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (dialog.showModal) dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      const close = () => {
        dialog.removeAttribute('data-nc-closing');
        if (dialog.close) dialog.close();
        else dialog.removeAttribute('open');
      };
      if (nativeExitAnimation() || reducedMotion()) return close();
      // Slide down first, then close (so it looks the same in every browser).
      dialog.setAttribute('data-nc-closing', '');
      const timer = setTimeout(close, 320);
      dialog.addEventListener('transitionend', close, { once: true });
      return () => clearTimeout(timer);
    }
  }, [open]);

  const onPointerDown = (e) => {
    const dialog = ref.current;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startY: e.clientY, startTime: performance.now(), dy: 0, frame: 0 };
    dialog.classList.add('nc-dragging');
  };
  const onPointerMove = (e) => {
    const state = drag.current;
    if (!state) return;
    state.dy = Math.max(0, e.clientY - state.startY); // only downwards
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      ref.current.style.transform = `translateY(${state.dy}px)`; // GPU-only: follows the finger
    });
  };
  const onPointerUp = () => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    cancelAnimationFrame(state.frame);
    const dialog = ref.current;
    const velocity = state.dy / Math.max(1, performance.now() - state.startTime); // px per ms
    dialog.classList.remove('nc-dragging');
    dialog.style.transform = ''; // CSS animates from here: back up, or away if closing
    if (state.dy > dialog.offsetHeight * 0.3 || velocity > 0.6) onClose?.();
  };

  return (
    <dialog
      ref={ref}
      aria-label={label}
      className={`nc-sheet ${className}`}
      onCancel={(e) => {
        e.preventDefault(); // Esc: let the app decide via onClose
        onClose?.();
      }}
      onClick={(e) => {
        if (e.target !== ref.current) return;
        const r = ref.current.getBoundingClientRect();
        const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (outside) onClose?.(); // tap on the dimmed backdrop
      }}
      {...rest}
    >
      <div className="nc-sheet-header">
        <div
          className="nc-sheet-handle"
          aria-hidden="true"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {closeLabel && (
          <button type="button" className="nc-sheet-close" aria-label={closeLabel} onClick={() => onClose?.()}>
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}

/**
 * Swipeable pages with scroll-snap: the browser does the swiping physics (momentum, snapping),
 * so it feels native on every device. Arrow keys work when focused; dots show and pick the page.
 *
 *   <Carousel label="Photos" peek={24}>{photos.map((p) => <img key={p.id} src={p.src} alt={p.alt} />)}</Carousel>
 */
export function Carousel({
  children,
  label = 'Carousel',
  dots = true,
  peek = 0,
  gap,
  onIndexChange,
  className = '',
  style,
}) {
  const track = useRef(null);
  const [index, setIndex] = useState(0);
  const slides = Children.toArray(children);
  const count = slides.length;

  useEffect(() => {
    const el = track.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const i = Number(entry.target.dataset.index);
          setIndex(i);
          onIndexChange?.(i);
        }
      },
      { root: el, threshold: 0.6 },
    );
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [count, onIndexChange]);

  const goTo = (i) => {
    const el = track.current;
    const target = el?.children[Math.max(0, Math.min(count - 1, i))];
    if (!target) return;
    el.scrollTo({ left: target.offsetLeft - el.children[0].offsetLeft, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };

  return (
    <div
      className={`nc-carousel ${className}`}
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      style={{ '--nc-peek': `${peek}px`, ...(gap !== undefined ? { '--nc-gap': `${gap}px` } : {}), ...style }}
    >
      <div
        ref={track}
        className="nc-snap-x nc-snap-one nc-carousel-track"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') goTo(index + 1);
          else if (e.key === 'ArrowLeft') goTo(index - 1);
          else return;
          e.preventDefault();
        }}
      >
        {slides.map((slide, i) => (
          <div key={i} data-index={i} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${count}`}>
            {slide}
          </div>
        ))}
      </div>
      {dots && count > 1 && (
        <div className="nc-carousel-dots">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Go to slide ${i + 1}`}
              aria-current={i === index}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
