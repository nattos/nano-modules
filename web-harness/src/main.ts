import { GPURenderer } from './gpu-renderer';
import { WasmHost, WasmModule, ConsoleEntry, ParamDecl } from './wasm-host';
import { FAKE_PARAMS, FakeParam } from './fake-resolume-params';

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

    if (param.type === 0) {
      const btn = document.createElement('button');
      btn.className = 'param-btn';
      btn.textContent = param.name;
      btn.setAttribute('data-param', String(param.index));
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        host.frameState.params[param.index] = 1.0;
        wasmModule.onParamChange(param.index, 1.0);
        btn.classList.add('active');
      });
      btn.addEventListener('mouseup', () => {
        host.frameState.params[param.index] = 0.0;
        wasmModule.onParamChange(param.index, 0.0);
        btn.classList.remove('active');
      });
      btn.addEventListener('mouseleave', () => {
        if (host.frameState.params[param.index] > 0.5) {
          host.frameState.params[param.index] = 0.0;
          wasmModule.onParamChange(param.index, 0.0);
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
        host.frameState.params[param.index] = val;
        wasmModule.onParamChange(param.index, val);
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

  // Register all fake param paths
  for (const fp of FAKE_PARAMS) {
    host.registerParamPath(fp.id, fp.path);
    // Also seed the param cache so get_param works
    host.pluginState[`_rparam_${fp.id}`] = fp.value;
  }

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
        valueEl.textContent = val.toFixed(2);
        fireResolumeParam(host, wasmModule, fp.id, val);
      });
      row.appendChild(slider);
    } else {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = fp.value > 0.5;
      cb.addEventListener('change', () => {
        const val = cb.checked ? 1.0 : 0.0;
        fp.value = val;
        valueEl.textContent = val.toFixed(0);
        fireResolumeParam(host, wasmModule, fp.id, val);
      });
      valueEl.textContent = fp.value.toFixed(0);
      row.appendChild(cb);
    }

    row.appendChild(valueEl);
    resolumeContentEl.appendChild(row);
  }
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

  // Determine module from URL or selector
  const urlParams = new URLSearchParams(window.location.search);
  const initialModule = urlParams.get('module') || 'nanolooper';
  moduleSelect.value = initialModule;

  async function loadModule(moduleName: string) {
    statusEl.textContent = `Loading ${moduleName}.wasm...`;
    consoleEl.innerHTML = '';
    resolumeContentEl.innerHTML = '';

    const host = new WasmHost();
    host.onAudioTrigger = triggerAudio;
    host.onStateChange = (state) => updateStateDisplay(state);
    host.onLog = (entry) => addLogEntry(entry);

    let wasmModule: WasmModule;
    try {
      wasmModule = await host.load(`${moduleName}.wasm`);
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

    // Build parameter UI
    const keyBindings = buildParamUI(host.params, host, wasmModule);
    const keyToParam: Record<string, number> = {};
    for (const [idx, key] of Object.entries(keyBindings)) {
      keyToParam[key] = parseInt(idx);
    }

    // Build Resolume param panel (show for all modules)
    resolumePanelEl.style.display = '';
    buildResolumePanel(host, wasmModule);

    // State editor
    stateEditBtn.onclick = () => {
      stateEditing = true;
      stateTextarea.value = JSON.stringify(host.pluginState, null, 2);
      stateContentEl.style.display = 'none';
      stateEditorEl.style.display = 'block';
      stateTextarea.focus();
    };
    stateApplyBtn.onclick = () => {
      try {
        const newState = JSON.parse(stateTextarea.value);
        host.pluginState = newState;
        wasmModule.onStateChanged();
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
        host.frameState.params[paramIdx] = 1.0;
        wasmModule.onParamChange(paramIdx, 1.0);
        const btn = paramsEl.querySelector(`[data-param="${paramIdx}"]`);
        if (btn) btn.classList.add('active');
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (stateEditing) return;
      const key = e.key.toLowerCase();
      const paramIdx = keyToParam[key];
      if (paramIdx !== undefined) {
        host.frameState.params[paramIdx] = 0.0;
        wasmModule.onParamChange(paramIdx, 0.0);
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
      host.drawList = [];
      wasmModule.render(vpW, vpH);

      renderer.beginFrame(vpW, vpH);
      renderer.execute(host.drawList);
      renderer.endFrame();

      const step = Math.floor(barPhase * 16);
      statusEl.textContent = `${fps} FPS | ${bpm} BPM | Step ${step + 1}/16 | ${host.drawList.length} cmds`;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);

    // Return cleanup function
    return () => {
      running = false;
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
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
