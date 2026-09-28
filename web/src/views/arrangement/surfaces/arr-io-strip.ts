/**
 * <arr-io-strip> — a track header's Composition I/O ports (I/O mode, in place
 * of the mixer strip): the main `in` / `out`, the track's named ports, and a
 * `+` to add one. Each pip is a wire endpoint — drag from it to connect, drop
 * a field or another port on it, click it for its popup (rename / output
 * routing / its routes). A SEND-NOWHERE `out` is drawn hollow.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import { PORT_IN, PORT_OUT, type Track } from '../model/composition';
import { WireConnect } from '../../../widgets/taps-connect';
import { setAnchor, AnchorKeys } from './anchor-registry';
import { portConnect, portDir, portName } from './arr-io';

@customElement('arr-io-strip')
export class ArrIoStrip extends MobxLitElement {
  @property({ attribute: false }) trackId!: string;

  static styles = css`
    :host { display: flex; align-items: center; gap: 3px; min-width: 0; overflow: hidden; }
    .port {
      display: inline-flex; align-items: center; gap: 3px; flex: 0 1 auto; min-width: 0;
      height: 16px; padding: 0 5px 0 3px; border-radius: 8px; cursor: crosshair;
      border: 1px solid var(--app-tint-4); background: var(--app-bg-color1);
      font-size: var(--app-fs-xs); color: var(--app-text-color2); user-select: none;
    }
    .port .dot {
      width: 8px; height: 8px; border-radius: 50%; flex: none;
      background: var(--io-color, #46d18c);
    }
    .port.in .dot { background: transparent; border: 2px solid var(--io-color, #46d18c); width: 4px; height: 4px; }
    .port.none .dot { background: transparent; border: 1px dashed var(--io-color, #46d18c); }
    .port .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .port.wired { color: var(--app-text-color1); border-color: color-mix(in srgb, var(--io-color, #46d18c) 60%, transparent); }
    .port:hover, .port[tap-drop-target] { background: color-mix(in srgb, var(--io-color, #46d18c) 20%, transparent); }
    .spacer { flex: 1 1 0; min-width: 0; }
    .add {
      flex: none; width: 16px; height: 16px; border-radius: 8px; cursor: pointer; padding: 0;
      border: 1px dashed var(--app-tint-4); background: none; color: var(--app-text-color2);
      font-size: var(--app-fs-xs); line-height: 14px;
    }
    .add:hover { color: var(--app-text-color1); border-color: var(--app-text-color2); }
  `;

  updated() {
    // Register every pip as a route anchor (the overlay draws to them).
    const t = store.trackById(this.trackId);
    if (!t) return;
    for (const el of this.renderRoot.querySelectorAll<HTMLElement>('.port')) {
      setAnchor(AnchorKeys.port(this.trackId, el.dataset.portId!), el.querySelector('.dot'));
    }
  }

  render() {
    const t = store.trackById(this.trackId);
    if (!t || t.kind === 'rail') return nothing;
    const ins = (t.ports ?? []).filter((p) => p.dir === 'in');
    const outs = (t.ports ?? []).filter((p) => p.dir === 'out');
    const bus = store.isMainBus(t);
    return html`
      ${bus ? nothing : this.pip(t, PORT_IN)}
      ${ins.map((p) => this.pip(t, p.id))}
      <span class="spacer"></span>
      ${outs.map((p) => this.pip(t, p.id))}
      ${bus ? nothing : this.pip(t, PORT_OUT)}
      ${bus ? nothing : html`<button class="add" title="Add a named port"
          @pointerdown=${(e: Event) => e.stopPropagation()}
          @click=${(e: MouseEvent) => this.onAdd(e, t)}>+</button>`}
    `;
  }

  private pip(t: Track, portId: string) {
    const dir = portDir(t, portId);
    const wired = store.routesAt({ kind: 'port', trackId: t.id, portId }).length > 0;
    const none = portId === PORT_OUT && store.trackOutputMode(t.id) === 'none';
    const title = portId === PORT_IN
      ? 'Input — route a track or port here to process it instead of the stack below'
      : portId === PORT_OUT
        ? (none ? 'Output — sent nowhere (still renders; routes still deliver)' : 'Output — this track\'s picture, post-FX')
        : `${dir === 'out' ? 'Output' : 'Input'} port “${portName(t, portId)}” — wire it to a field`;
    return html`<span
      class="port tap-overlay-hit ${dir} ${wired ? 'wired' : ''} ${none ? 'none' : ''}"
      data-port-track=${t.id}
      data-port-id=${portId}
      data-port-dir=${dir}
      title=${title}
      @pointerdown=${(e: PointerEvent) => this.onPipDown(e, t, portId, dir)}
      @click=${(e: MouseEvent) => this.onPipClick(e, t, portId)}
    ><span class="dot"></span><span class="nm">${portName(t, portId)}</span></span>`;
  }

  private onPipDown(e: PointerEvent, t: Track, portId: string, dir: 'in' | 'out') {
    e.stopPropagation(); // not a header drag / selection
    // A click-mode gesture picked up elsewhere completes HERE.
    if (WireConnect.active) {
      e.preventDefault();
      WireConnect.active.completeOnTrackPort(t.id, portId, dir);
      return;
    }
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    portConnect.beginFromFieldDrag(e, el, '', `port/${t.id}/${portId}`, {
      sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: dir === 'out',
      viewportY: r.top + r.height / 2, schemaDef: null,
      trackPort: { trackId: t.id, portId, dir },
    });
  }

  private onPipClick(e: MouseEvent, t: Track, portId: string) {
    e.stopPropagation();
    if (portConnect.consumeClickSuppression()) return; // the end of a drag
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    store.openPortPopup(t.id, portId, r.left, r.bottom + 4);
  }

  private onAdd(e: MouseEvent, t: Track) {
    e.stopPropagation();
    // Shift adds an INPUT port; plain click an output (the common case: a
    // second picture out of one track).
    const dir = e.shiftKey ? 'in' : 'out';
    const id = store.addTrackPort(t.id, dir);
    if (id) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      store.openPortPopup(t.id, id, r.left, r.bottom + 4);
    }
  }
}
