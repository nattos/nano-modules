/**
 * <module-folders> — where effect bundles come from, and the folders the user
 * adds: the one Modules editor, mounted by Remote Control's Settings page and
 * by the arrangement's Settings tab.
 *
 * It persists the mapped folders (effect-bundles.ts setModulePaths — the file
 * the native side reads too, bridge/module_dirs.h) and then fires
 * `modules-changed` with what resolved before and after. Bringing an ENGINE in
 * line is the host's business: Remote Control's worker loads / swaps / unloads
 * and offers Resolume a reload; the arrangement hands it to its engine
 * (engineBridge.reloadModules — the worker, or the native compositor's
 * `reload_modules`).
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  bundleLabel, listModules, setModulePaths,
  type EffectBundleInfo, type ModuleListing, type ModulePathRow,
} from '../effect-bundles';
import { absPathOf, isElectron, revealInFolder, showDirectoryPicker } from '../state/paths';

export interface ModulesChangedDetail {
  /** The bundles that resolved before the change … */
  before: EffectBundleInfo[];
  /** … and the listing after it. */
  listing: ModuleListing;
}

@customElement('module-folders')
export class ModuleFolders extends LitElement {
  /** A narrow host (the arrangement's inspector): tighter, paths wrap. */
  @property({ type: Boolean, reflect: true }) compact = false;

  @state() private modules: ModuleListing | null = null;
  @state() private typedPath = '';
  @state() private error = '';

  static styles = css`
    :host { display: flex; flex-direction: column; gap: var(--app-sp-3); min-width: 0; }
    :host([compact]) { gap: var(--app-sp-2); }
    .hint { font-size: var(--app-fs-sm); color: var(--app-text-color2); line-height: 1.5; }
    .note {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      line-height: 1.5;
      border-left: 2px solid var(--app-tint-4);
      padding-left: var(--app-sp-3);
    }
    code {
      font-family: inherit;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      padding: 0 4px;
      word-break: break-all;
    }
    button.small {
      font-family: inherit;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      padding: 1px 8px;
      cursor: pointer;
      flex: none;
    }
    button.small:hover { border-color: var(--app-text-color2); }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--app-sp-2); }
    .row {
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      min-width: 0;
    }
    :host([compact]) .row { gap: var(--app-sp-2); flex-wrap: wrap; }
    .grow { flex: 1; min-width: 0; word-break: break-all; }
    .origin { opacity: 0.7; }
    input[type='text'] {
      flex: 1;
      min-width: 0;
      font-family: inherit;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      padding: 2px 6px;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    void listModules().then((l) => { this.modules = l; });
  }

  render() {
    const m = this.modules;
    if (!m) return nothing;
    const loaded = m.bundles.filter((b) => b.origin !== 'builtin');
    return html`
      <div class="hint">
        Effect bundles beyond the built-in ones load from the modules folder and
        from any folder you add here — e.g. where you build your own effects. A
        bundle in an added folder replaces a built-in one of the same name, and
        reloads live when it is rebuilt.
      </div>
      ${m.defaultDir ? html`
        <div class="row">
          <span class="grow">Modules folder: <code>${m.defaultDir}</code></span>
          ${isElectron() ? html`<button class="small"
            @click=${() => { void revealInFolder(m.defaultDir!); }}>Reveal</button>` : nothing}
        </div>` : nothing}
      ${m.editable ? html`
        <ul data-module-folders>
          ${m.paths.map((row, i) => html`
            <li class="row">
              <input type="checkbox" .checked=${row.enabled}
                title="Load bundles from this folder"
                @change=${(e: Event) => this.update_(m.paths.map((r, j) =>
                  j === i ? { ...r, enabled: (e.target as HTMLInputElement).checked } : r))}>
              <span class="grow"><code>${row.path}</code></span>
              ${isElectron() ? html`<button class="small"
                @click=${() => { void revealInFolder(row.path); }}>Reveal</button>` : nothing}
              <button class="small"
                @click=${() => this.update_(m.paths.filter((_, j) => j !== i))}>Remove</button>
            </li>`)}
          <li class="row">
            ${isElectron() ? html`
              <button class="small" data-module-add @click=${this.onAddFolder}>Add folder…</button>` : html`
              <input type="text" placeholder="/absolute/path/to/modules"
                .value=${this.typedPath}
                @input=${(e: Event) => { this.typedPath = (e.target as HTMLInputElement).value; }}>
              <button class="small" ?disabled=${!this.typedPath.trim()}
                @click=${() => {
                  const p = this.typedPath.trim();
                  this.typedPath = '';
                  this.update_([...m.paths, { path: p, enabled: true }]);
                }}>Add</button>`}
          </li>
        </ul>` : html`
        <div class="note">Module folders need the desktop app (or the dev server).</div>`}
      ${this.error ? html`<div class="note">${this.error}</div>` : nothing}
      ${loaded.length ? html`
        <ul data-module-bundles>
          ${loaded.map((b) => html`
            <li class="row">
              <span>${bundleLabel(b.id)}</span>
              <span class="grow"><code>${b.path ?? b.url}</code></span>
              <span class="origin">${b.origin === 'mapped' ? 'added folder' : 'modules folder'}</span>
            </li>`)}
        </ul>` : html`<div class="hint">No extra bundles found.</div>`}
    `;
  }

  private onAddFolder = async () => {
    const m = this.modules;
    if (!m) return;
    try {
      const dir = absPathOf(await showDirectoryPicker());
      if (!dir || m.paths.some((r) => r.path === dir)) return;
      this.update_([...m.paths, { path: dir, enabled: true }]);
    } catch (e) {
      this.error = String(e);
    }
  };

  /** Persist the mapped folders, then tell the host what they now resolve to. */
  private update_(rows: ModulePathRow[]) {
    this.error = '';
    const before = this.modules?.bundles ?? [];
    void setModulePaths(rows).then((listing) => {
      this.modules = listing;
      this.dispatchEvent(new CustomEvent<ModulesChangedDetail>('modules-changed', {
        detail: { before, listing }, bubbles: true, composed: true,
      }));
    }).catch((e) => { this.error = String(e); });
  }
}

declare global {
  interface HTMLElementTagNameMap { 'module-folders': ModuleFolders }
}
