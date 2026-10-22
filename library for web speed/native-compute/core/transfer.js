// Helpers for zero-copy data movement.

let streamsTransferable;

/** Safari does not support transferring streams; detect instead of guessing. */
export function canTransferStreams() {
  if (streamsTransferable === undefined) {
    try {
      const stream = new ReadableStream();
      const { port1, port2 } = new MessageChannel();
      port1.postMessage(stream, [stream]);
      port1.close();
      port2.close();
      streamsTransferable = true;
    } catch {
      streamsTransferable = false;
    }
  }
  return streamsTransferable;
}

function transferableClasses() {
  const g = globalThis;
  const names = ['ImageBitmap', 'OffscreenCanvas', 'MessagePort', 'VideoFrame', 'AudioData'];
  if (canTransferStreams()) names.push('ReadableStream', 'WritableStream', 'TransformStream');
  return names.map((n) => g[n]).filter((c) => typeof c === 'function');
}

/**
 * Walks a payload and returns everything that can be transferred instead of copied.
 * Transferring DETACHES these objects in the sender. Typed-array views are only
 * transferred when they cover their whole buffer, so you never lose unrelated data.
 */
export function collectTransferables(root, maxNodes = 10_000) {
  const out = new Set();
  const seen = new WeakSet();
  const classes = transferableClasses();
  const hasImageData = typeof ImageData !== 'undefined';
  const stack = [root];
  let visited = 0;

  while (stack.length && visited++ < maxNodes) {
    const value = stack.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);

    if (value instanceof ArrayBuffer) {
      out.add(value);
    } else if (ArrayBuffer.isView(value)) {
      const { buffer } = value;
      if (buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === buffer.byteLength)
        out.add(buffer);
    } else if (hasImageData && value instanceof ImageData) {
      stack.push(value.data);
    } else if (classes.some((C) => value instanceof C)) {
      out.add(value);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length && i < maxNodes; i++) {
        if (typeof value[i] === 'object' && value[i] !== null) stack.push(value[i]);
      }
    } else if (value instanceof Map) {
      for (const [k, v] of value) stack.push(k, v);
    } else if (value instanceof Set) {
      for (const v of value) stack.push(v);
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        for (const key in value) stack.push(value[key]);
      }
    }
  }
  return [...out];
}

/**
 * Copies a typed array into shared memory when the page is cross-origin isolated
 * (COOP/COEP headers). Shared arrays reach every worker without any copy.
 * Without isolation it returns the array unchanged, so code works either way.
 */
export function share(array) {
  const isolated = globalThis.crossOriginIsolated;
  if (typeof SharedArrayBuffer === 'undefined' || !isolated) return array;
  if (array.buffer instanceof SharedArrayBuffer) return array;
  const Ctor = array.constructor;
  const shared = new Ctor(new SharedArrayBuffer(array.byteLength));
  shared.set(array);
  return shared;
}
