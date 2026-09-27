/**
 * PreviewEngine — the effect store's own renderer.
 *
 * A second engine worker (EngineProxy, as the arrangement's ArrEngine does),
 * separate from the editor's: in Remote Control the editor's worker renders
 * nothing (Resolume does), and elsewhere a preview must never disturb the
 * sketch being edited. It loads the same bundles the surface would, and runs
 * ONE preview scenario at a time (preview/scenario.ts):
 *
 *   - bakeThumbnail(effect) steps a fixed clock to the scenario's capture
 *     time and returns the frame as an image — or, for a modulation effect,
 *     a plot of its primary output over the scenario's loop — for the cache;
 *   - startLive(effect) free-runs it for a hovered card, publishing frames
 *     (and output samples) as observables.
 *
 * One at a time matters: Chrome caps live wasm memories at ~100 per process,
 * shared with the editor's engine, so this engine keeps at most one scenario's
 * instances alive and is disposed when the store closes.
 */

import { observable, runInAction } from 'mobx';
import { EngineProxy } from '../engine-proxy';
import { discoverEffectBundles } from '../effect-bundles';
import type { EffectInfo, PluginInfo, StateDiff } from '../engine-types';
import { parseVersion } from '../version';
import { defaultStateForPlugin } from '../state/default-state';
import { compileScenario, type CompiledScenario, type PreviewKind } from './scenario';

export const PREVIEW_W = 320;
export const PREVIEW_H = 180;
const TRACE_ID = 'preview';
const STEP_HZ = 30;
const FRAME_TIMEOUT_MS = 5000;
/** Frames stepped at t=0 before recording, so every instance exists. */
const WARMUP_FRAMES = 6;

export interface PlotSeries {
  values: number[];
  min: number;
  max: number;
}

export interface LiveSamples {
  field: string;
  min: number;
  max: number;
  values: PlotValue[];
  /** Ghost series (the scenario's `plot`), drawn under the output. */
  ghosts: PlotSeries[];
}

type Frames = Record<string, ImageBitmap>;

export interface BakeOptions {
  /** Scenario JSON to run instead of the effect's own (authoring tools). */
  scenario?: string;
  /** Run the scene with the previewed effect powered off — its input alone. */
  bypassSelf?: boolean;
}

export interface BakedThumb {
  /** Empty for 'icon' (the scenario asks for the category tile, no bake). */
  blob: Blob;
  kind: 'image' | 'graph' | 'icon';
  /** A graph's plotted samples and range (for tooling). */
  samples?: { values: PlotValue[]; min: number; max: number };
}

/** Output types a modulation thumbnail can plot ('any'/'raw' plot whatever
 *  numbers or colours they carry). */
const PLOTTABLE = ['float', 'int', 'bool', 'float3', 'float4', 'any', 'raw'];

function fieldRange(f: any): { min: number; max: number } {
  const min = typeof f?.min === 'number' ? f.min : 0;
  const max = typeof f?.max === 'number' && f.max > min ? f.max : min + 1;
  return { min, max };
}

/** A sample: a number, or a colour/vector (plotted as a strip). */
export type PlotValue = number | number[];

interface PlotSpec {
  field: string;
  min: number;
  max: number;
  /** A RELAY output (input + output, e.g. mod.source.color's swatch) with
   *  nothing wired into it is its document value — the engine publishes one
   *  only when a wire drives it — so it plots as that constant. */
  fixed?: PlotValue;
  ghosts: Array<{ instanceKey: string; field: string; min: number; max: number }>;
}

function sample(v: unknown): PlotValue {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'number')) return v.length === 1 ? v[0] : v;
  return NaN;
}

function isTexture(f: any): boolean {
  return f && typeof f === 'object' && f.type === 'texture';
}

export class PreviewEngine {
  /** Every effect the loaded bundles registered, by id (UI-observable). */
  readonly catalog = observable.map<string, EffectInfo>({}, { deep: false });
  /** True once every discovered bundle has reported its effects. */
  readonly loaded = observable.box(false);
  /** The hovered card's latest frame (owned here; closed on replacement). */
  readonly liveFrame = observable.box<ImageBitmap | null>(null, { deep: false });
  /** Bumps on every live frame / sample (drives redraws). */
  readonly liveGeneration = observable.box(0);
  /** The effect currently running live, or null. */
  readonly liveEffect = observable.box<string | null>(null);
  /** Bumps when effect schemas arrive (kindOf answers change). */
  readonly schemaGeneration = observable.box(0);
  /** A modulation effect's live output samples (null for image effects). */
  liveSamples: LiveSamples | null = null;

  private proxy: EngineProxy | null = null;
  private startPromise: Promise<void> | null = null;
  private plugins = new Map<string, PluginInfo>();
  /** Bundles that have reported their effect list. */
  private reported = new Set<string>();
  private pluginStates = new Map<string, Record<string, any>>();
  private pendingFrames: Frames | null = null;
  private frameWaiters: Array<(f: Frames | null) => void> = [];
  private stage: Promise<unknown> = Promise.resolve();
  private runId = 0;
  private live: { compiled: CompiledScenario; sketchId: string; plot: PlotSpec | null } | null = null;
  /** Set when a live preview is wanted: an in-flight bake bails out early. */
  private liveWanted = false;
  private disposed = false;

  /** Boot the worker and load every bundle (idempotent). */
  start(): Promise<void> {
    this.startPromise ??= this.boot();
    return this.startPromise;
  }

  private async boot() {
    const proxy = new EngineProxy(PREVIEW_W, PREVIEW_H);
    this.proxy = proxy;
    proxy.onEffectsDiscovered = (effects, bundle) => {
      runInAction(() => {
        if (bundle) {
          for (const [id, e] of this.catalog) if (e.bundle === bundle && !effects.some((x) => x.id === id)) this.catalog.delete(id);
        }
        // First registration wins, as in the editor's list (setAvailableEffects):
        // a later bundle declaring the same id (testonly duplicates core's
        // effects) must not take the card over.
        for (const e of effects) {
          const cur = this.catalog.get(e.id);
          if (!cur || cur.bundle === (e.bundle ?? bundle)) this.catalog.set(e.id, { ...e, bundle: e.bundle ?? bundle });
        }
      });
      if (bundle) this.reported.add(bundle);
    };
    proxy.onStateUpdate = (state) => {
      let added = false;
      for (const p of state.plugins ?? []) {
        if (!p.schema) continue;
        if (!this.plugins.has(p.id)) added = true;
        this.plugins.set(p.id, p);
      }
      if (added) runInAction(() => this.schemaGeneration.set(this.schemaGeneration.get() + 1));
    };
    proxy.onTracedFrames = (frames) => {
      // The plugin-state diff of the same frame arrives next; resolve then.
      if (this.pendingFrames) for (const b of Object.values(this.pendingFrames)) b.close();
      this.pendingFrames = frames;
    };
    proxy.onPluginStatesDiff = (diff) => this.onFrameDone(diff);
    // A bundle that fails to load never reports effects; count it as done so
    // the store doesn't wait out the timeout for it.
    proxy.onError = (message) => {
      const m = /Failed to load (\S+):/.exec(message);
      if (m) this.reported.add(m[1]);
    };

    const t0 = Date.now();
    while (!proxy.ready) {
      if (this.disposed) return;
      if (Date.now() - t0 > 15_000) throw new Error('preview engine: worker init timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
    const bundles = await discoverEffectBundles();
    for (const b of bundles) proxy.loadModule(b);
    // Wait (bounded) until every bundle has reported its effect list.
    const t1 = Date.now();
    while (bundles.some((b) => !this.reported.has(b)) && Date.now() - t1 < 20_000 && !this.disposed) {
      await new Promise((r) => setTimeout(r, 100));
    }
    proxy.setPaused(true);
    runInAction(() => this.loaded.set(true));
  }

  private onFrameDone(diff: StateDiff) {
    if (diff) {
      for (const k of diff.removed) this.pluginStates.delete(k);
      for (const [k, v] of Object.entries(diff.changed)) {
        const cur = this.pluginStates.get(k);
        this.pluginStates.set(k, cur && v && typeof v === 'object' ? { ...cur, ...v } : v);
      }
    }
    const frames = this.pendingFrames ?? {};
    this.pendingFrames = null;
    if (this.live) this.onLiveFrame(frames);
    const waiters = this.frameWaiters;
    this.frameWaiters = [];
    if (waiters.length) {
      for (const w of waiters) w(frames);
    } else if (!this.live) {
      for (const b of Object.values(frames)) b.close();
    }
  }

  private nextFrame(): Promise<Frames | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((w) => w !== done);
        resolve(null);
      }, FRAME_TIMEOUT_MS);
      const done = (f: Frames | null) => { clearTimeout(timer); resolve(f); };
      this.frameWaiters.push(done);
    });
  }

  /** Run `fn` exclusively on the one preview stage. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stage.then(fn, fn);
    this.stage = run.catch(() => {});
    return run;
  }

  // ── What an effect is ──────────────────────────────────────────────────

  /** Has `effectId`'s schema arrived (so kindOf is authoritative)? */
  hasSchema(effectId: string): boolean {
    return !!this.plugins.get(effectId)?.schema;
  }

  /** `effectId`'s field schema, if it has arrived (authoring tools). */
  schemaOf(effectId: string): Record<string, any> | null {
    return this.plugins.get(effectId)?.schema ?? null;
  }

  /** How the store should present `effectId` (from its schema). */
  kindOf(effectId: string): PreviewKind {
    const p = this.plugins.get(effectId);
    if (!p?.schema) return 'image';
    const fields = Object.values(p.schema);
    const texOut = fields.some((f: any) => isTexture(f) && ((f.io ?? 0) & 2));
    const texIn = fields.some((f: any) => isTexture(f) && ((f.io ?? 0) & 1));
    if (!texOut) return 'modulation';
    if ((p.capabilities ?? []).includes('generator') || !texIn) return 'generator';
    return 'image';
  }

  /** The scalar output a modulation effect is plotted by: the primary one,
   *  else the first. */
  primaryScalarOutput(effectId: string): { field: string; min: number; max: number } | null {
    const schema = this.plugins.get(effectId)?.schema;
    if (!schema) return null;
    let first: { field: string; min: number; max: number } | null = null;
    for (const [name, f] of Object.entries(schema) as Array<[string, any]>) {
      if (!f || typeof f !== 'object' || !((f.io ?? 0) & 2)) continue;
      if (!PLOTTABLE.includes(f.type)) continue;
      const entry = { field: name, ...fieldRange(f) };
      if ((f.io & 4) !== 0) return entry;
      first ??= entry;
    }
    return first;
  }

  /** What a modulation scenario plots: its chosen (or primary) output, plus
   *  any ghost series, each with its declared range. */
  private plotSpec(effectId: string, compiled: CompiledScenario): PlotSpec | null {
    if (this.kindOf(effectId) !== 'modulation') return null;
    const schema = this.plugins.get(effectId)?.schema ?? {};
    const chosen = compiled.plotOutput ? schema[compiled.plotOutput] : null;
    const main = chosen && typeof chosen === 'object'
      ? { field: compiled.plotOutput!, ...fieldRange(chosen) }
      : this.primaryScalarOutput(effectId);
    if (!main) return null;
    const f = schema[main.field];
    const selfKey = compiled.selfKey;
    const driven = (compiled.sketch.wires ?? []).some((w) => w.dest.instanceKey === selfKey && w.dest.field === main.field);
    const fixed = f && ((f.io ?? 0) & 1) && !driven ? sample(compiled.sketch.instances?.[selfKey]?.state?.[main.field]) : undefined;
    const ghosts = compiled.plotSeries.map((g) => {
      const type = compiled.sketch.instances?.[g.instanceKey]?.module_type;
      const f = type ? this.plugins.get(type)?.schema?.[g.field] : null;
      return { ...g, ...fieldRange(f) };
    });
    return { ...main, ghosts, ...(fixed !== undefined ? { fixed } : {}) };
  }

  // ── Running a scenario ─────────────────────────────────────────────────

  private mount(effect: EffectInfo, opts: BakeOptions = {}): { compiled: CompiledScenario; sketchId: string } {
    const proxy = this.proxy!;
    const id = ++this.runId;
    const sketchId = `pv${id}`;
    const compiled = compileScenario(effect.id, opts.scenario ?? effect.preview, this.kindOf(effect.id), sketchId, (id) => {
      const p = this.plugins.get(id);
      return {
        version: { module: parseVersion(p?.moduleVersion), effect: parseVersion(p?.version) },
        state: p ? defaultStateForPlugin(p) : {},
      };
    }, (id) => this.catalog.has(id));
    if (opts.bypassSelf) {
      const self = compiled.sketch.instances?.[compiled.selfKey];
      if (self) self.state = { ...self.state, __enable__: 0 };
    }
    proxy.createSketch(sketchId, JSON.parse(JSON.stringify(compiled.sketch)));
    if (compiled.input) proxy.setSketchGenerator(sketchId, compiled.input);
    for (const [k, g] of Object.entries(compiled.instanceGenerators)) proxy.setInstanceGenerator(k, g);
    proxy.setTracePoints([{ id: TRACE_ID, target: { type: 'sketch_output', sketchId }, size: { width: PREVIEW_W, height: PREVIEW_H } }]);
    return { compiled, sketchId };
  }

  private unmount(m: { compiled: CompiledScenario; sketchId: string }) {
    const proxy = this.proxy;
    if (!proxy) return;
    proxy.setTracePoints([]);
    for (const k of Object.keys(m.compiled.instanceGenerators)) proxy.setInstanceGenerator(k, null);
    proxy.setSketchGenerator(m.sketchId, null);
    proxy.deleteSketch(m.sketchId);
    for (const k of Object.keys(m.compiled.sketch.instances ?? {})) this.pluginStates.delete(k);
  }

  private async step(t: number): Promise<Frames | null> {
    // The store may close (disposing this engine) mid-bake.
    if (!this.proxy || this.disposed) return null;
    this.proxy.setTime(t);
    this.proxy.stepFrame();
    return this.nextFrame();
  }

  /**
   * Bake `effect`'s thumbnail: a WebP of its scenario at the capture time, or
   * for a modulation effect a plot of its output over the loop. Null when the
   * engine couldn't produce one (or a live preview interrupted it — bake
   * again later). `opts` are for authoring tools (scripts/bake-thumbs.mjs).
   */
  bakeThumbnail(effect: EffectInfo, opts: BakeOptions = {}): Promise<BakedThumb | null> {
    return this.exclusive(async () => {
      await this.start();
      if (!this.proxy || this.disposed || this.liveWanted) return null;
      const proxy = this.proxy;
      proxy.setPaused(true);
      const m = this.mount(effect, opts);
      const selfKey = m.compiled.selfKey;
      if (m.compiled.thumb === 'icon') {
        this.unmount(m);
        return { blob: new Blob(), kind: 'icon' as const };
      }
      const plot = this.plotSpec(effect.id, m.compiled);
      try {
        for (let i = 0; i < WARMUP_FRAMES; i++) {
          const f = await this.step(0);
          if (f) for (const b of Object.values(f)) b.close();
          if (this.liveWanted || this.disposed) return null;
        }
        const until = plot ? m.compiled.loopSec : m.compiled.captureSec;
        const steps = Math.max(1, Math.round(until * STEP_HZ));
        const values: PlotValue[] = [];
        const ghosts: number[][] = plot ? plot.ghosts.map(() => []) : [];
        let last: ImageBitmap | null = null;
        for (let i = 1; i <= steps; i++) {
          const f = await this.step(i / STEP_HZ);
          if (this.liveWanted || this.disposed) { last?.close(); if (f) for (const b of Object.values(f)) b.close(); return null; }
          if (!f) continue;
          for (const [id, b] of Object.entries(f)) {
            if (id === TRACE_ID) { last?.close(); last = b; } else b.close();
          }
          if (plot) {
            values.push(plot.fixed ?? sample(this.pluginStates.get(selfKey)?.[plot.field]));
            plot.ghosts.forEach((g, gi) => {
              const v = sample(this.pluginStates.get(g.instanceKey)?.[g.field]);
              ghosts[gi].push(typeof v === 'number' ? v : NaN);
            });
          }
        }
        if (plot) {
          last?.close();
          const series = plot.ghosts.map((g, gi) => ({ values: ghosts[gi], min: g.min, max: g.max }));
          return {
            blob: await plotBlob(values, plot.min, plot.max, series), kind: 'graph' as const,
            samples: { values, min: plot.min, max: plot.max },
          };
        }
        if (!last) return null;
        const c = new OffscreenCanvas(last.width, last.height);
        c.getContext('2d')!.drawImage(last, 0, 0);
        last.close();
        return { blob: await c.convertToBlob({ type: 'image/webp', quality: 0.85 }), kind: 'image' as const };
      } finally {
        this.unmount(m);
      }
    });
  }

  /** Run `effect` live (the hovered card). Replaces any live preview. */
  startLive(effect: EffectInfo): Promise<void> {
    this.liveWanted = true;
    runInAction(() => this.liveEffect.set(effect.id));
    return this.exclusive(async () => {
      await this.start();
      if (!this.proxy || this.disposed || this.liveEffect.get() !== effect.id) return;
      this.stopLiveNow();
      const m = this.mount(effect);
      const plot = this.plotSpec(effect.id, m.compiled);
      this.liveSamples = plot ? {
        field: plot.field, min: plot.min, max: plot.max, values: [],
        ghosts: plot.ghosts.map((g) => ({ values: [], min: g.min, max: g.max })),
      } : null;
      this.live = { ...m, plot };
      this.proxy.setTime(0);
      this.proxy.stepFrame();
      this.proxy.setTime(null);
      this.proxy.setPaused(false);
    });
  }

  /** Stop the live preview of `effectId` (or whatever is live, if omitted). */
  stopLive(effectId?: string): Promise<void> {
    if (effectId && this.liveEffect.get() !== effectId) return Promise.resolve();
    this.liveWanted = false;
    runInAction(() => this.liveEffect.set(null));
    return this.exclusive(async () => {
      if (this.liveEffect.get() !== null) return; // a newer live preview took over
      this.stopLiveNow();
    });
  }

  private stopLiveNow() {
    if (!this.live) return;
    this.proxy?.setPaused(true);
    this.unmount(this.live);
    this.live = null;
    this.liveSamples = null;
    runInAction(() => {
      this.liveFrame.get()?.close();
      this.liveFrame.set(null);
      this.liveGeneration.set(this.liveGeneration.get() + 1);
    });
  }

  private onLiveFrame(frames: Frames) {
    const live = this.live!;
    const bmp = frames[TRACE_ID];
    for (const [id, b] of Object.entries(frames)) if (id !== TRACE_ID) b.close();
    if (live.plot && this.liveSamples) {
      const keep = <T,>(arr: T[], v: T) => {
        arr.push(v);
        if (arr.length > 120) arr.splice(0, arr.length - 120);
      };
      keep(this.liveSamples.values, live.plot.fixed ?? sample(this.pluginStates.get(live.compiled.selfKey)?.[live.plot.field]));
      live.plot.ghosts.forEach((g, gi) => {
        const v = sample(this.pluginStates.get(g.instanceKey)?.[g.field]);
        keep(this.liveSamples!.ghosts[gi].values, typeof v === 'number' ? v : NaN);
      });
    }
    runInAction(() => {
      if (bmp) {
        this.liveFrame.get()?.close();
        this.liveFrame.set(bmp);
      }
      this.liveGeneration.set(this.liveGeneration.get() + 1);
    });
  }

  dispose() {
    this.disposed = true;
    this.proxy?.destroy();
    this.proxy = null;
    for (const w of this.frameWaiters) w(null);
    this.frameWaiters = [];
    runInAction(() => {
      this.liveFrame.get()?.close();
      this.liveFrame.set(null);
      this.liveEffect.set(null);
      this.loaded.set(false);
    });
  }
}

/** Draw a modulation output as a line plot (the graph thumbnail). */
export async function plotBlob(values: PlotValue[], min: number, max: number, ghosts: PlotSeries[] = []): Promise<Blob> {
  const c = new OffscreenCanvas(PREVIEW_W, PREVIEW_H);
  drawPlot(c.getContext('2d')!, values, min, max, PREVIEW_W, PREVIEW_H, ghosts);
  return c.convertToBlob({ type: 'image/png' });
}

/**
 * Shared by the baked graph thumbnail and the live hover plot. Numbers plot
 * as a line over ghosted `ghosts` (e.g. the input a shaper reshapes); vector
 * samples (a colour output) plot as a strip of those colours over time.
 */
export function drawPlot(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  values: PlotValue[], min: number, max: number, w: number, h: number,
  ghosts: PlotSeries[] = [],
) {
  ctx.fillStyle = '#15171c';
  ctx.fillRect(0, 0, w, h);
  if (values.some((v) => Array.isArray(v))) {
    drawStrip(ctx, values, min, max, w, h);
    return;
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = Math.round((h * i) / 4) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  for (const g of ghosts) line(ctx, g.values, g.min, g.max, w, h, 'rgba(255,255,255,0.28)', Math.max(1, h / 120));
  line(ctx, values as number[], min, max, w, h, '#6fd3ff', Math.max(1.5, h / 60));
}

function line(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  values: number[], min: number, max: number, w: number, h: number, color: string, width: number,
) {
  if (values.filter((v) => Number.isFinite(v)).length < 2) return;
  const pad = h * 0.1;
  const span = max - min || 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const x = (i / (values.length - 1)) * w;
    const y = h - pad - ((Math.min(max, Math.max(min, v)) - min) / span) * (h - pad * 2);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/** A colour output over time: one vertical band per sample. */
function drawStrip(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  values: PlotValue[], min: number, max: number, w: number, h: number,
) {
  const span = max - min || 1;
  const byte = (x: number | undefined) => Math.round(255 * Math.min(1, Math.max(0, ((x ?? 0) - min) / span)));
  const n = values.length;
  values.forEach((v, i) => {
    const c = Array.isArray(v) ? v : [v, v, v];
    ctx.fillStyle = `rgb(${byte(c[0])},${byte(c[1])},${byte(c[2])})`;
    const x0 = Math.floor((i / n) * w);
    ctx.fillRect(x0, 0, Math.ceil(w / n) + 1, h);
  });
}
