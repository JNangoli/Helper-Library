// A small router built for native feel. No dependencies.
//
//   const routes = [
//     { path: '/', component: Home, title: 'Home' },
//     { path: '/products', component: lazy(() => import('./Products')), loader: () => getProducts(), keepAlive: true },
//     { path: '/products/:id', component: lazy(() => import('./Product')), loader: ({ params }) => getProduct(params.id),
//       title: (data) => data.name },
//   ];
//   <Router routes={routes} layout={AppShell} notFound={NotFound} fallback={<Splash />} />
//
// What makes it feel native:
//   * the current screen stays until the next one (code + data) is ready: no blank flashes
//   * a newer tap cancels an older navigation
//   * screens animate with View Transitions (direction-aware: forward vs back), where supported
//   * data you've seen shows instantly and refreshes in the background
//   * back/forward restore the scroll position; keepAlive screens keep their state too
//   * title updates and focus moves to the new screen (screen readers announce it)
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { compileRoute, matchRoute } from './match';
import { RouteDataCache } from './dataCache';
import { applyHead } from './head.mjs';
import { autoNative } from '../core/auto';

const RouterContext = createContext(null);
const ScreenContext = createContext(null);

/** Code-split a screen: loads on first use, and early when a <Link> to it is touched or hovered. */
export function lazy(load) {
  let promise;
  let Component;
  const preload = () =>
    (promise ??= load().then((m) => {
      Component = m.default ?? m;
      return Component;
    }));
  function LazyScreen(props) {
    if (!Component) throw preload(); // Suspense: only on a cold first render
    return <Component {...props} />;
  }
  LazyScreen.preload = preload;
  return LazyScreen;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const slowNetwork = () => {
  const c = typeof navigator !== 'undefined' ? navigator.connection : undefined;
  return !!c && (c.saveData || /(^|-)2g$/.test(c.effectiveType ?? ''));
};
const newKey = () => Math.random().toString(36).slice(2, 10);

function toLocation(url, basename) {
  let pathname = url.pathname;
  if (basename && pathname.toLowerCase().startsWith(basename.toLowerCase()))
    pathname = pathname.slice(basename.length) || '/';
  return { pathname, search: url.search, hash: url.hash, href: url.href, id: pathname + url.search };
}

// Scroll positions per history entry (kept for the tab's lifetime).
const scrolls = new Map();
const SCROLL_KEY = 'native-compute:scroll';
try {
  for (const [k, v] of JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '[]')) scrolls.set(k, v);
} catch {
  /* storage unavailable */
}
function saveScroll(key) {
  if (!key) return;
  scrolls.set(key, window.scrollY);
  try {
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify([...scrolls].slice(-100)));
  } catch {
    /* storage unavailable */
  }
}

/** The head for a screen: route.head (object or (data, params, location) => object), plus route.title. */
export function routeHead(entry, notFoundHead) {
  if (!entry.match) return { title: 'Page not found', ...notFoundHead, robots: 'noindex' };
  if (entry.error) return { title: 'Something went wrong', robots: 'noindex' };
  const { route, params } = entry.match;
  const head = typeof route.head === 'function' ? route.head(entry.data, params, entry.location) : route.head;
  const title = typeof route.title === 'function' ? route.title(entry.data, params) : route.title;
  return { ...(title ? { title } : {}), ...head };
}

/**
 * For servers and prerendering: match a URL, load the screen's code and data.
 * Returns { status: 200 | 404 | 500, data, head, error }. Render <Router routes url={url}
 * initialData={data} /> with react-dom/server, put headToHtml(head) and serializeData(data)
 * into the page, and send it with `status`. In the browser, hydrate with the same
 * <Router routes initialData={window.__NC_DATA__} />.
 */
export async function loadRoute(routes, url, { basename = '', notFoundHead } = {}) {
  const loc = toLocation(new URL(url, 'http://localhost'), basename);
  const matched = matchRoute(routes.map(compileRoute), loc.pathname);
  const entry = { id: loc.id, location: loc, match: matched };
  if (matched) {
    try {
      await matched.route.component?.preload?.();
      entry.data = matched.route.loader
        ? await matched.route.loader({ params: matched.params, query: new URLSearchParams(loc.search), location: loc })
        : undefined;
    } catch (error) {
      entry.error = error;
    }
  }
  return {
    status: !matched ? 404 : entry.error ? 500 : 200,
    data: entry.data,
    error: entry.error,
    head: routeHead(entry, notFoundHead),
  };
}

/** Screen readers: move focus to the new screen's main heading (read aloud), or announce the title. */
function focusScreen(screen) {
  if (!screen) return;
  const heading = screen.querySelector('h1') ?? screen.querySelector('h2');
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.setAttribute('data-nc-focus-target', '');
    heading.focus({ preventScroll: true });
    return;
  }
  screen.focus({ preventScroll: true });
  announce(document.title);
}

let liveRegion;
/** Polite announcement for screen readers. */
export function announce(message) {
  if (typeof document === 'undefined' || !message) return;
  if (!liveRegion?.isConnected) {
    liveRegion = document.createElement('div');
    liveRegion.className = 'nc-sr-only';
    liveRegion.setAttribute('aria-live', 'polite');
    liveRegion.setAttribute('role', 'status');
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = '';
  setTimeout(() => {
    liveRegion.textContent = message; // changed after a tick so it's always read, even if repeated
  }, 50);
}

function SkipLink({ label }) {
  return (
    <a
      href="#nc-main"
      className="nc-skip"
      onClick={(e) => {
        e.preventDefault(); // focus the content without changing the URL
        const main = document.getElementById('nc-main');
        main?.focus({ preventScroll: true });
        main?.scrollIntoView();
      }}
    >
      {label}
    </a>
  );
}

function DefaultNotFound() {
  return <p role="alert">Page not found.</p>;
}

function DefaultError({ error }) {
  return <p role="alert">Something went wrong: {String(error?.message ?? error)}</p>;
}

const PassThrough = ({ children }) => children;

export function Router({
  routes,
  layout: Layout = PassThrough,
  notFound: NotFound = DefaultNotFound,
  error: ErrorScreen = DefaultError,
  fallback = null,
  transitions = true,
  keepAlive = 3,
  basename = '',
  siteUrl, // e.g. 'https://example.com': makes canonical and og:url absolute
  notFoundHead, // head for the not-found screen (always noindex)
  url, // server rendering: the URL being rendered
  initialData, // hydration / server rendering: the loader data from loadRoute
  skipLink = 'Skip to content', // keyboard users jump past the navigation; false to turn off
}) {
  const compiled = useMemo(() => routes.map(compileRoute), [routes]);
  const [cache] = useState(() => new RouteDataCache());
  const [view, setView] = useState(() => {
    // Server render (url) or hydration (initialData): the first screen is known right away,
    // so the HTML from the server and the first browser render match.
    const href = url ?? (initialData !== undefined && typeof window !== 'undefined' ? window.location.href : null);
    if (!href) return { screens: [], currentId: null };
    const loc = toLocation(new URL(href, 'http://localhost'), basename);
    const match = matchRoute(compiled, loc.pathname);
    const entry = { id: loc.id, location: loc, match, data: initialData };
    return { screens: [entry], currentId: entry.id, hydrated: true };
  });
  const [pending, setPending] = useState(null);
  const navId = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const entryKey = useRef(null); // history entry currently shown (for saving its scroll)
  const entryIndex = useRef(0); // its position, to tell back from forward
  const screenEls = useRef(new Map());
  const compiledRef = useRef(compiled);
  compiledRef.current = compiled;
  const optionsRef = useRef({ transitions, keepAlive, basename });
  optionsRef.current = { transitions, keepAlive, basename };
  const headRef = useRef({ siteUrl, notFoundHead });
  headRef.current = { siteUrl, notFoundHead };

  const go = useCallback(
    async (to, opts = {}) => {
      const { basename: base, transitions: animate, keepAlive: keep } = optionsRef.current;
      const url = new URL(typeof to === 'string' && to.startsWith('/') && base ? base + to : to, window.location.href);
      if (url.origin !== window.location.origin) {
        window.location.assign(url.href);
        return;
      }
      const loc = toLocation(url, base);
      const currentId = viewRef.current.currentId;

      // Same screen, different #anchor: just scroll.
      if (!opts.pop && !opts.initial && loc.id === currentId) {
        saveScroll(entryKey.current);
        const index = opts.replace ? entryIndex.current : entryIndex.current + 1;
        const key = opts.replace ? entryKey.current : newKey();
        window.history[opts.replace ? 'replaceState' : 'pushState']({ key, index }, '', url.href);
        entryKey.current = key;
        entryIndex.current = index;
        if (loc.hash) document.getElementById(decodeURIComponent(loc.hash.slice(1)))?.scrollIntoView();
        return;
      }

      const id = ++navId.current;
      const matched = matchRoute(compiledRef.current, loc.pathname);
      setPending(loc);
      let data;
      let error;
      try {
        const onFresh = (value) =>
          setView((v) => ({ ...v, screens: v.screens.map((s) => (s.id === loc.id ? { ...s, data: value } : s)) }));
        [, data] = await Promise.all([
          matched?.route.component?.preload?.(),
          matched ? cache.load(matched, loc, onFresh) : undefined,
        ]);
      } catch (err) {
        error = err;
      }
      if (id !== navId.current) return; // a newer navigation took over

      const entry = { id: loc.id, location: loc, match: matched, data, error };
      const apply = () => {
        if (!opts.pop) {
          if (!opts.initial) saveScroll(entryKey.current);
          const replace = opts.replace || opts.initial;
          const index = replace ? entryIndex.current : entryIndex.current + 1;
          const key = opts.initial ? (window.history.state?.key ?? newKey()) : newKey();
          window.history[replace ? 'replaceState' : 'pushState']({ key, index }, '', url.href);
          entryKey.current = key;
          entryIndex.current = index;
        }
        // Route head first; a screen's useHead (which runs during the render below) can then override it.
        applyHead(routeHead(entry, headRef.current.notFoundHead), {
          siteUrl: headRef.current.siteUrl,
          pathname: url.pathname,
        });
        flushSync(() => {
          setView((v) => {
            const kept = v.screens.filter((s) => s.id !== entry.id && s.match?.route.keepAlive);
            const reused = v.screens.find((s) => s.id === entry.id);
            const keptAlive = keep > 0 ? kept.slice(-keep) : [];
            return { screens: [...keptAlive, reused ? { ...reused, ...entry } : entry], currentId: entry.id };
          });
          setPending(null);
        });

        const saved = scrolls.get(entryKey.current);
        if ((opts.pop || opts.initial) && saved !== undefined)
          window.scrollTo(0, saved); // back/forward/reload
        else if (loc.hash) document.getElementById(decodeURIComponent(loc.hash.slice(1)))?.scrollIntoView();
        else if (opts.scroll !== false && !opts.initial) window.scrollTo(0, 0);
        if (!opts.initial) focusScreen(screenEls.current.get(entry.id));
        window.dispatchEvent(new CustomEvent('nc:navigate', { detail: { location: loc } }));
      };

      const direction = opts.pop ? opts.direction : opts.replace ? 'replace' : 'forward';
      if (animate && !opts.initial && document.startViewTransition && !reducedMotion()) {
        const root = document.documentElement;
        root.dataset.navDirection = direction;
        const transition = document.startViewTransition(apply);
        transition.finished.finally(() => {
          if (root.dataset.navDirection === direction) delete root.dataset.navDirection;
        });
      } else {
        apply();
      }
    },
    [cache],
  );

  // First screen + back/forward buttons.
  useEffect(() => {
    autoNative();
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    const state = window.history.state;
    entryKey.current = state?.key ?? null;
    entryIndex.current = state?.index ?? 0;
    if (viewRef.current.hydrated) {
      // Hydrated from server HTML: the screen and its data are already here. Just take over history.
      const key = state?.key ?? newKey();
      window.history.replaceState({ key, index: entryIndex.current }, '', window.location.href);
      entryKey.current = key;
    } else {
      go(window.location.href, { initial: true });
    }

    const onPop = (e) => {
      saveScroll(entryKey.current);
      const index = e.state?.index ?? 0;
      const direction = index < entryIndex.current ? 'back' : 'forward';
      entryKey.current = e.state?.key ?? null;
      entryIndex.current = index;
      go(window.location.href, { pop: true, direction });
    };
    const onHide = () => saveScroll(entryKey.current);
    window.addEventListener('popstate', onPop);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('pagehide', onHide);
    };
  }, [go]);

  /** Start loading a screen's code and data now (used by <Link> on touch/hover/visibility). */
  const prefetch = useCallback(
    (to) => {
      if (slowNetwork()) return; // respect data-saver and 2G
      const { basename: base } = optionsRef.current;
      const url = new URL(typeof to === 'string' && to.startsWith('/') && base ? base + to : to, window.location.href);
      if (url.origin !== window.location.origin) return;
      const loc = toLocation(url, base);
      const matched = matchRoute(compiledRef.current, loc.pathname);
      if (!matched) return;
      matched.route.component?.preload?.()?.catch(() => {});
      Promise.resolve(cache.load(matched, loc)).catch(() => {});
    },
    [cache],
  );

  const current = view.screens.find((s) => s.id === view.currentId);
  const api = useMemo(
    () => ({
      navigate: (to, opts) => go(to, opts),
      prefetch,
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      /** Reload the current screen's data (or forget a URL's data, or everything). */
      revalidate: (id) => {
        cache.invalidate(id);
        if (!id || id === viewRef.current.currentId) go(window.location.href, { replace: true, scroll: false });
      },
      location: current?.location ?? null,
      currentId: view.currentId,
      pending,
      basename,
      siteUrl,
      notFoundHead,
    }),
    [go, prefetch, cache, current, view.currentId, pending, basename, siteUrl, notFoundHead],
  );

  return (
    <RouterContext.Provider value={api}>
      {skipLink && <SkipLink label={skipLink} />}
      <Layout>
        <div id="nc-main" tabIndex={-1} style={{ outline: 'none' }} aria-busy={pending ? 'true' : undefined}>
          {!view.screens.length && fallback}
          {view.screens.map((screen) => {
            const Screen = screen.match?.route.component;
            let content;
            if (screen.error) content = <ErrorScreen error={screen.error} />;
            else if (!screen.match) content = <NotFound />;
            else content = <Screen params={screen.match.params} data={screen.data} location={screen.location} />;
            return (
              <div
                key={screen.id}
                hidden={screen.id !== view.currentId}
                tabIndex={-1}
                style={{ outline: 'none' }}
                ref={(el) => (el ? screenEls.current.set(screen.id, el) : screenEls.current.delete(screen.id))}
              >
                <ScreenContext.Provider value={screen}>
                  <Suspense fallback={fallback}>{content}</Suspense>
                </ScreenContext.Provider>
              </div>
            );
          })}
        </div>
      </Layout>
    </RouterContext.Provider>
  );
}

function useRouterContext() {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('Use this inside <Router>');
  return ctx;
}

/** { navigate(to, { replace, scroll }), prefetch(to), back(), forward(), revalidate(), location, pending } */
export const useRouter = () => useRouterContext();

/** The current location: { pathname, search, hash, query: URLSearchParams } */
export function useLocation() {
  const screen = useContext(ScreenContext);
  const router = useContext(RouterContext);
  const location = screen?.location ?? router?.location;
  return useMemo(() => location && { ...location, query: new URLSearchParams(location.search) }, [location]);
}

/** Route parameters of the screen this component is in, e.g. { id: '42' } for /products/:id */
export const useParams = () => useContext(ScreenContext)?.match?.params ?? {};

/** The loader's result for the screen this component is in. */
export const useLoaderData = () => useContext(ScreenContext)?.data;

/**
 * Set head tags from inside a screen (merged over the route's head), e.g. once data arrives:
 *   useHead({ title: `${cart.count} items · Shop`, robots: 'noindex' });
 * Applied while this screen is the one showing, and again when you come back to it.
 */
export function useHead(head) {
  const screen = useContext(ScreenContext);
  const router = useContext(RouterContext);
  const active = !!screen && router?.currentId === screen.id;
  const key = JSON.stringify(head ?? null);
  useEffect(() => {
    if (!active) return;
    applyHead(
      { ...routeHead(screen, router.notFoundHead), ...head },
      {
        siteUrl: router.siteUrl,
        pathname: (router.basename || '') + screen.location.pathname,
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
}

/** { state: 'idle' | 'loading', location }: where a navigation in progress is going. */
export function useNavigation() {
  const { pending } = useRouterContext();
  return { state: pending ? 'loading' : 'idle', location: pending };
}
