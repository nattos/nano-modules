/**
 * <light-details> — the floating details panel for the light card selected in
 * the Devices view (the MIDI panel's twin, same place, same selection):
 *
 *   - TEMPLATE: make a type from it.
 *   - TYPE: its parameters, and "new rig" (N bars of it, addressed one after
 *     another, laid out as vertical strips).
 *   - RIG: its slots (type, universe, channel, destination, reverse; swap
 *     neighbours when bars went up in the wrong order; identify one), and —
 *     when the show includes it — the output switch, what it samples, the
 *     per-show LAYOUT editor and the test patterns.
 *   - NETWORK: the interface its bars are sent from, and its on-site patches
 *     (rebase unicast destinations onto a subnet, swap single destinations);
 *     Auto (built in) explains itself and offers "new network".
 *   - a MISSING rig (the show includes one this machine doesn't have).
 *
 * Changing one bar's network offers to put the rest of its rig on it too.
 *
 * Library edits go through lightController (persisted, per machine); show
 * edits through the store (undoable).
 */

import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { MobxLitElement } from '../../../../mobx-lit-element';
import {
  addressLabel, AUTO_NETWORK_ID, BUILTIN_NETWORKS, builtinNetwork, LIGHT_FORMATS, LOOPBACK_IFACE, lightTemplate, parseCidr, resolveNetworkDest, validDest,
  type LightFormat, type LightNetwork, type LightRig, type LightTemplate, type LightType,
} from '../../../../lights/light-types';
import { rigWarnings } from '../../../../lights/light-plan';
import { devicesUi } from '../../../devices/devices-ui';
import { devicesHost } from '../../../devices/devices-host';
import { engineBridge } from '../../engine/engine-bridge';
import { lightController, type LightPattern } from '../../state/light-controller';
import { store } from '../../state/store';
import { routeEndLabel } from '../arr-io';

import './light-layout-editor';
import './light-input-pip';

const PATTERNS: { id: LightPattern; label: string; title: string }[] = [
  { id: 'off', label: 'black', title: 'All pixels off' },
  { id: 'white', label: 'white', title: 'All pixels full white' },
  { id: 'colors', label: 'colours', title: 'Red, green, blue, white — a second each' },
  { id: 'chase', label: 'chase', title: 'A dot runs along every bar' },
  { id: 'bars', label: 'bars', title: 'One bar at a time, in rig order — where each hangs' },
  { id: 'numbers', label: 'numbers', title: 'Bar N lights its first N pixels — which bar is which' },
];

export const MISSING_PREFIX = 'missing-light:';

const LOOPBACK_NOTE = html`Everything stays on this machine: <b>broadcast</b> and every address go
  to 127.0.0.1 (a 127.x address is kept), on the same port.`;

@customElement('light-details')
export class LightDetails extends MobxLitElement {
  static styles = css`
    :host {
      position: fixed; right: 12px; bottom: 12px; z-index: 30;
      width: 340px; max-height: 70vh; overflow-y: auto;
      background: var(--app-bg-color2); border: 1px solid var(--app-tint-4); border-radius: 2px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace; font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
    }
    :host([data-empty]) { display: none; }
    .head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--app-tint-2); }
    .head .title { flex: 1; min-width: 0; }
    .head .kind { color: var(--app-text-color2); font-size: var(--app-fs-xs); text-transform: uppercase; letter-spacing: 0.08em; }
    .sec { padding: 8px 10px; border-bottom: 1px solid var(--app-tint-2); display: flex; flex-direction: column; gap: 6px; }
    .sec:last-child { border-bottom: none; }
    .sec h4 { margin: 0; font-weight: normal; font-size: var(--app-fs-xs); letter-spacing: 0.1em; text-transform: uppercase; color: var(--app-text-color2); }
    .row { display: flex; align-items: center; gap: 6px; }
    .row label { flex: 0 0 92px; color: var(--app-text-color2); }
    .note { color: var(--app-text-color2); font-size: var(--app-fs-xs); line-height: 1.4; }
    .warn { color: var(--app-hi-color1, #e0a040); font-size: var(--app-fs-xs); }
    input, select {
      font: inherit; color: var(--app-text-color1); background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-3); border-radius: 1px; padding: 1px 4px; min-width: 0;
    }
    input:focus, select:focus { outline: none; border-color: var(--app-hi-color2); }
    input[type='number'] { width: 56px; }
    input.name { flex: 1; }
    input.dest { width: 104px; }
    input.bad { border-color: var(--app-error, #e06c6c); }
    button {
      font: inherit; font-size: var(--app-fs-xs); color: var(--app-text-color2); background: none;
      border: 1px solid var(--app-tint-4); border-radius: 1px; padding: 1px 6px; cursor: pointer;
    }
    button:hover:not(:disabled) { border-color: var(--app-hi-color2); color: var(--app-hi-color2); }
    button:disabled { opacity: 0.4; cursor: default; }
    button.on { border-color: var(--app-hi-color2); color: var(--app-hi-color2); background: rgba(65, 105, 225, 0.12); }
    button.primary { color: var(--app-text-color1); border-color: var(--app-hi-color2); }
    .btns { display: flex; flex-wrap: wrap; gap: 4px; }
    .slot { display: flex; flex-direction: column; gap: 3px;
      padding: 4px; border: 1px solid transparent; border-radius: 1px; }
    .slot.sel { border-color: var(--app-hi-color2); }
    .slot .line { display: flex; align-items: center; gap: 4px; }
    .slot .n { flex: 0 0 14px; color: var(--app-text-color2); text-align: right; }
    .slot .line select { flex: 1; min-width: 0; }
    .slot .k { color: var(--app-text-color2); font-size: var(--app-fs-xs); }
    .slot .line input.dest { flex: 1; width: auto; }
    .swap { align-self: center; margin: -2px 0 -2px 18px; font-size: 10px; padding: 0 5px; }
    .spacer { flex: 1; }
    .offer { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0 0 4px 18px;
      padding: 4px 6px; border: 1px solid var(--app-hi-color2); border-radius: 1px;
      font-size: var(--app-fs-xs); color: var(--app-text-color1); background: rgba(65, 105, 225, 0.08); }
    .offer span { flex: 1 1 140px; }
  `;

  /** The slot picked in the layout editor / slot list. */
  @state() private slotSel = '';
  /** After one bar's network changed: offer the rest of its rig the same. */
  @state() private netOffer: { rigId: string; slotId: string; networkId: string } | null = null;
  /** New-rig form (per type card). */
  @state() private rigForm = { count: 4, universe: 0, channel: 1, dest: 'broadcast' };

  render() {
    const content = this.renderContent();
    this.toggleAttribute('data-empty', content === nothing);
    if (content !== nothing) {
      const { right, bottom } = devicesHost().detailsInset();
      this.style.right = `${right}px`;
      this.style.bottom = `${bottom}px`;
      this.style.maxHeight = `calc(100vh - ${bottom + 60}px)`;
    }
    return content;
  }

  private renderContent() {
    const id = devicesUi.selectedCardId;
    if (!id) return nothing;
    if (id.startsWith(MISSING_PREFIX)) return this.renderMissing(id.slice(MISSING_PREFIX.length));
    const tpl = lightTemplate(id);
    if (tpl) return this.renderTemplate(tpl);
    const builtin = builtinNetwork(id);
    if (builtin) return this.renderNetwork(builtin);
    const row = lightController.row(id);
    if (!row) return nothing;
    if (row.kind === 'network') return this.renderNetwork(row);
    return row.kind === 'type' ? this.renderType(row) : this.renderRig(row);
  }

  // ── Network ─────────────────────────────────────────────────────────────

  private renderNetwork(n: LightNetwork) {
    const users = lightController.networkUsers(n.id);
    const byRig = new Map<string, { name: string; bars: number[] }>();
    for (const u of users) {
      const e = byRig.get(u.rig.id) ?? { name: u.rig.name, bars: [] };
      e.bars.push(u.index + 1);
      byRig.set(u.rig.id, e);
    }
    const usedBy = users.length ? html`<div class="note">Sends ${users.length} bar${users.length === 1 ? '' : 's'}:
      ${[...byRig.values()].map((e, i) => html`${i ? ', ' : ''}${e.name} (${e.bars.join(', ')})`)}</div>`
      : html`<div class="note">No bars use it yet — pick it on a rig's bars ("via").</div>`;
    if (n.id === AUTO_NETWORK_ID) {
      return html`
        <div class="head"><span class="title">Auto</span><span class="kind">network</span></div>
        <div class="sec">
          <div class="note">The system picks the interface, and <b>broadcast</b> goes to
            255.255.255.255. A network of your own chooses the interface (broadcast then goes to
            that interface's subnet) and can patch destinations on site without touching the rigs.</div>
          ${usedBy}
          <div class="btns"><button class="primary" data-light-action="new-network" @click=${() =>
            devicesUi.selectCard(lightController.newNetwork().id)}>new network</button></div>
        </div>`;
    }
    if (builtinNetwork(n.id)) {
      return html`
        <div class="head"><span class="title">${n.name}</span><span class="kind">network</span></div>
        <div class="sec">
          <div class="note">${LOOPBACK_NOTE} Nothing reaches the LAN — for a visualiser on this
            machine, or this app's own Art-Net input.</div>
          ${usedBy}
          <div class="btns"><button data-light-action="duplicate-network"
            title="A loopback network of your own, to send some destinations to other ports"
            @click=${() => devicesUi.selectCard(lightController.newNetwork(n.id).id)}>duplicate</button></div>
        </div>`;
    }
    const ifs = lightController.netIfaces;
    const loopback = n.iface === LOOPBACK_IFACE;
    const cur = ifs?.find((i) => i.name === n.iface);
    const rebaseOk = !n.rebase || !!parseCidr(n.rebase);
    const overrides = n.overrides ?? [];
    const setOverride = (i: number, k: 'from' | 'to', v: string) => lightController.editNetwork(n.id, {
      overrides: overrides.map((o, j) => (j === i ? { ...o, [k]: v } : o)),
    });
    return html`
      <div class="head">
        <input class="name" .value=${n.name} @change=${(e: Event) =>
          lightController.editNetwork(n.id, { name: (e.target as HTMLInputElement).value })}>
        <span class="kind">network</span>
      </div>
      <div class="sec">
        <div class="row"><label>interface</label>
          ${ifs ? html`<select data-light-field="iface" @change=${(e: Event) =>
              lightController.editNetwork(n.id, { iface: (e.target as HTMLSelectElement).value })}>
              <option value="" ?selected=${!n.iface}>auto — the system picks</option>
              <option value=${LOOPBACK_IFACE} ?selected=${loopback}>loopback — this machine only</option>
              ${ifs.filter((i) => !i.loopback || i.name === n.iface).map((i) => html`<option value=${i.name}
                ?selected=${i.name === n.iface}>${i.name} · ${i.address}${i.up ? '' : ' (down)'}</option>`)}
              ${n.iface && !cur && !loopback ? html`<option value=${n.iface} selected>${n.iface} — not on this machine</option>` : nothing}
            </select>`
          : html`<input data-light-field="iface" placeholder="auto" .value=${n.iface}
              title="An interface name, e.g. en0 — blank lets the system pick, ${LOOPBACK_IFACE} keeps it on this machine"
              @change=${(e: Event) => lightController.editNetwork(n.id, { iface: (e.target as HTMLInputElement).value })}>`}
        </div>
        ${!n.iface ? html`<div class="note">No interface chosen: the system picks, as Auto does.</div>`
          : loopback ? html`<div class="note">${LOOPBACK_NOTE}</div>`
          : !ifs ? html`<div class="note">The interface list comes from the native compositor.</div>`
          : !cur ? html`<div class="warn">${n.iface} isn't on this machine — its bars send nothing.</div>`
          : !cur.up ? html`<div class="warn">${n.iface} is down — its bars send nothing.</div>`
          : html`<div class="note">${cur.address}${cur.broadcast ? html` · broadcast goes to ${cur.broadcast}`
              : ' · it has no broadcast address: give its bars IPs'}</div>`}
      </div>
      <div class="sec">
        <h4>Patches — on-site fixes; the rigs stay as they are</h4>
        <div class="row"><label>rebase to</label>
          <input class="dest ${rebaseOk ? '' : 'bad'}" data-light-field="rebase" placeholder="e.g. 10.0.5.0/24"
            .value=${n.rebase ?? ''} title="Move every unicast destination onto this subnet, keeping its host part"
            @change=${(e: Event) => lightController.editNetwork(n.id, { rebase: (e.target as HTMLInputElement).value })}>
        </div>
        ${n.rebase && rebaseOk ? html`<div class="note">e.g. 192.168.1.40 → ${resolveNetworkDest('192.168.1.40', { ...n, overrides: [] })}</div>` : nothing}
        ${overrides.map((o, i) => html`<div class="row" data-light-override=${i}>
          <input class="dest ${validDest(o.from) || !o.from ? '' : 'bad'}" placeholder="from" .value=${o.from}
            title="A destination as the rigs say it: broadcast, an IP (any port), or ip:port"
            @change=${(e: Event) => setOverride(i, 'from', (e.target as HTMLInputElement).value)}>
          <span class="k">→</span>
          <input class="dest ${validDest(o.to) || !o.to ? '' : 'bad'}" placeholder="to" .value=${o.to}
            @change=${(e: Event) => setOverride(i, 'to', (e.target as HTMLInputElement).value)}>
          <button title="Remove this override" @click=${() => lightController.editNetwork(n.id,
            { overrides: overrides.filter((_, j) => j !== i) })}>✕</button>
        </div>`)}
        <div class="btns"><button data-light-action="add-override" title="Send one destination somewhere else"
          @click=${() => lightController.editNetwork(n.id, { overrides: [...overrides, { from: '', to: '' }] })}>+ override</button></div>
      </div>
      <div class="sec">${usedBy}</div>
      <div class="sec"><div class="btns">
        <button @click=${() => devicesUi.selectCard(lightController.newNetwork(n.id).id)}>duplicate</button>
        <span class="spacer"></span>
        <button @click=${() => lightController.setDeleted(n.id, !n.deleted)}>${n.deleted ? 'restore' : 'delete'}</button>
      </div></div>`;
  }

  // ── Template / type ─────────────────────────────────────────────────────

  private renderTemplate(t: LightTemplate) {
    return html`
      <div class="head"><span class="title">${t.name}</span><span class="kind">template</span></div>
      <div class="sec">
        <div class="note">A bar of addressable pixels. Make a TYPE from it for your hardware —
          how many pixels, how many LEDs each lights, the colour order — then a rig of those.</div>
        <div class="btns"><button class="primary" data-light-action="new-type" @click=${() => {
          const row = lightController.newType(t.templateId);
          if (row) devicesUi.selectCard(row.id);
        }}>new type</button></div>
      </div>`;
  }

  private renderType(t: LightType) {
    const num = (v: string, f: (n: number) => void) => { const n = Number(v); if (Number.isFinite(n)) f(n); };
    const f = this.rigForm;
    const destOk = validDest(f.dest);
    return html`
      <div class="head">
        <input class="name" .value=${t.name} @change=${(e: Event) =>
          lightController.editType(t.id, { name: (e.target as HTMLInputElement).value.trim() || t.name })}>
        <span class="kind">type</span>
      </div>
      <div class="sec">
        <div class="row"><label>pixels</label>
          <input type="number" min="1" max="512" data-light-field="pixels" .value=${String(t.pixels)}
            @change=${(e: Event) => num((e.target as HTMLInputElement).value, (n) => lightController.editType(t.id, { pixels: n }))}>
          <span class="note">addressable</span></div>
        <div class="row"><label>LEDs / pixel</label>
          <input type="number" min="1" max="64" .value=${String(t.ledsPerPixel)}
            @change=${(e: Event) => num((e.target as HTMLInputElement).value, (n) => lightController.editType(t.id, { ledsPerPixel: n }))}>
          <span class="note">a 24 V segment lights several</span></div>
        <div class="row"><label>hung</label>
          ${([['vertical', true], ['horizontal', false]] as const).map(([label, v]) => html`<button
            class=${(t.vertical !== false) === v ? 'on' : ''} data-light-orient=${label}
            title=${v ? 'Pixels run top → bottom; a new rig spreads its bars across the frame'
                      : 'Pixels run left → right; a new rig stacks its bars down the frame'}
            @click=${() => lightController.editType(t.id, { vertical: v })}>${label}</button>`)}</div>
        <div class="row"><label>colour order</label>
          <select @change=${(e: Event) => lightController.editType(t.id, { format: (e.target as HTMLSelectElement).value as LightFormat })}>
            ${LIGHT_FORMATS.map((x) => html`<option value=${x.id} ?selected=${x.id === t.format}>${x.label}</option>`)}
          </select></div>
        <div class="row"><label>gamma</label>
          <input type="number" min="0.1" max="5" step="0.1" .value=${String(t.gamma)}
            @change=${(e: Event) => num((e.target as HTMLInputElement).value, (n) => lightController.editType(t.id, { gamma: n }))}></div>
      </div>
      <div class="sec">
        <h4>New rig of these</h4>
        <div class="row"><label>bars</label>
          <input type="number" min="1" max="64" data-light-field="count" .value=${String(f.count)}
            @change=${(e: Event) => { this.rigForm = { ...f, count: Number((e.target as HTMLInputElement).value) || 1 }; }}></div>
        <div class="row"><label>universe</label>
          <input type="number" min="0" max="32767" .value=${String(f.universe)}
            @change=${(e: Event) => { this.rigForm = { ...f, universe: Number((e.target as HTMLInputElement).value) || 0 }; }}>
          <label style="flex:0 0 auto">from ch</label>
          <input type="number" min="1" max="512" .value=${String(f.channel)}
            @change=${(e: Event) => { this.rigForm = { ...f, channel: Number((e.target as HTMLInputElement).value) || 1 }; }}></div>
        <div class="row"><label>send to</label>
          <input class="dest ${destOk ? '' : 'bad'}" .value=${f.dest} title="broadcast, a node's IP, or ip:port"
            @change=${(e: Event) => { this.rigForm = { ...f, dest: (e.target as HTMLInputElement).value.trim() || 'broadcast' }; }}></div>
        <div class="btns"><button class="primary" data-light-action="new-rig" ?disabled=${!destOk} @click=${() => {
          const rig = lightController.newRig({
            typeId: t.id, count: f.count, start: { universe: f.universe, channel: f.channel, dest: f.dest },
          });
          if (rig) devicesUi.selectCard(rig.id);
        }}>create rig</button></div>
      </div>
      <div class="sec"><div class="btns">
        <button @click=${() => { const c = lightController.newType(t.id); if (c) devicesUi.selectCard(c.id); }}>duplicate</button>
        <span class="spacer"></span>
        <button @click=${() => { lightController.setDeleted(t.id, !t.deleted); }}>${t.deleted ? 'restore' : 'delete'}</button>
      </div></div>`;
  }

  // ── Rig ─────────────────────────────────────────────────────────────────

  private renderRig(rig: LightRig) {
    const placement = store.lightPlacements.find((p) => p.deviceId === rig.id);
    const warnings = rigWarnings(rig, lightController.library);
    return html`
      <div class="head">
        <input class="name" .value=${rig.name} @change=${(e: Event) =>
          lightController.renameRig(rig.id, (e.target as HTMLInputElement).value)}>
        <span class="kind">rig</span>
      </div>
      ${placement ? this.renderShowSection(rig, placement.id, placement.enabled !== false) : html`
        <div class="sec"><div class="note">Not in this show — "in show" on its card adds it (it then
          samples the main output, and you can lay it out and test it).</div></div>`}
      <div class="sec">
        <h4>Slots — what each bar is and where it listens</h4>
        ${rig.slots.map((s, i) => html`
          ${i > 0 ? html`<button class="swap" data-light-swap=${i - 1}
            title="Swap bars ${i} and ${i + 1}: exchange their addresses (for bars hung in each other's places)"
            @click=${() => lightController.swapSlots(rig.id, rig.slots[i - 1].id, s.id)}>⇅ swap ${i} ↔ ${i + 1}</button>` : nothing}
          ${this.renderSlot(rig, s.id, i, placement?.id)}`)}
        <div class="btns"><button @click=${() => lightController.addSlot(rig.id)}>+ slot</button></div>
        ${warnings.map((w) => html`<div class="warn">${w.message}</div>`)}
      </div>
      <div class="sec"><div class="btns">
        <span class="spacer"></span>
        <button @click=${() => lightController.setDeleted(rig.id, !rig.deleted)}>${rig.deleted ? 'restore' : 'delete rig'}</button>
      </div></div>`;
  }

  private renderShowSection(rig: LightRig, pid: string, enabled: boolean) {
    const route = store.lightInputRoute(pid);
    const testing = lightController.testing[pid];
    const transmits = engineBridge.outputsLights;
    const status = lightController.status;
    return html`
      <div class="sec">
        <div class="row"><label>output</label>
          <button class=${enabled ? 'on' : ''} data-light-action="enable"
            @click=${() => store.setLightEnabled(pid, !enabled)}>${enabled ? 'on' : 'off'}</button>
          <span class="note">${!transmits ? 'this engine doesn\'t transmit'
            : status?.error ? status.error
            : enabled ? `${status?.pps ?? 0} packets/s` : 'not sending'}</span></div>
        <div class="row"><label>samples</label>
          <light-input-pip .placementId=${pid} .scope=${'devices'}></light-input-pip>
          ${route ? html`<button title="Sample the main output again"
            @click=${() => store.removeRoute(route.id)}>main</button>` : nothing}</div>
        ${!transmits ? html`<div class="note">Light output needs the native compositor (the desktop
          app). This engine still shows what the light would send.</div>` : nothing}
        ${route ? html`<div class="note">Routed from ${routeEndLabel(route.src)}.</div>` : nothing}
      </div>
      <div class="sec">
        <h4>Layout in this show</h4>
        <light-layout-editor .placementId=${pid} .selectedSlot=${this.slotSel}
          @select=${(e: CustomEvent<string>) => { this.slotSel = e.detail; }}></light-layout-editor>
        ${this.renderSelectedRect(rig, pid)}
        <div class="btns"><button data-light-action="reset-layout" @click=${() => store.resetLightLayout(pid)}>reset to rig layout</button></div>
      </div>
      <div class="sec">
        <h4>Test${transmits ? '' : ' — needs the native compositor'}</h4>
        <div class="btns">
          ${PATTERNS.map((p) => html`<button class=${testing?.pattern === p.id && !testing.slotId ? 'on' : ''}
            data-light-test=${p.id} title=${p.title} ?disabled=${!transmits}
            @click=${() => lightController.test(pid, null,
              testing?.pattern === p.id && !testing.slotId ? null : p.id)}>${p.label}</button>`)}
          ${testing ? html`<button class="primary" @click=${() => lightController.test(pid, null, null)}>stop</button>` : nothing}
        </div>
      </div>`;
  }

  /** The selected slot's rect in this show, as numbers (percent of the frame). */
  private renderSelectedRect(rig: LightRig, pid: string) {
    const slot = rig.slots.find((s) => s.id === this.slotSel);
    if (!slot) return html`<div class="note">Drag a strip to move it, its corner to resize it.</div>`;
    const p = store.placementById(pid);
    const r = p?.layout?.[slot.id] ?? slot.layout;
    const pct = (v: number) => (Math.round(v * 1000) / 10).toString();
    const set = (k: 'x' | 'y' | 'w' | 'h') => (e: Event) => {
      const n = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(n)) store.setLightLayout(pid, slot.id, { ...r, [k]: n / 100 });
    };
    return html`<div class="row">
      <label>bar ${rig.slots.indexOf(slot) + 1} %</label>
      ${(['x', 'y', 'w', 'h'] as const).map((k) => html`<input type="number" step="0.1"
        title=${k} .value=${pct(r[k])} @change=${set(k)}>`)}
      ${p?.layout?.[slot.id] ? html`<button title="Back to the rig's layout"
        @click=${() => store.resetLightLayout(pid, slot.id)}>↺</button>` : nothing}
    </div>`;
  }

  private renderSlot(rig: LightRig, slotId: string, i: number, pid: string | undefined) {
    const s = rig.slots.find((x) => x.id === slotId)!;
    const types = lightController.types;
    const destOk = validDest(s.address.dest);
    const num = (v: string) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const netId = s.address.network ?? AUTO_NETWORK_ID;
    const identifying = pid && lightController.testing[pid]?.pattern === 'identify'
      && lightController.testing[pid]?.slotId === s.id;
    return html`<div class="slot ${this.slotSel === s.id ? 'sel' : ''}" data-light-slot=${i}
        title=${addressLabel(s.address)} @click=${() => { this.slotSel = s.id; }}>
      <div class="line">
        <span class="n">${i + 1}</span>
        <select title="Type" @change=${(e: Event) =>
          lightController.editSlot(rig.id, s.id, { typeId: (e.target as HTMLSelectElement).value })}>
          ${types.map((t) => html`<option value=${t.id} ?selected=${t.id === s.typeId}>${t.name}</option>`)}
          ${types.some((t) => t.id === s.typeId) ? nothing : html`<option selected disabled>missing type</option>`}
        </select>
        <button class=${s.reverse ? 'on' : ''} title="Reversed: pixel 0 at the other end"
          @click=${(e: Event) => { e.stopPropagation(); lightController.editSlot(rig.id, s.id, { reverse: !s.reverse }); }}>⇵</button>
        ${pid ? html`<button class=${identifying ? 'on' : ''} data-light-identify=${i} ?disabled=${!engineBridge.outputsLights}
          title="Identify: this bar walks a dot (pixel 0 red); the others go dark"
          @click=${(e: Event) => { e.stopPropagation(); lightController.test(pid, s.id, identifying ? null : 'identify'); }}>id</button>` : nothing}
        <button title="Remove this slot" ?disabled=${rig.slots.length <= 1}
          @click=${(e: Event) => { e.stopPropagation(); lightController.removeSlot(rig.id, s.id); }}>✕</button>
      </div>
      <div class="line">
        <span class="n"></span>
        <span class="k">u</span>
        <input type="number" title="Universe (Art-Net port address, 0-based)" min="0" max="32767" .value=${String(s.address.universe)}
          @change=${(e: Event) => { const n = num((e.target as HTMLInputElement).value); if (n !== null) lightController.editSlot(rig.id, s.id, { address: { universe: n } }); }}>
        <span class="k">ch</span>
        <input type="number" title="Start channel" data-light-field="channel" min="1" max="512" .value=${String(s.address.channel)}
          @change=${(e: Event) => { const n = num((e.target as HTMLInputElement).value); if (n !== null) lightController.editSlot(rig.id, s.id, { address: { channel: n } }); }}>
        <span class="k">→</span>
        <input class="dest ${destOk ? '' : 'bad'}" title="broadcast, a node's IP, or ip:port" .value=${s.address.dest}
          @change=${(e: Event) => lightController.editSlot(rig.id, s.id, { address: { dest: (e.target as HTMLInputElement).value } })}>
      </div>
      <div class="line">
        <span class="n"></span>
        <span class="k">via</span>
        <select data-light-net=${i} title="The network it's sent on" @click=${(e: Event) => e.stopPropagation()}
          @change=${(e: Event) => this.onSlotNetwork(rig, s.id, (e.target as HTMLSelectElement).value)}>
          ${BUILTIN_NETWORKS.map((n) => html`<option value=${n.id} ?selected=${n.id === netId}>${n.name}</option>`)}
          ${lightController.networks.map((n) => html`<option value=${n.id} ?selected=${n.id === netId}>${n.name}</option>`)}
          ${lightController.network(netId) ? nothing : html`<option selected disabled>missing network</option>`}
        </select>
      </div>
    </div>
    ${this.renderNetOffer(rig, s.id)}`;
  }

  private onSlotNetwork(rig: LightRig, slotId: string, networkId: string) {
    lightController.editSlot(rig.id, slotId, { address: { network: networkId } });
    const others = rig.slots.filter((x) => x.id !== slotId && (x.address.network ?? AUTO_NETWORK_ID) !== networkId);
    this.netOffer = others.length ? { rigId: rig.id, slotId, networkId } : null;
  }

  /** "Put the other N bars on it too?" under the bar just changed. */
  private renderNetOffer(rig: LightRig, slotId: string) {
    const o = this.netOffer;
    if (!o || o.rigId !== rig.id || o.slotId !== slotId) return nothing;
    const others = rig.slots.filter((x) => x.id !== slotId && (x.address.network ?? AUTO_NETWORK_ID) !== o.networkId);
    if (!others.length) return nothing;
    const name = lightController.network(o.networkId)?.name ?? 'it';
    return html`<div class="offer">
      <span>Put the other ${others.length} bar${others.length === 1 ? '' : 's'} on ${name} too?</span>
      <button class="primary" data-light-action="net-all" @click=${() => {
        lightController.setRigNetwork(rig.id, o.networkId);
        this.netOffer = null;
      }}>switch all</button>
      <button @click=${() => { this.netOffer = null; }}>no</button>
    </div>`;
  }

  // ── Missing ─────────────────────────────────────────────────────────────

  private renderMissing(placementId: string) {
    const p = store.placementById(placementId);
    if (!p) return nothing;
    return html`
      <div class="head"><span class="title">${p.label ?? 'Light'}</span><span class="kind">missing</span></div>
      <div class="sec">
        <div class="note">This show includes a light rig this machine's library doesn't have, so
          nothing is sent for it. Make a rig with the same bars here, or take it out of the show.</div>
        <div class="btns"><button @click=${() => { store.removeDevicePlacement(placementId); devicesUi.clearSelection(); }}>
          remove from show</button></div>
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'light-details': LightDetails }
}
