/**
 * <app-settings> — the universal "Settings" tab, mounted (full-takeover) on
 * every top-level surface: Effect Dev, Playground, Remote Control (`live`).
 *
 * Houses cross-surface preferences that don't belong to any one surface:
 *   - The mode selector (which of the three surfaces this session prefers).
 *   - The Resolume-remote on/off kill-switch (`barrelRemoteEnabled`).
 *   - The Resolume setup checklist: what to install where, and which of those
 *     steps is actually satisfied right now. Live status comes from
 *     `state/resolume-setup.ts`, which keeps its own probe socket open while
 *     this tab is mounted — the checklist has to work from Effect Dev and
 *     Playground too, which is exactly when someone reads it.
 */

import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import { availableModes } from '../product';
import {
  bundleLabel, listModules, setModulePaths,
  type ModuleListing, type ModulePathRow,
} from '../effect-bundles';
import { LIVE_OFFLINE_KEY, type AppMode } from '../resolume-mode';
import { TARGET_FPS_OPTIONS } from './gpu-headroom';
import {
  resolumeSetup, setupStatuses, watchResolumeSetup, resolumeApiPort,
  resolumeRemoteSettingChanged,
  type SetupStepId, type SetupStepStatus,
} from '../state/resolume-setup';
import {
  absPathOf, appResourceRoot, copyText, isElectron, revealInFolder, showDirectoryPicker,
} from '../state/paths';

/** macOS, from Electron's own `process` when we have it. Both platforms ship a
 *  plug-in now, but they are different ARTEFACTS — a `.bundle` directory plus a
 *  `.dylib` against a plain pair of DLLs — and the install step has to name the
 *  files the person is actually looking for. */
function isMac(): boolean {
  const plat = (globalThis as any).process?.platform;
  if (typeof plat === 'string') return plat === 'darwin';
  return /Mac/i.test(navigator.platform || '');
}

/** Windows, by the same route. Neither is true in a plain browser tab, where
 *  there is no bundled plug-in to point at at all. */
function isWindows(): boolean {
  const plat = (globalThis as any).process?.platform;
  if (typeof plat === 'string') return plat === 'win32';
  return /Win/i.test(navigator.platform || '');
}

const MODE_OPTIONS: { id: AppMode; label: string; description: string }[] = [
  { id: 'effect-dev', label: 'Effect Dev', description: 'Author and test individual effects in isolation.' },
  { id: 'live', label: 'Remote Control', description: 'Bound to the shared NanoBarrel server (Resolume).' },
  { id: 'playground', label: 'Playground', description: 'Simulate the shared server locally, without Resolume.' },
];

@customElement('app-settings')
export class AppSettings extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .page {
      max-width: 640px;
      margin: 0 auto;
      padding: var(--app-sp-6);
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-6);
    }
    h1 {
      font-size: var(--app-fs-lg);
      color: var(--app-text-color1);
      margin: 0;
    }
    section {
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-3);
    }
    h2 {
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      margin: 0;
    }
    .hint {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      line-height: 1.5;
    }
    .mode-row {
      display: flex;
      gap: var(--app-sp-3);
    }
    .mode-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
      text-align: left;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      color: var(--app-text-color1);
      font-family: inherit;
      padding: var(--app-sp-4);
      cursor: pointer;
    }
    .mode-btn:hover {
      border-color: var(--app-text-color2);
    }
    .mode-btn[active] {
      border-color: var(--app-hi-color2);
    }
    .mode-btn .label {
      font-size: var(--app-fs-md);
    }
    .mode-btn .description {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
    }
    .toggle-row label {
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
      cursor: pointer;
    }
    select {
      font-family: inherit;
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      padding: var(--app-sp-2) var(--app-sp-3);
      cursor: pointer;
      align-self: flex-start;
    }

    /* --- Setup checklist --- */
    ol.steps {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-3);
      counter-reset: step;
    }
    li.step {
      display: grid;
      grid-template-columns: 20px 1fr;
      gap: var(--app-sp-3);
      align-items: start;
    }
    .mark {
      font-family: inherit;
      font-size: var(--app-fs-md);
      line-height: 1.4;
      text-align: center;
      color: var(--app-text-color2);
      user-select: none;
    }
    li.step[data-state='ok'] .mark { color: var(--app-hi-color2); }
    li.step[data-state='warn'] .mark { color: var(--app-warn); }
    .step-body {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .step-title {
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
    }
    li.step[data-state='ok'] .step-title { color: var(--app-text-color2); }
    .step-how {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      line-height: 1.5;
    }
    .step-detail {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      line-height: 1.5;
      word-break: break-all;
    }
    li.step[data-state='ok'] .step-detail { color: var(--app-hi-color2); }
    li.step[data-state='warn'] .step-detail { color: var(--app-warn); }
    code {
      font-family: inherit;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      padding: 0 4px;
      word-break: break-all;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--app-sp-2);
      margin-top: 2px;
    }
    button.small {
      font-family: inherit;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      padding: 2px var(--app-sp-3);
      cursor: pointer;
    }
    button.small:hover { border-color: var(--app-text-color2); }
    .module-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-2);
    }
    .module-row {
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      min-width: 0;
    }
    .module-row .grow { flex: 1; min-width: 0; word-break: break-all; }
    .module-row .origin { color: var(--app-text-color2); opacity: 0.7; }
    .module-row input[type='text'] {
      flex: 1;
      font-family: inherit;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      padding: 2px var(--app-sp-2);
    }
    .note {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      line-height: 1.5;
      border-left: 2px solid var(--app-tint-4);
      padding-left: var(--app-sp-3);
    }
  `;

  /** This app's own resource root (Electron only) — resolved once on mount,
   *  and the other half of the "is Resolume running OUR plug-in?" comparison. */
  @state() private appRoot: string | null = null;
  /** Feedback for the copy-path button, cleared on a timer. */
  @state() private copied = '';
  /** Effect bundles and module directories (null until listed). */
  @state() private modules: ModuleListing | null = null;
  @state() private modulesError = '';
  /** Browser-only: a path typed in, since the web picker yields no paths. */
  @state() private typedModulePath = '';
  private stopWatch: (() => void) | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback() {
    super.connectedCallback();
    // Only while the tab is actually mounted: no socket is held open behind a
    // settings page nobody is looking at.
    this.stopWatch = watchResolumeSetup();
    void appResourceRoot().then((root) => { this.appRoot = root; });
    void listModules().then((l) => { this.modules = l; });
  }

  disconnectedCallback() {
    this.stopWatch?.();
    this.stopWatch = null;
    if (this.copyTimer != null) { clearTimeout(this.copyTimer); this.copyTimer = null; }
    super.disconnectedCallback();
  }

  render() {
    const settings = appState.local.userSettings;
    return html`
      <div class="page">
        <h1>Settings</h1>
        <section>
          <h2>Mode</h2>
          <div class="hint">Switching reloads the page into the matching surface.</div>
          <div class="mode-row">
            ${MODE_OPTIONS.filter(o => availableModes().includes(o.id)).map(o => html`
              <button class="mode-btn"
                ?active=${settings.appMode === o.id}
                @click=${() => appController.switchAppMode(o.id)}>
                <span class="label">${o.label}</span>
                <span class="description">${o.description}</span>
              </button>
            `)}
          </div>
        </section>
        <section>
          <h2>Resolume Remote</h2>
          <div class="hint">
            Off: never try to reach Resolume, in any mode (Remote Control falls
            back to editing its offline copy). On: also watch quietly from the
            other modes, so they can offer switching to Remote Control.
          </div>
          <div class="toggle-row">
            <label>
              <input type="checkbox"
                .checked=${settings.barrelRemoteEnabled}
                @change=${this.onToggleRemote}>
              Enable Resolume Remote
            </label>
          </div>
          ${this.renderSetupChecklist()}
        </section>
        ${this.renderModules()}
        <section>
          <h2>Target Framerate</h2>
          <div class="hint">
            Sets the GPU headroom budget (the monitor's "% free" readout). Doesn't
            cap the render loop — it's the frame time to measure against.
          </div>
          <select
            title="Target framerate (the GPU headroom budget)"
            .value=${String(settings.targetFps)}
            @change=${this.onTargetChange}>
            ${TARGET_FPS_OPTIONS.map(
              (t) => html`<option value=${t} ?selected=${t === settings.targetFps}>${t} FPS</option>`,
            )}
          </select>
        </section>
        ${this.renderConnectionSection()}
      </div>
    `;
  }

  /**
   * The four-step "get Resolume talking to this app" checklist.
   *
   * Every step carries both the instruction and its own live checkmark, so the
   * page answers "what do I do" and "which bit is broken" at once. Step order
   * is the order you'd actually do them in; the marks are independent, so a
   * later one can be green while an earlier one isn't (a plug-in installed by
   * hand, say).
   */
  private renderModules() {
    const m = this.modules;
    if (!m) return nothing;
    const loaded = m.bundles.filter((b) => b.origin !== 'builtin');
    return html`
      <section>
        <h2>Modules</h2>
        <div class="hint">
          Effect bundles beyond the built-in ones load from the modules folder
          and from any folder you add here — e.g. where you build your own
          effects. A bundle in an added folder replaces a built-in one of the
          same name, and reloads live when it is rebuilt.
        </div>
        ${m.defaultDir ? html`
          <div class="module-row">
            <span class="grow">Modules folder: <code>${m.defaultDir}</code></span>
            ${isElectron() ? html`<button class="small"
              @click=${() => { void revealInFolder(m.defaultDir!); }}>Reveal</button>` : nothing}
          </div>` : nothing}
        ${m.editable ? html`
          <ul class="module-list">
            ${m.paths.map((row, i) => html`
              <li class="module-row">
                <input type="checkbox" .checked=${row.enabled}
                  title="Load bundles from this folder"
                  @change=${(e: Event) => this.updateModulePaths(m.paths.map((r, j) =>
                    j === i ? { ...r, enabled: (e.target as HTMLInputElement).checked } : r))}>
                <span class="grow"><code>${row.path}</code></span>
                ${isElectron() ? html`<button class="small"
                  @click=${() => { void revealInFolder(row.path); }}>Reveal</button>` : nothing}
                <button class="small"
                  @click=${() => this.updateModulePaths(m.paths.filter((_, j) => j !== i))}>Remove</button>
              </li>`)}
            <li class="module-row">
              ${isElectron() ? html`
                <button class="small" @click=${this.onAddModuleFolder}>Add folder…</button>` : html`
                <input type="text" placeholder="/absolute/path/to/modules"
                  .value=${this.typedModulePath}
                  @input=${(e: Event) => { this.typedModulePath = (e.target as HTMLInputElement).value; }}>
                <button class="small" ?disabled=${!this.typedModulePath.trim()}
                  @click=${() => {
                    const p = this.typedModulePath.trim();
                    this.typedModulePath = '';
                    this.updateModulePaths([...m.paths, { path: p, enabled: true }]);
                  }}>Add</button>`}
            </li>
          </ul>` : html`
          <div class="note">Module folders need the desktop app (or the dev server).</div>`}
        ${this.modulesError ? html`<div class="note">${this.modulesError}</div>` : nothing}
        ${loaded.length ? html`
          <ul class="module-list">
            ${loaded.map((b) => html`
              <li class="module-row">
                <span>${bundleLabel(b.id)}</span>
                <span class="grow"><code>${b.path ?? b.url}</code></span>
                <span class="origin">${b.origin === 'mapped' ? 'added folder' : 'modules folder'}</span>
              </li>`)}
          </ul>` : html`<div class="hint">No extra bundles found.</div>`}
        <div class="hint">
          Removing a folder takes effect the next time the app starts. Resolume
          picks up any change the next time it loads the plugin.
        </div>
      </section>
    `;
  }

  private onAddModuleFolder = async () => {
    const m = this.modules;
    if (!m) return;
    try {
      const dir = absPathOf(await showDirectoryPicker());
      if (!dir || m.paths.some((r) => r.path === dir)) return;
      this.updateModulePaths([...m.paths, { path: dir, enabled: true }]);
    } catch (e) {
      this.modulesError = String(e);
    }
  };

  /** Persist the mapped folders, then load whatever they newly provide — an
   *  added folder's bundles are usable at once; the worker ignores bundles it
   *  already has. */
  private updateModulePaths(rows: ModulePathRow[]) {
    this.modulesError = '';
    void setModulePaths(rows).then((listing) => {
      this.modules = listing;
      for (const b of listing.bundles) appController.loadModule(b.id);
    }).catch((e) => { this.modulesError = String(e); });
  }

  private renderSetupChecklist() {
    const settings = appState.local.userSettings;
    const { probe, plugin, server, liveInstances, compositionInstances } = resolumeSetup;
    const st = setupStatuses({
      remoteEnabled: settings.barrelRemoteEnabled,
      probe, plugin, server, liveInstances, compositionInstances,
      appRoot: this.appRoot,
      barrelUrl: appState.local.barrelUrl,
      barrelMode: appState.local.barrelMode,
      barrelConnection: appState.local.barrelConnection,
    });
    const apiPort = resolumeApiPort(server?.resolumeUrl) || '8080';
    // The folder to hand Resolume: the app's own `ffgl/`, which holds the
    // plug-in and its sibling runtime. Both desktop platforms have one; a
    // browser tab has neither, so there is nothing to reveal there.
    const desktop = isMac() || isWindows();
    const pluginDir = this.appRoot && desktop ? `${this.appRoot}/ffgl` : null;
    // The two files that must travel together. The runtime is dlopen'd/
    // LoadLibrary'd by path, so a plug-in without its sibling simply does not
    // start — which is the one thing this step exists to prevent.
    const pluginFiles = isMac()
      ? html`<code>NanoBarrel.bundle</code> <b>and</b> <code>libbridge_server.dylib</code>`
      : html`<code>NanoBarrel.dll</code> <b>and</b> <code>libbridge_server.dll</code>`;
    const revealLabel = isMac() ? 'Reveal in Finder' : 'Show in Explorer';

    return html`
      <h2 style="margin-top:var(--app-sp-4)">Set up Resolume</h2>
      ${settings.barrelRemoteEnabled ? nothing : html`
        <div class="note">
          Resolume Remote is off, so none of these are being checked. Turn it on
          above to see live status.
        </div>`}
      <ol class="steps">
        ${this.renderStep('plugin', st.plugin, 'Install the NanoBarrel plug-in', html`
          Resolume loads FFGL plug-ins from the folders under
          <b>Preferences → Video → FFGL plug-in folders</b>. Add this app's
          <code>ffgl</code> folder there, or copy ${pluginFiles} side by side
          into a folder that is already listed — the plug-in on its own will not
          start. Restart Resolume afterwards.
        `, pluginDir ? html`
          <div class="actions">
            <button class="small" @click=${() => void revealInFolder(pluginDir)}>${revealLabel}</button>
            <button class="small" @click=${() => this.onCopy(pluginDir)}>
              ${this.copied === pluginDir ? 'Copied' : 'Copy path'}
            </button>
          </div>` : nothing)}

        ${this.renderStep('webserver', st.webserver, "Turn on Resolume's web server", html`
          <b>Preferences → Webserver</b>, enable it, and leave the port at
          <code>${apiPort}</code>. Rendering works without it, but instance
          names, composition scanning, clip launching and channel assignment all
          go quiet.
        `)}

        ${this.renderStep('instance', st.instance, 'Add NanoBarrel to your composition', html`
          Drop the NanoBarrel effect on a clip, a layer, or the composition.
          <b>On a clip or a layer it does not appear here until that content is
          actually playing</b> — trigger the clip, or any clip on that layer, at
          least once. A composition-level effect is live immediately.
        `)}

        ${this.renderStep('connect', st.connect, 'Connect this app', html`
          Switch to Remote Control and the editor binds to the instances above: sketch
          chains, wiring and MIDI all edit the running composition.
        `, appState.local.barrelMode ? nothing : html`
          <div class="actions">
            <button class="small" @click=${() => { void appController.switchAppMode('live'); }}>
              Switch to Remote Control
            </button>
          </div>`)}
      </ol>
    `;
  }

  private renderStep(
    id: SetupStepId,
    status: SetupStepStatus,
    title: string,
    how: TemplateResult,
    actions: TemplateResult | typeof nothing = nothing,
  ) {
    const mark = status.state === 'ok' ? '\u2713' : status.state === 'warn' ? '\u26a0' : '\u25cb';
    return html`
      <li class="step" data-step=${id} data-state=${status.state}>
        <div class="mark" aria-hidden="true">${mark}</div>
        <div class="step-body">
          <div class="step-title">${title}</div>
          <div class="step-how">${how}</div>
          ${status.detail ? html`<div class="step-detail">${status.detail}</div>` : nothing}
          ${actions}
        </div>
      </li>
    `;
  }

  private onCopy(text: string) {
    void copyText(text);
    this.copied = text;
    if (this.copyTimer != null) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => { this.copied = ''; this.copyTimer = null; }, 1500);
  }

  /**
   * Only shown while in Live's universe (attempting to connect, or already
   * offline-editing) — the "have an editable cached composition" case from
   * the feature request is `bootLiveOffline`'s own job (it seeds an empty
   * state gracefully when nothing's cached yet), so this just needs to
   * offer the same action the automatic snackbars already do, reachable
   * without waiting for the 5s timeout.
   */
  private renderConnectionSection() {
    const { barrelMode, liveOfflineMode, barrelConnection } = appState.local;
    if (!barrelMode && !liveOfflineMode) return null;

    if (liveOfflineMode) {
      return html`
        <section>
          <h2>Connection</h2>
          <div class="hint">Currently editing offline. Reconnecting reconciles any changes against Resolume's current composition.</div>
          <button class="mode-btn" style="flex:none" @click=${this.onTryReconnect}>
            <span class="label">Try reconnecting</span>
          </button>
        </section>
      `;
    }
    if (barrelConnection !== 'open') {
      return html`
        <section>
          <h2>Connection</h2>
          <div class="hint">Not connected to Resolume yet. You can switch to editing the offline copy right away instead of waiting.</div>
          <button class="mode-btn" style="flex:none" @click=${this.onEditOffline}>
            <span class="label">Edit offline</span>
          </button>
        </section>
      `;
    }
    return null;
  }

  private onToggleRemote = (e: Event) => {
    appController.setUserSetting('barrelRemoteEnabled', (e.target as HTMLInputElement).checked);
    // Off has to drop the live probe socket too, not just stop reconnecting.
    resolumeRemoteSettingChanged();
  };

  private onTargetChange = (e: Event) => {
    const v = parseInt((e.target as HTMLSelectElement).value, 10);
    if (!Number.isNaN(v)) appController.setUserSetting('targetFps', v);
  };

  private onEditOffline = () => {
    try { sessionStorage.setItem(LIVE_OFFLINE_KEY, '1'); } catch { /* ignore */ }
    location.reload();
  };

  private onTryReconnect = () => {
    try { sessionStorage.removeItem(LIVE_OFFLINE_KEY); } catch { /* ignore */ }
    location.reload();
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'app-settings': AppSettings;
  }
}
