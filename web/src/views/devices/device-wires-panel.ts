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
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { midiController } from '../../state/midi-controller';
import { instanceDisplayLabel } from '../../state/instance-labels';
import { getDeviceTemplate } from '../../midi/device-registry';
import { DASHBOARD_MODULE_TYPE, type Wire } from '../../sketch-types';
import { wireModBinding, renderWireModInspector } from '../../widgets/wire-mod-inspector';
import { scrollToAndFlashField } from '../../widgets/field-anchor-lookup';
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
      const st = appState.database.sketches[sketchId]?.instances?.[row.dest.instance_key]?.state as
          Record<string, any> | undefined;
      const label = st?.[`label_${field.slice('knob_'.length)}`];
      if (typeof label === 'string' && label.trim() !== '') return `${moduleName}.${label}`;
    }
    const schemaDef = appState.local.plugins.find(p => p.id === moduleType)?.schema?.[field];
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
    return (appState.local.plugins.find(p => p.id === row.dest.module_type)
        ?.schema?.[row.wire.dest.field] ?? null) as
        { type?: string; hint?: string; raw?: boolean } | null;
  }

  /** Open the dest instance (if not already being edited), select the dest
   *  field (surfaces its floating card), scroll to it and flash it. */
  private locate(sketchId: string, row: DeviceModWireRow) {
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

  render() {
    if (!this.deviceId) return nothing;
    const groups = collectDeviceWires(
      appState.database.sketches, this.scanIds(), this.deviceId, this.controlIds);
    if (groups.length === 0) {
      return html`<div class="empty">
        No wires — in W wire mode, drag ${this.controlIds ? 'this control' : 'a control'}
        onto a field to modulate it, or onto another control to alias the two.
      </div>`;
    }
    const editing = appState.local.editingSketchId;
    const showControl = !this.controlIds || this.controlIds.length > 1;
    return html`
      ${groups.map(g => html`
        <div class="group-head">
          <span>${instanceDisplayLabel(g.sketchId)}</span>
          ${g.sketchId === editing ? html`<span class="current">· editing</span>` : nothing}
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
        <button title="Remove wire"
          @click=${() => appController.removeWire(sketchId, row.wire.id)}>×</button>
      </div>
      ${renderWireModInspector(row.wire,
        wireModBinding(`devwire/${sketchId}/${row.wire.id}`, this.wireOps(sketchId, row.wire.id)),
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
        <button title="Remove alias"
          @click=${() => appController.removeWire(sketchId, row.wire.id)}>×</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-wires-panel': DeviceWiresPanel;
  }
}
