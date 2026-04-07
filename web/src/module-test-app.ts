import { GPURenderer } from './gpu-renderer';
import { GPUHost } from './gpu-host';
import { WasmHost, WasmModule, ConsoleEntry, ParamDecl } from './wasm-host';
import { BridgeCore, BridgeCoreClient } from './bridge-core';
import { FAKE_PARAMS, FakeParam } from './fake-resolume-params';
import { ModuleClient } from './module-client';
import { editorRegistry } from './editor-registry';

// Import editor registrations
import './editors/paramlinker-editor';

const FREQUENCIES = [523.25, 659.26, 783.99, 1046.50];

let audioCtx: AudioContext | null = null;

function triggerAudio(channel: number) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = FREQUENCIES[channel % 4];
  gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.25);
}

// --- Side Panel Elements ---
const metadataEl = document.getElementById('metadata-content')!;
const stateContentEl = document.getElementById('state-content')!;
const stateEditorEl = document.getElementById('state-editor')!;
const stateTextarea = document.getElementById('state-textarea') as HTMLTextAreaElement;
const consoleEl = document.getElementById('console-content')!;
const paramsEl = document.getElementById('params-content')!;
const editorPanelEl = document.getElementById('panel-editor')!;
const editorContentEl = document.getElementById('editor-content')!;
const resolumePanelEl = document.getElementById('panel-resolume')!;
const resolumeContentEl = document.getElementById('resolume-content')!;
const legendEl = document.getElementById('legend')!;
const stateEditBtn = document.getElementById('state-edit-btn')!;
const stateApplyBtn = document.getElementById('state-apply-btn')!;
const stateCancelBtn = document.getElementById('state-cancel-btn')!;
const moduleSelect = document.getElementById('module-select') as HTMLSelectElement;

let stateEditing = false;

function updateMetadata(host: WasmHost) {
  if (host.metadata) {
    metadataEl.textContent = `${host.metadata.id} v${host.metadata.version}`;
  }
}

function updateStateDisplay(state: any) {
  if (!stateEditing) {
    stateContentEl.textContent = JSON.stringify(state, null, 2);
  }
}

function addLogEntry(entry: ConsoleEntry) {
  const div = document.createElement('div');
  div.className = `log-entry log-${entry.level}`;
  let html = `<span class="log-time">${entry.timestamp.toFixed(1)}s</span>`;
  html += `<span class="log-msg">${escapeHtml(entry.message)}`;
  if (entry.data !== undefined) {
    html += ` <span class="log-data">${escapeHtml(JSON.stringify(entry.data))}</span>`;
  }
  html += `</span>`;
  div.innerHTML = html;
  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
  while (consoleEl.children.length > 200) consoleEl.removeChild(consoleEl.firstChild!);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setParam(host: WasmHost, wasmModule: WasmModule, index: number, value: number) {
  host.frameState.params[index] = value;
  const param = host.params.find(p => p.index === index);
  host.notifyStatePatched(wasmModule, [
    { op: 'replace', path: param?.name ?? String(index), value },
  ]);
}

// --- Build parameter controls ---
function buildParamUI(params: ParamDecl[], host: WasmHost, wasmModule: WasmModule) {
  paramsEl.innerHTML = '';
  legendEl.innerHTML = '';

  const keys = ['1','2','3','4','d','m','z','x','r','o','s','g'];
  let keyIdx = 0;
  const keyBindings: Record<number, string> = {};

  for (const param of params) {
    const row = document.createElement('div');
    row.className = 'param-row';

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = param.name;
    row.appendChild(label);

    const control = document.createElement('div');
    control.className = 'param-control';

    if (param.type === 0 || param.type === 1) {  // boolean or event → button
      const btn = document.createElement('button');
      btn.className = 'param-btn';
      btn.textContent = param.name;
      btn.setAttribute('data-param', String(param.index));
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        setParam(host, wasmModule, param.index, 1.0);
        btn.classList.add('active');
      });
      btn.addEventListener('mouseup', () => {
        setParam(host, wasmModule, param.index, 0.0);
        btn.classList.remove('active');
      });
      btn.addEventListener('mouseleave', () => {
        if (host.frameState.params[param.index] > 0.5) {
          setParam(host, wasmModule, param.index, 0.0);
          btn.classList.remove('active');
        }
      });
      control.appendChild(btn);

      if (keyIdx < keys.length) {
        keyBindings[param.index] = keys[keyIdx];
        const span = document.createElement('span');
        span.innerHTML = `<b>${keys[keyIdx].toUpperCase()}</b> ${escapeHtml(param.name)}`;
        legendEl.appendChild(span);
        keyIdx++;
      }
    } else if (param.type === 10) {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'param-slider';
      slider.min = '0';
      slider.max = '1';
      slider.step = '0.01';
      slider.value = String(param.defaultValue);
      host.frameState.params[param.index] = param.defaultValue;
      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        setParam(host, wasmModule, param.index, val);
      });
      control.appendChild(slider);
    }

    row.appendChild(control);
    paramsEl.appendChild(row);
  }

  return keyBindings;
}

// --- Build Resolume fake param panel ---
function buildResolumePanel(host: WasmHost, wasmModule: WasmModule) {
  resolumeContentEl.innerHTML = '';
  const bc = host.bridgeCore;

  // Register all fake param paths and seed values
  for (const fp of FAKE_PARAMS) {
    if (bc) {
      bc.setParamPath(fp.id, fp.path);
      bc.setParam(fp.id, fp.value);
    }
  }

  // Map param IDs to their slider/checkbox elements for write-back
  const paramElements = new Map<bigint, { slider?: HTMLInputElement, checkbox?: HTMLInputElement, valueEl: HTMLElement }>();

  for (const fp of FAKE_PARAMS) {
    const row = document.createElement('div');
    row.className = 'resolume-param-row';

    const label = document.createElement('span');
    label.className = 'resolume-param-label';
    label.title = fp.path;
    // Show short path
    const shortPath = fp.path.split('/').slice(-2).join('/');
    label.textContent = shortPath;
    row.appendChild(label);

    const valueEl = document.createElement('span');
    valueEl.className = 'resolume-param-value';

    if (fp.type === 'range') {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'resolume-param-slider';
      slider.min = String(fp.min);
      slider.max = String(fp.max);
      slider.step = String((fp.max - fp.min) / 100);
      slider.value = String(fp.value);
      valueEl.textContent = fp.value.toFixed(2);
      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        fp.value = val;
        if (bc) bc.setParam(fp.id, val);
        valueEl.textContent = val.toFixed(2);
        fireResolumeParam(host, wasmModule, fp.id, val);
      });
      row.appendChild(slider);
      paramElements.set(fp.id, { slider, valueEl });
    } else {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = fp.value > 0.5;
      cb.addEventListener('change', () => {
        const val = cb.checked ? 1.0 : 0.0;
        fp.value = val;
        if (bc) bc.setParam(fp.id, val);
        valueEl.textContent = val.toFixed(0);
        fireResolumeParam(host, wasmModule, fp.id, val);
      });
      valueEl.textContent = fp.value.toFixed(0);
      row.appendChild(cb);
      paramElements.set(fp.id, { checkbox: cb, valueEl });
    }

    row.appendChild(valueEl);
    resolumeContentEl.appendChild(row);
  }

  // Handle write-back from WASM module (resolume.set_param)
  host.onResolumeParamSet = (id: bigint, value: number) => {
    const el = paramElements.get(id);
    if (!el) return;
    if (el.slider) {
      el.slider.value = String(value);
      el.valueEl.textContent = value.toFixed(2);
    } else if (el.checkbox) {
      el.checkbox.checked = value > 0.5;
      el.valueEl.textContent = value.toFixed(0);
    }
    // Update the fake param data too
    const fp = FAKE_PARAMS.find(p => p.id === id);
    if (fp) fp.value = value;
  };
}

function fireResolumeParam(host: WasmHost, wasmModule: WasmModule, paramId: bigint, value: number) {
  // Check if any subscription query matches (simple: "/*" or "*" matches everything)
  const matches = host.subscribeQueries.some(q => q === '/*' || q === '*');
  if (matches && wasmModule.onResolumeParam) {
    wasmModule.onResolumeParam(paramId, value);
  }
}

// --- Main ---
async function main() {
  const statusEl = document.getElementById('status')!;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  if (!navigator.gpu) {
    statusEl.textContent = 'WebGPU not supported in this browser';
    return;
  }

  const renderer = new GPURenderer();
  if (!await renderer.init(canvas)) {
    statusEl.textContent = 'Failed to initialize WebGPU';
    return;
  }

  // Load the shared bridge core
  statusEl.textContent = 'Loading bridge core...';
  const bridgeCore = new BridgeCore();
  await bridgeCore.init();

  // Determine module from URL or selector
  const urlParams = new URLSearchParams(window.location.search);
  const initialModule = urlParams.get('module') || 'nanolooper';
  moduleSelect.value = initialModule;

  async function loadModule(moduleName: string) {
    statusEl.textContent = `Loading ${moduleName}.wasm...`;
    consoleEl.innerHTML = '';
    resolumeContentEl.innerHTML = '';

    const host = new WasmHost();
    host.bridgeCore = bridgeCore;
    host.gpuHost = new GPUHost(renderer.device, renderer.format);
    host.onAudioTrigger = triggerAudio;
    host.onStateChange = (state) => updateStateDisplay(state);
    host.onLog = (entry) => addLogEntry(entry);

    let wasmModule: WasmModule;
    try {
      wasmModule = await host.load(`wasm/${moduleName}.wasm`);
    } catch (e) {
      statusEl.textContent = `WASM load failed: ${e}`;
      return;
    }

    wasmModule.init();
    updateMetadata(host);
    statusEl.textContent = 'Running';

    // Expose for debugging
    (window as any).__host = host;
    (window as any).__wasm = wasmModule;
    (window as any).__bridgeCore = bridgeCore;

    // Build parameter UI
    const keyBindings = buildParamUI(host.params, host, wasmModule);
    const keyToParam: Record<string, number> = {};
    for (const [idx, key] of Object.entries(keyBindings)) {
      keyToParam[key] = parseInt(idx);
    }

    // Build Resolume param panel (show for all modules)
    resolumePanelEl.style.display = '';
    buildResolumePanel(host, wasmModule);

    // Mount editor if one is registered for this module type
    let moduleClient: ModuleClient | null = null;
    let editorEl: HTMLElement | null = null;
    editorContentEl.innerHTML = '';
    editorPanelEl.style.display = 'none';

    if (host.metadata) {
      const factory = editorRegistry.getFactory(host.metadata.id);
      if (factory) {
        const pluginKey = host.pluginKey || `${host.metadata.id}@0`;
        const editorClient = new BridgeCoreClient(bridgeCore);
        moduleClient = new ModuleClient(pluginKey, host, wasmModule, editorClient);
        editorEl = factory.create(pluginKey, moduleClient);
        editorContentEl.appendChild(editorEl);
        editorPanelEl.style.display = '';
      }
    }

    // State editor
    stateEditBtn.onclick = () => {
      stateEditing = true;
      const currentState = host.bridgeCore && host.pluginKey
        ? host.bridgeCore.getPluginState(host.pluginKey)
        : host.pluginState;
      stateTextarea.value = JSON.stringify(currentState, null, 2);
      stateContentEl.style.display = 'none';
      stateEditorEl.style.display = 'block';
      stateTextarea.focus();
    };
    stateApplyBtn.onclick = () => {
      try {
        const newState = JSON.parse(stateTextarea.value);
        if (host.bridgeCore && host.pluginKey) {
          host.bridgeCore.setPluginState(host.pluginKey, newState);
          host.pluginState = newState;
        } else {
          host.pluginState = newState;
        }
        host.notifyStatePatched(wasmModule, [{ op: 'replace', path: '/', value: newState }]);
        addLogEntry({ timestamp: host.frameState.elapsedTime, level: 'log', message: 'State patch applied externally' });
      } catch (e) {
        addLogEntry({ timestamp: host.frameState.elapsedTime, level: 'error', message: `Invalid JSON: ${e}` });
      }
      stateEditing = false;
      stateContentEl.style.display = '';
      stateEditorEl.style.display = 'none';
    };
    stateCancelBtn.onclick = () => {
      stateEditing = false;
      stateContentEl.style.display = '';
      stateEditorEl.style.display = 'none';
    };

    // Audio init
    const initAudio = () => {
      if (!audioCtx) audioCtx = new AudioContext();
      document.removeEventListener('keydown', initAudio);
      document.removeEventListener('mousedown', initAudio);
    };
    document.addEventListener('keydown', initAudio);
    document.addEventListener('mousedown', initAudio);

    // Keyboard
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || stateEditing) return;
      const key = e.key.toLowerCase();
      const paramIdx = keyToParam[key];
      if (paramIdx !== undefined) {
        setParam(host, wasmModule, paramIdx, 1.0);
        const btn = paramsEl.querySelector(`[data-param="${paramIdx}"]`);
        if (btn) btn.classList.add('active');
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (stateEditing) return;
      const key = e.key.toLowerCase();
      const paramIdx = keyToParam[key];
      if (paramIdx !== undefined) {
        setParam(host, wasmModule, paramIdx, 0.0);
        const btn = paramsEl.querySelector(`[data-param="${paramIdx}"]`);
        if (btn) btn.classList.remove('active');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // Render loop
    let lastTime = performance.now() / 1000;
    let elapsed = 0;
    let frameCount = 0;
    let fpsTime = 0;
    let fps = 0;
    const bpm = 120;
    let running = true;

    function frame() {
      if (!running) return;
      const now = performance.now() / 1000;
      const dt = now - lastTime;
      lastTime = now;
      elapsed += dt;

      frameCount++;
      fpsTime += dt;
      if (fpsTime >= 1.0) { fps = frameCount; frameCount = 0; fpsTime = 0; }

      const dpr = window.devicePixelRatio || 1;
      const displayW = Math.floor(canvas.clientWidth * dpr);
      const displayH = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== displayW || canvas.height !== displayH) {
        canvas.width = displayW;
        canvas.height = displayH;
      }

      const vpW = canvas.width;
      const vpH = canvas.height;
      const barPhase = (elapsed * bpm / 60 / 4) % 1.0;
      host.frameState.elapsedTime = elapsed;
      host.frameState.deltaTime = dt;
      host.frameState.barPhase = barPhase;
      host.frameState.bpm = bpm;
      host.frameState.viewportW = vpW;
      host.frameState.viewportH = vpH;

      wasmModule.tick(dt);

      // Tick bridge core to broadcast state patches
      bridgeCore.tick();

      // Drain messages for any active editor client
      if (moduleClient) moduleClient.drainMessages();

      // Set GPU surface each frame (module may or may not use it)
      if (host.gpuHost) {
        const surfaceTex = renderer.context.getCurrentTexture();
        host.gpuHost.setSurface(surfaceTex, vpW, vpH);
      }

      host.drawList = [];
      wasmModule.render(vpW, vpH);

      // If draw list has commands, render via canvas path
      // If empty, module used gpu.* calls directly (GPU mode)
      if (host.drawList.length > 0) {
        renderer.beginFrame(vpW, vpH);
        renderer.execute(host.drawList);
        renderer.endFrame();
      }

      const step = Math.floor(barPhase * 16);
      statusEl.textContent = `${fps} FPS | ${bpm} BPM | Step ${step + 1}/16`;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);

    // Return cleanup function
    return () => {
      running = false;
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      if (moduleClient) { moduleClient.dispose(); moduleClient = null; }
      if (editorEl) {
        const factory = host.metadata ? editorRegistry.getFactory(host.metadata.id) : undefined;
        if (factory) factory.destroy(editorEl);
        editorContentEl.innerHTML = '';
        editorPanelEl.style.display = 'none';
        editorEl = null;
      }
    };
  }

  let cleanup: (() => void) | undefined;
  cleanup = await loadModule(initialModule);

  // Module selector
  moduleSelect.addEventListener('change', async () => {
    if (cleanup) cleanup();
    cleanup = await loadModule(moduleSelect.value);
    // Update URL
    const url = new URL(window.location.href);
    url.searchParams.set('module', moduleSelect.value);
    window.history.replaceState({}, '', url.toString());
  });
}

main();
