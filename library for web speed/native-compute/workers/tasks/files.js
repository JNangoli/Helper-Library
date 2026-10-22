// Files: CSV and JSON parsing, text reading, hashing and compression, with progress.
import { unsupported } from '../../core/util';

/** Reads a Blob as text in chunks, reporting progress. */
async function readText(blob, ctx, share = 1) {
  if (typeof blob === 'string') return blob;
  if (!blob.stream) return blob.text();
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(decoder.decode(value, { stream: true }));
    loaded += value.byteLength;
    ctx.progress((loaded / blob.size) * share);
    await ctx.checkpoint();
  }
  parts.push(decoder.decode());
  return parts.join('');
}

async function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('Expected a string, Blob, ArrayBuffer or typed array');
}

async function pipeBytes(data, transform) {
  const bytes = await toBytes(data);
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Response(stream).arrayBuffer();
}

function detectDelimiter(text) {
  const end = text.indexOf('\n');
  const line = end === -1 ? text : text.slice(0, end);
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    const count = line.split(d).length - 1;
    if (count > bestCount) [best, bestCount] = [d, count];
  }
  return best;
}

export const files = {
  /** RFC-4180 CSV (quotes, escaped quotes, CRLF), delimiter auto-detected, typed numeric columns. */
  async parseCSV(input, ctx) {
    const text = typeof input.source === 'string' ? input.source : await input.source.text();
    const d = (input.delimiter ?? detectDelimiter(text)).charCodeAt(0);
    const n = text.length;
    const rows = [];
    let row = [];
    let i = 0;

    while (i < n) {
      if (row.length === 0 && (rows.length & 4095) === 0) {
        ctx.progress((i / n) * 0.9);
        await ctx.checkpoint();
      }
      let field;
      if (text.charCodeAt(i) === 34) {
        // Quoted field: copy slices between quotes instead of char by char.
        let j = i + 1;
        field = '';
        for (;;) {
          const q = text.indexOf('"', j);
          if (q === -1) {
            field += text.slice(j);
            j = n;
            break;
          }
          field += text.slice(j, q);
          if (text.charCodeAt(q + 1) === 34) {
            field += '"';
            j = q + 2;
          } else {
            j = q + 1;
            break;
          }
        }
        i = j;
      } else {
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === d || c === 10 || c === 13) break;
          j++;
        }
        field = text.slice(i, j);
        i = j;
      }
      row.push(field);

      if (text.charCodeAt(i) === d) {
        i++;
        if (i === n) row.push('');
        continue;
      }
      if (text.charCodeAt(i) === 13) i++;
      if (text.charCodeAt(i) === 10) i++;
      if (!(row.length === 1 && row[0] === '')) rows.push(row); // skip blank lines
      row = [];
    }
    if (row.length) rows.push(row);

    const header = input.header === false ? [] : (rows.shift() ?? []);
    let width = header.length;
    for (const r of rows) if (r.length > width) width = r.length;

    const columns = [];
    for (let c = 0; c < width; c++) {
      await ctx.checkpoint();
      const values = new Float64Array(rows.length);
      let filled = 0;
      let numeric = 0;
      for (let r = 0; r < rows.length; r++) {
        const raw = rows[r][c];
        if (raw === undefined || raw === '' || raw.trim() === '') {
          values[r] = NaN;
          continue;
        }
        filled++;
        const v = Number(raw);
        values[r] = v;
        if (!Number.isNaN(v)) numeric++;
      }
      const isNumeric = filled > 0 && numeric / filled >= 0.95;
      if (isNumeric) ctx.transfer(values.buffer);
      columns.push({
        name: header[c]?.trim() || `Column ${c + 1}`,
        numeric: isNumeric ? values : null,
        text: isNumeric ? null : rows.map((r) => r[c] ?? ''),
      });
      ctx.progress(0.9 + (0.1 * (c + 1)) / width);
    }
    return { rows: rows.length, columns };
  },

  /** Parse JSON from text or a File/Blob, with read progress. */
  async parseJSON(input, ctx) {
    const text = await readText(input.source, ctx, 0.9);
    const value = JSON.parse(text);
    ctx.progress(1);
    return value;
  },

  /** Read a File/Blob as text with progress. */
  readText(input, ctx) {
    return readText(input.source, ctx);
  },

  /** SHA-256 (or SHA-1/384/512) of a string, Blob or bytes, as hex. */
  async hash(input) {
    const bytes = await toBytes(input.data);
    const digest = await crypto.subtle.digest(input.algorithm ?? 'SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  },

  /** gzip / deflate with the browser's native compressor. Returns an ArrayBuffer. */
  async compress(input, ctx) {
    if (typeof CompressionStream === 'undefined') throw unsupported('CompressionStream');
    const out = await pipeBytes(input.data, new CompressionStream(input.format ?? 'gzip'));
    ctx.transfer(out);
    return out;
  },

  async decompress(input, ctx) {
    if (typeof DecompressionStream === 'undefined') throw unsupported('DecompressionStream');
    const out = await pipeBytes(input.data, new DecompressionStream(input.format ?? 'gzip'));
    ctx.transfer(out);
    return out;
  },
};
