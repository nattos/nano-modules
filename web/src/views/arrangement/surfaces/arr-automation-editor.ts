/**
 * <arr-automation-editor> — the arrangement's editable automation curve.
 *
 * The arrangement counterpart of `<envelope-inspector>`: it wraps the SAME
 * shared `<envelope-graph>` Canvas editor, but binds it to a first-class
 * `AutomationLane` (`{x,y,bend}[]`) in the store rather than to a serialized
 * device field. Reusing `<envelope-graph>` means drag-a-node / double-click
 * add-remove / drag-a-segment-to-bend behave exactly as in the effect IDE, and
 * the drawn curve evaluates with the same eased math (`automation-eval` →
 * `envelope-math`, the lock-step twin of native `envelope.h`).
 *
 * Sync rule mirrors the inspector: a rAF loop pushes the lane's points into the
 * graph EXCEPT while the user is dragging (so an in-flight edit isn't clobbered
 * by undo/redo/playhead-driven re-renders). Writeback coalesces a whole drag
 * into ONE undo via a per-gesture session key; double-click add/remove is its
 * own one-shot undo.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import type { AutomationLane } from '../model/composition';
import { toEnvPoints } from '../engine/automation-eval';
// Registers <envelope-graph> (and the inspector); we only use the graph.
import { EnvelopeGraph } from '../../../editors/envelope-inspector';
import type { EnvPoint } from '../../../editors/envelope-math';

const DEFAULT_POINTS: EnvPoint[] = [{ x: 0, y: 0.5, ease: 0 }, { x: 1, y: 0.5, ease: 0 }];

@customElement('arr-automation-editor')
export class ArrAutomationEditor extends MobxLitElement {
  /** The lane to edit (read path; reactive). Undefined ⇒ seeded flat curve. */
  @property({ attribute: false }) lane: AutomationLane | undefined;
  /**
   * Resolve (creating on demand) the lane id to WRITE to. Called only on an
   * actual edit, never during render/sync, so creating a lane here is safe.
   */
  @property({ attribute: false }) ensureLaneId: (() => string) | null = null;
  /** Live signal position x∈[0,1] to draw as a cursor, or null. */
  @property({ attribute: false }) cursor: number | null = null;
  /**
   * Optional shared TIME grid (the clip panel's film strip): when set, the curve
   * maps its x∈[0,1] onto the same frame axis as the strip below it (zoom +
   * scroll), so the two share one grid. Omitted ⇒ default full-width [0,1].
   */
  @property({ attribute: false }) pxPerFrame: number | null = null;
  @property({ attribute: false }) scrollFrames = 0;
  @property({ attribute: false }) durationFrames = 0;

  private rafId = 0;
  /** Bumped per drag gesture so each drag coalesces into its own single undo. */
  private session = 0;
  /** Distinct one-shot (double-click) edits get their own undo entries. */
  private oneShot = 0;
  /** Lane id captured at gesture start (survives create-on-first-edit). */
  private activeLaneId: string | null = null;

  static styles = css`
    :host { display: block; }
    /* When sharing the film-strip grid, fill the panel area above the strip. */
    :host([gridded]) { height: 100%; }
    :host([gridded]) .hint { display: none; }
    .hint {
      font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0);
      opacity: 0.7; padding: 4px 0 0; line-height: 1.4;
    }
  `;

  private get graph(): EnvelopeGraph | null {
    return this.renderRoot?.querySelector('envelope-graph') as EnvelopeGraph | null;
  }

  connectedCallback() {
    super.connectedCallback();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const g = this.graph;
      if (!g) return;
      // Push lane points into the graph EXCEPT while dragging (don't clobber).
      if (!g.interacting) g.points = this.lane ? toEnvPoints(this.lane.points) : DEFAULT_POINTS;
      g.cursor = this.cursor;
      // Map the curve's x onto the shared film-strip frame axis when provided, so
      // curve and strip share one zoomable/scrollable time grid.
      if (this.pxPerFrame != null && this.durationFrames > 0) {
        const ppf = this.pxPerFrame;
        const scroll = this.scrollFrames;
        const dur = this.durationFrames;
        g.xMap = (dx) => (dx * dur - scroll) * ppf;
        g.xUnmap = (px) => (scroll + px / ppf) / dur;
      } else {
        g.xMap = null;
        g.xUnmap = null;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private resolveLaneId(): string {
    if (this.activeLaneId) return this.activeLaneId;
    if (this.lane) return this.lane.id;
    return this.ensureLaneId?.() ?? '';
  }

  private onChange = (pts: EnvPoint[]) => {
    const laneId = this.resolveLaneId();
    if (!laneId) return;
    // Drag → one undo for the whole gesture; double-click → its own one-shot.
    const key = this.graph?.interacting
      ? `auto:${laneId}:${this.session}`
      : `auto:${laneId}:one:${this.oneShot++}`;
    store.setAutomationPoints(
      laneId,
      pts.map((p) => ({ x: p.x, y: p.y, bend: p.ease })),
      key,
    );
  };
  private onStart = () => {
    this.session++;
    this.activeLaneId = this.resolveLaneId(); // may create the lane now
  };
  private onEnd = () => { this.activeLaneId = null; };

  render() {
    // `points`/`cursor`/`xMap` are synced imperatively via rAF (so a drag isn't
    // clobbered by re-renders); here we just wire the element + callbacks.
    const gridded = this.pxPerFrame != null;
    if (gridded) this.setAttribute('gridded', '');
    else this.removeAttribute('gridded');
    return html`
      <envelope-graph
        ?fill=${gridded}
        .onChange=${this.onChange}
        .onInteractionStart=${this.onStart}
        .onInteractionEnd=${this.onEnd}></envelope-graph>
      ${gridded ? '' : html`<div class="hint">double-click to add / remove a node · drag a segment to bend its easing</div>`}
    `;
  }
}
