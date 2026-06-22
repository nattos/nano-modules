/**
 * Nano Arrangement entry point — mounted at /arrangement.html.
 *
 * Milestone 1 is a UI mockup driven by fake data (no engine, no worker). The
 * standalone app owns its own store (`views/arrangement/state/store.ts`). The
 * timeline-native worker arrives in Milestone 2.
 */

import './views/arrangement/arrangement-app';
import 'line-awesome/dist/line-awesome/css/line-awesome.css';

import { store } from './views/arrangement/state/store';
import { engineBridge } from './views/arrangement/engine/engine-bridge';

// Expose for console poking / e2e (mirrors boot.ts's window globals).
(window as any).arrangementStore = store;
(window as any).__engineBridge = engineBridge;
