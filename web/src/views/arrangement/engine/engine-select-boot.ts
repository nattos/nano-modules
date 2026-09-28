/**
 * Select the composition engine at MODULE EVALUATION — imported first by the
 * arrangement entry (arrangement-app.ts), ahead of the <arrangement-app>
 * element, whose upgrade warms the engine. With ?compositor= the choice is
 * synchronous, so no browser-worker engine is ever started only to be thrown
 * away (a worker terminated mid-load lingers as a target that stalls a
 * puppeteer reconnect). The desktop app's own compositor still resolves over
 * IPC, and the bridge re-boots onto it (see engine-select.ts).
 */

import { selectCompEngine } from './engine-select';

(window as any).__compEngineKind = 'browser';
void selectCompEngine().then((kind) => { (window as any).__compEngineKind = kind; });
