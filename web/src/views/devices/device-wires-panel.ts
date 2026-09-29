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
 *
 * In Live mode the editor DB holds only the instances opened this session, so
 * the panel reads the host's composition-wide view (every live instance's
 * sketch, prefetched over the bridge). Edits only reach Resolume for the
 * EDITED instance, so the others' rows are read-only: locate opens them.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { midiController } from '../../state/midi-controller';
import { getDeviceTemplate } from '../../midi/device-registry';
import { DASHBOARD_MODULE_TYPE } from '../../sketch-types';
import { wireModBinding, renderWireModInspector } from '../../widgets/wire-mod-inspector';
import { devicesHost } from './devices-host';
import {
  collectDeviceWires, type DeviceAliasWireRow, type DeviceModWireRow, type DeviceWireRow,
} from './device-wires-model';
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
    .group-head .readonly {
      letter-spacing: 0;
      text-transform: none;
    }
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
    .wire-row .alias-tag {
      flex: none;
      font-size: var(--app-fs-xs);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--app-hi-color4);
      border: 1px solid var(--app-tint-4);
      border-radius: 1px;
      padding: 0 3px;
    }
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
  `;

  /** Editing instance the last composition prefetch was taken against. */
  private scannedFor: string | null | undefined = undefined;

  connectedCallback() {
    super.connectedCallback();
    this.scannedFor = undefined;
  }

  protected updated() {
    // Re-prefetch whenever the edited instance changes: the one just left is
    // now served from that prefetch, and the one entered from the DB.
    const host = devicesHost();
    const editing = host.currentSketchId();
    if (editing !== this.scannedFor) {
      this.scannedFor = editing;
      void host.refreshScan();
    }
  }

  /** 'Knob 3' — a control's label on `deviceId`, falling back to its id. */
  private labelFor(deviceId: string, controlId: string): string {
    const instance = midiController.instance(deviceId);
    const template = getDeviceTemplate(instance?.templateId ?? deviceId);
    const def = template?.layout.controls.find(c => c.id === controlId);
    return def?.label || controlId;
  }

  /** 'Knob 3 · turn' — the device-side label of one wire's source endpoint. */
  private controlLabel(row: DeviceWireRow): string {
    return this.labelFor(this.deviceId, row.controlId);
  }

  /** 'Twister · Knob 3' — the OTHER end of a control alias. The device name is
   *  dropped when the peer is this same device (two of its own controls). */
  private peerLabel(row: DeviceAliasWireRow): string {
    const control = this.labelFor(row.peer.deviceId, row.peer.controlId);
    if (row.peer.deviceId === this.deviceId) return control;
    const name = midiController.instance(row.peer.deviceId)?.name;
    return `${name || 'missing device'} · ${control}`;
  }

  /** 'dashboard.Speed' — the dest module + field, honoring a dashboard
   *  knob's user rename (state.label_i) and the schema display name. */
  private destLabel(sketchId: string, row: DeviceModWireRow): string {
    const moduleType = row.dest.module_type;
    const moduleName = moduleType.split('.').pop() ?? moduleType;
    const field = row.wire.dest.field;
    if (moduleType === DASHBOARD_MODULE_TYPE && field.startsWith('knob_')) {
      const st = devicesHost().sketches()[sketchId]?.instances?.[row.dest.instance_key]?.state as
          Record<string, any> | undefined;
      const label = st?.[`label_${field.slice('knob_'.length)}`];
      if (typeof label === 'string' && label.trim() !== '') return `${moduleName}.${label}`;
    }
    const schemaDef = devicesHost().fieldDef(moduleType, field);
    const fieldName = typeof schemaDef?.name === 'string' && schemaDef.name ? schemaDef.name : field;
    return `${moduleName}.${fieldName}`;
  }

  /** Is the wire's dest field declared `raw`? Raw inputs opt out of the
   *  magnitude fold (see host.h's Schema::raw()), so the inspector drops that
   *  row. Same schema lookup destLabel uses. */
  private destIsRaw(row: DeviceModWireRow): boolean {
    return !!this.destDef(row)?.raw;
  }

  /** The wire's dest field def — also what tells the shared inspector whether
   *  the destination is a VECTOR, and how wide, so the lane/fit rows appear. */
  private destDef(row: DeviceModWireRow): { type?: string; hint?: string; raw?: boolean } | null {
    return (devicesHost().fieldDef(row.dest.module_type, row.wire.dest.field) ?? null) as
        { type?: string; hint?: string; raw?: boolean } | null;
  }

  /** Show the dest field (the host opens / selects / scrolls / flashes). */
  private locate(sketchId: string, row: DeviceModWireRow) {
    devicesHost().locate(sketchId, row.chainIdx, row.wire.dest.field);
  }

  private editable(sketchId: string): boolean {
    return devicesHost().canEditWires(sketchId);
  }

  render() {
    if (!this.deviceId) return nothing;
    const host = devicesHost();
    const groups = collectDeviceWires(
      host.sketches(), host.scanIds(), this.deviceId, this.controlIds);
    if (groups.length === 0) {
      return html`<div class="empty">
        No wires — in W wire mode, drag ${this.controlIds ? 'this control' : 'a control'}
        onto a field to modulate it, or onto another control to alias the two.
      </div>`;
    }
    const editing = host.currentSketchId();
    const showControl = !this.controlIds || this.controlIds.length > 1;
    return html`
      ${groups.map(g => html`
        <div class="group-head">
          <span>${host.sketchLabel(g.sketchId)}</span>
          ${g.sketchId === editing ? html`<span class="current">· editing</span>`
            : !this.editable(g.sketchId)
              ? html`<span class="readonly" title="Open this instance to edit its wires">· locate to edit</span>`
              : nothing}
        </div>
        ${g.rows.map(row => row.kind === 'alias'
          ? this.renderAliasRow(g.sketchId, row, showControl)
          : this.renderModRow(g.sketchId, row, showControl))}
      `)}
    `;
  }

  private renderModRow(sketchId: string, row: DeviceModWireRow, showControl: boolean) {
    return html`
      <div class="wire-row">
        <span class="name" title="${row.wire.src.field} → ${row.wire.dest.instanceKey}.${row.wire.dest.field}">
          ${showControl ? html`${this.controlLabel(row)} ` : nothing}<span
            class="gesture">${row.gesture}</span> → ${this.destLabel(sketchId, row)}
        </span>
        <button title="Locate the target field"
          @click=${() => this.locate(sketchId, row)}>
          <ui-icon icon="la-crosshairs"></ui-icon>
        </button>
        ${this.editable(sketchId) ? html`<button title="Remove wire"
          @click=${() => devicesHost().removeWire(sketchId, row.wire.id)}>×</button>` : nothing}
      </div>
      ${!this.editable(sketchId) ? nothing : renderWireModInspector(row.wire,
        wireModBinding(`devwire/${sketchId}/${row.wire.id}`, devicesHost().wireOps(sketchId, row.wire.id)),
        this.destIsRaw(row), this.destDef(row))}
    `;
  }

  /** An ALIAS row: no target field to locate and no mod inspector (nothing
   *  folds an alias into a range — the two controls simply are one). The
   *  double arrow says the relationship is undirected. */
  private renderAliasRow(sketchId: string, row: DeviceAliasWireRow, showControl: boolean) {
    return html`
      <div class="wire-row">
        <span class="alias-tag" title="Control alias — both controls read whichever moved last">alias</span>
        <span class="name" title="${row.wire.src.field} ↔ ${row.wire.dest.instanceKey}.${row.wire.dest.field}">
          ${showControl ? html`${this.controlLabel(row)} ` : nothing}<span
            class="gesture">${row.gesture}</span> ↔ ${this.peerLabel(row)}<span
            class="gesture"> ${row.peer.gesture}</span>
        </span>
        ${this.editable(sketchId) ? html`<button title="Remove alias"
          @click=${() => devicesHost().removeWire(sketchId, row.wire.id)}>×</button>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-wires-panel': DeviceWiresPanel;
  }
}
