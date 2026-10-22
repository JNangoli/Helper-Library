// Main-thread scheduling helpers: keep input responsive while doing work in JS.
import { channelYield } from './util';

/** Give the browser a chance to handle input and paint. Uses scheduler.yield where available. */
export function yieldToMain() {
  const scheduler = globalThis.scheduler;
  if (scheduler?.yield) return scheduler.yield();
  if (scheduler?.postTask) return scheduler.postTask(() => {}, { priority: 'user-visible' });
  return channelYield();
}

/** Run when the browser is idle (Safari has no requestIdleCallback: falls back to a timer). */
export function whenIdle(callback, timeout = 2000) {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(() => callback(), { timeout });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(callback, 200);
  return () => clearTimeout(id);
}
