/**
 * Stable fingerprint of a GENERATOR clip's appearance — the cache key for its
 * dynamic film-strip thumbnails (#120).
 *
 * The fingerprint hashes the clip's editable effect params with a TOLERANCE so a
 * small/continuous slider drag doesn't change the key (and thus doesn't thrash the
 * thumbnail cache). Known float fields bucket by their declared range; other state
 * numbers (vec components like a solid colour, etc.) bucket by a default step.
 * moduleType + composition fps are included; time-varying MODULATION (automation /
 * wires) is intentionally NOT — it's folded into each live-captured frame instead.
 */

import type { Clip, Device } from '../model/composition';
import { catalogEffect } from './effect-catalog';
import { store } from '../state/store';

/** Buckets across a field's range (≈1.5% tolerance) — tune for stability vs fidelity. */
const BUCKETS = 64;
const DEFAULT_STEP = 1 / BUCKETS;

/** Round every number in a (possibly nested) value to `step` — leaves strings/bools alone. */
function deepBucket(v: unknown, step: number): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v / step) * step : 0;
  if (Array.isArray(v)) return v.map((x) => deepBucket(x, step));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = deepBucket((v as Record<string, unknown>)[k], step);
    return o;
  }
  return v;
}

/** The clip's catalog (real) devices, in chain order. */
function catalogDevices(clip: Clip): Device[] {
  return clip.sketch.devices.filter((d) => catalogEffect(d.moduleType));
}

/** The clip's generator device (first chain device with the `generator` role), if any. */
export function clipGeneratorDevice(clip: Clip): Device | undefined {
  return catalogDevices(clip).find((d) => catalogEffect(d.moduleType)!.role === 'generator');
}

/** A GENERATOR clip = has a generator device and is NOT media-backed (no decoded source). */
export function isGeneratorClip(clip: Clip): boolean {
  return !clip.source?.url && !!clipGeneratorDevice(clip);
}

/**
 * Tolerance-bucketed fingerprint of a generator clip's look, or null when the clip
 * has no generator device (so callers can skip non-generator clips).
 */
export function generatorFingerprint(clip: Clip): string | null {
  const devs = catalogDevices(clip);
  if (!devs.some((d) => catalogEffect(d.moduleType)!.role === 'generator')) return null;
  const parts: Array<[string, Record<string, unknown>]> = [];
  for (const d of devs) {
    const cat = catalogEffect(d.moduleType)!;
    const steps = new Map(cat.fields.map((f) => [f.key, ((f.max - f.min) / BUCKETS) || DEFAULT_STEP]));
    const state = d.state ?? {};
    const normed: Record<string, unknown> = {};
    for (const k of Object.keys(state).sort()) {
      normed[k] = deepBucket(state[k], steps.get(k) ?? DEFAULT_STEP);
    }
    parts.push([d.moduleType, normed]);
  }
  return JSON.stringify({ d: parts, fps: store.composition.meta.fps });
}

/**
 * True when every catalog device in the clip is `time_independent` — the generator
 * looks the same at every clip time, so ONE captured frame represents the whole strip.
 */
export function generatorIsTimeIndependent(clip: Clip): boolean {
  const devs = catalogDevices(clip);
  if (!devs.length) return false;
  return devs.every((d) => store.enginePlugin(d.moduleType)?.capabilities?.includes('time_independent') ?? false);
}
