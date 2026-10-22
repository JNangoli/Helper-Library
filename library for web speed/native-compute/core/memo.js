// Result caching. Inputs are identified by VALUE for small things (numbers, strings, small
// objects) and by IDENTITY for big things (arrays, typed arrays, files), which is instant.
// So treat data as immutable (the React way): make a new array instead of editing one in place.

const ids = new WeakMap();
let nextId = 0;

/** A stable id for an object, without holding on to it. */
export function idOf(object) {
  let id = ids.get(object);
  if (id === undefined) {
    id = ++nextId;
    ids.set(object, id);
  }
  return id;
}

const isBig = (v) =>
  ArrayBuffer.isView(v) ||
  v instanceof ArrayBuffer ||
  (typeof Blob !== 'undefined' && v instanceof Blob) ||
  (Array.isArray(v) && v.length > 64);

/** A cache key for any input. */
export function keyOf(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
  }
  if (depth > 4 || isBig(value)) return `#${idOf(value)}`;
  if (Array.isArray(value)) return `[${value.map((v) => keyOf(v, depth + 1)).join(',')}]`;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return `#${idOf(value)}`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${k}:${keyOf(value[k], depth + 1)}`).join(',')}}`;
}

/** Small LRU map. */
export class Memo {
  constructor(limit = 200) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key); // move to newest
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

/** Cache an async function's results (rejections are not cached). */
export function cached(memo, key, run) {
  const hit = memo.get(key);
  if (hit) return hit;
  const promise = run();
  memo.set(key, promise);
  promise.catch(() => memo.delete(key));
  return promise;
}
