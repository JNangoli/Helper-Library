# native-compute

A drop-in speed and native-feel layer for React apps. Heavy work runs in background threads (Web Workers) or on
the GPU, so the page never freezes; big lists, images, files and PDFs get fast paths; and a small
engine learns, per device, the fastest place to run each job.

- Plain JavaScript, no dependencies (the PDF add-on needs PDF.js).
- About 24 KB gzipped at startup for everything, including the native-feel CSS and the automatic layer (less if you use only part of it). GPU code, PDF.js and the workers are separate files that load only when used.
- React 18+. The core (`WorkerPool`, `Engine`, `defineOp`) also works without React.

---

## What happens automatically

You don't set any of this up. It starts with `<NativeComputeProvider>` or `<Router>`:

| Automatically | How |
|---|---|
| **Native-feel CSS is added** | No import needed (importing `styles/native-feel.css` yourself is optional, e.g. with server rendering so it's in the first paint) |
| **Missing browser features are filled in** | Older phones without `dvh` get exact full-height screens via a measured fallback. Browsers without scroll-driven animations get `nc-reveal` through an IntersectionObserver. Safari and Firefox get the sheet's closing animation in JavaScript. Frosted bars become solid where blur isn't supported |
| **Lite mode on weaker devices** | On 2-core / 2 GB devices, with data-saver on, with "reduce transparency" on, or when the page keeps dropping frames, blur, shadows and long animations are turned down (`html[data-nc-lite]`) |
| **Knows how the user is interacting** | `html[data-nc-input="touch" \| "mouse" \| "keyboard"]`, for your own CSS |
| **Accessibility** | A skip-to-content link. Focus moves to each new screen's heading, and the title is announced if there's none. Sheets get a Close button. Lists tell screen readers "row 5 of 300,000" and keep focus while scrolling. PDF text is readable and selectable. Large touch targets. High-contrast mode support. Reduced motion respected everywhere |
| **Device-aware work** | The engine picks page, worker(s) or GPU per job, images load near the screen, prefetching pauses on slow connections |
| **Problems flagged while you develop** | In development builds, the console lists missing alt text, unlabeled buttons and fields, tap targets under 24 px, positive `tabindex`, duplicate ids, a missing `lang`, slow CSS animations, and too many GPU layers. Production builds stay silent, and the check isn't even downloaded |

To change any of it, call `autoNative()` yourself before rendering (the first call wins):

```js
import { autoNative } from './native-compute';
autoNative({ css: true, lite: 'auto' /* or true / false */, devChecks: true /* default: only in development */ });
```

---

## 1. Install

Copy the `native-compute/` folder into your app's `src/`.

Your bundler must understand `new Worker(new URL('./file.js', import.meta.url))`: Vite, webpack 5,
Create React App 5 and Next.js (client components only) all do.

For PDFs only: `npm install pdfjs-dist@3.11.174`

## 2. Set up (once per app)

**a. A worker file.** It holds the built-in tasks plus your own:

```js
// src/app.worker.js
import { defineWorker } from './native-compute/core/worker-runtime';
import { builtins } from './native-compute/workers/builtins';

export const handlers = defineWorker({
  ...builtins,
  // your own tasks: any function of (input, ctx)
  async resizeAll(input, ctx) {
    for (let i = 0; i < input.items.length; i++) {
      await ctx.checkpoint();                 // lets the task be cancelled; cheap, call it often
      ctx.progress(i / input.items.length);   // 0..1, shown in the hook's `progress`
      /* ... */
    }
    return result;
  },
});
```

Only need some built-ins? Import the groups instead, for a smaller worker:
`import { math, lists, images, files } from './native-compute/workers/builtins'` and spread the ones you use.

**b. Bind the hooks:**

```js
// src/compute.js
import { createNativeCompute } from './native-compute';

export const {
  NativeComputeProvider, useTask, useAction, useCompute,
  FastImage, useFastImage, useDataView, useImagePipeline,
  useWorkerPool, useEngine, useEngineLog, useCapabilities,
} = createNativeCompute({
  createWorker: () => new Worker(new URL('./app.worker.js', import.meta.url), { type: 'module' }),
});
```

**c. Wrap your app:**

```jsx
<NativeComputeProvider><App /></NativeComputeProvider>
```

Workers start when the browser is idle, so the first task doesn't wait for them.

---

## 3. Use it

### Run any heavy function: `useTask` and `useAction`

```jsx
// Re-runs when deps change; an older run still in progress is cancelled.
const report = useTask('buildReport', () => orders && { payload: orders }, [orders]);
report.data; report.isPending; report.progress; report.error;

// From event handlers (clicks, file pickers). run() never throws: errors land in `error`.
const parse = useAction('parseCSV');
<input type="file" onChange={(e) => parse.run({ source: e.target.files[0] })} />
<button onClick={parse.cancel}>Cancel</button>
```

`useTask` options: `debounceMs`, `timeoutMs`, `cache: true` (same input returns the stored result).

### Let the engine pick where it runs: `defineOp` + `useCompute`

Describe the ways a job *can* run. The engine predicts each one's time on this device, picks the
fastest, measures, learns, and remembers it across visits.

```js
import { defineOp, ranges } from './native-compute';

defineOp('countPrimes', {
  size: ({ from, to }) => to - from,     // how big a job is
  inline: countPrimes,                   // on the page: only used when predicted under ~3 ms
  task: 'countPrimes',                   // the same function, registered in your worker file
  split: {                               // across all workers, then merged
    parts: ({ from, to }, n) => ranges(to - from, n).map(([s, e]) => ({ from: from + s, to: from + e })),
    merge: (counts) => counts.reduce((a, b) => a + b, 0),
  },
  // gpu: async (input, gpu) => ...      // optional
});
```

```jsx
const primes = useCompute('countPrimes', () => ({ from: 0, to }), [to], { cache: true });
primes.data;      // the answer
primes.decision;  // { backend: 'inline' | 'worker' | 'workers' | 'gpu' | 'cache', ms, reason }
```

Give any subset of `inline`, `task`, `split` and `gpu`. Rules the engine always follows:
- The page's main thread only gets jobs predicted to take under 3 ms.
- The GPU is skipped for small jobs, on software-only GPUs, and with `precision: 'high'` (it computes in 32-bit floats).
- An untested option that might win gets one try, so the engine can learn it.
- If a worker crashes, the job is retried on its replacement. If the GPU is lost, the job runs elsewhere and the GPU isn't offered again.

`useCompute` options: `prefer`, `force` (a backend name), `precision: 'high'`, `cache`, `debounceMs`.

**Built-in engine jobs:** `stats` (array → count/min/max/mean/std), `histogram`
(`{ data, bins, min, max }`), and `kernel` (element-wise math on arrays, GPU-capable).
Kernels are defined in `smart/kernels.js`: one GLSL line for the GPU and one JS function for
everything else. Add your own there.

### Fast images: `<FastImage>`

```jsx
<FastImage src={urlOrFileOrBlob} width={200} height={140} alt="..." fit="cover" />
```

- Loads only near the screen.
- Shows a tiny blurred preview first, then a display-sized copy made in a worker.
- Images scrolled past before they load are cancelled; the newest visible image goes first.
- Thumbnails of URLs and Files are kept in the browser's Cache API, so revisits are instant.

`useFastImage(src, { width, height })` returns `{ ref, src, placeholder }` if you need custom markup.
`clearThumbnailCache()` empties the saved thumbnails.

### Big lists and tables: `useDataView` + `<VirtualList>`

```jsx
const view = useDataView(rows, {
  search: 'lisbon',                                  // every word must appear
  fuzzy: false,                                      // true: letters in order ("lsbn" finds Lisbon)
  filters: [{ key: 'status', op: '=', value: 'paid' }],  // = != < <= > >= contains in between
  sort: [{ key: 'amount', dir: 'desc' }],           // natural order: "item 2" before "item 10"
}, { searchKeys: ['customer', 'city'], debounceMs: 0 });

<VirtualList
  count={view.count}
  rowHeight={36}
  height={400}
  renderRow={(i) => <Row row={rows[view.indices[i]]} />}
/>
```

- Lists up to 20,000 rows are queried on the page.
- Bigger lists are loaded into *one* worker once (if it crashes, they're reloaded on its replacement), and each query then sends only the query.
- Results are row numbers, never copies of rows.
- `<VirtualList>` draws only the visible rows.

### Files

| Task | Input | Result |
|---|---|---|
| `parseCSV` | `{ source: File \| string, delimiter?, header? }` | `{ rows, columns: [{ name, numeric: Float64Array \| null, text \| null }] }` |
| `parseJSON` | `{ source: File \| string }` | the parsed value (with read progress) |
| `readText` | `{ source: File }` | text (with progress) |
| `hash` | `{ data: File \| string \| bytes, algorithm? }` | hex SHA-256 (or SHA-1/384/512) |
| `compress` / `decompress` | `{ data, format?: 'gzip' \| 'deflate' }` | `ArrayBuffer` |

```jsx
const hash = useAction('hash');  hash.run({ data: file });
```

### PDFs (optional add-on)

```jsx
import { usePdf, PdfViewer, usePdfSearch } from './native-compute/addons/pdf';

const pdf = usePdf(fileOrUrl);                       // { status, doc, numPages, aspect, progress }
const found = usePdfSearch(pdf.doc, query);          // { results: [{ page, snippet }], indexed, total }
<PdfViewer doc={pdf.doc} numPages={pdf.numPages} aspect={pdf.aspect} scrollTo={page} />
```

- PDF.js downloads only when a PDF is opened.
- Pages render near the screen at the display's real sharpness, and free their memory when far away.
- Text for search is extracted once per document.

### Photo editing: `useImagePipeline`

```jsx
const editor = useImagePipeline({ prefer: 'auto' });   // 'auto' | 'gpu' | 'cpu'
<canvas ref={editor.canvasRef} key={prefer} style={{ width: '100%', height: 400 }} />
editor.setImage(file);
editor.setParams({ exposure: 0.5, contrast: 0.2, saturation: 0, temperature: 0, blur: 0, vignette: 0.3 });
const jpeg = await editor.exportImage({ type: 'image/jpeg', quality: 0.9 });
editor.mode;  // 'gpu-worker' | 'gpu-main' | 'cpu-workers'
```

- Renders on the GPU inside a worker where possible, otherwise on the page's GPU, otherwise in CPU workers.
- Shows a lower-quality preview while dragging and one full-quality frame on release.

### Smooth animations: GPU-friendly CSS

Browsers can move and fade elements on the GPU without redoing the page layout, but **only for
`transform` and `opacity`**. Animating `top`, `left`, `width`, `height` or `margin` recalculates
the layout on every frame, which is what makes animations stutter. Each GPU layer also uses
memory, so layers should exist only while something moves.

```jsx
import { useWillChange, LazySection, useGpuCssAudit } from './native-compute';

// A GPU layer only while the drawer moves (released 300 ms after it stops).
const ref = useWillChange(open, 'transform');
<aside ref={ref} style={{ transform: `translateX(${open ? 0 : -100}%)`, transition: 'transform 200ms' }} />

// Skip rendering long sections while they're off screen.
<LazySection estimatedHeight={600}>...</LazySection>

// In development: warns about animations on layout properties, too many GPU layers, heavy blur.
useGpuCssAudit(process.env.NODE_ENV === 'development');
```

| Do | Avoid |
|---|---|
| Animate `transform` and `opacity` | Animating `top`, `left`, `width`, `height`, `margin` |
| `useWillChange(active)` while it moves | Permanent `will-change` or `translateZ(0)` on many elements |
| `<LazySection>` for long pages | Rendering everything at once |
| Small, occasional blur | Big or many `filter: blur()` / `backdrop-filter` areas (costly on phones) |

The library follows these rules itself: `<VirtualList>` moves rows with `transform`, and
`<FastImage>` fades with `opacity` only and removes its blurred placeholder once the image is in.
CSS keeps animations smooth, but it can't fix slow JavaScript; that's what the rest of the
library is for.

### Navigation: `<Router>` and `<Link>` (no router library needed)

```jsx
import { Router, Link, lazy, useLoaderData, useParams, NavigationProgress } from './native-compute';

const routes = [
  { path: '/', component: Home, title: 'Home' },
  {
    path: '/products',
    component: lazy(() => import('./Products')),     // this screen's code loads only when needed
    loader: () => fetch('/api/products').then((r) => r.json()),
    keepAlive: true,                                  // going back keeps its state (filters, inputs)
    staleTime: 30_000,                                // saved data younger than this isn't refreshed
  },
  {
    path: '/products/:id',
    component: lazy(() => import('./Product')),
    loader: ({ params }) => fetch(`/api/products/${params.id}`).then((r) => r.json()),
    title: (product) => product.name,
  },
];

function AppShell({ children }) {          // stays on screen across navigations
  return (
    <div className="nc-safe">
      <NavigationProgress color="#2f6fed" />
      <nav className="nc-static"><Link to="/">Home</Link> <Link to="/products">Products</Link></nav>
      {children}
    </div>
  );
}

<Router routes={routes} layout={AppShell} notFound={NotFound} error={ErrorScreen} fallback={<Splash />} />

// In a screen:
function Product() {
  const product = useLoaderData();         // or props.data
  const { id } = useParams();              // or props.params
  return <h1>{product.name}</h1>;
}
```

What happens on a tap:
1. **Before the tap.** Touching, hovering or focusing a `<Link>` starts loading the next screen's code and data. On a phone, touch-down to click gives roughly 100–300 ms of head start. `prefetch="viewport"` preloads when the link is visible and the browser is idle. Prefetching is skipped on data-saver and 2G.
2. **During loading.** The current screen stays until the next one is ready, so there are no blank flashes. A newer tap cancels an older navigation. `<NavigationProgress>` appears only if it takes over 250 ms.
3. **On arrival.** The screen animates in with View Transitions (forward slides from the right, back from the left) where the browser supports it. The page title updates, and focus moves to the new screen so screen readers announce it.
4. **Going back.** It's instant. Saved data shows immediately and refreshes in the background, the scroll position is restored, and `keepAlive` screens keep their state.

| API | Use |
|---|---|
| `<Link to replace scroll prefetch>` | `prefetch`: `'intent'` (default), `'viewport'`, `'none'`. Ctrl/Cmd-click, `target` and `download` behave normally |
| `useRouter()` | `navigate(to, { replace, scroll })`, `prefetch(to)`, `back()`, `forward()`, `revalidate()`, `location` |
| `useLocation()` | `{ pathname, search, hash, query: URLSearchParams }` |
| `useParams()` / `useLoaderData()` | the screen's route parameters / loader result |
| `useNavigation()` | `{ state: 'idle' \| 'loading', location }` for your own indicators |
| `useHead(head)` | set head tags from inside a screen (see SEO below) |
| `<DelayedIndicator active>` / `useDelayedFlag(active)` | show a spinner only for slow work, and never flicker it |
| `<Router basename="/app">` | when the app isn't served from the site root |

Route patterns: `/`, `/products`, `/products/:id`, `/files/*` (rest of the path in `params['*']`).
Routes are matched in order, so put specific ones first. Screens kept alive are hidden, not
unmounted: their timers and effects keep running, so keep `keepAlive` for screens people return to.

**Shared-element animations.** Give the same CSS `view-transition-name` to a thumbnail on one
screen and the big image on the next, and supporting browsers morph one into the other.

**Server setup for direct links.** Your server must answer every app path (e.g. `/products/42`)
with `index.html`; Create React App's dev server and most static hosts have a "single-page app"
setting for this.

### SEO and link previews

Who sees what:
- **Google** runs JavaScript, so it sees what the router renders. It does so in a delayed second pass, so titles and descriptions should be correct as early as possible.
- **Link previews** (Facebook, X, LinkedIn, WhatsApp, Slack) and many other crawlers **don't run JavaScript**. They only see the HTML file the server sends. Layer 2 below solves that.

**Layer 1: head tags per screen (always on).** Give routes a `head`, and every navigation
updates the title, description, canonical URL, preview tags and structured data:

```jsx
<Router routes={routes} siteUrl="https://shop.example.com" />

{
  path: '/products/:id',
  component: lazy(() => import('./Product')),
  loader: ({ params }) => getProduct(params.id),
  head: (product) => ({
    title: `${product.name} · Shop`,
    description: product.summary,
    image: product.photo,                 // preview image; relative paths are made absolute
    type: 'product',
    jsonLd: { '@context': 'https://schema.org', '@type': 'Product', name: product.name },
  }),
}

// Inside a screen, when something is only known there:
useHead({ robots: 'noindex' });
```

The not-found and error screens are `noindex` automatically, so Google doesn't index empty pages.
Head fields: `title`, `description`, `canonical`, `robots`, `image`, `imageAlt`, `type`, `siteName`,
`locale`, `twitter`, `alternates` (other languages), `jsonLd`, and `meta` / `links` for anything else.

**Layer 2: prerendered HTML per page (recommended).** After building, write one HTML file per page
with its own head tags, plus `sitemap.xml` and `robots.txt`:

```bash
npm run build && node src/native-compute/tools/prerender.mjs --build build --config seo.config.mjs
```

```js
// seo.config.mjs (project root)
export default {
  siteUrl: 'https://shop.example.com',
  pages: async () => [
    { path: '/', head: { title: 'Shop', description: 'Handmade things' }, priority: 1 },
    ...(await fetch('https://api.example.com/products').then((r) => r.json())).map((p) => ({
      path: `/products/${p.id}`,
      head: { title: `${p.name} · Shop`, description: p.summary, image: p.photo, type: 'product' },
      lastmod: p.updatedAt,
    })),
  ],
  robots: { disallow: ['/account'] },
};
```

Link previews and non-JavaScript crawlers now see the right title, description and image for every
page. Pages marked `noindex` are left out of the sitemap, and the tool can safely be re-run on the
same build. To share head definitions between routes and this config, put them in a plain `.mjs`
file (no JSX) and import it from both.

**Layer 3: full server rendering (optional).** For the page *content* in the HTML too, render on a
server (or in the prerender config's `render` option):

```js
// server
import { renderToString } from 'react-dom/server';
const { status, data, head } = await loadRoute(routes, req.url);
const app = renderToString(<Router routes={routes} url={req.url} initialData={data} siteUrl={SITE} />);
res.status(status).send(template
  .replace('</head>', headToHtml(head, { siteUrl: SITE, pathname: req.path }) + '</head>')
  .replace('<div id="root"></div>', `<div id="root">${app}</div>${serializeData(data)}`));

// browser
hydrateRoot(document.getElementById('root'), <Router routes={routes} initialData={window.__NC_DATA__} siteUrl={SITE} />);
```

`loadRoute` returns the right status (200, 404, 500), so missing pages are real 404s. The browser
takes over without loading the data again, and from then on navigation is client-side.

**Checklist:**
- Use `<Link>`: it renders a real `<a href>`, which crawlers follow.
- Unique titles and descriptions per page.
- A `siteUrl`, so canonicals are absolute.
- Prerendering for anything that will be shared as a link.
- Submit `sitemap.xml` in Google Search Console.

### Native-feel CSS and components

The CSS (about 2.5 KB gzipped) is added automatically. Everything sits in `@layer native-compute`, so **any style you write wins** over it without
fighting over specificity.

**Global defaults (safe on any site):**
- no grey tap flash,
- no double-tap zoom delay on controls,
- no font inflation when rotating a phone,
- anchor links that land below a sticky header (set `--nc-header-height`).

Everything else is an opt-in class:

| Class | What it does | Built on |
|---|---|---|
| `nc-fill`, `nc-fill-exact` | Full-height screens that fit phones exactly, even as the address bar shows and hides | `dvh` units (with `vh` fallback) |
| `nc-safe`, `nc-safe-bottom` | Room for notches and the home bar | `env(safe-area-inset-*)` |
| `nc-bar`, `nc-bar-bottom` | Frosted sticky header / tab bar | `position: sticky`, `backdrop-filter`, `color-mix()` |
| `nc-press` | Native pressed state | `:active` + transform |
| `nc-ui` | Long-press doesn't select text or open the iOS image menu | `user-select`, `-webkit-touch-callout` |
| `nc-hover` | Hover effects only with a real mouse, so they don't "stick" after a tap | `@media (hover: hover)` |
| `nc-focus` | Focus ring for keyboard users only | `:focus-visible` |
| `nc-scroll` | Inner scroll areas that don't drag the page | `overscroll-behavior` |
| `nc-snap-x` (+ `nc-center`, `nc-snap-one`) | Swipeable horizontal paging with native momentum | scroll snap |
| `nc-snap-y` | Full-screen vertical paging (stories / reels style) | scroll snap |
| `nc-smooth` | Smooth scrolling, off for reduced motion | `scroll-behavior` |
| `nc-stable-scrollbar` | Page doesn't shift when a scrollbar appears | `scrollbar-gutter` |
| `nc-no-pull-refresh` | Turn off the browser's pull-to-refresh | `overscroll-behavior-y` |
| `nc-container` | Components that adapt to their own width (`@container (min-width: 480px) {...}`) | container queries |
| `nc-grid` | Responsive grid without media queries (`--nc-min`, `--nc-gap`) | `auto-fill` + `minmax()` |
| `nc-collapse` + `[data-open]` | Expand/collapse to natural height, animated | grid rows `0fr` to `1fr` |
| `nc-pop` | `<dialog>` and `popover` menus that fade/scale in and out, no JS animation | `@starting-style`, `allow-discrete` |
| `nc-balance`, `nc-pretty` | Even heading lines; no lonely last word | `text-wrap` |
| `nc-tabular` | Numbers that don't jiggle as they change | `font-variant-numeric` |
| `nc-system-font` | The device's own UI font | `system-ui` |
| `nc-auto-theme`, `nc-accent` | Follow light/dark mode; brand-coloured form controls (`--nc-accent`) | `color-scheme`, `accent-color` |
| `nc-static` | A header that stays still while screens slide | View Transitions |
| `nc-reveal` | Items fade in as they scroll into view (*enhancement*) | scroll-driven animations |

**`<Sheet>`: bottom sheet**

```jsx
import { Sheet, Carousel } from './native-compute';

<Sheet open={open} onClose={() => setOpen(false)} label="Filters">...</Sheet>
```

- Slides up and dims the page.
- Swipe the handle down (over 30% of its height, or a quick flick), tap outside, or press Esc to close.
- It's a real `<dialog>`: focus stays inside, the page behind is hidden from screen readers and doesn't scroll, and the drag only moves `transform`, so it stays on the GPU.

**`<Carousel>`: swipeable pages**

```jsx
<Carousel label="Photos" peek={24} gap={12}>{photos.map((p) => <img key={p.id} src={p.src} alt={p.alt} />)}</Carousel>
```

- The browser does the swiping physics (momentum and snapping), so it feels native on every device.
- Dots follow the visible page, and arrow keys work when it's focused.
- `peek` shows the edges of the neighbouring pages.

**Browser support.** Everything above works in current Chrome, Edge, Firefox and Safari, with these exceptions:
- `nc-reveal` needs scroll-driven animations (Chrome, Edge, Safari 26+). Elsewhere items just appear.
- `nc-pretty` is skipped where `text-wrap: pretty` isn't supported.
- The *closing* animation of `nc-pop` and `<Sheet>` is skipped in browsers that can't animate `display`. They still close instantly.
- Every animation turns off for users who prefer reduced motion.

### Accessibility

Built in, with nothing to configure:

- **Keyboard.**
  - Everything works with Tab, Enter, Esc and arrow keys.
  - A "Skip to content" link appears on the first Tab.
  - Focus rings show for keyboard users only.
- **Screen readers.**
  - After each navigation, focus goes to the new page's main heading, which gets read aloud; pages without one have their title announced.
  - Sheets are real dialogs with a Close button.
  - Carousels and slides are labelled, and lists say "row 5 of 300,000".
  - PDF pages have a hidden text layer, so they can be read, searched and copied.
- **Touch.**
  - Tap targets are at least 24 px.
  - No tap delay, and hover effects never "stick" on phones.
- **Motion and contrast.**
  - Every animation stops for users who ask for reduced motion.
  - Shapes stay visible in Windows high-contrast mode.

**What you still provide.** No library can write these for you, and the development check reminds you about them:
- meaningful `alt` text,
- labels for your own buttons and fields,
- sensible heading order,
- enough colour contrast.

`auditA11y()` runs the same check on demand. The library's own components pass axe-core, the
standard automated accessibility checker, with 0 violations. Test with a real screen reader too
(VoiceOver, TalkBack or NVDA): automated checks catch roughly a third to half of real problems.

### Instant repeat visits and offline start: service worker

1. Copy `native-compute/addons/service-worker.js` to your **public** folder.
2. Register it in production builds:

```js
import { registerServiceWorker } from './native-compute';
if (process.env.NODE_ENV === 'production') {
  registerServiceWorker({ onUpdate: ({ apply }) => showBanner('New version available', apply) });
}
```

- **Pages:** fetched from the network first, with the saved app shell used if the network is slower than 3 s or offline.
- **Built files with a content hash in the name:** served from the cache, which is safe because a new build changes their names.
- **APIs and everything else:** never touched.
- **Updates:** a new version waits until you call `apply()`.
- **If anything ever goes wrong:** ship `unregisterServiceWorker()` and it removes itself and its caches.
- **Requirements:** HTTPS (or localhost).

**Installable app (PWA).** Add a `manifest.json` with `name`, `icons` (192 and 512 px),
`start_url: "/"` and `display: "standalone"`, and link it from `index.html`. Phones then offer
"Add to Home Screen" and open your site full-screen like an app.

### Tools for your own components

| Export | Use |
|---|---|
| `useWillChange(active, value)` | GPU layer only while animating |
| `<LazySection estimatedHeight>` | skip rendering off-screen sections |
| `auditGpuCss()` / `useGpuCssAudit(enabled)` | development check for GPU-unfriendly CSS |
| `autoNative(options)` / `isLite()` | what runs automatically, and whether lite mode is on |
| `auditA11y()` | accessibility check on demand (automatic in development) |
| `announce(message)` | speak a message to screen-reader users (e.g. \"Saved\") |
| `useNearScreen(margin)` | `[ref, near]`: start work only when something is close to the screen |
| `useElementSize()` | `[ref, { width, height }]` |
| `useLatestTask(start, deps)` | run async work on change, aborting the previous run |
| `useAsyncAction(fn)` | `{ run, cancel, data, isPending, error }` for event handlers |
| `useEngine()` | `explain(op, input)`, `calibrate(op, makeInput)`, `reset()`, `subscribe(fn)` |
| `useEngineLog(n)` | the engine's last n decisions (for a dev panel) |
| `useCapabilities()` | cores, memory, GPU, worker features, device tier |
| `useWorkerPool()` | the pool: `run`, `broadcast`, `forget`, `cancel`, `stats` |
| `share(typedArray)` | shared memory, so every worker reads it without copies (needs COOP/COEP headers) |

---

## 4. Rules worth knowing

- **Treat data as immutable.** Make a new array instead of editing one in place. Caching and `useDataView` recognise big arrays by identity, which is instant.
- **Transferring hands data over.** With `transfer` (or `'auto'`), the buffers become unusable on your side. Never transfer arrays you keep in React state.
- **Tiny jobs aren't faster in a worker.** Sending a message costs more than the work. The engine knows this; `useTask` doesn't, so use it for real work.
- **Workers can't touch the page (DOM).** Compute in the worker, render on the page.
- **`<VirtualList>` uses one fixed row height.** Above ~450,000 rows of 36 px, Firefox's maximum element height is reached; page or group the data beyond that.
- **The thumbnail cache needs HTTPS or localhost.**
- **PDF.js security.** It's opened with `isEvalSupported: false`, which closes a known PDF.js 3.x hole (CVE-2024-4367). Keep that if you change the code.

## 5. Browser support

| Feature | Where |
|---|---|
| Workers, engine, lists, files | All current browsers |
| Thumbnails made in workers | Chrome, Edge, Firefox, Safari 16.4+ (elsewhere the original image is shown) |
| GPU in a worker | Chrome, Edge, Firefox, Safari 17+ (older Safari: GPU on the page) |
| No usable GPU | Math and photo editing run on CPU workers automatically |
| Compression | Chrome, Edge, Firefox 113+, Safari 16.4+ |

## 6. What's in the folder

```
native-compute/
  index.js          everything you import on the page
  core/             worker pool, worker runtime, caching, transfers, scheduling, device detection,
                    auto.js (automatic native feel), a11yAudit.js
  smart/            engine.js (decides and learns), ops.js (defineOp + built-in jobs), kernels.js
  data/             list search / filter / sort
  workers/          built-in worker tasks: tasks/math, lists, images, files
  image/            <FastImage> loader, photo editor (picks GPU or CPU)
  gpu/              WebGL2 compute and renderer, GPU worker
  react/            createNativeCompute, VirtualList, Sheet, Carousel, shared hooks, GPU-friendly CSS helpers
  router/           Router, Link, lazy, data cache, navigation progress, head tags (SEO)
  tools/            prerender.mjs: per-page HTML, sitemap.xml, robots.txt
  styles/           native-feel.css (modern CSS for native feel)
  addons/           PDF viewer and search (optional), service worker + registration
```
