// The smart part: for every run it predicts how long each backend would take on THIS
// device, picks the fastest, measures what really happened, and learns from it.
//
// Rules on top of the predictions:
//   * never block the page's main thread for more than MAIN_THREAD_BUDGET_MS
//   * backends that don't fit the data (tiny jobs on the GPU, software GPUs...) are skipped
//   * untested backends that might be competitive get tried once, so it can learn them
//   * if a backend fails (GPU lost, worker crash) the next best one runs instead
//   * learned timings are saved per browser, so the next visit starts smart
import { OPS, registerBuiltinOps } from './ops';
import { Memo, keyOf } from '../core/memo';
import { isAbort } from '../core/util';

const MAIN_THREAD_BUDGET_MS = 3;
const STORAGE_KEY = 'native-compute:costs:v1';
const DECAY = 0.9; // older measurements fade so the model follows changes (thermal throttling, other tabs)

/** Starting guesses, ms = a + b * n * opCost. Replaced by real measurements. */
function prior(backend, n, env, opCost) {
  const work = 1.5e-6 * opCost; // ms per element in plain JS, roughly
  switch (backend) {
    case 'inline':
      return 0.01 + n * work;
    case 'worker':
      return 0.5 + n * (work + 2e-6); // + copying in and out
    case 'workers':
      return 1 + n * (work / Math.max(1, env.workers) + 3e-6);
    case 'gpu':
      return 2 + n * (1.5e-7 + 3e-6); // + upload / readback
    default:
      return Infinity;
  }
}

function loadStats() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

class CostModel {
  constructor(stats = {}) {
    this.stats = stats;
  }

  record(key, n, ms) {
    const s = (this.stats[key] ??= { w: 0, x: 0, y: 0, xx: 0, xy: 0, count: 0 });
    s.w = s.w * DECAY + 1;
    s.x = s.x * DECAY + n;
    s.y = s.y * DECAY + ms;
    s.xx = s.xx * DECAY + n * n;
    s.xy = s.xy * DECAY + n * ms;
    s.count++;
  }

  /** Weighted least-squares line through past runs; falls back to the prior's shape. */
  predict(key, n, guess) {
    const s = this.stats[key];
    if (!s || !s.count) return { ms: guess(n), source: 'guess', samples: 0 };
    const mx = s.x / s.w;
    const my = s.y / s.w;
    const varX = s.xx / s.w - mx * mx;
    if (s.count >= 3 && varX > (mx * 0.1) ** 2) {
      const b = Math.max(0, (s.xy / s.w - mx * my) / varX);
      const a = Math.max(0, my - b * mx);
      return { ms: a + b * n, source: 'learned', samples: s.count };
    }
    const g = guess(mx);
    return { ms: g > 0 ? guess(n) * (my / g) : my, source: 'learned', samples: s.count };
  }
}

const failure = (err) => (err instanceof Error ? err.name : '');

export class Engine {
  constructor({ pool, getGpu, getCaps }) {
    registerBuiltinOps();
    this.pool = pool;
    this.getGpu = getGpu;
    this.getCaps = getCaps;
    this.model = new CostModel(loadStats());
    this.disabled = new Set();
    this.warmedUp = new Set();
    this.listeners = new Set();
    this.saveTimer = undefined;
    this.results = new Memo(200);
  }

  /** Ranked options for this op and input, with predicted times and why. */
  async explain(op, input, options = {}) {
    const caps = await this.getCaps();
    return this.plan(op, input, caps, options);
  }

  plan(op, input, caps, { prefer, force, precision } = {}) {
    const def = OPS[op];
    if (!def) throw new Error(`Unknown op "${op}"`);
    const n = def.size(input);
    const env = { caps, n, input, precision, workers: this.pool.size };
    const options = [];
    for (const [backend, impl] of Object.entries(def.backends)) {
      if (force && backend !== force) continue;
      if (this.disabled.has(backend) || this.disabled.has(`${op}:${backend}`)) continue;
      if (impl.available && !impl.available(env)) continue;
      const guess = (size) => prior(backend, size, env, def.cost);
      options.push({ backend, ...this.model.predict(`${op}:${backend}`, n, guess) });
    }
    if (!options.length) throw new Error(`No backend can run "${op}" here`);

    // Keep the page smooth: the main thread only gets jobs that fit in a frame's spare time.
    const smooth = options.filter((o) => o.backend !== 'inline' || o.ms <= MAIN_THREAD_BUDGET_MS);
    const ranked = (smooth.length ? smooth : options).sort((a, b) => a.ms - b.ms);
    ranked.forEach((o) => (o.reason = o.source === 'learned' ? 'fastest measured' : 'best guess'));

    const preferred = prefer && ranked.find((o) => o.backend === prefer);
    if (preferred) {
      preferred.reason = 'preferred';
      return [preferred, ...ranked.filter((o) => o !== preferred)];
    }
    // Explore: an untested backend that could plausibly win gets one try.
    const best = ranked[0];
    const explore = ranked.find(
      (o) => o !== best && o.source === 'guess' && o.backend !== 'inline' && o.ms <= best.ms * 1.5,
    );
    if (explore) {
      explore.reason = 'trying it to learn';
      return [explore, ...ranked.filter((o) => o !== explore)];
    }
    if (ranked.length === 1) best.reason = 'only option';
    return ranked;
  }

  /**
   * Run an op on the best backend. Returns { value, backend, ms, reason, n, options }.
   * options: { signal, prefer, force, precision: 'high' (skip float32 GPU), cache: true }
   */
  async run(op, input, options = {}) {
    if (options.cache) {
      // Same op + same input = same answer: reuse it. (Cached runs ignore `signal`, because
      // other callers may be waiting on the same result.)
      const key = `${op}|${options.precision ?? ''}|${keyOf(input)}`;
      const hit = this.results.get(key);
      if (hit) {
        const result = await hit;
        return { ...result, backend: 'cache', ms: 0, reason: 'cached result' };
      }
      const promise = this.runFresh(op, input, { ...options, signal: undefined });
      this.results.set(key, promise);
      promise.catch(() => this.results.delete(key));
      return promise;
    }
    return this.runFresh(op, input, options);
  }

  async runFresh(op, input, options) {
    const { signal } = options;
    const caps = await this.getCaps();
    const plan = this.plan(op, input, caps, options);
    const snapshot = plan.map(({ backend, ms, source }) => ({ backend, ms, source }));
    const n = OPS[op].size(input);
    let lastError;
    let retried = false;

    for (let i = 0; i < plan.length; i++) {
      const choice = plan[i];
      const impl = OPS[op].backends[choice.backend];
      const started = performance.now();
      try {
        const value = await impl.run(input, {
          pool: this.pool,
          getGpu: this.getGpu,
          signal,
          workers: this.pool.size,
        });
        const ms = performance.now() - started;
        this.learn(`${op}:${choice.backend}`, choice.backend, n, ms);
        const decision = {
          op,
          backend: choice.backend,
          ms,
          n,
          reason: i > 0 ? `fallback after ${plan[0].backend} failed` : choice.reason,
          options: snapshot,
        };
        this.listeners.forEach((fn) => fn(decision));
        return { value, ...decision };
      } catch (err) {
        if (signal?.aborted || isAbort(err)) throw err;
        lastError = err;
        if (failure(err) === 'GpuUnavailableError') {
          this.disabled.add('gpu'); // GPU lost: don't offer it again this session
        } else if (failure(err) === 'WorkerCrashedError' && !retried) {
          retried = true; // the pool already replaced the worker (and reloaded its data): try once more
          i--;
        } else if (failure(err) !== 'WorkerCrashedError') {
          throw err; // a real error in the job itself
        }
      }
    }
    throw lastError;
  }

  /** Measure every backend for an op at a few sizes, so decisions are good from the start. */
  async calibrate(op, makeInput, sizes = [10_000, 100_000, 1_000_000], { signal } = {}) {
    const caps = await this.getCaps();
    for (const size of sizes) {
      const input = makeInput(size);
      for (const { backend } of this.plan(op, input, caps)) {
        for (let r = 0; r < 2; r++) {
          if (signal?.aborted) return;
          await this.run(op, input, { force: backend, signal }).catch(() => {});
        }
      }
    }
  }

  /** Subscribe to every decision (for dev tools or a status line). Returns unsubscribe. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Forget everything learned on this device. */
  reset() {
    this.model = new CostModel({});
    this.results.clear();
    this.disabled.clear();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  learn(key, backend, n, ms) {
    // The first run of a backend includes starting workers / creating the GPU context: not representative.
    if (backend !== 'inline' && !this.warmedUp.has(backend)) {
      this.warmedUp.add(backend);
      return;
    }
    this.model.record(key, n, ms);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.model.stats));
      } catch {
        /* private mode or quota: learning still works for this session */
      }
    }, 1000);
  }
}
