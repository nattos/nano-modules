/**
 * <arr-overlay> — app-level wire overlay. A single viewport-fixed SVG that
 * draws rail modulation wires across BOTH the arrangement and the inspector,
 * so a reader wire can terminate at the actual field editor in a clip's chain.
 *
 * Endpoints come from the cross-shadow anchor registry; geometry is refreshed on
 * a rAF loop (positions change on scroll/zoom without re-rendering this element).
 * Wire DOM is reconciled by id so click handlers stay stable. The tap-config
 * popup is rendered reactively from store.tapPopup.
 */

import { html, css } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import { anchorRect, AnchorKeys } from './anchor-registry';
import { createGenericInspector, type InspectorFieldDef } from '../../../widgets/generic-inspector';
import { PORT_OUT, type Route, type RouteEnd } from '../model/composition';
import { beginPortClickConnect, portConnect, portDir, portName, revealRouteField, routeEndLabel, routeFieldRect, sketchFieldRect, sketchWireDestLabel } from './arr-io';
import type { FieldBinding, ContinuousEditHandle } from '../../../widgets/field-editor';
import { compositionSketches } from '../model/composition';
import { midiInstanceIdFromKey } from '../../../midi/midi-types';
import { deviceAnchorRect, DeviceAnchorKeys } from '../../devices/device-anchors';
import { devicesUi } from '../../devices/devices-ui';

// Wire (tap) options, rendered through the SAME generic field editors the effect IDE
// uses (createGenericInspector) so the two surfaces share one layout. Bound to the
// arrangement's tap object below.
const TAP_FIELDS: InspectorFieldDef[] = [
  { type: 'select', label: 'Combine', path: 'combine', default: 'add',
    options: ['replace', 'mix', 'add', 'mul'].map((v) => ({ label: v, value: v })) },
  { type: 'select', label: 'Magnitude', path: 'magnitude', default: 'auto',
    options: ['auto', 'signed', 'unsigned', 'absolute'].map((v) => ({ label: v, value: v })) },
  { type: 'slider', label: 'Scale', path: 'scale', min: 0, max: 2, step: 0.01, default: 1 },
  { type: 'boolean', label: 'Smooth', path: 'smoothing', default: false },
  { type: 'boolean', label: 'Remap', path: 'remap', default: false },
];
const tapInspector = createGenericInspector(TAP_FIELDS);

interface Pt {
  x: number;
  y: number;
}
interface WireDesc {
  id: string;
  /** A Composition I/O route (drawn in ROUTE colour; click opens the route
   *  popup, dbl-click deletes). */
  route?: { id: string; delayed: boolean; live: boolean };
  /** A MIDI device wire (a sketch wire from `midi:<uuid>`): click opens the
   *  device's card in the Devices view (its wires, with their settings),
   *  dbl-click deletes. */
  midi?: { sketchId: string; wireId: string; deviceId: string };
  color: string;
  a: Pt; // source (data-out)
  b: Pt; // dest (data-in)
  clipPath: string;
  label: string;
  target: { field?: string; trace?: boolean };
  popup?: boolean; // false = pip selects only (no tap config), e.g. beat warp
}

interface ChipDesc {
  id: string;
  at: Pt;
  text: string;
  route: Route;
  other: RouteEnd;
  live: boolean;
}

const WRITER = '#ff8c00';
const READER = '#4dc9f6';
const WARP = '#a07ce0';
/** Composition I/O routes (picture routing, not modulation). */
const ROUTE = '#46d18c';
const NS = 'http://www.w3.org/2000/svg';

/** The devices panel's scroll viewport (cards scrolled out of it draw no
 *  wire), or null when it isn't mounted. */
function devicesScrollRect(): DOMRect | null {
  const app = document.querySelector('arrangement-app');
  const tab = app?.shadowRoot?.querySelector('devices-tab');
  const sc = tab?.shadowRoot?.querySelector('.scroll');
  return sc ? sc.getBoundingClientRect() : null;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// A wire between a clip and an immediately-adjacent return track spans only a
// few vertical pixels; left as a straight segment it's an invisible, unhittable
// sliver. Bow the bezier in the travel direction so short wires still read as a
// grabbable arc. Long wires (|dy| past the threshold) are unchanged.
const MIN_WIRE_BOW = 26;

function wirePath(a: Pt, b: Pt): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const vert = Math.abs(dx) < 30;
  const c1x = a.x + (vert ? 18 : dx * 0.2);
  const c2x = b.x - (vert ? 18 : dx * 0.2);
  const dir = dy >= 0 ? 1 : -1;
  const bow = Math.max(0, MIN_WIRE_BOW - Math.abs(dy) * 0.5);
  const my = a.y + dy * 0.5 + dir * bow;
  return `M ${a.x} ${a.y} C ${c1x} ${my}, ${c2x} ${my}, ${b.x} ${b.y}`;
}

@customElement('arr-overlay')
export class ArrOverlay extends MobxLitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 60;
    }
    svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: visible;
    }
    svg path.hit {
      stroke: transparent;
      stroke-width: 12;
      fill: none;
      pointer-events: stroke;
      cursor: pointer;
    }
    svg path.arc {
      fill: none;
      stroke-width: 1.5;
      pointer-events: none;
      stroke-dasharray: 5 3;
      animation: wireflow 0.8s linear infinite;
    }
    svg path.arc.sel {
      stroke: var(--app-hi-color1) !important;
      stroke-width: 2;
      stroke-dasharray: none;
      animation: none;
    }
    @keyframes wireflow {
      to {
        stroke-dashoffset: -8;
      }
    }
    svg path.arc.route { stroke-dasharray: none; animation: none; stroke-width: 2; }
    svg path.arc.route.delayed { stroke-dasharray: 2 3; }
    svg path.arc.route.inert { opacity: 0.35; }
    svg path.arc.route.sel { stroke: #46d18c !important; stroke-width: 3; }
    svg path.connect {
      fill: none; stroke: #46d18c; stroke-width: 2; stroke-dasharray: 4 3; pointer-events: none;
    }
    .chip {
      position: fixed; pointer-events: auto; z-index: 61; cursor: pointer;
      max-width: 180px; padding: 1px 6px; border-radius: 8px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; font-size: var(--app-fs-xs);
      color: var(--app-text-color1); background: var(--app-bg-color2);
      border: 1px solid color-mix(in srgb, #46d18c 60%, transparent);
    }
    .chip.inert { opacity: 0.45; }
    .port-card { width: 220px; }
    .port-card input.pname {
      width: 100%; box-sizing: border-box; font: inherit; font-size: var(--app-fs-sm);
      background: var(--app-bg-color1); color: var(--app-text-color1);
      border: 1px solid var(--app-tint-4); border-radius: 2px; padding: 2px 4px;
    }
    .port-card .rt { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
    .port-card .rt .lbl {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      cursor: pointer; color: var(--app-text-color2);
    }
    .port-card .rt .lbl:hover { color: var(--app-text-color1); }
    .port-card .rt .flag { font-size: var(--app-fs-xs); color: var(--app-text-color2); }
    .port-card .x { cursor: pointer; background: none; border: none; color: var(--app-text-color2); }
    .port-card .x:hover { color: var(--app-text-color1); }
    .port-card .acts { display: flex; gap: 6px; margin-top: 6px; }
    svg circle.pip {
      pointer-events: auto;
      cursor: pointer;
      stroke: var(--app-bg-color1);
      stroke-width: 1;
    }
    .tap-card {
      position: fixed;
      pointer-events: auto;
      z-index: 61;
      width: 188px;
      padding: 7px 9px;
      border-radius: 2px;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-hi-color2);
      box-shadow: 0 3px 12px rgba(0, 0, 0, 0.5);
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
    }
    .tap-card .tc-head {
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      margin-bottom: 5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tap-card .tc-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 3px 0;
    }
    .tap-card select,
    .tap-card input[type='range'] {
      font-family: inherit;
      font-size: var(--app-fs-xs);
      background: var(--app-bg-color1);
      color: var(--app-text-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      max-width: 96px;
    }
    .tap-card .tc-toggle {
      cursor: pointer;
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 1px 6px;
      background: var(--app-bg-color1);
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs);
    }
    .tap-card .tc-toggle.on {
      border-color: var(--app-hi-color2);
      color: var(--app-hi-color2);
    }
  `;

  @query('svg') private svg!: SVGSVGElement;
  private raf = 0;
  private els = new Map<string, { hit: SVGPathElement; arc: SVGPathElement; pip: SVGCircleElement }>();

  firstUpdated() {
    this.tick();
    // The port popup closes on any press outside it (its card stops its own)
    // and on Escape.
    document.addEventListener('pointerdown', this.onDocDown);
    document.addEventListener('keydown', this.onDocKey);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    document.removeEventListener('pointerdown', this.onDocDown);
    document.removeEventListener('keydown', this.onDocKey);
  }
  private onDocDown = () => {
    if (store.portPopup) store.closePortPopup();
    if (store.routePopup) store.closeRoutePopup();
  };
  private onDocKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (store.portPopup) store.closePortPopup();
    if (store.routePopup) store.closeRoutePopup();
  };
  private tick = () => {
    this.sync();
    this.raf = requestAnimationFrame(this.tick);
  };

  render() {
    return html`<svg></svg><div class="chips"></div>${this.renderPopup()}${this.renderPortPopup()}${this.renderRoutePopup()}`;
  }

  // ── Wire geometry ───────────────────────────────────────────────────────
  /** Where a route end sits on screen (a port pip's centre, a field's left
   *  edge), or null when it isn't showing. */
  private routeEndPoint(e: RouteEnd): Pt | null {
    if (e.kind === 'device') {
      // A light's input pip: its card in the Devices view, its row otherwise.
      const r = store.mainView === 'devices'
        ? deviceAnchorRect(DeviceAnchorKeys.lightInput(e.placementId))
        : anchorRect(AnchorKeys.lightInput(e.placementId));
      return r ? { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } : null;
    }
    if (e.kind === 'port') {
      const r = anchorRect(AnchorKeys.port(e.trackId, e.portId));
      return r ? { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } : null;
    }
    const r = routeFieldRect(e);
    return r ? { x: r.left, y: (r.top + r.bottom) / 2 } : null;
  }

  /** Composition I/O routes (I/O mode). A route with only its PORT end on
   *  screen becomes a chip on that port instead (see syncChips). */
  private computeRoutes(chips: ChipDesc[]): WireDesc[] {
    if (!store.ioMode) return [];
    const out: WireDesc[] = [];
    for (const r of store.composition.routes ?? []) {
      const st = store.routeStatus[r.id] ?? { live: false, delayed: false };
      const a = this.routeEndPoint(r.src);
      const b = this.routeEndPoint(r.dest);
      if (a && b) {
        out.push({
          id: 'route:' + r.id, color: ROUTE, a, b, clipPath: '',
          label: `${routeEndLabel(r.src)} → ${routeEndLabel(r.dest)}`,
          target: {}, popup: false,
          route: { id: r.id, delayed: st.delayed, live: st.live },
        });
      } else if (a && r.src.kind === 'port') {
        chips.push({ id: r.id, at: a, text: `→ ${routeEndLabel(r.dest)}`, route: r, other: r.dest, live: st.live });
      } else if (b && r.dest.kind === 'port') {
        chips.push({ id: r.id, at: b, text: `← ${routeEndLabel(r.src)}`, route: r, other: r.src, live: st.live });
      }
    }
    return out;
  }

  /**
   * MIDI device wires (W mode), to the inspector field they drive:
   *   - Devices view: from the control in the devices panel (its W hit zone),
   *     for every wired device — while its card is scrolled into view;
   *   - Timeline view: from the control in the device's row (or the row's
   *     header while its bank isn't shown), for devices on the timeline.
   */
  private computeDeviceWires(out: WireDesc[]) {
    const devicesView = store.mainView === 'devices';
    const scroll = devicesView ? devicesScrollRect() : null;
    for (const [sketchId, sk] of Object.entries(compositionSketches(store.composition))) {
      for (const wire of sk.wires ?? []) {
        const deviceId = midiInstanceIdFromKey(wire.src.instanceKey);
        if (!deviceId || midiInstanceIdFromKey(wire.dest.instanceKey)) continue;  // aliases: no field end
        let a: Pt | null = null;
        if (devicesView) {
          const r = deviceAnchorRect(DeviceAnchorKeys.control(deviceId, wire.src.field));
          if (r && scroll && r.bottom > scroll.top && r.top < scroll.bottom) {
            a = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
          }
        } else if (store.placementForDevice(deviceId)) {
          const ctl = anchorRect(AnchorKeys.deviceControl(deviceId, wire.src.field));
          const row = ctl ? null : anchorRect(AnchorKeys.deviceRow(deviceId));
          a = ctl ? { x: (ctl.left + ctl.right) / 2, y: (ctl.top + ctl.bottom) / 2 }
            : row ? { x: row.right, y: (row.top + row.bottom) / 2 } : null;
        }
        if (!a) continue;
        const b = sketchFieldRect(sketchId, wire.dest.instanceKey, wire.dest.field);
        if (!b) continue;
        out.push({
          id: 'midi:' + wire.id, color: WRITER, a,
          b: { x: b.left, y: (b.top + b.bottom) / 2 },
          clipPath: '', label: `${wire.src.field} → ${sketchWireDestLabel(sketchId, wire)}`,
          target: {}, popup: false,
          midi: { sketchId, wireId: wire.id, deviceId },
        });
      }
    }
  }

  private computeWires(chips: ChipDesc[] = []): WireDesc[] {
    // The Devices view covers the timeline: only device wires (their field
    // ends are in the inspector, which stays).
    if (store.mainView === 'devices') {
      const out: WireDesc[] = [];
      if (store.wiresMode) this.computeDeviceWires(out);
      return out;
    }
    const routes = this.computeRoutes(chips);
    if (!store.wiresMode) return routes;
    const out: WireDesc[] = routes;
    this.computeDeviceWires(out);
    for (const track of store.composition.tracks) {
      if (track.kind !== 'rail' || !track.railId) continue;
      const railRect = anchorRect(AnchorKeys.rail(track.railId));
      if (!railRect) continue;
      const railMidY = (railRect.top + railRect.bottom) / 2;

      // Writers: clip/trace → rail.
      for (const w of store.railWriters(track.railId)) {
        const clipPath = `clip/${w.track.id}/${w.clip.id}`;
        const from =
          anchorRect(AnchorKeys.trace(w.clip.id)) ?? anchorRect(AnchorKeys.clip(w.clip.id));
        if (!from) continue;
        const fx = (from.left + from.right) / 2;
        const fmid = (from.top + from.bottom) / 2;
        const below = railMidY > fmid;
        const a: Pt = { x: fx, y: below ? from.bottom : from.top };
        const b: Pt = {
          x: clamp(fx, railRect.left + 4, railRect.right - 4),
          y: below ? railRect.top : railRect.bottom,
        };
        out.push({
          id: 'w:' + w.exp.id, color: WRITER, a, b, clipPath,
          label: `${w.clip.name} → ${track.name}`, target: { trace: true },
        });
      }

      // Readers: rail → field (when selected) or → clip.
      for (const r of store.railReaders(track.railId)) {
        const clipPath = `clip/${r.track.id}/${r.clip.id}`;
        const clipRect = anchorRect(AnchorKeys.clip(r.clip.id));
        if (!clipRect) continue;
        const cx = (clipRect.left + clipRect.right) / 2;
        const selected = store.isSelected(clipPath);
        const fieldRect = selected
          ? anchorRect(AnchorKeys.field(r.read.targetDeviceId, r.read.targetField))
          : null;
        const railBelowClip = railMidY > (clipRect.top + clipRect.bottom) / 2;
        const a: Pt = {
          x: clamp(cx, railRect.left + 4, railRect.right - 4),
          y: railBelowClip ? railRect.top : railRect.bottom,
        };
        const b: Pt = fieldRect
          ? { x: fieldRect.left, y: (fieldRect.top + fieldRect.bottom) / 2 }
          : { x: cx, y: railBelowClip ? clipRect.bottom : clipRect.top };
        out.push({
          id: 'r:' + r.read.id, color: READER, a, b, clipPath,
          label: `${track.name} → ${r.clip.name}.${r.read.targetField}`,
          target: { field: r.read.targetField },
        });
      }
    }

    // Beat-warp wires: warp clip → beat-warp track (if shown) else main bus.
    const warpDestKey = store.automationMode
      ? AnchorKeys.beatwarp()
      : AnchorKeys.mainbus();
    const warpDest = anchorRect(warpDestKey);
    if (warpDest) {
      const destMidY = (warpDest.top + warpDest.bottom) / 2;
      for (const ww of store.warpWriters()) {
        const clipPath = `clip/${ww.track.id}/${ww.clip.id}`;
        const from =
          anchorRect(AnchorKeys.trace(ww.clip.id)) ?? anchorRect(AnchorKeys.clip(ww.clip.id));
        if (!from) continue;
        const fx = (from.left + from.right) / 2;
        const below = destMidY > (from.top + from.bottom) / 2;
        out.push({
          id: 'warp:' + ww.clip.id,
          color: WARP,
          a: { x: fx, y: below ? from.bottom : from.top },
          b: {
            x: clamp(fx, warpDest.left + 4, warpDest.right - 4),
            y: below ? warpDest.top : warpDest.bottom,
          },
          clipPath,
          label: `${ww.clip.name} ⥲ beat warp`,
          target: {},
          popup: false,
        });
      }
    }
    return out;
  }

  private sync() {
    const svg = this.svg;
    if (!svg) return;
    const chips: ChipDesc[] = [];
    const wires = this.computeWires(chips);
    this.syncChips(chips);
    const present = new Set(wires.map((w) => w.id));

    // Remove stale.
    for (const [id, g] of this.els) {
      if (!present.has(id)) {
        g.hit.remove();
        g.arc.remove();
        g.pip.remove();
        this.els.delete(id);
      }
    }

    for (const w of wires) {
      let g = this.els.get(w.id);
      if (!g) {
        const hit = document.createElementNS(NS, 'path');
        hit.setAttribute('class', 'hit');
        const arc = document.createElementNS(NS, 'path');
        arc.setAttribute('class', 'arc');
        const pip = document.createElementNS(NS, 'circle');
        pip.setAttribute('class', 'pip');
        pip.setAttribute('r', '3.5');
        const routeId = w.route?.id;
        const midi = w.midi;
        const onClick = (e: PointerEvent) => {
          e.stopPropagation();
          if (routeId) { store.openRoutePopup(routeId, e.clientX + 8, e.clientY + 8); return; }
          if (midi) { devicesUi.selectCard(midi.deviceId); store.setMainView('devices'); return; }
          store.selectWire(w.id, w.clipPath, w.target);
        };
        // Double-click a modulation wire (export/read, not the warp link) to
        // delete it. Look up `w.popup` live — `w` is captured per-create only.
        const onDblClick = (e: Event) => {
          e.stopPropagation();
          if (routeId) { store.removeRoute(routeId); return; }
          if (midi) { store.removeSketchWire(midi.sketchId, midi.wireId); return; }
          if (w.popup === false) return;
          store.deleteWire(w.id);
        };
        hit.addEventListener('pointerdown', onClick);
        hit.addEventListener('dblclick', onDblClick);
        pip.addEventListener('dblclick', onDblClick);
        pip.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          if (routeId) { store.openRoutePopup(routeId, e.clientX + 8, e.clientY + 8); return; }
          if (midi) { devicesUi.selectCard(midi.deviceId); store.setMainView('devices'); return; }
          store.selectWire(w.id, w.clipPath, w.target);
          if (w.popup !== false) {
            store.openTapPopup({ wireId: w.id, x: e.clientX + 8, y: e.clientY + 8, label: w.label });
          }
        });
        svg.appendChild(hit);
        svg.appendChild(arc);
        svg.appendChild(pip);
        g = { hit, arc, pip };
        this.els.set(w.id, g);
      }
      const d = wirePath(w.a, w.b);
      g.hit.setAttribute('d', d);
      g.arc.setAttribute('d', d);
      g.arc.setAttribute('class', 'arc'
        + (w.route ? ' route' + (w.route.delayed ? ' delayed' : '') + (w.route.live ? '' : ' inert') : '')
        + (w.midi ? ' midi' : '')
        + ((w.route ? store.routePopup?.routeId === w.route.id : store.selectedWireId === w.id) ? ' sel' : ''));
      if (w.midi) {
        g.pip.innerHTML = '';
        const t = document.createElementNS(NS, 'title');
        t.textContent = w.label;
        g.pip.appendChild(t);
      }
      if (w.route) {
        g.pip.innerHTML = '';
        const t = document.createElementNS(NS, 'title');
        t.textContent = w.label + (w.route.delayed ? ' — one frame late (the source renders after its reader)' : '')
          + (w.route.live ? '' : ' — inert (its source isn’t rendering)');
        g.pip.appendChild(t);
      }
      g.arc.style.stroke = w.color;
      g.pip.setAttribute('cx', String((w.a.x + w.b.x) / 2));
      g.pip.setAttribute('cy', String((w.a.y + w.b.y) / 2));
      g.pip.style.fill = w.color;
    }
    this.syncConnectBand(svg);
  }

  // ── Port rubber band ──────────────────────────────────────────────────
  private band: SVGPathElement | null = null;

  /** The live line from a port pip to the cursor while a gesture that STARTED
   *  on a port is in flight (field-started gestures draw their own, in their
   *  column-group). */
  private syncConnectBand(svg: SVGSVGElement) {
    const c = portConnect.state;
    const port = c?.info.trackPort;
    const ctl = c?.info.deviceControl;
    const r = port ? anchorRect(AnchorKeys.port(port.trackId, port.portId))
      : ctl ? (store.mainView === 'devices'
          ? deviceAnchorRect(DeviceAnchorKeys.control(ctl.deviceInstanceId, ctl.controlId))
          : anchorRect(AnchorKeys.deviceControl(ctl.deviceInstanceId, ctl.controlId)))
      : null;
    if (!c || !r) { if (this.band) this.band.style.display = 'none'; return; }
    if (!this.band) {
      this.band = document.createElementNS(NS, 'path');
      this.band.setAttribute('class', 'connect');
      svg.appendChild(this.band);
    }
    const a = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    this.band.style.display = '';
    this.band.style.stroke = ctl ? WRITER : '';
    this.band.setAttribute('d', `M ${a.x} ${a.y} L ${c.pointerX} ${c.pointerY}`);
  }

  // ── Route chips (a route whose far end isn't on screen) ─────────────────
  private chipEls = new Map<string, HTMLDivElement>();

  private syncChips(chips: ChipDesc[]) {
    const host = this.renderRoot.querySelector('.chips') as HTMLElement | null;
    if (!host) return;
    const present = new Set<string>();
    // Several chips on one port stack downward.
    const perPort = new Map<string, number>();
    for (const c of chips) {
      present.add(c.id);
      let el = this.chipEls.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'chip';
        el.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          const other = (el as unknown as { __other?: RouteEnd }).__other;
          if (other?.kind === 'field') revealRouteField(other);
        });
        el.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          store.removeRoute(c.id);
        });
        host.appendChild(el);
        this.chipEls.set(c.id, el);
      }
      (el as unknown as { __other?: RouteEnd }).__other = c.other;
      const k = `${Math.round(c.at.x)}:${Math.round(c.at.y)}`;
      const n = perPort.get(k) ?? 0;
      perPort.set(k, n + 1);
      el.textContent = c.text;
      el.title = `${c.text}${c.other.kind === 'field' ? ' — click to show it' : ''} · double-click to disconnect`;
      el.classList.toggle('inert', !c.live);
      el.style.left = `${c.at.x + 8}px`;
      el.style.top = `${c.at.y + 8 + n * 16}px`;
    }
    for (const [id, el] of this.chipEls) {
      if (!present.has(id)) { el.remove(); this.chipEls.delete(id); }
    }
  }

  // ── Port popup ────────────────────────────────────────────────────────
  private renderPortPopup() {
    const pop = store.portPopup;
    if (!pop) return '';
    const t = store.trackById(pop.trackId);
    if (!t) return '';
    const named = t.ports?.find((p) => p.id === pop.portId);
    const dir = portDir(t, pop.portId);
    const end: RouteEnd = { kind: 'port', trackId: t.id, portId: pop.portId };
    const routes = store.routesAt(end);
    const x = Math.min(pop.x, window.innerWidth - 240);
    const y = Math.min(pop.y, window.innerHeight - 220);
    return html`
      <div class="tap-card port-card" style="left:${x}px; top:${y}px"
        @pointerdown=${(e: Event) => e.stopPropagation()}>
        <div class="tc-head">${store.trackDisplayName(t)} · ${dir === 'out' ? 'output' : 'input'}</div>
        ${named
          ? html`<input class="pname" .value=${named.name}
              @change=${(e: Event) => store.renameTrackPort(t.id, named.id, (e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}>`
          : html`<div class="tc-row">${portName(t, pop.portId)}</div>`}
        ${pop.portId === PORT_OUT
          ? html`<div class="tc-row">
              <span>Composite</span>
              <span>
                ${(['normal', 'none'] as const).map((m) => html`<button
                  class="tc-toggle ${store.trackOutputMode(t.id) === m ? 'on' : ''}"
                  title=${m === 'none' ? 'Send nowhere: keep rendering (routes still deliver) but never composite into the parent' : 'Composite into the parent as usual'}
                  @click=${() => store.setTrackOutputMode(t.id, m)}
                >${m === 'none' ? 'nowhere' : 'normal'}</button>`)}
              </span>
            </div>`
          : ''}
        ${routes.length === 0
          ? html`<div class="tc-row" style="color:var(--app-text-color2)">Not connected — drag from the port to a field or another port.</div>`
          : routes.map((r) => this.renderRouteRow(r, end))}
        <div class="acts">
          <button class="tc-toggle" title="Pick this port up, then click a field or port"
            @click=${() => this.connectFrom(t.id, pop.portId, dir)}>Connect…</button>
          ${named
            ? html`<button class="tc-toggle" @click=${() => { store.removeTrackPort(t.id, named.id); store.closePortPopup(); }}>Delete port</button>`
            : ''}
          <button class="tc-toggle" @click=${() => store.closePortPopup()}>Close</button>
        </div>
      </div>
    `;
  }

  private renderRouteRow(r: Route, here: RouteEnd) {
    const isSrc = r.src.kind === here.kind && JSON.stringify(r.src) === JSON.stringify(here);
    const other = isSrc ? r.dest : r.src;
    const st = store.routeStatus[r.id];
    return html`<div class="rt">
      <span>${isSrc ? '→' : '←'}</span>
      <span class="lbl" title="Show it"
        @click=${() => { if (other.kind === 'field') revealRouteField(other); }}>${routeEndLabel(other)}</span>
      ${st?.delayed ? html`<span class="flag" title="One frame late: its source renders after its reader">1f</span>` : ''}
      ${st && !st.live ? html`<span class="flag" title="Inert: its source isn't rendering">off</span>` : ''}
      <button class="x" title="Disconnect" @click=${() => store.removeRoute(r.id)}>✕</button>
    </div>`;
  }

  private connectFrom(trackId: string, portId: string, dir: 'in' | 'out') {
    beginPortClickConnect(trackId, portId, dir);
  }

  // ── Route popup (a clicked route wire) ──────────────────────────────────
  private renderRoutePopup() {
    const pop = store.routePopup;
    if (!pop) return '';
    const r = (store.composition.routes ?? []).find((x) => x.id === pop.routeId);
    if (!r) return '';
    const st = store.routeStatus[r.id];
    const x = Math.min(pop.x, window.innerWidth - 240);
    const y = Math.min(pop.y, window.innerHeight - 160);
    const end = (e: RouteEnd) => html`<span class="lbl"
      title=${e.kind === 'field' ? 'Show it' : ''}
      @click=${() => { if (e.kind === 'field') revealRouteField(e); }}>${routeEndLabel(e)}</span>`;
    return html`
      <div class="tap-card port-card route-card" style="left:${x}px; top:${y}px"
        @pointerdown=${(e: Event) => e.stopPropagation()}>
        <div class="tc-head">Route</div>
        <div class="rt"><span>from</span>${end(r.src)}</div>
        <div class="rt"><span>to</span>${end(r.dest)}</div>
        <div class="tc-row" style="color:var(--app-text-color2)">${
          !st ? 'Waiting for the engine…'
          : !st.live ? 'Inert — its source isn’t rendering.'
          : st.delayed ? 'Live, one frame late — its source renders after its reader.'
          : 'Live.'}</div>
        <div class="acts">
          <button class="tc-toggle" @click=${() => store.removeRoute(r.id)}>Disconnect</button>
          <button class="tc-toggle" @click=${() => store.closeRoutePopup()}>Close</button>
        </div>
      </div>
    `;
  }

  // ── Tap popup ─────────────────────────────────────────────────────────
  private renderPopup() {
    const pop = store.tapPopup;
    if (!pop) return '';
    const tap = store.tapByWireId(pop.wireId);
    if (!tap) return '';
    return html`
      <div
        class="tap-card"
        style="left:${pop.x}px; top:${pop.y}px"
        @pointerdown=${(e: Event) => e.stopPropagation()}
      >
        <div class="tc-head">${pop.label}</div>
        ${tapInspector(this.tapBinding(tap))}
      </div>
    `;
  }

  /** FieldBinding over a tap object (RailExport | RailRead) so the shared generic
   *  inspector can drive its combine / magnitude / scale / shaper toggles. Direct
   *  MobX mutation (matching the previous inline controls) — the monitor tracks these
   *  fields and recompiles the composite. */
  private tapBinding(tap: any): FieldBinding {
    return {
      instanceKey: `tap/${tap.id ?? ''}`,
      getValue: (path: string) => tap[path],
      setValue: (path: string, v: any) => { tap[path] = v; },
      beginContinuousEdit: (path: string, v: any): ContinuousEditHandle => {
        tap[path] = v;
        return {
          update: (nv: any) => { tap[path] = nv; },
          accept: () => {},
          cancel: () => {},
        };
      },
    };
  }
}
