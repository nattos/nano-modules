import { GPURenderer } from './gpu-renderer';
import { WasmHost, WasmModule, ConsoleEntry } from './wasm-host';

const FREQUENCIES = [523.25, 659.26, 783.99, 1046.50]; // C5 E5 G5 C6

const PID_TRIGGER_1 = 0, PID_TRIGGER_4 = 3;
const PID_DELETE = 4, PID_MUTE = 5, PID_UNDO = 6, PID_REDO = 7;
const PID_RECORD = 8, PID_SHOW_OVERLAY = 9, PID_SYNTH = 10;

const KEY_MAP: Record<string, number> = {
  '1': 0, '2': 1, '3': 2, '4': 3,
  'd': PID_DELETE, 'm': PID_MUTE,
  'z': PID_UNDO, 'x': PID_REDO, 'r': PID_RECORD,
};

let audioCtx: AudioContext | null = null;
let synthEnabled = false;

function triggerAudio(channel: number) {
  if (!synthEnabled || !audioCtx) return;
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
  while (consoleEl.children.length > 200) {
    consoleEl.removeChild(consoleEl.firstChild!);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

      // Update the canonical state (what state.read will see)
      host.pluginState = newState;

      // Notify the WASM module that state has changed
      // The module will call state.read to pull the updated grid
      wasmModule.onStateChanged();

      addLogEntry({
        timestamp: host.frameState.elapsedTime,
        level: 'log',
        message: 'State patch applied externally',
      });
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
  };
  document.addEventListener('keydown', initAudio);

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    // Don't capture keys when editing state
    if (stateEditing) return;
    const key = e.key.toLowerCase();

    if (key === 's') {
      synthEnabled = !synthEnabled;
      wasmModule.onParamChange(PID_SYNTH, synthEnabled ? 1.0 : 0.0);
      return;
    }

    const pid = KEY_MAP[key];
    if (pid !== undefined) {
      host.frameState.params[pid] = 1.0;
      wasmModule.onParamChange(pid, 1.0);
    }
  });

  document.addEventListener('keyup', (e) => {
    if (stateEditing) return;
    const key = e.key.toLowerCase();
    const pid = KEY_MAP[key];
    if (pid !== undefined) {
      host.frameState.params[pid] = 0.0;
      wasmModule.onParamChange(pid, 0.0);
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
    if (fpsTime >= 1.0) {
      fps = frameCount;
      frameCount = 0;
      fpsTime = 0;
    }

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
