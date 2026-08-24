/**
 * Custom inspector for mod.shaper.slice — the windowed value splitter.
 *
 * The card's whole idea is spatial: one input axis, N windows sitting on it,
 * each stretching its slice back out to 0..1 through its own drawn curve. The
 * generic inspector would render that as 25 unrelated rows (`start_3`, `end_3`,
 * `curve_3`, …) with nothing to say where a lane sits or which one is live.
 * So this one draws it:
 *
 *   - an OVERVIEW strip across the top: every lane's window as a band on the
 *     shared input axis, with a playhead at the live input. Overlaps, gaps and
 *     the lane order are visible at a glance — the thing a per-wire remap can
 *     never show you.
 *   - one LANE ROW each: the lane's envelope graph, its Start/End sliders, and
 *     a live readout of what it is publishing. The graph's cursor is where the
 *     input falls INSIDE that lane's window, so an inactive lane simply has no
 *     playhead and the live one shows exactly where on its curve it is sitting.
 *
 * A custom inspector REPLACES the generic card body, so every wireable field
 * has to be rendered here or it loses its port: a wire anchors to the widget's
 * DOM rect (field-anchor-lookup). Hence the Start/End sliders are not optional
 * decoration — they are the lanes' input pips. (`out_i` needs nothing: the
 * output trace rows come from the schema via column-group's collectModuleOutputs.)
 *
 * Live values are pushed imperatively from a rAF loop, never read in render():
 * a MobxLitElement tracks its whole render, so reading a per-frame engine value
 * there would re-render the card every frame forever.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding } from '../widgets/field-editor';
import {
  SLICE_MODULE_TYPE, sliceOutputCount, sliceSpreadValues,
  sliceStartField, sliceEndField, sliceCurveField, sliceOutField,
} from '../state/math-nodes';
import './envelope-field';
import '../widgets/scalar-slider';
import '../widgets/field-tab-bar';
import '../widgets/help-slot';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Lane hue — spread around the wheel so adjacent bands never read as one. */
export function sliceLaneColor(index: number, alpha = 1): string {
  const hue = (196 + index * 43) % 360;
  return `hsl(${hue} 62% 58% / ${alpha})`;
}

/**
 * Where `x` falls inside lane [start,end], or null when it falls outside.
 * Mirrors `laneValue`'s `t` in native/wasm_modules/mod_slice/main.cpp — it is
 * only ever used to place a cursor, so it deliberately does NOT evaluate the
 * curve (the graph draws that itself).
 */
export function sliceLaneCursor(x: number, start: number, end: number): number | null {
  const s = clamp01(start);
  const e = Math.max(s, clamp01(end));
  const inside = x >= s && (x < e || e >= 1);
  if (!inside) return null;
  const span = e - s;
  return span > 1e-6 ? clamp01((x - s) / span) : 1;
}

@customElement('slice-inspector')
export class SliceInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  private rafId = 0;

  static styles = css`
    :host { display: flex; flex-direction: column; gap: var(--app-sp-2); }

    .overview {
      position: relative;
      height: 22px;
      border: 1px solid var(--app-border-color, #3a3346);
      border-radius: 1px;
      background: rgba(0, 0, 0, 0.25);
      overflow: hidden;
    }
    .band {
      position: absolute; top: 0; bottom: 0;
      border-left: 1px solid rgba(255, 255, 255, 0.25);
      display: flex; align-items: center; justify-content: center;
      font-size: var(--app-fs-xs); color: rgba(255, 255, 255, 0.85);
      overflow: hidden;
    }
    .playhead {
      position: absolute; top: 0; bottom: 0; width: 1px;
      background: #fff; pointer-events: none;
    }

    .lane {
      display: flex; flex-direction: column; gap: 2px;
      padding-top: var(--app-sp-2);
      border-top: 1px solid var(--app-border-color, #3a3346);
    }
    .lane-head {
      display: flex; align-items: center; gap: var(--app-sp-2);
      font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0);
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .lane-val { margin-left: auto; font-variant-numeric: tabular-nums; }
    .graph { height: 72px; display: flex; }
    .graph envelope-field { flex: 1; min-width: 0; }
    .edges { display: flex; gap: var(--app-sp-2); }
    .edges scalar-slider { flex: 1; min-width: 0; }

    .actions { display: flex; justify-content: flex-end; }
    button {
      font: inherit; font-size: var(--app-fs-xs);
      color: var(--app-text-color2, #b0b0b0);
      background: var(--app-bg-color3, #2a2533);
      border: 1px solid var(--app-border-color, #3a3346);
      border-radius: 2px; padding: 2px 8px; cursor: pointer;
    }
    button:hover { color: var(--app-text-color, #fff); }
    .hint {
      font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0);
      opacity: 0.7; line-height: 1.4;
    }
  `;

  private count(): number {
    return sliceOutputCount(this.stateSnapshot());
  }

  /** The authored fields the lane layout depends on, as a plain object. */
  private stateSnapshot(): Record<string, any> {
    const b = this.binding;
    if (!b) return {};
    const s: Record<string, any> = { input_count: b.getValue('input_count') };
    for (let n = 1; n <= 8; n++) {
      s[sliceStartField(n)] = b.getValue(sliceStartField(n));
      s[sliceEndField(n)] = b.getValue(sliceEndField(n));
    }
    return s;
  }

  private edge(field: string, fallback: number): number {
    const v = this.binding?.getValue(field);
    return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : fallback;
  }

  connectedCallback() {
    super.connectedCallback();
    // Live values are pushed, not rendered — see the file header.
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const b = this.binding;
      const root = this.renderRoot as HTMLElement | null;
      if (!b || !root) return;

      const mod = b.getModulation?.('input');
      const raw = mod ? mod.value : b.getValue('input');
      const x = typeof raw === 'number' ? clamp01(raw) : 0;

      const head = root.querySelector('.playhead') as HTMLElement | null;
      if (head) head.style.left = `${x * 100}%`;

      const n = this.count();
      for (let i = 1; i <= n; i++) {
        const s = this.edge(sliceStartField(i), 0);
        const e = this.edge(sliceEndField(i), 1);
        const field = root.querySelector(`envelope-field[data-lane="${i}"]`) as any;
        if (field) field.cursorOverride = sliceLaneCursor(x, s, e);
        const out = root.querySelector(`.lane-val[data-lane="${i}"]`) as HTMLElement | null;
        if (out) {
          const v = b.getValue(sliceOutField(i));
          out.textContent = typeof v === 'number' ? v.toFixed(2) : '—';
        }
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** Re-spread every active lane evenly — one undo entry for the whole gesture. */
  private spread = () => {
    const b = this.binding;
    if (!b) return;
    const values = sliceSpreadValues(this.count());
    if (b.beginContinuousEditMulti) b.beginContinuousEditMulti(values).accept();
    else for (const k in values) b.setValue(k, values[k]);
  };

  private renderOverview(n: number) {
    const bands = [];
    for (let i = 1; i <= n; i++) {
      const s = this.edge(sliceStartField(i), (i - 1) / n);
      const e = Math.max(s, this.edge(sliceEndField(i), i / n));
      bands.push(html`<div class="band" style=${`left:${s * 100}%;width:${(e - s) * 100}%;` +
        `background:${sliceLaneColor(i - 1, 0.42)};`}>${e - s > 0.06 ? i : ''}</div>`);
    }
    return html`<div class="overview">${bands}<div class="playhead"></div></div>`;
  }

  render() {
    const b = this.binding;
    if (!b) return html``;
    const n = this.count();
    const lanes = [];
    for (let i = 1; i <= n; i++) {
      lanes.push(html`
        <div class="lane">
          <div class="lane-head">
            <span class="dot" style=${`background:${sliceLaneColor(i - 1)}`}></span>
            Out ${i}
            <span class="lane-val" data-lane=${i}>—</span>
          </div>
          <div class="graph">
            <envelope-field data-lane=${i} ?asString=${true} ?fill=${true}
              .fieldPath=${sliceCurveField(i)} .binding=${b}></envelope-field>
          </div>
          <div class="edges">
            <scalar-slider .fieldPath=${sliceStartField(i)} .label=${'Start'}
              .min=${0} .max=${1} .step=${0.01} .defaultValue=${(i - 1) / n}
              .binding=${b}></scalar-slider>
            <scalar-slider .fieldPath=${sliceEndField(i)} .label=${'End'}
              .min=${0} .max=${1} .step=${0.01} .defaultValue=${i / n}
              .binding=${b}></scalar-slider>
          </div>
        </div>
      `);
    }

    return html`
      <help-slot .binding=${b} .path=${'intro'}></help-slot>
      <help-slot .binding=${b} .path=${'@group/input'}></help-slot>
      <!-- The signal being cut up. Shown even when auto-connected so it exposes
           a wire port AND can be scrubbed by hand while dialling the windows in. -->
      <scalar-slider .fieldPath=${'input'} .label=${'Input'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0}
        .binding=${b}></scalar-slider>
      <field-tab-bar .fieldPath=${'beyond'} .label=${'Beyond'}
        .options=${[{ label: 'Gate', value: 0 }, { label: 'Hold', value: 1 }]}
        .defaultValue=${0} .binding=${b}></field-tab-bar>
      ${this.renderOverview(n)}
      <div class="actions"><button @click=${this.spread}>Spread evenly</button></div>
      <help-slot .binding=${b} .path=${'@group/slices'}></help-slot>
      ${lanes}
      <div class="hint">double-click a curve to add / remove a node · drag a segment to bend it</div>
    `;
  }
}

editorRegistry.register(SLICE_MODULE_TYPE, {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('slice-inspector') as SliceInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
