/**
 * SPIR-V → WGSL, in-process.
 *
 * Effects ship SPIR-V (DXC compiles the HLSL once at bundle-build time and
 * bakes it into the .wasm). WebGPU doesn't accept SPIR-V, so something has to
 * translate at load time. That used to be `POST /__naga/wgsl` — a Vite plugin
 * marked `apply: 'serve'` that spawns the `naga` CLI — which meant anything not
 * sitting behind the dev server had NO shader pipeline at all. Not a degraded
 * one: every `createShaderModuleByName` returned -1 and nothing rendered.
 *
 * `naga_spv.wasm` is the naga crate itself built to wasm32-wasip1 (see
 * native/naga_spv/). One artifact, same on macOS and Windows, ~590 KB.
 *
 * TWO CONSTRAINTS SHAPE THIS FILE:
 *
 *  - It must be SYNCHRONOUS. `wasm-host.ts`'s `fetchShaderWgsl` is called from
 *    inside an effect's `init()`, across the wasm import boundary, by C++ that
 *    expects a shader handle back immediately. There is no await to insert. So
 *    the module bytes come in over a synchronous XHR and are compiled with the
 *    synchronous `new WebAssembly.Module` — both legal in a worker, which is
 *    where the engine actually runs.
 *  - It must produce BYTE-IDENTICAL output to the CLI, including the
 *    `rgba32float` fixup, or a packaged build silently diverges from the one
 *    every effect was developed against. Pinned by naga-wgsl.test.ts.
 */

/** Exports of naga_spv.wasm — see native/naga_spv/src/lib.rs. */
interface NagaExports {
  memory: WebAssembly.Memory;
  ns_alloc(n: number): number;
  ns_free(p: number, n: number): void;
  ns_translate(p: number, n: number): number;
  ns_result_ptr(): number;
  ns_result_len(): number;
}

/**
 * Minimal `wasi_snapshot_preview1` for naga_spv.wasm. It imports exactly four
 * functions — no filesystem, no clock, no randomness — because translation is
 * a pure function over the input bytes. `fd_write` only ever carries a panic
 * message, so it goes to the console rather than being swallowed.
 */
function makeNagaWasi(mem: () => WebAssembly.Memory): WebAssembly.ModuleImports {
  const dv = () => new DataView(mem().buffer);
  return {
    environ_get: () => 0,
    environ_sizes_get: (c: number, s: number) => {
      const d = dv();
      d.setUint32(c, 0, true);
      d.setUint32(s, 0, true);
      return 0;
    },
    fd_write: (_fd: number, iovs: number, n: number, nwr: number) => {
      const d = dv();
      const bytes = new Uint8Array(mem().buffer);
      let total = 0;
      let text = '';
      for (let i = 0; i < n; i++) {
        const ptr = d.getUint32(iovs + i * 8, true);
        const len = d.getUint32(iovs + i * 8 + 4, true);
        text += new TextDecoder().decode(bytes.subarray(ptr, ptr + len));
        total += len;
      }
      if (text.trim()) console.error('[naga_spv]', text.trimEnd());
      d.setUint32(nwr, total, true);
      return 0;
    },
    proc_exit: (code: number) => {
      throw new Error(`naga_spv.wasm proc_exit ${code}`);
    },
  } as unknown as WebAssembly.ModuleImports;
}

let instance: NagaExports | null = null;
/** Sticky: one failed load means the artifact is missing or broken, and
 *  retrying it per shader would block the worker on a doomed XHR every time. */
let loadFailed = false;

/**
 * Compile and instantiate the translator, synchronously. Returns null if the
 * artifact isn't there — which is the normal state of a checkout that hasn't
 * run `native/naga_spv/build_wasm.sh`, so the caller falls back to the dev
 * server rather than failing.
 */
function ensureLoaded(url: string): NagaExports | null {
  if (instance) return instance;
  if (loadFailed) return null;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, /*async=*/false);
    // Sync XHR forbids responseType from a document context; workers tolerate
    // it. Fall back to reading the raw text as latin1 if it's refused.
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      xhr.responseType = 'arraybuffer';
      xhr.send();
      bytes = new Uint8Array(xhr.response as ArrayBuffer);
    } catch {
      const plain = new XMLHttpRequest();
      plain.open('GET', url, false);
      plain.overrideMimeType('text/plain; charset=x-user-defined');
      plain.send();
      const s = plain.responseText;
      bytes = new Uint8Array(new ArrayBuffer(s.length));
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    }
    if (bytes.length === 0) throw new Error(`empty response from ${url}`);

    const mod = new WebAssembly.Module(bytes);
    let memRef: WebAssembly.Memory | null = null;
    const inst = new WebAssembly.Instance(mod, {
      wasi_snapshot_preview1: makeNagaWasi(() => memRef!),
    });
    const ex = inst.exports as unknown as NagaExports;
    memRef = ex.memory;
    instance = ex;
    return instance;
  } catch (err) {
    loadFailed = true;
    console.warn(`[naga-wgsl] local translator unavailable (${url}):`, err);
    return null;
  }
}

/**
 * naga emits `rgba32float` as its default for an HLSL `RWTexture2D<float4>`,
 * because SPIR-V doesn't carry the format the HLSL `register` declaration
 * implied. The build helpers have always patched that back up with sed
 * (native/wasm_modules/wasm_build_env.sh) and so does the dev-server plugin.
 *
 * This is the ONE copy both runtime paths share — it used to be duplicated in
 * naga-bridge.ts, and a silent divergence here means a bind-group layout
 * mismatch, which shows up as black output rather than an error.
 */
export function applyStorageFormat(
  wgsl: string,
  storageFormat: string,
  storageAccess: string,
): string {
  return wgsl
    .replace(/rgba32float,read_write/g, `${storageFormat},${storageAccess}`)
    .replace(/rgba32float/g, storageFormat);
}

/**
 * Translate SPIR-V to WGSL in-process, applying the storage-format fixup.
 * Returns null when the translator isn't available (caller should fall back to
 * the dev-server endpoint) and throws when naga itself rejects the input —
 * those are two different failures and only one of them is worth retrying.
 */
export function spvToWgsl(
  spv: Uint8Array,
  storageFormat: string,
  storageAccess: string,
  url = '/wasm/naga_spv.wasm',
): string | null {
  const ex = ensureLoaded(url);
  if (!ex) return null;

  const ptr = ex.ns_alloc(spv.length);
  if (!ptr) throw new Error('[naga-wgsl] ns_alloc failed');
  try {
    new Uint8Array(ex.memory.buffer, ptr, spv.length).set(spv);
    const ok = ex.ns_translate(ptr, spv.length);
    // The result buffer carries the WGSL on success and the error text on
    // failure, and is overwritten by the next call — so copy it out here.
    const rp = ex.ns_result_ptr();
    const rl = ex.ns_result_len();
    const text = new TextDecoder().decode(
      new Uint8Array(ex.memory.buffer, rp, rl).slice(),
    );
    if (!ok) throw new Error(text || 'naga_spv: translation failed');
    return applyStorageFormat(text, storageFormat, storageAccess);
  } finally {
    ex.ns_free(ptr, spv.length);
  }
}

/** True once the translator is loaded and usable. For diagnostics/tests. */
export function isLocalTranslatorReady(): boolean {
  return instance !== null;
}

/** Test seam: forget the loaded instance so a later call re-resolves. */
export function resetLocalTranslator(): void {
  instance = null;
  loadFailed = false;
}

/**
 * Install the translator from bytes the caller already has, skipping the XHR.
 * Used by node-side tests (no XHR, and the artifact is right there on disk) and
 * available to any host that would rather hand the bytes over than serve them.
 */
export function loadLocalTranslatorFromBytes(bytes: Uint8Array<ArrayBuffer>): void {
  const mod = new WebAssembly.Module(bytes);
  let memRef: WebAssembly.Memory | null = null;
  const inst = new WebAssembly.Instance(mod, {
    wasi_snapshot_preview1: makeNagaWasi(() => memRef!),
  });
  const ex = inst.exports as unknown as NagaExports;
  memRef = ex.memory;
  instance = ex;
  loadFailed = false;
}
