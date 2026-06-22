/**
 * <arr-inspector> — content depends on the active right tab:
 *   inspector → the current selection (clip / track / rail / multi)
 *   settings  → composition settings + app-wide settings (combined list)
 *   export    → offline (Precise) render options
 *
 * Mockup: editors are representative; field values aren't deeply wired.
 */

import { html, css, TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import { clipProcessesTexture } from '../model/composition';
import './arr-chain';
import '../../../widgets/ui-icon';

@customElement('arr-inspector')
export class ArrInspector extends MobxLitElement {
  static styles = css`
    :host {
      display: block;
      overflow-y: auto;
      color: var(--app-text-color1);
      font-size: var(--app-fs-md);
    }
    .section-header {
      font-size: var(--app-fs-sm);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--app-text-color2);
      padding: var(--app-sp-4) var(--app-sp-5) var(--app-sp-2);
      border-bottom: 1px solid var(--app-tint-2);
    }
    .body {
      padding: var(--app-sp-4) var(--app-sp-5);
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-4);
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--app-sp-4);
      min-height: 22px;
    }
    .row label {
      color: var(--app-text-color2);
      font-size: var(--app-fs-sm);
    }
    .row .val {
      color: var(--app-text-color1);
      font-variant-numeric: tabular-nums;
    }
    input,
    select {
      font-family: inherit;
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 3px var(--app-sp-3);
      max-width: 130px;
    }
    .group-title {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      margin-top: var(--app-sp-3);
      border-top: 1px solid var(--app-tint-2);
      padding-top: var(--app-sp-3);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .chip {
      font-size: var(--app-fs-xs);
      padding: 2px 6px;
      border-radius: 2px;
      background: var(--app-tint-2);
    }
    .chip.mod {
      color: var(--app-cat-mod);
    }
    .tag {
      display: inline-block;
      font-size: var(--app-fs-xs);
      padding: 1px 6px;
      border-radius: 2px;
      background: var(--app-tint-3);
      color: var(--app-text-color2);
    }
    .empty {
      padding: var(--app-sp-6);
      color: var(--app-text-color2);
      opacity: 0.7;
      line-height: 1.6;
    }
    .dash-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 6px 4px 2px;
    }
    .dnode {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      width: 46px;
    }
    .dnode .fpip {
      position: absolute;
      top: -3px;
      left: 2px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      cursor: pointer;
      border: 1px solid var(--app-bg-color2);
      z-index: 1;
    }
    .dnode .fpip.in {
      background: var(--app-io-input);
    }
    .dnode .fpip.out {
      background: var(--app-io-output);
    }
    .dnode .knob {
      width: 30px;
      height: 30px;
    }
    .dnode .spark {
      width: 42px;
      height: 16px;
      background: var(--app-bg-color1);
      border: 1px solid var(--app-io-output);
      border-radius: 2px;
    }
    .dnode .dlabel {
      font-size: 8px;
      color: var(--app-text-color2);
      max-width: 46px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn {
      font-family: inherit;
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 6px 10px;
      cursor: pointer;
    }
    .btn.primary {
      border-color: var(--app-hi-color2);
      color: var(--app-hi-color2);
    }
  `;

  render() {
    switch (store.activeRightTab) {
      case 'settings':
        return this.renderSettings();
      case 'export':
        return this.renderExport();
      default:
        return this.renderSelection();
    }
  }

  // ── Selection ─────────────────────────────────────────────────────────
  private renderSelection(): TemplateResult {
    const count = store.selection.size;
    if (count === 0) {
      return html`<div class="empty">
        Nothing selected.<br />Click a clip or track. Double-click an empty lane
        to create a clip.
      </div>`;
    }
    if (count > 1) {
      return html`
        <div class="section-header">${count} items selected</div>
        <div class="body">
          <div class="row">
            <label>Selection</label
            ><span class="val">${count} objects</span>
          </div>
          <div class="empty" style="padding:0">
            Multi-select — shared edits would apply to all. Press ⌫ to delete
            selected clips.
          </div>
        </div>
      `;
    }
    const path = store.primaryPath!;
    const kind = path.split('/')[0];
    if (kind === 'clip') return this.renderClipInspector(path);
    if (kind === 'track') return this.renderTrackInspector(path);
    if (kind === 'rail') return this.renderRailInspector(path);
    return html`<div class="empty">Selected: ${path}</div>`;
  }

  /** Map device id → read target fields, so the chain can anchor reader wires. */
  private readFieldsByDevice(clip: { reads?: { targetDeviceId: string; targetField: string }[] }) {
    const out: Record<string, string[]> = {};
    for (const r of clip.reads ?? []) {
      (out[r.targetDeviceId] ??= []).push(r.targetField);
    }
    return out;
  }

  /** Wired chain fields keyed by `deviceId:field` (rail reads = input pips). */
  private clipFieldWires(clip: any, clipPath: string) {
    const out: Record<string, any> = {};
    for (const r of clip.reads ?? []) {
      out[`${r.targetDeviceId}:${r.targetField}`] = {
        wireId: 'r:' + r.id,
        dir: 'in',
        label: `rail → ${r.targetField}`,
        clipPath,
        target: { field: r.targetField },
      };
    }
    return out;
  }

  private onDashPip(e: PointerEvent, wire: any) {
    e.stopPropagation();
    store.selectWire(wire.wireId, wire.clipPath, wire.target);
    store.openTapPopup({ wireId: wire.wireId, x: e.clientX + 8, y: e.clientY + 8, label: wire.label });
  }

  private renderKnob(label: string, wire?: any): TemplateResult {
    return html`<div class="dnode">
      ${wire ? html`<span class="fpip in" title=${wire.label} @pointerdown=${(e: PointerEvent) => this.onDashPip(e, wire)}></span>` : ''}
      <svg class="knob" viewBox="0 0 28 28">
        <circle cx="14" cy="14" r="10" fill="var(--app-bg-color1)" stroke="var(--app-tint-4)"></circle>
        <line x1="14" y1="14" x2="21" y2="8" stroke="var(--app-text-color1)" stroke-width="1.5"></line>
      </svg>
      <span class="dlabel">${label}</span>
    </div>`;
  }

  private renderOut(label: string, wire?: any): TemplateResult {
    // Static mock sparkline.
    const pts = Array.from({ length: 21 }, (_, i) => {
      const x = i * 2;
      const y = 8 - Math.sin(i * 0.6) * 5;
      return `${x},${y.toFixed(1)}`;
    }).join(' ');
    return html`<div class="dnode">
      ${wire ? html`<span class="fpip out" title=${wire.label} @pointerdown=${(e: PointerEvent) => this.onDashPip(e, wire)}></span>` : ''}
      <svg class="spark" viewBox="0 0 40 16" preserveAspectRatio="none">
        <polyline points=${pts} fill="none" stroke="var(--app-io-output)" stroke-width="1"></polyline>
      </svg>
      <span class="dlabel">${label}</span>
    </div>`;
  }

  private renderDashboard(clip: any, clipPath: string): TemplateResult {
    const inputs = clip.reads ?? [];
    const outputs = clip.exports ?? [];
    return html`
      <div class="group-title" style="border-top:none;margin-top:0;padding-top:0">
        Dashboard · inputs
      </div>
      <div class="dash-row">
        ${inputs.length
          ? inputs.map((r: any) =>
              this.renderKnob(r.targetField, {
                wireId: 'r:' + r.id, dir: 'in', clipPath, target: { field: r.targetField },
                label: `rail → ${r.targetField}`,
              }),
            )
          : html`${this.renderKnob('Macro A')}${this.renderKnob('Macro B')}`}
      </div>
      <div class="group-title">Dashboard · outputs</div>
      <div class="dash-row">
        ${outputs.length
          ? outputs.map((ex: any) =>
              this.renderOut(ex.sourceField, {
                wireId: 'w:' + ex.id, dir: 'out', clipPath, target: {},
                label: `${ex.sourceField} → rail`,
              }),
            )
          : html`${this.renderOut('out')}`}
      </div>
    `;
  }

  private renderClipInspector(path: string): TemplateResult {
    const found = store.clipByPath(path);
    if (!found) return html`<div class="empty">Clip not found.</div>`;
    const { clip } = found;
    const processes = clipProcessesTexture(clip);
    return html`
      <div class="section-header">Clip · ${clip.name}</div>
      <div class="body">
        <div class="row">
          <label>Kind</label>
          <span class="val">
            <span class="tag">${clip.kind}</span>
            <span class="tag"
              >${processes ? 'processes frames' : 'modulation-only'}</span
            >
          </span>
        </div>
        <div class="row">
          <label>Start (beat)</label><span class="val">${clip.startBeat.toFixed(2)}</span>
        </div>
        <div class="row">
          <label>Length (beats)</label><span class="val">${clip.lengthBeat.toFixed(2)}</span>
        </div>
        <div class="row">
          <label>Play mode</label>
          <select .value=${clip.loop.mode} @change=${(e: Event) => (clip.loop.mode = (e.target as HTMLSelectElement).value as any)}>
            ${['loop', 'reverse-loop', 'pingpong', 'random-jumps', 'hold'].map(
              (m) => html`<option value=${m} ?selected=${m === clip.loop.mode}>${m}</option>`,
            )}
          </select>
        </div>
        ${clip.source
          ? html`<div class="row">
              <label>Source</label><span class="val">${clip.source.label}</span>
            </div>`
          : ''}

        ${this.renderDashboard(clip, path)}

        <div class="group-title">Chain (sketch)</div>
        <arr-chain
          .sketch=${clip.sketch}
          .allowSource=${clip.kind === 'effect'}
          .highlightFields=${this.readFieldsByDevice(clip)}
          .fieldWires=${this.clipFieldWires(clip, path)}
          .onAdd=${(kind: 'source' | 'effect') =>
            store.addClipDevice(found.track.id, clip.id, kind)}
        ></arr-chain>

        ${clip.warps.length
          ? html`<div class="group-title">Beat warp</div>
              ${clip.warps.map(
                (w) => html`<div class="row">
                  <label>${w.waveform} · ${w.periodBeats}b</label>
                  <span class="val">amp ${w.amplitude.toFixed(2)}</span>
                </div>`,
              )}`
          : ''}

        ${clip.exports.length
          ? html`<div class="group-title">Rail exports</div>
              ${clip.exports.map((ex) => {
                const rail = store.composition.rails.find((r) => r.id === ex.railId);
                return html`<div class="row">
                  <label>→ ${rail?.name ?? ex.railId}</label>
                  <span class="val"><span class="tag">${ex.combine}</span><span class="tag">${ex.magnitude}</span></span>
                </div>`;
              })}`
          : ''}

        ${clip.automation.length
          ? html`<div class="group-title">Clip automation</div>
              ${clip.automation.map(
                (l) => html`<div class="row"><label>${l.label}</label><span class="val">${l.points.length} pts</span></div>`,
              )}`
          : ''}
      </div>
    `;
  }

  private renderTrackInspector(path: string): TemplateResult {
    const track = store.trackById(path.split('/')[1]);
    if (!track) return html`<div class="empty">Track not found.</div>`;
    return html`
      <div class="section-header">${track.kind === 'group' ? 'Group' : 'Track'} · ${track.name}</div>
      <div class="body">
        <div class="row"><label>Clips</label><span class="val">${track.clips.length}</span></div>
        <div class="group-title">Chain (sketch)</div>
        <arr-chain
          .sketch=${track.sketch}
          .onAdd=${() => store.addTrackDevice(track.id, 'effect')}
        ></arr-chain>
        ${track.automation.length
          ? html`<div class="group-title">Track automation</div>
              ${track.automation.map(
                (l) => html`<div class="row"><label>${l.label}</label><span class="val">${l.points.length} pts</span></div>`,
              )}`
          : ''}
      </div>
    `;
  }

  private renderRailInspector(path: string): TemplateResult {
    const rail = store.composition.rails.find((r) => r.id === path.split('/')[1]);
    if (!rail) return html`<div class="empty">Rail not found.</div>`;
    return html`
      <div class="section-header">Rail · ${rail.name}</div>
      <div class="body">
        <div class="row"><label>Default</label><span class="val">${rail.defaultValue}</span></div>
        <div class="row"><label>Range</label><span class="val">${rail.range.min} … ${rail.range.max}</span></div>
      </div>
    `;
  }

  // ── Settings (composition + app, combined) ────────────────────────────
  private renderSettings(): TemplateResult {
    const meta = store.composition.meta;
    return html`
      <div class="section-header">Settings</div>
      <div class="body">
        <div class="group-title" style="border-top:none;margin-top:0;padding-top:0">Composition</div>
        <div class="row">
          <label>Resolution</label>
          <span class="val">
            <input
              type="number"
              .value=${String(meta.resolution.width)}
              @change=${(e: Event) => store.setResolution(Number((e.target as HTMLInputElement).value), meta.resolution.height)}
              style="max-width:64px"
            />×
            <input
              type="number"
              .value=${String(meta.resolution.height)}
              @change=${(e: Event) => store.setResolution(meta.resolution.width, Number((e.target as HTMLInputElement).value))}
              style="max-width:64px"
            />
          </span>
        </div>
        <div class="row">
          <label>Base BPM</label>
          <input type="number" .value=${String(meta.baseBPM)} @change=${(e: Event) => store.setBpm(Number((e.target as HTMLInputElement).value))} style="max-width:64px" />
        </div>
        <div class="row">
          <label>Time signature</label>
          <span class="val">${meta.timeSignature[0]} / ${meta.timeSignature[1]}</span>
        </div>

        <div class="group-title">Application</div>
        <div class="row"><label>Theme</label><span class="val"><span class="tag">Dark (Pro)</span></span></div>
        <div class="row"><label>Snap to grid</label><span class="val"><span class="tag">¼ beat</span></span></div>
        <div class="row"><label>Default play mode</label><span class="val">${store.composition.playMode.defaultMode}</span></div>
      </div>
    `;
  }

  // ── Export ────────────────────────────────────────────────────────────
  private renderExport(): TemplateResult {
    const meta = store.composition.meta;
    return html`
      <div class="section-header">Export</div>
      <div class="body">
        <div class="row"><label>Mode</label><span class="val"><span class="tag">Precise (waits)</span></span></div>
        <div class="row"><label>Resolution</label><span class="val">${meta.resolution.width}×${meta.resolution.height}</span></div>
        <div class="row">
          <label>Range</label>
          <span class="val">${store.loopEnabled ? 'Loop brace' : 'Whole arrangement'}</span>
        </div>
        <div class="row"><label>Format</label>
          <select><option>ProRes 4444</option><option>H.264</option><option>PNG sequence</option></select>
        </div>
        <button class="btn primary" style="margin-top:8px" @click=${() => alert('Offline render — wired in a later milestone.')}>
          <ui-icon icon="la-play"></ui-icon> Render
        </button>
      </div>
    `;
  }
}
