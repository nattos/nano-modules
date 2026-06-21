/**
 * <dashboard-editor> — custom card body for the `util.dashboard` effect.
 *
 * Renders the instance's fixed bank of knobs (state.knobs[]) as a single row of
 * <scalar-knob>s. Each knob is a FieldEditorElement bound to `knob_i`, so the
 * column-group's field scanner picks them up and the wire system treats each as
 * an endpoint (`knob_i` is both a wire source and sink — the executor resolves
 * direction by stack position).
 *
 * Mounted directly by column-group (not via the editor registry) because it
 * needs the full sketch/col/chain context to drive the knob writes.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController, DASHBOARD_KNOB_COUNT } from '../state/controller';
import type { FieldBinding, ContinuousEditHandle } from './field-editor';
import './scalar-knob';

const knobIndex = (fieldPath: string): number => {
  const n = parseInt(fieldPath.slice('knob_'.length), 10);
  return Number.isNaN(n) ? 0 : n;
};

@customElement('dashboard-editor')
export class DashboardEditor extends MobxLitElement {
  @property() sketchId = '';
  @property() instanceKey = '';

  static styles = css`
    /* The editor is a container so the knob grid can reflow on ITS width. */
    :host { display: block; container-type: inline-size; }
    /* Balanced wrap: 8 knobs in a divisor-of-8 column count, so rows are always
     * equal — 4/4 when wide, 2/2/2/2 narrower, then a single column. Container
     * queries pick the largest count that fits (each knob is ~44px). */
    .knob-row {
      display: grid;
      grid-template-columns: repeat(4, max-content);
      gap: var(--app-sp-3) 8px;
      justify-content: center;
      justify-items: center;
      padding: 4px 2px;
    }
    @container (max-width: 199px) {
      .knob-row { grid-template-columns: repeat(2, max-content); }
    }
    @container (max-width: 103px) {
      .knob-row { grid-template-columns: max-content; }
    }
  `;

  /** One binding for all knobs; field path `knob_i` selects the array slot. */
  private binding(): FieldBinding {
    const sId = this.sketchId, key = this.instanceKey;
    const knobsOf = (): number[] => {
      const st = appState.database.sketches[sId]?.instances?.[key]?.state as Record<string, any> | undefined;
      return Array.isArray(st?.knobs) ? st!.knobs : [];
    };
    return {
      instanceKey: key,
      getValue: (fp: string) => knobsOf()[knobIndex(fp)] ?? 0,
      setValue: (fp: string, v: any) =>
        appController.setDashboardKnob(sId, key, knobIndex(fp), v as number),
      beginContinuousEdit: (fp: string, v: any): ContinuousEditHandle => {
        const i = knobIndex(fp);
        const edit = appController.beginSetDashboardKnob(sId, key, i, v as number);
        return {
          update: (nv: any) => appController.updateSetDashboardKnob(edit, sId, key, i, nv as number),
          accept: () => edit.accept(),
          cancel: () => edit.cancel(),
        };
      },
    };
  }

  /**
   * A knob's stored value has no effect when it drives nothing (no outgoing
   * wire) OR an input wire overrides it with a destructive `replace` combine
   * (default when unset). Such knobs render grayed.
   */
  private isMuted(i: number): boolean {
    const wires = appState.database.sketches[this.sketchId]?.wires ?? [];
    const field = `knob_${i}`;
    const key = this.instanceKey;
    const hasOutgoing = wires.some(w => w.src.instanceKey === key && w.src.field === field);
    const replacedIn = wires.some(w =>
      w.dest.instanceKey === key && w.dest.field === field && (w.combine ?? 'replace') === 'replace');
    return !hasOutgoing || replacedIn;
  }

  render() {
    if (!this.sketchId || !this.instanceKey) return html``;
    const binding = this.binding();
    const knobs = Array.from({ length: DASHBOARD_KNOB_COUNT }, (_, i) => i);
    return html`
      <div class="knob-row">
        ${knobs.map(i => html`
          <scalar-knob
            .fieldPath=${`knob_${i}`}
            .label=${String(i)}
            .min=${0} .max=${1} .step=${0.01} .defaultValue=${0}
            .muted=${this.isMuted(i)}
            .binding=${binding}
          ></scalar-knob>
        `)}
      </div>
    `;
  }
}
