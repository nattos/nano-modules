/**
 * Which engine runs the arrangement's composition executor — decided once, at
 * boot, before the bridge boots its (lazy) engine.
 *
 *   ?compositor=ws://host:port[&compositorKey=k]  a native compositor already
 *                                                 running there (tests, remote)
 *   ?engine=native | ?engine=browser              in the desktop app: start /
 *                                                 don't start the shell's own
 *                                                 compositor (electron/compositor.cjs)
 *   neither                                       the shell's default:
 *                                                 NANO_ARRANGEMENT_ENGINE, else
 *                                                 Settings → Engine (the
 *                                                 `engine` key of
 *                                                 arrangement.json), else
 *                                                 native on macOS, browser
 *                                                 elsewhere
 *
 * A native engine that can't start falls back to the browser worker, loudly.
 */

import { engineBridge } from './engine-bridge';
import { RemoteCompEngine } from './remote-comp-engine';
import { electronIpc } from '../../../state/paths';
import { snackbars } from '../../../widgets/snackbars';

export type CompEngineKind = 'browser' | 'native';

/** The engine this page booted with (the Settings tab shows it). */
export let activeCompEngine: CompEngineKind = 'browser';

/** A dropped compositor socket is a crash (the shell restarts the process) or
 *  a remote that went away; either way the engine replays on reconnect. */
function onConnectionChange(up: boolean) {
  snackbars.show(up
    ? { message: 'Native engine reconnected', dedupeKey: 'native-engine' }
    : { message: 'Native engine stopped — reconnecting…', dedupeKey: 'native-engine', timeoutMs: 0 });
}

export async function selectCompEngine(search = location.search): Promise<CompEngineKind> {
  const params = new URLSearchParams(search);
  let url = params.get('compositor');
  let key = params.get('compositorKey') ?? undefined;
  const ipc = electronIpc();
  if (!url && ipc) {
    let want = params.get('engine');
    if (!want) want = await ipc.invoke('nano.compositorEngine').catch(() => 'browser');
    if (want === 'native') {
      const info = await ipc.invoke('nano.compositor').catch((err: unknown) => ({ error: String(err) }));
      if (info?.url) {
        url = info.url as string;
        key = info.key as string | undefined;
      } else {
        console.warn(`[arrangement] native engine unavailable (${info?.error}); using the browser engine`);
        snackbars.show({ message: 'Native engine unavailable — using the browser engine', dedupeKey: 'native-engine' });
      }
    }
  }
  if (!url) return (activeCompEngine = 'browser');
  const target = url;
  engineBridge.setEngineFactory((w, h) => new RemoteCompEngine(w, h, { url: target, key, onConnectionChange }));
  console.log(`[arrangement] engine: native compositor at ${target}`);
  return (activeCompEngine = 'native');
}
