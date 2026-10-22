// Main thread: a pool of workers with batching, zero-copy transfer,
// latest-wins cancellation, progress, and broadcast of shared state to every worker.
import { collectTransferables } from './transfer';
import { unique } from './protocol';

export class TaskCancelledError extends Error {
  name = 'AbortError';
  reason;
  constructor(reason) {
    super(`Task cancelled (${reason})`);
    this.reason = reason;
  }
}
export { isAbort as isCancelled } from './util';

export class WorkerTaskError extends Error {
  constructor(wire) {
    super(wire.message);
    this.name = wire.name;
    if (wire.stack) this.stack = wire.stack;
  }
}

export class WorkerCrashedError extends Error {
  name = 'WorkerCrashedError';
}

export function defaultPoolSize() {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const cores = nav?.hardwareConcurrency || 4;
  const memory = nav?.deviceMemory ?? 8;
  const cap = memory <= 2 ? 2 : memory <= 4 ? 3 : 6;
  return Math.max(1, Math.min(cores - 1, cap));
}

/**
 * new WorkerPool(options)
 *   createWorker          () => Worker   (required)
 *   size                  number of workers; default from CPU cores and device memory
 *   maxBatchSize          max tasks per postMessage (default 32)
 *   maxInFlightPerWorker  tasks handed to one worker at once; the rest wait where cancelling is free (default 32)
 *   batchWindowMs         0 = flush at the end of the tick (default); >0 = collect for N ms first
 *
 * pool.run(type, payload, options)
 *   key         latest wins: a new task with the same key cancels the previous one
 *   transfer    array of Transferables, or 'auto' to find them in the payload (they become unusable here)
 *   signal      AbortSignal
 *   timeoutMs   cancel with reason 'timeout'
 *   onProgress  (0..1) => void, fed by ctx.progress() in the worker
 *   priority    'high' jumps the queue (e.g. the image the user is looking at right now)
 *   affinity    tasks with the same affinity key always run on the same worker (data loaded there stays there)
 *   replay      with affinity: re-run this task on a replacement worker if that worker crashes (for loading data)
 *
 * pool.broadcast(type, payload, { key, replay = true })
 *   Runs on every worker; replayed to workers created later. Use a distinct key per dataset.
 *
 * Inside a handler, ctx gives: signal, transfer(...objects), await checkpoint(), progress(0..1).
 */
export class WorkerPool {
  opts;
  slots = [];
  queue = [];
  tasks = new Map();
  latestByKey = new Map();
  sticky = new Map();
  affinity = new Map(); // affinity key -> slot
  replays = new Map(); // affinity key -> task to re-run on a replacement worker
  nextId = 1;
  flushScheduled = false;
  cancelFlushScheduled = false;
  terminated = false;

  constructor(options) {
    this.opts = {
      createWorker: options.createWorker,
      size: Math.max(1, options.size ?? defaultPoolSize()),
      maxBatchSize: options.maxBatchSize ?? 32,
      maxInFlightPerWorker: options.maxInFlightPerWorker ?? 32,
      batchWindowMs: options.batchWindowMs ?? 0,
    };
  }

  run(type, payload, options = {}) {
    return this.enqueue(type, payload, options);
  }

  /**
   * Run a task on EVERY worker, e.g. to load a dataset or model that later tasks use.
   * Payloads are cloned per worker; wrap big typed arrays with share() to avoid any copy.
   */
  broadcast(type, payload, options = {}) {
    if (this.terminated) return Promise.reject(new TaskCancelledError('terminated'));
    const key = options.key ?? type;
    this.sticky.delete(key);
    this.ensureSlots();
    if (options.replay !== false) this.sticky.set(key, { type, payload });
    return Promise.all(this.slots.map((slot) => this.enqueue(type, payload, {}, slot)));
  }

  /** Stop replaying a broadcast to new workers (call when that shared data is no longer needed). */
  forget(key) {
    this.sticky.delete(key);
    this.affinity.delete(key);
    this.replays.delete(key);
  }

  /** Start all workers now (e.g. when idle) so the first real task has no startup cost. */
  prewarm() {
    if (!this.terminated) this.ensureSlots();
  }

  cancel(key) {
    const task = this.latestByKey.get(key);
    if (task) this.cancelTask(task, 'aborted');
    return !!task;
  }

  cancelAll() {
    for (const task of [...this.tasks.values()]) this.cancelTask(task, 'aborted');
  }

  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    for (const task of [...this.tasks.values()]) this.settle(task, false, new TaskCancelledError('terminated'));
    this.queue = [];
    this.sticky.clear();
    this.affinity.clear();
    this.replays.clear();
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
  }

  /** Number of workers this pool runs (created lazily). */
  get size() {
    return this.opts.size;
  }

  get isTerminated() {
    return this.terminated;
  }

  get stats() {
    return {
      workers: this.slots.length,
      queued: this.queue.length,
      inFlight: this.slots.reduce((n, s) => n + s.awaiting.size, 0),
    };
  }

  // ---- internals -----------------------------------------------------------

  enqueue(type, payload, options, pinned, front = false) {
    const { key, signal, timeoutMs, onProgress, affinity } = options;
    if (options.priority === 'high') front = true;
    if (affinity !== undefined && options.replay) this.replays.set(affinity, { type, payload });
    if (this.terminated) return Promise.reject(new TaskCancelledError('terminated'));
    if (signal?.aborted) return Promise.reject(new TaskCancelledError('aborted'));
    const transfer = options.transfer === 'auto' ? collectTransferables(payload) : (options.transfer ?? []);

    return new Promise((resolve, reject) => {
      const cleanups = [];
      const task = {
        id: this.nextId++,
        type,
        payload,
        transfer,
        key,
        pinned,
        affinity,
        onProgress,
        state: 'queued',
        resolve,
        reject,
        cleanup: () => cleanups.forEach((fn) => fn()),
      };
      if (key !== undefined) {
        const previous = this.latestByKey.get(key);
        if (previous) this.cancelTask(previous, 'superseded');
        this.latestByKey.set(key, task);
      }
      if (signal) {
        const onAbort = () => this.cancelTask(task, 'aborted');
        signal.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener('abort', onAbort));
      }
      if (timeoutMs !== undefined) {
        const timer = setTimeout(() => this.cancelTask(task, 'timeout'), timeoutMs);
        cleanups.push(() => clearTimeout(timer));
      }
      this.tasks.set(task.id, task);
      if (front) this.queue.unshift(task);
      else this.queue.push(task);
      this.scheduleFlush();
    });
  }

  ensureSlots() {
    while (this.slots.length < this.opts.size) {
      const slot = this.spawn();
      this.slots.push(slot);
      // Replay shared state first so it lands before any normal task on this worker.
      const entries = [...this.sticky.values()].reverse();
      for (const { type, payload } of entries) this.enqueue(type, payload, {}, slot, true).catch(() => {});
    }
  }

  spawn() {
    const slot = { worker: this.opts.createWorker(), awaiting: new Set(), cancels: [] };
    slot.worker.onmessage = (e) => this.onResults(slot, e.data);
    slot.worker.onerror = (e) => {
      e.preventDefault?.();
      this.onCrash(slot, e.message || 'worker error');
    };
    slot.worker.onmessageerror = () => this.onCrash(slot, 'could not deserialize a worker message');
    return slot;
  }

  onCrash(slot, message) {
    const index = this.slots.indexOf(slot);
    if (index === -1) return;
    this.slots.splice(index, 1); // replaced lazily on the next flush
    slot.worker.terminate();
    for (const id of slot.awaiting) {
      const task = this.tasks.get(id);
      if (task) this.settle(task, false, new WorkerCrashedError(`Worker crashed: ${message}`));
    }
    // Data that lived on this worker is reloaded on whichever worker takes over.
    for (const [key, owner] of this.affinity) {
      if (owner !== slot) continue;
      this.affinity.delete(key);
      const replay = this.replays.get(key);
      if (replay) this.enqueue(replay.type, replay.payload, { affinity: key }, undefined, true).catch(() => {});
    }
    if (this.queue.length) this.scheduleFlush();
  }

  pickSlot(ignoreCapacity = false) {
    let best;
    for (const slot of this.slots) {
      if (!ignoreCapacity && slot.awaiting.size >= this.opts.maxInFlightPerWorker) continue;
      if (!best || slot.awaiting.size < best.awaiting.size) best = slot;
    }
    return best;
  }

  scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    if (this.opts.batchWindowMs > 0) setTimeout(this.flush, this.opts.batchWindowMs);
    else queueMicrotask(this.flush);
  }

  flush = () => {
    this.flushScheduled = false;
    if (this.terminated || !this.queue.length) return;
    this.ensureSlots();

    const batches = new Map();
    const waiting = [];
    for (const task of this.queue) {
      if (task.state !== 'queued') continue;
      let slot = task.pinned;
      if (slot && !this.slots.includes(slot)) {
        this.settle(task, false, new WorkerCrashedError('The worker for this task is gone'));
        continue;
      }
      if (!slot && task.affinity !== undefined) {
        slot = this.affinity.get(task.affinity);
        if (!slot) {
          slot = this.pickSlot(true);
          this.affinity.set(task.affinity, slot);
        }
      }
      slot ??= this.pickSlot();
      if (!slot) {
        waiting.push(task); // every worker is busy: resumes when results come back
        continue;
      }
      task.state = 'sent';
      task.slot = slot;
      slot.awaiting.add(task.id);
      const batch = batches.get(slot) ?? [];
      batches.set(slot, batch);
      batch.push(task);
    }
    this.queue = waiting;

    for (const [slot, batch] of batches) {
      for (let i = 0; i < batch.length; i += this.opts.maxBatchSize) {
        this.post(slot, batch.slice(i, i + this.opts.maxBatchSize));
      }
    }
  };

  post(slot, batch) {
    const message = {
      kind: 'batch',
      tasks: batch.map(({ id, type, payload }) => ({ id, type, payload })),
    };
    try {
      slot.worker.postMessage(message, unique(batch.flatMap((t) => t.transfer)));
    } catch (err) {
      // e.g. DataCloneError: retry one by one so only the bad task fails.
      if (batch.length > 1) return batch.forEach((t) => this.post(slot, [t]));
      slot.awaiting.delete(batch[0].id);
      this.settle(batch[0], false, err);
      return;
    }
    for (const task of batch) {
      task.payload = undefined;
      task.transfer = [];
    }
  }

  onResults(slot, msg) {
    for (const [id, value] of msg.progress) {
      try {
        this.tasks.get(id)?.onProgress?.(value);
      } catch (err) {
        console.error(err);
      }
    }
    for (const r of msg.results) {
      slot.awaiting.delete(r.id);
      const task = this.tasks.get(r.id);
      if (!task) continue; // already cancelled here; this was the acknowledgement
      if (r.ok) this.settle(task, true, r.value);
      else this.settle(task, false, r.cancelled ? new TaskCancelledError('aborted') : new WorkerTaskError(r.error));
    }
    if (this.queue.length) this.scheduleFlush();
  }

  cancelTask(task, reason) {
    if (task.state === 'settled') return;
    if (task.state === 'queued') {
      const index = this.queue.indexOf(task);
      if (index !== -1) this.queue.splice(index, 1); // never left this thread: free
    } else if (task.slot) {
      task.slot.cancels.push(task.id);
      if (!this.cancelFlushScheduled) {
        this.cancelFlushScheduled = true;
        queueMicrotask(this.flushCancels);
      }
    }
    this.settle(task, false, new TaskCancelledError(reason));
  }

  flushCancels = () => {
    this.cancelFlushScheduled = false;
    for (const slot of this.slots) {
      if (!slot.cancels.length) continue;
      const message = { kind: 'cancel', ids: slot.cancels };
      slot.worker.postMessage(message);
      slot.cancels = [];
    }
  };

  settle(task, ok, value) {
    if (task.state === 'settled') return;
    task.state = 'settled';
    this.tasks.delete(task.id);
    if (task.key !== undefined && this.latestByKey.get(task.key) === task) this.latestByKey.delete(task.key);
    task.cleanup();
    task.payload = undefined;
    task.transfer = [];
    if (ok) task.resolve(value);
    else task.reject(value);
  }
}
