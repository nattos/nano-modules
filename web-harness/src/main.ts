import { GPURenderer } from './gpu-renderer';
import { WasmHost, WasmModule, ConsoleEntry, ParamDecl } from './wasm-host';

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

// --- Side Panel ---
const metadataEl = document.getElementById('metadata-content')!;
const stateContentEl = document.getElementById('state-content')!;
const stateEditorEl = document.getElementById('state-editor')!;
const stateTextarea = document.getElementById('state-textarea') as HTMLTextAreaElement;
const consoleEl = document.getElementById('console-content')!;
const paramsEl = document.getElementById('params-content')!;
const legendEl = document.getElementById('legend')!;
const stateEditBtn = document.getElementById('state-edit-btn')!;
const stateApplyBtn = document.getElementById('state-apply-btn')!;
const stateCancelBtn = document.getElementById('state-cancel-btn')!;

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
function buildParamUI(
  params: ParamDecl[],
  host: WasmHost,
  wasmModule: WasmModule,
) {
  paramsEl.innerHTML = '';
  legendEl.innerHTML = '';

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
      // BOOLEAN — momentary button (press/release)
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
    } else if (param.type === 10) {
      // STANDARD — slider 0-1
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

  // Build compact keyboard legend from params
  const keyBindings: Record<number, string> = {};
  // Auto-assign keyboard shortcuts for the first few boolean params
  const keys = ['1','2','3','4','d','m','z','x','r','o','s'];
  let keyIdx = 0;
  for (const param of params) {
    if (param.type === 0 && keyIdx < keys.length) {
      keyBindings[param.index] = keys[keyIdx];
      const span = document.createElement('span');
      span.innerHTML = `<b>${keys[keyIdx].toUpperCase()}</b> ${escapeHtml(param.name)}`;
      legendEl.appendChild(span);
      keyIdx++;
    }
  }

  return keyBindings;
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
  statusEl.textContent = 'WebGPU OK. Loading WASM...';

  const host = new WasmHost();
  host.onAudioTrigger = triggerAudio;
  host.onStateChange = (state) => updateStateDisplay(state);
  host.onLog = (entry) => addLogEntry(entry);

  let wasmModule: WasmModule;
  try {
    wasmModule = await host.load('nanolooper.wasm');
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

  // Build parameter UI from module declarations
  const keyBindings = buildParamUI(host.params, host, wasmModule);

  // Invert: key → param index
  const keyToParam: Record<string, number> = {};
  for (const [idx, key] of Object.entries(keyBindings)) {
    keyToParam[key] = parseInt(idx);
  }

  // State editor
  stateEditBtn.addEventListener('click', () => {
    stateEditing = true;
    stateTextarea.value = JSON.stringify(host.pluginState, null, 2);
    stateContentEl.style.display = 'none';
    stateEditorEl.style.display = 'block';
    stateTextarea.focus();
  });

  stateApplyBtn.addEventListener('click', () => {
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
  });

  stateCancelBtn.addEventListener('click', () => {
    stateEditing = false;
    stateContentEl.style.display = '';
    stateEditorEl.style.display = 'none';
  });

  // Audio init on first interaction
  const initAudio = () => {
    if (!audioCtx) audioCtx = new AudioContext();
    document.removeEventListener('keydown', initAudio);
    document.removeEventListener('mousedown', initAudio);
  };
  document.addEventListener('keydown', initAudio);
  document.addEventListener('mousedown', initAudio);

  // Keyboard shortcuts (auto-assigned from param declarations)
  document.addEventListener('keydown', (e) => {
    if (e.repeat || stateEditing) return;
    const key = e.key.toLowerCase();
    const paramIdx = keyToParam[key];
    if (paramIdx !== undefined) {
      host.frameState.params[paramIdx] = 1.0;
      wasmModule.onParamChange(paramIdx, 1.0);
      // Highlight the matching button
      const btn = paramsEl.querySelector(`[data-param="${paramIdx}"]`);
      if (btn) btn.classList.add('active');
    }
  });

  document.addEventListener('keyup', (e) => {
    if (stateEditing) return;
    const key = e.key.toLowerCase();
    const paramIdx = keyToParam[key];
    if (paramIdx !== undefined) {
      host.frameState.params[paramIdx] = 0.0;
      wasmModule.onParamChange(paramIdx, 0.0);
      const btn = paramsEl.querySelector(`[data-param="${paramIdx}"]`);
      if (btn) btn.classList.remove('active');
    }
  });

  // Render loop
  let lastTime = performance.now() / 1000;
  let elapsed = 0;
  let frameCount = 0;
  let fpsTime = 0;
  let fps = 0;
  const bpm = 120;

  function frame() {
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
}

main();
