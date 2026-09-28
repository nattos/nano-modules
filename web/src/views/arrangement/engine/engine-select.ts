/**
 * Which engine runs the arrangement's composition executor — decided once, at
 * boot, before the bridge boots its (lazy) engine.
 *
 *   ?compositor=ws://host:port[&compositorKey=k]  a native compositor already
 *                                                 running there (tests, remote)
 *   ?engine=native | ?engine=browser              in the desktop app: start /
 *                                                 don't start the shell's own
 *                                                 compositor (electron/compositor.cjs)
 *   neither                                       the shell's default
 *                                                 (NANO_ARRANGEMENT_ENGINE),
 *                                                 else the browser worker
 *
 * A native engine that can't start falls back to the browser worker, loudly.
 */

import { engineBridge } from './engine-bridge';
import { RemoteCompEngine } from './remote-comp-engine';
import { electronIpc } from '../../../state/paths';

export type CompEngineKind = 'browser' | 'native';

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
      }
    }
  }
  if (!url) return 'browser';
  const target = url;
  engineBridge.setEngineFactory((w, h) => new RemoteCompEngine(w, h, { url: target, key }));
  console.log(`[arrangement] engine: native compositor at ${target}`);
  return 'native';
}
