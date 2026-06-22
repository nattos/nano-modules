/**
 * Mockup-only glue so the real <scalar-slider> (and its FieldBinding contract)
 * can drive a clip/track sketch in the inspector without the real engine.
 *
 * `fakeParamsFor` synthesizes a small, deterministic parameter set per device
 * (devices carry no schema in M1), and `FakeBinding` reads/writes those values
 * on the device's `state` object so edits stick across re-selection.
 */

import type {
  FieldBinding,
  ContinuousEditHandle,
} from '../../../widgets/field-editor';
import type { Device } from '../model/composition';

export interface FakeParam {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

const POOL: Array<[string, number, number, number]> = [
  ['amount', 0, 1, 0.5],
  ['intensity', 0, 1, 0.6],
  ['mix', 0, 1, 0.5],
  ['radius', 0, 1, 0.3],
  ['gain', -1, 1, 0.0],
  ['threshold', 0, 1, 0.4],
  ['rate', 0, 1, 0.5],
  ['depth', 0, 1, 0.7],
  ['hue', -1, 1, 0.0],
  ['feedback', 0, 1, 0.25],
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic 2–3 fake params for a device, derived from its module id. */
export function fakeParamsFor(device: Device): FakeParam[] {
  const h = hash(device.moduleType);
  const count = 2 + (h % 2); // 2 or 3
  const params: FakeParam[] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    let idx = (h >>> (i * 5)) % POOL.length;
    while (used.has(idx)) idx = (idx + 1) % POOL.length;
    used.add(idx);
    const [name, min, max, def] = POOL[idx];
    params.push({
      path: name,
      label: name,
      min,
      max,
      step: max - min > 2 ? 0.05 : 0.01,
      defaultValue: def,
    });
  }
  return params;
}

/**
 * A FieldBinding backed by a device's `state` object. Constructed fresh per
 * render, so it must NOT write observables in its constructor (that would mutate
 * inside the render autorun and throw) — defaults are returned lazily, and the
 * device.state is only written on an actual edit (an event handler).
 */
export class FakeBinding implements FieldBinding {
  instanceKey: string;
  private device: Device;
  private defaults: Record<string, number> = {};

  constructor(device: Device, params: FakeParam[]) {
    this.instanceKey = device.id;
    this.device = device;
    for (const p of params) this.defaults[p.path] = p.defaultValue;
  }

  private writeState(): Record<string, any> {
    if (!this.device.state) this.device.state = {};
    return this.device.state as Record<string, any>;
  }

  getValue(fieldPath: string): any {
    const st = this.device.state as Record<string, any> | undefined;
    return st?.[fieldPath] ?? this.defaults[fieldPath] ?? 0;
  }

  setValue(fieldPath: string, value: any): void {
    this.writeState()[fieldPath] = value;
  }

  beginContinuousEdit(fieldPath: string, startValue: any): ContinuousEditHandle {
    return {
      update: (v: any) => {
        this.writeState()[fieldPath] = v;
      },
      accept: () => {
        /* mockup: no undo point */
      },
      cancel: () => {
        this.writeState()[fieldPath] = startValue;
      },
    };
  }
}
