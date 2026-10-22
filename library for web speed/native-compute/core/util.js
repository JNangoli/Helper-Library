// Small shared helpers.

export const noop = () => {};

/** Cancellations (ours and the browser's) are expected; callers usually ignore them. */
export const isAbort = (err) => err instanceof Error && err.name === 'AbortError';

let channel;
const waiters = [];
/** Yield to the event loop through a MessageChannel: a real task boundary, no 4 ms timer clamp. */
export function channelYield() {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => waiters.shift()?.();
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
    channel.port2.postMessage(null);
  });
}

/** Calls onSettle once poke() has stopped being called for `ms` (e.g. end of a slider drag). */
export function createSettle(ms, onSettle) {
  let timer;
  return {
    poke() {
      clearTimeout(timer);
      timer = setTimeout(onSettle, ms);
    },
    cancel: () => clearTimeout(timer),
  };
}

/** Error for features a browser lacks; callers can fall back. */
export function unsupported(what) {
  const error = new Error(`${what} is not supported in this browser`);
  error.name = 'UnsupportedError';
  return error;
}
