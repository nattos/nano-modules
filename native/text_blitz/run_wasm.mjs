// Run the wasm32-wasip1 build of the Blitz spike under Node's WASI and print
// its glyph runs to stdout — so we can diff them against the native build and
// prove native↔wasm parity of Blitz layout+shaping.
//
//   node --experimental-wasi-unstable-preview1 run_wasm.mjs [fontPathUnderRoot] [htmlPathUnderRoot]
//
// The repo root is preopened as "/", so pass repo-relative paths like
// "web/public/fonts/default.ttf" (resolved as "/web/...").
import { WASI } from 'node:wasi';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..'); // native/text_blitz -> repo root
const wasmPath = resolve(here, 'target/wasm32-wasip1/release/blitz_runs.wasm');

const font = process.argv[2] ?? 'web/public/fonts/default.ttf';
const args = ['blitz_runs', `/${font}`];
if (process.argv[3]) args.push(`/${process.argv[3]}`);

const wasi = new WASI({
  version: 'preview1',
  args,
  env: {},
  preopens: { '/': repoRoot },
  returnOnExit: true,
});

const wasm = await WebAssembly.compile(readFileSync(wasmPath));
const instance = await WebAssembly.instantiate(wasm, wasi.getImportObject());
const code = wasi.start(instance);
process.exit(code ?? 0);
