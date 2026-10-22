// Search, filter and sort rows of plain objects. The same code runs on the page (small data)
// and in a worker (big data), so results are identical wherever it runs.
//
// query = {
//   search:  'text'                      every word must appear in the row's searchable fields
//   fuzzy:   true                        letters in order, not necessarily together ("lsbn" finds Lisbon);
//                                        without a sort, best matches come first
//   filters: [{ key, op, value }]         op: = != < <= > >= contains in between
//   sort:    [{ key, dir: 'asc'|'desc' }] numbers numerically, text naturally ("item 2" < "item 10")
//   limit:   number                       optional
// }
// Returns a Uint32Array of row indices (tiny and transferable; rows are never copied back).

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const noop = async () => {};

const FILTERS = {
  '=': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  contains: (a, b) =>
    String(a ?? '')
      .toLowerCase()
      .includes(String(b).toLowerCase()),
  in: (a, b) => b.includes(a),
  between: (a, b) => a >= b[0] && a <= b[1],
};

/** Pre-lowercases the searchable text once, so every later search is fast. */
export function prepareRows(rows, searchKeys) {
  const keys = searchKeys?.length ? searchKeys : rows.length ? Object.keys(rows[0]) : [];
  const haystack = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    let text = '';
    for (const k of keys) {
      const v = rows[i][k];
      if (v !== null && v !== undefined) text += ` ${v}`;
    }
    haystack[i] = text.toLowerCase();
  }
  return { rows, haystack };
}

/** Score for `needle` appearing in `hay`: substring beats scattered letters; -1 = no match. */
function score(hay, needle, fuzzy) {
  const at = hay.indexOf(needle);
  if (at !== -1) return 1000 - at;
  if (!fuzzy) return -1;
  let total = 0;
  let from = 0;
  let streak = 0;
  for (const ch of needle) {
    const i = hay.indexOf(ch, from);
    if (i === -1) return -1;
    streak = i === from ? streak + 1 : 0;
    total += 1 + streak * 2 - (i - from) * 0.05;
    from = i + 1;
  }
  return total;
}

/**
 * Sort keys as numbers, computed once per column: text is ranked by sorting its distinct values
 * a single time, so the big sort only compares numbers. Empty values go last in either direction.
 */
function sortKeys(rows, hits, key, dir) {
  const keys = new Float64Array(hits.length);
  let numeric = true;
  for (const i of hits) {
    const v = rows[i][key];
    if (v !== null && v !== undefined && typeof v !== 'number') {
      numeric = false;
      break;
    }
  }
  let rank = null;
  if (!numeric) {
    const distinct = new Set();
    for (const i of hits) {
      const v = rows[i][key];
      if (v !== null && v !== undefined) distinct.add(String(v));
    }
    rank = new Map([...distinct].sort(collator.compare).map((v, r) => [v, r]));
  }
  for (let j = 0; j < hits.length; j++) {
    const v = rows[hits[j]][key];
    if (v === null || v === undefined || Number.isNaN(v)) keys[j] = Infinity;
    else keys[j] = dir * (numeric ? v : rank.get(String(v)));
  }
  return keys;
}

export async function queryRows(prepared, query = {}, checkpoint = noop) {
  const { rows, haystack } = prepared;
  const { search = '', fuzzy = false, filters = [], sort = [], limit } = query;
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  const tests = filters.map((f) => {
    const test = FILTERS[f.op ?? '='];
    if (!test) throw new Error(`Unknown filter "${f.op}"`);
    return [f.key, test, f.value];
  });
  const ranked = fuzzy && tokens.length && !sort.length;

  let hits = [];
  const scores = [];
  for (let i = 0; i < rows.length; i++) {
    if ((i & 8191) === 0) await checkpoint();
    let total = 0;
    let ok = true;
    for (const t of tokens) {
      const s = score(haystack[i], t, fuzzy);
      if (s < 0) {
        ok = false;
        break;
      }
      total += s;
    }
    if (!ok) continue;
    for (const [key, test, value] of tests) {
      if (!test(rows[i][key], value)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    hits.push(i);
    if (ranked) scores.push(total);
  }

  await checkpoint();
  if (sort.length || ranked) {
    const columns = ranked
      ? [Float64Array.from(scores, (s) => -s)]
      : sort.map((s) => sortKeys(rows, hits, s.key, s.dir === 'desc' ? -1 : 1));
    const order = Array.from(hits, (_, j) => j);
    order.sort((a, b) => {
      for (const keys of columns) {
        const d = keys[a] - keys[b];
        if (d) return d; // NaN (Infinity - Infinity) counts as equal
      }
      return a - b; // stable
    });
    hits = order.map((j) => hits[j]);
  }
  return Uint32Array.from(limit ? hits.slice(0, limit) : hits);
}
