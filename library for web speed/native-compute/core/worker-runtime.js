// Runs INSIDE a worker. Call defineWorker({...handlers}) once in your worker file.
import { unique } from './protocol';
import { channelYield } from './util';

const YIELD_INTERVAL_MS = 8;

// Yielding is a hybrid: a MessageChannel ping is fast (no 4 ms timer clamp) but on some
// engines it can starve the port that carries cancel messages, so at most every 32 ms we
// yield through a timer instead, which always lets them in. Cancel latency stays ~40 ms max.
// (scheduler.yield is deliberately not used: its continuation is prioritised over messages.)
const TIMER_YIELD_EVERY_MS = 32;
let lastTimerYield = 0;
function yieldToEventLoop() {
  const now = performance.now();
  if (now - lastTimerYield >= TIMER_YIELD_EVERY_MS) {
    lastTimerYield = now;
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return channelYield();
}

const abortError = () => new DOMException('Task cancelled', 'AbortError');

function serializeError(err) {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { name: 'Error', message: String(err) };
}

export function defineWorker(handlers) {
  const scope = globalThis;
  const queue = [];
  const running = new Map();
  const progress = new Map();
  let draining = false;
  let lastYield = 0;

  // Results and progress are batched: everything between two yields goes out in one message.
  let outbox = [];
  const send = (result, transfer = []) => {
    progress.delete(result.id);
    outbox.push({ result, transfer });
  };

  function post(items, prog) {
    const message = { kind: 'results', results: items.map((i) => i.result), progress: prog };
    try {
      scope.postMessage(message, unique(items.flatMap((i) => i.transfer)));
    } catch (err) {
      // Something wasn't cloneable: isolate it so the other results still arrive.
      if (items.length > 1) {
        items.forEach((item, i) => post([item], i === 0 ? prog : []));
        return;
      }
      const failed = {
        kind: 'results',
        results: [{ id: items[0].result.id, ok: false, cancelled: false, error: serializeError(err) }],
        progress: prog,
      };
      scope.postMessage(failed, []);
    }
  }

  function flush() {
    if (!outbox.length && !progress.size) return;
    const items = outbox;
    const prog = [...progress];
    outbox = [];
    progress.clear();
    post(items, prog);
  }

  async function maybeYield() {
    if (performance.now() - lastYield < YIELD_INTERVAL_MS) return;
    flush();
    await yieldToEventLoop();
    lastYield = performance.now();
  }

  async function runTask(task) {
    const controller = new AbortController();
    running.set(task.id, controller);
    const transfer = [];
    const ctx = {
      signal: controller.signal,
      transfer: (...items) => void transfer.push(...items),
      async checkpoint() {
        await maybeYield();
        if (controller.signal.aborted) throw abortError();
      },
      progress(value) {
        if (!controller.signal.aborted) progress.set(task.id, Math.min(1, Math.max(0, value)));
      },
    };
    try {
      const handler = handlers[task.type];
      if (!handler) throw new Error(`Unknown task type "${task.type}"`);
      const value = await handler(task.payload, ctx);
      if (controller.signal.aborted) throw abortError(); // nobody wants it: skip the copy
      send({ id: task.id, ok: true, value }, transfer);
    } catch (err) {
      send({ id: task.id, ok: false, cancelled: controller.signal.aborted, error: serializeError(err) });
    } finally {
      running.delete(task.id);
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        await runTask(queue.shift());
        await maybeYield();
      }
    } finally {
      draining = false;
      flush();
    }
  }

  scope.onmessage = (event) => {
    const msg = event.data;
    if (msg.kind === 'batch') {
      queue.push(...msg.tasks);
      void drain();
      return;
    }
    for (const id of msg.ids) {
      const controller = running.get(id);
      if (controller) {
        controller.abort();
        continue;
      }
      const index = queue.findIndex((t) => t.id === id);
      if (index !== -1) {
        queue.splice(index, 1);
        send({ id, ok: false, cancelled: true, error: serializeError(abortError()) });
      }
    }
    flush();
  };

  return handlers;
}
