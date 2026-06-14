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
    :host { display: block; }
    .knob-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 2px;
      justify-content: space-between;
      padding: 4px 2px;
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
            .binding=${binding}
          ></scalar-knob>
        `)}
      </div>
    `;
  }
}
