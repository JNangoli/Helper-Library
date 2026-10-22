// Optional PDF add-on (needs: npm install pdfjs-dist@3.11.174). Nothing here loads until a PDF
// is opened, so apps that never show PDFs never download PDF.js.
//   const pdf = usePdf(fileOrUrl);                  // { status, doc, numPages, aspect, progress }
//   <PdfViewer doc={pdf.doc} numPages={pdf.numPages} aspect={pdf.aspect} />
//   const found = usePdfSearch(pdf.doc, query);     // { results: [{ page, snippet }], indexed }
// Speed tricks: parsing happens in PDF.js's own worker; pages render only when near the screen,
// at the screen's real pixel density; pages far off screen release their memory and cancel
// unfinished renders; text for search is extracted once per document and reused.
import { useEffect, useRef, useState } from 'react';
import { useElementSize, useNearScreen } from '../react/hooks';

let pdfjsPromise;
function loadPdfJs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(
      new URL('pdfjs-dist/legacy/build/pdf.worker.js', import.meta.url),
    );
    return pdfjs;
  });
  return pdfjsPromise;
}

/** Open a PDF from a URL, File/Blob or ArrayBuffer. */
export function usePdf(source) {
  const [state, setState] = useState({ status: 'idle' });

  useEffect(() => {
    if (!source) {
      setState({ status: 'idle' });
      return;
    }
    let alive = true;
    let task;
    setState({ status: 'loading', progress: 0 });
    (async () => {
      const pdfjs = await loadPdfJs();
      let params;
      if (typeof source === 'string') params = { url: source };
      else {
        const bytes = source instanceof Blob ? await source.arrayBuffer() : source.slice(0); // copy: PDF.js takes ownership
        params = { data: new Uint8Array(bytes) };
      }
      // isEvalSupported: false closes the font-eval hole in PDF.js 3.x (CVE-2024-4367).
      task = pdfjs.getDocument({ ...params, isEvalSupported: false });
      task.onProgress = ({ loaded, total }) => alive && total && setState((s) => ({ ...s, progress: loaded / total }));
      const doc = await task.promise;
      const first = await doc.getPage(1);
      const viewport = first.getViewport({ scale: 1 });
      if (alive) setState({ status: 'ready', doc, numPages: doc.numPages, aspect: viewport.height / viewport.width });
    })().catch((error) => alive && setState({ status: 'error', error }));
    return () => {
      alive = false;
      task?.destroy();
    };
  }, [source]);

  return state;
}

/** One page, rendered only while near the screen. width is in CSS pixels. */
export function PdfPage({ doc, pageNumber, width, aspect = 1.414, className, style }) {
  const [wrapRef, near] = useNearScreen('1200px 0px');
  const canvasRef = useRef(null);
  const [pageAspect, setPageAspect] = useState(aspect);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!near || !doc || !width || !canvas) return;
    let alive = true;
    let task;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (!alive) return;
      const base = page.getViewport({ scale: 1 });
      setPageAspect(base.height / base.width);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: (width * dpr) / base.width });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
      await task.promise;
      if (alive) setRendered(true);
    })().catch((err) => {
      if (err?.name !== 'RenderingCancelledException') console.error(err);
    });
    return () => {
      alive = false;
      task?.cancel();
      canvas.width = 0; // release the bitmap memory of pages far off screen
      canvas.height = 0;
      setRendered(false);
    };
  }, [doc, pageNumber, width, near]);

  return (
    <div
      ref={wrapRef}
      className={className}
      data-page={pageNumber}
      style={{ width, aspectRatio: `1 / ${pageAspect}`, background: '#fff', position: 'relative', ...style }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Page ${pageNumber}`}
        style={{ width: '100%', height: '100%', display: 'block', opacity: rendered ? 1 : 0 }}
      />
    </div>
  );
}

/** All pages, sized to the container's width. Pass scrollTo={pageNumber} to jump to a page. */
export function PdfViewer({ doc, numPages, aspect, gap = 16, maxWidth = 900, scrollTo, className, style }) {
  const [ref, size] = useElementSize();
  const width = Math.min(maxWidth, Math.floor(size.width));

  useEffect(() => {
    if (!scrollTo || !ref.current) return;
    ref.current.querySelector(`[data-page="${scrollTo}"]`)?.scrollIntoView({ block: 'start' });
  }, [ref, scrollTo]);

  const pages = [];
  for (let n = 1; n <= (numPages ?? 0); n++) {
    pages.push(<PdfPage key={n} doc={doc} pageNumber={n} width={width} aspect={aspect} />);
  }
  return (
    <div ref={ref} className={className} style={{ display: 'grid', justifyItems: 'center', gap, ...style }}>
      {width > 0 && pages}
    </div>
  );
}

const textCache = new WeakMap(); // doc -> { texts: string[], done: Promise }

function indexText(doc, onPage) {
  let entry = textCache.get(doc);
  if (!entry) {
    const texts = new Array(doc.numPages).fill(null);
    const listeners = new Set();
    const done = (async () => {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent(); // parsed in PDF.js's worker
        texts[n - 1] = content.items.map((item) => item.str).join(' ');
        listeners.forEach((fn) => fn());
      }
    })();
    entry = { texts, done, listeners };
    textCache.set(doc, entry);
  }
  entry.listeners.add(onPage);
  return { texts: entry.texts, stop: () => entry.listeners.delete(onPage) };
}

/** Full-text search. Text is extracted once per document, page by page, and reused. */
export function usePdfSearch(doc, query, { limit = 50, debounceMs = 150 } = {}) {
  const [state, setState] = useState({ results: [], indexed: 0 });

  useEffect(() => {
    if (!doc) {
      setState({ results: [], indexed: 0 });
      return;
    }
    const needle = query.trim().toLowerCase();
    let timer;
    const search = () => {
      const results = [];
      let indexed = 0;
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (text === null) continue;
        indexed++;
        if (!needle || results.length >= limit) continue;
        const at = text.toLowerCase().indexOf(needle);
        if (at !== -1) {
          const snippet = text.slice(Math.max(0, at - 40), at + needle.length + 60).trim();
          results.push({ page: i + 1, snippet });
        }
      }
      setState({ results, indexed });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(search, debounceMs);
    };
    const { texts, stop } = indexText(doc, schedule);
    schedule();
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [doc, query, limit, debounceMs]);

  return { ...state, total: doc?.numPages ?? 0 };
}
