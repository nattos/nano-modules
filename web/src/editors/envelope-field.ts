/**
 * <envelope-field> — a thin reusable binding of the generic <envelope-graph>
 * curve editor to a FieldBinding path whose value is a flat number ARRAY
 * `[x0,y0,e0, ...]` (the wire `mod.shaper.envelope` format), rather than the stringified
 * `curve` field the mod.shaper.envelope effect inspector uses.
 *
 * It's the same imperative-sync pattern as EnvelopeInspector (points pushed into
 * the graph via a rAF loop, guarded by `interacting` so a drag isn't clobbered;
 * continuous edits routed through begin/update/accept), just array-valued and
 * without the effect-specific input slider. Used by the wire-config "Envelope"
 * shaper stage (column-group.ts) so a wire can carry the same drawn curve a
 * standalone mod.shaper.envelope effect would.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, ContinuousEditHandle } from '../widgets/field-editor';
import { type EnvPoint, parseCurve, curveToArray } from './envelope-math';
import { EnvelopeGraph } from './envelope-inspector';   // registers <envelope-graph>

@customElement('envelope-field')
export class EnvelopeFieldEditor extends MobxLitElement {
  /** Binding path holding the flat number array (the curve). */
  @property() fieldPath = 'envelope';
  @property({ attribute: false }) binding: FieldBinding | null = null;
  /** Optional binding path for the live value driving the curve's x (draws a
   *  cursor + dot). Null → no cursor. */
  @property() cursorField: string | null = null;

  private edit: ContinuousEditHandle | null = null;
  private rafId = 0;
  // Cache the parse so the rAF sync doesn't re-parse an unchanged value 60×/s.
  private lastRaw: any = undefined;
  private lastPts: EnvPoint[] = [];

  private pointsFromField(): EnvPoint[] {
    const raw = this.binding?.getValue(this.fieldPath);
    if (raw !== this.lastRaw) { this.lastRaw = raw; this.lastPts = parseCurve(raw); }
    return this.lastPts;
  }

  static styles = css`
    :host { display: block; }
    .hint {
      font-size: 9px; color: var(--app-text-color2, #8a8296); opacity: 0.7;
      padding: 4px 0 2px; line-height: 1.4;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const g = this.renderRoot?.querySelector('envelope-graph') as EnvelopeGraph | null;
      if (!g || !this.binding) return;
      // Sync points from the field (undo/redo/load) EXCEPT while dragging.
      if (!g.interacting) g.points = this.pointsFromField();
      if (this.cursorField) {
        const mod = this.binding.getModulation?.(this.cursorField);
        const live = mod ? mod.value : this.binding.getValue(this.cursorField);
        g.cursor = typeof live === 'number' ? live : null;
      }
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
    const arr = curveToArray(pts);
    if (this.edit) this.edit.update(arr);
    else this.binding.setValue(this.fieldPath, arr);   // one-shot (dbl-click add/remove)
  };
  private onStart = () => {
    if (!this.binding) return;
    this.edit = this.binding.beginContinuousEdit(this.fieldPath,
      curveToArray(this.pointsFromField()));
  };
  private onEnd = () => { this.edit?.accept(); this.edit = null; };

  render() {
    if (!this.binding) return html``;
    return html`
      <envelope-graph
        .onChange=${this.onChange}
        .onInteractionStart=${this.onStart}
        .onInteractionEnd=${this.onEnd}></envelope-graph>
      <div class="hint">double-click to add / remove a node · drag a segment to bend its easing</div>
    `;
  }
}
// Keep the import referenced (side-effect: <envelope-graph> registration).
void EnvelopeGraph;
