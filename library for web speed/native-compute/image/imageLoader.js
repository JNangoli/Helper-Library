// Fast image display for any app: thumbnails made in workers, only for images near the
// screen, newest-visible first, cancelled when scrolled away, kept in memory (LRU) and in
// the Cache API across visits. Falls back to the original image where workers can't draw.
import { idOf } from '../core/memo';
import { isAbort } from '../core/util';

const MEMORY_LIMIT = 400; // thumbnails kept as object URLs

/** Round sizes up so nearby sizes share one cached thumbnail. */
const bucket = (px) => Math.max(32, Math.ceil(px / 64) * 64);

function sourceId(source) {
  if (typeof source === 'string') return new URL(source, document.baseURI).href;
  if (typeof File !== 'undefined' && source instanceof File)
    return `file:${source.name}:${source.size}:${source.lastModified}`;
  return `blob:${idOf(source)}`;
}

export function createImageLoader(pool) {
  const entries = new Map(); // key -> { refs, promise, value, controller }

  function prune() {
    if (entries.size <= MEMORY_LIMIT) return;
    for (const [key, entry] of entries) {
      if (entries.size <= MEMORY_LIMIT) break;
      if (entry.refs > 0 || !entry.value) continue;
      if (entry.value.owned) {
        URL.revokeObjectURL(entry.value.src);
        if (entry.value.placeholder) URL.revokeObjectURL(entry.value.placeholder);
      }
      entries.delete(key);
    }
  }

  function load(source, width, height, fit, key, controller) {
    const id = sourceId(source);
    const persistent = typeof source === 'string' || (typeof File !== 'undefined' && source instanceof File);
    const payload = {
      source: typeof source === 'string' ? id : source,
      width,
      height,
      fit,
      cacheKey: persistent ? `${id}|${width}x${height}|${fit}` : undefined,
    };
    return pool.run('thumbnail', payload, { signal: controller.signal, priority: 'high' }).then(
      (r) => ({
        src: URL.createObjectURL(r.blob),
        placeholder: URL.createObjectURL(r.placeholder),
        width: r.width,
        height: r.height,
        cached: r.cached,
        owned: true,
      }),
      (err) => {
        if (isAbort(err)) throw err;
        // Workers can't draw here (older browsers) or decoding failed: show the original.
        const src = typeof source === 'string' ? id : URL.createObjectURL(source);
        return {
          src,
          placeholder: null,
          width,
          height,
          cached: false,
          owned: typeof source !== 'string',
          fallback: true,
        };
      },
    );
  }

  return {
    /** Start (or share) a thumbnail. Call release(key) when the component no longer needs it. */
    acquire(source, { width, height, fit = 'cover' }) {
      const w = bucket(width);
      const h = bucket(height);
      const key = `${sourceId(source)}|${w}x${h}|${fit}`;
      let entry = entries.get(key);
      if (!entry) {
        const controller = new AbortController();
        entry = { refs: 0, value: null, controller };
        entry.promise = load(source, w, h, fit, key, controller).then((value) => {
          entry.value = value;
          prune();
          return value;
        });
        entry.promise.catch(() => entries.delete(key));
        entries.set(key, entry);
      } else {
        entries.delete(key); // refresh LRU position
        entries.set(key, entry);
      }
      entry.refs++;
      return { key, promise: entry.promise, value: entry.value };
    },

    release(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.refs--;
      // Scrolled away before it finished: cancel so the queue serves what's on screen now.
      if (entry.refs <= 0 && !entry.value) {
        entry.controller.abort();
        entries.delete(key);
      }
      prune();
    },

    /** Drop everything from memory (the Cache API copy stays for next visit). */
    clear() {
      for (const entry of entries.values()) {
        entry.controller.abort();
        if (entry.value?.owned) {
          URL.revokeObjectURL(entry.value.src);
          if (entry.value.placeholder) URL.revokeObjectURL(entry.value.placeholder);
        }
      }
      entries.clear();
    },
  };
}

/** Delete the persistent thumbnail cache. */
export async function clearThumbnailCache() {
  if (typeof caches !== 'undefined') await caches.delete('native-compute-thumbs-v1');
}
