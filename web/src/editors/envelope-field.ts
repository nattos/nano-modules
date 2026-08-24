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
 * standalone mod.shaper.envelope effect would, and — with `asString` — by
 * mod.shaper.slice's inspector for its per-lane `curve_i` string fields.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, ContinuousEditHandle } from '../widgets/field-editor';
import { type EnvPoint, parseCurve, curveToArray, serializeCurve } from './envelope-math';
import { EnvelopeGraph } from './envelope-inspector';   // registers <envelope-graph>

@customElement('envelope-field')
export class EnvelopeFieldEditor extends MobxLitElement {
  /** Binding path holding the flat number array (the curve). */
  @property() fieldPath = 'envelope';
  @property({ attribute: false }) binding: FieldBinding | null = null;
  /** Optional binding path for the live value driving the curve's x (draws a
   *  cursor + dot). Null → no cursor. */
  @property() cursorField: string | null = null;
  /**
   * Serialize to the STRING form `"[x0,y0,e0, ...]"` instead of a number array.
   * That is what an effect reading its curve out of a `textField` gets (via
   * patchString) — mod.shaper.envelope's `curve`, mod.shaper.slice's per-lane
   * `curve_i`. `parseCurve` already accepts either form, so only the write side
   * differs.
   */
  @property({ type: Boolean }) asString = false;
  /**
   * Cursor position set imperatively by the parent, for an x the binding cannot
   * name. Slice's lanes need this: a lane's cursor is where the input falls
   * INSIDE that lane's window (null when it falls outside), which is a function
   * of three fields, not one. Takes precedence over `cursorField`.
   */
  cursorOverride: number | null | undefined = undefined;
  /**
   * Stretch the graph to the host's height and drop the interaction hint.
   * A stack of these (Slice's lanes) wants short graphs and one hint at most,
   * not eight 132px ones each repeating the same line.
   */
  @property({ type: Boolean, reflect: true }) fill = false;

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
    :host([fill]) { display: flex; flex-direction: column; min-height: 0; }
    :host([fill]) envelope-graph { flex: 1; min-height: 0; }
    .hint {
      font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0); opacity: 0.7;
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
      if (this.cursorOverride !== undefined) {
        g.cursor = this.cursorOverride;
      } else if (this.cursorField) {
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

  private serialize(pts: EnvPoint[]): string | number[] {
    return this.asString ? serializeCurve(pts) : curveToArray(pts);
  }

  private onChange = (pts: EnvPoint[]) => {
    if (!this.binding) return;
    const v = this.serialize(pts);
    if (this.edit) this.edit.update(v);
    else this.binding.setValue(this.fieldPath, v);   // one-shot (dbl-click add/remove)
  };
  private onStart = () => {
    if (!this.binding) return;
    this.edit = this.binding.beginContinuousEdit(this.fieldPath,
      this.serialize(this.pointsFromField()));
  };
  private onEnd = () => { this.edit?.accept(); this.edit = null; };

  render() {
    if (!this.binding) return html``;
    return html`
      <envelope-graph
        ?fill=${this.fill}
        .onChange=${this.onChange}
        .onInteractionStart=${this.onStart}
        .onInteractionEnd=${this.onEnd}></envelope-graph>
      ${this.fill ? '' : html`<div class="hint">double-click to add / remove a node · drag a segment to bend its easing</div>`}
    `;
  }
}
// Keep the import referenced (side-effect: <envelope-graph> registration).
void EnvelopeGraph;
