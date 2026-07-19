/**
 * <device-wires-panel> — every wire a device (or a subset of its controls)
 * drives, across ALL instances of the composition. Embedded at the bottom of
 * the Devices tab's floating details panel: a selected CONTROL scopes it to
 * that control's endpoints; a selected DEVICE CARD shows the device's whole
 * fan-out.
 *
 * Wires are grouped per instance — the currently-edited instance first, the
 * rest in Instances-tab order — and each row carries the SAME mod inspector
 * as the editor's wire popup (shared widgets/wire-mod-inspector.ts), plus a
 * locate button that opens the right instance, scrolls its editor to the dest
 * field, and flashes it.
 */

import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { midiController } from '../../state/midi-controller';
import { instanceDisplayLabel } from '../../state/instance-labels';
import { getDeviceTemplate } from '../../midi/device-registry';
import { DASHBOARD_MODULE_TYPE, type Wire } from '../../sketch-types';
import { wireModBinding, renderWireModInspector } from '../../widgets/wire-mod-inspector';
import { scrollToAndFlashField } from '../../widgets/field-anchor-lookup';
import { midiInstanceKey } from '../../midi/midi-types';
import { collectDeadMidiWires, collectDeviceWires, type DeviceWireRow } from './device-wires-model';
import '../../widgets/ui-icon';

@customElement('device-wires-panel')
export class DeviceWiresPanel extends MobxLitElement {
  /** Device library instance uuid (templates can't own wires — lazy-fork). */
  @property() deviceId = '';
  /** Physical control ids to scope to ('b0/e05'), or null = whole device. */
  @property({ attribute: false }) controlIds: string[] | null = null;

  static styles = css`
    :host {
      display: block;
      overflow-y: auto;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
    }
    .group-head {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin: 8px 0 2px;
      font-size: var(--app-fs-xs);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--app-text-color2);
    }
    .group-head:first-child { margin-top: 2px; }
    .group-head .current {
      color: var(--app-hi-color2);
      letter-spacing: 0;
      text-transform: none;
    }
    .wire-row {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 20px;
    }
    .wire-row .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .wire-row .gesture { color: var(--app-text-color2); }
    .wire-row button {
      flex: none;
      display: inline-flex;
      align-items: center;
      background: none;
      border: none;
      color: var(--app-text-color2);
      cursor: pointer;
      font-size: 13px;
      padding: 0 2px;
      line-height: 1;
    }
    .wire-row button:hover { color: var(--app-text-color1); }
    .empty {
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs);
      padding: 4px 0 2px;
    }
    .remap-banner {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 4px 0 6px;
      padding: 4px 6px;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color1);
      background: color-mix(in srgb, var(--app-hi-color1) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--app-hi-color1) 40%, transparent);
      border-radius: 2px;
    }
    .remap-banner .msg { flex: 1; min-width: 0; }
    .remap-banner button {
      flex: none;
      background: var(--app-hi-color1);
      color: #0a0a0a;
      border: none;
      border-radius: 2px;
      padding: 2px 8px;
      font-size: var(--app-fs-xs);
      cursor: pointer;
    }
    .remap-banner button:hover { filter: brightness(1.15); }
  `;

  /**
   * The composition scan set: the edited instance first (its wires lead the
   * list), then every instance the Instances tab shows — pg:* sketches in
   * Playground, cached/connected barrel UUIDs in Live.
   */
  private scanIds(): string[] {
    const editing = appState.local.editingSketchId;
    return [
      ...(editing ? [editing] : []),
      ...appState.local.barrelInstances.map(i => i.key),
    ];
  }

  /** 'Knob 3 · turn' — the device-side label of one wire's source endpoint. */
  private controlLabel(row: DeviceWireRow): string {
    const instance = midiController.instance(this.deviceId);
    const template = getDeviceTemplate(instance?.templateId ?? this.deviceId);
    const def = template?.layout.controls.find(c => c.id === row.controlId);
    return def?.label || row.controlId;
  }

  /** 'dashboard.Speed' — the dest module + field, honoring a dashboard
   *  knob's user rename (state.label_i) and the schema display name. */
  private destLabel(sketchId: string, row: DeviceWireRow): string {
    const moduleType = row.dest.module_type;
    const moduleName = moduleType.split('.').pop() ?? moduleType;
    const field = row.wire.dest.field;
    if (moduleType === DASHBOARD_MODULE_TYPE && field.startsWith('knob_')) {
      const st = appState.database.sketches[sketchId]?.instances?.[row.dest.instance_key]?.state as
          Record<string, any> | undefined;
      const label = st?.[`label_${field.slice('knob_'.length)}`];
      if (typeof label === 'string' && label.trim() !== '') return `${moduleName}.${label}`;
    }
    const schemaDef = appState.local.plugins.find(p => p.id === moduleType)?.schema?.[field];
    const fieldName = typeof schemaDef?.name === 'string' && schemaDef.name ? schemaDef.name : field;
    return `${moduleName}.${fieldName}`;
  }

  /** Open the dest instance (if not already being edited), select the dest
   *  field (surfaces its floating card), scroll to it and flash it. */
  private locate(sketchId: string, row: DeviceWireRow) {
    if (appState.local.editingSketchId !== sketchId) {
      appController.selectBarrelInstance(sketchId);
    }
    const key = `${sketchId}/0/${row.chainIdx}/${row.wire.dest.field}`;
    appController.selectField(key);   // queues until the editor renders it
    scrollToAndFlashField(key);
  }

  private wireOps(sketchId: string, wireId: string) {
    return {
      getWire: (): Wire | undefined =>
        appState.database.sketches[sketchId]?.wires?.find(w => w.id === wireId),
      updateWire: (patch: Partial<Wire>) => appController.updateWire(sketchId, wireId, patch),
      beginUpdateWire: (patch: Partial<Wire>) => appController.beginUpdateWire(sketchId, wireId, patch),
      updateUpdateWire: (edit: any, patch: Partial<Wire>) =>
        appController.updateUpdateWire(edit, sketchId, wireId, patch),
    };
  }

  /** Result line from the last remap ('Remapped 47 wires across 12 sketches'). */
  @state() private remapResult = '';
  @state() private remapBusy = false;

  private async doRemap() {
    const known = new Set(appState.local.midi.library.map(i => i.id));
    this.remapBusy = true;
    try {
      const res = await appController.remapDeadMidiWires(
        known, midiInstanceKey(this.deviceId));
      this.remapResult = `Remapped ${res.wires} wire${res.wires === 1 ? '' : 's'}`
        + ` across ${res.sketches} sketch${res.sketches === 1 ? '' : 'es'}.`;
    } finally {
      this.remapBusy = false;
    }
  }

  /**
   * Dead-mapping repair: wires sourced from a `midi:<uuid>` that matches NO
   * library device (the instance was re-created under a fresh id — new
   * browser profile, cleared storage — stranding every serialized mapping).
   * Offered on the whole-device view only. The remap covers the WHOLE
   * composition: loaded sketches in one undo step, plus (Live mode) every
   * other live barrel instance patched over the bridge — so the local count
   * shown here is a floor, not the total.
   */
  private renderRemapBanner() {
    if (this.controlIds) return nothing;   // whole-device card view only
    const known = new Set(appState.local.midi.library.map(i => i.id));
    const dead = collectDeadMidiWires(
      appState.database.sketches, this.scanIds(), known);
    if (dead.total === 0) {
      return this.remapResult
        ? html`<div class="empty remap-result">${this.remapResult}</div>` : nothing;
    }
    const name = midiController.instance(this.deviceId)?.name ?? 'this device';
    return html`
      <div class="remap-banner">
        <span class="msg">
          ${dead.total} wire${dead.total === 1 ? '' : 's'} point${dead.total === 1 ? 's' : ''}
          at a missing device (${[...dead.deadIds].map(id => id.slice(0, 8)).join(', ')}…)
        </span>
        <button ?disabled=${this.remapBusy}
          title="Re-point every dead midi: wire in the composition at ${name}, keeping fields and mod settings"
          @click=${() => this.doRemap()}>
          ${this.remapBusy ? 'Remapping…' : `Remap all to ${name}`}
        </button>
      </div>
    `;
  }

  render() {
    if (!this.deviceId) return nothing;
    const groups = collectDeviceWires(
      appState.database.sketches, this.scanIds(), this.deviceId, this.controlIds);
    if (groups.length === 0) {
      return html`
        ${this.renderRemapBanner()}
        <div class="empty">
          No wires — drag ${this.controlIds ? 'this control' : 'a control'} onto a field in W wire mode.
        </div>`;
    }
    const editing = appState.local.editingSketchId;
    const showControl = !this.controlIds || this.controlIds.length > 1;
    return html`
      ${this.renderRemapBanner()}
      ${groups.map(g => html`
        <div class="group-head">
          <span>${instanceDisplayLabel(g.sketchId)}</span>
          ${g.sketchId === editing ? html`<span class="current">· editing</span>` : nothing}
        </div>
        ${g.rows.map(row => html`
          <div class="wire-row">
            <span class="name" title="${row.wire.src.field} → ${row.wire.dest.instanceKey}.${row.wire.dest.field}">
              ${showControl ? html`${this.controlLabel(row)} ` : nothing}<span
                class="gesture">${row.gesture}</span> → ${this.destLabel(g.sketchId, row)}
            </span>
            <button title="Locate the target field"
              @click=${() => this.locate(g.sketchId, row)}>
              <ui-icon icon="la-crosshairs"></ui-icon>
            </button>
            <button title="Remove wire"
              @click=${() => appController.removeWire(g.sketchId, row.wire.id)}>×</button>
          </div>
          ${renderWireModInspector(row.wire,
            wireModBinding(`devwire/${g.sketchId}/${row.wire.id}`, this.wireOps(g.sketchId, row.wire.id)))}
        `)}
      `)}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-wires-panel': DeviceWiresPanel;
  }
}
