import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WasmHost } from './wasm-host';
import { buildImports, captureSchemas, loadHost } from './testing/node-wasm-host';

// The WasmHost lifecycle is exercised on testonly.wasm's debug.trigger_probe,
// a pure-data effect that fires host.trigger_audio, resolume.trigger_clip and
// state.console_log_structured on each rising edge of `fire`. (The looper's own
// cases live with it, in nano-modules-extras' tests/web.)

describe('WasmHost', () => {
  it('loads a bundle and activates one effect', async () => {
    const { module } = await loadHost();
    module.init();
  });

  it('tick and render run without error (GPU-less host)', async () => {
    const { host, module } = await loadHost();
    module.init();
    host.frameState.viewportW = 800;
    host.frameState.viewportH = 600;
    for (let i = 0; i < 10; i++) {
      host.frameState.elapsedTime = i * 0.016;
      module.tick(0.016);
    }
    expect(() => module.render(800, 600)).not.toThrow();
  });

  it('a patched input reaches the effect, whose trigger_audio and structured log reach the host', async () => {
    const { host, module } = await loadHost();
    module.init();
    const channels: number[] = [];
    host.onAudioTrigger = (ch) => { channels.push(ch); };

    host.notifyStatePatched(module, [{ op: 'replace', path: 'channel', value: 3 }]);
    // off → on (fires) → held (no re-fire) → off → on (fires)
    for (const fire of [0, 1, 1, 0, 1]) {
      host.notifyStatePatched(module, [{ op: 'replace', path: 'fire', value: fire }]);
      module.tick(0.016);
    }

    expect(channels).toEqual([3, 3]);
    const fired = host.consoleLogs.filter((l) => l.message === 'trigger_probe: fired');
    expect(fired.map((l) => l.data)).toEqual([
      { channel: 3, count: 1 },
      { channel: 3, count: 2 },
    ]);
  });
});


// ---------------------------------------------------------------------------
// is_identity ABI dispatch
//
// The effect's optional `is_identity` predicate is registered by name (it may
// be absent). The host exposes it as the activated module's isIdentity()
// method, threading the per-instance `self` through the indirect function table
// exactly like tick/render/on_state_patched.
//
// This test synthesizes a name-keyed EffectInfo and a fake indirect-function-
// table (an object exposing .get(idx)), drives the host's real activateEffect,
// and asserts isIdentity() resolves through the table — covering both the
// name→index lookup and the self-threading wrapper without GPU.
// ---------------------------------------------------------------------------
describe('is_identity name-keyed dispatch', () => {
  // Build a host with a synthetic name-keyed descriptor + fake function table.
  // `identityResult` is what the fake is_identity table entry returns
  // (a number, like the wasm function would); pass `null` to omit the
  // predicate entirely (absent name => never skippable).
  function makeHostWithDescriptor(identityResult: number | null): {
    host: WasmHost; capturedSelf: { value: number };
  } {
    const host = new WasmHost();
    const memory = new WebAssembly.Memory({ initial: 1 });

    // Fake indirect function table: we only ever need .get(idx).
    const SELF = 0xABCD;       // sentinel "self" pointer create() returns
    const capturedSelf = { value: 0 };
    const IDX_CREATE = 1, IDX_INIT = 2, IDX_TICK = 3, IDX_RENDER = 4,
          IDX_ONPATCH = 5, IDX_IS_IDENTITY = 9;
    const table = {
      get(idx: number): any {
        switch (idx) {
          case IDX_CREATE: return () => SELF;
          case IDX_INIT: return (_self: number) => {};
          case IDX_TICK: return (_self: number, _dt: number) => {};
          case IDX_RENDER: return (_self: number, _w: number, _h: number) => {};
          case IDX_ONPATCH: return () => {};
          case IDX_IS_IDENTITY:
            return (self: number) => { capturedSelf.value = self; return identityResult; };
          default: return null;
        }
      },
    };

    (host as any).memory = memory;
    (host as any).instance = { exports: { __indirect_function_table: table } };

    // Name-keyed callbacks. is_identity is simply absent when not provided.
    const fns = new Map<string, number>([
      ['create', IDX_CREATE],
      ['init', IDX_INIT],
      ['tick', IDX_TICK],
      ['render', IDX_RENDER],
      ['on_state_patched', IDX_ONPATCH],
    ]);
    if (identityResult !== null) fns.set('is_identity', IDX_IS_IDENTITY);

    (host as any).registeredEffects.push({
      id: 'video.test_identity',
      name: 'Test Identity',
      description: 'desc',
      category: 'video',
      keywords: [],
      _fns: fns,
    });

    return { host, capturedSelf };
  }

  it('isIdentity() returns true when the predicate returns nonzero', () => {
    const { host } = makeHostWithDescriptor(1);
    const module = host.activateEffect('video.test_identity');
    expect(module.isIdentity()).toBe(true);
  });

  it('isIdentity() returns false when the predicate returns zero', () => {
    const { host } = makeHostWithDescriptor(0);
    const module = host.activateEffect('video.test_identity');
    expect(module.isIdentity()).toBe(false);
  });

  it('isIdentity() returns false when no predicate is registered (idx 0)', () => {
    const { host } = makeHostWithDescriptor(null);
    const module = host.activateEffect('video.test_identity');
    expect(module.isIdentity()).toBe(false);
  });

  it('isIdentity() threads the per-instance self pointer', () => {
    const { host, capturedSelf } = makeHostWithDescriptor(1);
    const module = host.activateEffect('video.test_identity');
    module.isIdentity();
    // create() returned 0xABCD; the wrapper must pass that as `self`.
    expect(capturedSelf.value).toBe(0xABCD);
  });
});

// ---------------------------------------------------------------------------
// describeEffect — type-level schema discovery WITHOUT an instance
//
// The schema is published by module_init (type-level, self-less, GPU-guarded),
// so describeEffect runs only module_init + resolves the self-less
// eval_visibility fn — never create()/init(). A later activateEffect on the
// same host PROMOTES it to a live instance (create()+init()) WITHOUT re-running
// module_init. This is the bundle-warmup / visibility-host path.
// ---------------------------------------------------------------------------
describe('describeEffect — schema-only, no instance', () => {
  function makeHost(): {
    host: WasmHost;
    counts: { moduleInit: number; create: number; init: number };
  } {
    const host = new WasmHost();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const counts = { moduleInit: 0, create: 0, init: 0 };
    const SELF = 0x1234;
    const IDX_MODULE_INIT = 1, IDX_CREATE = 2, IDX_INIT = 3, IDX_EVAL = 4;
    const table = {
      get(idx: number): any {
        switch (idx) {
          case IDX_MODULE_INIT: return () => { counts.moduleInit++; };
          case IDX_CREATE: return () => { counts.create++; return SELF; };
          case IDX_INIT: return (_self: number) => { counts.init++; };
          case IDX_EVAL: return () => {};
          default: return null;
        }
      },
    };
    (host as any).memory = memory;
    (host as any).instance = { exports: { __indirect_function_table: table } };
    (host as any).registeredEffects.push({
      id: 'video.test_identity', name: 'Test', description: '', category: 'video', keywords: [],
      _fns: new Map<string, number>([
        ['module_init', IDX_MODULE_INIT], ['create', IDX_CREATE],
        ['init', IDX_INIT], ['eval_visibility', IDX_EVAL],
      ]),
    });
    return { host, counts };
  }

  it('runs module_init once + resolves eval_visibility, never creating an instance', () => {
    const { host, counts } = makeHost();
    host.describeEffect('video.test_identity');
    expect(counts.moduleInit).toBe(1);
    expect(counts.create).toBe(0);
    expect(counts.init).toBe(0);
    expect(host.evalVisibilityFn).not.toBeNull();
  });

  it('is idempotent — module_init runs once across repeated describes', () => {
    const { host, counts } = makeHost();
    host.describeEffect('video.test_identity');
    host.describeEffect('video.test_identity');
    expect(counts.moduleInit).toBe(1);
  });

  it('promotion: activateEffect after describe creates the instance but does NOT re-run module_init', () => {
    const { host, counts } = makeHost();
    host.describeEffect('video.test_identity');
    const mod = host.activateEffect('video.test_identity');
    expect(counts.moduleInit).toBe(1); // already ran in describe — not repeated
    expect(counts.create).toBe(1);
    expect(counts.init).toBe(1);
    expect(mod).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Schema metadata round-trip — the C++ Schema builder (host.h) emits groups,
// per-field display/short names + group ids, and help fields; this asserts they
// survive native emission → JSON. Instantiates the real core bundle and
// captures the schema JSON each effect publishes from its module_init.
// ---------------------------------------------------------------------------
describe('schema metadata round-trip (groups / names / help)', () => {

  it('core bundle: every effect emits VALID schema JSON; edited effects have groups/labels/help', async () => {
    const CORE = resolve(__dirname, '../../build/wasm/core.wasm');
    const ids = [
      'color.tone.auto_level', 'composite.bake_alpha', 'control.barrel_macros', 'filter.blur.gaussian',
      'color.tone.brightness_contrast', 'color.color_space', 'color.temperature', 'warp.crop',
      'color.tone.curve', 'util.dashboard', 'filter.edges', 'mod.source.adsr', 'mod.source.lfo',
      'color.tone.exposure', 'filter.blur.fast', 'source.gradient', 'source.grid', 'color.hsl',
      'color.hue_basis', 'color.invert', 'color.tone.levels', 'mod.shaper.delay', 'mod.shaper.envelope',
      'mod.shaper.flip', 'mod.shaper.motion', 'mod.shaper.remap', 'mod.shaper.smooth', 'mod.source.time', 'mod.source.bpm',
      'motion.blur', 'source.noise', 'color.posterize',
      'color.saturate', 'filter.sharpen', 'util.sketch_output', 'source.solid_color', 'warp.transform',
      'filter.glitch.twitch_mask', 'color.vibrance', 'color.colorize', 'composite.blend',
      'filter.vignette',
    ];
    const schemas = await captureSchemas(CORE, ids);   // JSON.parse per effect — throws on corruption
    if (schemas.size === 0) { console.warn('no core.wasm — skipping'); return; }
    expect(schemas.size).toBe(ids.length);   // all present, all valid JSON (no truncation)

    // Spot-check representative effects across domains: intro help + groups + a labelled input.
    for (const id of ['color.tone.brightness_contrast', 'color.tone.levels', 'motion.blur',
                      'util.dashboard', 'source.noise', 'mod.source.lfo']) {
      const s = schemas.get(id);
      expect(s?.fields?.intro?.type, `${id} intro`).toBe('help');
      expect(Object.keys(s?.groups ?? {}).length, `${id} groups`).toBeGreaterThan(0);
      const labelled = Object.values(s?.fields ?? {})
        .filter((f: any) => f?.type !== 'help' && (f?.io & 1) && typeof f?.name === 'string');
      expect(labelled.length, `${id} labelled inputs`).toBeGreaterThan(0);
    }
  });


  // (text/richtext are single-effect Blitz-linked bundles whose extra host
  // imports this minimal harness doesn't stub; they're verified by their build
  // + the shared host.h emission path exercised by the bundle above. The
  // extras' bundles are checked the same way in nano-modules-extras.)

});

// ---------------------------------------------------------------------------
// Core mod effects: beat-clock behaviors, driven frame-exactly.
//
// Instantiates the real core bundle with the fake host clock (dt 0.016 s at
// 120 BPM → 0.032 beats/frame, barPhase step 0.008) and reads the published
// scalar at host.pluginState.output after each tick — exact assertions the
// engine e2e's wall-clock rAF pacing can't make.
// ---------------------------------------------------------------------------
describe('core mod effects: beat-clock behaviors', () => {
  const CORE_PATH = resolve(__dirname, '../../build/wasm/core.wasm');

  async function loadCore(effectId: string) {
    let bytes: Buffer | null = null;
    try { bytes = readFileSync(CORE_PATH); } catch {}
    if (!bytes) return null;
    const host = new WasmHost();
    const imports = buildImports(host);
    const result = await WebAssembly.instantiate(bytes as BufferSource, imports);
    (host as any).instance = result.instance;
    (host as any).memory = result.instance.exports.memory as WebAssembly.Memory;
    (result.instance.exports._initialize as (() => void) | undefined)?.();
    (result.instance.exports.nano_module_main as () => void)();
    const module = host.activateEffect(effectId);
    return { host, module };
  }

  const patch = (host: WasmHost, module: any, params: Record<string, number>) =>
    host.notifyStatePatched(module, Object.entries(params).map(
      ([path, value]) => ({ op: 'replace' as const, path, value })));

  // Advance the fake transport `frames` frames, collecting the published
  // output after each tick.
  function drive(host: WasmHost, module: any, frames: number, bpm = 120): number[] {
    const dt = 0.016;
    const outs: number[] = [];
    for (let i = 0; i < frames; i++) {
      host.frameState.bpm = bpm;
      host.frameState.deltaTime = dt;
      host.frameState.elapsedTime += dt;
      host.frameState.barPhase = (host.frameState.barPhase + dt * bpm / 60 / 4) % 1;
      module.tick(dt);
      outs.push(host.pluginState.output as number);
    }
    return outs;
  }

  const SAW = 3;  // env_lfo ShapeSaw: output = 2·phase − 1 at shape 0

  it('LFO Beats+Locked rides the bar exactly, across the bar wrap', async () => {
    const loaded = await loadCore('mod.source.lfo');
    if (!loaded) { console.warn('no core.wasm — skipping'); return; }
    const { host, module } = loaded;
    // Start mid-bar: locked phase must equal the bar position (0.5 + i·0.008),
    // where a free clock (which always starts its cycle at 0) would lag it by
    // the 0.5 offset — this is what distinguishes Locked from Free.
    host.frameState.barPhase = 0.5;
    patch(host, module, { mode: 2, sync: 1, period_beats: 4, waveform: SAW });
    const outs = drive(host, module, 50);
    // Frame i: barPhase = 0.5 + (i+1)·0.008; phase == barPhase (period = 1 bar).
    expect(outs[24]).toBeCloseTo(2 * 0.7 - 1, 3);
    expect(outs[49]).toBeCloseTo(2 * 0.9 - 1, 3);
    // 100 more frames crosses the bar wrap: 0.5 + 150·0.008 = 1.7 → phase 0.7.
    const more = drive(host, module, 100);
    expect(more[99]).toBeCloseTo(2 * 0.7 - 1, 3);
  });

  it('LFO Beats+Free integrates the tempo-derived rate, ignoring bar position', async () => {
    const loaded = await loadCore('mod.source.lfo');
    if (!loaded) { console.warn('no core.wasm — skipping'); return; }
    const { host, module } = loaded;
    host.frameState.barPhase = 0.77;   // free mode must ignore where the bar is
    patch(host, module, { mode: 2, sync: 0, period_beats: 4, waveform: SAW });
    const outs = drive(host, module, 50);
    // 4 beats at 120 BPM = 0.5 Hz → phase = 50·0.016·0.5 = 0.4.
    expect(outs[49]).toBeCloseTo(2 * 0.4 - 1, 3);
    // Halve the tempo live: rate drops to 0.25 Hz → 50 more frames add 0.2.
    const more = drive(host, module, 50, 60);
    expect(more[49]).toBeCloseTo(2 * 0.6 - 1, 3);
  });

  it('LFO Period+Locked re-anchors to host time (backward scrubs follow)', async () => {
    const loaded = await loadCore('mod.source.lfo');
    if (!loaded) { console.warn('no core.wasm — skipping'); return; }
    const { host, module } = loaded;
    patch(host, module, { mode: 1, sync: 1, period: 2, waveform: SAW });
    const outs = drive(host, module, 25);
    // time = 25·0.016 = 0.4 s over a 2 s period → phase 0.2.
    expect(outs[24]).toBeCloseTo(2 * 0.2 - 1, 3);
    // Scrub the host clock backward: the locked phase follows it down.
    host.frameState.elapsedTime = 0.1 - 0.016;
    const after = drive(host, module, 1);
    expect(after[0]).toBeCloseTo(2 * 0.05 - 1, 3);
  });

  it('LFO defaults (Freq+Free) are unchanged: rate 0.5 = 5 Hz free-running', async () => {
    const loaded = await loadCore('mod.source.lfo');
    if (!loaded) { console.warn('no core.wasm — skipping'); return; }
    const { host, module } = loaded;
    patch(host, module, { waveform: SAW });
    const outs = drive(host, module, 5);
    // phase = 5·0.016·5 = 0.4
    expect(outs[4]).toBeCloseTo(2 * 0.4 - 1, 3);
  });

  it('Beat Trigger: decay tail by default; Single Frame is an exact 1-frame gate', async () => {
    const loaded = await loadCore('mod.trigger.beat');
    if (!loaded) { console.warn('no core.wasm — skipping'); return; }
    const { host, module } = loaded;

    // Decay mode: the tick frame is exactly 1, the next ≈ exp(-dt/0.12) ≈ 0.875.
    const decay = drive(host, module, 80);
    const i0 = decay.findIndex((v) => v === 1);
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(decay[i0 + 1]).toBeGreaterThan(0.5);
    expect(decay[i0 + 1]).toBeLessThan(1);

    // Single-frame mode: output only ever exactly 0 or exactly 1, and every 1
    // is isolated (the frames around it are exact 0s).
    patch(host, module, { single_frame: 1 });
    const gate = drive(host, module, 80);
    expect(gate.every((v) => v === 0 || v === 1)).toBe(true);
    const ones = gate.map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0);
    expect(ones.length).toBeGreaterThanOrEqual(2);   // every beat ≈ 31 frames
    for (const i of ones) {
      expect(gate[i - 1] ?? 0).toBe(0);
      expect(gate[i + 1] ?? 0).toBe(0);
    }
    // The trigger EVENT ring still fires in single-frame mode.
    const trig = (host.pluginState.triggers ?? []) as Array<{ on: boolean }>;
    expect(trig.some((t) => t.on === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pooled WASM instances.
//
// Chrome hard-caps LIVE WebAssembly memories at 100 per RENDERER PROCESS — a
// count cap shared by the main thread and every worker, independent of each
// memory's declared maximum. One instance per chain entry therefore capsized
// any session past ~90 live effects (the offline engine simulates every cached
// sketch at once). Effects are class-like — `module_init` per TYPE, `create()`
// → an opaque `self` per instance — so instances of one effect share a single
// WebAssembly.Instance, keyed by `WasmHost.poolKey`.
//
// These drive the REAL `load()` path (not the hand-wired imports above), since
// the whole point is that the shared import closures resolve host state through
// the pool's `cur` pointer.
// ---------------------------------------------------------------------------
describe('pooled WASM instances', () => {
  const CORE_WASM = resolve(__dirname, '../../build/wasm/core.wasm');
  let compiledCore: WebAssembly.Module | null | undefined;

  async function core(): Promise<WebAssembly.Module | null> {
    if (compiledCore !== undefined) return compiledCore;
    let bytes: Buffer | null = null;
    try { bytes = readFileSync(CORE_WASM); } catch { /* not built */ }
    compiledCore = bytes ? await WebAssembly.compile(bytes as BufferSource) : null;
    return compiledCore;
  }

  async function spawn(poolKey: string | null, effectId = 'mod.source.lfo') {
    const compiled = await core();
    if (!compiled) return null;
    const host = new WasmHost();
    host.poolKey = poolKey;
    await host.load(compiled);
    const module = host.activateEffect(effectId);
    return { host, module };
  }

  const wasmInstance = (h: WasmHost) => (h as any).instance as WebAssembly.Instance;
  const selfPtr = (h: WasmHost) => h.activeSelf;

  it('shares one WebAssembly.Instance across hosts with the same pool key', async () => {
    const a = await spawn('lfo|fmt1');
    if (!a) { console.warn('no core.wasm — skipping'); return; }
    const b = await spawn('lfo|fmt1')!;
    expect(wasmInstance(b!.host)).toBe(wasmInstance(a.host));
    // Same instance, but genuinely separate effect instances.
    expect(selfPtr(a.host)).not.toBe(0);
    expect(selfPtr(b!.host)).not.toBe(selfPtr(a.host));
    // Type-level setup replays rather than re-running: same schema shape...
    expect(b!.host.metadata?.id).toBe(a.host.metadata?.id);
    expect(Object.keys(b!.host.schema)).toEqual(Object.keys(a.host.schema));
    a.host.dispose(); b!.host.dispose();
  });

  it('keeps per-instance state independent inside a shared instance', async () => {
    const a = await spawn('lfo-indep|fmt1');
    if (!a) { console.warn('no core.wasm — skipping'); return; }
    const b = (await spawn('lfo-indep|fmt1'))!;
    const SAW = 3;
    const setup = (h: WasmHost, m: any, periodBeats: number) =>
      h.notifyStatePatched(m, [
        { op: 'replace', path: 'mode', value: 2 },
        { op: 'replace', path: 'sync', value: 1 },
        { op: 'replace', path: 'period_beats', value: periodBeats },
        { op: 'replace', path: 'waveform', value: SAW },
      ]);
    setup(a.host, a.module, 4);
    setup(b.host, b.module, 1);   // 4x faster — must not disturb A
    for (let i = 0; i < 40; i++) {
      for (const { host, module } of [a, b]) {
        host.frameState.bpm = 120;
        host.frameState.deltaTime = 0.016;
        host.frameState.elapsedTime += 0.016;
        host.frameState.barPhase = (host.frameState.barPhase + 0.016 * 120 / 60 / 4) % 1;
        module.tick(0.016);
      }
    }
    // barPhase after 40 frames = 0.32; A locks to the bar, B runs 4 beats per
    // cycle → phase (0.32*4) % 1 = 0.28.
    expect(a.host.pluginState.output as number).toBeCloseTo(2 * 0.32 - 1, 2);
    expect(b.host.pluginState.output as number).toBeCloseTo(2 * 0.28 - 1, 2);
    a.host.dispose(); b.host.dispose();
  });

  it('separates pools by key, and never pools a host that opted out', async () => {
    const a = await spawn('lfo-k1|fmt1');
    if (!a) { console.warn('no core.wasm — skipping'); return; }
    const other = (await spawn('lfo-k1|fmt3'))!;   // different working format
    const unpooled1 = (await spawn(null))!;
    const unpooled2 = (await spawn(null))!;
    expect(wasmInstance(other.host)).not.toBe(wasmInstance(a.host));
    expect(wasmInstance(unpooled1.host)).not.toBe(wasmInstance(a.host));
    expect(wasmInstance(unpooled2.host)).not.toBe(wasmInstance(unpooled1.host));
    for (const h of [a, other, unpooled1, unpooled2]) h.host.dispose();
  });

  it('releases the pool once its last host is disposed', async () => {
    const a = await spawn('lfo-refs|fmt1');
    if (!a) { console.warn('no core.wasm — skipping'); return; }
    const b = (await spawn('lfo-refs|fmt1'))!;
    const shared = wasmInstance(a.host);
    a.host.dispose();
    // One host left → the pool survives and is still joinable.
    const c = (await spawn('lfo-refs|fmt1'))!;
    expect(wasmInstance(c.host)).toBe(shared);
    b.host.dispose(); c.host.dispose();
    // Now empty → a later host instantiates afresh.
    const d = (await spawn('lfo-refs|fmt1'))!;
    expect(wasmInstance(d.host)).not.toBe(shared);
    d.host.dispose();
  });

  it('dispose() is idempotent and runs the effect destroy hook once', async () => {
    const a = await spawn('lfo-dispose|fmt1');
    if (!a) { console.warn('no core.wasm — skipping'); return; }
    let destroys = 0;
    const realDestroy = (a.host as any).destroyFn as ((self: number) => void) | null;
    expect(realDestroy).toBeTruthy();
    (a.host as any).destroyFn = (self: number) => { destroys++; realDestroy!(self); };
    a.host.dispose();
    a.host.dispose();
    expect(destroys).toBe(1);
    expect(a.host.activeSelf).toBe(0);
  });
});
