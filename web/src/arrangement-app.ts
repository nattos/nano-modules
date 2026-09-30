/**
 * Nano Arrangement entry point — mounted at /arrangement.html.
 *
 * Milestone 1 is a UI mockup driven by fake data (no engine, no worker). The
 * standalone app owns its own store (`views/arrangement/state/store.ts`). The
 * timeline-native worker arrives in Milestone 2.
 */

// Before any element class is defined: thin scrollbars in every shadow root.
import './widgets/scrollbars';

// First: pick the composition engine before the app element can warm one.
import './views/arrangement/engine/engine-select-boot';
import './views/arrangement/arrangement-app';
import 'line-awesome/dist/line-awesome/css/line-awesome.css';

import { store } from './views/arrangement/state/store';
import { engineBridge } from './views/arrangement/engine/engine-bridge';
import { thumbnailController, reelLayout } from './views/arrangement/media/thumbnail-controller';
import { generatorThumbCache } from './views/arrangement/media/generator-thumb-cache';
import * as workspaceBackend from './views/arrangement/workspace/backend';
import { libraryPaths } from './state/library-paths';
import * as handleRef from './state/handle-ref';
import * as mediaStore from './views/arrangement/workspace/media-store';
import * as dropImport from './views/arrangement/media/drop-import';
import * as paths from './state/paths';
import { exportComposition, canExport } from './views/arrangement/engine/export-renderer';
import { debugPerf } from './views/arrangement/state/debug-perf';
import { previewSurfaces } from './preview-surfaces';
import { previewGpu } from './preview-gpu';
import { midiController } from './state/midi-controller';
import { bootArrangementMidi } from './views/arrangement/state/arr-midi';
import { bootArrangementDisplays } from './views/arrangement/state/arr-displays';
import { bootArrangementLights } from './views/arrangement/state/arr-lights';
import { lightController } from './views/arrangement/state/light-controller';
import { displayController } from './views/arrangement/state/display-controller';
import { outputMaster } from './views/arrangement/state/output-master';

// Expose for console poking / e2e (mirrors boot.ts's window globals).
(window as any).arrangementStore = store;
(window as any).__engineBridge = engineBridge;
(window as any).__thumbCtl = thumbnailController;
(window as any).__genThumbCache = generatorThumbCache;
(window as any).__reelLayout = reelLayout;
(window as any).__workspaceBackend = workspaceBackend;
(window as any).__libraryPaths = libraryPaths;
(window as any).__handleRef = handleRef;
(window as any).__mediaStore = mediaStore;
(window as any).__dropImport = dropImport;
(window as any).__paths = paths;
(window as any).__export = { exportComposition, canExport };
// Per-clip provider telemetry bus (cache hit rate, seeks, notReady, decode path).
// Producers only collect while `active` — the stall benchmark flips it on.
(window as any).__debugPerf = debugPerf;
// Shared-surface preview transport stats (native engine in the desktop app).
(window as any).__previewSurfaces = previewSurfaces;
(window as any).__previewGpu = previewGpu;
// The MIDI device library + Web MIDI (devices the show includes drive its wires).
(window as any).midiController = midiController;
// The light library (types, rigs) + test patterns.
(window as any).lightController = lightController;
// This machine's display slots (which screen fills each) + identify.
(window as any).displayController = displayController;
// The master output switch (off at launch; ⌘⇧D).
(window as any).outputMaster = outputMaster;
void bootArrangementMidi();
void bootArrangementLights();
void bootArrangementDisplays();
