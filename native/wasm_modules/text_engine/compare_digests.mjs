/*
 * compare_digests.mjs — structural, tolerant comparison of two engine digests
 * (native vs wasm). Exits 0 if equivalent, 1 otherwise. Floats compared with a
 * small epsilon (float32 round-trip noise); the atlas `region.ptr` is ignored
 * (memory layout is legitimately environment-specific — the atlas `hash` is the
 * byte-equality proof).
 */
import { readFileSync } from 'node:fs';

const EPS = 1e-3;
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')));

function eq(x, y, path = '') {
  if (path.endsWith('.ptr')) return true; // env-specific, intentionally ignored
  if (typeof x === 'number' && typeof y === 'number') {
    if (Math.abs(x - y) > EPS * (1 + Math.abs(x))) {
      console.error(`mismatch at ${path}: ${x} != ${y}`); return false;
    }
    return true;
  }
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) { console.error(`length mismatch at ${path}: ${x.length} != ${y.length}`); return false; }
    return x.every((v, i) => eq(v, y[i], `${path}[${i}]`));
  }
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) if (!eq(x[k], y[k], `${path}.${k}`)) return false;
    return true;
  }
  if (x !== y) { console.error(`mismatch at ${path}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`); return false; }
  return true;
}

process.exit(eq(a, b) ? 0 : 1);
