# native-compute

A drop-in speed layer for React apps. Heavy work runs in background threads (Web Workers) or on
the GPU, so the page never freezes; big lists, images, files and PDFs get fast paths; and a small
engine learns, per device, the fastest place to run each job.

- Plain JavaScript, no dependencies (the PDF add-on needs PDF.js).
- About 14 KB gzipped added to your page at startup. GPU code, PDF.js and the workers are separate files that load only when used.
- React 18+. The core (`WorkerPool`, `Engine`, `defineOp`) also works without React.

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

### Tools for your own components

| Export | Use |
|---|---|
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
  core/             worker pool, worker runtime, caching, transfers, scheduling, device detection
  smart/            engine.js (decides and learns), ops.js (defineOp + built-in jobs), kernels.js
  data/             list search / filter / sort
  workers/          built-in worker tasks: tasks/math, lists, images, files
  image/            <FastImage> loader, photo editor (picks GPU or CPU)
  gpu/              WebGL2 compute and renderer, GPU worker
  react/            createNativeCompute, VirtualList, shared hooks
  addons/pdf.jsx    optional PDF viewer and search
```
