/**
 * Shared wire-mod inspector — the modulation controls for one SCALAR wire
 * (magnitude / envelope / remap / scale / delay / combine + mix), extracted
 * from <column-group> so every surface that configures a wire renders the
 * SAME options from one definition: the IDE's floating wire panel and field
 * card, and the Devices tab's per-control/per-device wires panel.
 *
 * Callers supply a `WireModOps` adapter (read + write + long-edit ONE wire) —
 * the IDE routes through its ColumnController seam (so the arrangement's
 * adapter keeps working), the Devices panel through appController directly.
 */

import { html, nothing, TemplateResult } from 'lit';
import type { Wire, TapCurve, TapCombine, WireMagnitude } from '../sketch-types';
import type { FieldBinding, ContinuousEditHandle } from './field-editor';
import type { EditHandle } from './column-adapter';
import { createGenericInspector, type InspectorFieldDef } from './generic-inspector';
import '../editors/envelope-field';   // <envelope-field> for the wire Envelope stage

/** Read/write access to one wire, however the host stores it. */
export interface WireModOps {
  getWire(): Wire | undefined;
  updateWire(patch: Partial<Wire>): void;
  beginUpdateWire(patch: Partial<Wire>): EditHandle;
  updateUpdateWire(edit: EditHandle, patch: Partial<Wire>): void;
}

/**
 * FieldBinding mapping synthetic paths to a wire's mod fields, so the shared
 * field editors can drive them with long edits. Numbers (scale, remap in/out
 * min/max, exponent, mixFactor), booleans (remapEnabled, remap.saturate), and
 * selects (remap.curveIn/curveOut, combine). Reads return undefined for unset
 * numerics so sliders fall back to their default.
 */
export function wireModBinding(bindingKey: string, ops: WireModOps): FieldBinding {
  const read = (path: string): any => {
    const wire = ops.getWire();
    if (!wire) return undefined;
    if (path === 'scale') return wire.mod?.scale;
    if (path === 'delay') return wire.mod?.delay;
    if (path === 'mixFactor') return wire.mixFactor;
    if (path === 'combine') return wire.combine ?? 'replace';
    if (path === 'magnitude') return wire.magnitude ?? 'auto';
    if (path === 'envelope') return wire.mod?.envelope;
    if (path === 'envelopeEnabled') return !!(wire.mod?.envelope && wire.mod.envelope.length >= 6);
    if (path === 'remapEnabled') return !!wire.mod?.remap;
    if (path.startsWith('remap.')) {
      return (wire.mod?.remap as Record<string, any> | undefined)?.[path.slice(6)];
    }
    return undefined;
  };
  // Build a Partial<Wire> patch for a path+value, deep-merging mod/remap.
  const patchFor = (path: string, v: any): Partial<Wire> => {
    const mod = ops.getWire()?.mod ?? {};
    if (path === 'scale') return { mod: { ...mod, scale: v as number } };
    if (path === 'delay') return { mod: { ...mod, delay: v as number } };
    if (path === 'mixFactor') return { mixFactor: v as number };
    if (path === 'combine') return { combine: v as TapCombine };
    if (path === 'magnitude') return { magnitude: v as WireMagnitude };
    if (path === 'envelope') return { mod: { ...mod, envelope: v as number[] } };
    if (path === 'envelopeEnabled') {
      // Toggle on → seed the identity curve [0,0,0, 1,1,0] (passthrough);
      // off → drop the array. Matches remap's enable-seeds-default pattern.
      return { mod: { ...mod, envelope: v ? (mod.envelope ?? [0, 0, 0, 1, 1, 0]) : undefined } };
    }
    if (path === 'remapEnabled') {
      return { mod: { ...mod, remap: v ? (mod.remap ?? { inMin: 0, inMax: 1, outMin: 0, outMax: 1 }) : undefined } };
    }
    const remap = mod.remap ?? { inMin: 0, inMax: 1, outMin: 0, outMax: 1 };
    const key = path.slice(6);
    // field-toggle writes 0/1 for saturate; everything else is the typed value.
    const val = key === 'saturate' ? !!v : v;
    return { mod: { ...mod, remap: { ...remap, [key]: val } } };
  };
  return {
    instanceKey: bindingKey,
    getValue: (path: string) => read(path),
    setValue: (path: string, v: any) => ops.updateWire(patchFor(path, v)),
    beginContinuousEdit: (path: string, v: any): ContinuousEditHandle => {
      const edit = ops.beginUpdateWire(patchFor(path, v));
      return {
        update: (nv: any) => ops.updateUpdateWire(edit, patchFor(path, nv)),
        accept: () => edit.accept(),
        cancel: () => edit.cancel(),
      };
    },
  };
}

/**
 * Modulation controls for one scalar wire: a range remapper (scale + optional
 * remap with saturation and in/out shaping curves) applied to the value, and a
 * `combine` mode for how it folds into the dest when several wires target it.
 * Built from the shared field editors via a FieldBinding (so long edits +
 * styling come for free) — the scalar twin of the old per-tap mod inspector.
 */
export function renderWireModInspector(wire: Wire, binding: FieldBinding): TemplateResult {
  const remap = wire.mod?.remap;
  const usesPower = remap?.curveIn === 'power' || remap?.curveOut === 'power';
  const CURVES: TapCurve[] = ['linear', 'quad', 'circular', 'power', 'foldback'];
  const COMBINES: TapCombine[] = ['replace', 'mix', 'add', 'mul'];
  const MAGNITUDES: WireMagnitude[] = ['auto', 'signed', 'unsigned', 'absolute'];
  const curveOpts = CURVES.map(c => ({ label: c, value: c }));
  const combineOpts = COMBINES.map(c => ({ label: c, value: c }));
  const magOpts = MAGNITUDES.map(m => ({ label: m, value: m }));

  // The shaper stages run in this order (matching native/src/sketch/tap_mod.h +
  // the executor): ENVELOPE → REMAP → SCALE (pure value transforms) → DELAY
  // (temporal, transitive) — with Magnitude folding the result into the dest
  // field's range and Combine deciding how multiple wires stack. The panel is
  // laid out in that order. Envelope's drawn-curve editor can't be a generic
  // field, so it's rendered as a <envelope-field> between the head and tail
  // generic blocks (both driven by the one shared wire binding).
  const envEnabled = !!(wire.mod?.envelope && wire.mod.envelope.length >= 6);

  const headFields: InspectorFieldDef[] = [
    { type: 'select', label: 'Magnitude', path: 'magnitude', options: magOpts, default: 'auto' },
    { type: 'boolean', label: 'Envelope', path: 'envelopeEnabled', default: false },
  ];

  // Remap shapes the value (in its own range); Scale then scales the result in
  // modulation space (applied LAST among the pure stages, before Magnitude maps
  // it into the dest field's declared range). Scale sits under Remap to match.
  const tailFields: InspectorFieldDef[] = [
    { type: 'boolean', label: 'Remap', path: 'remapEnabled', default: false },
  ];
  if (remap) {
    tailFields.push(
      { type: 'slider', label: 'In min', path: 'remap.inMin', min: -1, max: 1, default: 0 },
      { type: 'slider', label: 'In max', path: 'remap.inMax', min: -1, max: 1, default: 1 },
      { type: 'slider', label: 'Out min', path: 'remap.outMin', min: -1, max: 1, default: 0 },
      { type: 'slider', label: 'Out max', path: 'remap.outMax', min: -1, max: 1, default: 1 },
      { type: 'boolean', label: 'Saturate', path: 'remap.saturate', default: false },
      { type: 'select', label: 'Curve in', path: 'remap.curveIn', options: curveOpts, default: 'linear' },
      { type: 'select', label: 'Curve out', path: 'remap.curveOut', options: curveOpts, default: 'linear' },
    );
    if (usesPower) {
      tailFields.push({ type: 'slider', label: 'Exponent', path: 'remap.exponent', min: 0, max: 8, step: 0.1, default: 2 });
    }
  }
  tailFields.push({ type: 'slider', label: 'Scale', path: 'scale', min: 0, max: 4, step: 0.01, default: 1 });
  // Delay: temporal time-shift (seconds), runs after the pure stages. Bounded by
  // the executor's delay-line span (~8s @60fps); the slider caps at 2s.
  tailFields.push({ type: 'slider', label: 'Delay (s)', path: 'delay', min: 0, max: 2, step: 0.01, default: 0 });
  tailFields.push({ type: 'select', label: 'Combine', path: 'combine', options: combineOpts, default: 'replace' });
  if ((wire.combine ?? 'replace') === 'mix') {
    tailFields.push({ type: 'slider', label: 'Mix', path: 'mixFactor', min: 0, max: 1, default: 1 });
  }

  return html`<div style="margin:2px 0 6px 8px;padding-left:8px;border-left:2px solid rgba(255,255,255,0.08)">
    ${createGenericInspector(headFields)(binding)}
    ${envEnabled ? html`<envelope-field .binding=${binding} .fieldPath=${'envelope'}></envelope-field>` : nothing}
    ${createGenericInspector(tailFields)(binding)}
  </div>`;
}
