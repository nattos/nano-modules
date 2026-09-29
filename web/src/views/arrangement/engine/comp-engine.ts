/**
 * CompEngine — the seam between `EngineBridge` and whatever runs the
 * composition executor.
 *
 * Two implementations, one contract:
 *  - `ArrEngine` (arr-engine.ts): `executor.wasm` in a browser worker. The
 *    arrangement's decode pump runs HERE, on the main thread, and pushes each
 *    decoded frame in (`setInstanceTexture`) plus per-clip readiness for the
 *    Precise gate (`compControl` op 'videoReady').
 *  - a native compositor process over the bridge protocol (planned). It owns
 *    its own decode pump, so `ownsVideoPump` is true and the bridge skips the
 *    main-thread pump and the readiness pushes entirely.
 *
 * Everything the bridge reads back arrives on the callbacks: one frame set per
 * rendered frame (the composite plus any per-device traces), the per-frame
 * comp report, and the telemetry diffs. Frames are `PreviewFrame`s — an
 * ImageBitmap the receiver owns and closes, or a GPU-resident frame whose
 * texture the preview module owns (never closed by the receiver).
 */

import type { CompFrameInfo, PluginInfo, StateDiff, TracePoint, WorkerCommand } from '../../../engine-types';
import type { PreviewFrame } from '../../../preview-gpu';
import { isGpuPreviewFrame } from '../../../preview-gpu';

export type CompControlMsg = Omit<Extract<WorkerCommand, { type: 'compControl' }>, 'type'>;
export type CompOpMsg = Omit<Extract<WorkerCommand, { type: 'compOp' }>, 'type'>;

export interface CompEngine {
  /** Resolves once the engine can take commands. */
  readonly ready: Promise<void>;
  /** True when the engine decodes video itself: the bridge must not run its
   *  main-thread pump, inject frames or push readiness. */
  readonly ownsVideoPump: boolean;
  /** Effect ids discovered across loaded bundles (diagnostic). */
  readonly discovered: ReadonlySet<string>;
  /** Last debug stats (when debug mode is on; diagnostic). */
  readonly lastDebugStats: unknown;

  /** One call per rendered frame with every traced frame ({traceId → frame}). */
  onFrameSet: ((frames: Record<string, PreviewFrame>) => void) | null;
  onFps: ((fps: number) => void) | null;
  onGpuTime: ((gpuMs: number) => void) | null;
  onError: ((message: string) => void) | null;
  onModulationDataDiff: ((diff: StateDiff) => void) | null;
  onPluginStatesDiff: ((diff: StateDiff) => void) | null;
  onPlugins: ((plugins: PluginInfo[]) => void) | null;
  onCompInfo: ((info: CompFrameInfo) => void) | null;

  /** Load every shipping bundle so all effects are reachable. */
  warmBundles(bundles: readonly string[]): Promise<void>;
  /** An effect's static field-visibility evaluator over a candidate state. */
  evaluateVisibility(moduleType: string, state: Record<string, unknown>): Promise<string[] | null>;

  /** Enter comp mode, publishing the composite under `compositeId`. */
  compEnable(compositeId: string): Promise<void>;
  /** Full composition document replace. */
  compLoadDoc(json: string): void;
  compControl(msg: CompControlMsg): void;
  compOp(msg: CompOpMsg): void;

  /**
   * MIDI device values for the composition's device wires. The worker engine
   * takes the LOWERED table (`{"midi:<uuid>": {"b0/e05/turn": 0.42}}`, see
   * midi/wire-lowering.ts); the native compositor reads its own CoreMIDI host
   * and ignores it.
   */
  setExternalScalars(json: string): void;
  /**
   * The native compositor's side of the same thing: the device library (so its
   * CoreMIDI host can map hardware headlessly) and the on-screen simulation
   * overrides it merges over the hardware — the bridge's /global/midi_devices
   * and /global/midi_sim, as Remote Control mirrors them to a barrel. The
   * worker engine ignores it (its table already folds both in).
   */
  mirrorMidi(kind: 'library' | 'sim', value: unknown): void;

  /** Does this engine transmit light devices' DMX? Only the native
   *  compositor can (a browser has no UDP); the worker engine takes the plan
   *  and ignores it. */
  readonly outputsLights: boolean;
  /** The show's resolved light plan (lights/light-plan.ts) — replaces the last. */
  setLightPlan(plan: unknown): void;
  /** Start (pattern non-empty) or stop an identify / test pattern on a placed
   *  light, or one slot of it (slotId ''). */
  lightTest(placementId: string, slotId: string, pattern: string): void;

  /** Per-device texture traces, merged with the composite trace. */
  setExtraTracePoints(tps: TracePoint[]): void;
  /** Bind a decoded video frame to a source instance (null clears). Only
   *  meaningful when `ownsVideoPump` is false. */
  setInstanceTexture(instanceKey: string, bitmap: ImageBitmap | null): void;
  /** Raw RGBA8 of a trace's current texture, straight off the GPU (no
   *  checkerboard, no forced alpha). */
  readbackTrace(id: string): Promise<{ width: number; height: number; pixels: Uint8Array }>;

  resize(width: number, height: number): void;
  setDebugMode(on: boolean): void;
  destroy(): void;
}

/** Release a frame the receiver owns: close an ImageBitmap; a GPU frame's
 *  texture belongs to the preview module and is reused, so leave it. */
export function releaseFrame(frame: PreviewFrame | null | undefined): void {
  if (frame && !isGpuPreviewFrame(frame)) frame.close();
}
