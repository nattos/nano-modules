/**
 * Sketch Editor — main app entry point.
 *
 * Three-tab UI for creating, organizing, and editing module effect chains.
 * All WASM/GPU execution runs in a Web Worker via EngineProxy.
 */

import { EngineProxy } from './engine-proxy';
import type { EngineState, PluginInfo } from './engine-types';
import type { Sketch, ChainEntry } from './sketch-types';

// --- App state ---

interface StagingInstance {
  pluginKey: string;
  moduleType: string;
  name: string;
  textureIn: boolean;
  textureOut: boolean;
}

interface AppState {
  activeTab: 'create' | 'organize' | 'edit';
  plugins: PluginInfo[];
  sketches: Record<string, Sketch>;
  staging: StagingInstance[];
  selectedSketchId: string | null;
  editingSketchId: string | null;
}

const state: AppState = {
  activeTab: 'create',
  plugins: [],
  sketches: {},
  staging: [],
  selectedSketchId: null,
  editingSketchId: null,
};

let engine: EngineProxy;
let nextSketchId = 0;

// --- DOM references ---

const mainArea = document.getElementById('main-area')!;
const rightContent = document.getElementById('right-content')!;
const tabStatus = document.getElementById('tab-status')!;
const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tab-btn');

// --- Tab switching ---

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab as AppState['activeTab'];
    if (tab === state.activeTab) return;
    state.activeTab = tab;
    tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    render();
  });
});

function switchTab(tab: AppState['activeTab']) {
  state.activeTab = tab;
  tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  render();
}

// --- Render ---

function render() {
  switch (state.activeTab) {
    case 'create': renderCreateTab(); break;
    case 'organize': renderOrganizeTab(); break;
    case 'edit': renderEditTab(); break;
  }
}

// --- Create Tab ---

function renderCreateTab() {
  // Main area: plugin list
  if (state.plugins.length === 0) {
    mainArea.innerHTML = `<div class="empty-state">No modules loaded.<br>Load a module to get started.</div>`;
  } else {
    mainArea.innerHTML = `
      <div class="plugin-list">
        ${state.plugins.map(p => `
          <div class="plugin-card" data-key="${esc(p.key)}">
            <div class="plugin-card-info">
              <div class="plugin-card-name">${esc(shortName(p.id))}</div>
              <div class="plugin-card-key">${esc(p.key)} &middot; ${esc(moduleKind(p))} &middot; ${p.params.length} params</div>
            </div>
            <button class="panel-btn add-to-staging">Add</button>
          </div>
        `).join('')}
      </div>
    `;

    mainArea.querySelectorAll('.add-to-staging').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.plugin-card') as HTMLElement;
        const key = card.dataset.key!;
        const plugin = state.plugins.find(p => p.key === key);
        if (!plugin) return;
        // Don't add duplicates
        if (state.staging.some(s => s.pluginKey === key)) return;
        state.staging.push({
          pluginKey: key,
          moduleType: plugin.id,
          name: shortName(plugin.id),
          textureIn: false,
          textureOut: true,
        });
        render();
      });
    });
  }

  // Right panel: staging
  renderStagingPanel();
}

function renderStagingPanel() {
  let html = `<div class="staging-header">New Sketch</div>`;

  if (state.staging.length === 0) {
    html += `<div class="empty-state" style="padding:16px 0">Add instances from the left panel</div>`;
  } else {
    html += `<div class="staging-list">`;
    for (let i = 0; i < state.staging.length; i++) {
      const s = state.staging[i];
      html += `
        <div class="instance-row" data-idx="${i}">
          <span class="instance-row-name">${esc(s.name)}</span>
          <button class="toggle-btn ${s.textureIn ? 'active' : ''}" data-toggle="in">In</button>
          <button class="toggle-btn ${s.textureOut ? 'active' : ''}" data-toggle="out">Out</button>
          <button class="remove-btn" data-action="remove">&times;</button>
        </div>
      `;
    }
    html += `</div>`;
    html += `<button class="panel-btn" id="create-sketch-btn" style="width:100%;padding:6px">Create Sketch</button>`;
  }

  rightContent.innerHTML = html;

  // Wire toggle buttons
  rightContent.querySelectorAll('.instance-row').forEach(row => {
    const idx = parseInt((row as HTMLElement).dataset.idx!);
    row.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = (btn as HTMLElement).dataset.toggle!;
        if (field === 'in') state.staging[idx].textureIn = !state.staging[idx].textureIn;
        if (field === 'out') state.staging[idx].textureOut = !state.staging[idx].textureOut;
        render();
      });
    });
    row.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
      state.staging.splice(idx, 1);
      render();
    });
  });

  // Wire create button
  document.getElementById('create-sketch-btn')?.addEventListener('click', () => {
    createSketchFromStaging();
  });
}

function createSketchFromStaging() {
  if (state.staging.length === 0) return;

  const outInstances = state.staging.filter(s => s.textureOut);
  const inInstances = state.staging.filter(s => s.textureIn);

  // Build columns: one per "out" instance
  const columns = outInstances.map(out => {
    const chain: ChainEntry[] = [
      { type: 'texture_input', id: 'primary_in' },
    ];

    // If there's an "in" instance, add it as the source
    if (inInstances.length > 0) {
      chain.push({
        type: 'module',
        module_type: inInstances[0].moduleType,
        instance_key: inInstances[0].pluginKey,
        params: {},
      });
    }

    // Add the "out" instance
    chain.push({
      type: 'module',
      module_type: out.moduleType,
      instance_key: out.pluginKey,
      params: {},
    });

    chain.push({ type: 'texture_output', id: 'primary_out' });

    return { name: shortName(out.moduleType), chain };
  });

  // If no "out" instances, create a single default column
  if (columns.length === 0) {
    columns.push({
      name: 'main',
      chain: [
        { type: 'texture_input', id: 'primary_in' },
        { type: 'texture_output', id: 'primary_out' },
      ],
    });
  }

  const anchor = outInstances[0]?.pluginKey ?? inInstances[0]?.pluginKey ?? null;
  const sketch: Sketch = { anchor, columns };
  const sketchId = `sketch_${nextSketchId++}`;

  engine.createSketch(sketchId, sketch);
  state.sketches[sketchId] = sketch;
  state.staging = [];
  state.selectedSketchId = sketchId;
  switchTab('organize');
}

// --- Organize Tab ---

function renderOrganizeTab() {
  const sketchIds = Object.keys(state.sketches);

  if (sketchIds.length === 0) {
    mainArea.innerHTML = `<div class="empty-state">No sketches yet.<br>Go to Create to make one.</div>`;
  } else {
    mainArea.innerHTML = `
      <div class="sketch-list">
        ${sketchIds.map(id => {
          const s = state.sketches[id];
          const selected = id === state.selectedSketchId;
          return `
            <div class="sketch-card ${selected ? 'selected' : ''}" data-id="${esc(id)}">
              <div class="sketch-card-name">${esc(id)}</div>
              <div class="sketch-card-info">
                Anchor: ${esc(s.anchor ?? 'none')}
                &middot; ${s.columns.length} column${s.columns.length !== 1 ? 's' : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    mainArea.querySelectorAll('.sketch-card').forEach(card => {
      card.addEventListener('click', () => {
        state.selectedSketchId = (card as HTMLElement).dataset.id!;
        render();
      });
    });
  }

  // Right panel: selected sketch summary
  if (state.selectedSketchId && state.sketches[state.selectedSketchId]) {
    const sketch = state.sketches[state.selectedSketchId];
    const totalEntries = sketch.columns.reduce((sum, c) => sum + c.chain.length, 0);
    rightContent.innerHTML = `
      <div class="staging-header">Sketch: ${esc(state.selectedSketchId)}</div>
      <div style="font-size:11px;color:var(--app-text-color2);margin-bottom:12px">
        <div>Anchor: ${esc(sketch.anchor ?? 'none')}</div>
        <div>Columns: ${sketch.columns.length}</div>
        <div>Chain entries: ${totalEntries}</div>
      </div>
      <button class="panel-btn" id="edit-sketch-btn" style="width:100%;padding:6px">Edit</button>
    `;
    document.getElementById('edit-sketch-btn')?.addEventListener('click', () => {
      state.editingSketchId = state.selectedSketchId;
      switchTab('edit');
    });
  } else {
    rightContent.innerHTML = `<div class="empty-state" style="padding:16px 0">Select a sketch to see details</div>`;
  }
}

// --- Edit Tab ---

function renderEditTab() {
  const sketchId = state.editingSketchId;
  if (!sketchId || !state.sketches[sketchId]) {
    mainArea.innerHTML = `<div class="empty-state">No sketch selected for editing.<br>Go to Organize and pick one.</div>`;
    rightContent.innerHTML = '';
    return;
  }

  const sketch = state.sketches[sketchId];
  // Render the first column (for now)
  const column = sketch.columns[0];
  if (!column) {
    mainArea.innerHTML = `<div class="empty-state">Empty sketch.</div>`;
    rightContent.innerHTML = '';
    return;
  }

  let html = `<div class="chain-column">`;

  for (let i = 0; i < column.chain.length; i++) {
    const entry = column.chain[i];

    if (entry.type === 'texture_input') {
      html += `<div class="chain-marker">Texture Input</div>`;
      html += `<div class="chain-wire"></div>`;
      html += renderAddButton(sketchId, 0, i + 1);
      html += `<div class="chain-wire"></div>`;
    } else if (entry.type === 'texture_output') {
      html += `<div class="chain-marker">Texture Output</div>`;
    } else if (entry.type === 'module') {
      html += `
        <div class="effect-card" data-chain-idx="${i}">
          <div class="effect-card-header">
            <span class="effect-card-name">${esc(shortName(entry.module_type))}</span>
            <button class="remove-btn remove-effect" data-idx="${i}">&times;</button>
          </div>
          ${renderEffectParams(entry, i)}
        </div>
      `;
      html += `<div class="chain-wire"></div>`;
      // Add button after this module (before next entry)
      if (i + 1 < column.chain.length && column.chain[i + 1].type !== 'texture_output') {
        html += renderAddButton(sketchId, 0, i + 1);
        html += `<div class="chain-wire"></div>`;
      } else if (i + 1 < column.chain.length && column.chain[i + 1].type === 'texture_output') {
        html += renderAddButton(sketchId, 0, i + 1);
        html += `<div class="chain-wire"></div>`;
      }
    }
  }

  html += `</div>`;
  mainArea.innerHTML = html;

  // Wire add buttons
  mainArea.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const insertIdx = parseInt(el.dataset.insertIdx!);
      addEffectToChain(sketchId, 0, insertIdx);
    });
  });

  // Wire remove buttons
  mainArea.querySelectorAll('.remove-effect').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx!);
      removeEffectFromChain(sketchId, 0, idx);
    });
  });

  // Wire param sliders
  mainArea.querySelectorAll('.effect-param-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const el = slider as HTMLInputElement;
      const chainIdx = parseInt(el.dataset.chainIdx!);
      const paramKey = el.dataset.paramKey!;
      const value = parseFloat(el.value);

      const entry = column.chain[chainIdx];
      if (entry.type === 'module') {
        entry.params[paramKey] = value;
        engine.updateSketch(sketchId, sketch);
      }

      // Update value display
      const valueEl = el.parentElement?.querySelector('.effect-param-value');
      if (valueEl) valueEl.textContent = value.toFixed(2);
    });
  });

  // Right panel: preview info
  rightContent.innerHTML = `
    <div class="staging-header">Preview</div>
    <div class="empty-state" style="padding:16px 0">
      Live preview renders in the canvas below
    </div>
  `;
}

function renderAddButton(_sketchId: string, _colIdx: number, insertIdx: number): string {
  return `<button class="add-btn" data-insert-idx="${insertIdx}">+</button>`;
}

function renderEffectParams(entry: { type: 'module'; module_type: string; instance_key: string; params: Record<string, number> }, chainIdx: number): string {
  // Look up params from the plugin info (loaded modules know their params)
  const plugin = state.plugins.find(p => p.id === entry.module_type);
  const knownParams: { key: string; name: string; defaultValue: number }[] = [];

  if (plugin) {
    for (const p of plugin.params) {
      // Only show Standard (10) params as sliders for now
      if (p.type === 10) {
        knownParams.push({ key: String(p.index), name: p.name, defaultValue: p.defaultValue });
      }
    }
  }

  if (knownParams.length === 0) return '';

  return knownParams.map(p => {
    const value = entry.params[p.key] ?? p.defaultValue;
    return `
      <div class="effect-param">
        <span class="effect-param-label">${esc(p.name)}</span>
        <input type="range" class="effect-param-slider" min="0" max="1" step="0.01"
               value="${value}" data-param-key="${esc(p.key)}"
               data-chain-idx="${chainIdx}">
        <span class="effect-param-value">${value.toFixed(2)}</span>
      </div>
    `;
  }).join('');
}

function addEffectToChain(sketchId: string, colIdx: number, insertIdx: number) {
  const sketch = state.sketches[sketchId];
  if (!sketch) return;

  const column = sketch.columns[colIdx];
  if (!column) return;

  const instanceKey = `virtual_bc@${Date.now()}`;
  const newEntry: ChainEntry = {
    type: 'module',
    module_type: 'com.nattos.brightness_contrast',
    instance_key: instanceKey,
    params: { '0': 0.5, '1': 0.5 },
  };

  column.chain.splice(insertIdx, 0, newEntry);
  engine.updateSketch(sketchId, sketch);
  render();
}

function removeEffectFromChain(sketchId: string, colIdx: number, chainIdx: number) {
  const sketch = state.sketches[sketchId];
  if (!sketch) return;

  const column = sketch.columns[colIdx];
  if (!column) return;

  const entry = column.chain[chainIdx];
  if (entry.type !== 'module') return; // only remove modules

  column.chain.splice(chainIdx, 1);
  engine.updateSketch(sketchId, sketch);
  render();
}

// --- Helpers ---

function moduleKind(p: PluginInfo): string {
  const texInputs = p.io.filter(io => io.kind === 0).length;  // IO_TEXTURE_INPUT
  const texOutputs = p.io.filter(io => io.kind === 1).length; // IO_TEXTURE_OUTPUT
  if (texInputs === 0 && texOutputs > 0) return 'generator';
  if (texInputs === 1 && texOutputs > 0) return 'effect';
  if (texInputs >= 2 && texOutputs > 0) return 'mixer';
  if (texInputs === 0 && texOutputs === 0) return 'control';
  return 'module';
}

function shortName(moduleId: string): string {
  // "com.nattos.brightness_contrast" → "brightness_contrast"
  return moduleId.split('.').pop() ?? moduleId;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Init ---

async function main() {
  const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;

  // Set canvas size
  canvas.width = 320;
  canvas.height = 180;

  // Create engine (spins up worker with OffscreenCanvas)
  engine = new EngineProxy(canvas);

  engine.onStateUpdate = (engineState: EngineState) => {
    state.plugins = engineState.plugins;
    state.sketches = { ...state.sketches, ...engineState.sketches };
    render();
  };

  engine.onFps = (fps) => {
    tabStatus.textContent = `${fps} FPS`;
  };

  engine.onError = (msg) => {
    tabStatus.textContent = `Error: ${msg}`;
  };

  // Load default modules so they appear in the Create tab.
  // In production, these would come from Resolume composition discovery.
  engine.loadModule('com.nattos.spinningtris');
  engine.loadModule('com.nattos.nanolooper');
  engine.loadModule('com.nattos.gpu_test');
  engine.loadModule('com.nattos.brightness_contrast');
  engine.loadModule('com.nattos.paramlinker');

  render();
}

main();
