/**
 * Envelope Warp inspector (warp.envelope) — the drawn-curve warp.
 *
 * Reuses the generic <envelope-graph> editor (envelope-inspector.ts) for the
 * effect's curve textFields: <warp-curve-field> binds ONE string-serialized
 * curve field to a graph (rAF-synced so undo/redo/load update it without
 * clobbering a drag; drags go through one continuous edit = one undo entry).
 * The inspector composes the standard self-styled widgets around it — a mode
 * tab bar that also decides whether ONE curve or TWO (X and Y / Rect) are
 * shown, the Amount slider, the Edges fill picker, and the radial Center pad.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from '../widgets/field-editor';
import { parseCurve, serializeCurve, type EnvPoint } from './envelope-math';
import './envelope-inspector';   // defines <envelope-graph>
import type { EnvelopeGraph } from './envelope-inspector';
import '../widgets/field-tab-bar';
import '../widgets/field-vec';
import '../widgets/scalar-slider';
import '../widgets/help-slot';

/** One string-serialized curve textField ⇄ one <envelope-graph>. */
@customElement('warp-curve-field')
export class WarpCurveField extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = 'curve';
  @property() label = '';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return [this.fieldPath]; }
  getControlElements(): HTMLElement[] {
    const g = this.renderRoot?.querySelector('envelope-graph') as HTMLElement | null;
    return g ? [g] : [];
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  private edit: ContinuousEditHandle | null = null;
  private rafId = 0;
  private lastRaw: any = undefined;
  private lastPts: EnvPoint[] = [];

  private pointsFromField(): EnvPoint[] {
    const raw = this.binding?.getValue(this.fieldPath);
    if (raw !== this.lastRaw) { this.lastRaw = raw; this.lastPts = parseCurve(raw); }
    return this.lastPts;
  }

  static styles = css`
    :host { display: block; }
    .label {
      font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0); padding: 2px 0;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // Keep the graph synced with the field (undo/redo/load) except mid-drag.
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const g = this.renderRoot?.querySelector('envelope-graph') as EnvelopeGraph | null;
      if (!g || !this.binding) return;
      if (!g.interacting) g.points = this.pointsFromField();
    };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private onChange = (pts: EnvPoint[]) => {
    if (!this.binding) return;
    const str = serializeCurve(pts);
    if (this.edit) this.edit.update(str);
    else this.binding.setValue(this.fieldPath, str);   // one-shot (dbl-click add/remove)
  };
  private onStart = () => {
    if (!this.binding) return;
    this.edit = this.binding.beginContinuousEdit(this.fieldPath,
      serializeCurve(this.pointsFromField()));
  };
  private onEnd = () => { this.edit?.accept(); this.edit = null; };

  render() {
    if (!this.binding) return html``;
    return html`
      ${this.label ? html`<div class="label">${this.label}</div>` : ''}
      <envelope-graph
        .onChange=${this.onChange}
        .onInteractionStart=${this.onStart}
        .onInteractionEnd=${this.onEnd}></envelope-graph>
    `;
  }
}

const MODE_OPTIONS = [
  { label: 'Horizontal', value: 0 },
  { label: 'Vertical', value: 1 },
  { label: 'XY', value: 2 },
  { label: 'X and Y', value: 3 },
  { label: 'Rect', value: 4 },
  { label: 'Radial', value: 5 },
];
const EDGE_OPTIONS = [
  { label: 'Stretch', value: 0 },
  { label: 'Transparent', value: 1 },
];

@customElement('envelope-warp-inspector')
export class EnvelopeWarpInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  static styles = css`
    :host { display: block; }
    .section {
      font-size: var(--app-fs-xs); text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2, #b0b0b0); padding: 6px 0 2px; opacity: 0.7;
    }
    .hint {
      font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0); opacity: 0.7;
      padding: 4px 0 2px; line-height: 1.4;
    }
  `;

  private section(title: string, path: string) {
    return html`
      <div class="section">${title}</div>
      <help-slot .binding=${this.binding} .path=${path}></help-slot>
    `;
  }

  render() {
    if (!this.binding) return html``;
    const b = this.binding;
    const mode = Number(b.getValue('mode') ?? 0);
    const twoCurves = mode === 3 || mode === 4;   // X and Y / Rect
    const radial = mode === 5;
    return html`
      <help-slot .binding=${b} .path=${'intro'}></help-slot>

      ${this.section('Warp', '@group/warp')}
      <field-tab-bar .fieldPath=${'mode'} .label=${'Symmetry'} .options=${MODE_OPTIONS}
        .defaultValue=${0} ?wrap=${true} .binding=${b}></field-tab-bar>
      <scalar-slider style="width: 100%;" .fieldPath=${'amount'} .label=${'Amount'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1}
        .binding=${b}></scalar-slider>
      <field-tab-bar .fieldPath=${'edges'} .label=${'Edges'} .options=${EDGE_OPTIONS}
        .defaultValue=${0} .binding=${b}></field-tab-bar>
      ${radial ? html`
        <field-vec .fieldPath=${'center'} .label=${'Center'} .components=${2}
          .min=${-1} .max=${1} .step=${0.01} .defaultValue=${[0, 0]}
          .componentLabels=${['X', 'Y']} .binding=${b}></field-vec>
      ` : ''}

      ${this.section('Curves', '@group/curves')}
      <warp-curve-field .fieldPath=${'curve'}
        .label=${twoCurves ? 'X Curve' : ''} .binding=${b}></warp-curve-field>
      ${twoCurves ? html`
        <warp-curve-field .fieldPath=${'curve_y'} .label=${'Y Curve'}
          .binding=${b}></warp-curve-field>
      ` : ''}
      <div class="hint">
        the diagonal is no warp · double-click to add / remove a node ·
        drag a segment to bend its easing
      </div>
    `;
  }
}

editorRegistry.register('warp.envelope', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('envelope-warp-inspector') as EnvelopeWarpInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
